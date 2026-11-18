// Turns a Planning Center plan + local assignments into the roster shown on screen.

/** Person key used for assignments. PCO person id when available, else name. */
export function personKey(member) {
  return member.personId ? `p:${member.personId}` : `n:${member.name.toLowerCase()}`;
}

/**
 * Resolve a person's device for a plan: an explicit per-plan choice wins
 * (including an explicit "none" = null); otherwise fall back to their default.
 */
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
      for (const field of ['mic', 'iem']) {
        const r = resolve(planAssign, db.defaults, m.key, field);
        const dev = r.id ? devices.get(r.id) : null;
        row[field] = dev ? { id: dev.id, name: dev.name, channel: dev.channel, frequency: dev.frequency, kind: dev.kind, color: dev.color, source: r.source } : null;
        if (dev && (!forAdmin || t.inFilter !== false)) {
          if (!usage.has(dev.id)) usage.set(dev.id, []);
          usage.get(dev.id).push(m.name);
        }
      }
      return row;
    }),
  }));

  const conflicts = [...usage.entries()]
    .filter(([, names]) => new Set(names).size > 1)
    .map(([id, names]) => ({ deviceId: id, deviceName: devices.get(id)?.name, people: [...new Set(names)] }));

  return { teams: out, conflicts };
}
