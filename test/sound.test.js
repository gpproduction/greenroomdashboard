import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSpl, leq, maxOver, chooseSource } from '../server/osm.js';
import { summarisePlayer, beginAuth, finishAuth } from '../server/spotify.js';

test('OSM: dBFS → SPL like OSM shows it; silence → null', () => {
  assert.equal(toSpl(-50), 90);
  assert.equal(toSpl(-50, 1.5), 91.5);
  assert.equal(toSpl(null), null);
  assert.equal(toSpl('-Infinity'), null);
});

test('OSM: Leq is an energy average, max over a window', () => {
  const now = 1_000_000;
  const s = (ago, spl) => ({ t: now - ago * 1000, spl });
  assert.equal(leq([s(1, 90), s(2, 90)], 60, now).toFixed(1), '90.0');
  assert.equal(leq([s(1, 100), s(2, 80)], 60, now).toFixed(1), '97.0'); // loud moments dominate
  assert.equal(leq([s(120, 100), s(1, 80)], 60, now).toFixed(1), '80.0'); // outside the window ignored
  assert.equal(maxOver([s(10, 95), s(5, 99), s(90, 105)], 60, now), 99);
  assert.equal(leq([], 60, now), null);
});

test('OSM: chooses the configured measurement, else the first', () => {
  const m = new Map([['a', { uuid: 'a', name: 'Measurement 1' }], ['b', { uuid: 'b', name: 'FOH' }]]);
  assert.equal(chooseSource(m, 'foh').uuid, 'b');
  assert.equal(chooseSource(m, '').uuid, 'a');
  assert.equal(chooseSource(m, 'missing').uuid, 'a');
});

test('Spotify: player summary', () => {
  const p = summarisePlayer({ is_playing: true, progress_ms: 1000, device: { id: 'd', name: 'Sound Desk', volume_percent: 40 },
    item: { name: 'Gratitude', duration_ms: 200000, artists: [{ name: 'Brandon Lake' }], album: { name: 'X', images: [{ url: 'big', width: 640 }, { url: 'mid', width: 300 }, { url: 'small', width: 64 }] } } });
  assert.equal(p.title, 'Gratitude');
  assert.equal(p.artist, 'Brandon Lake');
  assert.equal(p.art, 'mid');
  assert.equal(p.device.volume, 40);
  assert.equal(summarisePlayer(null), null);
});

test('Spotify: sign-in paste-back checks state and swaps the code with PKCE', async () => {
  const url = new URL(beginAuth('0123456789abcdef0123456789abcdef'));
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:8888/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const st = url.searchParams.get('state');
  await assert.rejects(finishAuth(`http://127.0.0.1:8888/callback?code=abc&state=wrong`), /older attempt/);
  const realFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (u, opts) => {
    if (String(u).includes('/api/token')) { sent = Object.fromEntries(new URLSearchParams(opts.body)); return new Response(JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_in: 3600 }), { status: 200 }); }
    return new Response(null, { status: 204 });
  };
  try {
    await finishAuth(`http://127.0.0.1:8888/callback?code=abc&state=${st}`);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(sent.grant_type, 'authorization_code');
  assert.equal(sent.code, 'abc');
  assert.ok(sent.code_verifier.length >= 43);
});
