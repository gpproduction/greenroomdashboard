// Turns a Planning Center plan + local assignments into the roster shown on screen.

export const FIELDS = ['mic', 'iem', 'other']; // device slots per person ("other" = acoustic pack, violin mic…)

/** Person key used for assignments. PCO person id when available, else name. */
export function personKey(member) {
  return member.personId ? `p:${member.personId}` : `n:${member.name.toLowerCase()}`;
}

/**
 * Resolve a person's device for a plan: an explicit per-plan choice wins
 * (including an explicit "none" = null); otherwise fall back to their default.
 */
/** Key for a person's "show on dashboard" choice — per team, since someone can serve on two. */
export function visibilityKey(teamId, key) {
  return `${teamId}|${key}`;
}

/** Teams whose members show on the dashboard by default (setting, else any team named like "Worship"). */
export function teamShownByDefault(settings, team) {
  const ids = settings.pco.defaultVisibleTeamIds;
  if (Array.isArray(ids)) return ids.includes(team.id);
  return /worship/i.test(team.name || '');
}

/** Returns { pairedIemName } when mic and IEM don't match their pairing, else null. */
export function pairMismatch(mic, iem, devices) {
  if (!mic || !iem || !mic.linkedId || mic.linkedId === iem.id) return null;
  return { pairedIem: devices.get(mic.linkedId)?.name || null };
}

function resolve(planAssign, defaults, key, field) {
  const explicit = planAssign[key];
  if (explicit && field in explicit) return { id: explicit[field], source: 'plan' };
  const def = defaults[key]?.[field];
  return def ? { id: def, source: 'default' } : { id: null, source: null };
}

export function buildRoster(detail, db, { forAdmin = false } = {}) {
  if (!detail) return { teams: [], conflicts: [] };
  const { settings } = db;
  const planId = detail.plan.id;
  const planAssign = db.assignments[planId] || {};
  const devices = new Map(db.devices.map((d) => [d.id, d]));
  const teamFilter = settings.pco.teamIds || [];
  const hideDeclined = settings.pco.hideDeclined;

  const teams = new Map();
  for (const m of detail.members) {
    if (!forAdmin && teamFilter.length && !teamFilter.includes(m.teamId)) continue;
    if (hideDeclined && m.status === 'D') continue;
    if (!teams.has(m.teamId)) teams.set(m.teamId, { id: m.teamId, name: m.teamName, members: new Map() });
    const team = teams.get(m.teamId);
    const key = personKey(m);
    const existing = team.members.get(key);
    if (existing) {
      if (!existing.positions.includes(m.position)) existing.positions.push(m.position);
      // Best status wins (Confirmed > Unconfirmed > Declined)
      if ('CUD'.indexOf(m.status) < 'CUD'.indexOf(existing.status)) existing.status = m.status;
    } else {
      team.members.set(key, { key, name: m.name, positions: [m.position], status: m.status, photo: m.photo });
    }
  }

  const extras = (db.extras[planId] || []).map((x) => ({ key: x.key, name: x.name, positions: [x.role || 'Guest'], status: 'C', photo: null, extra: true }));
  if (extras.length) teams.set('__extras', { id: '__extras', name: 'Additional', members: new Map(extras.map((x) => [x.key, x])) });

  // Order teams: configured order first, then alphabetical.
  const ordered = [...teams.values()].sort((a, b) => {
    const ia = teamFilter.indexOf(a.id);
    const ib = teamFilter.indexOf(b.id);
    if (a.id === '__extras') return 1;
    if (b.id === '__extras') return -1;
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return a.name.localeCompare(b.name);
  });

  const usage = new Map(); // deviceId -> [names]
  const out = ordered.map((t) => ({
    id: t.id,
    name: t.name,
    inFilter: !teamFilter.length || teamFilter.includes(t.id) || t.id === '__extras',
    members: [...t.members.values()].map((m) => {
      const row = { ...m };
      for (const field of FIELDS) {
        const r = resolve(planAssign, db.defaults, m.key, field);
        const dev = r.id ? devices.get(r.id) : null;
        row[field] = dev ? { id: dev.id, name: dev.name, channel: dev.channel, frequency: dev.frequency, kind: dev.kind, linkedId: dev.linkedId || null, source: r.source } : null;
        if (dev && (!forAdmin || t.inFilter !== false)) {
          if (!usage.has(dev.id)) usage.set(dev.id, []);
          usage.get(dev.id).push(m.name);
        }
      }
      // Show on dashboard: anyone with a device always shows; otherwise their own
      // checkbox, else the team default (Worship Team on, others off).
      row.hasDevice = Boolean(row.mic || row.iem || row.other);
      // Out of sync: the mic is paired (Devices page) with a different IEM than this person has,
      // e.g. VOX 1 is paired with IEM 1 but they're on IEM 5. Highlighted yellow on screens.
      row.mismatch = pairMismatch(row.mic, row.iem, devices);
      const explicit = db.visibility?.[visibilityKey(t.id, m.key)];
      row.showChoice = typeof explicit === 'boolean' ? explicit : (t.id === '__extras' ? true : teamShownByDefault(settings, t));
      row.shown = row.hasDevice || row.showChoice;
      return row;
    }),
  }));

  // The board lists people with a device, plus anyone set to "show on dashboard".
  const visible = forAdmin ? out : out
    .map((t) => ({ ...t, members: t.members.filter((m) => m.shown) }))
    .filter((t) => t.members.length);

  const conflicts = [...usage.entries()]
    .filter(([, names]) => new Set(names).size > 1)
    .map(([id, names]) => ({ deviceId: id, deviceName: devices.get(id)?.name, people: [...new Set(names)] }));

  return { teams: visible, conflicts };
}

/**
 * What to write when someone's `field` ('mic'|'iem') is set to `value`.
 * Linked pairs flow one way, mic → IEM: picking a mic also picks its paired IEM,
 * but only when the IEM slot is empty or still holds the old mic's partner, so a
 * hand-picked IEM is never clobbered. Changing an IEM never touches the mic
 * (band members often get an IEM without a mic).
 */
export function assignmentChanges(db, planId, key, field, value, { linked = true } = {}) {
  const changes = { [field]: value };
  if (!linked || field !== 'mic') return changes;
  const other = 'iem';
  const byId = new Map(db.devices.map((d) => [d.id, d]));
  const current = (f) => {
    const a = db.assignments[planId]?.[key];
    return a && f in a ? a[f] : db.defaults[key]?.[f] ?? null;
  };
  const oldPartner = byId.get(current(field))?.linkedId || null;
  const newPartner = byId.get(value)?.linkedId || null;
  const otherNow = current(other);
  if (otherNow != null && otherNow !== oldPartner) return changes; // manual override: leave it
  const next = value && newPartner ? newPartner : null;
  if (next !== otherNow) changes[other] = next;
  return changes;
}
