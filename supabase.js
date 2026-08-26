'use strict';
// Supabase access for the voice bridge.
// Schema facts (verified against the live DB, Aug 26):
//   tenant_machines: enabled bool, mode text  <- the owner's notch
//   machine_configs: key/value rows per machine (greeting, hours_text, services, ...)
//   sr_tenant_profile(p_tenant uuid) -> jsonb  (business_name, owner_name, ...)
//   contacts: phone_e164, name, notes, opted_out_at, last_contact_at
//   voice_calls: call_sid, contact_id, caller_name, service, urgency, grade, outcome,
//                transcript, turns, summary, escalated, escalate_reason,
//                started_at, ended_at, duration_sec
//   leads: caller_number, call_sid, contact_id, machine_id, status,
//          ai_job_type, ai_urgency, ai_summary, message
//   events: event_type, subject_type, subject_id, summary, payload, machine_id, ai_model
//   Guardrail RPCs (schema v4+, finally invoked as of Day 8):
//     sr_gate(tenant, machine_key, action, phone, value_cents, subject_type, subject_id, message_text) -> jsonb {allowed, reason, ...}
//     sr_is_emergency(tenant, text) -> bool      sr_in_quiet_hours(tenant) -> bool
//     sr_upsert_contact / sr_open_job / sr_request_approval
// Logging must NEVER crash a live call: every write is wrapped and failures only journal.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MACHINE_ID = process.env.MACHINE_ID;
const MACHINE_KEY = process.env.MACHINE_KEY || 'voice_receptionist';
const TENANT_ID = process.env.TENANT_ID;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';

const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: 'Bearer ' + SUPABASE_KEY,
  'Content-Type': 'application/json'
};

async function sbGet(path) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, { headers: HEADERS });
  if (!res.ok) throw new Error('GET ' + path.split('?')[0] + ' -> ' + res.status);
  return res.json();
}

async function sbRpc(fn, args) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST', headers: HEADERS, body: JSON.stringify(args)
  });
  if (!res.ok) throw new Error('RPC ' + fn + ' -> ' + res.status);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

// Best-effort RPC: null on any failure, never throws.
async function sbRpcSafe(fn, args) {
  try { return await sbRpc(fn, args); }
  catch (e) { console.error('[supabase] rpc ' + fn + ' failed: ' + e.message); return null; }
}

let cache = { at: 0, cfg: null };
const CACHE_MS = 60000;

// Returns { enabled, mode, kv, profile }
async function loadConfig() {
  if (cache.cfg && Date.now() - cache.at < CACHE_MS) return cache.cfg;
  const [tm, kvRows, profile] = await Promise.all([
    sbGet('tenant_machines?tenant_id=eq.' + TENANT_ID + '&machine_id=eq.' + MACHINE_ID + '&select=enabled,mode&limit=1'),
    sbGet('machine_configs?tenant_id=eq.' + TENANT_ID + '&machine_id=eq.' + MACHINE_ID + '&select=key,value'),
    sbRpc('sr_tenant_profile', { p_tenant: TENANT_ID })
  ]);
  const kv = {};
  for (const r of kvRows) kv[r.key] = r.value;
  const cfg = {
    enabled: tm.length ? tm[0].enabled !== false : false,
    mode: tm.length ? tm[0].mode : 'paused',
    kv: kv,
    profile: profile || {}
  };
  cache = { at: Date.now(), cfg: cfg };
  return cfg;
}

// Existing customer lookup by caller id. Null on miss or error.
async function lookupContact(phoneE164) {
  if (!phoneE164) return null;
  try {
    const rows = await sbGet('contacts?tenant_id=eq.' + TENANT_ID +
      '&phone_e164=eq.' + encodeURIComponent(phoneE164) +
      '&select=id,name,notes,opted_out_at,last_contact_at&limit=1');
    return rows.length ? rows[0] : null;
  } catch (e) {
    console.error('[supabase] contact lookup failed: ' + e.message);
    return null;
  }
}

async function tryInsert(table, row) {
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + table, {
      method: 'POST',
      headers: { ...HEADERS, Prefer: 'return=minimal' },
      body: JSON.stringify(row)
    });
    if (!res.ok) console.error('[supabase] insert ' + table + ' -> ' + res.status + ': ' + (await res.text()).slice(0, 300));
    return res.ok;
  } catch (e) {
    console.error('[supabase] insert ' + table + ' error: ' + e.message);
    return false;
  }
}

async function tryUpdateCall(callSid, patch) {
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/voice_calls?call_sid=eq.' + encodeURIComponent(callSid), {
      method: 'PATCH',
      headers: { ...HEADERS, Prefer: 'return=minimal' },
      body: JSON.stringify(patch)
    });
    if (!res.ok) console.error('[supabase] update voice_calls -> ' + res.status + ': ' + (await res.text()).slice(0, 300));
  } catch (e) {
    console.error('[supabase] update voice_calls error: ' + e.message);
  }
}

function logCallStart(callSid, from, to, contact) {
  return tryInsert('voice_calls', {
    call_sid: callSid,
    tenant_id: TENANT_ID,
    from_number: from,
    to_number: to,
    contact_id: contact ? contact.id : null,
    caller_name: contact ? contact.name : null,
    started_at: new Date().toISOString()
  });
}

function logCallEnd(callSid, patch) {
  return tryUpdateCall(callSid, patch);
}

function logEvent(callSid, type, summary, payload) {
  return tryInsert('events', {
    tenant_id: TENANT_ID,
    machine_id: MACHINE_ID,
    event_type: type,
    subject_type: 'voice_call',
    subject_id: callSid,
    summary: summary,
    payload: payload || {},
    autonomous: true,
    ai_model: MODEL
  });
}

// ---------- Day 8: guardrail + action RPCs (built in schema v4, invoked at last) ----------

// The send gate. Returns { allowed, reason, ... } or null if the RPC itself failed.
// A null gate result is treated by callers as "blocked" for customer numbers and
// "allowed" for the owner's own number on emergencies - the owner must still hear
// about an emergency even if the platform DB is unreachable.
function gate(action, phone, messageText, callSid) {
  return sbRpcSafe('sr_gate', {
    p_tenant: TENANT_ID, p_machine_key: MACHINE_KEY, p_action: action,
    p_phone: phone || null, p_value_cents: null,
    p_subject_type: 'voice_call', p_subject_id: callSid || null,
    p_message_text: messageText || null
  });
}

function isEmergencyText(text) {
  return sbRpcSafe('sr_is_emergency', { p_tenant: TENANT_ID, p_text: text });
}

function inQuietHours() {
  return sbRpcSafe('sr_in_quiet_hours', { p_tenant: TENANT_ID });
}

// jsonb result shape is defensive-parsed by callers.
function upsertContact(phone, name, notes) {
  return sbRpcSafe('sr_upsert_contact', {
    p_tenant: TENANT_ID, p_phone: phone, p_name: name || null,
    p_source: 'voice_receptionist', p_notes: notes || null, p_touch: true
  });
}

function openJob(contactId, description, address, scheduledFor) {
  return sbRpcSafe('sr_open_job', {
    p_tenant: TENANT_ID, p_contact: contactId, p_description: description,
    p_address: address || null, p_status: 'lead',
    p_scheduled_for: scheduledFor || null
  });
}

function requestApproval(actionType, summary, payload, callSid) {
  return sbRpcSafe('sr_request_approval', {
    p_tenant: TENANT_ID, p_machine_key: MACHINE_KEY, p_action_type: actionType,
    p_summary: summary, p_payload: payload || {},
    p_subject_type: 'voice_call', p_subject_id: callSid || null
  });
}

function insertLead(row) {
  return tryInsert('leads', { tenant_id: TENANT_ID, machine_id: MACHINE_ID, ...row });
}

module.exports = {
  loadConfig, lookupContact, logCallStart, logCallEnd, logEvent,
  gate, isEmergencyText, inQuietHours, upsertContact, openJob,
  requestApproval, insertLead
};
