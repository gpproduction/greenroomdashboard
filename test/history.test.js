import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyList, historyDetail, historyTrends, historyCsv, serviceActual } from '../server/history.js';

const snap = (planId, date, sermonLen = 2100) => ({
  planId, serviceTypeName: 'Sunday Morning', seriesTitle: 'Series', dates: date, sortDate: `${date}T14:00:00Z`,
  times: [
    { id: `${planId}-reh`, type: 'rehearsal', startsAt: `${date}T12:45:00Z` },
    { id: `${planId}-9`, type: 'service', startsAt: `${date}T14:00:00Z` },
    { id: `${planId}-11`, type: 'service', startsAt: `${date}T16:00:00Z` },
  ],
  items: [
    { id: 'h', title: 'Worship', type: 'header', length: 0, position: 'during' },
    { id: 's1', title: 'Song A', type: 'song', length: 300, position: 'during' },
    { id: 'w', title: 'Welcome', type: 'item', length: 120, position: 'during' },
    { id: 'm', title: 'Message', type: 'item', length: sermonLen, position: 'during' },
    { id: 'c', title: 'Countdown', type: 'media', length: 300, position: 'pre' },
  ],
});
const db = {
  history: { A: snap('A', '2026-11-15'), B: snap('B', '2026-11-22') },
  live: {
    A: { 'A-9': { items: { s1: 310, w: 200, m: 2400 } }, test: { items: { s1: 5 } } },
    B: { 'B-9': { items: { s1: 290, w: 150, m: 2300, gone: 60 } }, 'B-11': { items: { w: 100, m: 2000 } } },
  },
};
const NY = 'America/New_York';

test('lists recorded plans newest first with per-service totals (test times excluded)', () => {
  const list = historyList(db, NY);
  assert.deepEqual(list.map((p) => p.planId), ['B', 'A']);
  assert.deepEqual(list[0].services.map((s) => s.label), ['9:00 AM', '11:00 AM']);
  const a9 = list[1].services[0];
  assert.equal(a9.planned, 300 + 120 + 2100); // "during" items only, headers excluded
  assert.equal(a9.actual, 310 + 200 + 2400);
  assert.equal(a9.delta, 2910 - 2520);
  assert.equal(list[1].services.length, 1); // "test" bucket not listed
});

test('detail shows per-item planned vs actual, including items no longer in the plan', () => {
  const d = historyDetail(db, 'B', NY);
  const m = d.items.find((i) => i.id === 'm');
  assert.deepEqual(m.actual, { 'B-9': 2300, 'B-11': 2000 });
  assert.ok(d.items.some((i) => i.title === '(item no longer in plan)' && i.actual['B-9'] === 60));
});

test('trends average recurring non-song items across weeks', () => {
  const t = historyTrends(db, NY);
  assert.equal(t.weeks, 2);
  const msg = t.items.find((i) => i.title === 'Message');
  assert.equal(msg.weeks, 2);
  assert.equal(msg.services, 3);
  assert.equal(msg.avgActual, Math.round((2400 + 2300 + 2000) / 3));
  assert.ok(!t.items.some((i) => i.title === 'Song A')); // songs excluded
  assert.equal(t.items[0].title, 'Message'); // most over first
});

test('CSV has a header, item rows and totals; quotes commas', () => {
  const d2 = structuredClone(db);
  d2.history.A.items[2].title = 'Welcome, New Here';
  const csv = historyCsv(d2, NY, 'A');
  const lines = csv.trim().split('\r\n');
  assert.match(lines[0], /^Date,Service type/);
  assert.ok(lines.some((l) => l.includes('"Welcome, New Here"') && l.includes('3:20')));
  assert.ok(lines.some((l) => l.includes(',TOTAL,') && l.includes('48:30')));
});

test('service totals count main-service items only, not the pre-service countdown', () => {
  const withCountdown = { ...db, live: { A: { 'A-9': { items: { c: 600, s1: 310, w: 200, m: 2400, gone: 30 } } } }, history: { A: db.history.A } };
  const [plan] = historyList(withCountdown, NY);
  assert.equal(plan.services[0].actual, 310 + 200 + 2400 + 30); // countdown's 600 left out; removed item still counts
  assert.equal(plan.services[0].planned, 300 + 120 + 2100);
  const d = historyDetail(withCountdown, 'A', NY);
  assert.equal(d.items.find((i) => i.id === 'c').actual['A-9'], 600); // its own row keeps its time
});

test('serviceActual counts everything when there is no saved plan', () => {
  assert.equal(serviceActual(null, { a: 10, b: 20 }), 30);
});
