// Single shared admin password. The dashboard itself is public on the LAN;
// everything under /api/admin requires a session cookie.
import crypto from 'node:crypto';
import * as store from './store.js';

const COOKIE = 'grd_session';
const SESSION_DAYS = 30;

// Sessions are persisted (as SHA-256 of the token) so a server restart or update
// doesn't sign everyone out.
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
function sessions() {
  return store.get().sessions;
}

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

function currentToken(req) {
  return parseCookies(req.headers.cookie)[COOKIE] || null;
}

function isValidSession(req) {
  const token = currentToken(req);
  const exp = token && sessions()[tokenHash(token)];
  if (!exp) return false;
  if (exp < Date.now()) {
    store.update((db) => { delete db.sessions[tokenHash(token)]; }, { topic: 'auth' });
    return false;
  }
  return true;
}

// `Secure` when the browser reached us over HTTPS (e.g. via a reverse proxy).
function cookieAttrs(req, maxAge) {
  return `HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;
}

function startSession(req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  store.update((db) => {
    const now = Date.now();
    for (const [h, exp] of Object.entries(db.sessions)) if (exp < now) delete db.sessions[h];
    db.sessions[tokenHash(token)] = now + SESSION_DAYS * 86400_000;
  }, { topic: 'auth' });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs(req, SESSION_DAYS * 86400)}`);
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
    startSession(req, res);
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
    startSession(req, res);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = currentToken(req);
    if (token) store.update((db) => { delete db.sessions[tokenHash(token)]; }, { topic: 'auth' });
    res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(req, 0)}`);
    res.json({ ok: true });
  });

  app.post('/api/admin/password', requireAdmin, (req, res) => {
    const { current, next } = req.body || {};
    if (!verifyPassword(String(current || ''), store.get().settings.admin.passwordHash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    if (!next || next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    // New password signs out every other device.
    const keep = tokenHash(currentToken(req));
    store.update((db) => {
      db.settings.admin.passwordHash = hashPassword(next);
      db.sessions = { [keep]: db.sessions[keep] };
    }, { topic: 'auth' });
    res.json({ ok: true });
  });
}
