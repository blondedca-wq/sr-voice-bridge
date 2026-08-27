'use strict';
// Day 8: the action layer. Turns a finished (or escalating) call into real rows
// and owner alerts, with every outbound message behind the send gate.
// Day 9: extraction now reports its own confidence; every call emits one
// voice_call_logged event carrying transcript + ai_confidence + outcome;
// voicemail/robocall calls are recorded but never become leads or alerts;
// a verbal STOP is written to the contact after the upsert.
//
// Mode contract (the notch):
// observe - record + grade only. Every action that WOULD have happened is
// logged as a voice_action_held event. Nothing written to
// contacts/jobs/leads, nothing sent. Zero side effects.
// approval - contact + lead + grade recorded; job booking goes through
// sr_request_approval (the owner taps yes); owner alert sent.
// autonomous - everything: contact, job, lead, owner alert.
//
// Guardrails: every SMS passes sr_gate first. An emergency may override a
// quiet-hours/window refusal (logged as voice_quiet_hours_bypassed); it never
// overrides an opt-out. All of this is best-effort: failures journal, calls survive.

const sb = require('./supabase');
const { sendSms } = require('./twilio');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';

function asText(v, cap) { return v == null ? null : String(v).slice(0, cap || 300); }

function transcriptText(history) {
return history.map(m => (m.role === 'user' ? 'Caller: ' : 'Receptionist: ') + m.content).join('
').slice(0, 12000);
}

// One cheap non-streaming call over the finished transcript -> structured facts.
async function extractFacts(session) {
const kv = (session.cfg && session.cfg.kv) || {};
const sys = [
'You extract structured facts from a phone call transcript between a caller and a receptionist.',
'Reply with ONLY a JSON object, no prose, with exactly these keys:',
'{"caller_name": string|null, "callback_number": string|null, "service": string|null,',
' "address": string|null, "time_window": string|null, "message": string|null,',
' "wants_booking": boolean, "is_emergency": boolean,',
' "grade": "HOT"|"WARM"|"COLD", "grade_reason": string, "outcome": string,',
' "confidence": number}',
'',
'Grading (Lead Rescue spec):',
'- HOT: emergency, ready to book, high-value job, strong buying intent.',
'- WARM: interested, gathering information, needs follow-up.',
'- COLD: low intent, general inquiry, wrong number, spam.',
kv.grading_notes ? 'Business-specific grading notes: ' + kv.grading_notes : '',
'',
'"outcome" is one short sentence in plain trade English: what happened on this call.',
'"confidence" is a number from 0 to 1: how certain you are that the facts and the grade',
'above are correct, given how clear and complete the transcript is. A short, garbled, or',
'ambiguous call is low confidence even if you filled every field.',
'Use null for anything the transcript does not actually contain. Never invent.'
].filter(Boolean).join('
');
const res = await fetch('https://api.anthropic.com/v1/messages', {
method: 'POST',
headers: {
'x-api-key': ANTHROPIC_KEY,
'anthropic-version': '2023-06-01',
'content-type': 'application/json'
},
body: JSON.stringify({
model: MODEL, max_tokens: 500, system: sys,
messages: [{ role: 'user', content: transcriptText(session.history) }]
})
});
if (!res.ok) throw new Error('extract ' + res.status);
const data = await res.json();
let text = (data.content && data.content[0] && data.content[0].text) || '';
const m = text.match(/{[sS]*}/);
if (!m) throw new Error('extract: no JSON in reply');
return JSON.parse(m[0]);
}

function ownerPhone(cfg) {
const p = (cfg && cfg.profile) || {};
const kv = (cfg && cfg.kv) || {};
return p.owner_phone || p.owner_number || kv.escalation_number || process.env.OWNER_PHONE || null;
}

function alertGrades(cfg) {
const kv = (cfg && cfg.kv) || {};
const raw = typeof kv.owner_alert_on === 'string' && kv.owner_alert_on ? kv.owner_alert_on : 'hot,emergency';
return raw.toLowerCase().split(',').map(s => s.trim());
}

// Send an SMS to the owner, through the gate. Emergency may bypass a
// quiet-hours refusal (logged), never an opt-out refusal.
async function gatedOwnerSms(callSid, to, body, isEmergency, action) {
if (!to) { sb.logEvent(callSid, 'voice_alert_skipped', 'No owner/escalation number configured'); return false; }
const g = await sb.gate(action || 'owner_alert', to, body, callSid);
const allowed = g && g.allowed === true;
const reason = (g && g.reason) ? String(g.reason) : (g ? 'unknown' : 'gate_unreachable');
if (allowed) {
const ok = await sendSms(to, body);
sb.logEvent(callSid, 'voice_owner_alerted', 'Owner texted: ' + body.slice(0, 80),
{ action: action || 'owner_alert', gate: g, sent: ok });
return ok;
}
const optedOut = /opt/i.test(reason);
const quietish = /quiet|window|blackout|hour|curfew/i.test(reason);
if (isEmergency && !optedOut && (quietish || reason === 'gate_unreachable')) {
const ok = await sendSms(to, body);
sb.logEvent(callSid, 'voice_quiet_hours_bypassed',
'EMERGENCY: alert sent despite gate refusal (' + reason + ')',
{ action: action || 'owner_alert', gate: g, sent: ok });
return ok;
}
sb.logEvent(callSid, 'voice_send_blocked', 'Owner alert held back by gate: ' + reason,
{ action: action || 'owner_alert', gate: g });
return false;
}

// Fired mid-call the first time an emergency intent is seen. Not in observe.
async function emergencyAlert(session) {
const cfg = session.cfg || {};
if (cfg.mode === 'observe') {
sb.logEvent(session.callSid, 'voice_action_held',
'WATCH: would have texted the owner about an emergency call in progress',
{ held: true, action: 'emergency_alert' });
return;
}
const to = ownerPhone(cfg);
const body = 'EMERGENCY call in progress. Caller ' + (session.contact && session.contact.name ? session.contact.name + ' ' : '') +
(session.from || 'unknown number') + '. The receptionist is on it - details to follow.';
await gatedOwnerSms(session.callSid, to, body, true, 'emergency_alert');
}

// Fired when the session escalates (keyword or confidence drop). Not in observe.
async function escalationAlert(session, reason) {
const cfg = session.cfg || {};
if (cfg.mode === 'observe') {
sb.logEvent(session.callSid, 'voice_action_held',
'WATCH: would have escalated to a human (' + reason + ')',
{ held: true, action: 'escalation', reason: reason });
return;
}
const to = ownerPhone(cfg);
const body = 'Call handed to you: ' + (session.contact && session.contact.name ? session.contact.name + ' ' : '') +
(session.from || 'unknown number') + ' - ' + reason + '. Your phone should be ringing.';
await gatedOwnerSms(session.callSid, to, body, true, 'escalation_alert');
}

// The post-call pipeline. Called once from Session.onClose, after logCallEnd.
async function processCall(session) {
if (!session.callSid || !session.history.length) return;
const cfg = session.cfg || {};
const callSid = session.callSid;
let ex;
try { ex = await extractFacts(session); }
catch (e) {
console.error('[actions] extract failed: ' + e.message);
sb.logEvent(callSid, 'voice_extract_failed', 'Post-call extraction failed: ' + e.message);
// Day 9: the call must still be fully logged even when extraction dies.
sb.logEvent(callSid, 'voice_call_logged', 'Call logged without extraction (extractor failed)', {
transcript: transcriptText(session.history),
turns: Math.ceil(session.history.length / 2),
ai_confidence: 0,
outcome: 'extraction_failed',
intents: session.intents,
voicemail: session.voicemailDetected === true,
opted_out: session.optedOut === true
});
return;
}

const grade = ['HOT', 'WARM', 'COLD'].includes(ex.grade) ? ex.grade : 'COLD';
const lastIntent = session.intents[session.intents.length - 1] || 'other';
const isEmergency = ex.is_emergency === true || session.intents.includes('emergency');
// Day 9: clamp the model's self-reported confidence to [0,1].
const conf = typeof ex.confidence === 'number' && isFinite(ex.confidence)
? Math.max(0, Math.min(1, ex.confidence)) : null;
const isVoicemail = session.voicemailDetected === true;

// 1. The call record itself always gets the facts + grade (all modes - this IS recording).
sb.logCallEnd(callSid, {
caller_name: asText(ex.caller_name, 120) || (session.contact && session.contact.name) || null,
service: asText(ex.service, 200),
urgency: isVoicemail ? 'low' : (isEmergency ? 'emergency' : (grade === 'HOT' ? 'high' : grade === 'WARM' ? 'normal' : 'low')),
grade: isVoicemail ? 'COLD' : grade,
outcome: isVoicemail ? 'Voicemail/IVR/robocall detected - ended politely, not a lead.' : asText(ex.outcome, 300)
});
sb.logEvent(callSid, 'voice_graded', 'Caller graded ' + (isVoicemail ? 'COLD (machine)' : grade) + ': ' + (ex.grade_reason || ''),
{ grade: isVoicemail ? 'COLD' : grade, reason: isVoicemail ? 'voicemail/robocall' : ex.grade_reason,
intents: session.intents, emergency: isEmergency, ai_confidence: conf });

// Day 9: the one event that makes every call auditable from the Receipt alone.
sb.logEvent(callSid, 'voice_call_logged', 'Call logged: ' + (isVoicemail ? 'machine caller' : (ex.outcome || 'no outcome extracted')), {
transcript: transcriptText(session.history),
turns: Math.ceil(session.history.length / 2),
ai_confidence: conf,
outcome: isVoicemail ? 'voicemail_or_robocall' : asText(ex.outcome, 300),
grade: isVoicemail ? 'COLD' : grade,
intents: session.intents,
barge_ins: session.bargeIns || 0,
silence_strikes: session.silenceStrikes || 0,
voicemail: isVoicemail,
opted_out: session.optedOut === true,
ended_by: session.endedBy || null
});

// Day 9: a machine caller is recorded above and goes no further -
// no contact, no job, no lead, no owner text. In any mode.
if (isVoicemail) return;

// 2. Watch stops here: everything below is an action.
if (cfg.mode === 'observe') {
const held = [];
if (ex.caller_name || ex.callback_number) held.push('save caller ' + (ex.caller_name || session.from) + ' to contacts');
if (ex.wants_booking || lastIntent === 'book' || isEmergency) held.push('open a job: ' + (ex.service || 'service call'));
held.push('file a ' + grade + ' lead into Lead Saver');
if (alertGrades(cfg).includes(grade.toLowerCase()) || isEmergency) held.push('text the owner');
if (session.optedOut) held.push('mark the caller do-not-contact');
for (const h of held) {
sb.logEvent(callSid, 'voice_action_held', 'WATCH: would ' + h, { held: true, grade: grade });
}
return;
}

// 3. Contact: save/refresh the caller.
let contactId = session.contact ? session.contact.id : null;
const cr = await sb.upsertContact(session.from, asText(ex.caller_name, 120),
ex.message ? 'Voice message: ' + asText(ex.message, 200) : null);
if (cr) contactId = cr.id || (cr.contact && cr.contact.id) || contactId;
sb.logEvent(callSid, 'voice_contact_saved',
'Caller saved: ' + (ex.caller_name || session.from), { contact_id: contactId, rpc: cr });

// Day 9: a verbal STOP survives the upsert - written after it, so brand-new
// callers get opted_out_at too. sr_gate reads this on every later send.
if (session.optedOut) {
const ok = await sb.markOptedOut(session.from);
sb.logEvent(callSid, 'voice_opt_out_saved',
'Do-not-contact recorded for ' + (ex.caller_name || session.from),
{ contact_id: contactId, written: ok });
}

// 4. Job: booking requests and emergencies become a jobs row.
if (ex.wants_booking || lastIntent === 'book' || isEmergency) {
const desc = (ex.service || 'Service call') +
(ex.time_window ? ' - wants ' + ex.time_window : '') +
(isEmergency ? ' [EMERGENCY]' : '');
if (cfg.mode === 'approval_required' && !isEmergency) {
const ap = await sb.requestApproval('open_job',
'Book: ' + desc + ' for ' + (ex.caller_name || session.from),
{ contact_id: contactId, description: desc, address: ex.address, time_window: ex.time_window },
callSid);
sb.logEvent(callSid, 'voice_job_pending_approval', 'Job waiting for your OK: ' + desc, { approval: ap });
} else if (contactId) {
const jr = await sb.openJob(contactId, desc, asText(ex.address, 300), null);
sb.logEvent(callSid, 'voice_job_opened', 'Job opened: ' + desc, { rpc: jr, contact_id: contactId });
} else {
sb.logEvent(callSid, 'voice_job_skipped', 'No contact id - job not opened', { extract: ex });
}
}

// 5. Lead Saver: every caller lands in leads, graded.
await sb.insertLead({
contact_id: contactId,
caller_number: session.from,
call_sid: callSid,
status: grade.toLowerCase(),
ai_job_type: asText(ex.service, 120),
ai_urgency: isEmergency ? 'emergency' : grade.toLowerCase(),
ai_summary: asText(ex.outcome, 300),
message: asText(ex.message, 500)
});
sb.logEvent(callSid, 'voice_lead_saved', grade + ' lead filed for ' + (ex.caller_name || session.from), { grade: grade });

// 6. Owner alert: configured grades, emergencies, and taken messages.
const wantAlert = alertGrades(cfg).includes(grade.toLowerCase()) ||
(isEmergency && alertGrades(cfg).includes('emergency')) ||
lastIntent === 'message';
if (wantAlert && !session.escalated) { // escalation already alerted mid-call
const bits = [];
bits.push((isEmergency ? 'EMERGENCY - ' : grade + ' lead - ') + (ex.caller_name || 'caller') + ' ' + (session.from || ''));
if (ex.service) bits.push(ex.service);
if (ex.address) bits.push(ex.address);
if (ex.time_window) bits.push('wants ' + ex.time_window);
if (ex.message) bits.push('Msg: ' + asText(ex.message, 120));
if (session.optedOut) bits.push('NOTE: caller asked not to be contacted - do not text them');
await gatedOwnerSms(callSid, ownerPhone(cfg), bits.join(' | ').slice(0, 480), isEmergency, 'owner_alert');
}
}

module.exports = { processCall, emergencyAlert, escalationAlert };
