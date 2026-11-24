import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planNames, sendNames, test as testConsole, open, asciiName, stringPayload, frame, packet } from '../server/studiolive.js';
import { fakeConsole } from './helpers/fake-studiolive.js';

const devices = [
  { id: 'm1', type: 'mic', name: 'VOX 1', mixerCh: 1, mixerChTuned: 33 },
  { id: 'm2', type: 'mic', name: 'VOX 2', mixerCh: 2, mixerChTuned: 34 },
  { id: 'm3', type: 'mic', name: 'VOX 3', mixerCh: 3, mixerChTuned: 35 },
  { id: 'e1', type: 'iem', name: 'IEM 1', mixerAux: 1 },
  { id: 'e2', type: 'iem', name: 'IEM 2', mixerAux: 2 },
  { id: 'e9', type: 'iem', name: 'IEM 9' }, // no aux set: left alone
  { id: 'o1', type: 'other', name: 'Acoustic Pack', mixerCh: 9 },
];
const people = [
  { name: 'Alex Rivera', mic: 'm1', iem: 'e1' },
  { name: 'Jordan Lee', mic: 'm2', iem: 'e2' },
  { name: 'Casey Morgan', other: 'o1' },
];

test('plans clean, tuned and IEM aux names; unassigned go back to the device name', () => {
  const plan = planNames(people, devices);
  const byCh = Object.fromEntries(plan.map((e) => [`${e.kind}${e.ch}`, e.name]));
  assert.equal(byCh.line1, 'Alex');
  assert.equal(byCh.line33, 'T. Alex');
  assert.equal(byCh.line2, 'Jordan');
  assert.equal(byCh.line34, 'T. Jordan');
  assert.equal(byCh.line3, 'VOX 3');
  assert.equal(byCh.line35, 'T. VOX 3');
  assert.equal(byCh.aux1, 'IEM 1 - Alex');
  assert.equal(byCh.aux2, 'IEM 2 - Jordan');
  assert.equal(byCh.line9, 'Casey');
  assert.equal(plan.filter((e) => e.kind === 'aux').length, 2);
});

test('same first names get a last initial; nicknames and accents are handled', () => {
  const plan = planNames([{ name: 'Alex Rivera', mic: 'm1' }, { name: 'Alex Chen', mic: 'm2' }, { name: 'Zoë Brooks', short: 'Zoë', mic: 'm3' }], devices);
  const names = plan.filter((e) => e.kind === 'line' && e.ch <= 3).map((e) => e.name);
  assert.deepEqual(names, ['Alex R.', 'Alex C.', 'Zoe']);
  assert.equal(asciiName('Renée “RJ”'), 'Renee "RJ"');
});

test('optional max length trims names', () => {
  const plan = planNames([{ name: 'Christopher Young', mic: 'm1', iem: 'e1' }], devices, { maxLength: 8 });
  assert.equal(plan.find((e) => e.kind === 'aux' && e.ch === 1).name, 'IEM 1 -');
});

test('PS packets frame and round-trip', () => {
  const p = packet('PS', stringPayload('line/ch5/username', 'Alex'));
  const [ps, rest] = frame(Buffer.concat([p, p.subarray(0, 3)]));
  assert.equal(ps.length, 1);
  assert.equal(ps[0].code, 'PS');
  assert.equal(rest.length, 3);
});

for (const chunked of [false, true]) {
  test(`renames channels on a console and confirms by reading back (${chunked ? 'chunked' : 'single'} state)`, async () => {
    const fake = await fakeConsole({ chunked });
    try {
      const t = await testConsole('127.0.0.1', fake.port);
      assert.equal(t.line, 64);
      assert.equal(t.aux, 32);
      const results = await sendNames('127.0.0.1', fake.port, planNames(people, devices));
      assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
      assert.equal(fake.names.line[33], 'T. Alex');
      assert.equal(fake.names.aux[1], 'IEM 1 - Alex');
      assert.equal(fake.names.line[4], 'Ch 4'); // untouched
      // Sending again changes nothing (only differing names are written).
      const before = fake.writes.length;
      await sendNames('127.0.0.1', fake.port, planNames(people, devices));
      assert.equal(fake.writes.length, before);
    } finally { await fake.close(); }
  });
}

test('channels the console does not have are reported, not sent', async () => {
  const fake = await fakeConsole({ lines: 16, auxes: 8 });
  try {
    const r = await sendNames('127.0.0.1', fake.port, [{ kind: 'line', ch: 40, name: 'Alex' }]);
    assert.equal(r[0].missing, true);
    assert.equal(fake.writes.length, 0);
  } finally { await fake.close(); }
});

test('a mixer that is not there fails with a clear message', async () => {
  await assert.rejects(open('127.0.0.1', 1, { timeout: 2000 }), /refused|didn't answer/);
});
