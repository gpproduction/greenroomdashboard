import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoster, personKey } from '../server/roster.js';
import { pickActivePlan } from '../server/pco.js';

const detail = {
  plan: { id: 'P1' },
  members: [
    { personId: '1', name: 'Ann', teamId: 'w', teamName: 'Worship', position: 'Vocals', status: 'C' },
    { personId: '1', name: 'Ann', teamId: 'w', teamName: 'Worship', position: 'Keys', status: 'U' },
    { personId: '2', name: 'Bob', teamId: 'w', teamName: 'Worship', position: 'Drums', status: 'C' },
    { personId: '3', name: 'Cy', teamId: 'p', teamName: 'Production', position: 'Sound', status: 'D' },
    { personId: '4', name: 'Di', teamId: 'h', teamName: 'Host', position: 'Greeter', status: 'C' },
  ],
};
const db = (over = {}) => ({
  settings: { pco: { teamIds: ['w', 'p'], hideDeclined: true } },
  devices: [{ id: 'm1', type: 'mic', name: 'HH1' }, { id: 'e1', type: 'iem', name: 'IEM1' }],
  assignments: {}, defaults: {}, extras: {}, ...over,
});

test('merges positions, filters teams/declined; Worship shows everyone by default', () => {
  const data = db({ defaults: { 'p:1': { mic: 'm1' }, 'p:3': { mic: 'm1' }, 'p:4': { iem: 'e1' } } });
  const { teams } = buildRoster(detail, data);
  assert.deepEqual(teams.map((t) => t.name), ['Worship']); // Cy declined; Host team filtered out
  assert.deepEqual(teams[0].members.map((m) => m.name), ['Ann', 'Bob']); // Bob has no device but Worship shows everyone
  assert.deepEqual(teams[0].members[0].positions, ['Vocals', 'Keys']);
  assert.equal(teams[0].members[0].status, 'C');
});

test('show on dashboard: devices always show; checkbox and team default otherwise', () => {
  const det = { plan: { id: 'P1' }, members: [
    { personId: '1', name: 'Ann', teamId: 'w', teamName: 'Worship Team', position: 'Vocals', status: 'C' },
    { personId: '2', name: 'Bob', teamId: 'w', teamName: 'Worship Team', position: 'Drums', status: 'C' },
    { personId: '5', name: 'Eve', teamId: 'p', teamName: 'Production', position: 'Camera', status: 'C' },
    { personId: '6', name: 'Fay', teamId: 'p', teamName: 'Production', position: 'Speaker', status: 'C' },
  ] };
  const names = (r) => r.teams.flatMap((t) => t.members.map((m) => m.name));
  // Bob hidden by his own checkbox, Eve shown by hers, Fay shown because she has an "other" device.
  const data = db({ defaults: { 'p:6': { other: 'o1' } }, visibility: { 'w|p:2': false, 'p|p:5': true } });
  data.devices.push({ id: 'o1', type: 'other', name: 'Acoustic Pack' });
  assert.deepEqual(names(buildRoster(det, data)), ['Ann', 'Eve', 'Fay']);
  // A device beats an explicit "hide".
  data.visibility['p|p:6'] = false;
  assert.ok(names(buildRoster(det, data)).includes('Fay'));
  // Team default can be changed in settings.
  const d2 = db({ settings: { pco: { teamIds: ['w', 'p'], hideDeclined: true, defaultVisibleTeamIds: ['p'] } } });
  assert.deepEqual(names(buildRoster(det, d2)), ['Eve', 'Fay']);
  // Admin still lists everyone, with the effective choice.
  const admin = buildRoster(det, data, { forAdmin: true });
  const bob = admin.teams[0].members.find((m) => m.name === 'Bob');
  assert.equal(bob.shown, false);
});

test('defaults fill in, explicit per-plan choice (including none) wins', () => {
  const { teams } = buildRoster(detail, db({
    defaults: { 'p:1': { mic: 'm1', iem: 'e1' } },
    assignments: { P1: { 'p:1': { iem: null } } },
  }));
  const ann = teams[0].members[0];
  assert.equal(ann.mic.id, 'm1');
  assert.equal(ann.mic.source, 'default');
  assert.equal(ann.iem, null);
});

test('flags the same device on two people', () => {
  const { conflicts } = buildRoster(detail, db({ defaults: { 'p:1': { mic: 'm1' }, 'p:2': { mic: 'm1' } } }));
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].people.sort(), ['Ann', 'Bob']);
});

test('personKey falls back to name', () => {
  assert.equal(personKey({ personId: null, name: 'Guest Person' }), 'n:guest person');
});

test('pickActivePlan keeps a plan until 2h after its last time', () => {
  const plans = [
    { id: 'a', sortDate: '2026-11-22T14:00:00Z', times: [{ startsAt: '2026-11-22T14:00:00Z', endsAt: '2026-11-22T17:30:00Z' }] },
    { id: 'b', sortDate: '2026-11-29T14:00:00Z', times: [{ startsAt: '2026-11-29T14:00:00Z', endsAt: '2026-11-29T17:30:00Z' }] },
  ];
  assert.equal(pickActivePlan(plans, Date.parse('2026-11-22T19:00:00Z')).id, 'a');
  assert.equal(pickActivePlan(plans, Date.parse('2026-11-22T20:00:00Z')).id, 'b');
});

import { assignmentChanges } from '../server/roster.js';

const linkDb = (over = {}) => ({
  devices: [
    { id: 'm1', type: 'mic', linkedId: 'e1' }, { id: 'e1', type: 'iem', linkedId: 'm1' },
    { id: 'm2', type: 'mic', linkedId: 'e2' }, { id: 'e2', type: 'iem', linkedId: 'm2' },
    { id: 'e9', type: 'iem', linkedId: null }, { id: 'm9', type: 'mic', linkedId: null },
  ],
  assignments: {}, defaults: {}, ...over,
});

test('linked: picking a mic fills the empty IEM slot', () => {
  assert.deepEqual(assignmentChanges(linkDb(), 'P', 'k', 'mic', 'm1'), { mic: 'm1', iem: 'e1' });
});

test('linked: switching mic moves the IEM along with it', () => {
  const db = linkDb({ assignments: { P: { k: { mic: 'm1', iem: 'e1' } } } });
  assert.deepEqual(assignmentChanges(db, 'P', 'k', 'mic', 'm2'), { mic: 'm2', iem: 'e2' });
});

test('linked: a manually overridden IEM is left alone', () => {
  const db = linkDb({ assignments: { P: { k: { mic: 'm1', iem: 'e9' } } } });
  assert.deepEqual(assignmentChanges(db, 'P', 'k', 'mic', 'm2'), { mic: 'm2' });
});

test('linked: changing the IEM never changes the mic', () => {
  const db = linkDb({ assignments: { P: { k: { mic: 'm1', iem: 'e1' } } } });
  assert.deepEqual(assignmentChanges(db, 'P', 'k', 'iem', 'e2'), { iem: 'e2' });
  assert.deepEqual(assignmentChanges(linkDb(), 'P', 'k', 'iem', 'e2'), { iem: 'e2' }); // IEM-only (drummer)
});

test('linked: clearing the mic clears its partner IEM; unlinked mic leaves slot empty', () => {
  const db = linkDb({ defaults: { k: { mic: 'm1', iem: 'e1' } } });
  assert.deepEqual(assignmentChanges(db, 'P', 'k', 'mic', null), { mic: null, iem: null });
  assert.deepEqual(assignmentChanges(db, 'P', 'k', 'mic', 'm9'), { mic: 'm9', iem: null });
});

