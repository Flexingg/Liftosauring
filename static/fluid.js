// Fluid — spring physics and pressure/direction-aware touch for Liftosauring.
// Every interactive surface is driven by damped springs, so motion is interruptible,
// carries velocity between gestures, and settles with an elastic overshoot.
(function () {
  'use strict';

  const root = document.documentElement;
  const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = reducedQuery.matches;
  reducedQuery.addEventListener?.('change', (e) => { reduced = e.matches; });

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // Rubber-band: displacement grows ever slower as you pull, approaching `limit`
  const rubber = (d, limit) => Math.sign(d) * limit * (1 - 1 / (Math.abs(d) / limit + 1));

  // ---------------------------------------------------------------- springs

  const SPRINGS = {
    press:   { stiffness: 520, damping: 32 },  // firm, immediate follow while touching
    release: { stiffness: 280, damping: 11 },  // bouncy wobble when let go
    light:   { stiffness: 190, damping: 24 },
    gentle:  { stiffness: 120, damping: 18 },
    bounce:  { stiffness: 300, damping: 15 },
    fast:    { stiffness: 430, damping: 30 },
    slow:    { stiffness: 170, damping: 19 },
    count:   { stiffness: 80, damping: 18 },   // ~critically damped: numbers never run backwards
  };

  class Spring {
    constructor(value = 0, cfg = {}) {
      this.value = value;
      this.target = value;
      this.velocity = 0;
      this.precision = 0.002;
      this.config(cfg);
    }
    config(cfg) {
      if (cfg.stiffness != null) this.stiffness = cfg.stiffness;
      if (cfg.damping != null) this.damping = cfg.damping;
      if (cfg.precision != null) this.precision = cfg.precision;
      this.stiffness ??= 170;
      this.damping ??= 20;
      return this;
    }
    to(target, cfg) { this.target = target; if (cfg) this.config(cfg); return this; }
    snap(v) { this.value = this.target = v; this.velocity = 0; return this; }
    kick(v) { this.velocity += v; return this; }
    get resting() {
      return Math.abs(this.velocity) < this.precision * 10 && Math.abs(this.value - this.target) < this.precision;
    }
    step(dt) {
      // Fixed sub-steps keep stiff springs stable on slow frames
      const h = 1 / 240;
      for (let t = dt; t > 0; t -= h) {
        const s = Math.min(h, t);
        const force = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
        this.velocity += force * s;
        this.value += this.velocity * s;
      }
      if (this.resting) { this.value = this.target; this.velocity = 0; return true; }
      return false;
    }
  }

  // One shared rAF loop for every active spring group; it sleeps when nothing moves.
  const drivers = new Set();
  let rafId = 0;
  let lastT = 0;

  function frame(t) {
    const dt = Math.min(0.05, Math.max(0.001, (t - lastT) / 1000));
    lastT = t;
    for (const d of drivers) {
      d.beforeStep?.(t);
      let done = true;
      for (const s of d.springs) if (!s.step(dt)) done = false;
      d.update();
      if (done && !d.hold) { drivers.delete(d); d.onRest?.(); }
    }
    rafId = drivers.size ? requestAnimationFrame(frame) : 0;
  }

  function run(driver) {
    if (reduced && !driver.hold) {
      driver.springs.forEach((s) => s.snap(s.target));
      driver.update();
      driver.onRest?.();
      return driver;
    }
    drivers.add(driver);
    if (!rafId) { lastT = performance.now(); rafId = requestAnimationFrame(frame); }
    return driver;
  }
  const isRunning = (d) => !!d && drivers.has(d);

  // Bake spring step-responses into CSS `linear()` easings so plain CSS transitions bounce too.
  function springEasing(cfg) {
    const s = new Spring(0, { ...cfg, precision: 0.0004 }).to(1);
    const dt = 1 / 120;
    const samples = [0];
    let t = 0;
    while (t < 3) { const done = s.step(dt); t += dt; samples.push(s.value); if (done) break; }
    const stride = Math.max(1, Math.round(samples.length / 56));
    const pts = samples.filter((_, i) => i % stride === 0).map((v) => +v.toFixed(4));
    if (pts[pts.length - 1] !== 1) pts.push(1);
    return { easing: `linear(${pts.join(', ')})`, duration: Math.round(t * 1000) };
  }

  if (window.CSS?.supports?.('transition-timing-function', 'linear(0, 0.5, 1)')) {
    const bounce = springEasing({ stiffness: 230, damping: 14 });
    const fluid = springEasing({ stiffness: 200, damping: 21 });
    root.style.setProperty('--ease-bounce', bounce.easing);
    root.style.setProperty('--dur-bounce', `${bounce.duration}ms`);
    root.style.setProperty('--ease-fluid', fluid.easing);
    root.style.setProperty('--dur-fluid', `${fluid.duration}ms`);
  }

  // ---------------------------------------------------------------- pressure-aware press

  const PRESS_SEL = '[data-press]';
  const FORM_SEL = 'input, select, textarea, option, label';
  const states = new WeakMap();
  const pressed = new Map();
  let hovered = null;

  function stateFor(el) {
    let st = states.get(el);
    if (!st) {
      st = {
        el,
        kind: el.dataset.press || 'card',
        press: new Spring(0, SPRINGS.press),
        rx: new Spring(0, SPRINGS.press),
        ry: new Spring(0, SPRINGS.press),
        dx: new Spring(0, SPRINGS.press),
        dy: new Spring(0, SPRINGS.press),
        lx: new Spring(50, SPRINGS.light),
        ly: new Spring(50, SPRINGS.light),
        li: new Spring(0, SPRINGS.light),
        pointerId: null,
        rect: null,
        driver: null,
      };
      st.springs = [st.press, st.rx, st.ry, st.dx, st.dy, st.lx, st.ly, st.li];
      states.set(el, st);
    }
    return st;
  }

  function ensureDriver(st, hold) {
    if (!isRunning(st.driver)) {
      st.driver = run({
        springs: st.springs,
        hold,
        beforeStep: () => rampPressure(st),
        update: () => paint(st),
        onRest: () => {
          if (!st.press.value && !st.li.value) {
            st.el.style.transform = '';
            st.el.style.removeProperty('--li');
          }
        },
      });
    }
    st.driver.hold = hold;
  }

  // Real pressure where the hardware reports it (pens, some touchscreens); otherwise pressure
  // builds the longer you hold, so a firm press still feels "deeper" than a tap.
  const hasRealPressure = (e) =>
    e.pointerType === 'pen' || (e.pointerType === 'touch' && e.pressure > 0 && e.pressure !== 0.5 && e.pressure !== 1);

  function rampPressure(st) {
    if (st.pointerId == null) return;
    const held = clamp(0.4 + (performance.now() - st.downAt) / 1100, 0, 1);
    const p = st.realPressure != null ? Math.max(st.realPressure, held * 0.6) : held;
    st.press.to(p);
    st.li.to(0.55 + p * 0.45);
    st.rx.to(-st.py * p);
    st.ry.to(st.px * p);
  }

  function paint(st) {
    const { el, rect } = st;
    if (!rect) return;
    const size = Math.max(rect.width, rect.height, 1);
    // Small things squish more; big cards mostly tilt
    const squish = clamp(15 / size, 0.012, 0.085);
    const tilt = clamp(820 / size, 1.4, 10);
    const dx = st.dx.value;
    const dy = st.dy.value;
    const mag = Math.hypot(dx, dy);
    let stretch = '';
    if (mag > 0.05) {
      const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
      const k = clamp(mag / (size * 1.6), 0, 0.1);
      stretch = ` rotate(${ang.toFixed(2)}deg) scale(${(1 + k).toFixed(4)}, ${(1 - k * 0.6).toFixed(4)}) rotate(${(-ang).toFixed(2)}deg)`;
    }
    el.style.transform =
      `perspective(900px) translate3d(${(dx * 0.4).toFixed(2)}px, ${(dy * 0.4).toFixed(2)}px, 0) ` +
      `rotateX(${(st.rx.value * tilt).toFixed(3)}deg) rotateY(${(st.ry.value * tilt).toFixed(3)}deg) ` +
      `scale(${(1 - squish * st.press.value).toFixed(4)})${stretch}`;
    el.style.setProperty('--lx', `${st.lx.value.toFixed(1)}%`);
    el.style.setProperty('--ly', `${st.ly.value.toFixed(1)}%`);
    el.style.setProperty('--li', clamp(st.li.value, 0, 1.2).toFixed(3));
  }

  function trackPointer(st, e) {
    const r = st.rect;
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    st.px = clamp(fx * 2 - 1, -1, 1);
    st.py = clamp(fy * 2 - 1, -1, 1);
    st.lx.to(clamp(fx * 100, -10, 110));
    st.ly.to(clamp(fy * 100, -10, 110));
    if (st.pointerId != null) {
      // Direction: dragging stretches the surface toward your finger, resisting more the further you go
      const limit = st.kind === 'card' ? 18 : 26;
      st.dx.to(rubber(e.clientX - st.ox, limit));
      st.dy.to(rubber(e.clientY - st.oy, limit));
      if (hasRealPressure(e)) st.realPressure = clamp(e.pressure * 1.3, 0, 1);
    }
  }

  function bloom(el, e, pressure) {
    if (reduced) return;
    let clip = el.querySelector(':scope > .fx-clip');
    if (!clip) {
      clip = document.createElement('span');
      clip.className = 'fx-clip';
      clip.setAttribute('aria-hidden', 'true');
      el.appendChild(clip);
    }
    const r = el.getBoundingClientRect();
    const b = document.createElement('span');
    const size = clamp(Math.max(r.width, r.height) * (0.9 + pressure), 60, 720);
    b.className = 'bloom';
    b.style.cssText = `left:${e.clientX - r.left}px;top:${e.clientY - r.top}px;width:${size}px;height:${size}px`;
    b.addEventListener('animationend', () => b.remove(), { once: true });
    clip.appendChild(b);
  }

  function haptic(ms) {
    try { navigator.vibrate?.(ms); } catch (_) { /* not allowed before user activation */ }
  }

  document.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    const el = e.target.closest(PRESS_SEL);
    if (!el || el.matches(':disabled, [aria-disabled="true"]')) return;
    // Typing into a field shouldn't make the whole card lurch
    if (e.target.closest(FORM_SEL) && !el.matches(FORM_SEL)) return;
    const st = stateFor(el);
    st.pointerId = e.pointerId;
    st.downAt = performance.now();
    st.rect = el.getBoundingClientRect();
    st.ox = e.clientX;
    st.oy = e.clientY;
    st.realPressure = hasRealPressure(e) ? clamp(e.pressure * 1.3, 0, 1) : null;
    for (const s of [st.press, st.rx, st.ry, st.dx, st.dy]) s.config(SPRINGS.press);
    trackPointer(st, e);
    bloom(el, e, st.realPressure ?? 0.4);
    if (st.kind !== 'card') haptic(6);
    ensureDriver(st, true);
    pressed.set(e.pointerId, st);
  }, { passive: true });

  document.addEventListener('pointermove', (e) => {
    const active = pressed.get(e.pointerId);
    if (active) { trackPointer(active, e); return; }
    if (e.pointerType !== 'mouse') return;
    // Hover: a soft light follows the cursor across the glass
    const el = e.target.closest(PRESS_SEL);
    if (el !== hovered) {
      if (hovered) { const old = stateFor(hovered); old.li.to(0); ensureDriver(old, false); }
      hovered = el;
    }
    if (!el) return;
    const st = stateFor(el);
    st.rect = el.getBoundingClientRect();
    trackPointer(st, e);
    st.li.to(0.35);
    ensureDriver(st, false);
  }, { passive: true });

  function release(e) {
    const st = pressed.get(e.pointerId);
    if (!st) return;
    pressed.delete(e.pointerId);
    st.pointerId = null;
    const depth = st.press.value;
    for (const s of [st.press, st.rx, st.ry, st.dx, st.dy]) s.to(0, SPRINGS.release);
    // Rebound past rest in proportion to how hard it was pressed
    st.press.kick(-depth * 7);
    st.li.to(hovered === st.el ? 0.35 : 0);
    ensureDriver(st, false);
  }
  document.addEventListener('pointerup', release, { passive: true });
  document.addEventListener('pointercancel', release, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => {
    if (hovered) { const st = stateFor(hovered); st.li.to(0); ensureDriver(st, false); hovered = null; }
  });

  // ---------------------------------------------------------------- jelly / tween / count

  const jellies = new WeakMap();
  function jelly(el, power = 1) {
    if (!el || reduced) return;
    let j = jellies.get(el);
    if (!j) {
      j = { sx: new Spring(1, SPRINGS.bounce), sy: new Spring(1, SPRINGS.bounce) };
      jellies.set(el, j);
    }
    j.sx.kick(3.2 * power);
    j.sy.kick(-2.4 * power);
    if (!isRunning(j.driver)) {
      j.driver = run({
        springs: [j.sx, j.sy],
        update: () => { el.style.scale = `${j.sx.value.toFixed(4)} ${j.sy.value.toFixed(4)}`; },
        onRest: () => { el.style.scale = ''; },
      });
    }
  }

  function tween(cb, preset = 'bounce') {
    const s = new Spring(0, { ...SPRINGS[preset], precision: 0.001 }).to(1);
    return run({ springs: [s], update: () => cb(s.value), onRest: () => cb(1) });
  }

  const counters = new WeakMap();
  function count(el, value, { decimals = 0, prefix = '', suffix = '' } = {}) {
    if (!el) return;
    const v = Number(value) || 0;
    let c = counters.get(el);
    if (!c) {
      // Start from whatever is already displayed so a first update animates from there, not from 0
      const shown = parseFloat((el.textContent || '').replace(/[^0-9.-]/g, ''));
      c = { s: new Spring(Number.isFinite(shown) ? shown : 0, { ...SPRINGS.count, precision: 0.5 * 10 ** -decimals }) };
      counters.set(el, c);
    }
    c.fmt = (n) => prefix + n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;
    c.s.to(v);
    if (!isRunning(c.driver)) {
      c.driver = run({
        springs: [c.s],
        update: () => { el.textContent = c.fmt(c.s.value); },
        onRest: () => { el.textContent = c.fmt(c.s.target); },
      });
    }
  }

  // ---------------------------------------------------------------- reveal / deferred fills

  const pendingVisible = new Map();
  const revealObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-visible');
          revealObserver.unobserve(entry.target);
          const fns = pendingVisible.get(entry.target);
          if (fns) { pendingVisible.delete(entry.target); setTimeout(() => fns.forEach((fn) => fn()), 140); }
        }
      }, { threshold: 0.06, rootMargin: '0px 0px -30px 0px' })
    : null;

  function observeReveals(scope = document) {
    scope.querySelectorAll('.reveal:not(.is-visible)').forEach((el) => {
      if (revealObserver) revealObserver.observe(el); else el.classList.add('is-visible');
    });
  }

  // Run fn once el's reveal container has scrolled into view (immediately if it already has)
  function whenVisible(el, fn) {
    const host = el?.closest('.reveal');
    if (!host || host.classList.contains('is-visible') || !revealObserver) {
      requestAnimationFrame(() => requestAnimationFrame(fn));
      return;
    }
    if (!pendingVisible.has(host)) pendingVisible.set(host, []);
    pendingVisible.get(host).push(fn);
  }

  function fill(el, pct) {
    if (!el) return;
    const v = clamp(Number(pct) || 0, 0, 100);
    whenVisible(el, () => { el.style.width = `${v}%`; });
  }

  // ---------------------------------------------------------------- FLIP reordering

  function flip(container, keyAttr, mutate) {
    const before = new Map();
    container.querySelectorAll(`[${keyAttr}]`).forEach((n) => before.set(n.getAttribute(keyAttr), n.getBoundingClientRect().top));
    mutate();
    let enterIndex = 0;
    container.querySelectorAll(`[${keyAttr}]`).forEach((n) => {
      const prev = before.get(n.getAttribute(keyAttr));
      if (prev == null) {
        n.style.setProperty('--i', enterIndex++);
        n.classList.add('pop-in');
        return;
      }
      const delta = prev - n.getBoundingClientRect().top;
      if (Math.abs(delta) < 1 || reduced) return;
      const s = new Spring(delta, SPRINGS.bounce).to(0);
      run({
        springs: [s],
        update: () => { n.style.translate = `0 ${s.value.toFixed(2)}px`; },
        onRest: () => { n.style.translate = ''; },
      });
    });
  }

  // ---------------------------------------------------------------- liquid indicator (tabs, dock)

  // The indicator's leading edge races ahead while the trailing edge lags, so it stretches like a
  // droplet between items. Drag across the bar to scrub; release to settle on the nearest item.
  function liquid(container, { onSelect, itemSelector = '[data-index]' } = {}) {
    const ind = container.querySelector('.liquid-ind');
    const items = () => [...container.querySelectorAll(itemSelector)];
    const L = new Spring(0, SPRINGS.slow);
    const R = new Spring(0, SPRINGS.slow);
    const lift = new Spring(0, SPRINGS.press);
    let active = 0;
    let targetW = 0;
    let ready = false;
    let scrub = null;
    let driver = null;

    const geom = (i) => {
      const it = items()[i];
      return it ? { l: it.offsetLeft, r: it.offsetLeft + it.offsetWidth } : { l: 0, r: 0 };
    };
    const draw = () => {
      const w = Math.max(0, R.value - L.value);
      const stretch = targetW ? clamp((w - targetW) / targetW, 0, 1) : 0;
      ind.style.width = `${w.toFixed(2)}px`;
      ind.style.transform = `translateX(${L.value.toFixed(2)}px) scale(${(1 + lift.value * 0.05).toFixed(4)}, ${(1 - stretch * 0.24 + lift.value * 0.06).toFixed(4)})`;
    };
    const animate = () => {
      if (!isRunning(driver)) driver = run({ springs: [L, R, lift], update: draw });
    };
    const moveTo = (l, r, immediate) => {
      targetW = r - l;
      if (immediate || !ready || reduced) { L.snap(l); R.snap(r); draw(); ready = true; return; }
      const right = l > L.target;
      (right ? R : L).to(right ? r : l, SPRINGS.fast);
      (right ? L : R).to(right ? l : r, SPRINGS.slow);
      animate();
    };
    const mark = (i) => items().forEach((it, j) => {
      it.classList.toggle('is-active', j === i);
      it.setAttribute('aria-selected', j === i ? 'true' : 'false');
    });
    function select(i, { emit = false, immediate = false } = {}) {
      const n = items().length;
      if (!n) return;
      active = clamp(i, 0, n - 1);
      mark(active);
      const g = geom(active);
      moveTo(g.l, g.r, immediate);
      if (emit) onSelect?.(active);
    }
    const localX = (e) => e.clientX - container.getBoundingClientRect().left + container.scrollLeft;
    const nearest = (x) => {
      let best = 0;
      let bestD = Infinity;
      items().forEach((it, j) => {
        const d = Math.abs(it.offsetLeft + it.offsetWidth / 2 - x);
        if (d < bestD) { bestD = d; best = j; }
      });
      return best;
    };

    container.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      // Pointer capture retargets later events to the container, so remember what was pressed now
      scrub = { id: e.pointerId, x0: e.clientX, moved: false, hit: e.target.closest(itemSelector) };
      try { container.setPointerCapture(e.pointerId); } catch (_) { /* capture is best effort */ }
      lift.to(1, SPRINGS.press);
      animate();
    });
    container.addEventListener('pointermove', (e) => {
      if (!scrub || e.pointerId !== scrub.id) return;
      if (!scrub.moved && Math.abs(e.clientX - scrub.x0) < 6) return;
      scrub.moved = true;
      const all = items();
      const first = all[0];
      const last = all[all.length - 1];
      const lo = first.offsetLeft + first.offsetWidth / 2;
      const hi = last.offsetLeft + last.offsetWidth / 2;
      let x = localX(e);
      if (x < lo) x = lo + rubber(x - lo, 24);
      if (x > hi) x = hi + rubber(x - hi, 24);
      const idx = nearest(x);
      mark(idx);
      const g = geom(idx);
      const half = (g.r - g.l) / 2;
      targetW = g.r - g.l;
      L.to(x - half, SPRINGS.fast);
      R.to(x + half, SPRINGS.fast);
      animate();
    });
    const end = (e, cancelled) => {
      if (!scrub || e.pointerId !== scrub.id) return;
      const { moved: wasScrub, hit } = scrub;
      scrub = null;
      lift.to(0, SPRINGS.release);
      if (cancelled) { select(active); return; }
      const idx = wasScrub ? nearest(localX(e)) : (hit ? items().indexOf(hit) : active);
      haptic(5);
      select(idx < 0 ? active : idx, { emit: true });
    };
    container.addEventListener('pointerup', (e) => end(e, false));
    container.addEventListener('pointercancel', (e) => end(e, true));
    // Keyboard activation (Enter/Space) arrives as a click with no pointer detail
    container.addEventListener('click', (e) => {
      if (e.detail !== 0) return;
      const it = e.target.closest(itemSelector);
      if (it) select(items().indexOf(it), { emit: true });
    });
    const resync = () => select(active, { immediate: true });
    window.addEventListener('resize', resync);
    document.fonts?.ready?.then(resync);

    return { select, resync, get index() { return active; } };
  }

  // ---------------------------------------------------------------- elastic slider

  function slider(input, { format = (v) => v, onInput } = {}) {
    const wrap = input.closest('.fslider');
    const bubble = wrap.querySelector('.fslider-val');
    const sq = new Spring(0, SPRINGS.release);
    const act = new Spring(0, SPRINGS.bounce);
    let lastV = +input.value;
    let lastT = performance.now();
    let driver = null;
    const paintThumb = () => {
      const k = clamp(Math.abs(sq.value), 0, 0.45);
      const a = act.value;
      wrap.style.setProperty('--sx', (1 + a * 0.18 + k).toFixed(4));
      wrap.style.setProperty('--sy', (1 + a * 0.18 - k * 0.55).toFixed(4));
      wrap.style.setProperty('--active', a.toFixed(3));
    };
    const animate = () => { if (!isRunning(driver)) driver = run({ springs: [sq, act], update: paintThumb }); };
    const sync = () => {
      const min = +input.min;
      const max = +input.max;
      const p = (+input.value - min) / (max - min || 1);
      wrap.style.setProperty('--p', p.toFixed(4));
      if (bubble) bubble.textContent = format(+input.value);
    };
    input.addEventListener('input', () => {
      const now = performance.now();
      const v = +input.value;
      const span = (+input.max - +input.min) || 1;
      // Fast drags squash the thumb along the direction of travel
      const vel = ((v - lastV) / span) / Math.max(0.008, (now - lastT) / 1000);
      sq.kick(clamp(vel, -12, 12) * 0.9);
      lastV = v;
      lastT = now;
      sync();
      animate();
      onInput?.(v);
    });
    input.addEventListener('pointerdown', () => { act.to(1); wrap.classList.add('is-active'); animate(); });
    const up = () => { act.to(0); wrap.classList.remove('is-active'); animate(); };
    input.addEventListener('pointerup', up);
    input.addEventListener('pointercancel', up);
    input.addEventListener('blur', up);
    sync();
    return { sync };
  }

  // ---------------------------------------------------------------- rubber-band scrolling

  function rubberScroll(scroller) {
    const inner = scroller.firstElementChild;
    if (!inner) return;
    const s = new Spring(0, SPRINGS.release);
    let driver = null;
    let edgeY = null;
    let lastY = 0;
    let wheelTimer = 0;
    const paint = () => { inner.style.translate = Math.abs(s.value) > 0.05 ? `0 ${s.value.toFixed(2)}px` : ''; };
    const settle = () => { s.to(0, SPRINGS.release); if (!isRunning(driver)) driver = run({ springs: [s], update: paint }); };
    const atTop = () => scroller.scrollTop <= 0;
    const atBottom = () => scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;

    scroller.addEventListener('touchstart', (e) => { lastY = e.touches[0].clientY; edgeY = null; }, { passive: true });
    scroller.addEventListener('touchmove', (e) => {
      const y = e.touches[0].clientY;
      const down = y > lastY;
      lastY = y;
      if ((down && atTop()) || (!down && atBottom()) || edgeY != null) {
        if (edgeY == null) edgeY = y;
        const d = y - edgeY;
        if ((d > 0 && !atTop()) || (d < 0 && !atBottom())) { edgeY = null; s.snap(0); paint(); return; }
        s.snap(rubber(d, 80));
        paint();
      }
    }, { passive: true });
    scroller.addEventListener('touchend', () => { edgeY = null; settle(); }, { passive: true });
    scroller.addEventListener('wheel', (e) => {
      if ((e.deltaY < 0 && atTop()) || (e.deltaY > 0 && atBottom())) {
        const next = s.value - e.deltaY * 0.25;
        s.snap(rubber(next, 60) * 1.4);
        paint();
        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(settle, 90);
      }
    }, { passive: true });
  }

  // ---------------------------------------------------------------- Fluid Cloud toasts

  const TOAST_ICONS = { success: '#i-check', error: '#i-alert', info: '#i-bolt' };
  function toast(message, type = 'success', { duration = 3800 } = {}) {
    const stack = document.getElementById('toast-stack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const ic = document.createElement('span');
    ic.className = 'toast-ic';
    ic.innerHTML = `<svg class="ic"><use href="${TOAST_ICONS[type] || TOAST_ICONS.info}"/></svg>`;
    const msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = message;
    el.append(ic, msg);
    stack.prepend(el);

    // Morphs out of a small dot: width springs open faster than height, like a droplet spreading
    const sx = new Spring(0.18, SPRINGS.bounce).to(1);
    const sy = new Spring(0.5, { stiffness: 380, damping: 20 }).to(1);
    const ty = new Spring(-18, SPRINGS.bounce).to(0);
    const op = new Spring(0, SPRINGS.fast).to(1);
    let drag = null;
    const paint = () => {
      el.style.transform = `translateY(${ty.value.toFixed(2)}px) scale(${sx.value.toFixed(4)}, ${sy.value.toFixed(4)})`;
      el.style.opacity = clamp(op.value, 0, 1).toFixed(3);
    };
    let driver = run({ springs: [sx, sy, ty, op], update: paint });
    requestAnimationFrame(() => el.classList.add('is-in'));

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      el.classList.remove('is-in');
      sx.to(0.2, SPRINGS.fast);
      sy.to(0.4, SPRINGS.fast);
      ty.to(ty.value - 10, SPRINGS.fast);
      op.to(0, SPRINGS.fast);
      if (!isRunning(driver)) driver = run({ springs: [sx, sy, ty, op], update: paint });
      driver.onRest = () => el.remove();
    };
    let timer = setTimeout(close, duration);

    // Flick it upward to dismiss; it stretches elastically if you pull it down
    el.addEventListener('pointerdown', (e) => {
      drag = { y0: e.clientY, id: e.pointerId };
      clearTimeout(timer);
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* best effort */ }
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const d = e.clientY - drag.y0;
      ty.snap(d < 0 ? d : rubber(d, 26));
      sy.snap(1 + clamp(Math.abs(d) / 400, 0, 0.12));
      sx.snap(1 - clamp(Math.abs(d) / 900, 0, 0.06));
      paint();
    });
    const up = () => {
      if (!drag) return;
      const flicked = ty.value < -24;
      drag = null;
      if (flicked) { close(); return; }
      ty.to(0, SPRINGS.release);
      sx.to(1, SPRINGS.release);
      sy.to(1, SPRINGS.release);
      if (!isRunning(driver)) driver = run({ springs: [sx, sy, ty, op], update: paint });
      timer = setTimeout(close, 2200);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return { close };
  }

  // ---------------------------------------------------------------- particles & ambient light

  function burst(el, count = 7) {
    if (!el || reduced) return;
    for (let i = 0; i < count; i++) {
      const p = document.createElement('span');
      const ang = (Math.PI * 2 * i) / count + Math.random() * 0.5;
      const dist = 22 + Math.random() * 16;
      p.className = 'burst-dot';
      p.style.setProperty('--dx', `${(Math.cos(ang) * dist).toFixed(1)}px`);
      p.style.setProperty('--dy', `${(Math.sin(ang) * dist).toFixed(1)}px`);
      p.addEventListener('animationend', () => p.remove(), { once: true });
      el.appendChild(p);
    }
  }

  function ambient() {
    const aura = document.getElementById('aura-follow');
    if (!aura) return;
    const x = new Spring(window.innerWidth * 0.7, SPRINGS.gentle);
    const y = new Spring(window.innerHeight * 0.2, SPRINGS.gentle);
    let driver = null;
    const paint = () => { aura.style.translate = `${x.value.toFixed(1)}px ${y.value.toFixed(1)}px`; };
    paint();
    window.addEventListener('pointermove', (e) => {
      if (reduced) return;
      x.to(e.clientX);
      y.to(e.clientY);
      if (!isRunning(driver)) driver = run({ springs: [x, y], update: paint });
    }, { passive: true });
  }

  window.Fluid = {
    Spring, SPRINGS, run, tween, jelly, count, fill, flip, liquid, slider, rubberScroll,
    toast, burst, haptic, whenVisible, observeReveals, ambient,
    get reduced() { return reduced; },
  };
})();
