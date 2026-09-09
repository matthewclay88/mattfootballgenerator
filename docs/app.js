/* ---------------------------------------------------------------
   Weekly Projection Simulator
   ---------------------------------------------------------------
   Loads data/players.json and runs a client-side Monte Carlo
   simulation for the selected player, week by week.

   Features:
     - Player-by-player weekly simulation
     - 50 / 100 / 150 trials per week
     - Full / Half / Standard PPR
     - Weekly projection cards
     - 10th / 50th / 90th percentile chart
     - Week-by-week projection table
     - Player comparison mode
------------------------------------------------------------------ */


/* ================================================================
   CONFIGURATION
   ================================================================ */

const BOOM_BUST = {
  QB: { boom: 25, bust: 12 },
  RB: { boom: 20, bust: 5 },
  WR: { boom: 20, bust: 5 },
  TE: { boom: 15, bust: 3 }
};


/* ================================================================
   GLOBAL STATE
   ================================================================ */

let ALL_PLAYERS = [];

let CURRENT_POS = "QB";

let SELECTED = null;

let CURRENT_WEEKS = [];

let SELECTED_WEEK = 1;

let COMPARE_A = null;
let COMPARE_B = null;

let COMPARE_WEEKS_A = [];
let COMPARE_WEEKS_B = [];

let CURRENT_VIEW = "player";


/* ================================================================
   RANDOM SAMPLING HELPERS
   ================================================================ */

function randNormal(mean, std) {
  let u = 0;
  let v = 0;

  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();

  const z =
    Math.sqrt(-2 * Math.log(u)) *
    Math.cos(2 * Math.PI * v);

  return mean + z * std;
}


/* Gamma sampler — Marsaglia & Tsang */

function randGamma(k, theta) {

  if (k < 1) {
    const u = Math.random();

    return randGamma(
      1 + k,
      theta
    ) * Math.pow(u, 1 / k);
  }

  const d = k - 1 / 3;

  const c = 1 / Math.sqrt(9 * d);

  while (true) {

    let x;
    let v;

    do {

      x = randNormal(0, 1);

      v = 1 + c * x;

    } while (v <= 0);

    v = v * v * v;

    const u = Math.random();

    if (
      u <
      1 -
      0.0331 *
      (x * x) *
      (x * x)
    ) {

      return d * v * theta;

    }

    if (
      Math.log(u) <
      0.5 * x * x +
      d *
      (1 - v + Math.log(v))
    ) {

      return d * v * theta;

    }

  }
}


/* Poisson sampler */

function randPoisson(lambda) {

  if (lambda <= 0) return 0;

  if (lambda < 30) {

    const L = Math.exp(-lambda);

    let k = 0;
    let p = 1;

    do {

      k++;

      p *= Math.random();

    } while (p > L);

    return k - 1;
  }

  return Math.max(
    0,
    Math.round(
      randNormal(
        lambda,
        Math.sqrt(lambda)
      )
    )
  );
}


/* Negative binomial via Gamma-Poisson mixture */

function randNegBin(r, p) {

  const scale =
    (1 - p) / p;

  const lambda =
    randGamma(r, scale);

  return randPoisson(lambda);
}


/* Small-N binomial */

function randBinomialSmallN(n, prob) {

  let count = 0;

  for (
    let i = 0;
    i < n;
    i++
  ) {

    if (Math.random() < prob) {
      count++;
    }

  }

  return count;
}


function clamp(v, lo, hi) {
  return Math.max(
    lo,
    Math.min(hi, v)
  );
}


/* ================================================================
   PLAYER GAME SIMULATION
   ================================================================ */

function simulateSkillPlayerGame(entry, scoring) {

  const carries =
    randNegBin(
      entry.volume.carries.r,
      entry.volume.carries.p
    );

  const targets =
    randNegBin(
      entry.volume.targets.r,
      entry.volume.targets.p
    );


  const ypc =
    randNormal(
      entry.efficiency.ypc.mean,
      entry.efficiency.ypc.std
    );

  const rushYards =
    Math.max(
      carries * ypc,
      -carries * 3
    );


  const catchProb =
    clamp(
      entry.efficiency.catch_rate,
      0.3,
      0.95
    );

  const receptions =
    randBinomialSmallN(
      Math.round(targets),
      catchProb
    );


  const ypr =
    Math.max(
      randNormal(
        entry.efficiency.ypr.mean,
        entry.efficiency.ypr.std
      ),
      0
    );

  const recYards =
    receptions * ypr;


  const rushTDs =
    randPoisson(
      entry.td_rate.rush_td_per_carry *
      carries
    );

  const recTDs =
    randPoisson(
      entry.td_rate.rec_td_per_catch *
      receptions
    );

  const fumbles =
    randPoisson(
      entry.td_rate.fumble_rate
    );


  let pts =
    rushYards / 10 +
    recYards / 10 +
    (rushTDs + recTDs) * 6 -
    fumbles * 2;


  if (scoring === "ppr") {
    pts += receptions;
  }

  if (scoring === "half") {
    pts += receptions * 0.5;
  }


  return Math.max(
    pts,
    -2
  );
}


/* ================================================================
   QUARTERBACK SIMULATION
   ================================================================ */

function simulateQBGame(entry, scoring) {

  const attempts =
    randNegBin(
      entry.volume.attempts.r,
      entry.volume.attempts.p
    );


  const compPct =
    clamp(
      randNormal(
        entry.efficiency.comp_pct.mean,
        entry.efficiency.comp_pct.std
      ),
      0.35,
      0.85
    );


  const completions =
    Math.round(
      attempts * compPct
    );


  const ypa =
    randNormal(
      entry.efficiency.yards_per_attempt.mean,
      entry.efficiency.yards_per_attempt.std
    );


  const passYards =
    Math.max(
      attempts * ypa,
      0
    );


  const passTDs =
    randPoisson(
      entry.td_rate.pass_td_per_att *
      attempts
    );


  const ints =
    randPoisson(
      entry.td_rate.int_per_att *
      attempts
    );


  const rushAtt =
    randNegBin(
      entry.rushing.volume.r,
      entry.rushing.volume.p
    );


  const rushYPC =
    randNormal(
      entry.rushing.ypc,
      1.5
    );


  const rushYards =
    Math.max(
      rushAtt * rushYPC,
      -rushAtt * 3
    );


  const rushTDs =
    randPoisson(
      entry.rushing.td_per_carry *
      rushAtt
    );


  const pts =
    passYards / 25 +
    passTDs * 4 -
    ints * 2 +
    rushYards / 10 +
    rushTDs * 6;


  return Math.max(
    pts,
    -2
  );
}


/* ================================================================
   SINGLE GAME
   ================================================================ */

function simulateGame(entry, scoring) {

  if (entry.position === "QB") {
    return simulateQBGame(
      entry,
      scoring
    );
  }

  return simulateSkillPlayerGame(
    entry,
    scoring
  );
}


/* ================================================================
   PERCENTILE
   ================================================================ */

function percentile(sorted, pct) {

  if (!sorted.length) {
    return 0;
  }

  const idx =
    clamp(
      Math.floor(
        pct *
        (sorted.length - 1)
      ),
      0,
      sorted.length - 1
    );

  return sorted[idx];
}


/* ================================================================
   SEASON SIMULATION
   ================================================================ */

function simulateSeason(
  entry,
  trials,
  scoring
) {

  const weeks = [];

  for (
    let wk = 1;
    wk <= 18;
    wk++
  ) {

    const sched =
      entry.schedule
        ? entry.schedule[String(wk)]
        : null;


    if (!sched) {

      weeks.push({
        week: wk,
        bye: true
      });

      continue;
    }


    const results = [];


    for (
      let t = 0;
      t < trials;
      t++
    ) {

      results.push(
        simulateGame(
          entry,
          scoring
        )
      );

    }


    results.sort(
      (a, b) => a - b
    );


    const thresh =
      BOOM_BUST[
        entry.position
      ] ||
      BOOM_BUST.WR;


    const boomCount =
      results.filter(
        v => v >= thresh.boom
      ).length;


    const bustCount =
      results.filter(
        v => v <= thresh.bust
      ).length;


    weeks.push({

      week: wk,

      bye: false,

      opp:
        (sched.home
          ? "vs "
          : "@ ") +
        sched.opp,

      floor:
        percentile(
          results,
          0.10
        ),

      median:
        percentile(
          results,
          0.50
        ),

      ceiling:
        percentile(
          results,
          0.90
        ),

      boomPct:
        (100 * boomCount) /
        trials,

      bustPct:
        (100 * bustCount) /
        trials

    });

  }

  return weeks;
}


/* ================================================================
   PLAYER LIST
   ================================================================ */

function renderPlayerList() {

  const listEl =
    document.getElementById(
      "playerList"
    );

  const searchEl =
    document.getElementById(
      "search"
    );


  const query =
    searchEl.value
      .trim()
      .toLowerCase();


  const filtered =
    ALL_PLAYERS

      .filter(
        p =>
          p.position ===
          CURRENT_POS
      )

      .filter(
        p =>
          !query ||
          p.name
            .toLowerCase()
            .includes(query)
      )

      .sort(
        (a, b) =>
          (a.expert_rank || 999) -
          (b.expert_rank || 999) ||
          a.name.localeCompare(
            b.name
          )
      );


  listEl.innerHTML = "";


  if (!filtered.length) {

    listEl.innerHTML =
      '<li class="no-results">No players match.</li>';

    return;
  }


  for (const p of filtered) {

    const li =
      document.createElement(
        "li"
      );


    li.className =
      "player-row" +
      (
        SELECTED &&
        SELECTED.id === p.id
          ? " selected"
          : ""
      );


    li.innerHTML = `
      <span class="pname">
        ${escapeHtml(p.name)}
      </span>

      <span class="pteam">
        ${escapeHtml(p.team || "")}
      </span>
    `;


    li.addEventListener(
      "click",
      () => {

        if (
          CURRENT_VIEW ===
          "compare"
        ) {

          assignComparePlayer(p);

        } else {

          selectPlayer(p);

        }

      }
    );


    listEl.appendChild(li);

  }
}


/* ================================================================
   SELECT PLAYER
   ================================================================ */

function selectPlayer(p) {

  SELECTED = p;

  CURRENT_VIEW = "player";

  showPlayerView();

  document.getElementById(
    "pvPos"
  ).textContent =
    p.position;


  document.getElementById(
    "pvName"
  ).textContent =
    p.name;


  updatePlayerAvatar(p);

  renderMeta(p);

  renderPlayerList();

  SELECTED_WEEK = 1;

  runSimulation();
}


/* ================================================================
   PLAYER META
   ================================================================ */

function renderMeta(p) {

  const scoring =
    document.getElementById(
      "scoringFormat"
    ).value;


  const rank =
    (
      p.expert_ranks &&
      p.expert_ranks[scoring]
    ) ||
    p.expert_rank;


  document.getElementById(
    "pvMeta"
  ).textContent =

    (p.team || "FA") +

    (
      rank
        ? ` · Expert consensus ${p.position} rank #${rank}`
        : ""
    );
}


/* ================================================================
   PLAYER AVATAR
   ================================================================ */

function updatePlayerAvatar(p) {

  const el =
    document.getElementById(
      "pvAvatar"
    );

  if (!el) return;


  const initials =
    p.name
      .split(/\s+/)
      .map(
        part =>
          part.charAt(0)
      )
      .join("")
      .slice(0, 2)
      .toUpperCase();


  el.textContent =
    initials;
}


/* ================================================================
   RUN PLAYER SIMULATION
   ================================================================ */

function runSimulation() {

  if (!SELECTED) return;


  const trials =
    parseInt(
      document.getElementById(
        "trialCount"
      ).value,
      10
    );


  const scoring =
    document.getElementById(
      "scoringFormat"
    ).value;


  CURRENT_WEEKS =
    simulateSeason(
      SELECTED,
      trials,
      scoring
    );


  renderChart(
    CURRENT_WEEKS
  );

  renderTable(
    CURRENT_WEEKS
  );

  renderSummaryCards(
    CURRENT_WEEKS
  );

  highlightSelectedWeek();
}


/* ================================================================
   SUMMARY CARDS
   ================================================================ */

function renderSummaryCards(weeks) {

  const week =
    weeks.find(
      w =>
        w.week ===
        SELECTED_WEEK
    );


  if (!week || week.bye) {

    setText(
      "pvFloor",
      "--"
    );

    setText(
      "pvMedian",
      "--"
    );

    setText(
      "pvCeiling",
      "--"
    );

    setText(
      "pvBoom",
      "--"
    );

    setText(
      "pvBust",
      "--"
    );

    return;
  }


  setText(
    "pvFloor",
    week.floor.toFixed(1)
  );

  setText(
    "pvMedian",
    week.median.toFixed(1)
  );

  setText(
    "pvCeiling",
    week.ceiling.toFixed(1)
  );

  setText(
    "pvBoom",
    `${week.boomPct.toFixed(0)}%`
  );

  setText(
    "pvBust",
    `${week.bustPct.toFixed(0)}%`
  );
}


function setText(id, value) {

  const el =
    document.getElementById(id);

  if (el) {
    el.textContent = value;
  }
}


/* ================================================================
   CHART
   ================================================================ */

function renderChart(weeks) {

  const svg =
    document.getElementById(
      "seasonChart"
    );


  const W = 960;
  const H = 320;

  const padL = 42;
  const padR = 16;
  const padT = 15;
  const padB = 32;


  const plotW =
    W -
    padL -
    padR;


  const plotH =
    H -
    padT -
    padB;


  const played =
    weeks.filter(
      w => !w.bye
    );


  const maxVal =
    Math.max(
      10,
      ...played.map(
        w => w.ceiling
      )
    ) * 1.1;


  const xFor =
    wk =>
      padL +
      (
        (wk - 1) /
        17
      ) *
      plotW;


  const yFor =
    val =>
      padT +
      plotH -
      (
        val /
        maxVal
      ) *
      plotH;


  let svgContent = "";


  /* Grid */

  const gridSteps = 4;


  for (
    let i = 0;
    i <= gridSteps;
    i++
  ) {

    const val =
      (maxVal /
        gridSteps) *
      i;


    const y =
      yFor(val);


    svgContent += `
      <line
        x1="${padL}"
        y1="${y}"
        x2="${W - padR}"
        y2="${y}"
        stroke="#29353a"
        stroke-width="1"
      />

      <text
        x="${padL - 9}"
        y="${y + 4}"
        text-anchor="end"
        font-size="10"
        font-family="IBM Plex Mono, monospace"
        fill="#667177"
      >
        ${val.toFixed(0)}
      </text>
    `;

  }


  /* Week labels */

  for (const w of weeks) {

    const x =
      xFor(w.week);


    const isSelected =
      w.week ===
      SELECTED_WEEK;


    svgContent += `

      <text
        x="${x}"
        y="${H - 9}"
        text-anchor="middle"
        font-size="${isSelected ? 12 : 10}"
        font-family="IBM Plex Mono, monospace"
        font-weight="${isSelected ? 600 : 400}"
        fill="${isSelected ? "#45d39b" : "#667177"}"
      >
        ${w.week}
      </text>

    `;


    /* Invisible click target */

    svgContent += `

      <rect
        x="${x - 20}"
        y="${padT}"
        width="40"
        height="${plotH}"
        fill="transparent"
        style="cursor:pointer"
        data-week="${w.week}"
      />

    `;

  }


  /* Build segments */

  const segments = [];

  let seg = [];


  for (const w of weeks) {

    if (w.bye) {

      if (seg.length) {
        segments.push(seg);
      }

      seg = [];

    } else {

      seg.push(w);

    }

  }


  if (seg.length) {
    segments.push(seg);
  }


  /* Range + median */

  for (const s of segments) {

    if (s.length < 2) {
      continue;
    }


    const top =
      s
        .map(
          w =>
            `${xFor(w.week)},${yFor(w.ceiling)}`
        )
        .join(" L ");


    const bottom =
      s
        .slice()
        .reverse()
        .map(
          w =>
            `${xFor(w.week)},${yFor(w.floor)}`
        )
        .join(" L ");


    svgContent += `

      <path
        d="M ${top} L ${bottom} Z"
        fill="rgba(69,211,155,0.12)"
        stroke="rgba(69,211,155,0.45)"
        stroke-width="1"
      />

    `;


    const medianPts =
      s
        .map(
          w =>
            `${xFor(w.week)},${yFor(w.median)}`
        )
        .join(" L ");


    svgContent += `

      <path
        d="M ${medianPts}"
        fill="none"
        stroke="#f2a93b"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />

    `;


    for (const w of s) {

      const selected =
        w.week ===
        SELECTED_WEEK;


      svgContent += `

        <circle
          cx="${xFor(w.week)}"
          cy="${yFor(w.median)}"
          r="${selected ? 5 : 3}"
          fill="${selected ? "#45d39b" : "#f2a93b"}"
          stroke="${selected ? "#0d1215" : "none"}"
          stroke-width="2"
          style="cursor:pointer"
          data-week="${w.week}"
        />

      `;

    }

  }


  /* Bye markers */

  for (const w of weeks) {

    if (!w.bye) continue;


    svgContent += `

      <text
        x="${xFor(w.week)}"
        y="${padT + plotH / 2}"
        text-anchor="middle"
        font-size="10"
        font-family="IBM Plex Mono, monospace"
        fill="#667177"
        font-style="italic"
      >
        BYE
      </text>

    `;

  }


  svg.innerHTML =
    svgContent;


  /* Add click behavior */

  svg
    .querySelectorAll(
      "[data-week]"
    )
    .forEach(
      el => {

        el.addEventListener(
          "click",
          event => {

            event.stopPropagation();

            const week =
              parseInt(
                el.dataset.week,
                10
              );

            selectWeek(week);

          }
        );

      }
    );
}


/* ================================================================
   SELECT WEEK
   ================================================================ */

function selectWeek(week) {

  SELECTED_WEEK =
    week;


  renderSummaryCards(
    CURRENT_WEEKS
  );

  renderChart(
    CURRENT_WEEKS
  );

  highlightSelectedWeek();
}


/* ================================================================
   TABLE
   ================================================================ */

function renderTable(weeks) {

  const body =
    document.getElementById(
      "weekTableBody"
    );


  body.innerHTML = "";


  for (const w of weeks) {

    const tr =
      document.createElement(
        "tr"
      );


    if (w.bye) {

      tr.className =
        "bye";


      tr.innerHTML = `

        <td>${w.week}</td>

        <td colspan="5">
          Bye week
        </td>

        <td>
          —
        </td>

      `;

    } else {

      const boomClass =
        w.boomPct >= 25
          ? " boom-high"
          : "";


      const bustClass =
        w.bustPct >= 25
          ? " bust-high"
          : "";


      tr.innerHTML = `

        <td>
          ${w.week}
        </td>

        <td>
          ${escapeHtml(w.opp)}
        </td>

        <td class="num">
          ${w.floor.toFixed(1)}
        </td>

        <td class="num">
          ${w.median.toFixed(1)}
        </td>

        <td class="num">
          ${w.ceiling.toFixed(1)}
        </td>

        <td class="num${boomClass}">
          ${w.boomPct.toFixed(0)}%
        </td>

        <td class="num${bustClass}">
          ${w.bustPct.toFixed(0)}%
        </td>

      `;

    }


    tr.dataset.week =
      w.week;


    tr.addEventListener(
      "click",
      () => {

        selectWeek(
          w.week
        );

      }
    );


    body.appendChild(tr);

  }

}


/* ================================================================
   TABLE WEEK HIGHLIGHT
   ================================================================ */

function highlightSelectedWeek() {

  document
    .querySelectorAll(
      "#weekTableBody tr"
    )
    .forEach(
      row => {

        row.classList.toggle(
          "selected-week",
          parseInt(
            row.dataset.week,
            10
          ) ===
          SELECTED_WEEK
        );

      }
    );
}


/* ================================================================
   COMPARISON
   ================================================================ */

function assignComparePlayer(p) {

  if (
    !COMPARE_A ||
    COMPARE_A.id === p.id
  ) {

    COMPARE_A = p;

  } else if (
    !COMPARE_B ||
    COMPARE_B.id === p.id
  ) {

    COMPARE_B = p;

  } else {

    COMPARE_B = p;

  }


  updateCompareDisplay();

  renderPlayerList();


  if (
    COMPARE_A &&
    COMPARE_B
  ) {

    runComparison();

  }
}


/* Add selected player to comparison */

function addSelectedToCompare() {

  if (!SELECTED) return;

  assignComparePlayer(
    SELECTED
  );

  showCompareView();
}


/* Update comparison player cards */

function updateCompareDisplay() {

  const aName =
    document.getElementById(
      "comparePlayerAName"
    );

  const aMeta =
    document.getElementById(
      "comparePlayerAMeta"
    );

  const bName =
    document.getElementById(
      "comparePlayerBName"
    );

  const bMeta =
    document.getElementById(
      "comparePlayerBMeta"
    );


  if (aName) {

    aName.textContent =
      COMPARE_A
        ? COMPARE_A.name
        : "Select a player";

  }


  if (aMeta) {

    aMeta.textContent =
      COMPARE_A
        ? `${COMPARE_A.team || "FA"} · ${COMPARE_A.position}`
        : "--";

  }


  if (bName) {

    bName.textContent =
      COMPARE_B
        ? COMPARE_B.name
        : "Select a player";

  }


  if (bMeta) {

    bMeta.textContent =
      COMPARE_B
        ? `${COMPARE_B.team || "FA"} · ${COMPARE_B.position}`
        : "--";

  }

}


/* ================================================================
   RUN COMPARISON
   ================================================================ */

function runComparison() {

  if (
    !COMPARE_A ||
    !COMPARE_B
  ) {

    return;

  }


  const scoringEl =
    document.getElementById(
      "compareScoringFormat"
    );


  const trialsEl =
    document.getElementById(
      "compareTrialCount"
    );


  const scoring =
    scoringEl
      ? scoringEl.value
      : "half";


  const trials =
    trialsEl
      ? parseInt(
          trialsEl.value,
          10
        )
      : 100;


  COMPARE_WEEKS_A =
    simulateSeason(
      COMPARE_A,
      trials,
      scoring
    );


  COMPARE_WEEKS_B =
    simulateSeason(
      COMPARE_B,
      trials,
      scoring
    );


  renderComparison();
}


/* ================================================================
   RENDER COMPARISON
   ================================================================ */

function renderComparison() {

  if (
    !COMPARE_A ||
    !COMPARE_B
  ) {

    return;

  }


  const placeholder =
    document.querySelector(
      ".comparison-placeholder"
    );


  if (placeholder) {
    placeholder.classList.add(
      "hidden"
    );
  }


  renderComparisonCards();

  renderComparisonChart();

  renderComparisonTable();

}


/* ================================================================
   COMPARISON SUMMARY
   ================================================================ */

function renderComparisonCards() {

  const container =
    document.querySelector(
      ".compare-selection"
    );


  if (!container) return;


  /*
     Add compact metrics underneath
     the two player cards.
  */

  let metrics =
    document.getElementById(
      "comparisonMetrics"
    );


  if (!metrics) {

    metrics =
      document.createElement(
        "div"
      );

    metrics.id =
      "comparisonMetrics";

    metrics.className =
      "comparison-metrics";

    container.parentNode.insertBefore(
      metrics,
      container.nextSibling
    );

  }


  const a =
    COMPARE_WEEKS_A.find(
      w =>
        w.week ===
        SELECTED_WEEK
    );


  const b =
    COMPARE_WEEKS_B.find(
      w =>
        w.week ===
        SELECTED_WEEK
    );


  if (
    !a ||
    !b ||
    a.bye ||
    b.bye
  ) {

    metrics.innerHTML = `
      <div class="comparison-metric-empty">
        One player has a bye in Week ${SELECTED_WEEK}.
      </div>
    `;

    return;

  }


  const diff =
    a.median -
    b.median;


  const absDiff =
    Math.abs(diff);


  const winner =
    diff >= 0
      ? COMPARE_A
      : COMPARE_B;


  metrics.innerHTML = `

    <div class="comparison-metric">

      <span class="metric-label">
        WEEK ${SELECTED_WEEK} MEDIAN
      </span>

      <strong>
        ${winner.name}
      </strong>

      <span>
        ${Math.abs(diff).toFixed(1)}
        point edge
      </span>

    </div>

    <div class="comparison-metric">

      <span class="metric-label">
        ${COMPARE_A.name}
      </span>

      <strong>
        ${a.median.toFixed(1)}
      </strong>

      <span>
        ${a.floor.toFixed(1)}
        – ${a.ceiling.toFixed(1)}
      </span>

    </div>

    <div class="comparison-metric">

      <span class="metric-label">
        ${COMPARE_B.name}
      </span>

      <strong>
        ${b.median.toFixed(1)}
      </strong>

      <span>
        ${b.floor.toFixed(1)}
        – ${b.ceiling.toFixed(1)}
      </span>

    </div>

  `;

}


/* ================================================================
   COMPARISON CHART
   ================================================================ */

function renderComparisonChart() {

  /*
     The current HTML does not yet contain a dedicated
     comparison SVG.

     Create one dynamically so the first version remains
     compatible with the HTML already provided.
  */

  let panel =
    document.getElementById(
      "comparisonChartPanel"
    );


  if (!panel) {

    panel =
      document.createElement(
        "section"
      );

    panel.id =
      "comparisonChartPanel";

    panel.className =
      "chart-section comparison-chart-created";


    panel.innerHTML = `

      <div class="chart-head">

        <div>

          <div class="eyebrow">
            SEASON COMPARISON
          </div>

          <h3>
            Weekly Median Projection
          </h3>

        </div>

        <div class="legend">

          <span class="legend-item">
            <i class="swatch line"></i>
            ${escapeHtml(COMPARE_A.name)}
          </span>

          <span class="legend-item">
            <i class="swatch band"></i>
            ${escapeHtml(COMPARE_B.name)}
          </span>

        </div>

      </div>

      <svg
        id="comparisonChart"
        viewBox="0 0 960 320"
        preserveAspectRatio="none"
      ></svg>

    `;


    const metrics =
      document.getElementById(
        "comparisonMetrics"
      );


    if (metrics) {

      metrics.after(
        panel
      );

    } else {

      const compareView =
        document.getElementById(
          "compareView"
        );

      compareView.appendChild(
        panel
      );

    }

  }


  const svg =
    document.getElementById(
      "comparisonChart"
    );


  if (!svg) return;


  const W = 960;
  const H = 320;

  const padL = 42;
  const padR = 16;
  const padT = 15;
  const padB = 32;


  const allValues = [
    ...COMPARE_WEEKS_A
      .filter(w => !w.bye)
      .map(w => w.ceiling),

    ...COMPARE_WEEKS_B
      .filter(w => !w.bye)
      .map(w => w.ceiling)
  ];


  const maxVal =
    Math.max(
      10,
      ...allValues
    ) * 1.1;


  const plotW =
    W - padL - padR;

  const plotH =
    H - padT - padB;


  const xFor =
    wk =>
      padL +
      ((wk - 1) / 17) *
      plotW;


  const yFor =
    val =>
      padT +
      plotH -
      (val / maxVal) *
      plotH;


  let content = "";


  /* Grid */

  for (
    let i = 0;
    i <= 4;
    i++
  ) {

    const val =
      (maxVal / 4) * i;

    const y =
      yFor(val);


    content += `

      <line
        x1="${padL}"
        y1="${y}"
        x2="${W - padR}"
        y2="${y}"
        stroke="#29353a"
        stroke-width="1"
      />

      <text
        x="${padL - 9}"
        y="${y + 4}"
        text-anchor="end"
        font-size="10"
        font-family="IBM Plex Mono, monospace"
        fill="#667177"
      >
        ${val.toFixed(0)}
      </text>

    `;

  }


  /* Week labels */

  for (
    let wk = 1;
    wk <= 18;
    wk++
  ) {

    content += `

      <text
        x="${xFor(wk)}"
        y="${H - 9}"
        text-anchor="middle"
        font-size="10"
        font-family="IBM Plex Mono, monospace"
        fill="#667177"
      >
        ${wk}
      </text>

    `;

  }


  /* Player A */

  const aPlayed =
    COMPARE_WEEKS_A
      .filter(
        w => !w.bye
      );


  const aPath =
    aPlayed
      .map(
        w =>
          `${xFor(w.week)},${yFor(w.median)}`
      )
      .join(" L ");


  if (aPlayed.length) {

    content += `

      <path
        d="M ${aPath}"
        fill="none"
        stroke="#45d39b"
        stroke-width="3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />

    `;


    for (const w of aPlayed) {

      content += `

        <circle
          cx="${xFor(w.week)}"
          cy="${yFor(w.median)}"
          r="3"
          fill="#45d39b"
        />

      `;

    }

  }


  /* Player B */

  const bPlayed =
    COMPARE_WEEKS_B
      .filter(
        w => !w.bye
      );


  const bPath =
    bPlayed
      .map(
        w =>
          `${xFor(w.week)},${yFor(w.median)}`
      )
      .join(" L ");


  if (bPlayed.length) {

    content += `

      <path
        d="M ${bPath}"
        fill="none"
        stroke="#f2a93b"
        stroke-width="3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />

    `;


    for (const w of bPlayed) {

      content += `

        <circle
          cx="${xFor(w.week)}"
          cy="${yFor(w.median)}"
          r="3"
          fill="#f2a93b"
        />

      `;

    }

  }


  svg.innerHTML =
    content;

}


/* ================================================================
   COMPARISON TABLE
   ================================================================ */

function renderComparisonTable() {

  let tableSection =
    document.getElementById(
      "comparisonTableCreated"
    );


  if (!tableSection) {

    tableSection =
      document.createElement(
        "section"
      );

    tableSection.id =
      "comparisonTableCreated";

    tableSection.className =
      "table-section";


    tableSection.innerHTML = `

      <div class="table-head">

        <div>

          <div class="eyebrow">
            WEEKLY BREAKDOWN
          </div>

          <h3>
            Head-to-Head Projections
          </h3>

        </div>

      </div>

      <div class="table-scroll">

        <table class="week-table">

          <thead>

            <tr>

              <th>WK</th>

              <th>
                ${escapeHtml(COMPARE_A.name)}
              </th>

              <th class="num">
                MEDIAN
              </th>

              <th>
                ${escapeHtml(COMPARE_B.name)}
              </th>

              <th class="num">
                MEDIAN
              </th>

              <th>
                EDGE
              </th>

            </tr>

          </thead>

          <tbody id="comparisonTableBody">
          </tbody>

        </table>

      </div>

    `;


    const compareView =
      document.getElementById(
        "compareView"
      );


    compareView.appendChild(
      tableSection
    );

  }


  const body =
    document.getElementById(
      "comparisonTableBody"
    );


  if (!body) return;


  body.innerHTML = "";


  for (
    let wk = 1;
    wk <= 18;
    wk++
  ) {

    const a =
      COMPARE_WEEKS_A.find(
        w =>
          w.week === wk
      );


    const b =
      COMPARE_WEEKS_B.find(
        w =>
          w.week === wk
      );


    const tr =
      document.createElement(
        "tr"
      );


    if (
      !a ||
      !b
    ) {

      tr.innerHTML = `
        <td>${wk}</td>
        <td colspan="5">—</td>
      `;

    } else if (
      a.bye ||
      b.bye
    ) {

      tr.innerHTML = `

        <td>${wk}</td>

        <td colspan="5">
          ${a.bye
            ? escapeHtml(COMPARE_A.name) + " BYE"
            : escapeHtml(COMPARE_B.name) + " BYE"}
        </td>

      `;

    } else {

      const diff =
        a.median -
        b.median;


      let edgeText;

      if (Math.abs(diff) < 0.25) {

        edgeText =
          "EVEN";

      } else if (diff > 0) {

        edgeText =
          `${COMPARE_A.name} +${diff.toFixed(1)}`;

      } else {

        edgeText =
          `${COMPARE_B.name} +${Math.abs(diff).toFixed(1)}`;

      }


      tr.innerHTML = `

        <td>
          ${wk}
        </td>

        <td>
          ${escapeHtml(a.opp)}
        </td>

        <td class="num">
          ${a.median.toFixed(1)}
        </td>

        <td>
          ${escapeHtml(b.opp)}
        </td>

        <td class="num">
          ${b.median.toFixed(1)}
        </td>

        <td>
          ${escapeHtml(edgeText)}
        </td>

      `;

    }


    body.appendChild(
      tr
    );

  }

}


/* ================================================================
   VIEW SWITCHING
   ================================================================ */

function showPlayerView() {

  CURRENT_VIEW =
    "player";


  const playerView =
    document.getElementById(
      "playerView"
    );


  const compareView =
    document.getElementById(
      "compareView"
    );


  const emptyState =
    document.getElementById(
      "emptyState"
    );


  playerView.classList.remove(
    "hidden"
  );


  compareView.classList.add(
    "hidden"
  );


  emptyState.classList.add(
    "hidden"
  );


  setViewButton(
    "playerViewBtn",
    true
  );


  setViewButton(
    "compareViewBtn",
    false
  );

}


function showCompareView() {

  CURRENT_VIEW =
    "compare";


  const playerView =
    document.getElementById(
      "playerView"
    );


  const compareView =
    document.getElementById(
      "compareView"
    );


  const emptyState =
    document.getElementById(
      "emptyState"
    );


  playerView.classList.add(
    "hidden"
  );


  emptyState.classList.add(
    "hidden"
  );


  compareView.classList.remove(
    "hidden"
  );


  setViewButton(
    "playerViewBtn",
    false
  );


  setViewButton(
    "compareViewBtn",
    true
  );


  updateCompareDisplay();


  renderPlayerList();


  if (
    COMPARE_A &&
    COMPARE_B
  ) {

    runComparison();

  }

}


function setViewButton(
  id,
  active
) {

  const el =
    document.getElementById(id);

  if (!el) return;

  el.classList.toggle(
    "active",
    active
  );

}


/* ================================================================
   UTILITIES
   ================================================================ */

function escapeHtml(value) {

  return String(value ?? "")
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );

}


/* ================================================================
   WIRING
   ================================================================ */

function init() {

  /* Load players */

  fetch(
    "data/players.json"
  )

    .then(
      response => {

        if (!response.ok) {
          throw new Error(
            `HTTP ${response.status}`
          );
        }

        return response.json();

      }
    )

    .then(
      data => {

        ALL_PLAYERS =
          data.players || [];

        renderPlayerList();

      }
    )

    .catch(
      err => {

        console.error(
          "Failed to load player data:",
          err
        );


        const list =
          document.getElementById(
            "playerList"
          );


        if (list) {

          list.innerHTML =
            '<li class="no-results">Could not load data/players.json</li>';

        }

      }
    );


  /* Search */

  const search =
    document.getElementById(
      "search"
    );


  if (search) {

    search.addEventListener(
      "input",
      renderPlayerList
    );

  }


  /* Position tabs */

  document
    .querySelectorAll(
      ".pos-tab"
    )
    .forEach(
      btn => {

        btn.addEventListener(
          "click",
          () => {

            document
              .querySelectorAll(
                ".pos-tab"
              )
              .forEach(
                b =>
                  b.classList.remove(
                    "active"
                  )
              );


            btn.classList.add(
              "active"
            );


            CURRENT_POS =
              btn.dataset.pos;


            renderPlayerList();

          }
        );

      }
    );


  /* Run player */

  const runBtn =
    document.getElementById(
      "runBtn"
    );


  if (runBtn) {

    runBtn.addEventListener(
      "click",
      runSimulation
    );

  }


  /* Scoring */

  const scoring =
    document.getElementById(
      "scoringFormat"
    );


  if (scoring) {

    scoring.addEventListener(
      "change",
      () => {

        if (SELECTED) {

          renderMeta(
            SELECTED
          );

          runSimulation();

        }

      }
    );

  }


  /* Trial count */

  const trials =
    document.getElementById(
      "trialCount"
    );


  if (trials) {

    trials.addEventListener(
      "change",
      runSimulation
    );

  }


  /* Player / Compare tabs */

  const playerViewBtn =
    document.getElementById(
      "playerViewBtn"
    );


  if (playerViewBtn) {

    playerViewBtn.addEventListener(
      "click",
      () => {

        if (SELECTED) {

          showPlayerView();

        }

      }
    );

  }


  const compareViewBtn =
    document.getElementById(
      "compareViewBtn"
    );


  if (compareViewBtn) {

    compareViewBtn.addEventListener(
      "click",
      showCompareView
    );

  }


  /* Add to compare */

  const addCompareBtn =
    document.getElementById(
      "addCompareBtn"
    );


  if (addCompareBtn) {

    addCompareBtn.addEventListener(
      "click",
      addSelectedToCompare
    );

  }


  /* Compare simulation */

  const runCompareBtn =
    document.getElementById(
      "runCompareBtn"
    );


  if (runCompareBtn) {

    runCompareBtn.addEventListener(
      "click",
      runComparison
    );

  }


  /* Compare scoring */

  const compareScoring =
    document.getElementById(
      "compareScoringFormat"
    );


  if (compareScoring) {

    compareScoring.addEventListener(
      "change",
      runComparison
    );

  }


  /* Compare trials */

  const compareTrials =
    document.getElementById(
      "compareTrialCount"
    );


  if (compareTrials) {

    compareTrials.addEventListener(
      "change",
      runComparison
    );

  }

}


/* ================================================================
   START
   ================================================================ */

document.addEventListener(
  "DOMContentLoaded",
  init
);
