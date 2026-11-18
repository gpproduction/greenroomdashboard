// ProPresenter 7 network API client (ProPresenter > Settings > Network > Enable Network).
// Docs: https://openapi.propresenter.com/  — we poll the lightweight endpoints.
import { EventEmitter } from 'node:events';
import * as store from './store.js';
import * as demo from './demo.js';

export const events = new EventEmitter();

let state = { connected: false, error: null, timers: [], activePresentation: null, checkedAt: null };
let lastJson = '';
let tick = 0;
let loopHandle = null;

export function getState() {
  return state;
}

function baseUrl(cfg) {
  const host = String(cfg.host || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `http://${host}:${cfg.port || 1025}`;
}

async function get(cfg, path, timeout = 1500) {
  const res = await fetch(baseUrl(cfg) + path, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`ProPresenter ${res.status} on ${path}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function normaliseTimers(raw) {
  return (raw || []).map((t) => ({
    id: t.id?.uuid,
    name: t.id?.name,
    index: t.id?.index,
    time: t.time,
    state: t.state, // stopped | running | complete | overrunning | overran
  }));
}

export async function test(cfg) {
  const version = await get(cfg, '/version', 3000);
  const timers = normaliseTimers(await get(cfg, '/v1/timers/current', 3000));
  return { ok: true, version, timers };
}

async function poll() {
  const cfg = store.get().settings.propresenter;
  const usingDemo = process.env.DEMO === '1' && !cfg.host;
  if (!usingDemo && (!cfg.enabled || !cfg.host)) {
    setState({ connected: false, error: cfg.enabled ? 'No host configured' : null, timers: [], activePresentation: null });
    return;
  }
  try {
    let timers;
    let active = state.activePresentation;
    if (usingDemo) {
      timers = normaliseTimers(demo.timers());
      active = demo.activePresentation();
    } else {
      timers = normaliseTimers(await get(cfg, '/v1/timers/current'));
      if (cfg.showActiveItem && tick % 2 === 0) {
        const pres = await get(cfg, '/v1/presentation/active').catch(() => null);
        active = pres?.presentation?.id?.name || null;
      }
    }
    if (cfg.timerIds?.length) {
      const order = new Map(cfg.timerIds.map((id, i) => [id, i]));
      timers = timers.filter((t) => order.has(t.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
    }
    setState({ connected: true, error: null, timers, activePresentation: active });
  } catch (err) {
    setState({ connected: false, error: err.name === 'TimeoutError' ? 'ProPresenter did not respond' : err.message, timers: [], activePresentation: null });
  }
}

function setState(next) {
  state = { ...next, checkedAt: new Date().toISOString() };
  const json = JSON.stringify({ ...next });
  if (json !== lastJson) {
    lastJson = json;
    events.emit('change', state);
  }
}

export function start() {
  if (loopHandle) return;
  const run = async () => {
    tick++;
    await poll();
    // Back off to every 5s while disconnected so we don't spam the network.
    loopHandle = setTimeout(run, state.connected ? 1000 : 5000);
  };
  run();
}

/** Wake the poller immediately (e.g. after settings change). */
export function kick() {
  if (loopHandle) clearTimeout(loopHandle);
  loopHandle = null;
  start();
}
