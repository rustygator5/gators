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

  return { fetchAll, SEASON };
})();
