// Planning Center Services API client (https://developer.planning.center/docs/#/apps/services)
// Uses a Personal Access Token (Application ID + Secret) with HTTP Basic auth.
import * as store from './store.js';
import * as demo from './demo.js';

const BASE = process.env.PCO_BASE_URL || 'https://api.planningcenteronline.com/services/v2'; // override only for testing

export function isDemo() {
  return process.env.DEMO === '1';
}

function credentials() {
  const { appId, secret } = store.get().settings.pco;
  return {
    appId: process.env.PCO_APP_ID || appId,
    secret: process.env.PCO_SECRET || secret,
  };
}

export function hasCredentials() {
  const c = credentials();
  return Boolean(c.appId && c.secret);
}

async function request(urlOrPath, params = {}, creds = credentials()) {
  if (!creds.appId || !creds.secret) throw new Error('Planning Center credentials are not configured');
  const url = new URL(urlOrPath.startsWith('http') ? urlOrPath : BASE + urlOrPath);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const auth = Buffer.from(`${creds.appId}:${creds.secret}`).toString('base64');

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 2) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const msg = res.status === 401 ? 'Planning Center rejected the credentials (401)' : `Planning Center ${res.status}: ${body.slice(0, 200)}`;
      throw new Error(msg);
    }
    return res.json();
  }
  throw new Error('Planning Center rate limit: too many retries');
}

/** Follow `links.next` and merge data + included across pages. */
async function requestAll(path, params = {}, creds) {
  let page = await request(path, { per_page: 100, ...params }, creds);
  const data = [...page.data];
  const included = [...(page.included || [])];
  let guard = 0;
  while (page.links?.next && guard++ < 20) {
    page = await request(page.links.next, {}, creds);
    data.push(...page.data);
    included.push(...(page.included || []));
  }
  return { data, included };
}

function indexIncluded(included = []) {
  const map = new Map();
  for (const r of included) map.set(`${r.type}:${r.id}`, r);
  return map;
}

export async function testConnection(creds) {
  if (isDemo()) return { ok: true, organization: 'Demo Church' };
  const res = await request('', {}, creds);
  return { ok: true, organization: res.data?.attributes?.name || 'Connected' };
}

export async function listServiceTypes() {
  if (isDemo()) return demo.serviceTypes();
  const { data } = await requestAll('/service_types', { order: 'sequence' });
  return data.map((s) => ({ id: s.id, name: s.attributes.name }));
}

export async function listTeams(serviceTypeIds) {
  if (isDemo()) return demo.teams();
  const seen = new Map();
  for (const stId of serviceTypeIds) {
    const { data } = await requestAll(`/service_types/${stId}/teams`, { order: 'name' });
    for (const t of data) if (!seen.has(t.id)) seen.set(t.id, { id: t.id, name: t.attributes.name });
  }
  return [...seen.values()];
}

function mapPlanTimes(plan, inc) {
  return (plan.relationships?.plan_times?.data || [])
    .map((ref) => inc.get(`PlanTime:${ref.id}`))
    .filter(Boolean)
    .map((t) => ({
      id: t.id,
      name: t.attributes.name,
      type: t.attributes.time_type, // service | rehearsal | other
      startsAt: t.attributes.starts_at,
      endsAt: t.attributes.ends_at,
    }))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** Upcoming plans (including today's) across the given service types, soonest first. */
export async function upcomingPlans(serviceTypeIds, serviceTypeNames = {}) {
  if (isDemo()) return demo.upcomingPlans();
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const plans = [];
  for (const stId of serviceTypeIds) {
    const res = await request(`/service_types/${stId}/plans`, {
      filter: 'after',
      after: yesterday,
      order: 'sort_date',
      per_page: 6,
      include: 'plan_times',
    });
    const inc = indexIncluded(res.included);
    for (const p of res.data) {
      plans.push({
        id: p.id,
        serviceTypeId: stId,
        serviceTypeName: serviceTypeNames[stId] || '',
        title: p.attributes.title,
        seriesTitle: p.attributes.series_title,
        dates: p.attributes.dates,
        sortDate: p.attributes.sort_date,
        times: mapPlanTimes(p, inc),
        url: p.links?.html || `https://services.planningcenteronline.com/plans/${p.id}`,
      });
    }
  }
  return plans.sort((a, b) => a.sortDate.localeCompare(b.sortDate));
}

/** Plan is "current" until 2h after its last scheduled time ends (or end of its sort day). */
export function pickActivePlan(plans, now = Date.now()) {
  const GRACE = 2 * 3600_000;
  return plans.find((p) => {
    const last = p.times.at(-1);
    const end = last ? Date.parse(last.endsAt || last.startsAt) : Date.parse(p.sortDate) + 86400_000;
    return end + GRACE > now;
  }) || null;
}

// ---- item leaders (Planning Center's native "Leader" column) ----------------------------
// Leaders are ItemAssignments on each item, pointing at a Person or a TeamPosition.
// A TeamPosition leader means "whoever is scheduled in that position on this plan".

const positionCache = new Map(); // serviceTypeId -> { at, map: positionId -> { name, teamId } }
async function teamPositions(serviceTypeId) {
  const hit = positionCache.get(serviceTypeId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.map;
  const { data, included } = await requestAll(`/service_types/${serviceTypeId}/teams`, { include: 'team_positions' });
  const map = new Map();
  for (const team of data) {
    for (const ref of team.relationships?.team_positions?.data || []) {
      const pos = included.find((r) => r.type === 'TeamPosition' && r.id === ref.id);
      if (pos) map.set(pos.id, { name: pos.attributes.name, teamId: team.id });
    }
  }
  positionCache.set(serviceTypeId, { at: Date.now(), map });
  return map;
}

/** Name to show for a leader: the quoted nickname if there is one, else the first name. */
export function shortName(name) {
  const nick = /["“”]([^"“”]+)["“”]/.exec(String(name || ''))?.[1];
  if (nick) return nick.trim();
  return String(name || '').trim().split(/\s+/)[0] || '';
}

const personCache = new Map(); // personId -> name (for leaders not scheduled on the plan)
async function personName(id) {
  if (personCache.has(id)) return personCache.get(id);
  const res = await request(`/people/${id}`, { 'fields[Person]': 'first_name,last_name,full_name' });
  const a = res.data?.attributes || {};
  const name = a.full_name || [a.first_name, a.last_name].filter(Boolean).join(' ') || null;
  personCache.set(id, name);
  return name;
}

/**
 * Resolve each item's assignments to people. Pure apart from the two lookups passed in.
 * assignmentsByItem: itemId -> [{ type: 'Person'|'TeamPosition', id }]
 */
export async function resolveLeaders(assignmentsByItem, members, { positions, lookupPerson }) {
  const byPerson = new Map(members.filter((m) => m.personId).map((m) => [m.personId, m]));
  const out = new Map();
  for (const [itemId, refs] of assignmentsByItem) {
    const leaders = [];
    const add = (l) => { if (l.name && !leaders.some((x) => x.name === l.name)) leaders.push(l); };
    for (const ref of refs) {
      if (ref.type === 'Person') {
        const m = byPerson.get(ref.id);
        add({ name: m?.name || await lookupPerson(ref.id).catch(() => null), photo: m?.photo || null, personId: ref.id });
      } else if (ref.type === 'TeamPosition') {
        const pos = positions.get(ref.id);
        if (!pos) continue;
        for (const m of members) {
          if (m.status !== 'D' && m.position === pos.name && (!pos.teamId || m.teamId === pos.teamId)) {
            add({ name: m.name, photo: m.photo, personId: m.personId, position: pos.name });
          }
        }
      }
    }
    for (const l of leaders) l.short = shortName(l.name);
    out.set(itemId, leaders);
  }
  return out;
}

export async function planDetail(serviceTypeId, planId) {
  if (isDemo()) return demo.planDetail(planId);
  const base = `/service_types/${serviceTypeId}/plans/${planId}`;
  const [planRes, itemsRes, membersRes, notesRes] = await Promise.all([
    request(base, { include: 'plan_times,series' }),
    requestAll(`${base}/items`, { include: 'item_notes,item_assignments' }),
    requestAll(`${base}/team_members`, { include: 'team' }),
    // Plan-level notes (outside the order of service), e.g. an "Announcements" category.
    requestAll(`${base}/notes`).catch(() => ({ data: [] })),
  ]);
  const planNotes = notesRes.data.map((n) => ({ category: n.attributes.category_name, content: n.attributes.content })).filter((n) => n.content);

  const p = planRes.data;
  const planInc = indexIncluded(planRes.included);
  const teamInc = indexIncluded(membersRes.included);
  const noteInc = indexIncluded(itemsRes.included);

  const items = itemsRes.data
    .map((i) => ({
      id: i.id,
      title: i.attributes.title,
      type: i.attributes.item_type, // song | header | media | item
      length: i.attributes.length || 0,
      sequence: i.attributes.sequence,
      position: i.attributes.service_position, // pre | during | post
      key: i.attributes.key_name,
      description: i.attributes.description,
      notes: (i.relationships?.item_notes?.data || [])
        .map((ref) => noteInc.get(`ItemNote:${ref.id}`))
        .filter(Boolean)
        .map((n) => ({ category: n.attributes.category_name, content: n.attributes.content })),
    }))
    .sort((a, b) => a.sequence - b.sequence);

  // Item leaders (assignments → people). The docs disagree on whether included
  // assignments carry their `assignable`; if not, ask per item, and log if still missing.
  const assignmentsByItem = new Map();
  const missing = [];
  for (const i of itemsRes.data) {
    const assignRefs = i.relationships?.item_assignments?.data || [];
    const refs = assignRefs.map((ref) => noteInc.get(`ItemAssignment:${ref.id}`)?.relationships?.assignable?.data).filter(Boolean);
    if (refs.length) assignmentsByItem.set(i.id, refs);
    else if (assignRefs.length) missing.push(i.id);
  }
  for (const itemId of missing) {
    try {
      const { data } = await requestAll(`${base}/items/${itemId}/item_assignments`);
      const refs = data.map((a) => a.relationships?.assignable?.data).filter(Boolean);
      if (refs.length) assignmentsByItem.set(itemId, refs);
      else console.warn(`[pco] item ${itemId} has leader assignments but no assignable person/position in the API response`);
    } catch (err) {
      console.warn(`[pco] could not read leaders for item ${itemId}: ${err.message}`);
    }
  }

  const members = membersRes.data.map((m) => {
    const teamId = m.relationships?.team?.data?.id;
    return {
      personId: m.relationships?.person?.data?.id || null,
      name: m.attributes.name,
      position: m.attributes.team_position_name,
      status: m.attributes.status, // C confirmed, U unconfirmed, D declined
      photo: m.attributes.photo_thumbnail,
      teamId,
      teamName: teamInc.get(`Team:${teamId}`)?.attributes?.name || 'Team',
    };
  });

  if (assignmentsByItem.size) {
    const needsPositions = [...assignmentsByItem.values()].flat().some((r) => r.type === 'TeamPosition');
    const positions = needsPositions ? await teamPositions(serviceTypeId).catch(() => new Map()) : new Map();
    const leaders = await resolveLeaders(assignmentsByItem, members, { positions, lookupPerson: personName });
    for (const item of items) item.leaders = leaders.get(item.id) || [];
  }

  return {
    plan: {
      id: p.id,
      serviceTypeId,
      title: p.attributes.title,
      seriesTitle: p.attributes.series_title,
      dates: p.attributes.dates,
      sortDate: p.attributes.sort_date,
      totalLength: p.attributes.total_length,
      times: mapPlanTimes(p, planInc),
      url: p.links?.html || `https://services.planningcenteronline.com/plans/${p.id}`,
    },
    items,
    members,
    planNotes,
    fetchedAt: new Date().toISOString(),
  };
}
