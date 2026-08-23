'use strict';
// Supabase REST helpers: machine config load (cached) + best-effort call logging.
// Logging must NEVER crash a live call: every write is wrapped and failures only journal.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MACHINE_ID = process.env.MACHINE_ID;
const TENANT_ID = process.env.TENANT_ID;

const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: 'Bearer ' + SUPABASE_KEY,
  'Content-Type': 'application/json'
};

let cache = { at: 0, cfg: null };
const CACHE_MS = 60000;

async function loadConfig() {
  if (cache.cfg && Date.now() - cache.at < CACHE_MS) return cache.cfg;
  const url = SUPABASE_URL + '/rest/v1/machine_configs?machine_id=eq.' + MACHINE_ID +
    '&tenant_id=eq.' + TENANT_ID + '&select=*&limit=1';
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error('machine_configs load failed: ' + res.status);
  const rows = await res.json();
  if (!rows.length) throw new Error('no machine_configs row for voice_receptionist');
  cache = { at: Date.now(), cfg: rows[0] };
  return rows[0];
}

// Best-effort insert. Returns true on success, false otherwise.
async function tryInsert(table, row) {
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + table, {
      method: 'POST',
      headers: { ...HEADERS, Prefer: 'return=minimal' },
      body: JSON.stringify(row)
    });
    if (!res.ok) {
      console.error('[supabase] insert ' + table + ' -> ' + res.status + ': ' + (await res.text()).slice(0, 300));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[supabase] insert ' + table + ' error: ' + e.message);
    return false;
  }
}

// Best-effort update by call_sid.
async function tryUpdateCall(callSid, patch) {
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/voice_calls?call_sid=eq.' + encodeURIComponent(callSid), {
      method: 'PATCH',
      headers: { ...HEADERS, Prefer: 'return=minimal' },
      body: JSON.stringify(patch)
    });
    if (!res.ok) {
      console.error('[supabase] update voice_calls -> ' + res.status + ': ' + (await res.text()).slice(0, 300));
    }
  } catch (e) {
    console.error('[supabase] update voice_calls error: ' + e.message);
  }
}

function logCallStart(callSid, from, to) {
  return tryInsert('voice_calls', {
    call_sid: callSid,
    tenant_id: TENANT_ID,
    from_number: from,
    to_number: to,
    status: 'in-progress',
    started_at: new Date().toISOString()
  });
}

function logCallEnd(callSid, transcript) {
  return tryUpdateCall(callSid, {
    status: 'completed',
    ended_at: new Date().toISOString(),
    transcript: transcript
  });
}

function logEvent(callSid, type, detail) {
  return tryInsert('events', {
    tenant_id: TENANT_ID,
    event_type: type,
    detail: { call_sid: callSid, ...detail },
    created_at: new Date().toISOString()
  });
}

module.exports = { loadConfig, logCallStart, logCallEnd, logEvent };
