// Keeps the "active" plan fresh from Planning Center and caches other plans the admin opens.
import { EventEmitter } from 'node:events';
import * as store from './store.js';
import * as pco from './pco.js';

export const events = new EventEmitter();

const status = { ok: false, error: null, lastSync: null, syncing: false };
let upcoming = [];
let active = null; // plan detail
const detailCache = new Map(); // planId -> { detail, at }
let timer = null;

export function getStatus() {
  return { ...status, configured: pco.isDemo() || pco.hasCredentials() };
}
export function getUpcoming() {
  return upcoming;
}
export function getActive() {
  return active || store.get().lastPlan;
}

async function serviceTypeNames() {
  try {
    return Object.fromEntries((await pco.listServiceTypes()).map((s) => [s.id, s.name]));
  } catch {
    return {};
  }
}

export async function syncNow() {
  const { pco: cfg } = store.get().settings;
  if (!pco.isDemo() && !pco.hasCredentials()) {
    Object.assign(status, { ok: false, error: 'Planning Center is not connected yet. Add credentials in Admin → Settings.' });
    events.emit('change');
    return;
  }
  if (!pco.isDemo() && !cfg.serviceTypeIds.length) {
    Object.assign(status, { ok: false, error: 'Pick at least one service type in Admin → Settings.' });
    events.emit('change');
    return;
  }
  if (status.syncing) return;
  status.syncing = true;
  try {
    upcoming = await pco.upcomingPlans(cfg.serviceTypeIds, await serviceTypeNames());

    let target = null;
    if (cfg.planSelection !== 'auto') {
      target = upcoming.find((p) => p.id === cfg.planSelection) || { id: cfg.planSelection, serviceTypeId: cfg.pinnedServiceTypeId };
    } else {
      target = pco.pickActivePlan(upcoming);
    }

    if (target?.serviceTypeId) {
      const detail = await pco.planDetail(target.serviceTypeId, target.id);
      detail.plan.serviceTypeName = target.serviceTypeName || detail.plan.serviceTypeName || '';
      active = detail;
      detailCache.set(detail.plan.id, { detail, at: Date.now() });
      store.update((db) => { db.lastPlan = detail; }, { topic: 'plan' });
    } else {
      active = null;
    }
    Object.assign(status, { ok: true, error: null, lastSync: new Date().toISOString() });
  } catch (err) {
    console.error('[sync]', err.message);
    Object.assign(status, { ok: false, error: err.message });
  } finally {
    status.syncing = false;
    events.emit('change');
  }
}

/** Detail for any plan (used by the admin assignment screen). Cached for 30s. */
export async function getPlanDetail(serviceTypeId, planId, { fresh = false } = {}) {
  const hit = detailCache.get(planId);
  if (hit && !fresh && Date.now() - hit.at < 30_000) return hit.detail;
  const detail = await pco.planDetail(serviceTypeId, planId);
  const meta = upcoming.find((p) => p.id === planId);
  if (meta) detail.plan.serviceTypeName = meta.serviceTypeName;
  detailCache.set(planId, { detail, at: Date.now() });
  if (active?.plan.id === planId) {
    active = detail;
    events.emit('change');
  }
  return detail;
}

export function start() {
  const loop = async () => {
    await syncNow();
    const secs = Math.max(20, Number(store.get().settings.pco.pollSeconds) || 60);
    timer = setTimeout(loop, secs * 1000);
  };
  loop();
}

export function restart() {
  if (timer) clearTimeout(timer);
  start();
}
