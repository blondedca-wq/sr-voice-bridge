'use strict';
// One Session per ConversationRelay websocket = one phone call.
// Streams Claude tokens to Twilio TTS on sentence boundaries for low latency.

const { loadConfig, logCallStart, logCallEnd, logEvent } = require('./supabase');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const MAX_TURNS = 24; // history cap: keep memory flat on a 1 GB box

function buildSystem(cfg) {
  const facts = JSON.stringify(cfg.config || cfg, null, 0);
  return [
    'You are the phone receptionist for this business. You are on a live voice call;',
    'everything you write is spoken aloud by text-to-speech.',
    '',
    'Business facts (JSON, from the business owner - treat as ground truth):',
    facts,
    '',
    'Style rules:',
    '- Speak like a warm, competent human receptionist. Contractions are fine.',
    '- One or two short sentences per turn. Never more than three.',
    '- NEVER repeat or summarise what the caller just said back to them. Respond to it.',
    '- Ask at most one question per turn.',
    '- Plain spoken language only: no lists, no markdown, no emoji, no stage directions.',
    '- If asked something not covered by the business facts, take a message: get name,',
    '  phone number and what they need, and say the owner will call back.',
    '- For emergencies, get the address first, then reassure.',
    '',
    'Example of what NOT to do:',
    'Caller: "My water heater is leaking and I need someone today."',
    'Bad: "So you are saying your water heater is leaking and you need someone today."',
    'Good: "Oh no, a leaking heater cannot wait. What is your address? I will get you on the list for today."'
  ].join('\n');
}

// Split streamed text into speakable chunks at sentence-ish boundaries.
function extractSpeakable(buf) {
  const m = buf.match(/^[\s\S]*?[.!?]["')\]]?\s+/);
  if (!m) return null;
  return m[0];
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.history = [];
    this.cfg = null;
    this.callSid = null;
    this.abort = null;
    this.closed = false;
    ws.on('message', (data) => this.onMessage(data).catch(e => console.error('[session] ' + e.message)));
    ws.on('close', () => this.onClose());
  }

  send(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  async onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'setup') {
      this.callSid = msg.callSid;
      this.cfg = await loadConfig();
      console.log('[call] setup ' + this.callSid + ' from ' + msg.from);
      logCallStart(this.callSid, msg.from, msg.to);
      logEvent(this.callSid, 'voice_call_started', { from: msg.from, engine: 'conversation_relay' });
    } else if (msg.type === 'prompt') {
      if (msg.voicePrompt) await this.respond(msg.voicePrompt);
    } else if (msg.type === 'interrupt') {
      if (this.abort) this.abort.abort();
    } else if (msg.type === 'error') {
      console.error('[call] twilio error: ' + JSON.stringify(msg).slice(0, 300));
    }
  }

  async respond(userText) {
    this.history.push({ role: 'user', content: userText });
    if (this.history.length > MAX_TURNS) this.history.splice(0, this.history.length - MAX_TURNS);
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
          max_tokens: 250,
          system: buildSystem(this.cfg || {}),
          messages: this.history,
          stream: true
        })
      });
      if (!res.ok) throw new Error('anthropic ' + res.status + ': ' + (await res.text()).slice(0, 200));

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let sse = '';
      let pending = '';
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
            if (!firstToken) { firstToken = Date.now(); }
            pending += ev.delta.text;
            full += ev.delta.text;
            let chunk;
            while ((chunk = extractSpeakable(pending))) {
              pending = pending.slice(chunk.length);
              this.send({ type: 'text', token: chunk, last: false });
            }
          }
        }
      }
      if (pending.trim()) this.send({ type: 'text', token: pending, last: false });
      this.send({ type: 'text', token: '', last: true });
      const ms = Date.now() - t0;
      const ttft = firstToken ? firstToken - t0 : ms;
      console.log('[call] turn ' + this.callSid + ' ttft=' + ttft + 'ms total=' + ms + 'ms chars=' + full.length);
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
    if (this.abort) this.abort.abort();
    if (this.callSid) {
      console.log('[call] closed ' + this.callSid + ' turns=' + this.history.length);
      logCallEnd(this.callSid, this.history);
      logEvent(this.callSid, 'voice_call_ended', { turns: this.history.length });
    }
  }
}

module.exports = { Session };
