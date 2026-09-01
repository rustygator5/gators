/* History storage.
 *
 * ESPN has no history endpoint — it only ever publishes FPI's current number —
 * so every trend line in this app is drawn from a log we keep ourselves.
 *
 * That log lives in Supabase (table `gator_fpi_history`, append-only) so the PC,
 * the laptop, and the phone all share one history. Every read is also mirrored
 * into localStorage, so the page still renders offline or if Supabase is down.
 *
 * If the table hasn't been created yet, the app degrades to a per-device
 * localStorage history and says so in the header — it never silently loses data.
 */
const Store = (() => {
  const SB_URL = "https://xuipllbtrsebavtffjdy.supabase.co";
  const SB_KEY = "sb_publishable_4Uc4-PMVI4Bsodk6FYYEjg_h2o5xZ0j";
  const TABLE = "gator_fpi_history";
  const SEASON = 2026;

  const CACHE_KEY = "gatorTracker.season";
  const HIST_KEY = "gatorTracker.history";

  // Day one of tracking, captured by the local Flask version before this page
  // existed. Seeded once into an empty table so the season's first FPI run
  // isn't lost — it can never be re-fetched from ESPN.
  const SEED = [
  {e:"401856637",t:"2026-09-01T10:46:20Z",wp:96.54,pm:28.37,sp:-26.5,ou:59.5},
  {e:"401856672",t:"2026-09-01T10:46:20Z",wp:99.45,pm:44.25,sp:null,ou:null},
  {e:"401856687",t:"2026-09-01T10:46:20Z",wp:48.38,pm:-0.55,sp:-1.5,ou:53.5},
  {e:"401856699",t:"2026-09-01T10:46:20Z",wp:49.76,pm:-0.08,sp:null,ou:null},
  {e:"401856708",t:"2026-09-01T10:46:20Z",wp:45.87,pm:-1.41,sp:null,ou:null},
  {e:"401856714",t:"2026-09-01T10:46:20Z",wp:62.15,pm:4.23,sp:null,ou:null},
  {e:"401856724",t:"2026-09-01T10:46:20Z",wp:12.17,pm:-16.85,sp:null,ou:null},
  {e:"401856734",t:"2026-09-01T10:46:20Z",wp:16.14,pm:-14.04,sp:12.5,ou:53.5},
  {e:"401856739",t:"2026-09-01T10:46:20Z",wp:45.43,pm:-1.56,sp:null,ou:null},
  {e:"401856884",t:"2026-09-01T10:46:20Z",wp:67.12,pm:6.08,sp:null,ou:null},
  {e:"401856748",t:"2026-09-01T10:46:20Z",wp:70.25,pm:7.33,sp:null,ou:null},
  {e:"401856759",t:"2026-09-01T10:46:20Z",wp:61.18,pm:3.88,sp:-4.5,ou:52.5},  ];

  // "supabase" | "local" | "table-missing" | "offline"
  let mode = "supabase";
  const state = () => mode;

  const headers = (extra) => Object.assign({
    apikey: SB_KEY,
    Authorization: "Bearer " + SB_KEY,
    "Content-Type": "application/json",
  }, extra || {});

  const rest = (path) => `${SB_URL}/rest/v1/${path}`;

  /* ---- localStorage mirror ---- */
  function readLocal(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function writeLocal(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* quota / private mode */ }
  }

  const loadCache = () => readLocal(CACHE_KEY, null);
  const saveCache = (games, teamIndex) =>
    writeLocal(CACHE_KEY, { games, teamIndex: teamIndex || null, updated: new Date().toISOString() });

  /* ---- history ---- */
  const rowToPoint = (row) => ({
    t: new Date(row.recorded_at).toISOString().replace(/\.\d{3}Z$/, "Z"),
    wp: numOrNull(row.win_pct),
    pm: numOrNull(row.pred_margin),
    sp: numOrNull(row.spread),
    ou: numOrNull(row.over_under),
  });

  const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));

  function group(rows) {
    const history = {};
    rows.forEach((row) => {
      (history[row.event_id] = history[row.event_id] || []).push(rowToPoint(row));
    });
    Object.values(history).forEach((series) => series.sort((a, b) => a.t.localeCompare(b.t)));
    return history;
  }

  async function loadHistory() {
    try {
      const res = await fetch(
        rest(`${TABLE}?season=eq.${SEASON}&select=event_id,recorded_at,win_pct,pred_margin,spread,over_under&order=recorded_at.asc`),
        { headers: headers() }
      );

      if (res.status === 404 || res.status === 400) { mode = "table-missing"; return localHistory(); }
      if (!res.ok) { mode = "offline"; return localHistory(); }

      const rows = await res.json();
      mode = "supabase";

      if (!rows.length) {
        // Fresh table: plant day one, then read it back as normal rows.
        await insert(SEED.map((p) => ({
          season: SEASON, event_id: p.e, recorded_at: p.t,
          win_pct: p.wp, pred_margin: p.pm, spread: p.sp, over_under: p.ou,
        })));
        return loadHistory();
      }

      const history = group(rows);
      writeLocal(HIST_KEY, history);
      return history;
    } catch (err) {
      mode = "offline";
      return localHistory();
    }
  }

  function localHistory() {
    const history = readLocal(HIST_KEY, null);
    if (history) return history;
    // Nothing stored on this device yet — start from the seed so the app is
    // never empty, even before the Supabase table exists.
    const seeded = {};
    SEED.forEach((p) => {
      (seeded[p.e] = seeded[p.e] || []).push({ t: p.t, wp: p.wp, pm: p.pm, sp: p.sp, ou: p.ou });
    });
    writeLocal(HIST_KEY, seeded);
    return seeded;
  }

  async function insert(rows) {
    if (!rows.length) return false;
    try {
      const res = await fetch(rest(TABLE), {
        method: "POST",
        headers: headers({ Prefer: "return=minimal" }),
        body: JSON.stringify(rows),
      });
      if (res.status === 404 || res.status === 400) { mode = "table-missing"; return false; }
      return res.ok;
    } catch (err) {
      return false;
    }
  }

  /**
   * Append a point for any game whose FPI or line changed since the last one on
   * record. Returns how many games moved. The history object is updated in
   * place so the caller can render without a round trip.
   */
  async function record(games, history) {
    const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const rows = [];

    games.forEach((game) => {
      const fpi = game.fpi || {};
      const odds = game.odds || {};
      const point = {
        t: stamp,
        wp: fpi.winPct ?? null,
        pm: fpi.predMargin ?? null,
        sp: odds.spread ?? null,
        ou: odds.overUnder ?? null,
      };
      if (point.wp === null && point.sp === null) return;

      const series = history[game.id] = history[game.id] || [];
      const last = series[series.length - 1];
      if (last && ["wp", "pm", "sp", "ou"].every((k) => last[k] === point[k])) return;

      series.push(point);
      rows.push({
        season: SEASON, event_id: game.id, recorded_at: stamp,
        win_pct: point.wp, pred_margin: point.pm, spread: point.sp, over_under: point.ou,
      });
    });

    if (rows.length) {
      writeLocal(HIST_KEY, history);
      if (mode === "supabase") await insert(rows);
    }
    return rows.length;
  }

  return { loadCache, saveCache, loadHistory, record, state, TABLE };
})();
