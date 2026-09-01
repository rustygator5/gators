/* Grading and season math — the browser-side twin of the local app's analysis.py.
 *
 *   Did Florida beat the spread?  cover / push / no cover, against the CLOSING
 *                                 line (the last line logged before kickoff).
 *   Was FPI right?                straight up, by margin error, and by Brier
 *                                 score — the only honest way to grade a model
 *                                 that says "62%" instead of "Florida wins".
 *                                 0.25 is what saying 50% every week scores.
 *   Does FPI beat Vegas?          whose number landed closer to the real margin.
 *   Where's the season heading?   remaining win probabilities combined into a
 *                                 projected total and bowl-eligibility odds.
 */
const Analysis = (() => {
  const vegasMargin = (spread) => (spread === null || spread === undefined ? null : -spread);
  const r1 = (n) => Math.round(n * 10) / 10;

  /** `closing` = {wp, pm, sp} as they stood at kickoff. */
  function gradeGame(game, closing) {
    const out = {
      ats: null, atsMargin: null,
      fpiPick: null, fpiCorrect: null,
      fpiMarginError: null, fpiAbsError: null, vegasAbsError: null,
      brier: null, fpiVsVegas: null,
      fpiAtsSide: null, fpiAtsCorrect: null,
      closingWp: closing.wp ?? null,
      closingPm: closing.pm ?? null,
      closingSpread: closing.sp ?? null,
    };

    if (!game.completed || game.scoreFor === null || game.scoreFor === undefined) return out;

    const actual = game.scoreFor - game.scoreAgainst;
    const won = game.result === "W";

    const spread = closing.sp;
    if (spread !== null && spread !== undefined) {
      const edge = actual + spread;           // >0 covered, 0 push, <0 missed
      out.atsMargin = r1(edge);
      out.ats = Math.abs(edge) < 1e-9 ? "push" : edge > 0 ? "cover" : "no cover";
    }

    const wp = closing.wp;
    if (wp !== null && wp !== undefined) {
      const prob = wp / 100;
      out.brier = Math.round((prob - (won ? 1 : 0)) ** 2 * 10000) / 10000;
      if (Math.abs(wp - 50) < 0.01) {
        out.fpiPick = "toss-up";
      } else {
        const pickedFlorida = wp > 50;
        out.fpiPick = pickedFlorida ? "FLA" : game.opponentShort;
        out.fpiCorrect = pickedFlorida === won;
      }
    }

    const pred = closing.pm;
    if (pred !== null && pred !== undefined) {
      out.fpiMarginError = r1(pred - actual);
      out.fpiAbsError = r1(Math.abs(pred - actual));
    }

    const vegas = vegasMargin(spread);
    if (vegas !== null) out.vegasAbsError = r1(Math.abs(vegas - actual));

    if (pred !== null && pred !== undefined && vegas !== null) {
      out.fpiVsVegas = out.fpiAbsError < out.vegasAbsError ? "fpi"
        : out.fpiAbsError > out.vegasAbsError ? "vegas" : "tie";

      // FPI disagreeing with the line is an implied pick against it.
      const diff = pred - vegas;
      if (Math.abs(diff) >= 0.5 && out.ats && out.ats !== "push") {
        out.fpiAtsSide = diff > 0 ? "FLA" : game.opponentShort;
        out.fpiAtsCorrect = (diff > 0) === (out.ats === "cover");
      }
    }

    return out;
  }

  function seasonSummary(games) {
    const played = games.filter((g) => g.completed);
    const upcoming = games.filter((g) => !g.completed);

    const wins = played.filter((g) => g.result === "W").length;
    const losses = played.filter((g) => g.result === "L").length;

    const ats = played.map((g) => g.grade.ats).filter(Boolean);
    const covers = ats.filter((a) => a === "cover").length;
    const fails = ats.filter((a) => a === "no cover").length;
    const pushes = ats.filter((a) => a === "push").length;

    const picks = played.map((g) => g.grade).filter((g) => g.fpiCorrect !== null);
    const hits = picks.filter((p) => p.fpiCorrect).length;

    const briers = played.map((g) => g.grade.brier).filter((v) => v !== null);
    const fpiErrs = played.map((g) => g.grade.fpiAbsError).filter((v) => v !== null);
    const vegErrs = played.map((g) => g.grade.vegasAbsError).filter((v) => v !== null);
    const duels = played.map((g) => g.grade.fpiVsVegas).filter(Boolean);
    const fpiAts = played.map((g) => g.grade.fpiAtsCorrect).filter((v) => v !== null);

    const remaining = upcoming
      .filter((g) => g.fpi && g.fpi.winPct !== null && g.fpi.winPct !== undefined)
      .map((g) => g.fpi.winPct / 100);

    const dist = winDistribution(remaining);
    const projected = wins + remaining.reduce((a, b) => a + b, 0);
    const mean = (arr, digits) => (arr.length
      ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10 ** digits) / 10 ** digits
      : null);

    return {
      record: `${wins}-${losses}`,
      wins, losses,
      gamesPlayed: played.length,
      atsRecord: `${covers}-${fails}` + (pushes ? `-${pushes}` : ""),
      atsPct: pct(covers, covers + fails),
      fpiSuRecord: `${hits}-${picks.length - hits}`,
      fpiSuPct: pct(hits, picks.length),
      brier: mean(briers, 4),
      fpiMae: mean(fpiErrs, 1),
      vegasMae: mean(vegErrs, 1),
      fpiBeatVegas: duels.filter((d) => d === "fpi").length,
      vegasBeatFpi: duels.filter((d) => d === "vegas").length,
      fpiAtsRecord: fpiAts.length
        ? `${fpiAts.filter(Boolean).length}-${fpiAts.filter((x) => !x).length}` : null,
      projectedWins: Math.round(projected * 10) / 10,
      projectedLosses: Math.round((games.length - projected) * 10) / 10,
      bowlOdds: upcoming.length
        ? Math.round(1000 * probAtLeast(dist, Math.max(0, 6 - wins))) / 10 : null,
      winDistribution: dist.map((p) => Math.round(p * 1000) / 10),
      remainingGames: upcoming.length,
    };
  }

  const pct = (hits, total) => (total ? Math.round((1000 * hits) / total) / 10 : null);

  /** Poisson-binomial: odds of winning exactly k of the remaining games. */
  function winDistribution(probs) {
    let dist = [1];
    for (const p of probs) {
      const next = new Array(dist.length + 1).fill(0);
      dist.forEach((prior, k) => {
        next[k] += prior * (1 - p);
        next[k + 1] += prior * p;
      });
      dist = next;
    }
    return dist;
  }

  function probAtLeast(dist, k) {
    if (k <= 0) return 1;
    return k < dist.length ? dist.slice(k).reduce((a, b) => a + b, 0) : 0;
  }

  /**
   * The last FPI and line recorded BEFORE kickoff — the numbers a prediction
   * should be graded against. Falls back to whatever exists if logging only
   * started after the game.
   */
  function closingValues(series, kickoffIso) {
    if (!series || !series.length) return { wp: null, pm: null, sp: null };
    const before = kickoffIso ? series.filter((p) => p.t <= kickoffIso) : series;
    const pool = before.length ? before : series;

    const lastPresent = (key) => {
      for (let i = pool.length - 1; i >= 0; i--) if (pool[i][key] !== null && pool[i][key] !== undefined) return pool[i][key];
      for (let i = series.length - 1; i >= 0; i--) if (series[i][key] !== null && series[i][key] !== undefined) return series[i][key];
      return null;
    };
    return { wp: lastPresent("wp"), pm: lastPresent("pm"), sp: lastPresent("sp") };
  }

  /**
   * Projected win total for every day with logged data: completed games count
   * as their real result, future games contribute their FPI odds AS THEY STOOD
   * THAT DAY.
   */
  function projectionTimeline(games, history) {
    const days = [...new Set(
      Object.values(history).flatMap((series) => series.map((p) => p.t.slice(0, 10)))
    )].sort();
    if (!days.length) return [];

    const kickoff = {};
    const finals = {};
    games.forEach((g) => {
      kickoff[g.id] = (g.date || "").slice(0, 10);
      if (g.completed) finals[g.id] = g.result === "W" ? 1 : 0;
    });

    return days.map((day) => {
      let total = 0;
      let counted = 0;
      for (const [id, series] of Object.entries(history)) {
        if (finals[id] !== undefined && (kickoff[id] || "") <= day) {
          total += finals[id];
          counted++;
          continue;
        }
        const wp = lastWpOnOrBefore(series, day);
        if (wp !== null) { total += wp / 100; counted++; }
      }
      return counted ? { date: day, wins: Math.round(total * 100) / 100, games: counted } : null;
    }).filter(Boolean);
  }

  function lastWpOnOrBefore(series, day) {
    let value = null;
    for (const p of series) if (p.t.slice(0, 10) <= day && p.wp !== null) value = p.wp;
    return value;
  }

  /** How far a game's win probability has moved recently, and overall. */
  function movement(series, days = 7) {
    const pts = (series || []).filter((p) => p.wp !== null && p.wp !== undefined);
    if (pts.length < 2) return null;

    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const recent = pts.filter((p) => p.t >= cutoff);
    const weekStart = recent.length ? recent[0].wp : pts[0].wp;
    const latest = pts[pts.length - 1].wp;

    return {
      current: latest,
      opened: pts[0].wp,
      changeTotal: r1(latest - pts[0].wp),
      changeRecent: r1(latest - weekStart),
      points: pts.length,
      high: Math.max(...pts.map((p) => p.wp)),
      low: Math.min(...pts.map((p) => p.wp)),
    };
  }

  return { gradeGame, seasonSummary, winDistribution, closingValues, projectionTimeline, movement };
})();
