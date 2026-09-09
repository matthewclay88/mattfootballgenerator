/* ---------------------------------------------------------------
   Weekly Projection Simulator — front end
   Loads data/players.json (built by scripts/fetch_data.py) and runs
   a client-side Monte Carlo simulation for the selected player,
   week by week, for the number of trials chosen.
------------------------------------------------------------------*/

const BOOM_BUST = {
  QB: { boom: 25, bust: 12 },
  RB: { boom: 20, bust: 5 },
  WR: { boom: 20, bust: 5 },
  TE: { boom: 15, bust: 3 },
};

let ALL_PLAYERS = [];
let CURRENT_POS = "QB";
let SELECTED = null;

// ---------------- Random sampling helpers ----------------

function randNormal(mean, std) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * std;
}

// Gamma sampler (Marsaglia & Tsang), shape k > 0, scale theta
function randGamma(k, theta) {
  if (k < 1) {
    const u = Math.random();
    return randGamma(1 + k, theta) * Math.pow(u, 1 / k);
  }
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      x = randNormal(0, 1);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v * theta;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * theta;
  }
}

// Poisson sampler: Knuth for small lambda, normal approx for large
function randPoisson(lambda) {
  if (lambda <= 0) return 0;
  if (lambda < 30) {
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do {
      k++;
      p *= Math.random();
    } while (p > L);
    return k - 1;
  }
  return Math.max(0, Math.round(randNormal(lambda, Math.sqrt(lambda))));
}

// Negative binomial via Gamma-Poisson mixture, using the {r, p}
// parameterization produced by fetch_data.py (mean = r*(1-p)/p)
function randNegBin(r, p) {
  const scale = (1 - p) / p;
  const lambda = randGamma(r, scale);
  return randPoisson(lambda);
}

function randBinomialSmallN(n, prob) {
  let count = 0;
  for (let i = 0; i < n; i++) if (Math.random() < prob) count++;
  return count;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---------------- Per-position single-game simulation ----------------

function simulateSkillPlayerGame(entry, scoring) {
  const carries = randNegBin(entry.volume.carries.r, entry.volume.carries.p);
  const targets = randNegBin(entry.volume.targets.r, entry.volume.targets.p);

  const ypc = randNormal(entry.efficiency.ypc.mean, entry.efficiency.ypc.std);
  const rushYards = Math.max(carries * ypc, -carries * 3);

  const catchProb = clamp(entry.efficiency.catch_rate, 0.3, 0.95);
  const receptions = randBinomialSmallN(Math.round(targets), catchProb);

  const ypr = Math.max(randNormal(entry.efficiency.ypr.mean, entry.efficiency.ypr.std), 0);
  const recYards = receptions * ypr;

  const rushTDs = randPoisson(entry.td_rate.rush_td_per_carry * carries);
  const recTDs = randPoisson(entry.td_rate.rec_td_per_catch * receptions);
  const fumbles = randPoisson(entry.td_rate.fumble_rate);

  let pts = rushYards / 10 + recYards / 10 + (rushTDs + recTDs) * 6 - fumbles * 2;
  if (scoring === "ppr") pts += receptions * 1.0;
  if (scoring === "half") pts += receptions * 0.5;

  return Math.max(pts, -2);
}

function simulateQBGame(entry, scoring) {
  const attempts = randNegBin(entry.volume.attempts.r, entry.volume.attempts.p);
  const compPct = clamp(randNormal(entry.efficiency.comp_pct.mean, entry.efficiency.comp_pct.std), 0.35, 0.85);
  const completions = Math.round(attempts * compPct);
  const ypa = randNormal(entry.efficiency.yards_per_attempt.mean, entry.efficiency.yards_per_attempt.std);
  const passYards = Math.max(attempts * ypa, 0);
  const passTDs = randPoisson(entry.td_rate.pass_td_per_att * attempts);
  const ints = randPoisson(entry.td_rate.int_per_att * attempts);

  const rushAtt = randNegBin(entry.rushing.volume.r, entry.rushing.volume.p);
  const rushYPC = randNormal(entry.rushing.ypc, 1.5);
  const rushYards = Math.max(rushAtt * rushYPC, -rushAtt * 3);
  const rushTDs = randPoisson(entry.rushing.td_per_carry * rushAtt);

  const pts = passYards / 25 + passTDs * 4 - ints * 2 + rushYards / 10 + rushTDs * 6;
  return Math.max(pts, -2);
}

function simulateGame(entry, scoring) {
  return entry.position === "QB"
    ? simulateQBGame(entry, scoring)
    : simulateSkillPlayerGame(entry, scoring);
}

function percentile(sorted, pct) {
  const idx = clamp(Math.floor(pct * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[idx];
}

function simulateSeason(entry, trials, scoring) {
  const weeks = [];
  for (let wk = 1; wk <= 18; wk++) {
    const sched = entry.schedule ? entry.schedule[String(wk)] : null;
    if (!sched) {
      weeks.push({ week: wk, bye: true });
      continue;
    }
    const results = [];
    for (let t = 0; t < trials; t++) results.push(simulateGame(entry, scoring));
    results.sort((a, b) => a - b);

    const thresh = BOOM_BUST[entry.position] || BOOM_BUST.WR;
    const boomCount = results.filter((v) => v >= thresh.boom).length;
    const bustCount = results.filter((v) => v <= thresh.bust).length;

    weeks.push({
      week: wk,
      bye: false,
      opp: (sched.home ? "vs " : "@ ") + sched.opp,
      floor: percentile(results, 0.1),
      median: percentile(results, 0.5),
      ceiling: percentile(results, 0.9),
      boomPct: (100 * boomCount) / trials,
      bustPct: (100 * bustCount) / trials,
    });
  }
  return weeks;
}

// ---------------- Rendering ----------------

function renderPlayerList() {
  const listEl = document.getElementById("playerList");
  const query = document.getElementById("search").value.trim().toLowerCase();

  const filtered = ALL_PLAYERS
    .filter((p) => p.position === CURRENT_POS)
    .filter((p) => !query || p.name.toLowerCase().includes(query))
    .sort((a, b) => (a.expert_rank || 999) - (b.expert_rank || 999) || a.name.localeCompare(b.name));

  listEl.innerHTML = "";
  if (filtered.length === 0) {
    listEl.innerHTML = '<li class="no-results">No players match.</li>';
    return;
  }

  for (const p of filtered) {
    const li = document.createElement("li");
    li.className = "player-row" + (SELECTED && SELECTED.id === p.id ? " selected" : "");
    li.innerHTML = `<span class="pname">${p.name}</span><span class="pteam">${p.team || ""}</span>`;
    li.addEventListener("click", () => selectPlayer(p));
    listEl.appendChild(li);
  }
}

function selectPlayer(p) {
  SELECTED = p;
  document.getElementById("emptyState").classList.add("hidden");
  document.getElementById("playerView").classList.remove("hidden");
  document.getElementById("pvPos").textContent = p.position;
  document.getElementById("pvName").textContent = p.name;
  renderMeta(p);
  renderPlayerList();
  runSimulation();
}

function renderMeta(p) {
  const scoring = document.getElementById("scoringFormat").value;
  const rank = (p.expert_ranks && p.expert_ranks[scoring]) || p.expert_rank;
  document.getElementById("pvMeta").textContent =
    (p.team || "FA") + (rank ? ` \u00b7 Expert consensus ${p.position} rank #${rank}` : "");
}

function runSimulation() {
  if (!SELECTED) return;
  const trials = parseInt(document.getElementById("trialCount").value, 10);
  const scoring = document.getElementById("scoringFormat").value;
  const weeks = simulateSeason(SELECTED, trials, scoring);
  renderChart(weeks);
  renderTable(weeks);
}

function renderChart(weeks) {
  const svg = document.getElementById("seasonChart");
  const W = 960, H = 320, padL = 36, padR = 12, padT = 12, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const played = weeks.filter((w) => !w.bye);
  const maxVal = Math.max(10, ...played.map((w) => w.ceiling)) * 1.1;

  const xFor = (wk) => padL + ((wk - 1) / 17) * plotW;
  const yFor = (val) => padT + plotH - (val / maxVal) * plotH;

  let svgContent = "";

  // gridlines
  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const val = (maxVal / gridSteps) * i;
    const y = yFor(val);
    svgContent += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#2B3236" stroke-width="1" />`;
    svgContent += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="11" font-family="IBM Plex Mono, monospace" fill="#8B9296">${val.toFixed(0)}</text>`;
  }

  // week ticks
  for (const w of weeks) {
    const x = xFor(w.week);
    svgContent += `<text x="${x}" y="${H - 8}" text-anchor="middle" font-size="11" font-family="IBM Plex Mono, monospace" fill="#8B9296">${w.week}</text>`;
  }

  // band (10th-90th) as filled path, only across played weeks, split on byes
  const segments = [];
  let seg = [];
  for (const w of weeks) {
    if (w.bye) {
      if (seg.length) segments.push(seg);
      seg = [];
    } else {
      seg.push(w);
    }
  }
  if (seg.length) segments.push(seg);

  for (const s of segments) {
    if (s.length < 2) continue;
    const top = s.map((w) => `${xFor(w.week)},${yFor(w.ceiling)}`).join(" L ");
    const bottom = s.slice().reverse().map((w) => `${xFor(w.week)},${yFor(w.floor)}`).join(" L ");
    svgContent += `<path d="M ${top} L ${bottom} Z" fill="rgba(76,140,74,0.18)" stroke="#4C8C4A" stroke-width="1" />`;
    const medianPts = s.map((w) => `${xFor(w.week)},${yFor(w.median)}`).join(" L ");
    svgContent += `<path d="M ${medianPts}" fill="none" stroke="#E8A33D" stroke-width="2.5" />`;
    for (const w of s) {
      svgContent += `<circle cx="${xFor(w.week)}" cy="${yFor(w.median)}" r="3" fill="#E8A33D" />`;
    }
  }

  // bye week markers
  for (const w of weeks) {
    if (w.bye) {
      svgContent += `<text x="${xFor(w.week)}" y="${padT + plotH / 2}" text-anchor="middle" font-size="11" fill="#8B9296" font-style="italic">BYE</text>`;
    }
  }

  svg.innerHTML = svgContent;
}

function renderTable(weeks) {
  const body = document.getElementById("weekTableBody");
  body.innerHTML = "";
  for (const w of weeks) {
    const tr = document.createElement("tr");
    if (w.bye) {
      tr.className = "bye";
      tr.innerHTML = `<td>${w.week}</td><td colspan="6">Bye week</td>`;
    } else {
      const boomClass = w.boomPct >= 25 ? " boom-high" : "";
      const bustClass = w.bustPct >= 25 ? " bust-high" : "";
      tr.innerHTML = `
        <td>${w.week}</td>
        <td>${w.opp}</td>
        <td class="num">${w.floor.toFixed(1)}</td>
        <td class="num">${w.median.toFixed(1)}</td>
        <td class="num">${w.ceiling.toFixed(1)}</td>
        <td class="num${boomClass}">${w.boomPct.toFixed(0)}%</td>
        <td class="num${bustClass}">${w.bustPct.toFixed(0)}%</td>
      `;
    }
    body.appendChild(tr);
  }
}

// ---------------- Wiring ----------------

function init() {
  fetch("data/players.json")
    .then((r) => r.json())
    .then((data) => {
      ALL_PLAYERS = data.players || [];
      renderPlayerList();
    })
    .catch((err) => {
      console.error("Failed to load player data", err);
      document.getElementById("playerList").innerHTML =
        '<li class="no-results">Could not load data/players.json</li>';
    });

  document.getElementById("search").addEventListener("input", renderPlayerList);

  document.querySelectorAll(".pos-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".pos-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      CURRENT_POS = btn.dataset.pos;
      renderPlayerList();
    });
  });

  document.getElementById("runBtn").addEventListener("click", runSimulation);
  document.getElementById("scoringFormat").addEventListener("change", () => {
    if (SELECTED) renderMeta(SELECTED);
    runSimulation();
  });
  document.getElementById("trialCount").addEventListener("change", runSimulation);
}

document.addEventListener("DOMContentLoaded", init);
