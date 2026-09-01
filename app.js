/* Gator Tracker — 2026 Florida football.
   Fetches ESPN directly from the browser, grades every game, and draws the
   trend charts from the shared history log. No server involved. */

const $ = (sel) => document.querySelector(sel);
const fmt1 = (n) => (n === null || n === undefined ? "—" : n.toFixed(1));

const SERIES_SLOTS = ["--series-1", "--series-2", "--series-3", "--series-4"];
const MAX_SELECTED = 4;

// Florida's mark, from the same ESPN CDN the opponent logos already come from.
const FLORIDA_LOGO = "https://a.espncdn.com/i/teamlogos/ncaa/500/57.png";

// ESPN reruns FPI about once a day, so there's nothing to gain from polling it
// hard. The only time fresh data matters by the minute is during a live game.
const STALE_MS = 3 * 60 * 60 * 1000;
const STALE_MS_LIVE = 60 * 1000;

const state = {
  data: null,
  history: {},
  updated: null,
  selected: [],
  slots: new Map(),     // event id -> colour slot (sticky: survivors never repaint)
  fetching: false,
};

/* ---------------------------------------------------------------- data --- */

async function boot() {
  state.history = await Store.loadHistory();

  const cache = Store.loadCache();
  if (cache && cache.games && cache.games.length) {
    build(cache.games, cache.updated, cache.teamIndex, cache.teamStats);   // instant paint
  }
  await pull(false);
}

async function pull(force) {
  if (state.fetching) return;

  // A cache from before a feature shipped can be fresh but incomplete, so only
  // skip the fetch when we actually hold everything the page renders.
  const complete = state.data && state.data.teamIndex;
  if (!force && state.updated && complete) {
    const live = state.data.games.some((g) => g.state === "in");
    if (Date.now() - new Date(state.updated).getTime() < (live ? STALE_MS_LIVE : STALE_MS)) return;
  }

  state.fetching = true;
  const btn = $("#refresh-btn");
  btn.disabled = true;
  btn.textContent = state.data ? "Refreshing…" : "Loading…";

  try {
    // The season-long index is a nice-to-have: if it fails, the rest still renders.
    const [games, teamIndex] = await Promise.all([ESPN.fetchAll(), ESPN.fetchTeamIndex()]);
    if (games.length) {
      // Box-score stats only exist once games are played, and the payload is
      // the biggest of the lot — so don't spend it before the opener.
      const teamStats = games.some((g) => g.completed) ? await ESPN.fetchTeamStats() : null;
      await Store.record(games, state.history);
      Store.saveCache(games, teamIndex, teamStats);
      build(games, new Date().toISOString(), teamIndex, teamStats);
    } else if (!state.data) {
      $("#loading").textContent = "Couldn't reach ESPN. Check your connection and refresh.";
    }
  } finally {
    state.fetching = false;
    btn.disabled = false;
    btn.textContent = "Refresh";
  }
}

/** Attach grading + history to each game, roll up the season, then paint. */
function build(games, updated, teamIndex, teamStats) {
  games.forEach((game) => {
    const series = state.history[game.id] || [];
    game.history = series;
    game.grade = Analysis.gradeGame(game, Analysis.closingValues(series, game.date));
    game.movement = Analysis.movement(series);
  });

  state.data = {
    games,
    summary: Analysis.seasonSummary(games),
    timeline: Analysis.projectionTimeline(games, state.history),
    teamIndex: teamIndex !== undefined ? teamIndex : (state.data || {}).teamIndex || null,
    teamStats: teamStats !== undefined ? teamStats : (state.data || {}).teamStats || null,
  };
  state.updated = updated;
  render();
}

function render() {
  const d = state.data;
  $("#loading").hidden = true;
  $("#app").hidden = false;
  $("#updated").textContent = state.updated ? "Updated " + relTime(state.updated) : "";

  if (!state.selected.length) {
    const upcoming = d.games.filter((g) => !g.completed).slice(0, MAX_SELECTED);
    (upcoming.length ? upcoming : d.games.slice(-MAX_SELECTED)).forEach((g) => select(g.id));
  }

  renderBanner();
  renderSync();
  renderKpis();
  renderOdds();
  renderProfile();
  renderStats();
  renderNext();
  renderChips();
  renderFpiChart();
  renderWeekly();
  renderProjection();
  renderDistribution();
  renderTable();
  renderAccuracy();
}

/* --------------------------------------------------------------- pieces --- */

function renderBanner() {
  const d = state.data;
  const points = d.games.reduce((n, g) => n + (g.history ? g.history.length : 0), 0);
  const days = new Set(d.games.flatMap((g) => (g.history || []).map((p) => p.t.slice(0, 10))));
  const el = $("#tracking-banner");
  el.hidden = false;

  if (days.size <= 1) {
    el.innerHTML = "<b>Tracking starts now.</b> ESPN only publishes FPI's <i>current</i> number, so the " +
      "trend lines fill in from here forward — one point per FPI rerun (roughly daily). " +
      `${points} game numbers logged so far.`;
  } else {
    const first = [...days].sort()[0];
    el.innerHTML = `<b>${days.size} days</b> of FPI history logged · ${points} data points since ` +
      new Date(first + "T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
}

function renderSync() {
  const el = $("#sync-banner");
  const mode = Store.state();

  if (mode === "supabase") { el.hidden = true; return; }
  el.hidden = false;

  if (mode === "table-missing") {
    el.innerHTML = "<b>History isn't syncing between devices yet.</b> The cloud table hasn't been " +
      `created, so this browser is keeping its own separate log. One-time fix: open your Supabase ` +
      `project → SQL Editor, paste in <b>supabase-gators.sql</b>, run it, then reload here.`;
  } else {
    el.innerHTML = "<b>Working offline.</b> Couldn't reach the history database, so you're seeing " +
      "this device's saved copy. Anything recorded now syncs on the next successful load.";
  }
}

function renderKpis() {
  const s = state.data.summary;
  const played = s.gamesPlayed;
  const ti = state.data.teamIndex;
  const espnSixWins = ti && ti.odds ? ti.odds.sixWins : null;

  const tiles = [
    { label: "Record", value: s.record, sub: `${s.remainingGames} to play`, hero: true },
    {
      label: "Against the spread",
      value: played ? s.atsRecord : "—",
      sub: s.atsPct !== null ? `${s.atsPct}% cover rate` : "no games graded yet",
    },
    {
      label: "FPI straight up",
      value: played ? s.fpiSuRecord : "—",
      sub: s.fpiSuPct !== null ? `${s.fpiSuPct}% correct` : "no games graded yet",
    },
    { label: "Projected wins", value: fmt1(s.projectedWins), sub: `${fmt1(s.projectedLosses)} projected losses` },
    {
      // ESPN's own simulation when we have it; our independent-games estimate
      // otherwise. ESPN's is the number to trust — see the distribution note.
      label: "Bowl eligible",
      value: espnSixWins !== null ? `${espnSixWins.toFixed(1)}%`
        : s.bowlOdds === null ? "—" : `${s.bowlOdds}%`,
      sub: espnSixWins !== null ? "ESPN's odds of 6 wins" : "odds of reaching 6 wins",
    },
    {
      label: "FPI calibration",
      value: s.brier === null ? "—" : s.brier.toFixed(3),
      sub: s.brier === null ? "Brier score, once games are played" : brierVerdict(s.brier),
    },
  ];

  $("#kpis").innerHTML = tiles.map((t) => `<div class="kpi${t.hero ? " hero" : ""}">
      <div class="label">${t.label}</div>
      <div class="value">${t.value}</div>
      <div class="sub">${t.sub}</div>
    </div>`).join("");

  $("#kpi-note").textContent = played
    ? `${played} game${played === 1 ? "" : "s"} graded`
    : "Season hasn't kicked off — everything below is projection";
}

/* ------------------------------------------------- championship odds ---- */

function renderOdds() {
  const ti = state.data.teamIndex;
  const box = $("#odds-tiles");

  if (!ti) {
    box.innerHTML = `<div class="empty-note">Couldn't load ESPN's season projections this time — try Refresh.</div>`;
    $("#odds-note").textContent = "";
    return;
  }

  const pct = (v) => (v === null ? "—" : `${v < 0.1 && v > 0 ? "<0.1" : v.toFixed(1)}%`);
  const o = ti.odds;

  const tiles = [
    { label: "Win the SEC", value: pct(o.winConf), sub: "conference title" },
    { label: "Make the Playoff", value: pct(o.playoff), sub: "reach the CFP field", hero: true },
    { label: "Reach the final", value: pct(o.titleGame), sub: "national title game" },
    { label: "Win it all", value: pct(o.winTitle), sub: "national champions" },
    { label: "6+ wins", value: pct(o.sixWins), sub: "bowl eligible" },
    { label: "Win out", value: pct(o.winOut), sub: "all 12, no losses" },
  ];

  box.innerHTML = tiles.map((t) => `<div class="kpi${t.hero ? " hero" : ""}">
      <div class="label">${t.label}</div>
      <div class="value">${t.value}</div>
      <div class="sub">${t.sub}</div>
    </div>`).join("");

  $("#odds-note").textContent =
    "Straight from ESPN's FPI, which simulates the rest of the season thousands of times.";
}

/* ---------------------------------------------------- team profile ------ */

function renderProfile() {
  const ti = state.data.teamIndex;
  const box = $("#profile");
  if (!ti) { box.innerHTML = `<div class="empty-note">Team profile unavailable right now.</div>`; return; }

  const eff = ti.efficiency;
  const hasEfficiency = eff.total || eff.offense || eff.defense || eff.special;

  const meter = (name, e) => {
    if (!e) return "";
    // The efficiency value is already a 0-100 goodness score, so it doubles as
    // the bar's fill — no rescaling, nothing implied that isn't in the data.
    const secPart = e.sec ? ` · <b>${ordinal(e.sec.rank)}</b> of ${e.sec.of} in SEC` : "";
    return `<div class="meter-row">
      <div class="meter-name">${name}</div>
      <div class="meter-track"><div class="meter-fill" style="width:${Math.max(2, e.value)}%"></div></div>
      <div class="meter-rank"><b>#${e.rank ?? "—"}</b> of ${e.of}${secPart}</div>
    </div>`;
  };

  const rankLine = (label, rank, hint, invert) => {
    if (rank === null || rank === undefined || rank === 0) return "";
    return `<div class="rank-line">
      <span class="lbl">${label}<br><span class="hint">${hint}</span></span>
      <span class="v">#${rank}</span>
    </div>`;
  };

  const change = ti.rankChange7;
  const changeText = change ? ` <span class="delta ${dirClass(-change)}">${change > 0 ? "▲" : "▼"} ${Math.abs(change)} in 7d</span>` : "";

  box.innerHTML = `
    <div class="profile-grid">
      <div>
        <h3>Efficiency</h3>
        ${hasEfficiency ? `<div class="meters">
            ${meter("Overall", eff.total)}
            ${meter("Offense", eff.offense)}
            ${meter("Defense", eff.defense)}
            ${meter("Special teams", eff.special)}
          </div>`
          : `<div class="empty-note" style="padding:14px 4px;text-align:left">
              Efficiency ratings are earned on the field — ESPN publishes them once games
              have been played, so these bars fill in after the opener. They'll show how
              Florida's offense, defense and special teams rank against all 138 FBS teams
              and against the SEC.
            </div>`}
      </div>
      <div>
        <h3>Rating &amp; schedule</h3>
        <div class="rank-list">
          <div class="rank-line">
            <span class="lbl">FPI rating<br><span class="hint">points better than average${changeText}</span></span>
            <span class="v">${ti.fpi === null ? "—" : (ti.fpi > 0 ? "+" : "") + ti.fpi.toFixed(1)}</span>
          </div>
          <div class="rank-line">
            <span class="lbl">National rank<br><span class="hint">of ${ti.fpiOf} FBS teams${ti.fpiSec ? ` · ${ordinal(ti.fpiSec.rank)} in the SEC` : ""}</span></span>
            <span class="v">#${ti.fpiRank ?? "—"}</span>
          </div>
          ${rankLine("Strength of schedule", ti.resume.sos, "1 = toughest slate in the country")}
          ${rankLine("Remaining schedule", ti.resume.sosRemaining, "how hard the rest of it is")}
          ${rankLine("Strength of record", ti.resume.sor, "how impressive the results are so far")}
          ${rankLine("Game control", ti.resume.gameControl, "how much of each game they've led")}
        </div>
      </div>
    </div>`;
}

/* ------------------------------------------------- points & yards ------- */

function renderStats() {
  const stats = state.data.teamStats;
  const box = $("#team-stats");
  const note = $("#stats-note");

  if (!stats) {
    box.innerHTML = `<div class="empty-note" style="text-align:left;padding:14px 4px">
      Box-score stats start after the first game. Once Florida has played, this shows
      points and yards per game — scored and allowed — with where each figure ranks
      among all FBS teams and inside the SEC.
    </div>`;
    note.textContent = "Per game, for and against, with where that ranks.";
    return;
  }

  const line = (stat) => {
    const value = stat.isPct ? `${stat.value}%` : stat.value.toFixed(1);
    const secPart = stat.sec ? ` · ${ordinal(stat.sec.rank)} of ${stat.sec.of} SEC` : "";
    // Top and bottom thirds get a nudge of colour, with the rank always spelled
    // out beside it so the colour is never the only signal.
    let tone = "";
    if (stat.rank && stat.of) {
      if (stat.rank <= stat.of / 3) tone = "rk-good";
      else if (stat.rank > (stat.of * 2) / 3) tone = "rk-bad";
    }
    return `<div class="stat-line">
      <span class="lbl">${stat.label}</span>
      <span class="right">
        <span class="v">${value}</span>
        <span class="rk"><span class="${tone}">#${stat.rank ?? "—"}</span> of ${stat.of}${secPart}</span>
      </span>
    </div>`;
  };

  box.innerHTML = `<div class="stat-cols">
      <div>
        <h3 style="font-family:Oswald,'Arial Narrow',sans-serif;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);font-weight:500;margin-bottom:6px">Offense</h3>
        ${stats.offense.map(line).join("")}
      </div>
      <div>
        <h3 style="font-family:Oswald,'Arial Narrow',sans-serif;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);font-weight:500;margin-bottom:6px">Defense <span style="text-transform:none;letter-spacing:0">(allowed)</span></h3>
        ${stats.defense.map(line).join("")}
      </div>
    </div>`;

  note.textContent = "Per game, for and against. Defensive ranks are ESPN's — #1 allows the fewest.";
}

function ordinal(n) {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return n + "th";
  return n + (["th", "st", "nd", "rd"][n % 10] || "th");
}

function brierVerdict(b) {
  if (b < 0.15) return "sharp (0.25 = coin flip)";
  if (b < 0.25) return "better than a coin flip";
  return "worse than a coin flip";
}

function renderNext() {
  const d = state.data;
  const game = d.games.find((g) => !g.completed) || d.games[d.games.length - 1];
  if (!game) return;

  const fpi = game.fpi || {};
  const odds = game.odds || {};
  const mv = game.movement;
  const kickoff = new Date(game.date);

  $("#next-game").innerHTML = `
    <div class="next-teams">
      <div class="matchup">
        <img src="${FLORIDA_LOGO}" alt="Florida">
        <span class="vs">${game.homeAway === "away" ? "at" : "vs"}</span>
        ${game.opponentLogo ? `<img src="${game.opponentLogo}" alt="">` : ""}
      </div>
      <div>
        <div class="next-title">
          ${game.opponentRank ? `<span class="rank">#${game.opponentRank}</span> ` : ""}${game.opponent}
        </div>
        <div class="next-meta">
          <strong>${kickoff.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</strong>
          · ${game.timeSet === false ? "time TBD" : kickoff.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          ${game.tv ? " · " + game.tv : ""}
          ${game.venue ? " · " + game.venue : ""}
        </div>
      </div>
    </div>
    <div class="next-nums">
      <div>
        <div class="n">${fpi.winPct === undefined || fpi.winPct === null ? "—" : fpi.winPct.toFixed(1) + "%"}</div>
        <div class="l">FPI win prob</div>
        ${mv ? `<div class="next-meta ${dirClass(mv.changeRecent)}">${signed(mv.changeRecent)} pts / 7d</div>` : ""}
      </div>
      <div>
        <div class="n">${odds.spread === undefined || odds.spread === null ? "—" : signedSpread(odds.spread)}</div>
        <div class="l">Spread</div>
        <div class="next-meta">${odds.spread === undefined || odds.spread === null ? "not posted yet" : (odds.provider || "")}</div>
      </div>
      <div>
        <div class="n">${fpi.predMargin === undefined || fpi.predMargin === null ? "—" : signed(fpi.predMargin)}</div>
        <div class="l">FPI margin</div>
        <div class="next-meta">${edgeNote(fpi.predMargin, odds.spread)}</div>
      </div>
    </div>`;
}

function edgeNote(pred, spread) {
  if (pred === null || pred === undefined || spread === null || spread === undefined) return "";
  const diff = pred - -spread;
  if (Math.abs(diff) < 0.5) return "matches the line";
  return `${Math.abs(diff).toFixed(1)} ${diff > 0 ? "higher" : "lower"} than the line`;
}

/* ----------------------------------------------------------- selection --- */

function select(id) {
  if (state.selected.includes(id)) return;
  if (state.selected.length >= MAX_SELECTED) deselect(state.selected[0]);
  const used = new Set(state.slots.values());
  const slot = SERIES_SLOTS.findIndex((_, i) => !used.has(i));
  state.slots.set(id, slot === -1 ? 0 : slot);
  state.selected.push(id);
}

function deselect(id) {
  state.selected = state.selected.filter((x) => x !== id);
  state.slots.delete(id);
}

function colorOf(id) {
  const slot = state.slots.get(id);
  return slot === undefined ? "var(--context)" : `var(${SERIES_SLOTS[slot]})`;
}

function renderChips() {
  const box = $("#game-chips");
  box.innerHTML = state.data.games.map((g) => {
    const on = state.selected.includes(g.id);
    return `<button class="chip" aria-pressed="${on}" data-id="${g.id}" style="${on ? `color:${colorOf(g.id)}` : ""}">
      <span class="dot" ${on ? `style="background:${colorOf(g.id)}"` : ""}></span>${g.opponentShort || g.opponent}
    </button>`;
  }).join("");

  box.querySelectorAll(".chip").forEach((chip) => {
    chip.onclick = () => {
      const id = chip.dataset.id;
      state.selected.includes(id) ? deselect(id) : select(id);
      renderChips();
      renderFpiChart();
    };
  });
}

/* -------------------------------------------------------------- charts --- */

const NS = "http://www.w3.org/2000/svg";
function el(name, attrs = {}, text) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderFpiChart() {
  const host = $("#fpi-chart");
  const games = state.data.games.filter((g) => (g.history || []).some((p) => p.wp !== null));
  if (!games.length) {
    host.innerHTML = `<div class="empty-note">No FPI history recorded yet.</div>`;
    $("#fpi-caption").textContent = "";
    return;
  }

  const series = games.map((g) => ({
    id: g.id,
    name: g.opponentShort || g.opponent,
    selected: state.selected.includes(g.id),
    color: colorOf(g.id),
    points: g.history.filter((p) => p.wp !== null).map((p) => ({ t: new Date(p.t), y: p.wp })),
  }));

  const single = new Set(series.flatMap((s) => s.points.map((p) => +p.t))).size < 2;

  drawLines(host, series, {
    yMin: 0, yMax: 100, yTicks: [0, 25, 50, 75, 100],
    yFormat: (v) => v + "%",
    baseline: 50, baselineLabel: "coin flip",
    height: 300,
    tipFormat: (v) => v.toFixed(1) + "%",
  });

  $("#fpi-caption").textContent = single
    ? "Only one FPI run recorded so far — each line becomes a curve once ESPN posts its next update (usually overnight)."
    : "Florida's win probability in each selected game. Grey lines are the games you haven't highlighted.";
}

/* ---------------------------------------------------------- weekly grid --- */

function renderWeekly() {
  const table = $("#weekly-table");
  const note = $("#weekly-note");
  const weekly = Analysis.weeklySnapshots(state.data.games, state.history);

  if (!weekly.weeks.length) {
    table.innerHTML = `<tbody><tr><td class="empty-note">No weekly snapshots yet.</td></tr></tbody>`;
    note.innerHTML = "";
    return;
  }

  const head = `<thead><tr>
      <th class="game-col">Game</th>
      ${weekly.weeks.map((w) => `<th class="wk${w.state === "current" ? " current" : ""}">
        ${w.label}${w.state === "current" ? "<br><span style='font-weight:500'>live</span>" : ""}
      </th>`).join("")}
    </tr></thead>`;

  const body = weekly.rows.map((row) => {
    const game = state.data.games.find((g) => g.id === row.id);
    const cells = row.cells.map((cell) => {
      if (cell.done) {
        return `<td class="done" title="Already played">${cell.result === "W" ? "W" : cell.result === "L" ? "L" : "—"}</td>`;
      }
      if (cell.wp === null) return `<td class="blank">·</td>`;

      const delta = cell.delta !== null && Math.abs(cell.delta) >= 0.1
        ? `<span class="wdelta">${cell.delta > 0 ? "▲" : "▼"} ${Math.abs(cell.delta).toFixed(1)}</span>`
        : "";
      const title = `${row.opponent} — FPI ${cell.wp.toFixed(1)}% ${cell.locked ? "(locked)" : "(still moving)"}`;
      return `<td class="cell${cell.isGameWeek ? " gameweek" : ""}"
        style="background:${divergingFill(cell.wp)}" title="${title}">
        ${cell.wp.toFixed(1)}${delta}
      </td>`;
    }).join("");

    return `<tr>
      <td class="game-col">
        <span class="loc">${locWord(game.homeAway)}</span>
        ${game.opponentRank ? `<span class="rank">#${game.opponentRank}</span> ` : ""}${row.name}
      </td>
      ${cells}
    </tr>`;
  }).join("");

  table.innerHTML = head + `<tbody>${body}</tbody>`;

  const locked = weekly.weeks.filter((w) => w.state === "locked").length;
  note.innerHTML = `
    <span class="swatch-row">
      <span>Opponent favoured</span>
      <span class="swatch">
        <i style="background:${divergingFill(5)}"></i><i style="background:${divergingFill(25)}"></i>
        <i style="background:${divergingFill(50)}"></i>
        <i style="background:${divergingFill(75)}"></i><i style="background:${divergingFill(95)}"></i>
      </span>
      <span>Florida favoured</span>
    </span>
    <span class="item"><span style="box-shadow:inset 0 0 0 2px var(--uf-orange);width:12px;height:12px;border-radius:3px;display:inline-block"></span> the week that game is played</span>
    <span class="item">${locked} week${locked === 1 ? "" : "s"} locked · Wk ${weekly.currentWeek} still moving</span>`;
}

/**
 * Win probability is diverging around 50%: a coin flip is the neutral middle,
 * and each side leans to its own pole. Mixed against the surface so the number
 * on top stays readable in both themes.
 */
function divergingFill(wp) {
  const strength = Math.min(1, Math.abs(wp - 50) / 50) * 55;
  const pole = wp >= 50 ? "--div-cool" : "--div-warm";
  return `color-mix(in oklab, var(${pole}) ${strength.toFixed(0)}%, var(--surface-1))`;
}

function renderProjection() {
  const host = $("#proj-chart");
  const timeline = state.data.timeline || [];
  if (!timeline.length) { host.innerHTML = `<div class="empty-note">Nothing logged yet.</div>`; return; }

  const values = timeline.map((d) => d.wins);
  const pad = Math.max(0.6, (Math.max(...values) - Math.min(...values)) * 0.4);

  drawLines(host, [{
    id: "proj", name: "Projected wins", selected: true, color: "var(--series-2)",
    points: timeline.map((d) => ({ t: new Date(d.date + "T12:00:00Z"), y: d.wins })),
  }], {
    yMin: Math.max(0, Math.floor(Math.min(...values) - pad)),
    yMax: Math.min(state.data.games.length, Math.ceil(Math.max(...values) + pad)),
    yTicks: null,
    yFormat: (v) => v.toFixed(1),
    height: 210,
    tipFormat: (v) => v.toFixed(2) + " wins",
    hideLegendNames: true,
  });

  const first = timeline[0].wins;
  const last = timeline[timeline.length - 1].wins;
  $("#proj-caption").textContent = timeline.length < 2
    ? `FPI's opening projection: ${last.toFixed(1)} wins. The line grows a point per day.`
    : `${signed(+(last - first).toFixed(2))} wins since tracking began (${first.toFixed(1)} → ${last.toFixed(1)}).`;
}

/**
 * Multi-series time-series line chart with crosshair + tooltip.
 * Unselected series draw first in the de-emphasis grey, so highlighted games sit
 * on top of their context instead of competing with it.
 */
function drawLines(host, series, opts) {
  const W = host.clientWidth || 720;
  const H = opts.height;
  const M = { top: 12, right: 52, bottom: 26, left: 38 };

  const pts = series.flatMap((s) => s.points);
  if (!pts.length) { host.innerHTML = `<div class="empty-note">No data.</div>`; return; }

  let t0 = Math.min(...pts.map((p) => +p.t));
  let t1 = Math.max(...pts.map((p) => +p.t));
  // One lone reading so far: seat it near the left edge rather than the middle,
  // so its labels have somewhere to go and the day it was taken still reads.
  if (t0 === t1) { t0 -= 21600000; t1 += 151200000; }

  const x = (t) => M.left + ((+t - t0) / (t1 - t0)) * (W - M.left - M.right);
  const y = (v) => M.top + (1 - (v - opts.yMin) / (opts.yMax - opts.yMin)) * (H - M.top - M.bottom);

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img" });

  const ticks = opts.yTicks || niceTicks(opts.yMin, opts.yMax, 4);
  const axis = el("g", { class: "axis" });
  ticks.forEach((v) => {
    axis.appendChild(el("line", { x1: M.left, x2: W - M.right, y1: y(v), y2: y(v) }));
    axis.appendChild(el("text", { x: M.left - 8, y: y(v) + 3.5, "text-anchor": "end", class: "tick-label" }, opts.yFormat(v)));
  });
  svg.appendChild(axis);

  if (opts.baseline !== undefined) {
    svg.appendChild(el("line", {
      x1: M.left, x2: W - M.right, y1: y(opts.baseline), y2: y(opts.baseline),
      stroke: "var(--border-str)", "stroke-dasharray": "3 3", "stroke-width": 1,
    }));
    svg.appendChild(el("text", { x: W - M.right + 6, y: y(opts.baseline) + 3.5, class: "tick-label" }, opts.baselineLabel || ""));
  }

  const dayFmt = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  svg.appendChild(el("text", { x: M.left, y: H - 7, class: "tick-label" }, dayFmt(t0)));
  svg.appendChild(el("text", { x: W - M.right, y: H - 7, class: "tick-label", "text-anchor": "end" }, dayFmt(t1)));

  const path = (s) => s.points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.y).toFixed(1)}`).join("");

  const ordered = [...series.filter((s) => !s.selected), ...series.filter((s) => s.selected)];
  const labels = [];
  ordered.forEach((s) => {
    if (s.points.length === 1) {
      const p = s.points[0];
      svg.appendChild(el("circle", {
        cx: x(p.t), cy: y(p.y), r: s.selected ? 4.5 : 3,
        fill: s.selected ? s.color : "var(--context)",
        stroke: "var(--surface-1)", "stroke-width": 2,
      }));
    } else {
      svg.appendChild(el("path", {
        d: path(s), class: "line" + (s.selected ? "" : " context"),
        stroke: s.selected ? s.color : "var(--context)",
      }));
    }

    if (s.selected && !opts.hideLegendNames) {
      const last = s.points[s.points.length - 1];
      labels.push({ x: x(last.t) + 8, y: y(last.y) + 3.5, name: s.name, color: s.color });
    }
  });

  // Two games can sit a point apart in win probability, which would stack their
  // labels on top of each other. Nudge them apart, keeping their order.
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) {
    if (labels[i].y - labels[i - 1].y < 13) labels[i].y = labels[i - 1].y + 13;
  }
  const overflow = labels.length ? labels[labels.length - 1].y - (H - M.bottom) : 0;
  if (overflow > 0) labels.forEach((l) => (l.y -= overflow));
  labels.forEach((l) => svg.appendChild(el("text", { x: l.x, y: l.y, class: "end-label", fill: l.color }, l.name)));

  const hoverLine = el("line", { y1: M.top, y2: H - M.bottom, stroke: "var(--border-str)", "stroke-width": 1, opacity: 0 });
  svg.appendChild(hoverLine);
  const dots = el("g");
  svg.appendChild(dots);

  const overlay = el("rect", {
    x: M.left, y: M.top, width: Math.max(1, W - M.left - M.right), height: H - M.top - M.bottom,
    fill: "transparent", style: "cursor:crosshair",
  });
  svg.appendChild(overlay);

  const tip = $("#tip");
  const shown = series.filter((s) => s.selected);
  const stamps = [...new Set(pts.map((p) => +p.t))].sort((a, b) => a - b);

  overlay.addEventListener("pointermove", (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    const target = t0 + ((px - M.left) / (W - M.left - M.right)) * (t1 - t0);
    const nearest = stamps.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a), stamps[0]);

    hoverLine.setAttribute("x1", x(nearest));
    hoverLine.setAttribute("x2", x(nearest));
    hoverLine.setAttribute("opacity", 1);

    dots.textContent = "";
    const rows = [];
    shown.forEach((s) => {
      const p = valueAt(s.points, nearest);
      if (!p) return;
      dots.appendChild(el("circle", {
        cx: x(nearest), cy: y(p.y), r: 4.5, fill: s.color, stroke: "var(--surface-1)", "stroke-width": 2,
      }));
      rows.push(`<div class="t-row"><span class="nm"><span class="sw" style="background:${s.color}"></span>${s.name}</span><b>${opts.tipFormat(p.y)}</b></div>`);
    });
    if (!rows.length) return;

    tip.innerHTML = `<div class="t-date">${new Date(nearest).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>${rows.join("")}`;
    tip.style.opacity = 1;
    tip.style.left = Math.min(window.innerWidth - 190, ev.clientX + 14) + "px";
    tip.style.top = Math.max(8, ev.clientY - 20) + "px";
  });

  overlay.addEventListener("pointerleave", () => {
    tip.style.opacity = 0;
    hoverLine.setAttribute("opacity", 0);
    dots.textContent = "";
  });

  host.textContent = "";
  host.appendChild(svg);
}

function valueAt(points, stamp) {
  let found = null;
  for (const p of points) if (+p.t <= stamp) found = p;
  return found || (points.length && +points[0].t === stamp ? points[0] : null);
}

function niceTicks(min, max, count) {
  const step = (max - min) / count;
  return Array.from({ length: count + 1 }, (_, i) => min + step * i);
}

function renderDistribution() {
  const host = $("#dist-chart");
  const s = state.data.summary;
  const dist = s.winDistribution || [];
  if (!dist.length) { host.innerHTML = `<div class="empty-note">No projection yet.</div>`; return; }

  // dist is indexed by ADDITIONAL wins; shift it onto final win totals.
  const bars = dist.map((p, k) => ({ wins: s.wins + k, p })).filter((b) => b.p >= 0.15);
  const W = host.clientWidth || 360;
  const H = 210;
  const M = { top: 10, right: 8, bottom: 26, left: 26 };
  const maxP = Math.max(...bars.map((b) => b.p));
  const bw = (W - M.left - M.right) / bars.length;

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img" });
  bars.forEach((b, i) => {
    const h = Math.max(2, (b.p / maxP) * (H - M.top - M.bottom));
    const bx = M.left + i * bw;
    svg.appendChild(el("rect", {
      x: bx + 2.5, y: H - M.bottom - h, width: Math.max(1, bw - 5), height: h, rx: 4,
      fill: "var(--series-1)", "fill-opacity": (0.35 + 0.65 * (b.p / maxP)).toFixed(2),
    }));
    svg.appendChild(el("text", { x: bx + bw / 2, y: H - M.bottom + 15, class: "tick-label", "text-anchor": "middle" }, b.wins));
    if (b.p >= maxP * 0.55) {
      svg.appendChild(el("text", {
        x: bx + bw / 2, y: H - M.bottom - h - 5, class: "tick-label", "text-anchor": "middle",
        style: "font-weight:600;fill:var(--text-2)",
      }, b.p.toFixed(0) + "%"));
    }
  });

  host.textContent = "";
  host.appendChild(svg);

  const best = bars.reduce((a, b) => (b.p > a.p ? b : a), bars[0]);
  const ti = state.data.teamIndex;
  const mine = s.bowlOdds;
  const theirs = ti && ti.odds ? ti.odds.sixWins : null;
  const caveat = (theirs !== null && mine !== null && Math.abs(theirs - mine) >= 1)
    ? ` This curve treats each game as independent, so it reads a little rosier than ESPN's ` +
      `simulation (${mine.toFixed(1)}% vs ${theirs.toFixed(1)}% for 6 wins) — a real season's results are correlated.`
    : "";

  $("#dist-caption").textContent =
    `Final win total (x-axis). Most likely finish: ${best.wins}-${state.data.games.length - best.wins} ` +
    `at ${best.p.toFixed(0)}%. Outcomes under 0.15% are hidden.` + caveat;
}

/* --------------------------------------------------------------- table --- */

function renderTable() {
  $("#games-body").innerHTML = withByes(state.data.games)
    .map((row) => (row.bye ? byeRow(row) : rowFor(row)))
    .join("");
}

/** Weeks Florida doesn't play show up as gaps in the week numbers — fill them in. */
function withByes(games) {
  const out = [];
  games.forEach((g, i) => {
    const prev = games[i - 1];
    if (prev && g.week && prev.week && g.week - prev.week > 1) {
      for (let w = prev.week + 1; w < g.week; w++) {
        const when = new Date(prev.date);
        when.setDate(when.getDate() + 7 * (w - prev.week));
        out.push({ bye: true, week: w, date: when.toISOString() });
      }
    }
    out.push(g);
  });
  return out;
}

function byeRow(row) {
  const when = new Date(row.date);
  return `<tr class="bye-row">
    <td class="muted">${row.week}</td>
    <td colspan="8">
      <span class="tag">BYE</span>
      <span class="muted" style="margin-left:8px">Open date — week of ${when.toLocaleDateString(undefined, { month: "long", day: "numeric" })}</span>
    </td>
  </tr>`;
}

function rowFor(g) {
  const fpi = g.fpi || {};
  const grade = g.grade || {};
  const mv = g.movement;
  const date = new Date(g.date);

  const shownWp = g.completed && grade.closingWp !== null && grade.closingWp !== undefined
    ? grade.closingWp : fpi.winPct;
  const spread = g.completed ? grade.closingSpread : (g.odds || {}).spread;

  let result = `<span class="muted">${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>`;
  if (g.state === "in") result = `<span class="tag">LIVE · ${g.statusDetail || ""}</span>`;
  else if (g.completed) result = `<span class="tag ${g.result === "W" ? "good" : "bad"}">${g.result} ${g.scoreFor}–${g.scoreAgainst}</span>`;

  let ats = `<span class="muted">—</span>`;
  if (grade.ats === "cover") ats = `<span class="tag good">Cover +${fmt1(grade.atsMargin)}</span>`;
  else if (grade.ats === "no cover") ats = `<span class="tag bad">No cover ${fmt1(grade.atsMargin)}</span>`;
  else if (grade.ats === "push") ats = `<span class="tag">Push</span>`;

  let call = `<span class="muted">—</span>`;
  if (grade.fpiCorrect === true) call = `<span class="tag good">Right · ${signed(grade.fpiMarginError)} pts</span>`;
  else if (grade.fpiCorrect === false) call = `<span class="tag bad">Wrong · ${signed(grade.fpiMarginError)} pts</span>`;
  else if (grade.fpiPick === "toss-up") call = `<span class="tag">Toss-up</span>`;

  const move = mv && Math.abs(mv.changeTotal) >= 0.05
    ? `<span class="delta ${dirClass(mv.changeTotal)}">${signed(mv.changeTotal)}</span>`
    : `<span class="delta flat">—</span>`;

  return `<tr>
    <td class="muted">${g.week ?? ""}</td>
    <td>
      <div class="opp">
        ${g.opponentLogo ? `<img src="${g.opponentLogo}" alt="" loading="lazy">` : ""}
        <span class="loc">${locWord(g.homeAway)}</span>
        ${g.opponentRank ? `<span class="rank">#${g.opponentRank}</span>` : ""}
        <span>${g.opponent}</span>
      </div>
    </td>
    <td class="num">${shownWp === null || shownWp === undefined ? "—" : shownWp.toFixed(1) + "%"}</td>
    <td class="num">${move}</td>
    <td>${sparkline(g)}</td>
    <td class="num">${spread === null || spread === undefined ? `<span class="muted">n/a</span>` : signedSpread(spread)}</td>
    <td>${result}</td>
    <td>${ats}</td>
    <td>${call}</td>
  </tr>`;
}

function sparkline(g) {
  const pts = (g.history || []).filter((p) => p.wp !== null);
  if (pts.length < 2) return `<span class="muted" style="font-size:11px">—</span>`;
  const w = 62, h = 20;
  const ys = pts.map((p) => p.wp);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const span = hi - lo || 1;
  const d = pts.map((p, i) =>
    `${i ? "L" : "M"}${((i / (pts.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((p.wp - lo) / span) * (h - 4)).toFixed(1)}`
  ).join("");
  const rising = ys[ys.length - 1] >= ys[0];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <path d="${d}" fill="none" stroke="${rising ? "var(--good)" : "var(--bad)"}" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
}

/* ------------------------------------------------------------ accuracy --- */

function renderAccuracy() {
  const s = state.data.summary;
  if (!s.gamesPlayed) {
    $("#accuracy").innerHTML = `<div class="empty-note">
      Once Florida plays, this panel grades every FPI number three ways: did it pick the
      winner, how far off was its predicted margin, and was its confidence calibrated —
      plus whether it read each game better than the betting market did.
    </div>`;
    return;
  }

  const cards = [
    { h: "Picking winners", v: s.fpiSuRecord, p: `${s.fpiSuPct}% of games. Whether FPI's favourite actually won.` },
    {
      h: "Margin error",
      v: s.fpiMae === null ? "—" : `${s.fpiMae} pts`,
      p: s.vegasMae === null
        ? "Average miss between FPI's predicted margin and the real one."
        : `Vegas averaged ${s.vegasMae} pts. ${s.fpiMae < s.vegasMae ? "FPI is closer." : s.fpiMae > s.vegasMae ? "The market is closer." : "Dead even."}`,
    },
    {
      h: "Calibration",
      v: s.brier === null ? "—" : s.brier.toFixed(3),
      p: `Brier score — 0 is perfect, 0.25 is what saying "50%" every week gets you. ${brierVerdict(s.brier)}.`,
    },
    {
      h: "FPI vs. the market",
      v: `${s.fpiBeatVegas}–${s.vegasBeatFpi}`,
      p: s.fpiAtsRecord
        ? `Games where FPI's number landed closer than the closing line. Betting FPI's disagreements with the line: ${s.fpiAtsRecord}.`
        : "Games where FPI's number landed closer than the closing line.",
    },
  ];

  $("#accuracy").innerHTML = `<div class="kpis" style="box-shadow:none">
    ${cards.map((c) => `<div>
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);font-weight:600">${c.h}</div>
      <div style="font-size:25px;font-weight:670;margin:2px 0 3px">${c.v}</div>
      <div style="font-size:12.5px;color:var(--text-2)">${c.p}</div>
    </div>`).join("")}
  </div>`;
}

/* --------------------------------------------------------------- utils --- */

const locWord = (homeAway) => (homeAway === "away" ? "@" : "vs");

function signed(n) {
  if (n === null || n === undefined) return "—";
  return (n > 0 ? "+" : "") + n.toFixed(1);
}
function signedSpread(sp) {
  return sp === 0 ? "PK" : (sp > 0 ? "+" : "") + sp;
}
function dirClass(n) {
  if (n === null || n === undefined || Math.abs(n) < 0.05) return "flat";
  return n > 0 ? "up" : "down";
}
function relTime(iso) {
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 90) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

/* ---------------------------------------------------------------- boot --- */

$("#refresh-btn").onclick = () => pull(true);

const isDark = () =>
  getComputedStyle(document.documentElement).getPropertyValue("--surface-0").trim() === "#121213";

/** The button shows where you're going, not where you are. */
function syncThemeButton() {
  const btn = $("#theme-btn");
  const dark = isDark();
  btn.textContent = dark ? "☀" : "☾";
  btn.title = dark ? "Switch to light mode" : "Switch to dark mode";
  btn.setAttribute("aria-label", btn.title);
}

$("#theme-btn").onclick = () => {
  const next = isDark() ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("gatorTracker.theme", next); } catch (e) {}
  syncThemeButton();
  if (state.data) render();
};

try {
  const saved = localStorage.getItem("gatorTracker.theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
} catch (e) {}
syncThemeButton();

// Following the system theme means reacting when the system changes.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (document.documentElement.getAttribute("data-theme") === "auto") {
    syncThemeButton();
    if (state.data) render();
  }
});

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.data) { renderFpiChart(); renderProjection(); renderDistribution(); }
  }, 150);
});

// Coming back to a phone tab that's been open for days should show fresh data.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) pull(false);
});
setInterval(() => pull(false), 60000);

boot();
