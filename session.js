'use strict';
// The brain. One Session per ConversationRelay websocket = one phone call.
// Day 7: intents, tenant-profile answers, human-realism, caller identification.
// Day 8: real actions (contacts/jobs/leads), human takeover mid-call, owner
// alerts behind the send gate, and a true Watch mode (records + grades,
// never acts).
// Day 9: hardening - barge-in truncation, silence handling, voicemail/robocall
// detection, verbal STOP honoured, graceful wrap on shutdown.

const { loadConfig, lookupContact, logCallStart, logCallEnd, logEvent, markOptedOut } = require('./supabase');
const actions = require('./actions');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';

const INTENTS = ['book', 'quote', 'emergency', 'existing_customer', 'message', 'other'];
const TAG_RE = /^\s*\[intent:([a-z_]+)\]\s*/;

// Day 9: things a human never says but machines do. If the "caller" is a
// voicemail box, IVR, or robocall, end politely and file nothing hot.
const VOICEMAIL_RE = /\b(leave (a |your )?message|after the (tone|beep)|voice ?mail|mailbox is full|is not available|has been forwarded|press (one|two|three|1|2|3)|para espanol|this call may be (recorded|monitored)|to opt out|final notice|auto[- ]?mated (call|message)|this is an? (important|courtesy) (call|message))\b/i;

// Day 9: a caller telling us to leave them alone, in their own words.
const OPTOUT_RE = /\b(stop (calling|texting|contacting)|don'?t (call|text|contact) me|do not (call|text|contact)|take me off|remove me from|unsubscribe|no more (calls|texts|messages))\b/i;

// callSid -> { handoff: bool, number: string, reason: string }
// server.js reads this when Twilio hits /relay/action after the session ends.
const handoffs = new Map();

function asList(v) {
if (Array.isArray(v)) return v;
if (typeof v === 'string' && v) return [v];
return [];
}

function buildSystem(cfg, contact, callerNumber) {
const kv = cfg.kv || {};
const p = cfg.profile || {};
const observe = cfg.mode === 'observe';
const biz = p.business_name || 'the business';
const lines = [];

lines.push('You are the phone receptionist for ' + biz + (p.trade ? ', a ' + p.trade + ' business' : '') + '.');
lines.push('You are on a live voice call. Everything you write is spoken aloud by text-to-speech.');
lines.push('');
lines.push('BUSINESS FACTS (ground truth - never contradict, never invent beyond these):');
if (kv.hours_text) lines.push('- Hours: ' + kv.hours_text);
if (asList(kv.services).length) lines.push('- Services: ' + asList(kv.services).join(', ') + '.');
if (kv.emergency_policy) lines.push('- Emergencies: ' + kv.emergency_policy);
if (p.owner_name) lines.push('- The owner is ' + p.owner_name + '.');
lines.push('');
lines.push('PRICING RULE (hard guardrail):');
if (kv.can_quote_prices === true && kv.call_out_fee_text) {
lines.push('- The ONLY price you may state, word for word: "' + kv.call_out_fee_text + '".');
lines.push('- Any other pricing question: the owner will confirm the exact price on a callback.');
} else {
lines.push('- You may NOT state, estimate, or hint at any price or number. If asked about cost,');
lines.push(' say the owner will call back with an exact price. Never guess. This is a legal rule, not a style rule.');
}
lines.push('');
lines.push('CALLER:');
if (contact && contact.name) {
lines.push('- EXISTING CUSTOMER: ' + contact.name + ' (calling from ' + callerNumber + ').');
lines.push('- Greet them by name in your FIRST reply, before your second sentence. Do not ask who they are.');
if (contact.notes) lines.push('- Notes on file: ' + String(contact.notes).slice(0, 200));
} else {
lines.push('- New caller, number ' + (callerNumber || 'unknown') + '. Not in our customer list.');
lines.push('- Get their name early, naturally. Confirm the number they are calling from is the best callback number.');
}
lines.push('');
lines.push('INTENTS - start EVERY reply with a tag, one of:');
lines.push('[intent:book] [intent:quote] [intent:emergency] [intent:existing_customer] [intent:message] [intent:other]');
lines.push('The tag is machine-read and stripped before the caller hears anything. Never speak it, never explain it.');
lines.push('What each intent needs before you wrap up:');
lines.push('- book: what service, the address, a preferred time window, their name. The owner confirms the exact slot by text or call.');
lines.push('- quote: what the job is, roughly what is involved. Owner calls back with the exact price.');
lines.push('- emergency: ADDRESS FIRST, then what is happening. Reassure. Tell them the owner is being alerted right now.');
lines.push('- existing_customer: greet by name, handle whatever they need.');
lines.push('- message: their name, best number, and the message. Confirm you have it.');
if (observe) {
lines.push('');
lines.push('TRIAL MODE (hard rule for this call):');
lines.push('- You may take details and messages, but NEVER promise that anything is booked,');
lines.push(' scheduled, sent, or alerted. The only promise allowed: "I will pass this to the owner');
lines.push(' and they will get back to you." Do not offer to transfer the call.');
}
lines.push('');
lines.push('CONSENT AND CONTACT PREFERENCES (hard rule):');
lines.push('- If the caller asks not to be called, texted, or contacted: acknowledge it once, plainly,');
lines.push(' and confirm they will not be contacted again. Do not argue, do not ask why, do not offer alternatives.');
lines.push('- Never promise to text or call a caller who has asked not to be contacted.');
lines.push('');
lines.push('STYLE (a caller must never sense an AI):');
lines.push('- Warm, competent, quick. Contractions are fine. One or two short sentences per turn, never more than three.');
lines.push('- NEVER repeat or summarise what the caller just said back to them. Respond to it.');
lines.push('- Ask at most one question per turn.');
lines.push('- Plain spoken words only: no lists, no markdown, no emoji. Say numbers the way people say them out loud.');
lines.push('- When you have what you need: confirm once, briefly, and wrap up. Do not pad, do not re-confirm twice.');
lines.push('- Never claim an action already happened (a booking made, a text sent). Say what will happen: the owner follows up.');
lines.push('- If asked directly if you are a robot or AI: one relaxed sentence - you are the assistant answering the phones');
lines.push(' so nothing gets missed - then straight back to helping. Never deny it, never make it a topic.');
lines.push('');
lines.push('Example of what NOT to do:');
lines.push('Caller: "My water heater is leaking and I need someone today."');
lines.push('Bad: "So you are saying your water heater is leaking and you need someone today."');
lines.push('Good: "[intent:emergency] Oh no, a leaking heater cannot wait. What is your address? I will get you looked after."');
return lines.join('\n');
}

// Split streamed text into speakable chunks at sentence-ish boundaries.
function extractSpeakable(buf) {
const m = buf.match(/^[\s\S]*?[.!?]["')\]]?\s+/);
if (!m) return null;
return m[0];
}

function matchKeyword(text, list) {
const t = (text || '').toLowerCase();
for (const k of asList(list)) {
if (t.includes(String(k).toLowerCase())) return String(k);
}
return null;
}

class Session {
constructor(ws) {
this.ws = ws;
this.history = [];
this.cfg = null;
this.contact = null;
this.callSid = null;
this.from = null;
this.abort = null;
this.closed = false;
this.startedMs = 0;
this.intents = [];
this.escalated = false;
this.escalateReason = null;
this.handingOff = false;
this.emergencyAlerted = false;
this.failStreak = 0;
this.timer = null;
// Day 9 state
this.silenceTimer = null;
this.silenceStrikes = 0;
this.bargeIns = 0;
this.voicemailDetected = false;
this.optedOut = false;
this.endedBy = null; // 'silence' | 'voicemail' | 'max_time' | 'shutdown' | null
ws.on('message', (data) => this.onMessage(data).catch(e => console.error('[session] ' + e.message)));
ws.on('close', () => this.onClose());
}

send(obj) {
if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
}

maxTurns() {
const n = this.cfg && this.cfg.kv && Number(this.cfg.kv.max_turns);
return n && n > 0 ? n * 2 : 36; // kv counts exchanges; history counts messages
}

// ---------- Day 9: silence handling ----------
// Armed after the greeting and after every completed assistant turn.
// One quiet stretch gets a gentle check-in; a second ends the call politely.
armSilenceTimer() {
if (this.closed || this.handingOff || this.endedBy) return;
const kv = (this.cfg && this.cfg.kv) || {};
const secs = Number(kv.silence_reprompt_seconds) || 12;
clearTimeout(this.silenceTimer);
this.silenceTimer = setTimeout(() => this.onSilence(), secs * 1000);
}

onSilence() {
if (this.closed || this.handingOff || this.endedBy) return;
this.silenceStrikes++;
if (this.silenceStrikes === 1) {
logEvent(this.callSid, 'voice_silence', 'No speech heard - checking the caller is still there', { strike: 1 });
this.send({ type: 'text', token: 'Are you still there?', last: true });
this.armSilenceTimer();
} else {
this.endedBy = 'silence';
logEvent(this.callSid, 'voice_silence_hangup', 'Still silent after a check-in - ending the call politely', { strike: this.silenceStrikes });
this.send({ type: 'text', token: 'I might have lost you there. Call us back any time - take care.', last: true });
setTimeout(() => this.send({ type: 'end' }), 3500);
}
}

// ---------- Day 9: voicemail / robocall detection ----------
noteVoicemail(userText) {
if (this.voicemailDetected || !VOICEMAIL_RE.test(userText || '')) return false;
this.voicemailDetected = true;
this.endedBy = 'voicemail';
logEvent(this.callSid, 'voice_voicemail_detected',
'Machine on the line (voicemail/IVR/robocall) - ending, nothing will be filed as a lead',
{ sample: String(userText || '').slice(0, 160) });
if (this.abort) this.abort.abort();
this.send({ type: 'text', token: 'Thanks. Goodbye.', last: true });
setTimeout(() => this.send({ type: 'end' }), 1500);
return true;
}

// ---------- Day 9: verbal STOP / do-not-contact ----------
noteOptOut(userText) {
if (this.optedOut || !OPTOUT_RE.test(userText || '')) return;
this.optedOut = true;
logEvent(this.callSid, 'voice_opt_out',
'Caller asked not to be contacted - honoured immediately',
{ verbatim: String(userText || '').slice(0, 200) });
// Best-effort immediate write; actions.processCall repeats it after the
// contact upsert so brand-new callers are covered too.
markOptedOut(this.from).catch(() => {});
}

async onMessage(data) {
let msg;
try { msg = JSON.parse(data.toString()); } catch { return; }
if (msg.type === 'setup') {
this.callSid = msg.callSid;
this.from = msg.from;
this.startedMs = Date.now();
const results = await Promise.all([loadConfig(), lookupContact(msg.from)]);
this.cfg = results[0];
this.contact = results[1];
console.log('[call] setup ' + this.callSid + ' from ' + msg.from +
(this.contact ? ' KNOWN=' + this.contact.name : ' new-caller') +
' mode=' + this.cfg.mode);
logCallStart(this.callSid, msg.from, msg.to, this.contact);
logEvent(this.callSid, 'voice_call_started',
(this.contact ? 'Existing customer ' + this.contact.name : 'New caller') + ' on the line',
{ from: msg.from, engine: 'conversation_relay', known: !!this.contact, mode: this.cfg.mode });
const maxSec = Number(this.cfg.kv.max_call_seconds) || 480;
this.timer = setTimeout(() => { this.endedBy = 'max_time'; this.wrapUp(); }, maxSec * 1000);
this.armSilenceTimer();
} else if (msg.type === 'prompt') {
clearTimeout(this.silenceTimer);
this.silenceStrikes = 0;
if (msg.voicePrompt) await this.respond(msg.voicePrompt);
} else if (msg.type === 'interrupt') {
// Day 9: barge-in. Stop generating AND keep the transcript honest -
// trim the last assistant turn to what the caller actually heard.
if (this.abort) this.abort.abort();
this.bargeIns++;
const heard = typeof msg.utteranceUntilInterrupt === 'string' ? msg.utteranceUntilInterrupt : null;
const last = this.history[this.history.length - 1];
if (heard && last && last.role === 'assistant' && last.content && last.content.length > heard.length) {
last.content = heard;
}
logEvent(this.callSid, 'voice_barge_in', 'Caller interrupted - assistant stopped mid-sentence',
{ barge_ins: this.bargeIns, heard_chars: heard ? heard.length : null });
} else if (msg.type === 'error') {
console.error('[call] twilio error: ' + JSON.stringify(msg).slice(0, 300));
}
}

// Day 8: a matched keyword now actually hands the call to a human.
noteEscalation(userText) {
if (this.escalated || !this.cfg) return;
const kv = this.cfg.kv || {};
const emergencyHit = matchKeyword(userText, kv.emergency_transfer_on);
const humanHit = matchKeyword(userText, kv.transfer_to_human_on);
const hit = emergencyHit || humanHit;
if (!hit) return;
this.escalated = true;
this.escalateReason = hit;
logEvent(this.callSid, 'voice_escalation_flagged', 'Caller said "' + hit + '"',
{ keyword: hit, emergency: !!emergencyHit });
this.handOff(emergencyHit ? 'emergency keyword: ' + hit : 'asked for a person: ' + hit, !!emergencyHit);
}

noteIntent(tag) {
if (!INTENTS.includes(tag)) return;
if (this.intents[this.intents.length - 1] !== tag) {
this.intents.push(tag);
logEvent(this.callSid, 'voice_intent', 'Intent: ' + tag, { intent: tag, turn: Math.ceil(this.history.length / 2) });
}
if (tag === 'emergency' && !this.emergencyAlerted) {
this.emergencyAlerted = true;
actions.emergencyAlert(this).catch(e => console.error('[actions] emergencyAlert: ' + e.message));
}
}

// Speak a short line, then end the ConversationRelay session with handoff data.
// Twilio then requests /relay/action, which dials the escalation number.
handOff(reason, isEmergency) {
if (this.handingOff || !this.cfg) return;
const kv = this.cfg.kv || {};
const number = kv.escalation_number;
if (this.cfg.mode === 'observe' || !number) {
// Watch never transfers; and with no number there is nothing to dial.
logEvent(this.callSid, this.cfg.mode === 'observe' ? 'voice_action_held' : 'voice_handoff_unconfigured',
(this.cfg.mode === 'observe' ? 'WATCH: would have handed the call to a human (' : 'No escalation number set; cannot hand off (') + reason + ')',
{ held: this.cfg.mode === 'observe', reason: reason });
return;
}
this.handingOff = true;
clearTimeout(this.silenceTimer);
handoffs.set(this.callSid, { handoff: true, number: number, reason: reason });
logEvent(this.callSid, 'voice_handoff', 'Handing the call to a human: ' + reason,
{ number_last4: String(number).slice(-4), reason: reason, emergency: !!isEmergency });
if (this.abort) this.abort.abort();
this.send({ type: 'text', token: 'One moment - I am connecting you now. It will just be a second.', last: true });
actions.escalationAlert(this, reason).catch(e => console.error('[actions] escalationAlert: ' + e.message));
setTimeout(() => this.send({ type: 'end', handoffData: JSON.stringify({ reason: reason }) }), 2500);
}

wrapUp() {
this.send({ type: 'text', token: 'I have to let you go, but everything is noted and the owner will follow up shortly. Thanks for calling.', last: true });
setTimeout(() => this.send({ type: 'end' }), 4000);
}

// Day 9: called by server.js on SIGTERM so a deploy never strands a caller.
gracefulEnd() {
if (this.closed || this.endedBy) return;
this.endedBy = 'shutdown';
logEvent(this.callSid, 'voice_shutdown_wrap', 'Bridge restarting - caller wrapped up politely, owner will follow up');
this.send({ type: 'text', token: 'Sorry - I have to step away for a second. The owner has your details and will call you right back.', last: true });
setTimeout(() => this.send({ type: 'end' }), 1500);
}

async respond(userText) {
if (this.noteVoicemail(userText)) return;
this.noteOptOut(userText);
this.noteEscalation(userText);
if (this.handingOff || this.endedBy) return;
this.history.push({ role: 'user', content: userText });
const cap = this.maxTurns();
if (this.history.length > cap) this.history.splice(0, this.history.length - cap);
if (this.abort) this.abort.abort();
const ac = new AbortController();
this.abort = ac;
const t0 = Date.now();
let full = '';
try {
const res = await fetch('https://api.anthropic.com/v1/messages', {
method: 'POST',
signal: ac.signal,
headers: {
'x-api-key': ANTHROPIC_KEY,
'anthropic-version': '2023-06-01',
'content-type': 'application/json'
},
body: JSON.stringify({
model: MODEL,
max_tokens: 200,
system: buildSystem(this.cfg || {}, this.contact, this.from),
messages: this.history,
stream: true
})
});
if (!res.ok) throw new Error('anthropic ' + res.status + ': ' + (await res.text()).slice(0, 200));

const reader = res.body.getReader();
const dec = new TextDecoder();
let sse = '';
let pending = '';
let tagDone = false;
let firstToken = 0;
for (;;) {
const { done, value } = await reader.read();
if (done) break;
sse += dec.decode(value, { stream: true });
let idx;
while ((idx = sse.indexOf('\n\n')) >= 0) {
const block = sse.slice(0, idx);
sse = sse.slice(idx + 2);
const line = block.split('\n').find(l => l.startsWith('data: '));
if (!line) continue;
let ev;
try { ev = JSON.parse(line.slice(6)); } catch { continue; }
if (ev.type === 'content_block_delta' && ev.delta && ev.delta.text) {
if (!firstToken) firstToken = Date.now();
pending += ev.delta.text;
full += ev.delta.text;
if (!tagDone) {
const m = pending.match(TAG_RE);
if (m) {
this.noteIntent(m[1]);
pending = pending.replace(TAG_RE, '');
tagDone = true;
} else if (pending.length > 40 || /^\s*[^\s\[]/.test(pending)) {
tagDone = true; // no tag coming; speak as-is
} else {
continue; // still buffering a possible tag
}
}
let chunk;
while ((chunk = extractSpeakable(pending))) {
pending = pending.slice(chunk.length);
this.send({ type: 'text', token: chunk, last: false });
}
}
}
}
if (!tagDone) {
const m = pending.match(TAG_RE);
if (m) { this.noteIntent(m[1]); pending = pending.replace(TAG_RE, ''); }
}
if (pending.trim()) this.send({ type: 'text', token: pending, last: false });
this.send({ type: 'text', token: '', last: true });
this.failStreak = 0;
const ms = Date.now() - t0;
const ttft = firstToken ? firstToken - t0 : ms;
console.log('[call] turn ' + this.callSid + ' ttft=' + ttft + 'ms total=' + ms + 'ms chars=' + full.length +
' intent=' + (this.intents[this.intents.length - 1] || 'none'));
this.armSilenceTimer();
} catch (e) {
if (e.name === 'AbortError') {
console.log('[call] interrupted ' + this.callSid);
} else {
console.error('[call] respond failed: ' + e.message);
this.failStreak++;
if (this.failStreak >= 2) {
// Confidence has dropped: stop apologising and get a human on the line.
logEvent(this.callSid, 'voice_confidence_drop', 'Two failed turns in a row - escalating');
this.escalated = true;
this.escalateReason = 'low_confidence';
this.handOff('the assistant had trouble on this call', false);
} else {
this.send({ type: 'text', token: 'Sorry, I had trouble hearing that. Could you say it again?', last: true });
this.armSilenceTimer();
}
}
} finally {
if (this.abort === ac) this.abort = null;
}
if (full) this.history.push({ role: 'assistant', content: full });
}

onClose() {
if (this.closed) return;
this.closed = true;
if (this.timer) clearTimeout(this.timer);
if (this.silenceTimer) clearTimeout(this.silenceTimer);
if (this.abort) this.abort.abort();
if (this.callSid) {
const turns = Math.ceil(this.history.length / 2);
const dur = this.startedMs ? Math.round((Date.now() - this.startedMs) / 1000) : null;
console.log('[call] closed ' + this.callSid + ' turns=' + turns + ' intents=' + this.intents.join(',') +
(this.endedBy ? ' endedBy=' + this.endedBy : ''));
logCallEnd(this.callSid, {
transcript: this.history,
turns: turns,
ended_at: new Date().toISOString(),
duration_sec: dur,
summary: 'Intents: ' + (this.intents.join(', ') || 'none') +
(this.escalated ? '. Escalation keyword: ' + this.escalateReason : '') +
(this.endedBy ? '. Ended by: ' + this.endedBy : '') +
(this.optedOut ? '. Caller opted out of contact.' : ''),
escalated: this.escalated,
escalate_reason: this.escalateReason
});
logEvent(this.callSid, 'voice_call_ended', 'Call ended after ' + turns + ' turns',
{ turns: turns, duration_sec: dur, intents: this.intents, escalated: this.escalated,
barge_ins: this.bargeIns, silence_strikes: this.silenceStrikes,
voicemail: this.voicemailDetected, opted_out: this.optedOut, ended_by: this.endedBy });
// Day 8: the action layer - extraction, grading, contacts/jobs/leads, owner alert.
actions.processCall(this).catch(e => console.error('[actions] processCall: ' + e.message));
// Handoff entries are consumed by /relay/action; clean up stragglers later.
const sid = this.callSid;
setTimeout(() => handoffs.delete(sid), 120000);
}
}
}

module.exports = { Session, handoffs };
