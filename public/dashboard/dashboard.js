/* GrowPoint Backstage (green room screen) — designed to run unattended in a Chrome kiosk window.
 *
 * URL options (combine with &):
 *   ?layout=full|roster|order|timers   which panels to show (default full)
 *   ?teams=Worship Team,Choir    only show these teams (names, case-insensitive)
 *   ?scale=1.2                   make everything bigger/smaller
 *   ?embed=1                     hide the header and status bar (for embedding)
 *   ?side=0                      hide the right-hand panel
 */
(() => {
  const params = new URLSearchParams(location.search);
  const layout = params.get('layout') || 'full';
  const teamFilter = (params.get('teams') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  document.body.classList.add(`layout-${layout}`);
  if (params.get('side') === '0') document.body.classList.add('no-side');
  if (params.get('embed') === '1') document.body.classList.add('embed'); // inside another page (e.g. Front of House): no header/footer
  // Theme: ?theme= on the link wins, else Admin → Settings → Backstage.
  const urlTheme = params.get('theme');
  const applyTheme = (t) => { document.documentElement.dataset.theme = ['pco-dark', 'pco-light'].includes(t) ? t : 'growpoint'; };
  applyTheme(urlTheme);
  if (params.get('scale')) document.documentElement.style.setProperty('--user-scale', params.get('scale'));

  const $ = (id) => document.getElementById(id);
  let state = null;
  let pp = { connected: false, timers: [] };
  let media = null; // { hyperdeck, obs } recorder/encoder status
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

  // Church time zone from Settings; an invalid name falls back to the TV's own zone instead of crashing.
  const tz = () => {
    const zone = state?.display?.timezone;
    try { if (zone) new Intl.DateTimeFormat('en-US', { timeZone: zone }); return zone || undefined; } catch { return undefined; }
  };
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


    if (!urlTheme) applyTheme(display.theme);
    renderRoster();
    renderOrder();
    renderTimers();
    renderAnnouncements();
    renderStatus();
    tickClock();
    requestAnimationFrame(autoFit);
  }

  function chip(label, dev) {
    if (!dev) return null; // nothing assigned → no placeholder chip
    return el('span', {
      class: 'chip',
      title: [dev.kind, dev.frequency].filter(Boolean).join(' · '),
    }, label ? el('span', { class: 'k' }, label) : null, dev.name);
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
    let teams = state.teams || [];
    if (teamFilter.length) teams = teams.filter((t) => teamFilter.includes(t.name.toLowerCase()));

    if (!state.plan) {
      root.append(el('div', { class: 'empty-state' }, state.pco?.error || 'Waiting for Planning Center…'));
      return;
    }
    if (!teams.length) {
      root.append(el('div', { class: 'empty-state' }, 'No one to show yet — assign devices or tick “Show” in admin.'));
      return;
    }

    for (const team of teams) {
      const members = team.members; // server only sends people with a mic or IEM
      root.append(el('div', { class: 'team' },
        el('h3', {}, team.name),
        members.map((m) => el('div', { class: 'person' + (m.status === 'U' ? ' unconfirmed' : '') + (m.arrivedAt ? ' arrived' : '') },
          avatar(m),
          el('div', { class: 'who' },
            el('div', { class: 'name-line' }, el('span', { class: 'name' }, m.name)),
            el('div', { class: 'pos' },
              // Badged in through UniFi Access today (on the second line so the name gets the full width)
              m.arrivedAt ? el('span', { class: 'arrived-tag' }, '✓ Arrived', el('span', { class: 'at' }, fmtTime(new Date(m.arrivedAt).toISOString()))) : null,
              m.positions.join(', '), m.status === 'U' ? el('span', { class: 'tag' }, 'unconfirmed') : null)),
          // "Other" (acoustic pack, violin mic…) shows as a plain chip with just its name.
          el('div', { class: 'devices' }, chip('Mic', m.mic), chip('IEM', m.iem), chip('', m.other)),
        )),
      ));
    }
  }

  function normalise(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // Which plan item is live in ProPresenter? ProPresenter tells us the name of the
  // presentation that's currently showing; we match it to a Planning Center item
  // title. Exact match wins; otherwise one name containing the other (e.g.
  // "Raise A Hallelujah (Live)"). Only one item is ever highlighted.
  function activeItemId(items, presentationName) {
    const active = normalise(presentationName);
    if (!active) return null;
    const candidates = items.filter((i) => i.type !== 'header').map((i) => ({ id: i.id, t: normalise(i.title) })).filter((i) => i.t);
    const exact = candidates.find((i) => i.t === active);
    if (exact) return exact.id;
    const partial = candidates.find((i) => Math.min(i.t.length, active.length) >= 4 && (active.includes(i.t) || i.t.includes(active)));
    return partial ? partial.id : null;
  }

  // Server time ≈ Date.now() + clockOffset (keeps the live counter honest if the TV's clock drifts).
  let clockOffset = 0;
  const serverNow = () => Date.now() + clockOffset;

  function showDescription(item) {
    const mode = state.display.itemDescriptions || 'announcements';
    if (!item.description || mode === 'none') return false;
    return mode === 'all' || /announce/i.test(item.title);
  }

  // Seconds an item has actually run in the shown service time (incl. the running segment).
  function actualSeconds(item) {
    const live = state.live;
    let secs = live?.actuals?.[item.id] || 0;
    if (live?.recording && live.currentItemId === item.id) secs += Math.max(0, (serverNow() - live.currentStartedAt) / 1000);
    return secs;
  }

  // Leader column: Planning Center's native leaders (small photos + first names),
  // or the fallback note-column text.
  function leaderCell(item) {
    const leaders = item.leaders || [];
    if (!leaders.length) return el('span', { class: 'lead' }, item.leader || '');
    const first = (l) => l.short || String(l.name).trim().split(/\s+/)[0]; // server sends nickname or first name
    return el('span', { class: 'lead people' },
      el('span', { class: 'faces' }, leaders.slice(0, 3).map((l) => {
        if (!hasPhoto(l.photo)) return el('span', { class: 'face' }, initials(l.name));
        const img = el('img', { class: 'face', src: l.photo, alt: '', referrerpolicy: 'no-referrer' });
        img.onerror = () => img.replaceWith(el('span', { class: 'face' }, initials(l.name)));
        return img;
      })),
      el('span', { class: 'names' }, leaders.map(first).join(' & ')));
  }

  function renderOrder() {
    const panel = $('order-panel');
    const list = $('order');
    list.replaceChildren();
    const items = state.plan?.items || [];
    const showOrder = state.display.showOrderOfService && items.length;
    document.body.classList.toggle('no-order', !showOrder);
    if (!showOrder) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');

    const live = state.live;
    const hasActuals = Boolean(live && (live.recording || Object.keys(live.actuals || {}).length));
    const activeId = live?.recording ? live.currentItemId : activeItemId(items, pp.activePresentation);

    // Header badge: LIVE while recording, otherwise which service's actual times are shown.
    const status = $('live-status');
    status.className = 'live-status';
    if (live?.test) {
      // Production test mode (started from admin): obvious so nobody mistakes it for a real service.
      status.classList.add('on', 'test');
      status.replaceChildren(el('i', { class: 'rec' }), 'TEST MODE');
    } else if (live?.recording) {
      status.classList.add('on');
      status.replaceChildren(el('i', { class: 'rec' }), `LIVE · ${fmtTime(live.startsAt)}`);
    } else if (hasActuals && live.startsAt) {
      status.replaceChildren(`${fmtTime(live.startsAt)} actual`);
    } else status.replaceChildren();

    list.append(el('li', { class: 'cols' }, el('span', {}, 'Item'), el('span', {}, 'Leader'), el('span', {}, 'Time')));
    let plannedTotal = 0;
    let actualTotal = 0;
    for (const item of items) {
      if (item.type === 'header') {
        list.append(el('li', { class: 'header' }, item.title));
        continue;
      }
      const isActive = item.id === activeId;
      const isLive = live?.recording && item.id === live.currentItemId;
      const secs = hasActuals ? actualSeconds(item) : 0;
      if (item.position === 'during') plannedTotal += item.length || 0;
      actualTotal += secs;
      const over = item.length && secs > item.length;

      const timing = el('span', { class: 'timing' },
        isLive
          ? el('span', { class: 'actual live' + (over ? ' over' : ''), id: 'live-elapsed', 'data-item': item.id }, fmtDuration(secs))
          : secs ? el('span', { class: 'actual' + (over ? ' over' : ' under') }, fmtDuration(secs)) : null,
        el('span', { class: 'len' }, item.length ? (secs || isLive ? `of ${fmtDuration(item.length)}` : fmtDuration(item.length)) : ''));

      list.append(el('li', { class: [isActive ? 'active' : '', isLive ? 'is-live' : '', item.position !== 'during' ? 'prepost' : ''].join(' ') },
        el('span', {},
          item.title, item.key ? el('span', { class: 'key' }, item.key) : null,
          showDescription(item) ? el('span', { class: 'desc' }, item.description) : null),
        leaderCell(item),
        timing));
    }
    if (hasActuals && actualTotal) {
      list.append(el('li', { class: 'total' },
        el('span', {}, 'Service so far'),
        el('span', {}),
        el('span', { class: 'timing' },
          el('span', { class: 'actual' + (actualTotal > plannedTotal ? ' over' : ''), id: 'live-total' }, fmtDuration(actualTotal)),
          plannedTotal ? el('span', { class: 'len' }, `of ${fmtDuration(plannedTotal)}`) : null)));
    }
  }

  // Tick the running item and total every second without re-rendering the list.
  function tickLive() {
    const live = state?.live;
    if (!live?.recording) return;
    const node = $('live-elapsed');
    const item = state.plan?.items?.find((i) => i.id === live.currentItemId);
    if (node && item) {
      const secs = actualSeconds(item);
      node.textContent = fmtDuration(secs);
      node.classList.toggle('over', Boolean(item.length && secs > item.length));
    }
    const total = $('live-total');
    if (total) total.textContent = fmtDuration(state.plan.items.reduce((sum, i) => sum + (i.type === 'header' ? 0 : actualSeconds(i)), 0));
  }

  // Announcements box (Admin → Settings → Backstage), pulled from Planning Center.
  function renderAnnouncements() {
    const panel = $('ann-panel');
    const a = state?.announcements;
    panel.classList.toggle('hidden', !a?.enabled);
    if (!a?.enabled) return;
    const box = $('announcements');
    if (!a.groups.length) { box.replaceChildren(el('div', { class: 'empty' }, 'No announcements in this plan.')); return; }
    const showTitles = a.groups.length > 1;
    // Shown as written: plain lines as-is, "-" lines as bullets, blank lines as spacing, indentation kept.
    box.replaceChildren(...a.groups.map((g) => el('div', { class: 'ann-group' },
      showTitles ? el('div', { class: 'ann-title' }, g.title) : null,
      g.lines.map((l) => (l.blank
        ? el('div', { class: 'ann-gap' })
        : el('div', { class: `ann-line${l.bullet ? ' bullet' : ''}`, style: l.indent ? `margin-left:${l.indent * 1.2}rem` : null }, l.text))))));
  }

  function renderTimers() {
    const panel = $('timers-panel');
    const box = $('timers');
    box.replaceChildren();
    // The right-hand column holds timers and/or announcements.
    document.body.classList.toggle('no-timers', !state?.showTimers && !state?.announcements?.enabled);
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
      box.append(el('div', { class: `timer ${cls}` }, el('div', { class: 'name' }, t.name), el('div', { class: 'time' }, ppTime(t.time))));
    }
  }

  // HyperDeck / OBS pills in the footer. "on" = recording/streaming (red), "warn" = paused or
  // reconnecting, "idle" = connected but not running, "offline" = can't reach the device.
  function obsTime(tc) {
    if (!tc) return '';
    const [h, m, s] = tc.split('.')[0].split(':').map(Number);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  function pill(kind, label, state, word, time) {
    return el('span', { class: `pill ${state}` }, el('i', { class: 'dot' }), el('span', { class: 'pill-label' }, label),
      word ? el('b', {}, word) : null, time ? el('span', { class: 'tc' }, time) : null);
  }
  function renderMedia() {
    const box = $('media');
    if (!box) return;
    const pills = [];
    const h = media?.hyperdeck;
    if (h?.enabled) {
      if (!h.connected) pills.push(pill('hd', 'HyperDeck', 'offline', 'Offline'));
      else if (h.status === 'record') pills.push(pill('hd', 'HyperDeck', 'on', 'REC', h.timecode));
      else if (h.status === 'play') pills.push(pill('hd', 'HyperDeck', 'idle', 'PLAY', h.timecode));
      else pills.push(pill('hd', 'HyperDeck', 'idle', 'Stopped', h.timecode));
    }
    const o = media?.obs;
    if (o?.enabled) {
      if (!o.connected) pills.push(pill('obs', 'OBS', 'offline', 'Offline'));
      else {
        const st = o.stream;
        pills.push(st?.reconnecting ? pill('obs', 'Stream', 'warn', 'RECONNECTING', obsTime(st.timecode))
          : st?.active ? pill('obs', 'Stream', 'on', 'LIVE', obsTime(st.timecode))
            : pill('obs', 'Stream', 'idle', 'Off'));
        const rc = o.record;
        pills.push(rc?.paused ? pill('obs', 'OBS Record', 'warn', 'PAUSED', obsTime(rc.timecode))
          : rc?.active ? pill('obs', 'OBS Record', 'on', 'REC', obsTime(rc.timecode))
            : pill('obs', 'OBS Record', 'idle', 'Off'));
      }
    }
    box.replaceChildren(...pills);
  }

  function renderStatus() {
    const set = (id, cls, title) => { const n = $(id); n.className = cls; n.title = title || ''; };
    set('status-pco', state?.pco?.ok ? 'ok' : 'bad', state?.pco?.error || (state?.pco?.lastSync ? `Last sync ${fmtTime(state.pco.lastSync)}` : ''));
    set('status-pp', !state?.showTimers ? 'off' : pp.connected ? 'ok' : 'bad', pp.error || '');
    set('status-ws', wsConnected ? 'ok' : 'bad');
    const u = state?.unifi;
    set('status-unifi', !u?.enabled ? 'hidden' : u.connected ? 'ok' : 'bad', u?.error || '');
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
    tickLive();
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
    if (s.serverTime) clockOffset = s.serverTime - Date.now();
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
      if (msg.type === 'media') { media = msg.payload; renderMedia(); }
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
      media = data.media;
      renderMedia();
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
