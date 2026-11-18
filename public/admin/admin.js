/* Green Room admin — assignments, device inventory, integrations. */
(() => {
  const $ = (id) => document.getElementById(id);

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked' || k === 'selected' || k === 'disabled') node[k] = Boolean(v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
    return node;
  }

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 5000 : 2000);
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.startsWith('/api/auth')) { showLogin(); throw new Error('Signed out'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ---- auth ------------------------------------------------------------------
  let setupMode = false;
  async function boot() {
    const s = await api('/api/auth/status');
    if (s.signedIn) return startApp();
    showLogin(!s.configured);
  }

  function showLogin(firstRun = setupMode) {
    setupMode = firstRun;
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
    $('login-confirm').classList.toggle('hidden', !firstRun);
    $('login-confirm').required = firstRun;
    $('login-submit').textContent = firstRun ? 'Create password' : 'Sign in';
    $('login-hint').textContent = firstRun ? 'First time here: choose an admin password.' : '';
    $('login-password').focus();
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').textContent = '';
    const password = $('login-password').value;
    try {
      if (setupMode) {
        if (password !== $('login-confirm').value) throw new Error('Passwords do not match');
        await api('/api/auth/setup', { method: 'POST', body: { password } });
      } else {
        await api('/api/auth/login', { method: 'POST', body: { password } });
      }
      $('login-password').value = '';
      $('login-confirm').value = '';
      startApp();
    } catch (err) {
      $('login-error').textContent = err.message;
    }
  });

  $('logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    showLogin(false);
  });

  // ---- tabs --------------------------------------------------------------------
  let currentTab = 'assign';
  const renderers = { assign: renderAssign, devices: renderDevices, live: renderLive, settings: renderSettings };
  $('tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('button')?.dataset.tab;
    if (!tab) return;
    switchTab(tab);
  });
  function switchTab(tab) {
    currentTab = tab;
    clearInterval(livePoll); // the Live tab polls only while it's open
    livePoll = null;
    for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === tab);
    for (const name of Object.keys(renderers)) $(`tab-${name}`).classList.toggle('hidden', name !== tab);
    location.hash = tab;
    renderers[tab]();
  }

  let settings = null;
  // Show times in the church's time zone (Settings → Dashboard display), not the browser's.
  const churchTz = () => {
    const tz = settings?.display?.timezone;
    try { if (tz) new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz || undefined; } catch { return undefined; }
  };
  async function startApp() {
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    settings = await api('/api/admin/settings');
    api('/api/health').then((h) => { $('version').textContent = `v${h.version}`; }).catch(() => {});
    $('demo-note').classList.toggle('hidden', !settings.demo);
    const fromHash = location.hash.slice(1);
    switchTab(renderers[fromHash] ? fromHash : (settings.pco.hasSecret || settings.pco.envCredentials || settings.demo ? 'assign' : 'settings'));
  }

  // ---- Assign tab ------------------------------------------------------------------
  let selectedPlan = null; // { id, serviceTypeId }
  let devices = [];

  async function renderAssign() {
    const root = $('tab-assign');
    root.replaceChildren(el('p', { class: 'muted' }, 'Loading plans…'));
    let plansRes;
    try {
      [plansRes, devices] = await Promise.all([api('/api/admin/plans'), api('/api/admin/devices')]);
    } catch (err) {
      root.replaceChildren(el('div', { class: 'section' }, el('p', { class: 'error' }, err.message)));
      return;
    }
    const { plans, activeId, status } = plansRes;

    if (!plans.length) {
      root.replaceChildren(el('div', { class: 'section' },
        el('h2', {}, 'No upcoming plans'),
        el('p', { class: 'muted' }, status.error || 'Planning Center returned no upcoming plans for the selected service types.'),
        el('button', { class: 'primary', onclick: () => switchTab('settings') }, 'Go to settings')));
      return;
    }

    if (!selectedPlan || !plans.some((p) => p.id === selectedPlan.id)) {
      const p = plans.find((x) => x.id === activeId) || plans[0];
      selectedPlan = { id: p.id, serviceTypeId: p.serviceTypeId };
    }

    const select = el('select', {
      onchange: (e) => {
        const p = plans.find((x) => x.id === e.target.value);
        selectedPlan = { id: p.id, serviceTypeId: p.serviceTypeId };
        loadPlan();
      },
    }, plans.map((p) => el('option', { value: p.id, selected: p.id === selectedPlan.id },
      `${p.dates} — ${p.serviceTypeName}${p.title ? ` — ${p.title}` : p.seriesTitle ? ` — ${p.seriesTitle}` : ''}${p.id === activeId ? '  (on dashboard)' : ''}`)));

    const planBody = el('div', { id: 'plan-body' });
    root.replaceChildren(
      el('div', { class: 'plan-bar' },
        select,
        el('button', { onclick: () => loadPlan(true) }, '↻ Refresh from Planning Center'),
        el('span', { class: 'muted help' }, status.lastSync ? `Last sync ${new Date(status.lastSync).toLocaleTimeString([], { timeZone: churchTz() })}` : ''),
      ),
      planBody,
    );
    loadPlan();

    async function loadPlan(fresh = false) {
      planBody.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
      try {
        const data = await api(`/api/admin/plans/${selectedPlan.serviceTypeId}/${selectedPlan.id}${fresh ? '?fresh=1' : ''}`);
        renderPlan(planBody, data, plans.find((p) => p.id === selectedPlan.id), activeId, () => loadPlan());
        if (fresh) toast('Refreshed from Planning Center');
      } catch (err) {
        planBody.replaceChildren(el('div', { class: 'section' }, el('p', { class: 'error' }, err.message)));
      }
    }
  }

  function avatar(m) {
    const initials = m.name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
    if (!m.photo || !/^https:\/\//.test(m.photo) || /no_photo|default|placeholder/i.test(m.photo)) return el('div', { class: 'mini-avatar' }, initials);
    const img = el('img', { class: 'mini-avatar', src: m.photo, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.onerror = () => img.replaceWith(el('div', { class: 'mini-avatar' }, initials));
    return img;
  }

  function deviceOptions(type, current, usedBy) {
    const list = devices.filter((d) => d.type === type && (d.active || d.id === current));
    return [
      el('option', { value: '' }, '—'),
      ...list.map((d) => {
        const other = usedBy.get(d.id);
        return el('option', { value: d.id, selected: d.id === current }, `${d.name}${d.channel ? ` (ch ${d.channel})` : ''}${other ? `  · in use: ${other}` : ''}`);
      }),
    ];
  }

  function renderPlan(root, data, meta, activeId, reload) {
    const { plan, teams, conflicts } = data;
    const conflictIds = new Set(conflicts.map((c) => c.deviceId));

    // device -> who has it (for the "in use" hint)
    const usage = new Map();
    for (const t of teams) for (const m of t.members) for (const f of ['mic', 'iem']) if (m[f]) usage.set(m[f].id, m.name);

    const header = el('div', { class: 'section' },
      el('div', { class: 'row' },
        el('h2', { style: 'margin:0' }, `${plan.dates}${plan.title ? ` · ${plan.title}` : ''}`),
        plan.id === activeId ? el('span', { class: 'badge live' }, 'Showing on dashboard') : el('span', { class: 'badge' }, 'Not on dashboard'),
        el('a', { href: plan.url, target: '_blank', rel: 'noopener' }, 'Open in Planning Center ↗'),
      ),
      el('p', { class: 'help' }, 'Assignments save instantly and appear on the dashboard within a second. Only people with a mic or IEM show on the dashboard. Picking a mic also picks its linked IEM; you can still change the IEM on its own. Each person\'s choice is remembered and pre-fills future plans (marked “auto”).'),
      meta?.times?.length ? el('p', { class: 'help' }, meta.times.map((t) => `${t.name || (t.type === 'service' ? 'Service' : t.type)} ${new Date(t.startsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: churchTz() })}`).join(' · ')) : null,
    );

    const conflictBox = conflicts.length ? el('div', { class: 'section conflicts' },
      el('h2', {}, 'Conflicts'),
      el('ul', {}, conflicts.map((c) => el('li', {}, `${c.deviceName} is assigned to ${c.people.join(' and ')}`)))) : null;

    const blocks = teams.map((team) => {
      const rows = team.members.map((m) => {
        const cell = (field) => {
          const current = m[field]?.id || '';
          const others = new Map([...usage].filter(([id, name]) => name !== m.name && id));
          const sel = el('select', {
            onchange: async (e) => {
              try {
                const r = await api(`/api/admin/plans/${plan.id}/assignments/${encodeURIComponent(m.key)}`, { method: 'PUT', body: { field, deviceId: e.target.value || null } });
                const other = field === 'mic' ? 'iem' : 'mic';
                if (other in (r.changes || {})) {
                  const d = devices.find((x) => x.id === r.changes[other]);
                  toast(`Saved ${m.name} · linked ${other.toUpperCase()} ${d ? `→ ${d.name}` : 'cleared'}`);
                } else toast(`Saved ${m.name}`);
                reload();
              } catch (err) { toast(err.message, true); }
            },
          }, deviceOptions(field, current, others));
          return el('td', { class: current && conflictIds.has(current) ? 'conflict' : '' },
            sel,
            m[field]?.source === 'default' ? el('div', { class: 'source-default' }, 'auto (remembered)') : null);
        };
        return el('tr', {},
          el('td', { class: 'person-cell' + (m.mic || m.iem ? '' : ' unassigned') },
            avatar(m),
            el('div', {},
            el('div', { class: 'person-name' }, m.name, m.status === 'U' ? el('span', { class: 'status-U' }, '  unconfirmed') : null),
            el('div', { class: 'help' }, m.positions.join(', ')),
            m.arrivedAt ? el('div', { class: 'arrived-note' }, `✓ Arrived ${new Date(m.arrivedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: churchTz() })}`) : null),
            m.extra ? el('button', {
              class: 'small danger',
              onclick: async () => { await api(`/api/admin/plans/${plan.id}/extras/${encodeURIComponent(m.key)}`, { method: 'DELETE' }); reload(); },
            }, 'Remove') : null),
          cell('mic'),
          cell('iem'));
      });
      return el('div', { class: 'section team-block' + (team.inFilter ? '' : ' dim') },
        el('div', { class: 'team-head' }, el('h3', {}, team.name), team.inFilter ? null : el('span', { class: 'badge' }, 'hidden on dashboard')),
        el('div', { class: 'table-wrap' }, el('table', { class: 'assign-table' },
          el('thead', {}, el('tr', {}, el('th', { style: 'width:40%' }, 'Person'), el('th', {}, 'Mic'), el('th', {}, 'IEM'))),
          el('tbody', {}, rows))));
    });

    const guestName = el('input', { placeholder: 'Name (e.g. Guest Speaker)' });
    const guestRole = el('input', { placeholder: 'Role' });
    const guests = el('div', { class: 'section' },
      el('h2', {}, 'Add someone not in Planning Center'),
      el('form', {
        class: 'row',
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await api(`/api/admin/plans/${plan.id}/extras`, { method: 'POST', body: { name: guestName.value, role: guestRole.value } });
            reload();
          } catch (err) { toast(err.message, true); }
        },
      }, guestName, guestRole, el('button', { class: 'primary', type: 'submit' }, 'Add')),
    );

    const reset = el('div', { class: 'row' },
      el('button', {
        class: 'danger',
        onclick: async () => {
          if (!confirm('Clear this plan\'s manual changes and go back to everyone\'s remembered defaults?')) return;
          await api(`/api/admin/plans/${plan.id}/reset`, { method: 'POST' });
          reload();
        },
      }, 'Reset this plan to defaults'));

    if (!devices.length) {
      root.replaceChildren(header, el('div', { class: 'section' },
        el('p', {}, 'You have no microphones or IEMs yet.'),
        el('button', { class: 'primary', onclick: () => switchTab('devices') }, 'Add devices')));
      return;
    }
    root.replaceChildren(header, conflictBox || '', ...blocks, guests, timingReport(data, reload), reset);
  }

  // Planned vs actual item times for each service time (recorded from ProPresenter).
  function timingReport(data, reload) {
    const services = (data.plan.times || []).filter((t) => t.type === 'service');
    const fmt = (secs) => {
      if (!secs) return '';
      secs = Math.round(secs);
      const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
      return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
    };
    const label = (t) => new Date(t.startsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: churchTz() });
    const section = el('div', { class: 'section' },
      el('h2', {}, 'Service timing'),
      el('p', { class: 'help' }, 'Actual time spent on each item, recorded automatically while an item is live in ProPresenter during each service time (never during rehearsals).'));
    if (!services.length) { section.append(el('p', { class: 'muted' }, 'This plan has no service times in Planning Center.')); return section; }
    const items = data.items.filter((i) => i.type !== 'header');
    const totals = services.map((t) => Object.values(data.live[t.id]?.items || {}).reduce((a, b) => a + b, 0));
    section.append(el('div', { class: 'table-wrap' }, el('table', { class: 'timing-table' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Item'), el('th', {}, 'Planned'),
        services.map((t) => el('th', {}, label(t), data.live[t.id] ? el('button', {
          class: 'small ghost danger',
          title: 'Clear recorded times for this service',
          onclick: async () => {
            if (!confirm(`Clear the recorded times for the ${label(t)} service?`)) return;
            await api(`/api/admin/plans/${data.plan.id}/live/${t.id}`, { method: 'DELETE' });
            reload();
          },
        }, 'Clear') : null)))),
      el('tbody', {},
        items.map((i) => el('tr', {},
          el('td', {}, i.title),
          el('td', { class: 'num' }, fmt(i.length)),
          services.map((t) => {
            const secs = data.live[t.id]?.items?.[i.id];
            const isLive = data.liveCurrent?.planTimeId === t.id && data.liveCurrent.itemId === i.id;
            return el('td', { class: 'num' + (secs && i.length && secs > i.length ? ' over' : '') }, fmt(secs), isLive ? el('span', { class: 'badge live' }, 'LIVE') : null);
          }))),
        el('tr', { class: 'total' },
          el('td', {}, 'Total'),
          el('td', { class: 'num' }, fmt(items.filter((i) => i.position === 'during').reduce((a, i) => a + (i.length || 0), 0))),
          totals.map((secs) => el('td', { class: 'num' }, fmt(secs))))))));
    return section;
  }

  // ---- Live tab ----------------------------------------------------------------------
  // Shows what ProPresenter has on screen, which plan item that matched, and the item
  // timing as it happens. Production test mode records outside service times so the
  // team can click through ProPresenter and check that timings work.
  let livePoll = null;
  const fmtDur = (secs) => {
    secs = Math.max(0, Math.round(secs || 0));
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };
  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: churchTz() });

  async function renderLive() {
    const root = $('tab-live');
    const minutesSel = el('select', {}, [[30, '30 minutes'], [60, '1 hour'], [120, '2 hours']].map(([v, t]) => el('option', { value: v, selected: v === 60 }, t)));
    const statusBox = el('div');
    const tableBox = el('div');
    const controls = el('div', { class: 'row' });
    root.replaceChildren(
      el('div', { class: 'section' },
        el('h2', {}, 'Production test'),
        el('p', { class: 'help' }, 'Click through ProPresenter and watch item times update here and on the dashboard, any time — not just during a service. Test times are saved separately and never mix with real service times. The dashboard shows a “TEST MODE” badge while it’s on, and it turns itself off when the time runs out. During a real service time, real recording always takes priority.'),
        controls),
      el('div', { class: 'section' }, el('h2', {}, 'Right now'), statusBox),
      el('div', { class: 'section' }, el('h2', {}, 'Item times'), tableBox));

    let busy = false;
    async function refresh() {
      if (busy) return;
      busy = true;
      try {
        const d = await api('/api/admin/live');
        draw(d);
      } catch (err) {
        statusBox.replaceChildren(el('p', { class: 'error' }, err.message));
      } finally { busy = false; }
    }

    function draw(d) {
      const testOn = Boolean(d.test && d.test.until > d.now);
      const realWindow = d.window && !d.window.test;

      // Controls
      controls.replaceChildren(
        testOn
          ? el('span', { class: 'badge test' }, `TEST MODE · on until ${clock(d.test.until)}`)
          : el('span', { class: 'badge' }, 'Test mode off'),
        testOn
          ? el('button', { class: 'danger', onclick: async () => { await api('/api/admin/live/test', { method: 'DELETE' }); toast('Test mode off'); refresh(); } }, 'Stop test')
          : el('span', { class: 'row' }, minutesSel, el('button', {
            class: 'primary',
            disabled: !d.plan,
            onclick: async () => {
              await api('/api/admin/live/test', { method: 'POST', body: { minutes: Number(minutesSel.value) } });
              toast('Test mode on — click through ProPresenter');
              refresh();
            },
          }, 'Start production test')),
        d.testRecorded ? el('button', {
          class: 'ghost danger',
          onclick: async () => {
            if (!confirm('Clear all test times for this plan?')) return;
            await api(`/api/admin/plans/${d.plan.id}/live/test`, { method: 'DELETE' });
            toast('Test times cleared');
            refresh();
          },
        }, 'Clear test times') : null);

      // Status
      const matched = d.items.find((i) => i.id === d.matchedItemId);
      const ppLine = !d.propresenter.enabled
        ? el('span', { class: 'error' }, 'ProPresenter is not turned on in Settings.')
        : d.propresenter.connected
          ? el('span', { class: 'ok-text' }, '● Connected')
          : el('span', { class: 'error' }, `● Not connected${d.propresenter.error ? ` — ${d.propresenter.error}` : ''}`);
      const mode = realWindow
        ? `Recording the ${clock(d.window.start)} service`
        : testOn ? 'Recording test times' : 'Not recording (outside service times — start a production test to try it)';
      statusBox.replaceChildren(el('dl', { class: 'facts' },
        el('dt', {}, 'Plan on dashboard'), el('dd', {}, d.plan ? `${d.plan.dates} · ${d.plan.serviceTypeName || ''}` : 'None'),
        el('dt', {}, 'ProPresenter'), el('dd', {}, ppLine),
        el('dt', {}, 'On screen now'), el('dd', {}, d.propresenter.activePresentation || el('span', { class: 'muted' }, 'Nothing')),
        el('dt', {}, 'Matched item'), el('dd', {},
          matched ? el('strong', {}, matched.title)
            : d.propresenter.activePresentation ? el('span', { class: 'warn-text' }, 'No match — rename the presentation (or the plan item) so the titles agree')
              : el('span', { class: 'muted' }, '—')),
        el('dt', {}, 'Timing'), el('dd', {}, mode)));

      // Item times for whatever is being shown (test, current service, or last service)
      const sum = d.summary;
      const label = !sum?.planTimeId ? null : sum.test ? 'Test' : clock(sum.startsAt);
      const running = (id) => (sum?.recording && sum.currentItemId === id ? (d.now - sum.currentStartedAt) / 1000 : 0);
      tableBox.replaceChildren(!d.items.length ? el('p', { class: 'muted' }, 'No plan loaded.') : el('div', { class: 'table-wrap' }, el('table', { class: 'timing-table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Item'), el('th', {}, 'Planned'), el('th', {}, label ? `Actual (${label})` : 'Actual'))),
        el('tbody', {}, d.items.filter((i) => i.type !== 'header').map((i) => {
          const secs = (sum?.actuals?.[i.id] || 0) + running(i.id);
          const isLive = sum?.recording && sum.currentItemId === i.id;
          return el('tr', { class: isLive ? 'live-row' : '' },
            el('td', {}, i.title, isLive ? el('span', { class: 'badge ' + (sum.test ? 'test' : 'live') }, sum.test ? 'TEST' : 'LIVE') : null),
            el('td', { class: 'num' }, i.length ? fmtDur(i.length) : ''),
            el('td', { class: 'num' + (i.length && secs > i.length ? ' over' : '') }, secs ? fmtDur(secs) : ''));
        })))));
    }

    await refresh();
    livePoll = setInterval(refresh, 1000);
  }

  // ---- Devices tab -------------------------------------------------------------------
  async function renderDevices() {
    const root = $('tab-devices');
    devices = await api('/api/admin/devices');

    const saveTimers = new Map();
    const save = (d, patch) => {
      Object.assign(d, patch);
      clearTimeout(saveTimers.get(d.id));
      saveTimers.set(d.id, setTimeout(async () => {
        try { await api(`/api/admin/devices/${d.id}`, { method: 'PUT', body: d }); toast('Saved'); } catch (err) { toast(err.message, true); }
      }, 400));
    };
    const move = async (d, dir) => {
      const i = devices.indexOf(d);
      const j = i + dir;
      if (j < 0 || j >= devices.length) return;
      [devices[i], devices[j]] = [devices[j], devices[i]];
      await api('/api/admin/devices-order', { method: 'PUT', body: { ids: devices.map((x) => x.id) } });
      renderDevices();
    };

    const linkSelect = (d) => {
      const partners = devices.filter((x) => x.type !== d.type);
      return el('select', {
        onchange: async (e) => {
          try {
            await api(`/api/admin/devices/${d.id}/link`, { method: 'PUT', body: { linkedId: e.target.value || null } });
            toast('Link saved');
            renderDevices();
          } catch (err) { toast(err.message, true); }
        },
      }, el('option', { value: '' }, '— none —'), partners.map((p) => el('option', { value: p.id, selected: p.id === d.linkedId }, p.name)));
    };

    const table = (type, label) => {
      const list = devices.filter((d) => d.type === type);
      return el('div', { class: 'section' },
        el('div', { class: 'row', style: 'justify-content:space-between' },
          el('h2', { style: 'margin:0' }, `${label} (${list.length})`),
          el('button', {
            class: 'primary',
            onclick: async () => {
              const n = list.length + 1;
              await api('/api/admin/devices', { method: 'POST', body: { type, name: type === 'mic' ? `Mic ${n}` : `IEM ${n}`, channel: String(n) } });
              renderDevices();
            },
          }, `+ Add ${type === 'mic' ? 'mic' : 'IEM'}`)),
        list.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'devices-table' },
          el('thead', {}, el('tr', {}, ['', 'Name', 'Channel', 'Frequency', 'Type / model', type === 'mic' ? 'Linked IEM' : 'Linked mic', 'Notes', 'Active', ''].map((h) => el('th', {}, h)))),
          el('tbody', {}, list.map((d) => el('tr', {},
            el('td', { style: 'white-space:nowrap' },
              el('button', { class: 'small ghost', title: 'Move up', onclick: () => move(d, -1) }, '↑'),
              el('button', { class: 'small ghost', title: 'Move down', onclick: () => move(d, 1) }, '↓')),
            el('td', {}, el('input', { value: d.name, oninput: (e) => save(d, { name: e.target.value }) })),
            el('td', { style: 'width:6rem' }, el('input', { value: d.channel, oninput: (e) => save(d, { channel: e.target.value }) })),
            el('td', {}, el('input', { value: d.frequency, placeholder: 'e.g. 518.250 MHz', oninput: (e) => save(d, { frequency: e.target.value }) })),
            el('td', {}, el('input', { value: d.kind, placeholder: type === 'mic' ? 'Handheld / Headset' : 'Pack / Wired', oninput: (e) => save(d, { kind: e.target.value }) })),
            el('td', {}, linkSelect(d)),
            el('td', {}, el('input', { value: d.notes, oninput: (e) => save(d, { notes: e.target.value }) })),
            el('td', {}, el('input', { type: 'checkbox', checked: d.active, onchange: (e) => save(d, { active: e.target.checked }) })),
            el('td', {}, el('button', {
              class: 'small danger',
              onclick: async () => {
                if (!confirm(`Delete ${d.name}? It will be unassigned everywhere.`)) return;
                await api(`/api/admin/devices/${d.id}`, { method: 'DELETE' });
                renderDevices();
              },
            }, 'Delete')),
          ))))) : el('p', { class: 'muted' }, 'None yet.'));
    };

    root.replaceChildren(
      el('div', { class: 'section' },
        el('h2', {}, 'Mic ↔ IEM links'),
        el('p', { class: 'help' }, 'Linked devices are assigned together: picking a mic for someone also gives them its IEM. You can still change the IEM per person, and picking just an IEM never adds a mic. Set links in the tables below, or pair them up by list order:'),
        el('button', {
          onclick: async () => {
            if (!confirm('Replace all links, pairing the 1st mic with the 1st IEM, 2nd with 2nd, and so on?')) return;
            const r = await api('/api/admin/devices/auto-link', { method: 'POST' });
            toast(`Linked ${r.linked} pairs`);
            renderDevices();
          },
        }, 'Pair mics and IEMs by list order')),
      el('p', { class: 'help' }, 'Your wireless inventory. Untick “Active” for gear that is out for repair.'),
      table('mic', 'Microphones'),
      table('iem', 'In-ear monitors'),
    );
  }

  // ---- Settings tab -------------------------------------------------------------------
  async function renderSettings() {
    const root = $('tab-settings');
    settings = await api('/api/admin/settings');
    const s = structuredClone(settings);

    const field = (label, input, help) => el('label', { class: 'field' }, el('span', {}, label), input, help ? el('div', { class: 'help' }, help) : null);
    const check = (label, obj, key) => el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: obj[key], onchange: (e) => { obj[key] = e.target.checked; } }), label);

    async function saveSection(section) {
      try {
        await api('/api/admin/settings', { method: 'PUT', body: { [section]: s[section] } });
        toast('Settings saved');
        settings = await api('/api/admin/settings');
      } catch (err) { toast(err.message, true); }
    }

    // Planning Center ---------------------------------------------------------------
    const appId = el('input', { value: s.pco.appId, placeholder: 'Application ID', autocomplete: 'off', oninput: (e) => { s.pco.appId = e.target.value.trim(); } });
    const secret = el('input', { type: 'password', value: s.pco.secret, placeholder: 'Secret', autocomplete: 'new-password', oninput: (e) => { s.pco.secret = e.target.value.trim(); } });
    const pcoResult = el('span', { class: 'help' });
    const stBox = el('div', { class: 'checklist' }, el('span', { class: 'muted' }, 'Connect to load service types…'));
    const teamBox = el('div', {}, el('span', { class: 'muted' }, 'Pick service types to load teams…'));
    const planSel = el('select', { onchange: (e) => { s.pco.planSelection = e.target.value; s.pco.pinnedServiceTypeId = e.target.selectedOptions[0]?.dataset.st || null; } });

    async function loadServiceTypes() {
      try {
        const types = await api('/api/admin/pco/service-types');
        stBox.replaceChildren(...types.map((t) => el('label', { class: 'check' },
          el('input', {
            type: 'checkbox',
            checked: s.pco.serviceTypeIds.includes(t.id),
            onchange: (e) => {
              s.pco.serviceTypeIds = e.target.checked ? [...s.pco.serviceTypeIds, t.id] : s.pco.serviceTypeIds.filter((x) => x !== t.id);
              loadTeams();
            },
          }), t.name)));
        loadTeams();
      } catch (err) {
        stBox.replaceChildren(el('span', { class: 'error' }, err.message));
      }
    }

    async function loadTeams() {
      if (!s.pco.serviceTypeIds.length) { teamBox.replaceChildren(el('span', { class: 'muted' }, 'Pick service types to load teams…')); return; }
      try {
        const teams = await api(`/api/admin/pco/teams?serviceTypeIds=${s.pco.serviceTypeIds.join(',')}`);
        const byId = new Map(teams.map((t) => [t.id, t]));
        s.pco.teamIds = s.pco.teamIds.filter((id) => byId.has(id));
        const draw = () => {
          const chosen = s.pco.teamIds.map((id) => byId.get(id));
          const rest = teams.filter((t) => !s.pco.teamIds.includes(t.id));
          teamBox.replaceChildren(
            el('div', { class: 'help' }, 'Ticked teams appear on the dashboard in this order. Leave all unticked to show every team.'),
            ...chosen.map((t, i) => el('div', { class: 'check' },
              el('input', { type: 'checkbox', checked: true, onchange: () => { s.pco.teamIds = s.pco.teamIds.filter((x) => x !== t.id); draw(); } }),
              el('span', { style: 'flex:1' }, t.name),
              el('button', { class: 'small ghost', disabled: i === 0, onclick: () => { const a = s.pco.teamIds; [a[i - 1], a[i]] = [a[i], a[i - 1]]; draw(); } }, '↑'),
              el('button', { class: 'small ghost', disabled: i === chosen.length - 1, onclick: () => { const a = s.pco.teamIds; [a[i + 1], a[i]] = [a[i], a[i + 1]]; draw(); } }, '↓'))),
            ...rest.map((t) => el('label', { class: 'check' },
              el('input', { type: 'checkbox', onchange: () => { s.pco.teamIds = [...s.pco.teamIds, t.id]; draw(); } }), t.name)),
          );
        };
        draw();
      } catch (err) {
        teamBox.replaceChildren(el('span', { class: 'error' }, err.message));
      }
    }

    // Leader column: pick from the item-note columns actually used in the current plan.
    const leaderBox = el('div', {}, el('span', { class: 'muted' }, 'Loading columns from Planning Center…'));
    async function loadLeaderColumns() {
      const chosen = () => String(s.pco.leaderNoteCategories || '').split(',').map((x) => x.trim()).filter(Boolean);
      const setChosen = (list) => { s.pco.leaderNoteCategories = list.join(', '); };
      let data = { categories: [] };
      try { data = await api('/api/admin/pco/note-categories'); } catch { /* fall back to manual entry */ }
      const names = new Set(data.categories.map((c) => c.name));
      const manual = el('input', {
        value: chosen().filter((c) => !names.has(c)).join(', '),
        placeholder: 'Other column name(s), comma-separated',
        oninput: (e) => setChosen([...chosen().filter((c) => names.has(c)), ...e.target.value.split(',').map((x) => x.trim()).filter(Boolean)]),
      });
      leaderBox.replaceChildren(
        el('p', { class: 'help' }, `Which Planning Center item-note column holds who leads each item. These are the columns used in the current plan${data.plan ? ` (${data.plan})` : ''}:`),
        data.categories.length
          ? el('div', {}, data.categories.map((c) => el('label', { class: 'check', style: 'align-items:flex-start' },
            el('input', {
              type: 'checkbox',
              checked: chosen().includes(c.name),
              onchange: (e) => setChosen(e.target.checked ? [...chosen(), c.name] : chosen().filter((x) => x !== c.name)),
            }),
            el('span', {}, el('strong', {}, c.name), el('span', { class: 'help' }, ` — ${c.count} item(s), e.g. ${c.examples.join(' · ')}`)))))
          : el('p', { class: 'muted' }, 'No item notes found in the current plan.'),
        field('Not listed? Type the column name', manual));
    }

    async function loadPlanChoices() {
      const { plans } = await api('/api/admin/plans').catch(() => ({ plans: [] }));
      planSel.replaceChildren(
        el('option', { value: 'auto', selected: s.pco.planSelection === 'auto' }, 'Automatic — next/current plan'),
        ...plans.map((p) => el('option', { value: p.id, 'data-st': p.serviceTypeId, selected: s.pco.planSelection === p.id }, `Pin: ${p.dates} — ${p.serviceTypeName}`)),
      );
    }

    const pcoSection = el('div', { class: 'section' },
      el('h2', {}, 'Planning Center'),
      s.pco.envCredentials ? el('p', { class: 'help' }, 'Credentials are provided by the server environment (PCO_APP_ID / PCO_SECRET).') : el('div', {},
        el('p', { class: 'help' }, 'Create a Personal Access Token at ', el('a', { href: 'https://api.planningcenteronline.com/oauth/applications', target: '_blank', rel: 'noopener' }, 'api.planningcenteronline.com/oauth/applications'), ' (signed in as someone with Services access), then paste the Application ID and Secret here.'),
        el('div', { class: 'grid2' }, field('Application ID', appId), field('Secret', secret))),
      el('div', { class: 'row', style: 'margin-top:0.7rem' },
        el('button', {
          onclick: async () => {
            pcoResult.textContent = 'Testing…';
            try {
              const r = await api('/api/admin/pco/test', { method: 'POST', body: { appId: s.pco.appId, secret: s.pco.secret } });
              pcoResult.textContent = `✓ Connected to ${r.organization}`;
              pcoResult.className = 'help ok-text';
              await api('/api/admin/settings', { method: 'PUT', body: { pco: { appId: s.pco.appId, secret: s.pco.secret } } });
              loadServiceTypes();
            } catch (err) {
              pcoResult.textContent = err.message;
              pcoResult.className = 'help error';
            }
          },
        }, 'Test & connect'),
        pcoResult),
      el('h3', {}, 'Service types to pull plans from'), stBox,
      el('h3', {}, 'Teams on the dashboard'), teamBox,
      el('h3', {}, 'Which plan is shown'),
      el('div', { class: 'grid2' },
        field('Plan', planSel, 'Automatic switches to the next plan two hours after the last service ends.'),
        field('Refresh every (seconds)', el('input', { type: 'number', min: 20, value: s.pco.pollSeconds, oninput: (e) => { s.pco.pollSeconds = Number(e.target.value); } }))),
      check('Hide people who declined', s.pco, 'hideDeclined'),
      el('h3', {}, 'Leader column'),
      leaderBox,
      el('div', { class: 'row', style: 'margin-top:0.8rem' }, el('button', { class: 'primary', onclick: () => saveSection('pco') }, 'Save Planning Center settings')),
    );

    // ProPresenter -------------------------------------------------------------------
    const ppResult = el('div', { class: 'help' });
    const timerBox = el('div', {});
    const drawTimers = (timers) => {
      if (!timers?.length) { timerBox.replaceChildren(); return; }
      timerBox.replaceChildren(
        el('h3', {}, 'Timers to show'),
        el('div', { class: 'help' }, 'Leave all unticked to show every timer.'),
        el('div', { class: 'checklist' }, timers.map((t) => el('label', { class: 'check' },
          el('input', {
            type: 'checkbox',
            checked: s.propresenter.timerIds.includes(t.id),
            onchange: (e) => { s.propresenter.timerIds = e.target.checked ? [...s.propresenter.timerIds, t.id] : s.propresenter.timerIds.filter((x) => x !== t.id); },
          }), `${t.name}  (${t.time})`))));
    };
    const ppSection = el('div', { class: 'section' },
      el('h2', {}, 'ProPresenter'),
      el('p', { class: 'help' }, 'In ProPresenter 7 open Settings → Network, tick “Enable Network”, and note the IP address and port shown there. This server must be on the same network.'),
      check('Connect to ProPresenter', s.propresenter, 'enabled'),
      el('div', { class: 'grid2' },
        field('Host / IP address', el('input', { value: s.propresenter.host, placeholder: '192.168.1.50', oninput: (e) => { s.propresenter.host = e.target.value.trim(); } })),
        field('Port', el('input', { type: 'number', value: s.propresenter.port, oninput: (e) => { s.propresenter.port = Number(e.target.value); } }))),
      check('Highlight the item that is live in ProPresenter (matched by presentation name to the Planning Center item title)', s.propresenter, 'showActiveItem'),
      el('div', { class: 'row', style: 'margin-top:0.6rem' },
        el('button', {
          onclick: async () => {
            ppResult.textContent = 'Testing…';
            ppResult.className = 'help';
            try {
              const r = await api('/api/admin/propresenter/test', { method: 'POST', body: { host: s.propresenter.host, port: s.propresenter.port } });
              ppResult.textContent = `✓ Connected${r.version?.name ? ` to ${r.version.name}` : ''}${r.version?.host_description ? ` (${r.version.host_description})` : ''} — ${r.timers.length} timer(s) found`;
              ppResult.className = 'help ok-text';
              drawTimers(r.timers);
            } catch (err) {
              ppResult.textContent = err.message;
              ppResult.className = 'help error';
            }
          },
        }, 'Test connection'),
        el('button', { class: 'primary', onclick: () => saveSection('propresenter') }, 'Save ProPresenter settings')),
      ppResult,
      timerBox,
    );

    // Display ---------------------------------------------------------------------------
    const origin = location.origin;
    const logoImg = el('img', { class: 'logo-preview', alt: 'Logo', src: `/branding/logo?v=${Date.now()}` });
    const logoInput = el('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/webp,image/svg+xml',
      class: 'hidden',
      onchange: async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const dataUrl = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = reject;
          r.readAsDataURL(file);
        });
        try {
          await api('/api/admin/logo', { method: 'POST', body: { dataUrl } });
          logoImg.src = `/branding/logo?v=${Date.now()}`;
          toast('Logo updated');
        } catch (err) { toast(err.message, true); }
        e.target.value = '';
      },
    });
    const logoBox = el('div', { class: 'logo-box' },
      el('div', { class: 'logo-stage' }, logoImg),
      el('div', {},
        el('div', { class: 'row' },
          el('button', { onclick: () => logoInput.click() }, 'Upload logo…'),
          el('button', {
            class: 'ghost',
            onclick: async () => {
              await api('/api/admin/logo', { method: 'DELETE' });
              logoImg.src = `/branding/logo?v=${Date.now()}`;
              toast('Using the default GrowPoint logo');
            },
          }, 'Reset to GrowPoint logo')),
        el('div', { class: 'help' }, 'The dashboard is dark, so use a white or light logo on a transparent background (PNG or SVG).'),
        logoInput));
    const displaySection = el('div', { class: 'section' },
      el('h2', {}, 'Dashboard display'),
      el('p', { class: 'help' }, 'The header greets the room with “Good Morning”, “Good Afternoon” or “Good Evening” based on the time zone below.'),
      logoBox,
      check('Show the logo', s.display, 'showLogo'),
      el('div', { class: 'grid2' },
        field('Time zone', el('input', { value: s.display.timezone, oninput: (e) => { s.display.timezone = e.target.value.trim(); } }), 'IANA name, e.g. America/New_York'),
        field('Full page reload every (hours)', el('input', { type: 'number', min: 0, value: s.display.reloadHours, oninput: (e) => { s.display.reloadHours = Number(e.target.value); } }), '0 = never. Live updates happen instantly regardless.')),
      check('Show ProPresenter timers', s.display, 'showTimers'),
      check('Show order of service', s.display, 'showOrderOfService'),
      check('Show countdown to the next service time', s.display, 'showServiceCountdown'),
      el('div', { class: 'grid2' },
        field('Show item descriptions from Planning Center', el('select', { onchange: (e) => { s.display.itemDescriptions = e.target.value; } },
          [['announcements', 'Announcements only'], ['all', 'All items'], ['none', 'None']].map(([v, t]) => el('option', { value: v, selected: (s.display.itemDescriptions || 'announcements') === v }, t))),
          '“Announcements only” shows the description on items with “announcement” in the title.')),
      el('div', { class: 'row', style: 'margin-top:0.6rem' }, el('button', { class: 'primary', onclick: () => saveSection('display') }, 'Save display settings')),
      el('h3', {}, 'Dashboard links'),
      el('ul', { class: 'help' },
        el('li', {}, el('code', {}, `${origin}/dashboard/`), ' — everything'),
        el('li', {}, el('code', {}, `${origin}/dashboard/?layout=timers`), ' — big timers only (stage/greenroom clock)'),
        el('li', {}, el('code', {}, `${origin}/dashboard/?layout=roster`), ' — mic/IEM list only'),
        el('li', {}, el('code', {}, `${origin}/dashboard/?teams=Worship Team`), ' — only certain teams (comma-separated)'),
        el('li', {}, 'Add ', el('code', {}, '&scale=1.3'), ' to make text larger on a distant TV.')),
    );

    // Password -----------------------------------------------------------------------------
    const cur = el('input', { type: 'password', autocomplete: 'current-password' });
    const next = el('input', { type: 'password', autocomplete: 'new-password' });
    const pwSection = el('div', { class: 'section' },
      el('h2', {}, 'Admin password'),
      el('div', { class: 'grid2' }, field('Current password', cur), field('New password', next)),
      el('div', { class: 'row', style: 'margin-top:0.6rem' }, el('button', {
        onclick: async () => {
          try { await api('/api/admin/password', { method: 'POST', body: { current: cur.value, next: next.value } }); toast('Password changed'); cur.value = ''; next.value = ''; } catch (err) { toast(err.message, true); }
        },
      }, 'Change password')));

    // HyperDeck & OBS ------------------------------------------------------------------
    const testButton = (url, body, resultEl, describe) => el('button', {
      onclick: async () => {
        resultEl.textContent = 'Testing…';
        resultEl.className = 'help';
        try {
          const r = await api(url, { method: 'POST', body: body() });
          resultEl.textContent = describe(r);
          resultEl.className = 'help ok-text';
        } catch (err) {
          resultEl.textContent = err.message;
          resultEl.className = 'help error';
        }
      },
    }, 'Test connection');

    const hdResult = el('div', { class: 'help' });
    const hdSection = el('div', { class: 'section' },
      el('h2', {}, 'HyperDeck'),
      el('p', { class: 'help' }, 'Shows the HyperDeck’s record status and timecode along the bottom of the dashboard. On the HyperDeck, make sure Ethernet/remote control is enabled and note its IP address (shown on its front-panel Setup menu or in Blackmagic HyperDeck Setup).'),
      check('Connect to HyperDeck', s.hyperdeck, 'enabled'),
      el('div', { class: 'grid2' },
        field('IP address', el('input', { value: s.hyperdeck.host, placeholder: '192.168.1.60', oninput: (e) => { s.hyperdeck.host = e.target.value.trim(); } })),
        field('Port', el('input', { type: 'number', value: s.hyperdeck.port, oninput: (e) => { s.hyperdeck.port = Number(e.target.value); } }), 'Normally 9993')),
      el('div', { class: 'row', style: 'margin-top:0.6rem' },
        testButton('/api/admin/hyperdeck/test', () => ({ host: s.hyperdeck.host, port: s.hyperdeck.port }), hdResult,
          (r) => `✓ Connected to ${r.model}${r.status ? ` — ${r.status}` : ''}${r.timecode ? ` at ${r.timecode}` : ''}`),
        el('button', { class: 'primary', onclick: () => saveSection('hyperdeck') }, 'Save HyperDeck settings')),
      hdResult);

    const obsResult = el('div', { class: 'help' });
    const obsSection = el('div', { class: 'section' },
      el('h2', {}, 'OBS'),
      el('p', { class: 'help' }, 'Shows OBS stream and recording time along the bottom of the dashboard. In OBS open Tools → WebSocket Server Settings, tick “Enable WebSocket server”, and use “Show Connect Info” for the IP, port and password.'),
      check('Connect to OBS', s.obs, 'enabled'),
      el('div', { class: 'grid2' },
        field('IP address', el('input', { value: s.obs.host, placeholder: '192.168.1.70', oninput: (e) => { s.obs.host = e.target.value.trim(); } })),
        field('Port', el('input', { type: 'number', value: s.obs.port, oninput: (e) => { s.obs.port = Number(e.target.value); } }), 'Normally 4455'),
        field('Password', el('input', { type: 'password', value: s.obs.password, autocomplete: 'new-password', placeholder: 'Leave blank if authentication is off', oninput: (e) => { s.obs.password = e.target.value; } }))),
      el('div', { class: 'row', style: 'margin-top:0.6rem' },
        testButton('/api/admin/obs/test', () => ({ host: s.obs.host, port: s.obs.port, password: s.obs.password }), obsResult,
          (r) => `✓ Connected${r.obsVersion ? ` to OBS ${r.obsVersion}` : ''}`),
        el('button', { class: 'primary', onclick: () => saveSection('obs') }, 'Save OBS settings')),
      obsResult);

    // UniFi Access ----------------------------------------------------------------------
    const unifiResult = el('div', { class: 'help' });
    const unifiSection = el('div', { class: 'section' },
      el('h2', {}, 'UniFi Access (arrivals)'),
      el('p', { class: 'help' }, 'Shows a green “Arrived” next to people on the dashboard once they badge in today. People are matched by name, so their UniFi Access name needs to match their Planning Center name (nicknames like Mackenzie “Kenzie” Smith also match “Kenzie Smith”).'),
      el('p', { class: 'help' }, 'Create the token in UniFi Access → Settings → General → Advanced → API Token, with permission to view system logs. The console must be reachable from the NAS on port 12445.'),
      check('Connect to UniFi Access', s.unifi, 'enabled'),
      el('div', { class: 'grid2' },
        field('UniFi console IP address', el('input', { value: s.unifi.host, placeholder: '192.168.1.1', oninput: (e) => { s.unifi.host = e.target.value.trim(); } })),
        field('Port', el('input', { type: 'number', value: s.unifi.port, oninput: (e) => { s.unifi.port = Number(e.target.value); } }), 'Normally 12445'),
        field('API token', el('input', { type: 'password', value: s.unifi.token, autocomplete: 'new-password', oninput: (e) => { s.unifi.token = e.target.value; } })),
        field('Count arrivals from (minutes before)', el('input', { type: 'number', min: 0, max: 240, value: s.unifi.leadMinutes ?? 60, oninput: (e) => { s.unifi.leadMinutes = Number(e.target.value); } }),
          'Badge-ins count from this long before the first rehearsal or service time of the day. Days with no plan times show no arrivals.')),
      el('div', { class: 'row', style: 'margin-top:0.6rem' },
        el('button', {
          onclick: async () => {
            unifiResult.className = 'help';
            unifiResult.textContent = 'Testing…';
            try {
              const r = await api('/api/admin/unifi/test', { method: 'POST', body: { host: s.unifi.host, port: s.unifi.port, token: s.unifi.token } });
              unifiResult.replaceChildren(
                el('div', { class: 'ok-text' }, `✓ Connected — ${r.events} door event(s) today. ${r.matched.length} person(s) on this week's plan badged in today${r.matched.length ? `: ${r.matched.join(', ')}` : ''}.`),
                el('div', { class: 'help' }, r.windowStart
                  ? `Arrivals on the dashboard count from ${new Date(r.windowStart).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: churchTz() })} today.`
                  : 'No arrivals are shown right now: there is no rehearsal or service time today, or it is still more than the lead time before the first one.'),
                r.recent.length ? el('table', { style: 'margin-top:0.5rem' },
                  el('thead', {}, el('tr', {}, ['Name in UniFi', 'Time', 'Door', 'Result', 'Matches plan'].map((h) => el('th', {}, h)))),
                  el('tbody', {}, r.recent.map((e) => el('tr', {},
                    el('td', {}, e.name),
                    el('td', {}, e.at ? new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: churchTz() }) : ''),
                    el('td', {}, e.door || ''),
                    el('td', {}, e.result || ''),
                    el('td', {}, e.matches.length ? e.matches.join(', ') : el('span', { class: 'muted' }, '—')))))) : null);
            } catch (err) {
              unifiResult.className = 'help error';
              unifiResult.textContent = err.message;
            }
          },
        }, 'Test connection'),
        el('button', { class: 'primary', onclick: () => saveSection('unifi') }, 'Save UniFi settings')),
      unifiResult);

    // Live item timing -----------------------------------------------------------------
    const liveSection = el('div', { class: 'section' },
      el('h2', {}, 'Live item timing'),
      el('p', { class: 'help' }, 'Like Services LIVE: when an order-of-service item goes live in ProPresenter, the dashboard starts counting how long you have been on it, and the actual time is saved for each service time. It only records during Planning Center service times, never rehearsals. An item stays live until the next one starts.'),
      check('Record actual item times', s.live, 'enabled'),
      el('div', { class: 'grid2' },
        field('Start recording before each service (minutes)', el('input', { type: 'number', min: 0, max: 120, value: s.live.preRollMinutes, oninput: (e) => { s.live.preRollMinutes = Number(e.target.value); } }), 'Covers pre-service items like the countdown.'),
        field('Keep recording after each service ends (minutes)', el('input', { type: 'number', min: 0, max: 120, value: s.live.postRollMinutes, oninput: (e) => { s.live.postRollMinutes = Number(e.target.value); } }), 'In case the service runs long.')),
      el('div', { class: 'row', style: 'margin-top:0.6rem' }, el('button', { class: 'primary', onclick: () => saveSection('live') }, 'Save timing settings')));

    root.replaceChildren(pcoSection, ppSection, hdSection, obsSection, unifiSection, liveSection, displaySection, pwSection);
    if (s.pco.hasSecret || s.pco.envCredentials || s.demo) loadServiceTypes();
    loadPlanChoices();
    loadLeaderColumns();
  }

  boot().catch((err) => toast(err.message, true));
})();
