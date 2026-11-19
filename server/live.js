// "Services LIVE"-style timing: when an order-of-service item goes live in
// ProPresenter, start a clock on it, and record how long each item actually ran.
//
// Rules:
//  • Only records during Planning Center *service* times (never rehearsals), from
//    a short pre-roll before each service starts until a little after it ends.
//  • An item stays live until a different item goes live (like Services LIVE), so
//    clearing slides or showing a non-plan presentation doesn't stop the clock.
//  • Each service time (e.g. 9:00 and 11:00) is recorded separately. Revisiting an
//    item adds to its total.
import { EventEmitter } from 'node:events';
import * as store from './store.js';
import * as pp from './propresenter.js';
import * as sync from './sync.js';

export const events = new EventEmitter();
const MIN_SEGMENT_SECONDS = 3; // ignore quick click-throughs

// ---- pure helpers (unit-tested) ---------------------------------------------------

export function normalise(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Plan item matching ProPresenter's live presentation name (exact first, then containment). */
export function matchItem(items, presentationName) {
  const active = normalise(presentationName);
  if (!active) return null;
  const candidates = (items || []).filter((i) => i.type !== 'header').map((i) => ({ id: i.id, t: normalise(i.title) })).filter((i) => i.t);
  const exact = candidates.find((i) => i.t === active);
  if (exact) return exact.id;
  const partial = candidates.find((i) => Math.min(i.t.length, active.length) >= 4 && (active.includes(i.t) || i.t.includes(active)));
  return partial ? partial.id : null;
}

/**
 * The service time (not rehearsal) whose recording window contains `now`, if any.
 * Where windows overlap (9:00's post-roll vs 11:00's pre-roll) a service that is in
 * progress wins, then one about to start, then one that just ended.
 */
export function serviceWindow(times, now, { preRollMinutes = 20, postRollMinutes = 15 } = {}) {
  const rank = (w) => (now >= w.start && now <= w.end ? 0 : now < w.start ? 1 : 2);
  let best = null;
  for (const t of times || []) {
    if (t.type !== 'service') continue;
    const start = Date.parse(t.startsAt);
    let end = t.endsAt ? Date.parse(t.endsAt) : NaN;
    if (!(end > start)) end = start + 90 * 60_000; // no end time in PCO → assume 90 min
    const from = start - preRollMinutes * 60_000;
    const to = end + postRollMinutes * 60_000;
    const w = { id: t.id, start, end, from, to };
    if (now >= from && now <= to && (!best || rank(w) < rank(best))) best = w;
  }
  return best;
}

/**
 * Production test mode: a temporary recording window starting now, recorded under
 * the pseudo service time "test" so real service data is never touched.
 */
export function testWindow(liveTest, now) {
  if (!liveTest || now > liveTest.until) return null;
  return { id: 'test', start: liveTest.startedAt, end: liveTest.until, from: liveTest.startedAt, to: liveTest.until, test: true };
}

/** Real service windows always win; test mode only applies outside them (e.g. during rehearsal). */
export function currentWindow(db, detail, now) {
  if (!detail) return null;
  const real = db.settings.live.enabled ? serviceWindow(detail.plan.times, now, db.settings.live) : null;
  return real || testWindow(db.liveTest, now);
}

/** A copy of the plan kept with its recordings, so history survives later edits in Planning Center. */
export function planSnapshot(detail) {
  const p = detail.plan;
  return {
    planId: p.id,
    serviceTypeId: p.serviceTypeId || null,
    serviceTypeName: p.serviceTypeName || '',
    title: p.title || null,
    seriesTitle: p.seriesTitle || null,
    dates: p.dates || '',
    sortDate: p.sortDate || null,
    times: (p.times || []).map(({ id, name, type, startsAt, endsAt }) => ({ id, name, type, startsAt, endsAt })),
    items: (detail.items || []).map(({ id, title, type, length, position, sequence }) => ({ id, title, type, length: length || 0, position, sequence })),
    savedAt: new Date().toISOString(),
  };
}

/**
 * One step of the timing state machine.
 * current: { planId, planTimeId, itemId, startedAt, windowEnd } | null
 * Returns the new current item and any finished segments to record.
 */
export function step(current, { planId, window, matchedItemId, now }) {
  const closed = [];
  const close = (c, at) => {
    const endedAt = Math.min(at, c.windowEnd);
    const seconds = Math.round((endedAt - c.startedAt) / 1000);
    if (seconds >= MIN_SEGMENT_SECONDS) closed.push({ planId: c.planId, planTimeId: c.planTimeId, itemId: c.itemId, startedAt: c.startedAt, endedAt, seconds });
  };
  if (current && (!window || current.planId !== planId || current.planTimeId !== window.id || now > current.windowEnd)) {
    close(current, now);
    current = null;
  }
  if (window && matchedItemId && (!current || current.itemId !== matchedItemId)) {
    if (current) close(current, now);
    current = { planId, planTimeId: window.id, itemId: matchedItemId, startedAt: now, windowEnd: window.to };
  }
  return { current, closed };
}

// ---- runtime -------------------------------------------------------------------------

export function tick(now = Date.now()) {
  const db = store.get();
  if (db.liveTest && now > db.liveTest.until) store.update((d) => { d.liveTest = null; }, { topic: 'live' }); // test mode expired
  const detail = sync.getActive();
  const win = currentWindow(db, detail, now);
  const ppState = pp.getState();
  const matched = win && ppState.connected ? matchItem(detail.items, ppState.activePresentation) : null;
  const res = step(db.liveCurrent, { planId: detail?.plan.id, window: win, matchedItemId: matched, now });
  if (res.closed.length || JSON.stringify(res.current) !== JSON.stringify(db.liveCurrent)) {
    store.update((d) => {
      d.liveCurrent = res.current;
      // Keep a copy of the plan alongside real (non-test) recordings for History.
      if (detail && win && !win.test) (d.history ??= {})[detail.plan.id] = planSnapshot(detail);
      for (const s of res.closed) {
        const rec = ((d.live[s.planId] ??= {})[s.planTimeId] ??= { items: {}, segments: [] });
        rec.items[s.itemId] = (rec.items[s.itemId] || 0) + s.seconds;
        rec.segments.push({ itemId: s.itemId, startedAt: s.startedAt, endedAt: s.endedAt, seconds: s.seconds });
      }
    }, { topic: 'live' });
  }
}

/** What the dashboard needs: which service time is shown, actuals, and the running item. */
export function summary(detail, db, now = Date.now()) {
  if (!detail) return null;
  const planId = detail.plan.id;
  const records = db.live[planId] || {};
  const services = (detail.plan.times || []).filter((t) => t.type === 'service');
  const cur = db.liveCurrent?.planId === planId ? db.liveCurrent : null;
  const win = currentWindow(db, detail, now);
  let shownId = cur?.planTimeId || win?.id || null;
  if (!shownId) {
    // Between/after services: show the most recent service time that has recordings.
    const past = services.filter((t) => Date.parse(t.startsAt) <= now && records[t.id]);
    shownId = past.at(-1)?.id || null;
  }
  const t = services.find((x) => x.id === shownId);
  return {
    enabled: db.settings.live.enabled,
    planTimeId: shownId,
    test: shownId === 'test',
    testUntil: db.liveTest?.until || null,
    startsAt: t?.startsAt || null,
    inWindow: Boolean(win),
    recording: Boolean(cur),
    currentItemId: cur?.itemId || null,
    currentStartedAt: cur?.startedAt || null,
    actuals: records[shownId]?.items || {},
  };
}

export function start() {
  setInterval(() => tick(), 5000); // also closes the last item when a window ends
  pp.events.on('change', () => tick());
  sync.events.on('change', () => tick());
}
