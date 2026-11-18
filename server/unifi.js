// UniFi Access door arrivals → green "Arrived" on the dashboard.
//
// Uses the UniFi Access developer API on the console (https://<console>:12445/api/v1/developer)
// with an API token created in UniFi Access. We read today's "door_openings" system log
// and match each granted unlock's person name to Planning Center names.
import https from 'node:https';
import { EventEmitter } from 'node:events';
import * as store from './store.js';

export const events = new EventEmitter();

let state = { enabled: false, connected: false, error: null, lastPoll: null, events: 0 };
let arrivals = new Map(); // name key -> { ts, name, door }
let timer = null;
let lastJson = '';

export function getState() {
  return state;
}

// ---- name matching (pure, unit-tested) -----------------------------------------------

/** Lowercase, strip quoted nicknames / parentheses / punctuation. */
export function normaliseName(name) {
  return String(name || '')
    .replace(/["“”'‘’][^"“”'‘’]*["“”'‘’]/g, ' ') // Mackenzie "Kenzie" Smith → Mackenzie Smith
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // é → e
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/[-\s]+/g, ' ')
    .trim();
}

/** Keys a name can be matched by: full name, first+last, and nickname+last. */
export function nameKeys(name) {
  const keys = new Set();
  const full = normaliseName(name);
  if (!full) return keys;
  keys.add(full);
  const parts = full.split(' ');
  if (parts.length > 2) keys.add(`${parts[0]} ${parts.at(-1)}`);
  const nick = /["“”'‘’]([^"“”'‘’]+)["“”'‘’]/.exec(String(name || ''))?.[1];
  if (nick && parts.length >= 2) keys.add(`${normaliseName(nick)} ${parts.at(-1)}`);
  return keys;
}

/** Earliest arrival today for a Planning Center name, or null. */
export function arrivalFor(name, map = arrivals) {
  let best = null;
  for (const k of nameKeys(name)) {
    const a = map.get(k);
    if (a && (!best || a.ts < best.ts)) best = a;
  }
  return best;
}

/** Midnight today in the church time zone, as epoch ms. */
export function startOfDay(timeZone, now = Date.now()) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
    const h = Number(parts.hour) % 24;
    return now - ((h * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000 - (now % 1000);
  } catch {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
}

/** Turn door_openings log hits into a name-key → earliest-arrival map. */
export function buildArrivals(hits) {
  const map = new Map();
  for (const hit of hits) {
    const src = hit._source || hit;
    const ev = src.event || {};
    const actor = src.actor || {};
    if (ev.result && ev.result !== 'ACCESS') continue; // denied attempts don't count
    if (actor.type && actor.type !== 'user') continue;
    const name = actor.display_name;
    if (!name || name === 'N/A') continue;
    const ts = ev.published || Date.parse(hit['@timestamp'] || src['@timestamp']);
    if (!ts) continue;
    const door = (src.target || []).find((t) => t.type === 'door')?.display_name || null;
    for (const k of nameKeys(name)) {
      const prev = map.get(k);
      if (!prev || ts < prev.ts) map.set(k, { ts, name, door });
    }
  }
  return map;
}

// ---- API -----------------------------------------------------------------------------------

function cfg() {
  return store.get().settings.unifi;
}

/**
 * Call the UniFi Access API. The console uses a self-signed certificate, so
 * verification is skipped for this one host on the local network only.
 */
function request(c, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: c.host, port: c.port || 12445, method, path: `/api/v1/developer${path}`,
      rejectUnauthorized: false,
      timeout: 8000,
      headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error('UniFi Access rejected the API token (check its permissions)'));
        let json;
        try { json = JSON.parse(data); } catch { return reject(new Error(`UniFi Access returned ${res.statusCode}`)); }
        if (json.code && json.code !== 'SUCCESS') return reject(new Error(`UniFi Access: ${json.msg || json.code}`));
        resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`No response from ${c.host}:${c.port || 12445}`)));
    req.on('error', (err) => reject(err.code === 'ECONNREFUSED' ? new Error('Connection refused (is the UniFi Access API enabled on port 12445?)') : err));
    if (payload) req.write(payload);
    req.end();
  });
}

/** All door openings since `since` (ms), following pagination. */
export async function fetchDoorOpenings(c, since, until = Date.now()) {
  const hits = [];
  for (let page = 1; page <= 10; page++) {
    const res = await request(c, 'POST', `/system/logs?page_num=${page}&page_size=100`, {
      topic: 'door_openings', since: Math.floor(since / 1000), until: Math.ceil(until / 1000),
    });
    const batch = res.data?.hits || [];
    hits.push(...batch);
    const total = res.pagination?.total;
    if (batch.length < 100 || (total && hits.length >= total)) break;
  }
  return hits;
}

function publish(patch, newArrivals) {
  state = { ...state, ...patch };
  if (newArrivals) arrivals = newArrivals;
  const json = JSON.stringify([state.enabled, state.connected, state.error, [...arrivals.entries()].map(([k, v]) => [k, v.ts])]);
  if (json !== lastJson) {
    lastJson = json;
    events.emit('change');
  }
}

async function poll() {
  const c = cfg();
  const tz = store.get().settings.display.timezone;
  if (process.env.DEMO === '1' && !c.host) return demoArrivals(tz);
  if (!c.enabled || !c.host || !c.token) {
    publish({ enabled: Boolean(c.enabled), connected: false, error: c.enabled ? 'Enter the console IP and API token' : null }, new Map());
    return;
  }
  try {
    const hits = await fetchDoorOpenings(c, startOfDay(tz));
    publish({ enabled: true, connected: true, error: null, lastPoll: new Date().toISOString(), events: hits.length }, buildArrivals(hits));
  } catch (err) {
    publish({ enabled: true, connected: false, error: err.message }); // keep last arrivals on a blip
  }
}

/** Test from admin: today's door events and who they matched in the current plan. */
export async function test(c, planNames = [], timeZone) {
  const hits = await fetchDoorOpenings(c, startOfDay(timeZone));
  const map = buildArrivals(hits);
  const recent = hits
    .map((h) => h._source || h)
    .filter((s) => s.actor?.display_name)
    .slice(-10)
    .reverse()
    .map((s) => ({
      name: s.actor.display_name,
      at: s.event?.published || null,
      result: s.event?.result || null,
      door: (s.target || []).find((t) => t.type === 'door')?.display_name || null,
      matches: planNames.filter((n) => [...nameKeys(n)].some((k) => nameKeys(s.actor.display_name).has(k))),
    }));
  const matched = planNames.filter((n) => arrivalFor(n, map));
  return { ok: true, events: hits.length, recent, matched };
}

// ---- demo ------------------------------------------------------------------------------------
function demoArrivals(tz) {
  const base = Math.max(startOfDay(tz), Date.now() - 3 * 3600_000);
  const people = [['Alex Rivera', 0], ['Jordan Lee', 6], ['Casey Morgan', 11], ['Pat Kim', 25], ['Jamie Fox', 31]];
  const map = buildArrivals(people.map(([name, min]) => ({ _source: { actor: { display_name: name, type: 'user' }, event: { result: 'ACCESS', published: base + min * 60_000 }, target: [{ type: 'door', display_name: 'Production Entrance' }] } })));
  publish({ enabled: true, connected: true, error: null, lastPoll: new Date().toISOString(), events: people.length }, map);
}

// ---- lifecycle ---------------------------------------------------------------------------------
export function start() {
  const loop = async () => {
    await poll();
    timer = setTimeout(loop, 15_000);
  };
  loop();
}

export function restart() {
  clearTimeout(timer);
  start();
}
