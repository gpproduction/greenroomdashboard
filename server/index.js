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
import { buildRoster, assignmentChanges } from './roster.js';

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
function dashboardState() {
  const db = store.get();
  const detail = sync.getActive();
  const roster = buildRoster(detail, db);
  const { display } = db.settings;
  const leaderCats = String(db.settings.pco.leaderNoteCategories || '').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  const items = (detail?.items || []).map(({ notes, ...item }) => ({
    ...item,
    leader: (notes || []).filter((n) => leaderCats.includes(String(n.category).toLowerCase())).map((n) => n.content.trim()).filter(Boolean).join(', ') || null,
  }));
  return {
    bootId: BOOT_ID,
    generatedAt: new Date().toISOString(),
    display,
    showTimers: display.showTimers && (db.settings.propresenter.enabled || pco.isDemo()),
    plan: detail ? { ...detail.plan, items } : null,
    serverTime: Date.now(), // lets dashboards correct for clock drift on the live timer
    live: live.summary(detail, db),
    teams: roster.teams,
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
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

auth.routes(app);

app.get('/api/health', (req, res) => res.json({ ok: true, bootId: BOOT_ID }));
app.get('/api/dashboard', (req, res) => res.json({ ...dashboardState(), propresenter: pp.getState() }));

const admin = express.Router();
admin.use(auth.requireAdmin);

admin.get('/settings', (req, res) => {
  const { settings } = store.get();
  res.json({
    ...settings,
    pco: { ...settings.pco, secret: settings.pco.secret ? '••••••••' : '', hasSecret: Boolean(settings.pco.secret), envCredentials: Boolean(process.env.PCO_APP_ID) },
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
  }, { topic: 'settings' });
  if (body.pco) sync.restart();
  if (body.propresenter) pp.kick();
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
    res.json({ plan: detail.plan, items: detail.items, ...roster, live: db.live[detail.plan.id] || {}, liveCurrent: db.liveCurrent?.planId === detail.plan.id ? db.liveCurrent : null });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

admin.put('/plans/:planId/assignments/:key', (req, res) => {
  const { planId, key } = req.params;
  const { field, deviceId, remember = true, linked = true } = req.body || {};
  if (!['mic', 'iem'].includes(field)) return res.status(400).json({ error: 'field must be mic or iem' });
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
  if (d.type && !['mic', 'iem'].includes(d.type)) d.type = 'mic';
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
      for (const a of Object.values(map)) for (const f of ['mic', 'iem']) if (a[f] === req.params.id) a[f] = null;
    }
  });
  res.json({ ok: true });
});
// Pair a mic with an IEM (symmetric). linkedId null unlinks.
function setLink(db, id, linkedId) {
  const a = db.devices.find((d) => d.id === id);
  if (!a) return false;
  const b = linkedId ? db.devices.find((d) => d.id === linkedId) : null;
  if (linkedId && (!b || b.type === a.type)) return false;
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

// --- start -------------------------------------------------------------------------
server.listen(PORT, HOST, () => {
  console.log(`Green Room Dashboard on http://localhost:${PORT}  (dashboard: /dashboard  admin: /admin)${pco.isDemo() ? '  [DEMO MODE]' : ''}`);
  sync.start();
  pp.start();
  live.start();
});

function shutdown() {
  store.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

