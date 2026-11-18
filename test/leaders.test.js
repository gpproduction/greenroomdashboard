import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A fake Planning Center Services API shaped like the real JSON:API responses.
function fakePco() {
  const plan = { type: 'Plan', id: 'P', attributes: { title: null, series_title: 'S', dates: 'November 22, 2026', sort_date: '2026-11-22T14:00:00Z', total_length: 0 }, relationships: { plan_times: { data: [] } } };
  const item = (id, title, assignmentIds) => ({ type: 'Item', id, attributes: { title, item_type: 'song', length: 300, sequence: Number(id.slice(1)), service_position: 'during' }, relationships: { item_notes: { data: [] }, item_assignments: { data: assignmentIds.map((a) => ({ type: 'ItemAssignment', id: a })) } } });
  const assign = (id, type, targetId, withAssignable = true) => ({ type: 'ItemAssignment', id, attributes: { assignable_type: type }, relationships: { item: { data: null }, ...(withAssignable ? { assignable: { data: { type, id: targetId } } } : {}) } });
  const member = (personId, name, position, status = 'C') => ({ type: 'PlanPerson', id: `pp${personId}`, attributes: { name, team_position_name: position, status, photo_thumbnail: `https://avatars.planningcenteronline.com/${personId}.jpg` }, relationships: { person: { data: { type: 'Person', id: personId } }, team: { data: { type: 'Team', id: 't1' } } } });
  const routes = {
    '/service_types/st/plans/P': { data: plan, included: [] },
    '/service_types/st/plans/P/items': {
      data: [item('i1', 'Wait (Like A Seed)', ['a1']), item('i2', 'Raise A Hallelujah', ['a2']), item('i3', 'Message', ['a3']), item('i4', 'With You', ['a4']), item('i5', 'Doors Open', [])],
      included: [assign('a1', 'Person', '101'), assign('a2', 'TeamPosition', '900'), assign('a3', 'Person', '555'), assign('a4', 'Person', '102', false)],
    },
    '/service_types/st/plans/P/items/i4/item_assignments': { data: [assign('a4', 'Person', '102')] },
    '/service_types/st/plans/P/team_members': {
      data: [member('101', 'Nico Curtis', 'Vocals'), member('102', 'Sumer Smith', 'Worship Leader'), member('104', 'Bailee Reitz', 'Worship Leader'), member('103', 'Roslyn Nicoloff', 'Worship Leader', 'D')],
      included: [{ type: 'Team', id: 't1', attributes: { name: 'Worship Team' } }],
    },
    '/service_types/st/teams': { data: [{ type: 'Team', id: 't1', attributes: { name: 'Worship Team' }, relationships: { team_positions: { data: [{ type: 'TeamPosition', id: '900' }] } } }], included: [{ type: 'TeamPosition', id: '900', attributes: { name: 'Worship Leader' } }] },
    '/people/555': { data: { type: 'Person', id: '555', attributes: { full_name: 'Josh Smith' } } },
  };
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const body = routes[path];
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body || { errors: [{ title: 'not found' }] }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

test('planDetail resolves Planning Center native leaders (person, position, off-plan, fallback)', async () => {
  const server = await fakePco();
  process.env.PCO_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.PCO_APP_ID = 'id';
  process.env.PCO_SECRET = 'secret';
  const pco = await import('../server/pco.js');
  const d = await pco.planDetail('st', 'P');
  server.close();
  const leaders = Object.fromEntries(d.items.map((i) => [i.title, (i.leaders || []).map((l) => l.name)]));
  assert.deepEqual(leaders['Wait (Like A Seed)'], ['Nico Curtis']); // a person on the plan
  assert.deepEqual(leaders['Raise A Hallelujah'], ['Sumer Smith', 'Bailee Reitz']); // position → everyone scheduled (not declined)
  assert.deepEqual(leaders['Message'], ['Josh Smith']); // a person not scheduled on the plan → looked up
  assert.deepEqual(leaders['With You'], ['Sumer Smith']); // assignable missing from include → per-item fallback
  assert.deepEqual(leaders['Doors Open'], []);
  assert.ok(d.items[0].leaders[0].photo.includes('101'));
});
