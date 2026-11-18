// Recorder / encoder status for the dashboard footer:
//   • Blackmagic HyperDeck — Ethernet protocol (TCP 9993): record/play status + timecode
//   • OBS Studio — obs-websocket v5 (built into OBS 28+, default port 4455): stream + record time
// Both reconnect on their own and report { connected, error, ... } so the TV can show
// a status dot even when a device is off.
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import * as store from './store.js';

export const events = new EventEmitter();
const isDemo = () => process.env.DEMO === '1';

let state = {
  hyperdeck: { enabled: false, connected: false, error: null, status: null, timecode: null, model: null },
  obs: { enabled: false, connected: false, error: null, stream: null, record: null },
};
let lastJson = '';

export function getState() {
  return state;
}

function publish(part, patch) {
  state = { ...state, [part]: { ...state[part], ...patch } };
  const json = JSON.stringify(state);
  if (json !== lastJson) {
    lastJson = json;
    events.emit('change', state);
  }
}

// ---- HyperDeck --------------------------------------------------------------------------

/**
 * Parse HyperDeck protocol text into responses. Single-line responses look like
 * "200 ok"; multi-line ones end the first line with ":" and finish with a blank line.
 * Returns { responses: [{ code, title, fields }], rest } — rest is an incomplete tail.
 */
export function parseHyperDeck(buffer) {
  const responses = [];
  let rest = buffer.replace(/\r\n/g, '\n');
  for (;;) {
    const nl = rest.indexOf('\n');
    if (nl === -1) break;
    const first = rest.slice(0, nl);
    const m = /^(\d{3}) (.*?)(:?)$/.exec(first.trim());
    if (!m) { rest = rest.slice(nl + 1); continue; } // stray line
    if (!m[3]) { // single-line response
      responses.push({ code: Number(m[1]), title: m[2], fields: {} });
      rest = rest.slice(nl + 1);
      continue;
    }
    const end = rest.indexOf('\n\n', nl);
    if (end === -1) break; // wait for the rest of this response
    const fields = {};
    for (const line of rest.slice(nl + 1, end).split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    responses.push({ code: Number(m[1]), title: m[2], fields });
    rest = rest.slice(end + 2);
  }
  return { responses, rest };
}

const hd = { socket: null, timer: null, poll: null, buf: '', lastReply: 0, cfgKey: '' };

function hyperdeckCfg() {
  return store.get().settings.hyperdeck;
}

function hdCleanup() {
  clearInterval(hd.poll);
  hd.poll = null;
  if (hd.socket) { hd.socket.removeAllListeners(); hd.socket.destroy(); hd.socket = null; }
}

function hdSchedule(ms = 5000) {
  clearTimeout(hd.timer);
  hd.timer = setTimeout(hdConnect, ms);
}

function hdConnect() {
  hdCleanup();
  const cfg = hyperdeckCfg();
  if (isDemo() && !cfg.host) return hdDemo();
  if (!cfg.enabled || !cfg.host) {
    publish('hyperdeck', { enabled: Boolean(cfg.enabled), connected: false, error: cfg.enabled ? 'No IP address set' : null, status: null, timecode: null });
    return;
  }
  publish('hyperdeck', { enabled: true });
  const sock = net.createConnection({ host: cfg.host, port: cfg.port || 9993 });
  hd.socket = sock;
  hd.buf = '';
  sock.setEncoding('utf8');
  sock.setTimeout(5000);
  sock.on('connect', () => {
    hd.lastReply = Date.now();
    sock.setTimeout(0);
    const ask = () => {
      if (Date.now() - hd.lastReply > 5000) { // HyperDeck stopped answering
        publish('hyperdeck', { connected: false, error: 'HyperDeck stopped responding' });
        hdCleanup();
        return hdSchedule();
      }
      sock.write('transport info\r\n');
    };
    ask();
    hd.poll = setInterval(ask, 1000);
  });
  sock.on('data', (chunk) => {
    const { responses, rest } = parseHyperDeck(hd.buf + chunk);
    hd.buf = rest.slice(-8192);
    for (const r of responses) {
      hd.lastReply = Date.now();
      if (r.code === 500) publish('hyperdeck', { model: r.fields.model || null });
      if (r.code === 208 || r.code === 508) { // transport info (or its async notify)
        publish('hyperdeck', {
          connected: true,
          error: null,
          status: r.fields.status || null, // preview | stopped | play | forward | rewind | jog | shuttle | record
          timecode: r.fields['display timecode'] || r.fields.timecode || null,
        });
      }
    }
  });
  sock.on('timeout', () => sock.destroy(new Error('No response')));
  sock.on('error', (err) => publish('hyperdeck', { connected: false, error: err.code === 'ECONNREFUSED' ? 'Connection refused (is Ethernet control on?)' : err.message }));
  sock.on('close', () => {
    publish('hyperdeck', { connected: false, status: null, timecode: null });
    hdCleanup();
    hdSchedule();
  });
}

/** One-off connection test from the admin page. */
export function testHyperDeck({ host, port = 9993 }) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let buf = '';
    let info = {};
    const done = (fn, v) => { clearTimeout(t); sock.destroy(); fn(v); };
    const t = setTimeout(() => done(reject, new Error(`No response from ${host}:${port}`)), 4000);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write('transport info\r\n'));
    sock.on('data', (c) => {
      const { responses, rest } = parseHyperDeck(buf + c);
      buf = rest;
      for (const r of responses) {
        if (r.code === 500) info = r.fields;
        if (r.code === 208) done(resolve, { ok: true, model: info.model || 'HyperDeck', status: r.fields.status, timecode: r.fields['display timecode'] || r.fields.timecode });
      }
    });
    sock.on('error', (err) => done(reject, err));
  });
}

// ---- OBS (obs-websocket v5) ---------------------------------------------------------------

/** obs-websocket v5 auth string: base64(sha256(base64(sha256(password + salt)) + challenge)). */
export function obsAuth(password, salt, challenge) {
  const secret = crypto.createHash('sha256').update(password + salt).digest('base64');
  return crypto.createHash('sha256').update(secret + challenge).digest('base64');
}

const obs = { ws: null, timer: null, poll: null };

function obsCleanup() {
  clearInterval(obs.poll);
  obs.poll = null;
  if (obs.ws) { obs.ws.removeAllListeners(); try { obs.ws.terminate(); } catch { /* ignore */ } obs.ws = null; }
}

function obsSchedule(ms = 5000) {
  clearTimeout(obs.timer);
  obs.timer = setTimeout(obsConnect, ms);
}

/** Open an identified obs-websocket session. Resolves with the socket. */
function obsSession({ host, port = 4455, password = '' }, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}:${port}`, { handshakeTimeout: timeout });
    const t = setTimeout(() => { ws.terminate(); reject(new Error(`No response from OBS at ${host}:${port}`)); }, timeout);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.op === 0) { // Hello
        const d = { rpcVersion: 1, eventSubscriptions: 0 };
        if (msg.d.authentication) {
          if (!password) { clearTimeout(t); ws.terminate(); return reject(new Error('OBS requires a password (Tools → WebSocket Server Settings)')); }
          d.authentication = obsAuth(password, msg.d.authentication.salt, msg.d.authentication.challenge);
        }
        ws.send(JSON.stringify({ op: 1, d }));
      } else if (msg.op === 2) { // Identified
        clearTimeout(t);
        ws.removeAllListeners('message');
        resolve(ws);
      }
    });
    ws.on('close', (code) => {
      clearTimeout(t);
      reject(new Error(code === 4009 ? 'OBS rejected the password' : `OBS closed the connection (${code})`));
    });
    ws.on('error', (err) => { clearTimeout(t); reject(new Error(err.code === 'ECONNREFUSED' ? 'Connection refused (is the OBS WebSocket server enabled?)' : err.message)); });
  });
}

function obsRequest(ws, requestType) {
  ws.send(JSON.stringify({ op: 6, d: { requestType, requestId: `${requestType}-${Date.now()}` } }));
}

async function obsConnect() {
  obsCleanup();
  const cfg = store.get().settings.obs;
  if (isDemo() && !cfg.host) return obsDemo();
  if (!cfg.enabled || !cfg.host) {
    publish('obs', { enabled: Boolean(cfg.enabled), connected: false, error: cfg.enabled ? 'No IP address set' : null, stream: null, record: null });
    return;
  }
  publish('obs', { enabled: true });
  let ws;
  try {
    ws = await obsSession(cfg);
  } catch (err) {
    publish('obs', { connected: false, error: err.message, stream: null, record: null });
    return obsSchedule(err.message.includes('password') ? 30_000 : 5000);
  }
  obs.ws = ws;
  publish('obs', { connected: true, error: null });
  let lastReply = Date.now();
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.op !== 7) return;
    lastReply = Date.now();
    const r = msg.d.responseData || {};
    if (msg.d.requestType === 'GetStreamStatus') {
      publish('obs', { stream: { active: Boolean(r.outputActive), reconnecting: Boolean(r.outputReconnecting), timecode: r.outputTimecode || null } });
    } else if (msg.d.requestType === 'GetRecordStatus') {
      publish('obs', { record: { active: Boolean(r.outputActive), paused: Boolean(r.outputPaused), timecode: r.outputTimecode || null } });
    }
  });
  ws.on('close', () => {
    publish('obs', { connected: false, error: 'OBS disconnected', stream: null, record: null });
    obsCleanup();
    obsSchedule();
  });
  ws.on('error', () => { /* close follows */ });
  const ask = () => {
    if (Date.now() - lastReply > 5000) { ws.terminate(); return; }
    obsRequest(ws, 'GetStreamStatus');
    obsRequest(ws, 'GetRecordStatus');
  };
  ask();
  obs.poll = setInterval(ask, 1000);
}

/** One-off connection test from the admin page. */
export async function testObs(cfg) {
  const ws = await obsSession(cfg, { timeout: 4000 });
  const version = await new Promise((resolve) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.op === 7 && msg.d.requestType === 'GetVersion') resolve(msg.d.responseData || {});
    });
    obsRequest(ws, 'GetVersion');
    setTimeout(() => resolve({}), 2000);
  });
  ws.terminate();
  return { ok: true, obsVersion: version.obsVersion || null };
}

// ---- demo fakes ----------------------------------------------------------------------------
const demoStart = Date.now();
function hms(ms, frames = false) {
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  const base = `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  return frames ? `${base}:${p(Math.floor((ms % 1000) / 1000 * 30))}` : `${base}.000`;
}
function hdDemo() {
  const tick = () => publish('hyperdeck', { enabled: true, connected: true, error: null, model: 'HyperDeck Studio (demo)', status: 'record', timecode: hms(Date.now() - demoStart + 754_000, true) });
  tick();
  hd.poll = setInterval(tick, 1000);
}
function obsDemo() {
  const tick = () => publish('obs', {
    enabled: true, connected: true, error: null,
    stream: { active: true, reconnecting: false, timecode: hms(Date.now() - demoStart + 1_380_000) },
    record: { active: false, paused: false, timecode: null },
  });
  tick();
  obs.poll = setInterval(tick, 1000);
}

// ---- lifecycle ------------------------------------------------------------------------------
export function start() {
  hdConnect();
  obsConnect();
}

/** Reconnect after settings change. */
export function restart(which = ['hyperdeck', 'obs']) {
  if (which.includes('hyperdeck')) { clearTimeout(hd.timer); hdConnect(); }
  if (which.includes('obs')) { clearTimeout(obs.timer); obsConnect(); }
}
