'use strict';
// Supabase access for the voice bridge.
// Schema facts (verified against the live DB, Aug 23):
//   tenant_machines: enabled bool, mode text  <- the owner's notch
//   machine_configs: key/value rows per machine (greeting, hours_text, services, ...)
//   sr_tenant_profile(p_tenant uuid) -> jsonb  (business_name, owner_name, booking_link, ...)
//   contacts: phone_e164, name, notes, opted_out_at, last_contact_at
//   voice_calls: call_sid, contact_id, caller_name, transcript, turns, summary,
//                escalated, escalate_reason, started_at, ended_at, duration_sec
//   events: event_type, subject_type, subject_id, summary, payload, machine_id, ai_model
// Logging must NEVER crash a live call: every write is wrapped and failures only journal.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MACHINE_ID = process.env.MACHINE_ID;
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
  return res.json();
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
  } catch (e) {
    console.error('[supabase] insert ' + table + ' error: ' + e.message);
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

module.exports = { loadConfig, lookupContact, logCallStart, logCallEnd, logEvent };
