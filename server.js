'use strict';
// SecondRing Voice Receptionist I - ConversationRelay bridge.
// HTTP: /relay/incoming (TwiML), /relay/health (JSON).
// WS:   /relay/ws (Twilio ConversationRelay).
// Caddy terminates TLS and proxies /relay/* to this process.

const http = require('http');
const { WebSocketServer } = require('ws');
const { loadConfig } = require('./supabase');
const { Session } = require('./session');

const PORT = parseInt(process.env.PORT || '8080', 10);
// Caddy runs in a Docker container here, so the bridge listens on the docker
// network gateway, not loopback. ufw keeps this port off the public internet.
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const PUBLIC_HOST = process.env.PUBLIC_HOST || 'auto.secondring.ca';
// Where callers go if this machine is disabled/paused: the proven n8n Gather flow.
const FALLBACK_TWIML_URL = process.env.FALLBACK_TWIML_URL || '';

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function twimlFor() {
  let cfg = null;
  try { cfg = await loadConfig(); } catch (e) {
    console.error('[twiml] config load failed: ' + e.message);
  }
  const enabled = cfg && cfg.enabled !== false && cfg.mode !== 'paused' && cfg.mode !== 'observe';
  if (!enabled) {
    if (FALLBACK_TWIML_URL) {
      return '<?xml version="1.0" encoding="UTF-8"?><Response><Redirect>' +
        xmlEscape(FALLBACK_TWIML_URL) + '</Redirect></Response>';
    }
    return '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, we cannot take your call right now. Please try again shortly.</Say></Response>';
  }
  const c = (cfg && cfg.config) || {};
  const greeting = c.greeting || c.welcome_greeting ||
    ('Thanks for calling ' + (c.business_name || 'us') + '. How can I help you today?');
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Connect>' +
    '<ConversationRelay url="wss://' + PUBLIC_HOST + '/relay/ws"' +
    ' welcomeGreeting="' + xmlEscape(greeting) + '"' +
    ' interruptible="speech" dtmfDetection="true" />' +
    '</Connect></Response>';
}

let liveSessions = 0;

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  if (url === '/relay/health') {
    const mem = process.memoryUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      rss_mb: Math.round(mem.rss / 1048576),
      sessions: liveSessions,
      uptime_s: Math.round(process.uptime())
    }));
    return;
  }
  if (url === '/relay/incoming' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      const twiml = await twimlFor();
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(twiml);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

const wss = new WebSocketServer({ server, path: '/relay/ws' });
wss.on('connection', (ws) => {
  liveSessions++;
  new Session(ws);
  ws.on('close', () => { liveSessions--; });
});

process.on('uncaughtException', (e) => console.error('[fatal-ish] ' + (e.stack || e.message)));
process.on('unhandledRejection', (e) => console.error('[rejection] ' + (e && e.message ? e.message : e)));

server.listen(PORT, BIND_HOST, () => {
  console.log('sr-voice-bridge listening on ' + BIND_HOST + ':' + PORT + ' (public wss://' + PUBLIC_HOST + '/relay/ws)');
});
