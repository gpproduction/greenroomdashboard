import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceWindow, step, matchItem } from '../server/live.js';

const T = (h, m = 0) => Date.UTC(2026, 10, 22, h, m); // Nov 22 2026, UTC
const times = [
  { id: 'reh', type: 'rehearsal', startsAt: new Date(T(12, 45)).toISOString(), endsAt: new Date(T(13, 45)).toISOString() },
  { id: 's9', type: 'service', startsAt: new Date(T(14)).toISOString(), endsAt: new Date(T(15, 30)).toISOString() },
  { id: 's11', type: 'service', startsAt: new Date(T(16)).toISOString(), endsAt: new Date(T(17, 30)).toISOString() },
];
const cfg = { preRollMinutes: 20, postRollMinutes: 15 };

test('rehearsal times are never a recording window', () => {
  assert.equal(serviceWindow(times, T(13, 0), cfg), null);
  assert.equal(serviceWindow(times, T(13, 39), cfg), null);
});

test('window opens at pre-roll and closes after post-roll', () => {
  assert.equal(serviceWindow(times, T(13, 40), cfg).id, 's9');
  assert.equal(serviceWindow(times, T(15, 35), cfg).id, 's9'); // 9:00 post-roll
  assert.equal(serviceWindow(times, T(15, 42), cfg).id, 's11'); // overlap: the upcoming service wins over a finished one
  assert.equal(serviceWindow(times, T(17, 45), cfg).id, 's11');
  assert.equal(serviceWindow(times, T(17, 46), cfg), null);
});

test('a service in progress wins any overlap', () => {
  const tight = [
    { id: 'a', type: 'service', startsAt: new Date(T(14)).toISOString(), endsAt: new Date(T(15)).toISOString() },
    { id: 'b', type: 'service', startsAt: new Date(T(15, 10)).toISOString(), endsAt: new Date(T(16)).toISOString() },
  ];
  assert.equal(serviceWindow(tight, T(14, 55), cfg).id, 'a'); // b's pre-roll began 14:50
});

test('items are sticky and accumulate; switching records the previous item', () => {
  const win = serviceWindow(times, T(14, 0), cfg);
  let r = step(null, { planId: 'P', window: win, matchedItemId: 'song1', now: T(14, 0) });
  assert.equal(r.current.itemId, 'song1');
  r = step(r.current, { planId: 'P', window: win, matchedItemId: null, now: T(14, 2) }); // slides cleared
  assert.equal(r.current.itemId, 'song1');
  assert.equal(r.closed.length, 0);
  r = step(r.current, { planId: 'P', window: win, matchedItemId: 'song2', now: T(14, 5) });
  assert.equal(r.current.itemId, 'song2');
  assert.deepEqual(r.closed.map((c) => [c.itemId, c.planTimeId, c.seconds]), [['song1', 's9', 300]]);
});

test('quick click-throughs (<3s) are ignored', () => {
  const win = serviceWindow(times, T(14, 0), cfg);
  let r = step(null, { planId: 'P', window: win, matchedItemId: 'a', now: T(14, 0) });
  r = step(r.current, { planId: 'P', window: win, matchedItemId: 'b', now: T(14, 0) + 2000 });
  assert.equal(r.closed.length, 0);
});

test('leaving the window closes the item at the window end', () => {
  const win = serviceWindow(times, T(15, 20), cfg);
  let r = step(null, { planId: 'P', window: win, matchedItemId: 'dismissal', now: T(15, 20) });
  r = step(r.current, { planId: 'P', window: null, matchedItemId: null, now: T(16, 30) });
  assert.equal(r.current, null);
  assert.equal(r.closed[0].seconds, 25 * 60); // 15:20 → window end 15:45
});

test('each service time is recorded separately', () => {
  const w9 = serviceWindow(times, T(15, 0), cfg);
  const w11 = serviceWindow(times, T(16, 0), cfg);
  let r = step(null, { planId: 'P', window: w9, matchedItemId: 'x', now: T(15, 0) });
  r = step(r.current, { planId: 'P', window: w11, matchedItemId: 'x', now: T(16, 0) });
  assert.equal(r.closed[0].planTimeId, 's9');
  assert.equal(r.current.planTimeId, 's11');
});

test('matchItem prefers exact titles and skips headers', () => {
  const items = [{ id: 'h', type: 'header', title: 'Worship' }, { id: 'a', type: 'song', title: 'Raise A Hallelujah' }, { id: 'b', type: 'song', title: 'Worship' }];
  assert.equal(matchItem(items, 'Raise a Hallelujah (Live)'), 'a');
  assert.equal(matchItem(items, 'WORSHIP'), 'b');
  assert.equal(matchItem(items, 'Walk-in Loop'), null);
});

import { testWindow, currentWindow } from '../server/live.js';

test('test mode records under "test", during rehearsal too, and expires', () => {
  const db = { settings: { live: { enabled: true, ...cfg } }, liveTest: { startedAt: T(13, 0), until: T(14, 0) } };
  const detail = { plan: { times } };
  assert.equal(currentWindow(db, detail, T(13, 10)).id, 'test'); // during sound check
  assert.equal(currentWindow(db, detail, T(13, 50)).id, 's9'); // real service window wins
  assert.equal(testWindow(db.liveTest, T(14, 1)), null); // expired
  assert.equal(currentWindow({ ...db, liveTest: null }, detail, T(13, 10)), null);
});

test('test mode works even when live recording is turned off', () => {
  const db = { settings: { live: { enabled: false, ...cfg } }, liveTest: { startedAt: T(14, 0), until: T(15, 0) } };
  assert.equal(currentWindow(db, { plan: { times } }, T(14, 30)).id, 'test');
});
