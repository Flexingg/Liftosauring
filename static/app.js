// Liftosauring — Read-Only Strength Telemetry & Ranking Controller
let APP_STATE = null;
let CURRENT_LB_MODE = 'overall';
let SCROLL_OBSERVER = null;

document.addEventListener('DOMContentLoaded', () => {
  initScrollReveal();
  loadState();
});

function initScrollReveal() {
  SCROLL_OBSERVER = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
      }
    });
  }, {
    threshold: 0.08,
    rootMargin: '0px 0px -40px 0px'
  });

  document.querySelectorAll('.reveal-on-scroll').forEach(el => {
    SCROLL_OBSERVER.observe(el);
  });
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  const style = type === 'error'
    ? 'border-rose-500/40 bg-zinc-950/95 text-rose-200'
    : 'border-white/15 bg-zinc-900/95 text-zinc-200';
  el.className = `px-4 py-3 rounded-lg border ${style} shadow-xl backdrop-blur-md text-xs font-mono flex items-center gap-2.5 transition-all duration-300`;
  el.innerHTML = `
    <span class="w-1.5 h-1.5 rounded-full ${type === 'error' ? 'bg-rose-400' : 'bg-emerald-400'} shrink-0"></span>
    <div class="leading-snug">${message}</div>
  `;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 3800);
}

async function loadState() {
  try {
    const res = await fetch('/api/state');
    const json = await res.json();
    if (json.ok) {
      APP_STATE = json.data;
      renderAll();
      runRankCalculator();
    } else {
      showToast(json.error || 'Failed to load telemetry', 'error');
    }
  } catch (err) {
    showToast('Network error: ' + err.message, 'error');
  }
}

async function syncLiveKey() {
  const btn = document.getElementById('btn-sync-now');
  const icon = document.getElementById('sync-icon');
  if (btn) btn.disabled = true;
  if (icon) icon.classList.add('animate-spin');

  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const json = await res.json();
    if (json.ok) {
      APP_STATE = json.data;
      renderAll();
      showToast(json.message || 'Liftosaur telemetry synced.');
    } else {
      showToast(json.error || 'Sync failed', 'error');
    }
  } catch (err) {
    showToast('Error syncing with Liftosaur: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (icon) icon.classList.remove('animate-spin');
  }
}

async function saveAndSyncKey(e) {
  e.preventDefault();
  const callsign = document.getElementById('vault-callsign').value.trim();
  const sex = document.getElementById('vault-sex').value;
  const apiKey = document.getElementById('vault-apikey').value.trim();

  showToast('Validating Liftosaur API token...');
  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callsign, sex, apiKey })
    });
    const json = await res.json();
    if (json.ok) {
      APP_STATE = json.data;
      document.getElementById('vault-apikey').value = '';
      renderAll();
      showToast(json.message || 'API Key validated & synced.');
    } else {
      showToast(json.error || 'Invalid API Key', 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

function renderAll() {
  if (!APP_STATE || !APP_STATE.user) return;
  const u = APP_STATE.user;
  const r = u.overallRank || {};

  document.getElementById('header-masked-key').textContent = u.maskedKey || 'lftsk_connected';

  // Hero Rank Card
  const emblem = document.getElementById('hero-rank-emblem');
  emblem.textContent = r.icon || 'VI';
  emblem.style.color = r.color || '#34d399';
  emblem.style.borderColor = `${r.color || '#34d399'}40`;

  document.getElementById('hero-callsign').textContent = (u.callsign || 'JONATHAN').toUpperCase();
  document.getElementById('hero-bw-pill').textContent = `${u.bodyweight || 197} lb`;
  document.getElementById('hero-program-pill').textContent = (u.activeProgram || '5/3/1 BBB').slice(0, 28);

  const titleEl = document.getElementById('hero-rank-title');
  titleEl.textContent = r.fullTitle || 'Stegosaurus III';

  document.getElementById('hero-rank-desc').textContent = r.desc || '';
  document.getElementById('hero-overall-score').textContent = u.overallScore || 0;
  document.getElementById('hero-dots-score').textContent = u.dotsScore || 0;
  document.getElementById('hero-sbd-total').textContent = u.sbdTotal || 0;

  document.getElementById('hero-lp-val').textContent = r.lp ?? 0;
  document.getElementById('hero-pts-needed').textContent = r.scoreNeededForNext ?? 5;
  document.getElementById('hero-next-rank').textContent = r.nextRankLabel || 'Next Division';
  document.getElementById('hero-lp-bar').style.width = `${Math.max(3, Math.min(100, r.lp || 0))}%`;

  // Primary Compound Cards
  const findEx = (name) => (u.exercises || []).find(x => x.name === name);
  const sq = findEx('Squat');
  const bp = findEx('Bench Press');
  const dl = findEx('Deadlift');
  const ohp = findEx('Overhead Press');

  if (sq) {
    document.getElementById('b4-squat').textContent = Math.round(sq.best_e1rm);
    document.getElementById('b4-squat-tier').textContent = sq.rank.fullTitle;
    document.getElementById('b4-squat-set').textContent = sq.best_set_str;
  }
  if (bp) {
    document.getElementById('b4-bench').textContent = Math.round(bp.best_e1rm);
    document.getElementById('b4-bench-tier').textContent = bp.rank.fullTitle;
    document.getElementById('b4-bench-set').textContent = bp.best_set_str;
  }
  if (dl) {
    document.getElementById('b4-dead').textContent = Math.round(dl.best_e1rm);
    document.getElementById('b4-dead-tier').textContent = dl.rank.fullTitle;
    document.getElementById('b4-dead-set').textContent = dl.best_set_str;
  }
  if (ohp) {
    document.getElementById('b4-ohp').textContent = Math.round(ohp.best_e1rm);
    document.getElementById('b4-ohp-tier').textContent = ohp.rank.fullTitle;
    document.getElementById('b4-ohp-set').textContent = ohp.best_set_str;
  }

  // Biometrics strip
  const hm = u.healthMetrics || {};
  document.getElementById('bio-weight').textContent = hm.weight ? hm.weight.value : `${u.bodyweight} lb`;
  document.getElementById('bio-bf').textContent = hm.bodyfat ? hm.bodyfat.value : '20%';
  document.getElementById('bio-vol').textContent = `${((u.weeklyVolume || 0) / 1000).toFixed(1)}k lb`;
  document.getElementById('bio-streak').textContent = `${u.recentWorkouts14d || 0} Sessions`;

  renderMuscleRadar(u.muscleRadar || {});
  renderTierLadder(APP_STATE.rankTiers || [], r.tierId);
  renderExerciseArsenal();
  renderNextWorkout(u.nextWorkout);
  renderRecentWorkouts(u.workouts || []);
  renderSoloQuests(u.quests || []);
  renderGhostTargets(u);
  renderPackLeaderboard();
  renderRaidAndSocial();

  // API Telemetry
  document.getElementById('vault-callsign').value = u.callsign || 'Jonathan';
  document.getElementById('vault-masked-display').textContent = u.maskedKey || 'lftsk_••••';
  document.getElementById('telemetry-time').textContent = u.syncedAt || 'Synced';
  document.getElementById('tel-workouts').textContent = u.workoutsCount || 0;
  document.getElementById('tel-bw').textContent = `${u.bodyweight || 197} lb`;
  document.getElementById('tel-next').textContent = u.nextWorkout ? u.nextWorkout.dayName : 'Scheduled';
  document.getElementById('tel-progs').textContent = u.programsCount || 27;
  document.getElementById('calc-bw').value = u.bodyweight || 197;
}

function renderMuscleRadar(radar) {
  const svg = document.getElementById('muscle-radar-svg');
  if (!svg) return;

  const axes = [
    { key: 'Chest', label: 'CHEST' },
    { key: 'Shoulders', label: 'SHOULDERS' },
    { key: 'Arms', label: 'ARMS' },
    { key: 'Discipline', label: 'CADENCE' },
    { key: 'Legs', label: 'LEGS' },
    { key: 'Back', label: 'BACK' }
  ];

  const cx = 150, cy = 122, maxR = 80;
  let html = '';

  [0.25, 0.5, 0.75, 1.0].forEach(level => {
    const r = maxR * level;
    const pts = axes.map((_, i) => {
      const angle = (Math.PI * 2 * i) / axes.length - Math.PI / 2;
      return `${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`;
    }).join(' ');
    html += `<polygon points="${pts}" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="1" />`;
  });

  axes.forEach((ax, i) => {
    const angle = (Math.PI * 2 * i) / axes.length - Math.PI / 2;
    const x2 = cx + maxR * Math.cos(angle);
    const y2 = cy + maxR * Math.sin(angle);
    const lx = cx + (maxR + 26) * Math.cos(angle);
    const ly = cy + (maxR + 17) * Math.sin(angle);
    const val = Math.round(radar[ax.key] || 500);

    html += `<line x1="${cx}" y1="${cy}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="rgba(255,255,255,0.07)" stroke-width="1" />`;
    html += `
      <text x="${lx.toFixed(1)}" y="${(ly - 2).toFixed(1)}" text-anchor="middle" fill="#a1a1aa" font-size="8.5" font-family="Inter" font-weight="600" letter-spacing="0.05em">${ax.label}</text>
      <text x="${lx.toFixed(1)}" y="${(ly + 9).toFixed(1)}" text-anchor="middle" fill="#f4f4f5" font-size="9" font-family="JetBrains Mono" font-weight="500">${val}</text>
    `;
  });

  const dataPts = axes.map((ax, i) => {
    const val = Math.max(100, Math.min(1000, radar[ax.key] || 500));
    const r = (val / 1000.0) * maxR;
    const angle = (Math.PI * 2 * i) / axes.length - Math.PI / 2;
    return {
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle)
    };
  });

  const polyStr = dataPts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  html += `<polygon points="${polyStr}" fill="rgba(52, 211, 153, 0.14)" stroke="#34d399" stroke-width="1.75" />`;
  dataPts.forEach(p => {
    html += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.75" fill="#f4f4f5" stroke="#090a0c" stroke-width="1.2" />`;
  });

  svg.innerHTML = html;
}

function renderTierLadder(tiers, activeTierId) {
  const container = document.getElementById('tier-ladder-strip');
  if (!container) return;

  container.innerHTML = tiers.map(t => {
    const isCurrent = t.id === activeTierId;
    return `
      <div class="rounded-xl p-3 border transition-all ${isCurrent ? 'bg-zinc-900 border-white/25' : 'panel-subtle opacity-60 hover:opacity-95'}">
        <div class="flex items-center justify-between font-mono text-[10px]">
          <span class="text-zinc-300 font-semibold">${t.icon}</span>
          <span class="text-zinc-500">${t.min}</span>
        </div>
        <div class="font-display font-medium text-xs mt-1.5 truncate" style="color: ${t.color}">${t.name}</div>
        ${isCurrent ? `<div class="text-[9px] font-mono uppercase text-emerald-400 mt-0.5">Current</div>` : `<div class="text-[9px] font-mono text-zinc-600 mt-0.5">${t.max === 1500 ? '940+' : t.min + '–' + t.max}</div>`}
      </div>
    `;
  }).join('');
}

function renderExerciseArsenal() {
  const container = document.getElementById('exercise-arsenal-list');
  if (!container || !APP_STATE || !APP_STATE.user) return;

  const filter = document.getElementById('muscle-filter').value;
  const allEx = APP_STATE.user.exercises || [];
  const filtered = filter === 'ALL' ? allEx : allEx.filter(x => x.muscle === filter);

  document.getElementById('arsenal-count').textContent = filtered.length;

  container.innerHTML = filtered.map(ex => {
    const r = ex.rank;
    const nt = ex.nextTarget;
    return `
      <div class="panel-subtle hover:border-white/10 rounded-xl p-3.5 transition flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="flex items-center gap-3.5">
          <div class="w-9 h-9 rounded-lg bg-zinc-900 border border-white/[0.07] flex items-center justify-center font-mono text-xs font-semibold shrink-0" style="color: ${r.color}">
            ${r.icon}
          </div>
          <div>
            <div class="flex items-center gap-2.5 flex-wrap">
              <span class="font-medium text-sm text-zinc-100">${ex.name}</span>
              <span class="text-[11px] font-mono text-zinc-400">
                ${r.fullTitle} <span class="text-zinc-600">·</span> ${r.lp} LP
              </span>
            </div>
            <div class="text-xs text-zinc-500 mt-0.5 flex items-center gap-2.5 flex-wrap font-mono">
              <span>Peak: <span class="text-zinc-300">${ex.best_set_str}</span></span>
              <span>·</span>
              <span>${ex.sessions} sessions</span>
              <span>·</span>
              <span class="text-zinc-400">${nt.nextRankLabel} @ ${nt.rep5Weight}lb × 5</span>
            </div>
          </div>
        </div>

        <div class="flex sm:flex-col items-center sm:items-end justify-between shrink-0 border-t sm:border-t-0 border-white/[0.05] pt-2 sm:pt-0">
          <div class="font-display font-semibold text-base text-zinc-100">${ex.best_e1rm} <span class="text-xs font-normal text-zinc-500">lb e1RM</span></div>
          <div class="text-[11px] font-mono text-zinc-500">Index <span class="text-zinc-300">${ex.score}</span></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderNextWorkout(nw) {
  const container = document.getElementById('next-workout-entries');
  if (!container) return;
  if (!nw) {
    container.innerHTML = `<div class="text-xs text-zinc-500">No upcoming session scheduled.</div>`;
    return;
  }

  document.getElementById('next-workout-title').textContent = nw.dayName || 'Next Session';
  document.getElementById('next-workout-prog').textContent = nw.programName || '';

  container.innerHTML = (nw.entries || []).map(e => {
    const setsTags = (e.sets || []).slice(0, 5).map(s =>
      `<span class="px-2 py-0.5 rounded bg-zinc-900 border ${s.isAmrap ? 'border-emerald-500/40 text-emerald-300' : 'border-white/[0.06] text-zinc-400'} text-[11px] font-mono">${s.weight} × ${s.reps}${s.isAmrap ? '+' : ''}</span>`
    ).join('');
    const moreCount = (e.sets || []).length > 5 ? `<span class="text-[10px] font-mono text-zinc-500">+${e.sets.length - 5} sets</span>` : '';

    const prBox = e.prChallenge ? `
      <div class="mt-2.5 pt-2.5 border-t border-white/[0.05] flex items-center justify-between gap-2 text-[11px] font-mono text-zinc-400">
        <span>PR Threshold on ${e.prChallenge.weight}lb AMRAP:</span>
        <span class="text-emerald-400 font-medium">${e.prChallenge.repsNeededForPR} reps (${e.prChallenge.projectedE1rm} lb e1RM)</span>
      </div>
    ` : '';

    return `
      <div class="panel-subtle rounded-xl p-3.5">
        <div class="flex items-center justify-between">
          <span class="font-medium text-xs text-zinc-200">${e.name}</span>
          <span class="text-[11px] font-mono text-zinc-500">${e.setsCount} working sets</span>
        </div>
        <div class="flex flex-wrap items-center gap-1.5 mt-2">
          ${setsTags} ${moreCount}
        </div>
        ${prBox}
      </div>
    `;
  }).join('');
}

function renderRecentWorkouts(workouts) {
  const container = document.getElementById('recent-workouts-list');
  if (!container) return;

  container.innerHTML = workouts.slice(0, 12).map(w => {
    const exNames = (w.exercises || []).map(e => `${e.name} (${Math.round(e.best_e1rm)}lb)`).join(', ');
    return `
      <div class="panel-subtle rounded-xl p-3 flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="font-medium text-xs text-zinc-200">${w.dayName}</span>
            <span class="text-[10px] font-mono text-zinc-500">${w.date.slice(0, 10)}</span>
          </div>
          <div class="text-[11px] text-zinc-500 truncate mt-0.5">${exNames}</div>
        </div>
        <div class="text-right shrink-0 font-mono">
          <div class="text-xs text-emerald-400">+${w.lpEarned} LP</div>
          <div class="text-[10px] text-zinc-500">${Math.round(w.totalVolume).toLocaleString()} lbs</div>
        </div>
      </div>
    `;
  }).join('');
}

function renderSoloQuests(quests) {
  const container = document.getElementById('solo-quests-list');
  if (!container) return;

  container.innerHTML = quests.map(q => {
    const pct = Math.min(100, Math.round((q.current / Math.max(1, q.target)) * 100));
    return `
      <div class="panel-subtle rounded-xl p-4 space-y-2.5">
        <div class="flex items-start justify-between gap-3">
          <div class="flex items-start gap-3">
            <span class="font-mono text-xs text-zinc-500 pt-0.5">${q.icon}</span>
            <div>
              <div class="font-medium text-xs text-zinc-200 flex items-center gap-2">
                <span>${q.title}</span>
                ${q.completed ? `<span class="text-[10px] font-mono text-emerald-400">Completed</span>` : ''}
              </div>
              <p class="text-[11px] text-zinc-500 mt-0.5">${q.desc}</p>
            </div>
          </div>
          <div class="text-right font-mono text-xs text-zinc-400 shrink-0">
            +${q.rewardLp} LP
          </div>
        </div>
        <div class="space-y-1">
          <div class="flex justify-between text-[10px] font-mono text-zinc-500">
            <span>${q.current.toLocaleString()} / ${q.target.toLocaleString()}</span>
            <span>${pct}%</span>
          </div>
          <div class="w-full h-1.5 bg-zinc-900 rounded-full overflow-hidden">
            <div class="h-full bg-zinc-300" style="width: ${pct}%"></div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderGhostTargets(u) {
  const container = document.getElementById('ghost-targets-grid');
  if (!container) return;
  document.getElementById('ghost-bw').textContent = u.bodyweight || 197;

  const targets = [
    { name: 'Squat', cur: u.bigFour?.Squat || 341, target: 395 },
    { name: 'Bench Press', cur: u.bigFour?.['Bench Press'] || 269.5, target: 295 },
    { name: 'Deadlift', cur: u.bigFour?.Deadlift || 280, target: 445 },
    { name: 'Overhead Press', cur: u.bigFour?.['Overhead Press'] || 175, target: 195 },
  ];

  container.innerHTML = targets.map(t => {
    const pct = Math.min(100, Math.round((t.cur / t.target) * 100));
    const diff = Math.max(0, (t.target - t.cur).toFixed(1));
    return `
      <div class="panel-subtle rounded-xl p-3.5 space-y-2">
        <div class="flex items-center justify-between text-xs">
          <span class="font-medium text-zinc-200">${t.name}</span>
          <span class="font-mono text-[11px] text-zinc-500">Target: ${t.target} lb</span>
        </div>
        <div class="flex items-baseline justify-between font-mono">
          <span class="text-sm font-semibold text-zinc-100">${t.cur} <span class="text-[11px] font-normal text-zinc-500">lb</span></span>
          <span class="text-[11px] text-zinc-500">${diff > 0 ? `-${diff} lb` : 'Reached'}</span>
        </div>
        <div class="w-full h-1.5 bg-zinc-900 rounded-full overflow-hidden">
          <div class="h-full bg-emerald-400/80" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

async function runRankCalculator() {
  const exercise = document.getElementById('calc-exercise').value;
  const weight = parseFloat(document.getElementById('calc-weight').value || 225);
  const reps = parseInt(document.getElementById('calc-reps').value || 5, 10);
  const bodyweight = parseFloat(document.getElementById('calc-bw').value || 197);

  try {
    const res = await fetch('/api/calculator', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exercise, weight, reps, bodyweight, sex: APP_STATE?.user?.sex || 'M' })
    });
    const json = await res.json();
    if (json.ok) {
      const r = json.result;
      document.getElementById('calc-res-icon').textContent = r.rank.icon;
      document.getElementById('calc-res-icon').style.color = r.rank.color;
      document.getElementById('calc-res-title').textContent = `${r.rank.fullTitle} (${r.rank.lp} LP)`;
      document.getElementById('calc-res-e1rm').innerHTML = `${r.e1rm} <span class="text-xs font-normal text-zinc-500">lb</span>`;
      document.getElementById('calc-res-score').textContent = r.score;

      const existing = (APP_STATE?.user?.exercises || []).find(x => x.name === exercise);
      const compEl = document.getElementById('calc-res-comparison');
      if (existing) {
        const diff = (r.e1rm - existing.best_e1rm).toFixed(1);
        if (diff > 0) {
          compEl.textContent = `+${diff} lb above historical PR (${existing.best_e1rm} lb)`;
          compEl.className = 'text-xs text-emerald-400 font-mono mt-0.5';
        } else {
          compEl.textContent = `Historical PR: ${existing.best_e1rm} lb (${existing.rank.fullTitle})`;
          compEl.className = 'text-xs text-zinc-500 font-mono mt-0.5';
        }
      }
    }
  } catch (e) {}
}

function setLeaderboardMode(mode) {
  CURRENT_LB_MODE = mode;
  ['overall', 'dots', 'improved', 'volume'].forEach(m => {
    const btn = document.getElementById(`lb-mode-${m}`);
    if (btn) {
      if (m === mode) {
        btn.className = 'lb-mode-btn px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-100 text-zinc-950 transition';
      } else {
        btn.className = 'lb-mode-btn px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-100 transition';
      }
    }
  });
  renderPackLeaderboard();
}

function renderPackLeaderboard() {
  const container = document.getElementById('pack-leaderboard-rows');
  if (!container || !APP_STATE) return;

  const members = [...(APP_STATE.packMembers || [])];
  if (CURRENT_LB_MODE === 'overall') {
    members.sort((a, b) => b.overallScore - a.overallScore);
  } else if (CURRENT_LB_MODE === 'dots') {
    members.sort((a, b) => b.dotsScore - a.dotsScore);
  } else if (CURRENT_LB_MODE === 'improved') {
    members.sort((a, b) => b.lpGainedWeek - a.lpGainedWeek);
  } else if (CURRENT_LB_MODE === 'volume') {
    members.sort((a, b) => b.weeklyVolume - a.weeklyVolume);
  }

  container.innerHTML = members.map((m, idx) => {
    const r = m.overallRank || {};
    let primaryStat = '';
    let subStat = '';

    if (CURRENT_LB_MODE === 'overall') {
      primaryStat = `${m.overallScore}`;
      subStat = `${r.fullTitle} · ${r.lp} LP`;
    } else if (CURRENT_LB_MODE === 'dots') {
      primaryStat = `${m.dotsScore} DOTS`;
      subStat = `${m.sbdTotal} lb SBD @ ${m.bodyweight} lb`;
    } else if (CURRENT_LB_MODE === 'improved') {
      primaryStat = `+${m.lpGainedWeek} LP`;
      subStat = `${m.recentWorkouts14d} sessions / 14d`;
    } else {
      primaryStat = `${m.weeklyVolume.toLocaleString()} lbs`;
      subStat = `7-Day Volume`;
    }

    return `
      <div class="rounded-xl p-4 border transition flex flex-col md:flex-row md:items-center justify-between gap-4 ${m.isMe ? 'bg-zinc-900/90 border-white/20' : 'panel-subtle'}">
        <div class="flex items-center gap-4">
          <div class="w-6 text-center font-mono text-xs text-zinc-500">0${idx + 1}</div>
          <div class="w-10 h-10 rounded-lg bg-zinc-900 border border-white/[0.07] flex items-center justify-center font-mono text-xs font-semibold shrink-0" style="color: ${r.color || '#e4e4e7'}">
            ${r.icon || 'VI'}
          </div>
          <div>
            <div class="flex items-center gap-2.5 flex-wrap">
              <span class="font-medium text-sm text-zinc-100">${m.callsign}</span>
              ${m.isMe ? `<span class="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-200">Active Key</span>` : ''}
              <span class="text-xs font-mono text-zinc-400">${r.fullTitle}</span>
            </div>
            <div class="text-xs text-zinc-500 mt-0.5 flex items-center gap-2.5 flex-wrap font-mono">
              <span>${m.liveStatus}</span>
              <span>·</span>
              <span>S ${Math.round(m.bigFour?.Squat || 0)} / B ${Math.round(m.bigFour?.['Bench Press'] || 0)} / D ${Math.round(m.bigFour?.Deadlift || 0)}</span>
            </div>
          </div>
        </div>

        <div class="flex md:flex-col items-center md:items-end justify-between border-t md:border-t-0 border-white/[0.05] pt-2 md:pt-0 shrink-0">
          <div class="font-display font-semibold text-lg text-zinc-100">${primaryStat}</div>
          <div class="text-[11px] font-mono text-zinc-500">${subStat}</div>
        </div>
      </div>
    `;
  }).join('');
}

async function addPackFriend(e) {
  e.preventDefault();
  const callsign = document.getElementById('friend-name').value.trim();
  const apiKey = document.getElementById('friend-apikey').value.trim();
  const sex = document.getElementById('friend-sex').value;

  showToast(`Syncing ${callsign}'s Liftosaur API key...`);
  try {
    const res = await fetch('/api/pack/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callsign, apiKey, sex })
    });
    const json = await res.json();
    if (json.ok) {
      APP_STATE = json.data;
      document.getElementById('friend-name').value = '';
      document.getElementById('friend-apikey').value = '';
      renderAll();
      showToast(`Added ${callsign} to Pack standings.`);
    } else {
      showToast(json.error || 'Could not sync peer key', 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

function renderRaidAndSocial() {
  if (!APP_STATE) return;
  const boss = APP_STATE.raidBoss;
  if (boss) {
    document.getElementById('raid-boss-name').textContent = boss.name;
    document.getElementById('raid-hp-cur').textContent = boss.currentHp.toLocaleString();
    document.getElementById('raid-hp-max').textContent = boss.maxHp.toLocaleString();
    const hpPct = Math.max(0, Math.min(100, (boss.currentHp / boss.maxHp) * 100));
    const dmgPct = (100 - hpPct).toFixed(1);
    document.getElementById('raid-hp-pct').textContent = `${dmgPct}% Complete`;
    document.getElementById('raid-hp-bar').style.width = `${dmgPct}%`;

    const logEl = document.getElementById('raid-combat-log');
    logEl.innerHTML = (boss.combatLog || []).slice(0, 5).map(c => `
      <div class="panel-subtle rounded-lg px-3.5 py-2.5 flex items-center justify-between gap-2 text-xs">
        <div class="min-w-0">
          <span class="font-medium text-zinc-200">${c.attacker}</span>
          <span class="text-zinc-600 mx-1.5">·</span>
          <span class="text-zinc-400 truncate">${c.move}</span>
        </div>
        <div class="font-mono text-zinc-300 shrink-0">
          ${c.damage.toLocaleString()} lbs
        </div>
      </div>
    `).join('');
  }

  // Head-to-Head Comparisons
  const duelsEl = document.getElementById('duels-list');
  if (duelsEl) {
    duelsEl.innerHTML = (APP_STATE.duels || []).map(d => {
      const uPct = Math.min(100, Math.round((d.user_progress / d.target_goal) * 100));
      const oPct = Math.min(100, Math.round((d.opponent_progress / d.target_goal) * 100));
      return `
        <div class="panel-subtle rounded-xl p-4 space-y-3">
          <div class="flex items-center justify-between">
            <h4 class="font-medium text-xs text-zinc-200">${d.metric_type}</h4>
            <span class="text-[11px] font-mono text-zinc-500">${d.expires_in}</span>
          </div>

          <div class="space-y-2 text-[11px] font-mono">
            <div>
              <div class="flex justify-between text-zinc-300 mb-1">
                <span>${d.challenger_name}</span>
                <span>${d.user_progress.toLocaleString()} / ${d.target_goal.toLocaleString()} ${d.unit}</span>
              </div>
              <div class="w-full h-1.5 bg-zinc-900 rounded-full overflow-hidden">
                <div class="h-full bg-emerald-400" style="width: ${uPct}%"></div>
              </div>
            </div>

            <div>
              <div class="flex justify-between text-zinc-400 mb-1">
                <span>${d.opponent_name} (${d.opponent_rank})</span>
                <span>${d.opponent_progress.toLocaleString()} / ${d.target_goal.toLocaleString()} ${d.unit}</span>
              </div>
              <div class="w-full h-1.5 bg-zinc-900 rounded-full overflow-hidden">
                <div class="h-full bg-zinc-500" style="width: ${oPct}%"></div>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // Synced Activity Ledger
  const feedEl = document.getElementById('social-feed-list');
  if (feedEl) {
    feedEl.innerHTML = (APP_STATE.socialFeed || []).map(f => `
      <div class="panel-subtle rounded-xl p-4 space-y-2">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <span class="w-7 h-7 rounded-md bg-zinc-900 border border-white/[0.07] flex items-center justify-center font-mono text-[11px] text-zinc-300">${f.avatar}</span>
            <div>
              <div class="flex items-center gap-2">
                <span class="font-medium text-xs text-zinc-100">${f.callsign}</span>
                <span class="text-[11px] font-mono text-zinc-500">${f.rank_title}</span>
              </div>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <span class="text-[10px] font-mono text-zinc-500">${f.created_at}</span>
            <button onclick="hypePost(${f.id})" class="px-2 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 border border-white/[0.07] text-[11px] font-mono text-zinc-400 hover:text-zinc-200 transition">
              +${f.hype_count}
            </button>
          </div>
        </div>
        <div class="font-medium text-xs text-zinc-200">${f.headline}</div>
        <p class="text-xs text-zinc-400 leading-relaxed">${f.detail}</p>
      </div>
    `).join('');
  }
}

async function hypePost(postId) {
  try {
    const res = await fetch('/api/feed/hype', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId })
    });
    const json = await res.json();
    if (json.ok) {
      APP_STATE = json.data;
      renderRaidAndSocial();
    }
  } catch (e) {}
}
