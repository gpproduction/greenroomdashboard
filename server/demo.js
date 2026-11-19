// Fake Planning Center + ProPresenter data so the app can be tried without credentials (DEMO=1).

function nextSunday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  return d;
}

// Demo times are Eastern (UTC-5 in winter) so they look right regardless of server clock.
function at(day, h, m) {
  const d = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), h + 5, m));
  return d.toISOString();
}

export function serviceTypes() {
  return [
    { id: 'st1', name: 'Sunday Morning' },
    { id: 'st2', name: 'Sunday Nights' },
    { id: 'st3', name: 'Special Services' },
  ];
}

export function teams() {
  return [
    { id: 't1', name: 'Worship Team' },
    { id: 't2', name: 'Production Team' },
    { id: 't3', name: 'Choir' },
    { id: 't4', name: 'Host Team' },
  ];
}

function plan() {
  if (process.env.DEMO_LIVE === '1') return livePlan();
  const day = nextSunday();
  return {
    id: 'demo-plan',
    serviceTypeId: 'st1',
    serviceTypeName: 'Sunday Morning',
    title: null,
    seriesTitle: 'Demo Series',
    dates: day.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    sortDate: at(day, 9, 0),
    times: [
      { id: 'pt1', name: 'Sound Check', type: 'rehearsal', startsAt: at(day, 7, 45), endsAt: at(day, 8, 45) },
      { id: 'pt2', name: null, type: 'service', startsAt: at(day, 9, 0), endsAt: at(day, 10, 30) },
      { id: 'pt3', name: null, type: 'service', startsAt: at(day, 11, 0), endsAt: at(day, 12, 30) },
    ],
    url: 'https://services.planningcenteronline.com/',
  };
}

// DEMO_LIVE=1: a service that started 10 minutes ago, to try live item timing.
const DEMO_T0 = Date.now(); // anchor so the demo service doesn't drift on every sync
function livePlan() {
  const now = DEMO_T0;
  const iso = (min) => new Date(now + min * 60_000).toISOString();
  return {
    id: 'demo-plan',
    serviceTypeId: 'st1',
    serviceTypeName: 'Sunday Morning',
    title: null,
    seriesTitle: 'Demo Series',
    dates: 'Today',
    sortDate: iso(-10),
    times: [
      { id: 'pt1', name: 'Sound Check', type: 'rehearsal', startsAt: iso(-90), endsAt: iso(-30) },
      { id: 'pt2', name: null, type: 'service', startsAt: iso(-10), endsAt: iso(80) },
      { id: 'pt3', name: null, type: 'service', startsAt: iso(110), endsAt: iso(200) },
    ],
    url: 'https://services.planningcenteronline.com/',
  };
}

export function upcomingPlans() {
  return [plan()];
}

const PEOPLE = [
  ['p1', 'Alex Rivera', 't1', 'Worship Team', 'Vocals', 'C'],
  ['p2', 'Jordan Lee', 't1', 'Worship Team', 'Vocals', 'C'],
  ['p3', 'Sam Patel', 't1', 'Worship Team', 'Vocals', 'U'],
  ['p4', 'Casey Morgan', 't1', 'Worship Team', 'Acoustic Guitar', 'C'],
  ['p4', 'Casey Morgan', 't1', 'Worship Team', 'MD', 'C'],
  ['p5', 'Taylor Brooks', 't1', 'Worship Team', 'Electric Guitar', 'C'],
  ['p6', 'Riley Chen', 't1', 'Worship Team', 'Bass Guitar', 'C'],
  ['p7', 'Morgan Diaz', 't1', 'Worship Team', 'Keys', 'C'],
  ['p8', 'Jamie Fox', 't1', 'Worship Team', 'Drums', 'C'],
  ['p14', 'Chris Young', 't1', 'Worship Team', 'Aux/Organ', 'C'], // no device: shows because Worship Team shows everyone
  ['p15', 'Robin Park', 't4', 'Host Team', 'Greeter', 'C'],
  ['p16', 'Dana Cruz', 't4', 'Host Team', 'Info Center', 'C'],
  ['p9', 'Pat Kim', 't2', 'Production Team', 'Speaking Pastor', 'C'],
  ['p10', 'Drew Hall', 't2', 'Production Team', 'Announcements', 'C'],
  ['p11', 'Quinn Ward', 't2', 'Production Team', 'Sound', 'C'],
  ['p12', 'Avery Scott', 't2', 'Production Team', 'ProPresenter', 'C'],
  ['p13', 'Jesse Long', 't3', 'Choir', 'Choir Member', 'D'],
];

export function planDetail() {
  const p = plan();
  return {
    plan: { ...p, totalLength: 5400 },
    items: [
      { id: 'i0', title: 'Pre-Service', type: 'header', length: 0, sequence: 0, position: 'pre' },
      { id: 'i1', title: 'Countdown', type: 'media', length: 300, sequence: 1, position: 'pre' },
      { id: 'i2', title: 'Worship', type: 'header', length: 0, sequence: 2, position: 'during' },
      { id: 'i3', title: 'Opening Song', type: 'song', length: 270, sequence: 3, position: 'during', key: 'G', notes: [{ category: 'Lead', content: 'Alex' }],
        leaders: [{ name: 'Alex Rivera', photo: 'https://avatars.planningcenteronline.com/uploads/demo/p1.png', personId: 'p1' }] },
      { id: 'i4', title: 'Second Song', type: 'song', length: 300, sequence: 4, position: 'during', key: 'D',
        leaders: [{ name: 'Jordan Lee', photo: null, personId: 'p2' }, { name: 'Alex Rivera', photo: 'https://avatars.planningcenteronline.com/uploads/demo/p1.png', personId: 'p1' }] },
      { id: 'i5', title: 'Welcome & Announcements', type: 'item', length: 300, sequence: 5, position: 'during', notes: [{ category: 'Lead', content: 'Drew' }],
        description: 'Baptism Sunday sign-ups close Dec 7\nChristmas Eve services 4:00 & 6:00\nNew here? Stop by the Info Center' },
      { id: 'i6', title: 'Third Song', type: 'song', length: 330, sequence: 6, position: 'during', key: 'A', notes: [{ category: 'Lead', content: 'Alex' }] },
      { id: 'i7', title: 'Message', type: 'header', length: 0, sequence: 7, position: 'during' },
      { id: 'i8', title: 'Sermon', type: 'item', length: 2100, sequence: 8, position: 'during', notes: [{ category: 'Lead', content: 'Pastor Pat' }] },
      { id: 'i9', title: 'Response Song', type: 'song', length: 300, sequence: 9, position: 'during', key: 'E', notes: [{ category: 'Lead', content: 'Sam' }] },
      { id: 'i10', title: 'Dismissal', type: 'item', length: 120, sequence: 10, position: 'during' },
    ],
    members: PEOPLE.map(([personId, name, teamId, teamName, position, status]) => ({
      personId, name, teamId, teamName, position, status,
      // A couple of photo URLs to exercise the avatar path; offline they fall back to initials.
      photo: ['p1', 'p9'].includes(personId) ? `https://avatars.planningcenteronline.com/uploads/demo/${personId}.png` : null,
    })),
    fetchedAt: new Date().toISOString(),
  };
}

/** Three past Sundays of recorded item times, for the History tab in demo mode. */
export function seedHistory() {
  const live = {};
  const history = {};
  const items = [
    ['c', 'Countdown', 'media', 300, 'pre'], ['s1', 'Opening Song', 'song', 270, 'during'], ['s2', 'Second Song', 'song', 300, 'during'],
    ['w', 'Welcome & Announcements', 'item', 300, 'during'], ['s3', 'Third Song', 'song', 330, 'during'],
    ['m', 'Sermon', 'item', 2100, 'during'], ['r', 'Response Song', 'song', 300, 'during'], ['d', 'Dismissal', 'item', 120, 'during'],
  ];
  const jitter = [[0, 15, -10, 95, 20, 290, 40, 10], [0, -5, 25, 140, 0, 410, -20, 25], [0, 10, 5, 60, -15, 180, 30, -10]];
  for (let w = 1; w <= 3; w++) {
    const day = new Date(nextSunday().getTime() - w * 7 * 86400_000);
    const id = `demo-past-${w}`;
    const t9 = `${id}-9`, t11 = `${id}-11`;
    history[id] = {
      planId: id, serviceTypeId: 'st1', serviceTypeName: 'Sunday Morning', title: null, seriesTitle: 'Demo Series',
      dates: day.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }), sortDate: at(day, 9, 0),
      times: [{ id: t9, name: null, type: 'service', startsAt: at(day, 9, 0), endsAt: at(day, 10, 30) }, { id: t11, name: null, type: 'service', startsAt: at(day, 11, 0), endsAt: at(day, 12, 30) }],
      items: [{ id: 'h', title: 'Worship', type: 'header', length: 0, position: 'during', sequence: 0 }, ...items.map(([iid, title, type, length, position], i) => ({ id: iid, title, type, length, position, sequence: i + 1 }))],
      savedAt: new Date().toISOString(),
    };
    const rec = (k) => ({ items: Object.fromEntries(items.map(([iid, , , len], i) => [iid, Math.max(30, len + jitter[w - 1][i] + k)])), segments: [] });
    live[id] = { [t9]: rec(0), [t11]: rec(-25) };
  }
  return { live, history };
}

export function seedDevices() {
  const devices = [];
  for (let i = 1; i <= 8; i++) {
    devices.push({ id: `m${i}`, type: 'mic', name: `HH ${i}`, channel: String(i), frequency: `${(518 + i * 1.375).toFixed(3)} MHz`, kind: 'Handheld', notes: '', active: true, linkedId: `e${i}` });
  }
  devices.push({ id: 'm9', type: 'mic', name: 'Headset A', channel: '9', frequency: '531.250 MHz', kind: 'Headset', notes: '', active: true, linkedId: null });
  devices.push({ id: 'm10', type: 'mic', name: 'Lav B', channel: '10', frequency: '533.000 MHz', kind: 'Lavalier', notes: '', active: true, linkedId: null });
  devices.push({ id: 'o1', type: 'other', name: 'Acoustic Pack', channel: '', frequency: '', kind: 'Wireless pack', notes: '', active: true, linkedId: null });
  devices.push({ id: 'o2', type: 'other', name: 'Violin Mic', channel: '', frequency: '', kind: 'Clip-on', notes: '', active: true, linkedId: null });
  for (let i = 1; i <= 8; i++) {
    devices.push({ id: `e${i}`, type: 'iem', name: `IEM ${i}`, channel: `Mix ${i}`, frequency: `${(570 + i * 0.8).toFixed(3)} MHz`, kind: 'Wireless pack', notes: '', active: true, linkedId: `m${i}` });
  }
  return devices;
}

export function seedAssignments() {
  return {
    p1: { mic: 'm1', iem: 'e1' }, p2: { mic: 'm2', iem: 'e2' }, p3: { mic: 'm3', iem: 'e3' },
    p4: { mic: 'm4', iem: 'e4', other: 'o1' }, p5: { iem: 'e5' }, p6: { iem: 'e6' }, p7: { mic: 'm5', iem: 'e7' },
    p8: { iem: 'e8' }, p9: { mic: 'm9' }, p10: { mic: 'm10' },
  };
}

// --- ProPresenter fakes -------------------------------------------------------
const started = Date.now();
function fmt(sec) {
  const sign = sec < 0 ? '-' : '';
  sec = Math.abs(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function timers() {
  const elapsed = Math.floor((Date.now() - started) / 1000);
  const countdown = 300 - (elapsed % 420);
  return [
    { id: { uuid: 'tm1', name: 'Service Countdown', index: 0 }, time: fmt(countdown), state: countdown < 0 ? 'overrun' : 'running' },
    { id: { uuid: 'tm2', name: 'Sermon', index: 1 }, time: fmt(1800 - elapsed), state: 'running' },
    { id: { uuid: 'tm3', name: 'Walk-in Loop', index: 2 }, time: '00:10:00', state: 'stopped' },
  ];
}

export function activePresentation() {
  const titles = ['Opening Song', 'Second Song', 'Welcome & Announcements', 'Third Song'];
  return titles[Math.floor((Date.now() - started) / 20_000) % titles.length];
}
