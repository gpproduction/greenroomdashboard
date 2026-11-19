// Spotify now-playing + playback control via the Spotify Web API.
//
// Auth: Authorization Code with PKCE (no client secret). Spotify only allows
// http redirect URIs on the loopback address, so the one-time sign-in redirects to
// http://127.0.0.1:8888/callback (nothing listens there); the admin pastes that URL
// back into Backstage, which swaps the code for a refresh token.
// Playback control needs Spotify Premium (Spotify's rule, not ours).
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as store from './store.js';

export const events = new EventEmitter();
export const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative';
const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';

let access = { token: null, expiresAt: 0 };
let pending = null; // { verifier, state, clientId }
let state = { connected: false, error: null, player: null };
let timer = null;
let started = false; // poller running (only after start())
let lastJson = '';

const cfg = () => store.get().settings.spotify;
const isDemo = () => process.env.DEMO === '1' && !cfg().refreshToken;

export function getState() {
  return { ...state, configured: Boolean(cfg().refreshToken) || isDemo() };
}

function publish(patch) {
  state = { ...state, ...patch };
  const json = JSON.stringify(state);
  if (json !== lastJson) {
    lastJson = json;
    events.emit('change', getState());
  }
}

// ---- auth --------------------------------------------------------------------------------

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Step 1: the URL the admin opens to sign in to Spotify. */
export function beginAuth(clientId) {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const st = b64url(crypto.randomBytes(12));
  pending = { verifier, state: st, clientId };
  const url = new URL(`${ACCOUNTS}/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state: st,
  }).toString();
  return url.toString();
}

async function tokenRequest(params) {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(10_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Spotify: ${json.error_description || json.error || res.status}`);
  return json;
}

/** Step 2: the admin pastes the 127.0.0.1 URL Spotify sent them to. */
export async function finishAuth(pastedUrl) {
  if (!pending) throw new Error('Start the Spotify sign-in again (click “Connect Spotify”).');
  let u;
  try { u = new URL(String(pastedUrl).trim()); } catch { throw new Error('That doesn’t look like the address from your browser’s address bar.'); }
  if (u.searchParams.get('error')) throw new Error(`Spotify said: ${u.searchParams.get('error')}`);
  const code = u.searchParams.get('code');
  if (!code) throw new Error('No code in that address — copy the whole address after signing in.');
  if (u.searchParams.get('state') !== pending.state) throw new Error('That sign-in link is from an older attempt. Click “Connect Spotify” again.');
  const tok = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: pending.clientId, code_verifier: pending.verifier });
  store.update((db) => {
    db.settings.spotify.clientId = pending.clientId;
    db.settings.spotify.refreshToken = tok.refresh_token;
  }, { topic: 'settings' });
  access = { token: tok.access_token, expiresAt: Date.now() + (tok.expires_in - 60) * 1000 };
  pending = null;
  restart();
  return { ok: true };
}

export function disconnect() {
  store.update((db) => { db.settings.spotify.refreshToken = ''; }, { topic: 'settings' });
  access = { token: null, expiresAt: 0 };
  publish({ connected: false, error: null, player: null });
}

async function token() {
  if (access.token && Date.now() < access.expiresAt) return access.token;
  const { clientId, refreshToken } = cfg();
  if (!clientId || !refreshToken) throw new Error('Spotify isn’t connected');
  const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
  access = { token: tok.access_token, expiresAt: Date.now() + (tok.expires_in - 60) * 1000 };
  if (tok.refresh_token && tok.refresh_token !== refreshToken) {
    store.update((db) => { db.settings.spotify.refreshToken = tok.refresh_token; }, { topic: 'settings' });
  }
  return access.token;
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 204 || res.status === 202) return null;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const reason = json?.error?.reason || json?.error?.message || res.status;
    if (reason === 'PREMIUM_REQUIRED') throw new Error('Spotify only allows remote control with a Premium account.');
    if (reason === 'NO_ACTIVE_DEVICE') throw new Error('No Spotify device is active — open Spotify on the sound desk computer (or pick a device).');
    throw new Error(`Spotify: ${reason}`);
  }
  return json;
}

// ---- now playing -----------------------------------------------------------------------------

/** Trim Spotify's player object to what the screens need. */
export function summarisePlayer(p) {
  if (!p || !p.item) return p?.device ? { isPlaying: false, device: p.device ? { id: p.device.id, name: p.device.name, volume: p.device.volume_percent } : null } : null;
  const it = p.item;
  return {
    isPlaying: Boolean(p.is_playing),
    title: it.name,
    artist: (it.artists || it.show && [it.show] || []).map((a) => a.name).join(', '),
    album: it.album?.name || null,
    art: (it.album?.images || it.images || []).sort((a, b) => (a.width || 0) - (b.width || 0)).find((i) => (i.width || 0) >= 200)?.url || it.album?.images?.[0]?.url || null,
    durationMs: it.duration_ms || 0,
    progressMs: p.progress_ms || 0,
    at: Date.now(),
    shuffle: Boolean(p.shuffle_state),
    context: p.context?.uri || null,
    device: p.device ? { id: p.device.id, name: p.device.name, volume: p.device.volume_percent } : null,
  };
}

async function poll() {
  if (isDemo()) return demoTick();
  if (!cfg().refreshToken) { publish({ connected: false, error: null, player: null }); return; }
  try {
    const p = await api('GET', '/me/player?additional_types=episode');
    publish({ connected: true, error: null, player: summarisePlayer(p) });
  } catch (err) {
    publish({ connected: false, error: err.message });
  }
}

// ---- controls --------------------------------------------------------------------------------

export async function control(action, body = {}) {
  if (isDemo()) return demoControl(action, body);
  const dev = body.deviceId ? `?device_id=${encodeURIComponent(body.deviceId)}` : '';
  switch (action) {
    case 'play': await api('PUT', `/me/player/play${dev}`, body.contextUri ? { context_uri: body.contextUri } : undefined); break;
    case 'pause': await api('PUT', '/me/player/pause'); break;
    case 'next': await api('POST', '/me/player/next'); break;
    case 'previous': await api('POST', '/me/player/previous'); break;
    case 'volume': await api('PUT', `/me/player/volume?volume_percent=${Math.max(0, Math.min(100, Math.round(Number(body.volume))))}`); break;
    case 'shuffle': await api('PUT', `/me/player/shuffle?state=${body.state ? 'true' : 'false'}`); break;
    case 'transfer': await api('PUT', '/me/player', { device_ids: [body.deviceId], play: Boolean(body.play) }); break;
    default: throw new Error('Unknown action');
  }
  setTimeout(poll, 400); // reflect the change quickly
  return { ok: true };
}

export async function devices() {
  if (isDemo()) return [{ id: 'demo', name: 'Sound Desk Mac', type: 'Computer', isActive: true, volume: demo.volume }];
  const r = await api('GET', '/me/player/devices');
  return (r?.devices || []).map((d) => ({ id: d.id, name: d.name, type: d.type, isActive: d.is_active, volume: d.volume_percent }));
}

export async function playlists() {
  if (isDemo()) return [{ uri: 'spotify:playlist:demo1', name: 'Pre-Service', tracks: 42 }, { uri: 'spotify:playlist:demo2', name: 'Post-Service', tracks: 30 }];
  const out = [];
  let next = '/me/playlists?limit=50';
  for (let i = 0; next && i < 4; i++) {
    const r = await api('GET', next.replace(API, ''));
    for (const p of r?.items || []) if (p) out.push({ uri: p.uri, name: p.name, tracks: p.tracks?.total ?? null });
    next = r?.next || null;
  }
  return out;
}

// ---- demo ------------------------------------------------------------------------------------
const demo = { isPlaying: true, i: 0, startedAt: Date.now(), volume: 60,
  tracks: [['Firm Foundation', 'Maverick City Music'], ['Gratitude', 'Brandon Lake'], ['Praise', 'Elevation Worship']] };
function demoTick() {
  const [title, artist] = demo.tracks[demo.i % demo.tracks.length];
  const dur = 240_000;
  let prog = demo.isPlaying ? (Date.now() - demo.startedAt) % dur : demo.pausedAt || 0;
  publish({ connected: true, error: null, player: { isPlaying: demo.isPlaying, title, artist, album: 'Demo', art: null, durationMs: dur, progressMs: prog, at: Date.now(), shuffle: false, context: 'spotify:playlist:demo1', device: { id: 'demo', name: 'Sound Desk Mac', volume: demo.volume } } });
}
function demoControl(action, body) {
  if (action === 'pause') { demo.pausedAt = (Date.now() - demo.startedAt) % 240_000; demo.isPlaying = false; }
  if (action === 'play') { demo.startedAt = Date.now() - (demo.pausedAt || 0); demo.isPlaying = true; }
  if (action === 'next') { demo.i++; demo.startedAt = Date.now(); demo.pausedAt = 0; }
  if (action === 'previous') { demo.i = Math.max(0, demo.i - 1); demo.startedAt = Date.now(); demo.pausedAt = 0; }
  if (action === 'volume') demo.volume = Number(body.volume);
  demoTick();
  return { ok: true };
}

// ---- lifecycle -------------------------------------------------------------------------------
export function start() {
  started = true;
  const loop = async () => {
    await poll();
    timer = setTimeout(loop, 3000);
  };
  loop();
}

export function restart() {
  if (!started) return;
  clearTimeout(timer);
  start();
}
