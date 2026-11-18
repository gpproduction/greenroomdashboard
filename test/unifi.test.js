import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseName, nameKeys, buildArrivals, arrivalFor, startOfDay } from '../server/unifi.js';

test('normalises names: case, accents, nicknames, punctuation', () => {
  assert.equal(normaliseName('Mackenzie "Kenzie" Smith'), 'mackenzie smith');
  assert.equal(normaliseName('  José   García-López '), 'jose garcia lopez');
  assert.equal(normaliseName("Liam O'Brien"), 'liam o brien');
});

test('matches by full name, first+last, and nickname+last', () => {
  const map = buildArrivals([
    { _source: { actor: { display_name: 'Kenzie Smith', type: 'user' }, event: { result: 'ACCESS', published: 1000 } } },
    { _source: { actor: { display_name: 'Hayden Cougill', type: 'user' }, event: { result: 'ACCESS', published: 2000 } } },
    { _source: { actor: { display_name: 'Roslyn Ann Nicoloff', type: 'user' }, event: { result: 'ACCESS', published: 3000 } } },
  ]);
  assert.equal(arrivalFor('Mackenzie "Kenzie" Smith', map)?.ts, 1000);
  assert.equal(arrivalFor('hayden cougill', map)?.ts, 2000);
  assert.equal(arrivalFor('Roslyn Nicoloff', map)?.ts, 3000);
  assert.equal(arrivalFor('Nico Curtis', map), null);
});

test('only granted unlocks by users count; earliest arrival wins', () => {
  const map = buildArrivals([
    { _source: { actor: { display_name: 'Josh Smith', type: 'user' }, event: { result: 'BLOCKED', published: 500 } } },
    { _source: { actor: { display_name: 'Josh Smith', type: 'user' }, event: { result: 'ACCESS', published: 900 } } },
    { _source: { actor: { display_name: 'Josh Smith', type: 'user' }, event: { result: 'ACCESS', published: 700 } } },
    { _source: { actor: { display_name: 'N/A', type: 'user' }, event: { result: 'ACCESS', published: 100 } } },
  ]);
  assert.equal(arrivalFor('Josh Smith', map).ts, 700);
  assert.equal(map.size, 1);
});

test('startOfDay uses the church time zone', () => {
  const now = Date.UTC(2026, 10, 22, 14, 30); // 9:30 AM New York
  assert.equal(startOfDay('America/New_York', now), Date.UTC(2026, 10, 22, 5, 0));
  assert.ok(nameKeys('').size === 0);
});

import { arrivalWindowStart } from '../server/unifi.js';

test('arrivals count from 1h before the first rehearsal/service time today', () => {
  const NY = 'America/New_York';
  const iso = (h, m = 0, d = 22) => new Date(Date.UTC(2026, 10, d, h, m)).toISOString(); // UTC; NY = UTC-5
  const times = [
    { type: 'rehearsal', startsAt: iso(23, 30, 18) }, // Wed 6:30 PM NY
    { type: 'rehearsal', startsAt: iso(12, 45) }, // Sun 7:45 AM sound check
    { type: 'service', startsAt: iso(14) }, // Sun 9:00
    { type: 'service', startsAt: iso(16) }, // Sun 11:00
    { type: 'other', startsAt: iso(11) }, // ignored
  ];
  const at = (h, m = 0, d = 22) => Date.UTC(2026, 10, d, h, m);
  assert.equal(arrivalWindowStart(times, at(11, 30), NY), null); // 6:30 AM — too early
  assert.equal(arrivalWindowStart(times, at(11, 50), NY), at(11, 45)); // from 6:45 AM (sound check − 1h)
  assert.equal(arrivalWindowStart(times, at(17), NY), at(11, 45)); // still counting at noon
  assert.equal(arrivalWindowStart(times, at(23, 0, 18), NY), at(22, 30, 18)); // Wed rehearsal: from 5:30 PM
  assert.equal(arrivalWindowStart(times, at(17, 0, 19), NY), null); // Thursday: nothing scheduled
  assert.equal(arrivalWindowStart(times, at(12, 0), NY, 30), null); // 7:00 AM, 30-min lead opens at 7:15
  assert.equal(arrivalWindowStart(times, at(12, 30), NY, 30), at(12, 15)); // custom lead time
});
