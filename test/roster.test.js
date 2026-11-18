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

test('merges positions, filters teams and declined people', () => {
  const { teams } = buildRoster(detail, db());
  assert.deepEqual(teams.map((t) => t.name), ['Worship']);
  assert.deepEqual(teams[0].members[0].positions, ['Vocals', 'Keys']);
  assert.equal(teams[0].members[0].status, 'C');
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
