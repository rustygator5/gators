/* ESPN data layer — the browser-side twin of the local app's espn.py.
 *
 * Three endpoints per Florida game:
 *   schedule   site.api ... /teams/57/schedule        (opponent, score, status)
 *   predictor  sports.core.api ... /predictor         (FPI win %, predicted margin)
 *   odds       sports.core.api ... /odds              (DraftKings line)
 *
 * ESPN serves all three cross-origin, which is what lets this app run as a
 * static page with no server of its own.
 *
 * Everything is normalized to FLORIDA'S perspective:
 *   winPct     Florida's FPI win probability (0-100)
 *   predMargin FPI's predicted Florida margin (+ = Florida favoured)
 *   spread     Florida's spread (-7.5 = Florida favoured by 7.5)
 */
const ESPN = (() => {
  const FLORIDA_ID = "57";
  const SEASON = 2026;
  const SCHEDULE_URL = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/${FLORIDA_ID}/schedule?season=${SEASON}`;
  const CORE = (id, res) =>
    `https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/events/${id}/competitions/${id}/${res}`;

  async function getJson(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;      // a game with no line posted yields 404 — expected
      return await res.json();
    } catch (err) {
      return null;
    }
  }

  const teamIdFromRef = (ref) => {
    try { return ref.split("/teams/")[1].split("?")[0]; } catch (e) { return null; }
  };

  async function fetchPredictor(eventId) {
    const data = await getJson(CORE(eventId, "predictor"));
    if (!data || !data.homeTeam) return null;

    for (const side of ["homeTeam", "awayTeam"]) {
      const block = data[side] || {};
      if (teamIdFromRef((block.team || {}).$ref) !== FLORIDA_ID) continue;
      const stats = {};
      (block.statistics || []).forEach((s) => { stats[s.name] = s.value; });
      if (stats.gameProjection === undefined || stats.gameProjection === null) return null;
      return {
        winPct: round2(stats.gameProjection),
        predMargin: round2(stats.teamPredPtDiff || 0),
        asOf: data.lastModified || null,
      };
    }
    return null;
  }

  async function fetchOdds(eventId) {
    const data = await getJson(CORE(eventId, "odds"));
    const items = (data && data.items) || [];
    for (const item of items) {
      for (const side of ["homeTeamOdds", "awayTeamOdds"]) {
        const block = item[side] || {};
        if (teamIdFromRef((block.team || {}).$ref) !== FLORIDA_ID) continue;
        const current = block.current || {};
        const spread = parseSpread((current.pointSpread || {}).american);
        if (spread === null) continue;
        return {
          spread,
          overUnder: item.overUnder ?? null,
          moneyLine: (current.moneyLine || {}).alternateDisplayValue ?? null,
          provider: (item.provider || {}).name || null,
        };
      }
    }
    return null;
  }

  function parseSpread(raw) {
    if (raw === null || raw === undefined) return null;
    const text = String(raw).trim().toUpperCase().replace("+", "");
    if (["EVEN", "EV", "PK", "PICK", "PICK'EM"].includes(text)) return 0;
    const value = parseFloat(text);
    return Number.isNaN(value) ? null : value;
  }

  async function fetchSchedule() {
    const data = await getJson(SCHEDULE_URL);
    if (!data) return [];

    const games = [];
    for (const event of data.events || []) {
      const comp = (event.competitions || [{}])[0];
      const competitors = comp.competitors || [];
      const us = competitors.find((c) => (c.team || {}).id === FLORIDA_ID);
      const them = competitors.find((c) => (c.team || {}).id !== FLORIDA_ID);
      if (!us || !them) continue;

      const status = ((comp.status || {}).type) || {};
      const opp = them.team || {};
      const scoreFor = intOrNull(us.score && us.score.value !== undefined ? us.score.value : us.score);
      const scoreAgainst = intOrNull(them.score && them.score.value !== undefined ? them.score.value : them.score);

      games.push({
        id: event.id,
        week: (event.week || {}).number ?? null,
        date: event.date,
        opponent: opp.displayName,
        opponentShort: opp.abbreviation || opp.shortDisplayName,
        opponentLogo: logoOf(opp),
        opponentRank: rankOf(them),
        homeAway: comp.neutralSite ? "neutral" : us.homeAway,
        venue: (comp.venue || {}).fullName || null,
        tv: broadcastOf(comp),
        // ESPN sends midnight UTC when kickoff isn't scheduled yet, which would
        // otherwise render as a confident "12:00 AM".
        timeSet: !!(event.timeValid ?? comp.timeValid ?? true),
        state: status.state,
        statusDetail: status.shortDetail || status.detail || null,
        completed: !!status.completed,
        scoreFor,
        scoreAgainst,
        result: resultOf(scoreFor, scoreAgainst, status.completed),
      });
    }
    games.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    return games;
  }

  function logoOf(team) {
    const logos = team.logos || [];
    const def = logos.find((l) => (l.rel || []).includes("default"));
    return (def || logos[0] || {}).href || null;
  }

  /** ESPN sends curatedRank 99 for everyone outside the top 25. */
  function rankOf(competitor) {
    const rank = intOrNull(((competitor.curatedRank) || {}).current);
    return rank && rank >= 1 && rank <= 25 ? rank : null;
  }

  function broadcastOf(comp) {
    for (const b of comp.broadcasts || []) {
      if ((b.names || []).length) return b.names[0];
      if (b.media && b.media.shortName) return b.media.shortName;
    }
    return null;
  }

  function intOrNull(value) {
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? null : n;
  }

  function resultOf(us, them, completed) {
    if (!completed || us === null || them === null) return null;
    return us > them ? "W" : us < them ? "L" : "T";
  }

  const round2 = (n) => Math.round(Number(n) * 100) / 100;

  /* ---- season-long FPI: the numbers behind ESPN's FPI page ---------------
   * One request returns every FBS team's FPI rating, championship odds, resume
   * ranks and efficiency ratings (~48KB gzipped). Having all 138 teams is what
   * lets us rank Florida inside the SEC as well as nationally — ESPN publishes
   * the national rank but not the conference one.
   */
  const POWERINDEX_URL =
    `https://site.api.espn.com/apis/fitt/v3/sports/football/college-football/powerindex?season=${SEASON}&limit=200`;
  const SEC_TEAMS_URL =
    `https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/${SEASON}/types/2/groups/8/teams?limit=50`;

  // Used only if the conference lookup fails; the SEC's roster rarely moves.
  const SEC_FALLBACK = ["2", "8", "57", "61", "96", "99", "142", "145",
                        "201", "238", "245", "251", "333", "344", "2579", "2633"];

  async function fetchSecIds() {
    const data = await getJson(SEC_TEAMS_URL);
    const ids = ((data || {}).items || [])
      .map((i) => teamIdFromRef(i.$ref))
      .filter(Boolean);
    return ids.length ? ids : SEC_FALLBACK;
  }

  async function fetchTeamIndex() {
    const [data, secIds] = await Promise.all([getJson(POWERINDEX_URL), fetchSecIds()]);
    if (!data || !data.teams) return null;

    // Values arrive as bare arrays; the category header names the columns.
    const columns = {};
    (data.categories || []).forEach((c) => { columns[c.name] = c.names || []; });

    const readStats = (team) => {
      const out = {};
      (team.categories || []).forEach((cat) => {
        const keys = columns[cat.name] || [];
        const values = cat.values || [];          // null before the season starts
        keys.forEach((key, i) => { out[key] = values[i] ?? null; });
      });
      return out;
    };

    const all = data.teams.map((t) => ({ id: t.team.id, stats: readStats(t) }));
    const florida = all.find((t) => t.id === FLORIDA_ID);
    if (!florida) return null;

    const sec = all.filter((t) => secIds.includes(t.id));
    const s = florida.stats;

    // Every efficiency and rating here is "higher is better" (ESPN's own rank 1
    // always holds the highest value), so one comparator covers them all.
    const rankAmong = (pool, key) => {
      const ranked = pool
        .filter((t) => typeof t.stats[key] === "number")
        .sort((a, b) => b.stats[key] - a.stats[key]);
      const index = ranked.findIndex((t) => t.id === FLORIDA_ID);
      return index === -1 ? null : { rank: index + 1, of: ranked.length };
    };

    const efficiency = (key, rankKey) => {
      if (typeof s[key] !== "number") return null;
      return {
        value: Math.round(s[key] * 10) / 10,
        rank: s[rankKey] ? Math.round(s[rankKey]) : null,
        of: all.filter((t) => typeof t.stats[key] === "number").length,
        sec: rankAmong(sec, key),
      };
    };

    const num = (v) => (typeof v === "number" ? v : null);

    return {
      fpi: num(s.fpi),
      fpiRank: s.fpirank ? Math.round(s.fpirank) : null,
      fpiOf: all.length,
      fpiSec: rankAmong(sec, "fpi"),
      rankChange7: num(s.rankchange7days),
      projWins: num(s.projectedw),
      projLosses: num(s.projectedl),
      odds: {
        winOut: num(s.probwinout),
        sixWins: num(s.prob6wins),
        winConf: num(s.probwinconf),
        playoff: num(s.probmakeplayoffs),
        titleGame: num(s.probmaketitlegame),
        winTitle: num(s.probwintitle),
      },
      resume: {
        sos: s.avgsosrank ? Math.round(s.avgsosrank) : null,
        sosRemaining: s.sosremainingrank ? Math.round(s.sosremainingrank) : null,
        sor: s.accomplishmentrank ? Math.round(s.accomplishmentrank) : null,
        gameControl: s.gamecontrolrank ? Math.round(s.gamecontrolrank) : null,
      },
      efficiency: {
        total: efficiency("totefficiency", "totefficiencyrank"),
        offense: efficiency("offefficiency", "offefficiencyrank"),
        defense: efficiency("defefficiency", "defefficiencyrank"),
        special: efficiency("stefficiency", "stefficiencyrank"),
      },
      secSize: sec.length,
      asOf: data.lastUpdated || null,
    };
  }

  /* ---- box-score team stats ---------------------------------------------
   * Points and yards per game, for and against, with ESPN's national ranks.
   *
   * ESPN files the team totals under the "passing" category (totalPointsPerGame
   * and yardsPerGame live there, oddly), and splits every category two ways:
   * splitId "0" is what Florida did, "900" is what opponents did to them — so
   * the same fields give offense and defense.
   *
   * Ranks in the opponent split are already defence-correct (rank 1 = fewest
   * allowed, verified against the 2025 leaders), so they're used as published.
   */
  const BYTEAM_URL = (season) =>
    "https://site.web.api.espn.com/apis/common/v3/sports/football/college-football" +
    `/statistics/byteam?season=${season}&seasontype=2&limit=200`;

  const OWN = "0";
  const OPPONENT = "900";

  // [key, category, label, lower-is-better-when-on-defense]
  const STAT_PICKS = [
    ["totalPointsPerGame", "passing", "Points"],
    ["yardsPerGame", "passing", "Total yards"],
    ["passingYardsPerGame", "passing", "Passing"],
    ["rushingYardsPerGame", "rushing", "Rushing"],
    ["thirdDownConvPct", "miscellaneous", "3rd down %"],
  ];

  /**
   * `season` is overridable only so the parser can be checked against a
   * completed season — nothing calls it with an argument in normal use.
   */
  async function fetchTeamStats(season = SEASON) {
    const data = await getJson(BYTEAM_URL(season));
    if (!data || !data.teams) return null;

    const columns = {};
    (data.categories || []).forEach((c) => { columns[c.name] = c.names || []; });

    // team id -> split -> stat name -> {value, rank}
    const read = (team) => {
      const bySplit = { [OWN]: {}, [OPPONENT]: {} };
      (team.categories || []).forEach((cat) => {
        const target = bySplit[cat.splitId];
        if (!target) return;
        const keys = columns[cat.name] || [];
        keys.forEach((key, i) => {
          if (target[key]) return;                     // duplicate column: keep the first
          const value = (cat.values || [])[i];
          const rank = parseInt((cat.ranks || [])[i], 10);
          if (typeof value !== "number") return;
          target[key] = { value, rank: Number.isNaN(rank) ? null : rank };
        });
      });
      return bySplit;
    };

    const all = data.teams.map((t) => ({ id: t.team.id, splits: read(t) }));
    const florida = all.find((t) => t.id === FLORIDA_ID);
    if (!florida) return null;                          // no games played yet

    const secIds = await fetchSecIds();
    const sec = all.filter((t) => secIds.includes(t.id));

    const secRank = (split, key, lowerIsBetter) => {
      const ranked = sec
        .filter((t) => t.splits[split][key])
        .sort((a, b) => (lowerIsBetter ? 1 : -1) * (a.splits[split][key].value - b.splits[split][key].value));
      const index = ranked.findIndex((t) => t.id === FLORIDA_ID);
      return index === -1 ? null : { rank: index + 1, of: ranked.length };
    };

    const side = (split) => STAT_PICKS.map(([key, , label]) => {
      const stat = florida.splits[split][key];
      if (!stat) return null;
      // On defence fewer points and yards are better; a 3rd-down rate allowed
      // is the same story, so the whole opponent split reads lower-is-better.
      const lowerIsBetter = split === OPPONENT;
      return {
        key, label,
        value: Math.round(stat.value * 10) / 10,
        rank: stat.rank,
        of: all.filter((t) => t.splits[split][key]).length,
        sec: secRank(split, key, lowerIsBetter),
        isPct: key.endsWith("Pct"),
      };
    }).filter(Boolean);

    const offense = side(OWN);
    const defense = side(OPPONENT);
    if (!offense.length && !defense.length) return null;

    return { offense, defense, season };
  }

  /** Run promises a few at a time — 25 simultaneous requests is rude. */
  async function inBatches(items, size, worker) {
    const out = [];
    for (let i = 0; i < items.length; i += size) {
      out.push(...(await Promise.all(items.slice(i, i + size).map(worker))));
    }
    return out;
  }

  async function fetchAll() {
    const games = await fetchSchedule();
    if (!games.length) return [];

    const fpis = await inBatches(games, 4, (g) => fetchPredictor(g.id));
    const odds = await inBatches(games, 4, (g) => fetchOdds(g.id));
    games.forEach((g, i) => { g.fpi = fpis[i]; g.odds = odds[i]; });
    return games;
  }

  return { fetchAll, fetchTeamIndex, fetchTeamStats, SEASON };
})();
