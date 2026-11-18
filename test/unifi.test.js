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
