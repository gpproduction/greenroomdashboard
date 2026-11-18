// Tiny JSON-file store. The data set is small (settings, a few dozen devices,
// assignments per plan) so a single file with atomic writes is plenty and
// avoids native database dependencies on the church PC.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const FILE = path.join(DATA_DIR, 'db.json');

export const events = new EventEmitter();

function defaults() {
  return {
    settings: {
      pco: {
        appId: '',
        secret: '',
        serviceTypeIds: [], // which service types to pull plans from
        teamIds: [], // which teams appear on the dashboard (ordered); empty = all
        planSelection: 'auto', // 'auto' or a pinned plan id
        pinnedServiceTypeId: null,
        pollSeconds: 60,
        hideDeclined: true,
        leaderNoteCategories: 'Lead', // item note categories holding the item's leader (comma-separated)
      },
      propresenter: {
        enabled: false,
        host: '',
        port: 1025,
        timerIds: [], // timer uuids to show; empty = all
        showActiveItem: true,
      },
      display: {
        showLogo: true,
        logoVersion: 0, // bumped when the logo changes (cache-busting)
        timezone: 'America/New_York',
        showOrderOfService: true,
        showTimers: true,
        showServiceCountdown: true,
        reloadHours: 6,
      },
      admin: { passwordHash: null },
    },
    devices: [], // { id, type: 'mic'|'iem', name, channel, frequency, kind, notes, active, linkedId }
    assignments: {}, // planId -> personKey -> { mic?: deviceId|null, iem?: deviceId|null }
    defaults: {}, // personKey -> { mic, iem }   (last-used, auto-fills future plans)
    extras: {}, // planId -> [{ key, name, role }]   (guests not in Planning Center)
    lastPlan: null, // cached copy of the last good plan detail for offline resilience
    sessions: {}, // sha256(token) -> expiresAt (admin logins)
  };
}

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = k in base && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

let db = load();

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return deepMerge(defaults(), raw);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[store] could not read ${FILE}:`, err.message);
    return defaults();
  }
}

let saveTimer = null;
function writeNow() {
  saveTimer = null;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}

export function get() {
  return db;
}

/** Mutate the db inside fn, persist (debounced) and notify listeners. */
export function update(fn, { topic = 'data' } = {}) {
  const result = fn(db);
  if (!saveTimer) saveTimer = setTimeout(writeNow, 200);
  events.emit('change', topic);
  return result;
}

export function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    writeNow();
  }
}

export function newId(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 10);
}
