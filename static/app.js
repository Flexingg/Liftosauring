// Liftosauring — Fluid UI controller (read-only Liftosaur telemetry)
'use strict';

let APP_STATE = null;
let LB_MODE = 'overall';
let EX_FILTER = 'ALL';
let SELECTED_TIER = null;
let CALC_SEQ = 0;
let calcTimer = 0;
let calcBwTouched = false;
let lastTierId = null;
const OPEN_EXERCISES = new Set();
const RADAR_AXES = [
  { key: 'Chest', label: 'CHEST' },
  { key: 'Shoulders', label: 'SHOULDERS' },
  { key: 'Arms', label: 'ARMS' },
  { key: 'Discipline', label: 'CADENCE' },
  { key: 'Legs', label: 'LEGS' },
  { key: 'Back', label: 'BACK' },
];
const BIG4 = [['Squat', 'Squat'], ['Bench Press', 'Bench'], ['Deadlift', 'Deadlift'], ['Overhead Press', 'OHP']];
const SECTIONS = ['sec-overview', 'sec-arsenal', 'sec-projection', 'sec-pack', 'sec-api'];
const LB_MODES = ['overall', 'dots', 'improved', 'volume'];
const EVENT_TAGS = {
  WORKOUT_SYNC: ['Session', '#3ee6a8'],
  PR_ALERT: ['PR', '#ffb547'],
  RANK_UP: ['Rank up', '#38bdf8'],
  CHALLENGE: ['Challenge', '#f472b6'],
  NEW_MEMBER: ['Joined', '#a78bfa'],
};

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------- safe templating
// Every interpolated value is HTML-escaped unless it is itself an html`` fragment, so names
// and notes coming from Liftosaur or other Pack members can never inject markup.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
class Html { constructor(s) { this.s = s; } toString() { return this.s; } }
const part = (v) => (v == null || v === false ? '' : v instanceof Html ? v.s : Array.isArray(v) ? v.map(part).join('') : esc(v));
function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += part(v) + strings[i + 1]; });
  return new Html(out);
}
const setHTML = (el, frag) => { if (el) el.innerHTML = String(frag); };
// Only hex colours or our own CSS variables may reach a style attribute
const safeColor = (c, fallback = '#8b978e') => (/^#[0-9a-f]{3,8}$/i.test(c || '') || /^var\(--[a-z0-9-]+\)$/.test(c || '') ? c : fallback);

const fmt = (n, d = 0) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const kfmt = (n) => (Math.abs(n) >= 1000 ? `${fmt(n / 1000, 1)}k` : fmt(n));
const parseUtc = (s) => new Date(String(s || '').replace(' ', 'T') + (String(s).length <= 19 ? 'Z' : ''));

function setRankColor(color) {
  document.documentElement.style.setProperty('--rank', safeColor(color, '#3ee6a8'));
}

// ---------------------------------------------------------------- data

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json;
  try { json = await res.json(); } catch (_) { throw new Error(`Server returned ${res.status}`); }
  if (!json.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

async function loadState() {
  try {
    const json = await api('/api/state');
    applyState(json.data);
  } catch (err) {
    Fluid.toast(`Couldn't load telemetry: ${err.message}`, 'error');
  }
}

function applyState(data) {
  const prevTier = lastTierId;
  APP_STATE = data;
  renderAll();
  const tier = data?.user?.overallRank;
  if (tier) {
    if (prevTier && prevTier !== tier.tierId) {
      Fluid.toast(`Evolved to ${tier.fullTitle}!`, 'info', { duration: 5200 });
      Fluid.jelly($('hero-emblem'), 1.6);
    }
    lastTierId = tier.tierId;
  }
}

function setBusy(btn, busy) {
  if (!btn) return;
  btn.disabled = busy;
  btn.classList.toggle('is-busy', busy);
  Fluid.jelly(btn, 0.6);
}

async function syncLiveKey() {
  if (!APP_STATE?.user?.overallRank) {
    Fluid.toast('Paste your Liftosaur API key first.', 'info');
    goTo('sec-api');
    setTimeout(() => $('vault-apikey').focus({ preventScroll: true }), 650);
    return;
  }
  const btn = $('btn-sync-now');
  setBusy(btn, true);
  try {
    const json = await api('/api/sync', {});
    applyState(json.data);
    Fluid.toast(json.message || 'Liftosaur telemetry synced.');
  } catch (err) {
    Fluid.toast(err.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

async function saveAndSyncKey(e) {
  e.preventDefault();
  const btn = $('vault-submit');
  const apiKey = $('vault-apikey').value.trim();
  if (!apiKey && !APP_STATE?.user?.overallRank) {
    Fluid.toast('Paste a Liftosaur API key (lftsk_…) to connect.', 'info');
    Fluid.jelly($('vault-apikey'), 0.5);
    return;
  }
  setBusy(btn, true);
  try {
    const json = await api('/api/sync', {
      callsign: $('vault-callsign').value.trim(),
      sex: $('vault-sex').value,
      apiKey,
    });
    $('vault-apikey').value = '';
    applyState(json.data);
    Fluid.toast(json.message || 'API key validated & synced.');
  } catch (err) {
    Fluid.toast(err.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

async function addPackFriend(e) {
  e.preventDefault();
  const callsign = $('friend-name').value.trim();
  const apiKey = $('friend-apikey').value.trim();
  const btn = $('peer-submit');
  setBusy(btn, true);
  try {
    const json = await api('/api/pack/add', { callsign, apiKey, sex: $('friend-sex').value });
    $('friend-name').value = '';
    $('friend-apikey').value = '';
    applyState(json.data);
    Fluid.toast(`Added ${callsign} to the Pack.`);
  } catch (err) {
    Fluid.toast(err.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

async function hypePost(btn) {
  const id = Number(btn.dataset.post);
  const countEl = btn.querySelector('.hype-count');
  const before = Number(countEl.dataset.n) || 0;
  countEl.dataset.n = before + 1;
  Fluid.count(countEl, before + 1);
  btn.classList.add('is-hyped');
  Fluid.jelly(btn, 1.2);
  Fluid.burst(btn);
  try {
    const json = await api('/api/feed/hype', { postId: id });
    APP_STATE = json.data;
  } catch (err) {
    countEl.dataset.n = before;
    Fluid.count(countEl, before);
    Fluid.toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------- render: everything

function renderAll() {
  const s = APP_STATE || {};
  const u = s.user || {};
  const has = !!u.overallRank;
  setRankColor(has ? u.overallRank.color : '#3ee6a8');

  renderHeader(u, has);
  renderHero(u, has);
  renderRadar(u.muscleRadar || {}, has);
  renderBio(u, has);
  renderTierTrack(s.rankTiers || [], has ? u.overallRank : null, has ? u.overallScore : null);
  renderExercises();
  renderNextWorkout(u.nextWorkout, has);
  renderWorkoutLog(u.workouts || []);
  renderQuests(u.quests || []);
  renderThresholds(u, has);
  renderLeaderboard();
  renderObjective(s.raidBoss);
  renderDuels(s.duels || [], has);
  renderFeed(s.socialFeed || []);
  renderVault(u, has);

  if (has && !calcBwTouched) $('calc-bw').value = u.bodyweight || 197;
  runCalculator();
}

function renderHeader(u, has) {
  $('header-masked-key').textContent = has ? u.maskedKey : 'Not connected';
  $('key-pill').classList.toggle('is-live', has);
}

function renderHero(u, has) {
  const r = u.overallRank || {};
  const emblem = $('hero-emblem');
  emblem.classList.toggle('is-egg', !has);
  $('hero-rank-icon').textContent = has ? r.icon : '?';
  $('hero-callsign').textContent = has ? u.callsign : 'No profile yet';
  $('hero-bw-pill').textContent = has ? `${fmt(u.bodyweight, 1)} lb` : '— lb';
  $('hero-program-pill').textContent = has ? u.activeProgram : 'Liftosaur';
  $('hero-rank-title').textContent = has ? r.fullTitle : 'Unhatched';
  $('hero-rank-desc').textContent = has ? r.desc : 'Connect your Liftosaur API key to hatch your strength rank.';
  $('hero-cta').hidden = has;
  $('hero-lp').hidden = !has;

  Fluid.count($('hero-overall-score'), has ? u.overallScore : 0, { decimals: 1 });
  Fluid.count($('hero-dots-score'), u.dotsScore || 0, { decimals: 1 });
  Fluid.count($('hero-sbd-total'), u.sbdTotal || 0);
  Fluid.count($('hero-lp-val'), r.lp || 0);

  const maxed = r.nextRankLabel === 'MAX RANK';
  setHTML($('hero-next-line'), maxed
    ? html`<span class="rank-ink">Apex reached. Nothing above you.</span>`
    : html`<b>${fmt(r.scoreNeededForNext, 1)}</b> pts to <span class="rank-ink">${r.nextRankLabel || '—'}</span>`);
  Fluid.fill($('hero-lp-bar'), has ? Math.max(4, r.lp || 0) : 0);

  const find = (name) => (u.exercises || []).find((x) => x.name === name);
  setHTML($('big4-grid'), html`${BIG4.map(([name, label]) => {
    const ex = find(name);
    const color = ex ? safeColor(ex.rank.color) : 'var(--text-3)';
    return html`
      <button type="button" class="tile" data-press="tile" data-action="focus-ex" data-ex="${name}" style="--c:${color}" ${ex ? '' : new Html('disabled')}>
        <span class="tile-top"><span>${label}</span><span class="tile-tier">${ex ? ex.rank.icon : '–'}</span></span>
        <span class="tile-num">${ex ? Math.round(ex.best_e1rm) : '—'}<small> lb</small></span>
        <span class="tile-rank">${ex ? ex.rank.fullTitle : 'Unranked'}</span>
        <span class="tile-sub">${ex ? `Best ${ex.best_set_str}` : 'Not logged yet'}</span>
      </button>`;
  })}`);
}

// ---------------------------------------------------------------- radar

let radarShown = RADAR_AXES.map(() => 0);
let radarDriver = null;

function radarPoint(i, r) {
  const angle = (Math.PI * 2 * i) / RADAR_AXES.length - Math.PI / 2;
  return [150 + r * Math.cos(angle), 128 + r * Math.sin(angle)];
}

function renderRadar(radar, has) {
  const svg = $('muscle-radar-svg');
  const maxR = 86;
  if (!svg.dataset.built) {
    const rings = [0.25, 0.5, 0.75, 1].map((lv) => html`<polygon class="ring ${lv === 1 ? 'outer' : ''}" points="${RADAR_AXES.map((_, i) => radarPoint(i, maxR * lv).map((n) => n.toFixed(1)).join(',')).join(' ')}"/>`);
    const spokes = RADAR_AXES.map((_, i) => { const [x, y] = radarPoint(i, maxR); return html`<line class="spoke" x1="150" y1="128" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`; });
    const labels = RADAR_AXES.map((ax, i) => {
      const [x, y] = radarPoint(i, maxR + 24);
      return html`<text class="ax-label" x="${x.toFixed(1)}" y="${(y - 3).toFixed(1)}" text-anchor="middle">${ax.label}</text><text class="ax-val" id="radar-val-${i}" x="${x.toFixed(1)}" y="${(y + 10).toFixed(1)}" text-anchor="middle">0</text>`;
    });
    setHTML(svg, html`
      <defs>
        <radialGradient id="radar-fill" cx="50%" cy="50%" r="60%">
          <stop offset="0" style="stop-color:var(--rank);stop-opacity:.05"/>
          <stop offset="1" style="stop-color:var(--rank);stop-opacity:.38"/>
        </radialGradient>
      </defs>
      ${rings}${spokes}
      <polygon class="shape" id="radar-shape" points=""/>
      <g id="radar-nodes">${RADAR_AXES.map(() => html`<circle class="node" r="3.6" cx="150" cy="128"/>`)}</g>
      ${labels}`);
    svg.dataset.built = '1';
  }

  const target = RADAR_AXES.map((ax) => (has ? clamp(Number(radar[ax.key]) || 0, 0, 1000) : 0));
  RADAR_AXES.forEach((ax, i) => Fluid.count($(`radar-val-${i}`), Math.round(target[i])));
  const from = radarShown.slice();
  const shape = $('radar-shape');
  const nodes = $('radar-nodes').children;
  const draw = (p) => {
    radarShown = from.map((f, i) => f + (target[i] - f) * p);
    const pts = radarShown.map((v, i) => radarPoint(i, (Math.max(60, v) / 1000) * maxR * (has ? 1 : 0)));
    shape.setAttribute('points', pts.map((pt) => pt.map((n) => n.toFixed(1)).join(',')).join(' '));
    pts.forEach(([x, y], i) => { nodes[i].setAttribute('cx', x.toFixed(1)); nodes[i].setAttribute('cy', y.toFixed(1)); });
  };
  Fluid.whenVisible(svg, () => { radarDriver = Fluid.tween(draw, 'bounce'); });
}

function renderBio(u, has) {
  const hm = u.healthMetrics || {};
  $('bio-weight').textContent = has ? (hm.weight?.value || `${fmt(u.bodyweight, 1)} lb`) : '—';
  $('bio-bf').textContent = hm.bodyfat?.value || '—';
  $('bio-vol').textContent = has ? `${kfmt(u.weeklyVolume || 0)} lb` : '—';
  $('bio-streak').textContent = has ? `${u.recentWorkouts14d || 0} sessions` : '—';
}

// ---------------------------------------------------------------- evolution track

function renderTierTrack(tiers, rank, score) {
  const track = $('tier-track');
  if (!tiers.length) return;
  const curIdx = rank ? rank.tierIndex : -1;
  if (!SELECTED_TIER || !tiers.some((t) => t.id === SELECTED_TIER)) SELECTED_TIER = rank ? rank.tierId : tiers[0].id;
  const gradient = `linear-gradient(90deg, ${tiers.map((t) => safeColor(t.color)).join(', ')})`;

  setHTML(track, html`
    <span class="tier-line" style="background:${gradient}"></span>
    ${rank ? html`<span class="tier-marker" id="tier-marker"></span>` : ''}
    ${tiers.map((t, i) => html`
      <button type="button" class="tier-node ${i === curIdx ? 'is-current' : ''} ${curIdx >= 0 && i > curIdx ? 'is-locked' : ''} ${t.id === SELECTED_TIER ? 'is-selected' : ''}"
        data-press="chip" data-action="tier" data-tier="${t.id}" style="--c:${safeColor(t.color)}" aria-pressed="${t.id === SELECTED_TIER}">
        <span class="tier-dot"></span>
        <span class="t-num">${t.icon}</span>
        <span class="t-name">${t.name}</span>
        <span class="t-range">${t.max >= 1000 ? `${t.min}+` : `${t.min}–${t.max}`}</span>
      </button>`)}`);

  if (rank) {
    // Glide the droplet to your exact position inside your tier's column
    const t = tiers[curIdx];
    const frac = clamp((score - t.min) / (Math.min(t.max, 1000) - t.min), 0, 1);
    const marker = $('tier-marker');
    Fluid.whenVisible(marker, () => {
      const node = track.children[2 + curIdx];
      const left = node.offsetLeft + 12 + frac * (node.offsetWidth - 24);
      marker.style.left = `${left}px`;
      const scroller = $('tier-scroll');
      scroller.scrollTo({ left: node.offsetLeft - scroller.clientWidth / 2 + node.offsetWidth / 2, behavior: Fluid.reduced ? 'auto' : 'smooth' });
    });
  }
  renderTierDetail(tiers, rank);
}

function renderTierDetail(tiers, rank) {
  const t = tiers.find((x) => x.id === SELECTED_TIER);
  if (!t) return;
  const isCur = rank && rank.tierId === t.id;
  const box = $('tier-detail');
  box.style.setProperty('--rank', safeColor(t.color));
  setHTML(box, html`
    <span class="emblem" aria-hidden="true"><span class="emblem-blob"></span><span class="emblem-gloss"></span><span class="emblem-num">${t.icon}</span></span>
    <div class="swap-in">
      <h4>${t.name} ${isCur ? html`<span class="chip chip-rank">You are here</span>` : ''}</h4>
      <p>${t.desc}</p>
    </div>`);
}

// ---------------------------------------------------------------- exercise index

function sparkline(history, sessions) {
  const pts = (history || []).filter((h) => h.e1rm > 0).slice(-24);
  if (pts.length < 2) return html`<div class="empty" style="padding:14px">Log this lift a few more times to chart its trend.</div>`;
  const W = 300, H = 64, P = 4;
  const raw = pts.map((p) => p.e1rm);
  // Heavy and volume days alternate, so the line follows the running PR; sessions are faint dots
  let best = 0;
  const vals = raw.map((v) => (best = Math.max(best, v)));
  const lo = Math.min(...raw), hi = Math.max(...raw);
  const span = hi - lo || 1;
  const x = (i) => P + (i * (W - 2 * P)) / (pts.length - 1);
  const y = (v) => H - P - ((v - lo) / span) * (H - 2 * P);
  const xy = vals.map((v, i) => [x(i), y(v)]);
  // Catmull-Rom → cubic Bézier for a smooth, liquid curve
  let d = `M${xy[0][0].toFixed(1)} ${xy[0][1].toFixed(1)}`;
  for (let i = 0; i < xy.length - 1; i++) {
    const [p0, p1, p2, p3] = [xy[i - 1] || xy[i], xy[i], xy[i + 1], xy[i + 2] || xy[i + 1]];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  const area = `${d} L${xy[xy.length - 1][0].toFixed(1)} ${H} L${xy[0][0].toFixed(1)} ${H} Z`;
  const gid = `sg${Math.random().toString(36).slice(2, 8)}`;
  const delta = vals[vals.length - 1] - vals[0];
  return html`
    <svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style="stop-color:var(--c);stop-opacity:.32"/><stop offset="1" style="stop-color:var(--c);stop-opacity:0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#${gid})"/>
      ${raw.map((v, i) => html`<circle class="spark-dot" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.2"/>`)}
      <path class="spark-line" d="${d}" pathLength="1"/>
    </svg>
    <div class="spark-cap"><span>${pts[0].date}</span><b>${delta > 0 ? `+${fmt(delta, 1)} lb PR` : 'Holding PR'} · ${sessions} sessions</b><span>${pts[pts.length - 1].date}</span></div>`;
}

function exRow(ex) {
  const r = ex.rank;
  const nt = ex.nextTarget || {};
  const open = OPEN_EXERCISES.has(ex.name);
  const load = (w) => (nt.isBw ? (w > 0 ? `BW+${w}` : 'BW') : `${w} lb`);
  const maxed = nt.nextRankLabel === 'MAX RANK';
  return html`
    <article class="ex ${open ? 'is-open' : ''}" data-press="row" data-ex="${ex.name}" style="--c:${safeColor(r.color)}">
      <button type="button" class="ex-head" data-action="toggle-ex" aria-expanded="${open}">
        <span class="badge">${r.icon}</span>
        <span class="ex-main">
          <span class="ex-name">${ex.name}</span>
          <span class="ex-meta">${r.fullTitle} · ${r.lp} LP</span>
        </span>
        <span class="ex-side">
          <span class="ex-e1rm">${fmt(ex.best_e1rm, 1)}<small> lb</small></span>
          <span class="ex-score">Index ${fmt(ex.score, 1)}</span>
        </span>
        <svg class="ic ex-chev"><use href="#i-chev"/></svg>
      </button>
      <div class="ex-body" ${open ? new Html('style="height:auto"') : ''}>
        <div class="ex-body-inner">
          ${sparkline(ex.history, ex.sessions)}
          <div class="mini-stats">
            <div class="mini"><span>Peak set</span><b>${ex.best_set_str}</b></div>
            <div class="mini"><span>Next</span><b>${maxed ? 'Apex reached' : nt.nextRankLabel}</b></div>
            <div class="mini"><span>5-rep target</span><b>${maxed ? '—' : load(nt.rep5Weight)}</b></div>
            <div class="mini"><span>3-rep target</span><b>${maxed ? '—' : load(nt.rep3Weight)}</b></div>
          </div>
        </div>
      </div>
    </article>`;
}

function renderExercises() {
  const list = $('exercise-arsenal-list');
  const all = APP_STATE?.user?.exercises || [];
  const filtered = EX_FILTER === 'ALL' ? all : all.filter((x) => x.muscle === EX_FILTER);
  Fluid.count($('arsenal-count'), filtered.length);
  if (!all.length) {
    setHTML(list, html`<div class="empty"><svg class="ic"><use href="#i-egg"/></svg>Your ranked lifts appear here after your first sync.</div>`);
    return;
  }
  if (!filtered.length) {
    setHTML(list, html`<div class="empty">No ${EX_FILTER.toLowerCase()} lifts logged yet.</div>`);
    return;
  }
  setHTML(list, html`${filtered.map(exRow)}`);
  [...list.children].forEach((n, i) => { n.style.setProperty('--i', Math.min(i, 8)); n.classList.add('pop-in'); });
}

function toggleExercise(article) {
  const name = article.dataset.ex;
  const body = article.querySelector('.ex-body');
  const head = article.querySelector('.ex-head');
  const opening = !article.classList.contains('is-open');
  if (opening) OPEN_EXERCISES.add(name); else OPEN_EXERCISES.delete(name);
  article.classList.toggle('is-open', opening);
  head.setAttribute('aria-expanded', String(opening));
  // Height eases with a spring curve; snap to auto after so later reflows aren't fixed
  const from = body.getBoundingClientRect().height;
  body.style.height = 'auto';
  const to = opening ? body.scrollHeight : 0;
  body.style.height = `${from}px`;
  body.getBoundingClientRect();
  body.style.height = `${to}px`;
  const done = (e) => {
    if (e.target !== body || e.propertyName !== 'height') return;
    body.removeEventListener('transitionend', done);
    if (article.classList.contains('is-open')) body.style.height = 'auto';
  };
  body.addEventListener('transitionend', done);
}

function focusExercise(name) {
  EX_FILTER = 'ALL';
  muscleSeg?.select(0, { immediate: false });
  OPEN_EXERCISES.add(name);
  renderExercises();
  goTo('sec-arsenal');
  const row = [...$('exercise-arsenal-list').children].find((n) => n.dataset.ex === name);
  if (row) {
    const scroller = $('ex-scroller');
    setTimeout(() => {
      scroller.scrollTo({ top: row.offsetTop - scroller.offsetTop - 8, behavior: 'smooth' });
      Fluid.jelly(row, 0.5);
    }, 420);
  }
}

// ---------------------------------------------------------------- sessions

function renderNextWorkout(nw, has) {
  const box = $('next-workout-entries');
  if (!nw) {
    $('next-workout-title').textContent = has ? 'No session scheduled' : 'Waiting for sync';
    $('next-workout-prog').textContent = 'Read-only from /workout/next';
    setHTML(box, html`<div class="empty"><svg class="ic"><use href="#i-calendar"/></svg>${has ? 'Liftosaur has no upcoming workout for you.' : 'Your next prescribed session will show here.'}</div>`);
    return;
  }
  $('next-workout-title').textContent = nw.dayName || 'Next session';
  $('next-workout-prog').textContent = nw.programName || '';
  setHTML(box, html`${(nw.entries || []).map((e) => html`
    <div class="entry surface">
      <div class="entry-head"><b>${e.name}</b><span>${e.setsCount} sets</span></div>
      <div class="set-chips">
        ${(e.sets || []).slice(0, 6).map((s) => html`<span class="set-chip ${s.isAmrap ? 'amrap' : ''}">${s.weightVal > 0 ? s.weight : 'BW'} × ${s.reps}${s.isAmrap ? '+' : ''}</span>`)}
        ${(e.sets || []).length > 6 ? html`<span class="set-chip">+${e.sets.length - 6}</span>` : ''}
      </div>
      ${e.prChallenge ? html`
        <div class="pr-callout"><svg class="ic"><use href="#i-flame"/></svg>
          <span>Hit <b>${e.prChallenge.repsNeededForPR} reps</b> at ${e.prChallenge.weight > 0 ? `${fmt(e.prChallenge.weight)} lb` : 'bodyweight'} for a new PR · <b>${fmt(e.prChallenge.projectedE1rm, 1)} lb</b> e1RM</span>
        </div>` : ''}
    </div>`)}`);
}

function renderWorkoutLog(workouts) {
  const box = $('recent-workouts-list');
  if (!workouts.length) {
    setHTML(box, html`<div class="empty"><svg class="ic"><use href="#i-calendar"/></svg>Synced sessions will appear here.</div>`);
    return;
  }
  setHTML(box, html`${workouts.slice(0, 12).map((w) => {
    const d = parseUtc(w.date);
    const valid = !Number.isNaN(d.getTime());
    return html`
      <div class="log-row surface">
        <span class="date-blob"><b>${valid ? d.getDate() : '?'}</b><span>${valid ? d.toLocaleString(undefined, { month: 'short' }) : ''}</span></span>
        <span class="log-main">
          <b>${w.dayName}</b>
          <span>${(w.exercises || []).map((e) => `${e.name} ${Math.round(e.best_e1rm)}`).join(' · ')}</span>
        </span>
        <span class="log-side"><span class="lp-pill">+${w.lpEarned} LP</span><small>${kfmt(w.totalVolume)} lb</small></span>
      </div>`;
  })}`);
}

// ---------------------------------------------------------------- projection

function runCalculator() {
  clearTimeout(calcTimer);
  calcTimer = setTimeout(doCalculate, 60);
}

async function doCalculate() {
  const seq = ++CALC_SEQ;
  const exercise = $('calc-exercise').value;
  const body = {
    exercise,
    weight: Number($('calc-weight').value) || 0,
    reps: Number($('calc-reps').value) || 1,
    bodyweight: Number($('calc-bw').value) || 197,
    sex: APP_STATE?.user?.sex || 'M',
  };
  let r;
  try {
    r = (await api('/api/calculator', body)).result;
  } catch (err) {
    if (seq === CALC_SEQ) $('calc-res-comparison').textContent = err.message;
    return;
  }
  if (seq !== CALC_SEQ) return; // a newer slider position already superseded this answer

  const card = $('calc-result');
  const prevTier = card.dataset.tier;
  card.style.setProperty('--rank', safeColor(r.rank.color));
  card.dataset.tier = r.rank.tierId;
  $('calc-res-icon').textContent = r.rank.icon;
  $('calc-res-title').textContent = `${r.rank.fullTitle} · ${r.rank.lp} LP`;
  Fluid.count($('calc-res-e1rm'), r.e1rm, { decimals: 1 });
  Fluid.count($('calc-res-score'), r.score, { decimals: 1 });
  if (prevTier && prevTier !== r.rank.tierId) Fluid.jelly(card.querySelector('.emblem'), 1);

  const comp = $('calc-res-comparison');
  const existing = (APP_STATE?.user?.exercises || []).find((x) => x.name === exercise);
  if (!existing) {
    comp.textContent = 'No logged history for this lift yet.';
    comp.className = '';
  } else if (r.e1rm > existing.best_e1rm) {
    comp.textContent = `+${fmt(r.e1rm - existing.best_e1rm, 1)} lb over your PR (${fmt(existing.best_e1rm, 1)} lb)`;
    comp.className = 'up';
  } else {
    comp.textContent = `Your PR: ${fmt(existing.best_e1rm, 1)} lb · ${existing.rank.fullTitle}`;
    comp.className = '';
  }
}

function renderQuests(quests) {
  const box = $('solo-quests-list');
  if (!quests.length) {
    setHTML(box, html`<div class="empty"><svg class="ic"><use href="#i-flame"/></svg>Standards unlock after your first sync.</div>`);
    return;
  }
  setHTML(box, html`${quests.map((q) => {
    const pct = clamp(Math.round((q.current / Math.max(1, q.target)) * 100), 0, 100);
    return html`
      <div class="quest surface ${q.completed ? 'is-done' : ''}" data-press="row">
        <div class="quest-top">
          <span class="quest-ic">${q.completed ? html`<svg class="ic"><use href="#i-check"/></svg>` : q.icon}</span>
          <span class="quest-text"><b>${q.title}</b><span>${q.desc}</span></span>
          <span class="reward">+${q.rewardLp} LP</span>
        </div>
        <div>
          <div class="quest-meter"><span>${fmt(q.current)} / ${fmt(q.target)}</span><span>${pct}%</span></div>
          <div class="liquid-bar sm" style="--c:${q.completed ? 'var(--jade)' : 'var(--rank)'}"><div class="fill" data-fill="${pct}"></div></div>
        </div>
      </div>`;
  })}`);
  box.querySelectorAll('[data-fill]').forEach((f) => Fluid.fill(f, f.dataset.fill));
}

function renderThresholds(u, has) {
  const tt = u.tierTargets;
  const box = $('ghost-targets-grid');
  $('ghost-bw').textContent = has ? fmt(u.bodyweight, 1) : '—';
  if (!has || !tt) {
    $('targets-title').textContent = 'Tier thresholds';
    setHTML(box, html`<div class="empty">Sync to see the lifts that unlock your next tier.</div>`);
    return;
  }
  $('targets-title').textContent = `${tt.tierName} (Tier ${tt.tierIcon}) thresholds`;
  const card = $('targets-card');
  card.style.setProperty('--c', safeColor(tt.tierColor));
  setHTML(box, html`${tt.lifts.map((l) => {
    const pct = l.target > 0 ? clamp((l.current / l.target) * 100, 0, 100) : 0;
    const diff = l.target - l.current;
    return html`
      <div class="target surface" data-press="tile">
        <div class="target-top"><b>${l.name}</b><span>Goal ${fmt(l.target, 1)} lb</span></div>
        <div class="target-num">
          <b>${l.current > 0 ? fmt(l.current, 1) : '—'}<small> lb</small></b>
          ${diff <= 0 ? html`<span class="done">Reached</span>` : html`<span>${fmt(diff, 1)} lb to go</span>`}
        </div>
        <div class="liquid-bar sm" style="--c:${safeColor(tt.tierColor)}"><div class="fill" data-fill="${pct}"></div></div>
      </div>`;
  })}`);
  box.querySelectorAll('[data-fill]').forEach((f) => Fluid.fill(f, f.dataset.fill));
}

// ---------------------------------------------------------------- pack

function renderLeaderboard() {
  const box = $('pack-leaderboard-rows');
  const members = [...(APP_STATE?.packMembers || [])];
  const key = { overall: 'overallScore', dots: 'dotsScore', improved: 'lpGainedWeek', volume: 'weeklyVolume' }[LB_MODE];
  members.sort((a, b) => (Number(b[key]) || 0) - (Number(a[key]) || 0));

  Fluid.flip(box, 'data-key', () => setHTML(box, html`${members.map((m, idx) => {
    const r = m.overallRank || {};
    const stat = {
      overall: [fmt(m.overallScore, 1), `${r.fullTitle} · ${r.lp} LP`],
      dots: [`${fmt(m.dotsScore, 1)}`, `${fmt(m.sbdTotal)} lb SBD @ ${fmt(m.bodyweight)}`],
      improved: [`+${fmt(m.lpGainedWeek)} LP`, `${m.recentWorkouts14d} sessions / 14d`],
      volume: [`${kfmt(m.weeklyVolume)} lb`, '7-day volume'],
    }[LB_MODE];
    const bf = m.bigFour || {};
    return html`
      <div class="lb-row surface ${m.isMe ? 'is-me' : ''}" data-press="row" data-key="${m.id}">
        <span class="lb-pos ${idx === 0 ? 'p1' : ''}">${String(idx + 1).padStart(2, '0')}</span>
        <span class="avatar" style="--c:${safeColor(r.color)}">${r.icon || '?'}</span>
        <span class="lb-main">
          <span class="lb-name"><b>${m.callsign}</b>${m.isMe ? html`<span class="you-tag">You</span>` : ''}</span>
          <span class="lb-sub">${r.fullTitle} · S ${Math.round(bf.Squat || 0)} / B ${Math.round(bf['Bench Press'] || 0)} / D ${Math.round(bf.Deadlift || 0)}</span>
        </span>
        <span class="lb-stat"><b>${stat[0]}</b><span>${stat[1]}</span></span>
      </div>`;
  })}`));
}

function renderObjective(b) {
  if (!b) return;
  const pct = clamp(100 - (b.currentHp / Math.max(1, b.maxHp)) * 100, 0, 100);
  const tank = $('raid-tank');
  Fluid.whenVisible(tank, () => tank.style.setProperty('--level', (pct / 100).toFixed(4)));
  Fluid.count($('raid-hp-pct'), pct, { decimals: pct < 100 ? 1 : 0, suffix: '%' });
  Fluid.count($('raid-total'), b.totalVolume || 0);
  Fluid.count($('raid-hp-cur'), b.currentHp);
  $('raid-hp-max').textContent = fmt(b.maxHp);

  const top = Math.max(1, ...(b.combatLog || []).map((c) => c.damage));
  const box = $('raid-combat-log');
  setHTML(box, html`${(b.combatLog || []).slice(0, 6).map((c) => html`
    <div class="contrib surface">
      <div class="contrib-top"><b>${c.attacker}${c.isMe ? ' (you)' : ''}</b><span>${fmt(c.damage)} lb</span></div>
      <div class="liquid-bar sm" style="--c:${c.isMe ? 'var(--rank)' : 'var(--amber)'}"><div class="fill" data-fill="${((c.damage / top) * 100).toFixed(1)}"></div></div>
      <small>${c.move}</small>
    </div>`)}`);
  box.querySelectorAll('[data-fill]').forEach((f) => Fluid.fill(f, f.dataset.fill));
}

function renderDuels(duels, has) {
  const box = $('duels-list');
  if (!duels.length) {
    setHTML(box, html`<div class="empty"><svg class="ic"><use href="#i-pack"/></svg>${has ? 'No active comparisons.' : 'Comparisons start once you sync.'}</div>`);
    return;
  }
  setHTML(box, html`${duels.map((d) => {
    const goal = Math.max(1, d.target_goal);
    const me = clamp((d.user_progress / goal) * 100, 0, 100);
    const them = clamp((d.opponent_progress / goal) * 100, 0, 100);
    const dp = /e1rm/i.test(d.unit) ? 1 : 0;
    return html`
      <div class="duel surface" data-press="row">
        <div class="duel-top"><b>${d.metric_type}</b><span>${d.expires_in}</span></div>
        <div class="duel-side">
          <div class="duel-meta"><span>${d.challenger_name}</span><span>${fmt(d.user_progress, dp)} / ${fmt(goal)} ${d.unit}</span></div>
          <div class="liquid-bar sm"><div class="fill" data-fill="${me.toFixed(1)}"></div></div>
        </div>
        <span class="duel-vs">VS</span>
        <div class="duel-side">
          <div class="duel-meta"><span>${d.opponent_name} · ${d.opponent_rank}</span><span>${fmt(d.opponent_progress, dp)} / ${fmt(goal)} ${d.unit}</span></div>
          <div class="liquid-bar sm" style="--c:var(--amber)"><div class="fill" data-fill="${them.toFixed(1)}"></div></div>
        </div>
      </div>`;
  })}`);
  box.querySelectorAll('[data-fill]').forEach((f) => Fluid.fill(f, f.dataset.fill));
}

function renderFeed(feed) {
  const box = $('social-feed-list');
  if (!feed.length) {
    setHTML(box, html`<div class="empty"><svg class="ic"><use href="#i-foot"/></svg>Pack activity shows up here after your first sync.</div>`);
    return;
  }
  setHTML(box, html`${feed.map((f) => {
    const [label, color] = EVENT_TAGS[f.event_type] || ['Update', '#8b978e'];
    return html`
      <div class="post surface" data-press="row">
        <div class="post-top">
          <span class="avatar sm" style="--c:${safeColor(f.rank_color)}">${f.avatar}</span>
          <span class="post-who"><b>${f.callsign}</b><span>${f.rank_title}</span></span>
          <span class="event-tag" style="--c:${color}">${label}</span>
        </div>
        <h4>${f.headline}</h4>
        <p>${f.detail}</p>
        <div class="post-foot">
          <span>${f.created_at}</span>
          <button type="button" class="hype" data-press="btn" data-action="hype" data-post="${f.id}" aria-label="Hype this post">
            <svg class="ic ic-fill"><use href="#i-foot"/></svg><span class="hype-count" data-n="${f.hype_count}">${f.hype_count}</span>
          </button>
        </div>
      </div>`;
  })}`);
}

// ---------------------------------------------------------------- key vault

function renderVault(u, has) {
  const callsign = $('vault-callsign');
  if (document.activeElement !== callsign) callsign.value = u.callsign || '';
  if (has) $('vault-sex').value = u.sex === 'F' ? 'F' : 'M';
  $('vault-masked-display').textContent = has ? u.maskedKey : 'None stored';
  $('telemetry-time').textContent = has ? `Last synced ${u.syncedAt}` : 'Not synced yet';
  Fluid.count($('tel-workouts'), u.workoutsCount || 0);
  $('tel-bw').textContent = has ? `${fmt(u.bodyweight, 1)} lb` : '—';
  $('tel-next').textContent = u.nextWorkout ? u.nextWorkout.dayName : '—';
  Fluid.count($('tel-progs'), u.programsCount || 0);
}

// ---------------------------------------------------------------- navigation

let dock = null;
let muscleSeg = null;
let lbSeg = null;
let spyLockUntil = 0;

function goTo(id) {
  const idx = SECTIONS.indexOf(id);
  if (idx >= 0) dock?.select(idx);
  spyLockUntil = performance.now() + 900;
  $(id)?.scrollIntoView({ behavior: Fluid.reduced ? 'auto' : 'smooth', block: 'start' });
}

function scrollSpy() {
  if (performance.now() < spyLockUntil || !dock) return;
  const line = window.innerHeight * 0.35;
  let current = 0;
  SECTIONS.forEach((id, i) => { if ($(id).getBoundingClientRect().top <= line) current = i; });
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = SECTIONS.length - 1;
  if (current !== dock.index) dock.select(current);
}

// ---------------------------------------------------------------- wiring

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  switch (el.dataset.action) {
    case 'sync': syncLiveKey(); break;
    case 'jelly': Fluid.jelly(el, 1.3); break;
    case 'toggle-ex': toggleExercise(el.closest('.ex')); break;
    case 'focus-ex': focusExercise(el.dataset.ex); break;
    case 'hype': hypePost(el); break;
    case 'tier': {
      SELECTED_TIER = el.dataset.tier;
      el.parentElement.querySelectorAll('.tier-node').forEach((n) => {
        const on = n === el;
        n.classList.toggle('is-selected', on);
        n.setAttribute('aria-pressed', String(on));
      });
      renderTierDetail(APP_STATE?.rankTiers || [], APP_STATE?.user?.overallRank);
      Fluid.jelly(el.querySelector('.tier-dot'), 1.4);
      break;
    }
    default: break;
  }
});

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.reveal').forEach((el, i) => { if (!el.style.getPropertyValue('--i')) el.style.setProperty('--i', i % 3); });
  Fluid.observeReveals();
  Fluid.ambient();
  ['ex-scroller', 'log-scroller'].forEach((id) => Fluid.rubberScroll($(id)));

  dock = Fluid.liquid($('dock'), { onSelect: (i) => goTo(SECTIONS[i]) });
  dock.select(0, { immediate: true });
  let spyQueued = false;
  window.addEventListener('scroll', () => {
    if (spyQueued) return;
    spyQueued = true;
    requestAnimationFrame(() => { spyQueued = false; scrollSpy(); });
  }, { passive: true });

  muscleSeg = Fluid.liquid($('muscle-seg'), {
    onSelect: (i) => {
      const v = $('muscle-seg').querySelector(`[data-index="${i}"]`).dataset.value;
      if (v === EX_FILTER) return;
      EX_FILTER = v;
      renderExercises();
    },
  });
  muscleSeg.select(0, { immediate: true });

  lbSeg = Fluid.liquid($('lb-seg'), {
    onSelect: (i) => {
      if (LB_MODES[i] === LB_MODE) return;
      LB_MODE = LB_MODES[i];
      renderLeaderboard();
    },
  });
  lbSeg.select(0, { immediate: true });

  Fluid.slider($('calc-weight'), { format: (v) => `${v} lb`, onInput: runCalculator });
  Fluid.slider($('calc-reps'), { format: (v) => `${v} ${v === 1 ? 'rep' : 'reps'}`, onInput: runCalculator });
  $('calc-exercise').addEventListener('change', runCalculator);
  $('calc-bw').addEventListener('input', () => { calcBwTouched = true; runCalculator(); });

  $('vault-form').addEventListener('submit', saveAndSyncKey);
  $('peer-form').addEventListener('submit', addPackFriend);

  loadState();
});
