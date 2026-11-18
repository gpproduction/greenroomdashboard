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

test('merges positions, filters teams/declined, dashboard shows only assigned people', () => {
  const data = db({ defaults: { 'p:1': { mic: 'm1' }, 'p:3': { mic: 'm1' }, 'p:4': { iem: 'e1' } } });
  const { teams } = buildRoster(detail, data);
  assert.deepEqual(teams.map((t) => t.name), ['Worship']); // Cy declined, Host team filtered out
  assert.deepEqual(teams[0].members.map((m) => m.name), ['Ann']); // Bob has nothing assigned
  assert.deepEqual(teams[0].members[0].positions, ['Vocals', 'Keys']);
  assert.equal(teams[0].members[0].status, 'C');
  // The admin view still lists everyone so they can be assigned.
  const admin = buildRoster(detail, data, { forAdmin: true });
  assert.deepEqual(admin.teams.find((t) => t.name === 'Worship').members.map((m) => m.name), ['Ann', 'Bob']);
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

