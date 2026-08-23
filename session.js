'use strict';
// The brain. One Session per ConversationRelay websocket = one phone call.
// Day 7: intents, tenant-profile answers, human-realism, caller identification.

const { loadConfig, lookupContact, logCallStart, logCallEnd, logEvent } = require('./supabase');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';

const INTENTS = ['book', 'quote', 'emergency', 'existing_customer', 'message', 'other'];
const TAG_RE = /^\s*\[intent:([a-z_]+)\]\s*/;

function asList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v) return [v];
  return [];
}

function buildSystem(cfg, contact, callerNumber) {
  const kv = cfg.kv || {};
  const p = cfg.profile || {};
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
    lines.push('  say the owner will call back with an exact price. Never guess. This is a legal rule, not a style rule.');
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
  lines.push('');
  lines.push('STYLE (a caller must never sense an AI):');
  lines.push('- Warm, competent, quick. Contractions are fine. One or two short sentences per turn, never more than three.');
  lines.push('- NEVER repeat or summarise what the caller just said back to them. Respond to it.');
  lines.push('- Ask at most one question per turn.');
  lines.push('- Plain spoken words only: no lists, no markdown, no emoji. Say numbers the way people say them out loud.');
  lines.push('- When you have what you need: confirm once, briefly, and wrap up. Do not pad, do not re-confirm twice.');
  lines.push('- Never claim an action already happened (a booking made, a text sent). Say what will happen: the owner follows up.');
  lines.push('- If asked directly if you are a robot or AI: one relaxed sentence - you are the assistant answering the phones');
  lines.push('  so nothing gets missed - then straight back to helping. Never deny it, never make it a topic.');
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
    this.timer = null;
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
        (this.contact ? ' KNOWN=' + this.contact.name : ' new-caller'));
      logCallStart(this.callSid, msg.from, msg.to, this.contact);
      logEvent(this.callSid, 'voice_call_started',
        (this.contact ? 'Existing customer ' + this.contact.name : 'New caller') + ' on the line',
        { from: msg.from, engine: 'conversation_relay', known: !!this.contact });
      const maxSec = Number(this.cfg.kv.max_call_seconds) || 480;
      this.timer = setTimeout(() => this.wrapUp(), maxSec * 1000);
    } else if (msg.type === 'prompt') {
      if (msg.voicePrompt) await this.respond(msg.voicePrompt);
    } else if (msg.type === 'interrupt') {
      if (this.abort) this.abort.abort();
    } else if (msg.type === 'error') {
      console.error('[call] twilio error: ' + JSON.stringify(msg).slice(0, 300));
    }
  }

  noteEscalation(userText) {
    if (this.escalated || !this.cfg) return;
    const kv = this.cfg.kv || {};
    const hit = matchKeyword(userText, kv.emergency_transfer_on) || matchKeyword(userText, kv.transfer_to_human_on);
    if (hit) {
      this.escalated = true;
      this.escalateReason = hit;
      logEvent(this.callSid, 'voice_escalation_flagged', 'Caller said "' + hit + '"', { keyword: hit });
    }
  }

  noteIntent(tag) {
    if (!INTENTS.includes(tag)) return;
    if (this.intents[this.intents.length - 1] === tag) return;
    this.intents.push(tag);
    logEvent(this.callSid, 'voice_intent', 'Intent: ' + tag, { intent: tag, turn: Math.ceil(this.history.length / 2) });
  }

  wrapUp() {
    this.send({ type: 'text', token: 'I have to let you go, but everything is noted and the owner will follow up shortly. Thanks for calling.', last: true });
    setTimeout(() => this.send({ type: 'end' }), 4000);
  }

  async respond(userText) {
    this.noteEscalation(userText);
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
      const ms = Date.now() - t0;
      const ttft = firstToken ? firstToken - t0 : ms;
      console.log('[call] turn ' + this.callSid + ' ttft=' + ttft + 'ms total=' + ms + 'ms chars=' + full.length +
        ' intent=' + (this.intents[this.intents.length - 1] || 'none'));
    } catch (e) {
      if (e.name === 'AbortError') {
        console.log('[call] interrupted ' + this.callSid);
      } else {
        console.error('[call] respond failed: ' + e.message);
        this.send({ type: 'text', token: 'Sorry, I had trouble hearing that. Could you say it again?', last: true });
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
    if (this.abort) this.abort.abort();
    if (this.callSid) {
      const turns = Math.ceil(this.history.length / 2);
      const dur = this.startedMs ? Math.round((Date.now() - this.startedMs) / 1000) : null;
      console.log('[call] closed ' + this.callSid + ' turns=' + turns + ' intents=' + this.intents.join(','));
      logCallEnd(this.callSid, {
        transcript: this.history,
        turns: turns,
        ended_at: new Date().toISOString(),
        duration_sec: dur,
        summary: 'Intents: ' + (this.intents.join(', ') || 'none') +
          (this.escalated ? '. Escalation keyword: ' + this.escalateReason : ''),
        escalated: this.escalated,
        escalate_reason: this.escalateReason
      });
      logEvent(this.callSid, 'voice_call_ended', 'Call ended after ' + turns + ' turns',
        { turns: turns, duration_sec: dur, intents: this.intents, escalated: this.escalated });
    }
  }
}

module.exports = { Session };
