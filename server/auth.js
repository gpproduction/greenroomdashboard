// Single shared admin password. The dashboard itself is public on the LAN;
// everything under /api/admin requires a session cookie.
import crypto from 'node:crypto';
import * as store from './store.js';

const COOKIE = 'grd_session';
const SESSION_DAYS = 30;
const sessions = new Map(); // token -> expiresAt

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [, salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/** If ADMIN_PASSWORD is provided via env and no password is set yet, adopt it. */
export function bootstrapPassword() {
  const envPw = process.env.ADMIN_PASSWORD;
  if (envPw && !store.get().settings.admin.passwordHash) {
    store.update((db) => { db.settings.admin.passwordHash = hashPassword(envPw); });
    console.log('[auth] admin password initialised from ADMIN_PASSWORD');
  }
}

export function isConfigured() {
  return Boolean(store.get().settings.admin.passwordHash);
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
  );
}

function isValidSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  const exp = token && sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function startSession(res) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_DAYS * 86400_000);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}

export function requireAdmin(req, res, next) {
  if (isValidSession(req)) return next();
  res.status(401).json({ error: 'Not signed in' });
}

// Basic brute-force damping: max 10 failed attempts per IP per 10 minutes.
const failures = new Map();
function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) return false;
  return f.count >= 10;
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) failures.set(ip, { count: 1, until: Date.now() + 600_000 });
  else f.count += 1;
}

export function routes(app) {
  app.get('/api/auth/status', (req, res) => {
    res.json({ configured: isConfigured(), signedIn: isValidSession(req) });
  });

  // First-run: set the admin password (only allowed when none exists).
  app.post('/api/auth/setup', (req, res) => {
    if (isConfigured()) return res.status(409).json({ error: 'Password already set' });
    const { password } = req.body || {};
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    store.update((db) => { db.settings.admin.passwordHash = hashPassword(password); });
    startSession(res);
    res.json({ ok: true });
  });

  app.post('/api/auth/login', (req, res) => {
    const ip = req.ip;
    if (tooManyFailures(ip)) return res.status(429).json({ error: 'Too many attempts, try again in a few minutes' });
    const { password } = req.body || {};
    if (!verifyPassword(String(password || ''), store.get().settings.admin.passwordHash)) {
      recordFailure(ip);
      return res.status(401).json({ error: 'Incorrect password' });
    }
    failures.delete(ip);
    startSession(res);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  app.post('/api/admin/password', requireAdmin, (req, res) => {
    const { current, next } = req.body || {};
    if (!verifyPassword(String(current || ''), store.get().settings.admin.passwordHash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    if (!next || next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    store.update((db) => { db.settings.admin.passwordHash = hashPassword(next); });
    res.json({ ok: true });
  });
}
