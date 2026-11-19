/* Front of House (sound desk): Open Sound Meter levels, Spotify now-playing + controls, order of service. */
(() => {
  const $ = (id) => document.getElementById(id);
  let osm = null;
  let sp = null;
  let signedIn = false;
  let bootId = null;
  let tz;

  // ---- helpers ---------------------------------------------------------------------
  const fmt1 = (v) => (v == null ? '--' : v.toFixed(1));
  const mmss = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const level = (v, o) => (v == null ? '' : v >= o.alarm ? 'alarm' : v >= o.warn ? 'warn' : '');
  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { signedIn = false; renderSpotify(); throw new Error('Sign in to control Spotify'); }
    if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
    return data;
  }
  async function get(url) {
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
    return data;
  }

  // ---- clock -------------------------------------------------------------------------
  setInterval(() => {
    let t;
    try { t = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: tz }); } catch { t = new Date().toLocaleTimeString(); }
    $('clock').textContent = t;
    tickProgress();
  }, 1000);

  // ---- level meter --------------------------------------------------------------------
  const LOW = 60, HIGH = 110;
  const pct = (v) => Math.max(0, Math.min(100, ((v - LOW) / (HIGH - LOW)) * 100));
  function renderMeter() {
    const card = $('meter');
    const o = osm || {};
    $('spl-unit').textContent = `dB(${o.curve || 'A'})`;
    $('spl-time').textContent = o.time || 'Slow';
    $('leq-label').textContent = `Leq ${o.leqMinutes || 15} min`;
    $('mark-warn').style.left = `${pct(o.warn || 95)}%`;
    $('mark-alarm').style.left = `${pct(o.alarm || 100)}%`;
    const live = o.connected && o.spl != null;
    // Toggle only the level classes (don't overwrite "tool"/"hidden" used by the tool picker).
    const lvl = live ? level(o.spl, o) : 'off';
    for (const c of ['warn', 'alarm', 'off']) card.classList.toggle(c, c === lvl);
    $('spl').textContent = live ? fmt1(o.spl) : '--.-';
    $('bar-fill').style.width = live ? `${pct(o.fast ?? o.spl)}%` : '0';
    for (const [id, v] of [['leq', o.leq], ['leq1', o.leq1], ['max1', o.max1]]) {
      $(id).textContent = fmt1(v);
      $(id).className = `v ${level(v, o)}`;
    }
    $('meter-src').textContent = live ? `${o.source}${o.host ? ` · ${o.host}` : ''}` : 'Open Sound Meter';
    const msg = $('meter-msg');
    msg.className = 'msg';
    if (!o.enabled) msg.innerHTML = 'Not connected. Turn it on in <a href="/admin/#settings" target="_blank">Admin → Settings → Open Sound Meter</a>.';
    else if (o.error) { msg.className = 'msg error'; msg.textContent = o.error; }
    else if (!o.connected) msg.textContent = 'Waiting for Open Sound Meter… (in OSM, open Remote and tick “Server”).';
    else msg.textContent = '';
  }

  // ---- Spotify ----------------------------------------------------------------------------
  function renderSpotify() {
    const card = $('spotify');
    const p = sp?.player;
    card.classList.toggle('locked', !signedIn || !sp?.connected);
    $('sp-title').textContent = p?.title || (sp?.connected ? 'Nothing playing' : '—');
    $('sp-artist').textContent = p?.artist || '';
    $('sp-art').style.backgroundImage = p?.art ? `url("${encodeURI(p.art)}")` : '';
    $('sp-art').textContent = p?.art ? '' : '♫';
    $('sp-device').textContent = p?.device ? `on ${p.device.name}` : '';
    $('sp-playpause').textContent = p?.isPlaying ? '⏸' : '▶';
    if (p?.device && document.activeElement !== $('sp-volume')) $('sp-volume').value = p.device.volume ?? 50;
    tickProgress();
    const msg = $('sp-msg');
    msg.className = 'msg';
    if (!sp?.configured) msg.innerHTML = 'Not connected. Connect it in <a href="/admin/#settings" target="_blank">Admin → Settings → Spotify</a>.';
    else if (sp.error) { msg.className = 'msg error'; msg.textContent = sp.error; }
    else if (!signedIn) msg.innerHTML = '<a href="/admin/" target="_blank">Sign in to admin</a> on this computer to control playback, then reload.';
    else msg.textContent = '';
  }

  function tickProgress() {
    const p = sp?.player;
    if (!p || !p.durationMs) { $('sp-progress').style.width = '0'; $('sp-pos').textContent = '0:00'; $('sp-dur').textContent = '0:00'; return; }
    const pos = Math.min(p.durationMs, p.progressMs + (p.isPlaying ? Date.now() - p.at : 0));
    $('sp-progress').style.width = `${(pos / p.durationMs) * 100}%`;
    $('sp-pos').textContent = mmss(pos);
    $('sp-dur').textContent = mmss(p.durationMs);
  }

  async function act(action, body) {
    try {
      $('sp-msg').className = 'msg';
      await post(`/api/sound/spotify/${action}`, body);
    } catch (err) {
      $('sp-msg').className = 'msg error';
      $('sp-msg').textContent = err.message;
    }
  }
  for (const b of document.querySelectorAll('[data-act]')) b.addEventListener('click', () => act(b.dataset.act));
  $('sp-playpause').addEventListener('click', () => act(sp?.player?.isPlaying ? 'pause' : 'play'));
  let volTimer;
  $('sp-volume').addEventListener('input', (e) => {
    clearTimeout(volTimer);
    volTimer = setTimeout(() => act('volume', { volume: Number(e.target.value) }), 250);
  });
  $('sp-play-playlist').addEventListener('click', () => {
    const uri = $('sp-playlists').value;
    if (uri) act('play', { contextUri: uri, deviceId: $('sp-devices').value || undefined });
  });
  $('sp-devices').addEventListener('change', (e) => { if (e.target.value) act('transfer', { deviceId: e.target.value, play: Boolean(sp?.player?.isPlaying) }); });

  async function loadPickers() {
    if (!signedIn || !sp?.connected) return;
    try {
      const lists = await get('/api/sound/spotify-playlists');
      $('sp-playlists').replaceChildren(new Option('Choose a playlist…', ''), ...lists.map((l) => new Option(`${l.name}${l.tracks != null ? ` (${l.tracks})` : ''}`, l.uri)));
      const devs = await get('/api/sound/spotify-devices');
      $('sp-devices').replaceChildren(new Option(devs.length ? 'Play on…' : 'No devices — open Spotify', ''), ...devs.map((d) => {
        const o = new Option(`${d.name}${d.isActive ? ' ✓' : ''}`, d.id);
        return o;
      }));
    } catch (err) {
      $('sp-msg').className = 'msg error';
      $('sp-msg').textContent = err.message;
    }
  }
  $('sp-devices').addEventListener('focus', loadPickers);

  // ---- which tools to show ------------------------------------------------------------------
  // Admin → Settings → Front of House, or per computer with ?tools=level,order
  const urlTools = new URLSearchParams(location.search).get('tools');
  // Theme: ?theme= on the link wins, else Admin → Settings → Front of House.
  const urlTheme = new URLSearchParams(location.search).get('theme');
  let theme = 'growpoint';
  function applyTheme(t) {
    t = ['pco-dark', 'pco-light'].includes(t) ? t : 'growpoint';
    document.documentElement.dataset.theme = t;
    if (t === theme) return;
    theme = t;
    // Embedded order of service / mic list follow the same theme.
    for (const f of document.querySelectorAll('.frame iframe')) f.src = withTheme(f.closest('.frame').dataset.src);
  }
  const withTheme = (src) => `${src}&theme=${theme}`;
  let appliedTools = '';
  function applyTools(list) {
    const key = list.join(',');
    if (key === appliedTools) return;
    appliedTools = key;
    const on = new Set(list);
    for (const card of document.querySelectorAll('.tool')) {
      const show = on.has(card.dataset.tool);
      card.classList.toggle('hidden', !show);
      // Embedded dashboard views load only when shown.
      if (card.dataset.src) {
        if (show && !card.querySelector('iframe')) {
          const f = document.createElement('iframe');
          f.src = withTheme(card.dataset.src);
          f.title = card.dataset.tool;
          card.append(f);
        } else if (!show) card.replaceChildren();
      }
    }
    const left = ['level', 'spotify', 'timers', 'recording', 'announcements'].some((t) => on.has(t));
    const right = ['order', 'roster'].some((t) => on.has(t));
    $('main').className = left && right ? '' : left ? 'only-left' : 'only-right';
    $('main').style.visibility = 'visible';
  }

  // ---- Announcements ---------------------------------------------------------------------------
  function renderAnnouncements(a) {
    const box = $('announcements');
    if (!a?.enabled) { box.innerHTML = '<div class="msg">Turn on Announcements in Admin → Settings → Backstage.</div>'; return; }
    if (!a.groups.length) { box.innerHTML = '<div class="msg">No announcements in this plan.</div>'; return; }
    box.replaceChildren(...a.groups.flatMap((g) => {
      const parts = [];
      if (a.groups.length > 1) { const t = document.createElement('div'); t.className = 'ann-title'; t.textContent = g.title; parts.push(t); }
      const ul = document.createElement('ul');
      for (const line of g.lines) { const li = document.createElement('li'); li.textContent = line; ul.append(li); }
      parts.push(ul);
      return parts;
    }));
  }

  // ---- ProPresenter timers --------------------------------------------------------------------
  function renderTimers(pp) {
    const box = $('timers');
    if (!pp?.connected) { box.innerHTML = '<div class="msg">ProPresenter not connected</div>'; return; }
    if (!pp.timers?.length) { box.innerHTML = '<div class="msg">No timers</div>'; return; }
    box.replaceChildren(...pp.timers.map((t) => {
      const neg = String(t.time || '').startsWith('-');
      const [h, m, s] = String(t.time || '0:0:0').replace('-', '').split(':').map(Number);
      const secs = (h * 3600 + m * 60 + s) * (neg ? -1 : 1);
      const txt = (neg ? '-' : '') + (h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`);
      const cls = secs < 0 || /overr/.test(t.state || '') ? 'overrun' : t.state !== 'running' ? 'stopped' : secs <= 60 ? 'warning' : '';
      const row = document.createElement('div');
      row.className = `t-row ${cls}`;
      row.innerHTML = '<span class="t-name"></span><span class="t-time"></span>';
      row.firstChild.textContent = t.name;
      row.lastChild.textContent = txt;
      return row;
    }));
  }

  // ---- HyperDeck / OBS ------------------------------------------------------------------------
  function renderRecording(media) {
    const pills = [];
    const pill = (label, cls, word, tc) => {
      const p = document.createElement('span');
      p.className = `rec ${cls}`;
      p.innerHTML = '<i class="dot"></i><span class="lbl"></span><b></b><span class="tc"></span>';
      p.querySelector('.lbl').textContent = label;
      p.querySelector('b').textContent = word;
      p.querySelector('.tc').textContent = tc || '';
      return p;
    };
    const obsTime = (tc) => (tc ? tc.split('.')[0].replace(/^00:/, '') : '');
    const h = media?.hyperdeck;
    if (h?.enabled) pills.push(!h.connected ? pill('HyperDeck', 'offline', 'Offline') : h.status === 'record' ? pill('HyperDeck', 'on', 'REC', h.timecode) : pill('HyperDeck', '', h.status === 'play' ? 'PLAY' : 'Stopped', h.timecode));
    const o = media?.obs;
    if (o?.enabled) {
      if (!o.connected) pills.push(pill('OBS', 'offline', 'Offline'));
      else {
        pills.push(o.stream?.reconnecting ? pill('Stream', 'warn', 'RECONNECTING', obsTime(o.stream.timecode)) : o.stream?.active ? pill('Stream', 'on', 'LIVE', obsTime(o.stream.timecode)) : pill('Stream', '', 'Off'));
        pills.push(o.record?.paused ? pill('Record', 'warn', 'PAUSED', obsTime(o.record.timecode)) : o.record?.active ? pill('Record', 'on', 'REC', obsTime(o.record.timecode)) : pill('Record', '', 'Off'));
      }
    }
    if (!pills.length) { $('recording').innerHTML = '<div class="msg">HyperDeck and OBS aren’t set up (Admin → Settings → Connections).</div>'; return; }
    $('recording').replaceChildren(...pills);
  }

  // ---- live connection ---------------------------------------------------------------------
  let retry = 1000;
  let pickersLoaded = false;
  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => { retry = 1000; };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'state') {
        if (bootId && msg.payload.bootId !== bootId) location.reload(); // server updated
        bootId = msg.payload.bootId;
        tz = msg.payload.display?.timezone;
        applyTheme(urlTheme || msg.payload.sound?.theme);
        renderAnnouncements(msg.payload.announcements);
        applyTools(urlTools ? urlTools.split(',').map((t) => t.trim()) : msg.payload.sound?.tools || ['level', 'spotify', 'order']);
        const p = msg.payload.plan;
        $('plan-meta').textContent = p ? [p.serviceTypeName, p.dates].filter(Boolean).join(' · ') : '';
      }
      if (msg.type === 'osm') { osm = msg.payload; renderMeter(); }
      if (msg.type === 'propresenter') renderTimers(msg.payload);
      if (msg.type === 'media') renderRecording(msg.payload);
      if (msg.type === 'spotify') {
        sp = msg.payload;
        renderSpotify();
        if (!pickersLoaded && sp.connected && signedIn) { pickersLoaded = true; loadPickers(); }
      }
    };
    ws.onclose = () => { setTimeout(connect, retry); retry = Math.min(retry * 2, 15000); };
    ws.onerror = () => ws.close();
  }

  fetch('/api/auth/status').then((r) => r.json()).then((s) => { signedIn = Boolean(s.signedIn); renderSpotify(); }).catch(() => {});
  renderMeter();
  renderSpotify();
  connect();
})();
