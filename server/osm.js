// Open Sound Meter (v1.4.x) live levels.
//
// With OSM's Remote → "Server" switched on, OSM:
//   • broadcasts a UDP "hello" every second (port 49007) listing its sources, and
//   • multicasts a "levels" message (239.255.42.42:49007) each time a source updates:
//       { message: "levels", source: "{uuid}", objectName: "Measurement 1",
//         data: { A: { Fast: dBFS, Slow: dBFS }, B: {...}, C: {...}, Z: {...} } }
// OSM's own SPL readout is dBFS + 140, so we do the same (plus an optional offset).
// Leq isn't sent, so we integrate it here from the stream.
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import * as store from './store.js';

export const events = new EventEmitter();
export const PORT = 49007;
export const MULTICAST = '239.255.42.42';
export const SPL_OFFSET = 140;

const sources = new Map(); // uuid -> { uuid, name, host, lastSeen }
let latest = null; // { uuid, name, levels, at }
let samples = []; // [{ t, spl }] one per second for Leq / max
let lastSampleAt = 0;
let socket = null;
let lastHello = 0;
let state = { enabled: false, listening: false, connected: false, error: null };

const cfg = () => store.get().settings.osm;

// ---- pure helpers (unit-tested) --------------------------------------------------

/** dBFS from OSM → SPL as OSM displays it. Non-finite (silence) → null. */
export function toSpl(dbfs, offset = 0) {
  if (dbfs == null || dbfs === '') return null; // OSM sends null for silence (-∞)
  const v = Number(dbfs);
  return Number.isFinite(v) ? v + SPL_OFFSET + Number(offset || 0) : null;
}

/** Energy-average (Leq) of SPL samples over the last `seconds`. */
export function leq(list, seconds, now = Date.now()) {
  const from = now - seconds * 1000;
  const vals = list.filter((s) => s.t >= from && s.spl != null).map((s) => s.spl);
  if (!vals.length) return null;
  const mean = vals.reduce((a, v) => a + 10 ** (v / 10), 0) / vals.length;
  return 10 * Math.log10(mean);
}

export function maxOver(list, seconds, now = Date.now()) {
  const from = now - seconds * 1000;
  let m = null;
  for (const s of list) if (s.t >= from && s.spl != null && (m == null || s.spl > m)) m = s.spl;
  return m;
}

/** Pick the source to show: the configured name if present, else the first one seen. */
export function chooseSource(all, wantedName) {
  const list = [...all.values()];
  if (wantedName) {
    const hit = list.find((s) => s.name?.toLowerCase() === wantedName.toLowerCase());
    if (hit) return hit;
  }
  return list[0] || null;
}

// ---- state for the UI ----------------------------------------------------------------

export function getState(now = Date.now()) {
  const c = cfg();
  const fresh = latest && now - latest.at < 3000;
  const curve = c.curve || 'A';
  const time = c.time || 'Slow';
  const lv = fresh ? latest.levels?.[curve] : null;
  const leqMinutes = Number(c.leqMinutes) || 15;
  return {
    ...state,
    connected: Boolean(fresh),
    host: [...sources.values()].find((s) => s.uuid === latest?.uuid)?.host || null,
    sources: [...sources.values()].map((s) => ({ name: s.name, host: s.host })),
    source: fresh ? latest.name : null,
    curve, time,
    spl: lv ? toSpl(lv[time], c.offset) : null,
    fast: lv ? toSpl(lv.Fast, c.offset) : null,
    leq: leq(samples, leqMinutes * 60, now),
    leq1: leq(samples, 60, now),
    max1: maxOver(samples, 60, now),
    leqMinutes,
    warn: Number(c.warn) || 95,
    alarm: Number(c.alarm) || 100,
  };
}

// ---- network -------------------------------------------------------------------------------

function handle(msg, rinfo) {
  let m;
  try { m = JSON.parse(msg.toString('utf8')); } catch { return; }
  if (m.api !== 'Open Sound Meter') return;
  const now = Date.now();
  if (m.message === 'hello') {
    lastHello = now;
    for (const s of m.sources || []) {
      sources.set(s.uuid, { uuid: s.uuid, name: s.objectName, host: m.host || rinfo.address, lastSeen: now });
    }
    for (const [id, s] of sources) if (now - s.lastSeen > 10_000) sources.delete(id);
    return;
  }
  if (m.message === 'levels' && m.data) {
    if (!sources.has(m.source)) sources.set(m.source, { uuid: m.source, name: m.objectName, host: m.host || rinfo.address, lastSeen: now });
    const chosen = chooseSource(sources, cfg().source);
    if (chosen && chosen.uuid !== m.source) return;
    latest = { uuid: m.source, name: m.objectName, levels: m.data, at: now };
    // one sample per second feeds Leq / max
    if (now - lastSampleAt >= 1000) {
      lastSampleAt = now;
      const c = cfg();
      samples.push({ t: now, spl: toSpl(m.data?.[c.curve || 'A']?.[c.time || 'Slow'], c.offset) });
      const keep = Math.max(15, Number(c.leqMinutes) || 15) * 60_000 + 5000;
      while (samples.length && samples[0].t < now - keep) samples.shift();
    }
  }
}

function startSocket() {
  stopSocket();
  const c = cfg();
  if (!c.enabled) { state = { enabled: false, listening: false, connected: false, error: null }; return; }
  socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('message', handle);
  socket.on('error', (err) => {
    state = { ...state, listening: false, error: `Can't listen on UDP ${PORT}: ${err.message}` };
    console.warn('[osm]', err.message);
  });
  socket.bind(PORT, () => {
    try {
      socket.addMembership(MULTICAST);
      state = { enabled: true, listening: true, connected: false, error: null };
    } catch (err) {
      state = { enabled: true, listening: true, connected: false, error: `Joined UDP ${PORT} but not multicast ${MULTICAST}: ${err.message}` };
    }
  });
}

function stopSocket() {
  if (socket) { try { socket.close(); } catch { /* already closed */ } socket = null; }
}

// Demo: a believable worship-service level wander.
let demoTimer = null;
function startDemo() {
  const t0 = Date.now();
  sources.set('{demo}', { uuid: '{demo}', name: 'FOH Mic', host: 'sound-desk', lastSeen: Date.now() });
  demoTimer = setInterval(() => {
    const t = (Date.now() - t0) / 1000;
    const base = 88 + 5 * Math.sin(t / 40) + 2 * Math.sin(t / 7) + (Math.random() - 0.5) * 2;
    const dbfs = base - SPL_OFFSET;
    sources.get('{demo}').lastSeen = Date.now();
    handle(Buffer.from(JSON.stringify({ api: 'Open Sound Meter', message: 'levels', source: '{demo}', objectName: 'FOH Mic',
      data: { A: { Fast: dbfs + (Math.random() - 0.5) * 3, Slow: dbfs }, C: { Fast: dbfs + 4, Slow: dbfs + 3 }, Z: { Fast: dbfs + 6, Slow: dbfs + 5 } } })), { address: '127.0.0.1' });
  }, 200);
  state = { enabled: true, listening: true, connected: true, error: null };
}

export function start() {
  if (process.env.DEMO === '1' && !cfg().enabled) return startDemo();
  startSocket();
  // Push meter updates to screens ~4×/second while data is flowing, every 2 s otherwise.
  let tick = 0;
  setInterval(() => {
    tick++;
    const flowing = latest && Date.now() - latest.at < 5000;
    if (flowing || (state.enabled && tick % 8 === 0)) events.emit('change', getState());
  }, 250);
}

export function restart() {
  if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
  sources.clear();
  latest = null;
  samples = [];
  startSocket();
}

export function lastHelloAt() {
  return lastHello;
}
