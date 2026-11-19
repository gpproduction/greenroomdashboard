// History of recorded services: planned vs actual per item, trends across weeks, CSV.
// Built from db.live (recordings) + db.history (a copy of each plan saved while recording).
import { planSnapshot } from './live.js';

const isService = (id) => id !== 'test';

/** Snapshot for a plan: the saved copy, else the cached current plan if it matches. */
function snapshotFor(db, planId) {
  if (db.history?.[planId]) return db.history[planId];
  if (db.lastPlan?.plan?.id === planId) return planSnapshot(db.lastPlan);
  return null;
}

function timeLabel(iso, timeZone) {
  if (!iso) return 'Service';
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
  } catch {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
}

const plannedTotal = (snap) => (snap?.items || []).filter((i) => i.type !== 'header' && i.position === 'during').reduce((a, i) => a + (i.length || 0), 0);

/** One row per recorded plan, newest first. */
export function historyList(db, timeZone) {
  const out = [];
  for (const [planId, byTime] of Object.entries(db.live || {})) {
    const timeIds = Object.keys(byTime).filter(isService);
    if (!timeIds.length) continue;
    const snap = snapshotFor(db, planId);
    const planned = plannedTotal(snap);
    const services = timeIds.map((tid) => {
      const t = snap?.times?.find((x) => x.id === tid);
      const actual = Object.values(byTime[tid].items || {}).reduce((a, v) => a + v, 0);
      return { planTimeId: tid, startsAt: t?.startsAt || byTime[tid].segments?.[0]?.startedAt || null, label: timeLabel(t?.startsAt, timeZone), actual, planned, delta: planned ? actual - planned : null };
    }).sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));
    out.push({
      planId,
      dates: snap?.dates || 'Unknown date',
      sortDate: snap?.sortDate || services[0]?.startsAt || null,
      serviceTypeName: snap?.serviceTypeName || '',
      title: snap?.title || snap?.seriesTitle || '',
      hasSnapshot: Boolean(snap),
      services,
    });
  }
  return out.sort((a, b) => String(b.sortDate || '').localeCompare(String(a.sortDate || '')));
}

/** Planned vs actual for every item of one plan, per service time. */
export function historyDetail(db, planId, timeZone) {
  const byTime = db.live?.[planId];
  if (!byTime) return null;
  const snap = snapshotFor(db, planId);
  const entry = historyList(db, timeZone).find((e) => e.planId === planId);
  const known = new Set((snap?.items || []).map((i) => i.id));
  const items = (snap?.items || []).map((i) => ({
    id: i.id, title: i.title, type: i.type, position: i.position, length: i.length || 0,
    actual: Object.fromEntries(entry.services.map((s) => [s.planTimeId, byTime[s.planTimeId]?.items?.[i.id] || 0])),
  }));
  // Items that were recorded but are no longer in the saved plan.
  for (const s of entry.services) {
    for (const id of Object.keys(byTime[s.planTimeId]?.items || {})) {
      if (known.has(id)) continue;
      known.add(id);
      items.push({ id, title: '(item no longer in plan)', type: 'item', position: 'during', length: 0,
        actual: Object.fromEntries(entry.services.map((x) => [x.planTimeId, byTime[x.planTimeId]?.items?.[id] || 0])) });
    }
  }
  return { ...entry, items };
}

const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Recurring items across the last `limit` recorded plans (e.g. Welcome, Message):
 * average planned vs actual per item title, plus whole-service averages.
 */
export function historyTrends(db, timeZone, limit = 8) {
  const plans = historyList(db, timeZone).filter((p) => p.hasSnapshot).slice(0, limit);
  const byTitle = new Map();
  const serviceDeltas = [];
  for (const p of plans) {
    const d = historyDetail(db, p.planId, timeZone);
    for (const s of p.services) if (s.delta != null && s.actual > 0) serviceDeltas.push({ actual: s.actual, planned: s.planned });
    for (const it of d.items) {
      if (it.type === 'header' || it.type === 'song') continue; // songs change week to week
      for (const s of p.services) {
        const a = it.actual[s.planTimeId];
        if (!a) continue;
        const k = norm(it.title);
        if (!byTitle.has(k)) byTitle.set(k, { title: it.title, n: 0, actual: 0, planned: 0, plans: new Set() });
        const row = byTitle.get(k);
        row.n += 1; row.actual += a; row.planned += it.length || 0; row.plans.add(p.planId);
      }
    }
  }
  const items = [...byTitle.values()]
    .filter((r) => r.plans.size >= 2) // recurring only
    .map((r) => ({ title: r.title, services: r.n, weeks: r.plans.size, avgActual: Math.round(r.actual / r.n), avgPlanned: Math.round(r.planned / r.n), avgDelta: Math.round((r.actual - r.planned) / r.n) }))
    .sort((a, b) => b.avgDelta - a.avgDelta);
  const svc = serviceDeltas.length
    ? { services: serviceDeltas.length, avgActual: Math.round(serviceDeltas.reduce((a, s) => a + s.actual, 0) / serviceDeltas.length), avgPlanned: Math.round(serviceDeltas.reduce((a, s) => a + s.planned, 0) / serviceDeltas.length) }
    : null;
  return { weeks: plans.length, service: svc, items };
}

const mmss = (secs) => {
  const neg = secs < 0;
  secs = Math.abs(Math.round(secs || 0));
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return (neg ? '-' : '') + (h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`);
};
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV of every recorded item (one plan, or all plans). Opens in Excel / Google Sheets. */
export function historyCsv(db, timeZone, planId = null) {
  const rows = [['Date', 'Service type', 'Series / title', 'Service time', 'Item', 'Type', 'Planned', 'Actual', 'Difference', 'Planned (sec)', 'Actual (sec)']];
  for (const p of historyList(db, timeZone)) {
    if (planId && p.planId !== planId) continue;
    const d = historyDetail(db, p.planId, timeZone);
    for (const s of d.services) {
      for (const it of d.items) {
        if (it.type === 'header') continue;
        const a = it.actual[s.planTimeId] || 0;
        if (!a && !it.length) continue;
        rows.push([p.dates, p.serviceTypeName, p.title, s.label, it.title, it.type, mmss(it.length), a ? mmss(a) : '', a && it.length ? mmss(a - it.length) : '', it.length || 0, a]);
      }
      rows.push([p.dates, p.serviceTypeName, p.title, s.label, 'TOTAL', '', mmss(s.planned), mmss(s.actual), s.delta != null ? mmss(s.delta) : '', s.planned, s.actual]);
    }
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
