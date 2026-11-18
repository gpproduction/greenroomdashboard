/* Green Room dashboard — designed to run unattended in a Chrome kiosk window.
 *
 * URL options (combine with &):
 *   ?layout=full|roster|timers   which panels to show (default full)
 *   ?teams=Worship Team,Choir    only show these teams (names, case-insensitive)
 *   ?scale=1.2                   make everything bigger/smaller
 *   ?side=0                      hide the right-hand panel
 */
(() => {
  const params = new URLSearchParams(location.search);
  const layout = params.get('layout') || 'full';
  const teamFilter = (params.get('teams') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  document.body.classList.add(`layout-${layout}`);
  if (params.get('side') === '0') document.body.classList.add('no-side');
  if (params.get('scale')) document.documentElement.style.setProperty('--user-scale', params.get('scale'));

  const $ = (id) => document.getElementById(id);
  let state = null;
  let pp = { connected: false, timers: [] };
  let bootId = null;
  let wsConnected = false;
  const loadedAt = Date.now();

  // ---- helpers --------------------------------------------------------------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'style') node.style.cssText = v;
      else node.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
    return node;
  }

  const tz = () => state?.display?.timezone || undefined;
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz() });

  function fmtDuration(totalSec) {
    totalSec = Math.max(0, Math.round(totalSec));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
  }

  // ProPresenter gives "HH:MM:SS" (optionally negative). Trim leading zero hours.
  function ppTime(str) {
    if (!str) return '--:--';
    const neg = str.startsWith('-');
    const parts = str.replace('-', '').split(':').map((n) => parseInt(n, 10));
    if (parts.some(Number.isNaN)) return str;
    const [h, m, s] = parts.length === 3 ? parts : [0, ...parts];
    const body = h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
    return (neg ? '-' : '') + body;
  }
  function ppSeconds(str) {
    if (!str) return null;
    const neg = str.startsWith('-');
    const parts = str.replace('-', '').split(':').map(Number);
    const sec = parts.reduce((acc, n) => acc * 60 + n, 0);
    return neg ? -sec : sec;
  }

  // ---- rendering ---------------------------------------------------------------
  function render() {
    if (!state) return;
    const { display, plan } = state;
    const logo = $('logo');
    logo.classList.toggle('hidden', display.showLogo === false);
    const logoSrc = `/branding/logo?v=${display.logoVersion || 0}`;
    if (logo.getAttribute('src') !== logoSrc) logo.setAttribute('src', logoSrc);

    if (plan) {
      const bits = [plan.serviceTypeName, plan.dates, plan.title || plan.seriesTitle].filter(Boolean);
      $('plan-meta').textContent = bits.join('  ·  ');
    } else {
      $('plan-meta').textContent = 'No upcoming plan';
    }

    // Conflicts banner
    const banner = $('banner');
    if (state.conflicts?.length) {
      banner.textContent = '⚠ Device conflict: ' + state.conflicts.map((c) => `${c.deviceName} → ${c.people.join(' & ')}`).join('   ·   ');
      banner.classList.remove('hidden');
    } else banner.classList.add('hidden');

    renderRoster();
    renderOrder();
    renderTimers();
    renderStatus();
    tickClock();
    requestAnimationFrame(autoFit);
  }

  function chip(label, dev, conflictIds) {
    if (!dev) return el('span', { class: 'chip empty' }, el('span', { class: 'k' }, label), '—');
    return el('span', {
      class: 'chip' + (conflictIds.has(dev.id) ? ' conflict' : ''),
      title: [dev.kind, dev.frequency].filter(Boolean).join(' · '),
    }, el('span', { class: 'k' }, label), dev.name);
  }

  // Planning Center photo when the person has one, otherwise their initials.
  function hasPhoto(url) {
    return url && /^https:\/\//.test(url) && !/no_photo|default|placeholder/i.test(url);
  }
  function avatar(m) {
    if (!hasPhoto(m.photo)) return el('div', { class: 'avatar' }, initials(m.name));
    const img = el('img', { class: 'avatar', src: m.photo, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.onerror = () => img.replaceWith(el('div', { class: 'avatar' }, initials(m.name)));
    return img;
  }

  function renderRoster() {
    const root = $('roster');
    root.replaceChildren();
    const conflictIds = new Set((state.conflicts || []).map((c) => c.deviceId));
    let teams = state.teams || [];
    if (teamFilter.length) teams = teams.filter((t) => teamFilter.includes(t.name.toLowerCase()));

    if (!state.plan) {
      root.append(el('div', { class: 'empty-state' }, state.pco?.error || 'Waiting for Planning Center…'));
      return;
    }
    if (!teams.length) {
      root.append(el('div', { class: 'empty-state' }, 'No mics or IEMs assigned yet for this plan.'));
      return;
    }

    for (const team of teams) {
      const members = team.members; // server only sends people with a mic or IEM
      root.append(el('div', { class: 'team' },
        el('h3', {}, team.name),
        members.map((m) => el('div', { class: 'person' + (m.status === 'U' ? ' unconfirmed' : '') },
          avatar(m),
          el('div', { class: 'who' },
            el('div', { class: 'name' }, m.name),
            el('div', { class: 'pos' }, m.positions.join(', '), m.status === 'U' ? el('span', { class: 'tag' }, 'unconfirmed') : null)),
          el('div', { class: 'devices' }, chip('Mic', m.mic, conflictIds), chip('IEM', m.iem, conflictIds)),
        )),
      ));
    }
  }

  function normalise(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function renderOrder() {
    const panel = $('order-panel');
    const list = $('order');
    list.replaceChildren();
    const items = state.plan?.items || [];
    if (!state.display.showOrderOfService || !items.length) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    const active = normalise(pp.activePresentation);
    for (const item of items) {
      if (item.type === 'header') {
        list.append(el('li', { class: 'header' }, item.title));
        continue;
      }
      const t = normalise(item.title);
      const isActive = active && t && (t === active || active.includes(t) || t.includes(active));
      list.append(el('li', { class: [isActive ? 'active' : '', item.position !== 'during' ? 'prepost' : ''].join(' ') },
        el('span', {}, item.title, item.key ? el('span', { class: 'key' }, item.key) : null,
          item.leader ? el('span', { class: 'leader' }, item.leader) : null),
        el('span', { class: 'len' }, item.length ? fmtDuration(item.length) : '')));
    }
  }

  function renderTimers() {
    const panel = $('timers-panel');
    const box = $('timers');
    box.replaceChildren();
    if (!state?.showTimers) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    if (!pp.connected) {
      box.append(el('div', { class: 'empty' }, pp.error ? `ProPresenter: ${pp.error}` : 'ProPresenter not connected'));
      return;
    }
    if (!pp.timers.length) {
      box.append(el('div', { class: 'empty' }, 'No timers'));
      return;
    }
    for (const t of pp.timers) {
      const secs = ppSeconds(t.time);
      let cls = t.state === 'running' ? 'running' : 'stopped';
      if (secs != null && secs < 0) cls = 'overrun';
      else if (t.state === 'running' && secs != null && secs <= 60) cls = 'warning';
      if (/overr/.test(t.state || '')) cls = 'overrun';
      box.append(el('div', { class: `timer ${cls}` }, el('span', { class: 'name' }, t.name), el('span', { class: 'time' }, ppTime(t.time))));
    }
  }

  function renderStatus() {
    const set = (id, cls, title) => { const n = $(id); n.className = cls; n.title = title || ''; };
    set('status-pco', state?.pco?.ok ? 'ok' : 'bad', state?.pco?.error || (state?.pco?.lastSync ? `Last sync ${fmtTime(state.pco.lastSync)}` : ''));
    set('status-pp', !state?.showTimers ? 'off' : pp.connected ? 'ok' : 'bad', pp.error || '');
    set('status-ws', wsConnected ? 'ok' : 'bad');
  }

  // Shrink everything until the roster fits on one screen (no scrolling on a TV).
  function autoFit() {
    const root = document.documentElement;
    const roster = $('roster');
    let fs = 1;
    root.style.setProperty('--fs', fs);
    const overflowing = () => roster.scrollWidth > roster.clientWidth + 2 || roster.scrollHeight > roster.clientHeight + 2
      || $('order-panel').scrollHeight > $('order-panel').clientHeight + 2;
    while (overflowing() && fs > 0.5) {
      fs = Math.round((fs - 0.04) * 100) / 100;
      root.style.setProperty('--fs', fs);
    }
  }
  window.addEventListener('resize', () => requestAnimationFrame(autoFit));

  // ---- clock & service countdown -----------------------------------------------
  function greeting() {
    const hour = Number(new Date().toLocaleString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz() }));
    return hour < 12 ? 'Good Morning' : hour < 17 ? 'Good Afternoon' : 'Good Evening';
  }

  function tickClock() {
    const g = greeting();
    if ($('greeting').textContent !== g) $('greeting').textContent = g;
    $('clock').textContent = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: tz() });
    const box = $('service-countdown');
    const times = (state?.plan?.times || []).filter((t) => t.type === 'service' || t.type === 'rehearsal');
    if (!state?.display?.showServiceCountdown || !times.length) { box.replaceChildren(); return; }
    const now = Date.now();
    const current = times.find((t) => Date.parse(t.startsAt) <= now && now < Date.parse(t.endsAt));
    const next = times.find((t) => Date.parse(t.startsAt) > now);
    const label = (t) => t.name || (t.type === 'service' ? `${fmtTime(t.startsAt)} Service` : 'Rehearsal');
    box.classList.toggle('live', Boolean(current));
    if (current && current.type === 'service') {
      box.replaceChildren(el('div', { class: 'label' }, `${label(current)} · in progress`), el('div', { class: 'value' }, `ends ${fmtTime(current.endsAt)}`));
    } else if (next && Date.parse(next.startsAt) - now < 12 * 3600_000) {
      box.replaceChildren(el('div', { class: 'label' }, `${label(next)} starts in`), el('div', { class: 'value' }, fmtDuration((Date.parse(next.startsAt) - now) / 1000)));
    } else if (next) {
      box.replaceChildren(el('div', { class: 'label' }, 'Next'), el('div', { class: 'value' }, `${new Date(next.startsAt).toLocaleDateString('en-US', { weekday: 'short', timeZone: tz() })} ${fmtTime(next.startsAt)}`));
    } else box.replaceChildren();
  }
  setInterval(tickClock, 1000);

  // ---- live connection -------------------------------------------------------
  function onState(s) {
    // A new bootId means the server restarted (possibly with new code) → reload.
    if (bootId && s.bootId !== bootId) { location.reload(); return; }
    bootId = s.bootId;
    state = s;
    render();
  }

  let retry = 1000;
  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => { wsConnected = true; retry = 1000; renderStatus(); };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'state') onState(msg.payload);
      if (msg.type === 'propresenter') {
        pp = msg.payload;
        if (state) { renderTimers(); renderOrder(); renderStatus(); }
      }
    };
    ws.onclose = () => {
      wsConnected = false;
      renderStatus();
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 15000);
    };
    ws.onerror = () => ws.close();
  }

  // Fallback polling in case WebSockets are blocked or flaky.
  async function poll() {
    if (wsConnected) return;
    try {
      const res = await fetch('/api/dashboard', { cache: 'no-store' });
      const data = await res.json();
      pp = data.propresenter;
      onState(data);
    } catch { /* server unreachable — keep showing last data */ }
  }
  setInterval(poll, 15000);

  // Periodic hard reload keeps a long-running kiosk tab healthy.
  setInterval(() => {
    const hours = Number(state?.display?.reloadHours) || 0;
    if (hours > 0 && Date.now() - loadedAt > hours * 3600_000) location.reload();
  }, 60_000);

  // Keep the screen awake where the browser allows it (HTTPS or localhost only).
  async function wakeLock() {
    try { await navigator.wakeLock?.request('screen'); } catch { /* not available on plain http */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wakeLock(); });
  wakeLock();

  poll();
  connect();
})();
