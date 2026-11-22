/* Holiday theme for Backstage and Front of House: falling snow, Christmas lights under the
   header, snow piled on the footer, snow caps on panels and section headers.
   Usage: Holiday.apply({ snow, lights, pile, caps }) — call again with new options any time;
   Holiday.apply(null) removes everything. Decorative only (no clicks, no layout shifts). */
(() => {
  const COLORS = ['#ff3b3b', '#2ee06a', '#ffcc33', '#3fa9ff', '#ff8a3d', '#f4f4ff'];
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let current = '';

  // ---- falling snow ----------------------------------------------------------------
  let canvas = null;
  let raf = 0;
  let flakes = [];
  function startSnow() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.className = 'holiday-snow';
    document.body.append(canvas);
    const ctx = canvas.getContext('2d');
    const size = () => {
      canvas.width = innerWidth; // 1:1 pixels keeps older TV PCs smooth
      canvas.height = innerHeight;
      const target = Math.min(160, Math.round((innerWidth * innerHeight) / 14000));
      while (flakes.length < target) flakes.push(newFlake(true));
      flakes.length = target;
    };
    const newFlake = (anywhere) => ({
      x: Math.random() * innerWidth,
      y: anywhere ? Math.random() * innerHeight : -10,
      r: 0.8 + Math.random() * 2.6,
      vy: 0.25 + Math.random() * 0.75,
      sway: Math.random() * Math.PI * 2,
      swaySpeed: 0.004 + Math.random() * 0.012,
      a: 0.35 + Math.random() * 0.5,
    });
    size();
    window.addEventListener('resize', size);
    canvas._cleanup = () => window.removeEventListener('resize', size);
    let last = performance.now();
    let tint = '255,255,255';
    const draw = (t) => {
      // White flakes on dark themes; soft blue-grey ones on the light theme so they show.
      tint = document.documentElement.dataset.theme === 'pco-light' ? '120,150,190' : '255,255,255';
      const dt = Math.min(3, (t - last) / 16.7); // frame-rate independent
      last = t;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const f of flakes) {
        if (!reduced) {
          f.sway += f.swaySpeed * dt;
          f.y += f.vy * dt;
          f.x += Math.sin(f.sway) * 0.35 * dt;
          if (f.y > canvas.height + 5) Object.assign(f, newFlake(false));
          if (f.x < -5) f.x = canvas.width + 5;
          if (f.x > canvas.width + 5) f.x = -5;
        }
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${tint},${f.a})`;
        ctx.fill();
      }
      if (!reduced) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
  }
  function stopSnow() {
    if (!canvas) return;
    cancelAnimationFrame(raf);
    canvas._cleanup();
    canvas.remove();
    canvas = null;
    flakes = [];
  }

  // ---- lights under the header -------------------------------------------------------
  let lightsObs = null;
  function buildLights(box) {
    const w = box.clientWidth;
    const spacing = 56;
    const n = Math.max(4, Math.round(w / spacing));
    const step = w / n;
    // Wire droops between bulbs; bulbs hang at the low points.
    let d = `M0 0`;
    for (let i = 0; i < n; i += 1) d += ` Q ${step * i + step / 2} 12 ${step * (i + 1)} 0`;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'wire');
    svg.setAttribute('viewBox', `0 0 ${w} 14`);
    svg.setAttribute('preserveAspectRatio', 'none');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#24352a');
    path.setAttribute('stroke-width', '2');
    svg.append(path);
    const bulbs = [];
    for (let i = 0; i < n; i += 1) {
      const b = document.createElement('i');
      b.className = 'bulb';
      b.style.left = `${step * i + step / 2}px`;
      b.style.top = '6px';
      b.style.setProperty('--c', COLORS[i % COLORS.length]);
      b.style.setProperty('--r', `${(i % 2 ? 1 : -1) * (4 + (i * 7) % 9)}deg`);
      b.style.setProperty('--d', `${1.8 + ((i * 37) % 17) / 10}s`);
      b.style.setProperty('--delay', `${-((i * 53) % 29) / 10}s`);
      bulbs.push(b);
    }
    box.replaceChildren(svg, ...bulbs);
  }
  function startLights() {
    const top = document.querySelector('.top');
    if (!top || top.querySelector('.holiday-lights')) return;
    const box = document.createElement('div');
    box.className = 'holiday-lights';
    top.append(box);
    buildLights(box);
    lightsObs = new ResizeObserver(() => buildLights(box));
    lightsObs.observe(top);
    document.documentElement.classList.add('holiday-lit');
  }
  function stopLights() {
    lightsObs?.disconnect();
    lightsObs = null;
    document.querySelector('.holiday-lights')?.remove();
    document.documentElement.classList.remove('holiday-lit');
  }

  // ---- snow pile on the footer ---------------------------------------------------------
  function startPile() {
    const foot = document.querySelector('.status');
    if (!foot || foot.querySelector('.holiday-pile')) return;
    const pile = document.createElement('div');
    pile.className = 'holiday-pile';
    foot.prepend(pile);
  }
  const stopPile = () => document.querySelector('.holiday-pile')?.remove();

  window.Holiday = {
    apply(opts) {
      const o = opts || {};
      const key = JSON.stringify([o.snow, o.lights, o.pile, o.caps]);
      if (key === current) return;
      current = key;
      if (o.snow) startSnow(); else stopSnow();
      if (o.lights) startLights(); else stopLights();
      if (o.pile) startPile(); else stopPile();
      document.documentElement.classList.toggle('holiday-caps', Boolean(o.caps));
    },
  };
})();
