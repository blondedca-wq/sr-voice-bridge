'use strict';
// Minimal Twilio REST sender for owner alerts. Best-effort: a failed SMS must
// never crash a live call. Credentials come from .env, never from code.

const SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH = process.env.TWILIO_AUTH_TOKEN;
const FROM = process.env.TWILIO_FROM;

async function sendSms(to, body) {
  if (!SID || !AUTH || !FROM) {
    console.error('[twilio] TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM not set; sms not sent');
    return false;
  }
  if (!to) { console.error('[twilio] no destination number; sms not sent'); return false; }
  try {
    const params = new URLSearchParams({ To: to, From: FROM, Body: body });
    const res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + SID + '/Messages.json', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(SID + ':' + AUTH).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    if (!res.ok) {
      console.error('[twilio] send -> ' + res.status + ': ' + (await res.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[twilio] send error: ' + e.message);
    return false;
  }
}

module.exports = { sendSms };
