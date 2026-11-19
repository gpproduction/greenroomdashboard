import './env.js'; // must be first: loads .env before other modules read process.env
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import * as store from './store.js';
import * as auth from './auth.js';
import * as pco from './pco.js';
import * as sync from './sync.js';
import * as pp from './propresenter.js';
import * as demo from './demo.js';
import * as live from './live.js';
import * as media from './media.js';
import * as unifi from './unifi.js';
import * as osm from './osm.js';
import * as spotify from './spotify.js';
import { buildRoster, assignmentChanges, FIELDS, visibilityKey } from './roster.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
// Changes every server start; dashboards reload themselves when they see a new one
// so updates to the app reach the TVs without anyone touching them.
const BOOT_ID = crypto.randomBytes(6).toString('hex');

// --- first-run seeding for demo mode -----------------------------------------
if (pco.isDemo() && !store.get().devices.length) {
  store.update((db) => {
    db.devices = demo.seedDevices();
    db.defaults = Object.fromEntries(Object.entries(demo.seedAssignments()).map(([k, v]) => [`p:${k}`, v]));
    db.settings.pco.serviceTypeIds = ['st1'];
    db.settings.pco.teamIds = ['t1', 't2'];
  });
}
auth.bootstrapPassword();

// --- dashboard payload ---------------------------------------------------------
// Mark people who have badged in through UniFi Access today.
function withArrivals(teams) {
  return teams.map((t) => ({
    ...t,
    members: t.members.map((m) => ({ ...m, arrivedAt: unifi.arrivalFor(m.name)?.ts || null })),
  }));
}

function dashboardState() {
  const db = store.get();
  const detail = sync.getActive();
  const roster = buildRoster(detail, db);
  const { display } = db.settings;
  const leaderCats = String(db.settings.pco.leaderNoteCategories || '').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  const useNative = db.settings.pco.useNativeLeaders !== false;
  const items = (detail?.items || []).map(({ notes, leaders, ...item }) => ({
    ...item,
    // Planning Center's own Leader column (people/positions), when it has someone…
    leaders: useNative && leaders?.length ? leaders : [],
    // …otherwise the chosen item-note column as text (e.g. a custom "Lead" column).
    leader: (useNative && leaders?.length) ? null
      : (notes || []).filter((n) => leaderCats.includes(String(n.category).toLowerCase())).map((n) => n.content.trim()).filter(Boolean).join(', ') || null,
  }));
  return {
    bootId: BOOT_ID,
    generatedAt: new Date().toISOString(),
    display,
    showTimers: display.showTimers && (db.settings.propresenter.enabled || pco.isDemo()),
    plan: detail ? { ...detail.plan, items } : null,
    serverTime: Date.now(), // lets dashboards correct for clock drift on the live timer
    sound: db.settings.sound, // which tools the sound desk page shows
    live: live.summary(detail, db),
    teams: withArrivals(roster.teams),
    unifi: unifi.getState(),
    conflicts: roster.conflicts,
    pco: sync.getStatus(),
  };
}

// --- HTTP ----------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
// If a reverse proxy on this machine is ever put in front (it sets X-Forwarded-*),
// trusting loopback lets req.ip / req.secure reflect the real visitor. Harmless otherwise.
app.set('trust proxy', 'loopback');
// --- logo (custom upload in DATA_DIR, else the bundled GrowPoint logo) ----------------
const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
const DEFAULT_LOGO = path.join(__dirname, '..', 'public', 'img', 'growpoint-logo.png');
function customLogoPath() {
  for (const ext of Object.values(LOGO_TYPES)) {
    const p = path.join(store.DATA_DIR, `logo.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
app.get('/branding/logo', (req, res) => {
  // Locked-down CSP so an uploaded SVG can never run script if opened directly.
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(customLogoPath() || DEFAULT_LOGO);
});
app.post('/api/admin/logo', auth.requireAdmin, express.json({ limit: '4mb' }), (req, res) => {
  const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(req.body?.dataUrl || '');
  const ext = m && LOGO_TYPES[m[1]];
  if (!ext) return res.status(400).json({ error: 'Upload a PNG, JPG, WebP or SVG image' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3 * 1024 * 1024) return res.status(400).json({ error: 'Logo must be under 3 MB' });
  const old = customLogoPath();
  if (old) fs.unlinkSync(old);
  fs.mkdirSync(store.DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(store.DATA_DIR, `logo.${ext}`), buf);
  store.update((db) => { db.settings.display.logoVersion = Date.now(); }, { topic: 'settings' });
  res.json({ ok: true });
});
app.delete('/api/admin/logo', auth.requireAdmin, (req, res) => {
  const old = customLogoPath();
  if (old) fs.unlinkSync(old);
  store.update((db) => { db.settings.display.logoVersion = Date.now(); }, { topic: 'settings' });
  res.json({ ok: true });
});

app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => res.redirect('/dashboard/'));
// Friendly names: /backstage → the green room screen, /foh → Front of House (sound desk).
// The original /dashboard/ and /sound/ links keep working.
const keepQuery = (req) => (req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '');
app.get(['/backstage', '/backstage/'], (req, res) => res.redirect(`/dashboard/${keepQuery(req)}`));
app.get(['/foh', '/foh/'], (req, res) => res.redirect(`/sound/${keepQuery(req)}`));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

auth.routes(app);

// App version (from package.json) so it's easy to confirm an update actually took.
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
const COMMIT = (process.env.APP_COMMIT || '').slice(0, 7) || null;
app.get('/api/health', (req, res) => res.json({ ok: true, version: VERSION, commit: COMMIT, bootId: BOOT_ID }));
app.get('/api/dashboard', (req, res) => res.json({ ...dashboardState(), propresenter: pp.getState(), media: media.getState(), osm: osm.getState(), spotify: spotify.getState() }));

// Sound desk: Spotify controls need an admin sign-in (viewing doesn't).
app.post('/api/sound/spotify/:action', auth.requireAdmin, async (req, res) => {
  try { res.json(await spotify.control(req.params.action, req.body || {})); } catch (err) { res.status(400).json({ error: err.message }); }
});
app.get('/api/sound/spotify-devices', auth.requireAdmin, async (req, res) => {
  try { res.json(await spotify.devices()); } catch (err) { res.status(400).json({ error: err.message }); }
});
app.get('/api/sound/spotify-playlists', auth.requireAdmin, async (req, res) => {
  try { res.json(await spotify.playlists()); } catch (err) { res.status(400).json({ error: err.message }); }
});

const admin = express.Router();
admin.use(auth.requireAdmin);

admin.get('/settings', (req, res) => {
  const { settings } = store.get();
  res.json({
    ...settings,
    pco: { ...settings.pco, secret: settings.pco.secret ? '••••••••' : '', hasSecret: Boolean(settings.pco.secret), envCredentials: Boolean(process.env.PCO_APP_ID) },
    obs: { ...settings.obs, password: settings.obs.password ? '••••••••' : '', hasPassword: Boolean(settings.obs.password) },
    unifi: { ...settings.unifi, token: settings.unifi.token ? '••••••••' : '', hasToken: Boolean(settings.unifi.token) },
    spotify: { clientId: settings.spotify.clientId, connected: Boolean(settings.spotify.refreshToken), redirectUri: spotify.REDIRECT_URI },
    admin: undefined,
    demo: pco.isDemo(),
  });
});

admin.put('/settings', (req, res) => {
  const body = req.body || {};
  store.update((db) => {
    const s = db.settings;
    if (body.pco) {
      const { secret, hasSecret, envCredentials, ...rest } = body.pco;
      Object.assign(s.pco, rest);
      if (secret && !secret.startsWith('••')) s.pco.secret = secret;
    }
    if (body.propresenter) Object.assign(s.propresenter, body.propresenter);
    if (body.display) Object.assign(s.display, body.display);
    if (body.live) Object.assign(s.live, body.live);
    if (body.hyperdeck) Object.assign(s.hyperdeck, body.hyperdeck);
    if (body.osm) Object.assign(s.osm, body.osm);
    if (body.sound) {
      const allowed = ['level', 'spotify', 'timers', 'recording', 'order', 'roster'];
      s.sound.tools = (body.sound.tools || []).filter((t) => allowed.includes(t));
    }
    if (body.unifi) {
      const { token, hasToken, ...rest } = body.unifi;
      Object.assign(s.unifi, rest);
      if (token !== undefined && !String(token).startsWith('••')) s.unifi.token = token.trim();
    }
    if (body.obs) {
      const { password, hasPassword, ...rest } = body.obs;
      Object.assign(s.obs, rest);
      if (password !== undefined && !String(password).startsWith('••')) s.obs.password = password;
    }
  }, { topic: 'settings' });
  if (body.pco) sync.restart();
  if (body.propresenter) pp.kick();
  if (body.hyperdeck) media.restart(['hyperdeck']);
  if (body.obs) media.restart(['obs']);
  if (body.unifi) unifi.restart();
  if (body.osm) osm.restart();
  res.json({ ok: true });
});

// Planning Center helpers
admin.post('/pco/test', async (req, res) => {
  const { appId, secret } = req.body || {};
  const stored = store.get().settings.pco;
  const creds = {
    appId: appId || process.env.PCO_APP_ID || stored.appId,
    secret: secret && !secret.startsWith('••') ? secret : process.env.PCO_SECRET || stored.secret,
  };
  try {
    res.json(await pco.testConnection(creds));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});
admin.get('/pco/service-types', async (req, res) => {
  try { res.json(await pco.listServiceTypes()); } catch (err) { res.status(502).json({ error: err.message }); }
});
// Item-note columns used in the current plan (e.g. Lead, Sound, Projection) with examples,
// so the Leader column can be picked from real data rather than typed.
admin.get('/pco/note-categories', (req, res) => {
  const detail = sync.getActive();
  const cats = new Map();
  for (const item of detail?.items || []) {
    for (const n of item.notes || []) {
      if (!cats.has(n.category)) cats.set(n.category, { name: n.category, count: 0, examples: [] });
      const c = cats.get(n.category);
      c.count += 1;
      if (c.examples.length < 3) c.examples.push(`${item.title}: ${String(n.content).trim().slice(0, 40)}`);
    }
  }
  res.json({ plan: detail ? detail.plan.dates : null, categories: [...cats.values()].sort((a, b) => a.name.localeCompare(b.name)) });
});

admin.get('/pco/teams', async (req, res) => {
  const ids = String(req.query.serviceTypeIds || '').split(',').filter(Boolean);
  try { res.json(await pco.listTeams(ids.length ? ids : store.get().settings.pco.serviceTypeIds)); } catch (err) { res.status(502).json({ error: err.message }); }
});
admin.post('/sync', async (req, res) => {
  await sync.syncNow();
  res.json(sync.getStatus());
});

// Plans & assignments
admin.get('/plans', (req, res) => {
  res.json({ plans: sync.getUpcoming(), activeId: sync.getActive()?.plan.id || null, status: sync.getStatus() });
});

admin.get('/plans/:serviceTypeId/:planId', async (req, res) => {
  try {
    const detail = await sync.getPlanDetail(req.params.serviceTypeId, req.params.planId, { fresh: req.query.fresh === '1' });
    const roster = buildRoster(detail, store.get(), { forAdmin: true });
    const db = store.get();
    res.json({ plan: detail.plan, items: detail.items, ...roster, teams: withArrivals(roster.teams), live: db.live[detail.plan.id] || {}, liveCurrent: db.liveCurrent?.planId === detail.plan.id ? db.liveCurrent : null });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

admin.put('/plans/:planId/assignments/:key', (req, res) => {
  const { planId, key } = req.params;
  const { field, deviceId, remember = true, linked = true } = req.body || {};
  if (!FIELDS.includes(field)) return res.status(400).json({ error: 'field must be mic, iem or other' });
  const value = deviceId || null;
  const changes = assignmentChanges(store.get(), planId, key, field, value, { linked });

  store.update((db) => {
    db.assignments[planId] ??= {};
    db.assignments[planId][key] ??= {};
    Object.assign(db.assignments[planId][key], changes);
    if (remember && !key.startsWith('x:')) {
      db.defaults[key] ??= {};
      for (const [f, v] of Object.entries(changes)) {
        if (v) db.defaults[key][f] = v;
        else delete db.defaults[key][f];
      }
    }
  });
  res.json({ ok: true, changes });
});

// Live tab: what ProPresenter shows, what it matched, and the timing state.
admin.get('/live', (req, res) => {
  const db = store.get();
  const detail = sync.getActive();
  const p = pp.getState();
  const now = Date.now();
  const win = live.currentWindow(db, detail, now);
  res.json({
    now,
    plan: detail ? { id: detail.plan.id, dates: detail.plan.dates, serviceTypeName: detail.plan.serviceTypeName, times: detail.plan.times } : null,
    items: detail?.items.map(({ id, title, type, length, position }) => ({ id, title, type, length, position })) || [],
    propresenter: { enabled: db.settings.propresenter.enabled || pco.isDemo(), connected: p.connected, error: p.error, activePresentation: p.activePresentation },
    matchedItemId: detail ? live.matchItem(detail.items, p.activePresentation) : null,
    window: win ? { id: win.id, test: Boolean(win.test), start: win.start, end: win.end } : null,
    test: db.liveTest,
    summary: live.summary(detail, db, now),
    testRecorded: Boolean(detail && db.live[detail.plan.id]?.test),
  });
});

// Production test mode on/off.
admin.post('/live/test', (req, res) => {
  const minutes = Math.min(240, Math.max(5, Number(req.body?.minutes) || 60));
  const now = Date.now();
  store.update((db) => { db.liveTest = { startedAt: now, until: now + minutes * 60_000 }; }, { topic: 'live' });
  live.tick();
  res.json({ ok: true, until: store.get().liveTest.until });
});
admin.delete('/live/test', (req, res) => {
  store.update((db) => { db.liveTest = null; }, { topic: 'live' });
  live.tick(); // closes the running test item
  res.json({ ok: true });
});

// "Show on dashboard" for one person on one team (remembered across plans).
admin.put('/visibility', (req, res) => {
  const { teamId, key, show } = req.body || {};
  if (!teamId || !key || typeof show !== 'boolean') return res.status(400).json({ error: 'teamId, key and show are required' });
  store.update((db) => { (db.visibility ??= {})[visibilityKey(teamId, key)] = show; });
  res.json({ ok: true });
});

// Spotify one-time connection (PKCE, paste-back of the 127.0.0.1 redirect URL).
admin.post('/spotify/begin', (req, res) => {
  const clientId = String(req.body?.clientId || '').trim();
  if (!/^[0-9a-f]{32}$/i.test(clientId)) return res.status(400).json({ error: 'Paste the Client ID from your Spotify developer app (32 letters and numbers).' });
  res.json({ url: spotify.beginAuth(clientId), redirectUri: spotify.REDIRECT_URI });
});
admin.post('/spotify/finish', async (req, res) => {
  try { res.json(await spotify.finishAuth(req.body?.url)); } catch (err) { res.status(400).json({ error: err.message }); }
});
admin.post('/spotify/disconnect', (req, res) => { spotify.disconnect(); res.json({ ok: true }); });

// Auto-update (Watchtower sidecar on the NAS): status + "install updates now".
admin.get('/update', (req, res) => {
  res.json({ version: VERSION, commit: COMMIT, autoUpdate: Boolean(process.env.UPDATER_URL) });
});
admin.post('/update', async (req, res) => {
  const url = process.env.UPDATER_URL;
  if (!url) return res.status(400).json({ error: 'Automatic updates are not set up on this server (see docs/AUTO-UPDATE.md).' });
  // Watchtower may replace this very container while handling the request, so don't wait for it.
  fetch(`${url.replace(/\/$/, '')}/v1/update`, {
    headers: { Authorization: `Bearer ${process.env.UPDATER_TOKEN || ''}` },
    signal: AbortSignal.timeout(10 * 60_000),
  }).then((r) => console.log(`[update] updater answered ${r.status}`)).catch((err) => console.log(`[update] ${err.message}`));
  res.json({ ok: true });
});

// Clear recorded item times for one service time of a plan.
admin.delete('/plans/:planId/live/:planTimeId', (req, res) => {
  store.update((db) => {
    if (db.live[req.params.planId]) delete db.live[req.params.planId][req.params.planTimeId];
    if (db.liveCurrent?.planId === req.params.planId && db.liveCurrent.planTimeId === req.params.planTimeId) db.liveCurrent = null;
  }, { topic: 'live' });
  res.json({ ok: true });
});

admin.post('/plans/:planId/reset', (req, res) => {
  store.update((db) => { delete db.assignments[req.params.planId]; });
  res.json({ ok: true });
});

admin.post('/plans/:planId/extras', (req, res) => {
  const { name, role } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const extra = { key: `x:${store.newId()}`, name: String(name).slice(0, 80), role: String(role || 'Guest').slice(0, 80) };
  store.update((db) => { (db.extras[req.params.planId] ??= []).push(extra); });
  res.json(extra);
});

admin.delete('/plans/:planId/extras/:key', (req, res) => {
  store.update((db) => {
    db.extras[req.params.planId] = (db.extras[req.params.planId] || []).filter((x) => x.key !== req.params.key);
    if (db.assignments[req.params.planId]) delete db.assignments[req.params.planId][req.params.key];
  });
  res.json({ ok: true });
});

// Devices
const DEVICE_FIELDS = ['type', 'name', 'channel', 'frequency', 'kind', 'notes', 'active'];
function cleanDevice(body) {
  const d = {};
  for (const f of DEVICE_FIELDS) if (f in body) d[f] = typeof body[f] === 'string' ? body[f].slice(0, 120) : body[f];
  if (d.type && !FIELDS.includes(d.type)) d.type = 'mic';
  return d;
}
admin.get('/devices', (req, res) => res.json(store.get().devices));
admin.post('/devices', (req, res) => {
  const d = { id: store.newId('d'), type: 'mic', name: 'New device', channel: '', frequency: '', kind: '', notes: '', active: true, linkedId: null, ...cleanDevice(req.body || {}) };
  store.update((db) => { db.devices.push(d); });
  res.json(d);
});
admin.put('/devices/:id', (req, res) => {
  let found = null;
  store.update((db) => {
    found = db.devices.find((d) => d.id === req.params.id);
    if (found) Object.assign(found, cleanDevice(req.body || {}));
  });
  found ? res.json(found) : res.status(404).json({ error: 'Not found' });
});
admin.delete('/devices/:id', (req, res) => {
  store.update((db) => {
    db.devices = db.devices.filter((d) => d.id !== req.params.id);
    for (const d of db.devices) if (d.linkedId === req.params.id) d.linkedId = null;
    for (const map of [db.defaults, ...Object.values(db.assignments)]) {
      for (const a of Object.values(map)) for (const f of FIELDS) if (a[f] === req.params.id) a[f] = null;
    }
  });
  res.json({ ok: true });
});
// Pair a mic with an IEM (symmetric). linkedId null unlinks.
function setLink(db, id, linkedId) {
  const a = db.devices.find((d) => d.id === id);
  if (!a) return false;
  const b = linkedId ? db.devices.find((d) => d.id === linkedId) : null;
  // Only a mic and an IEM can be paired ("other" devices are never linked).
  if (linkedId && (!b || ![a.type, b.type].includes('mic') || ![a.type, b.type].includes('iem'))) return false;
  // Break any existing pairings either device was part of.
  for (const d of db.devices) if (d.linkedId === a.id || (b && d.linkedId === b.id)) d.linkedId = null;
  a.linkedId = b ? b.id : null;
  if (b) b.linkedId = a.id;
  return true;
}
admin.put('/devices/:id/link', (req, res) => {
  let ok = false;
  store.update((db) => { ok = setLink(db, req.params.id, req.body?.linkedId || null); });
  ok ? res.json({ ok: true }) : res.status(400).json({ error: 'Can only link a mic to an IEM' });
});
// Pair Mic #1↔IEM #1, #2↔#2 … in list order.
admin.post('/devices/auto-link', (req, res) => {
  let n = 0;
  store.update((db) => {
    const mics = db.devices.filter((d) => d.type === 'mic');
    const iems = db.devices.filter((d) => d.type === 'iem');
    for (const d of db.devices) d.linkedId = null;
    for (let i = 0; i < Math.min(mics.length, iems.length); i++) { setLink(db, mics[i].id, iems[i].id); n++; }
  });
  res.json({ ok: true, linked: n });
});
admin.put('/devices-order', (req, res) => {
  const ids = req.body?.ids || [];
  store.update((db) => {
    const pos = new Map(ids.map((id, i) => [id, i]));
    db.devices.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
  });
  res.json({ ok: true });
});

// ProPresenter
// HyperDeck / OBS connection tests
admin.post('/hyperdeck/test', async (req, res) => {
  const cfg = { ...store.get().settings.hyperdeck, ...(req.body || {}) };
  if (!cfg.host) return res.status(400).json({ ok: false, error: 'Enter the HyperDeck IP address' });
  try { res.json(await media.testHyperDeck(cfg)); } catch (err) { res.status(400).json({ ok: false, error: err.code === 'ECONNREFUSED' ? 'Connection refused (is Ethernet control on?)' : err.message }); }
});
admin.post('/obs/test', async (req, res) => {
  const saved = store.get().settings.obs;
  const body = req.body || {};
  const cfg = { ...saved, ...body, password: body.password && !body.password.startsWith('••') ? body.password : saved.password };
  if (!cfg.host) return res.status(400).json({ ok: false, error: 'Enter the OBS computer’s IP address' });
  try { res.json(await media.testObs(cfg)); } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

admin.post('/unifi/test', async (req, res) => {
  const saved = store.get().settings.unifi;
  const body = req.body || {};
  const cfg = { ...saved, ...body, token: body.token && !body.token.startsWith('••') ? body.token.trim() : saved.token };
  if (!cfg.host || !cfg.token) return res.status(400).json({ ok: false, error: 'Enter the UniFi console IP address and an API token' });
  const detail = sync.getActive();
  const names = detail ? [...new Set(detail.members.map((m) => m.name))] : [];
  try { res.json(await unifi.test(cfg, names, store.get().settings.display.timezone)); } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

admin.post('/propresenter/test', async (req, res) => {
  const cfg = { ...store.get().settings.propresenter, ...(req.body || {}) };
  if (pco.isDemo() && !cfg.host) return res.json({ ok: true, version: { name: 'Demo' }, timers: pp.getState().timers });
  try {
    res.json(await pp.test(cfg));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.name === 'TimeoutError' ? `No response from ${cfg.host}:${cfg.port}` : err.message });
  }
});

app.use('/api/admin', admin);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// --- WebSocket push --------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) if (client.readyState === 1) client.send(msg);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ type: 'state', payload: dashboardState() }));
  ws.send(JSON.stringify({ type: 'propresenter', payload: pp.getState() }));
  ws.send(JSON.stringify({ type: 'media', payload: media.getState() }));
  ws.send(JSON.stringify({ type: 'osm', payload: osm.getState() }));
  ws.send(JSON.stringify({ type: 'spotify', payload: spotify.getState() }));
});

// Heartbeat: drop dead sockets so clients notice and reconnect.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15_000);

let pending = null;
function scheduleStateBroadcast() {
  if (pending) return;
  pending = setTimeout(() => { pending = null; broadcast('state', dashboardState()); }, 150);
}
store.events.on('change', (topic) => { if (topic !== 'auth') scheduleStateBroadcast(); });
sync.events.on('change', scheduleStateBroadcast);
pp.events.on('change', (s) => broadcast('propresenter', s));
media.events.on('change', (s) => broadcast('media', s));
osm.events.on('change', (s) => broadcast('osm', s));
spotify.events.on('change', (s) => broadcast('spotify', s));
unifi.events.on('change', scheduleStateBroadcast);

// --- start -------------------------------------------------------------------------
server.listen(PORT, HOST, () => {
  console.log(`GrowPoint Backstage on http://localhost:${PORT}  (Backstage: /dashboard  Front of House: /sound  admin: /admin)${pco.isDemo() ? '  [DEMO MODE]' : ''}`);
  sync.start();
  pp.start();
  live.start();
  media.start();
  unifi.start();
  osm.start();
  spotify.start();
});

function shutdown() {
  store.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

