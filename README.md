# Gator Tracker

Florida Gators football, 2026: ESPN's FPI win probability, the betting line, the
final score — and the questions those three numbers actually answer.

**Live:** https://rustygator5.github.io/gators/

A static page. It calls ESPN's public JSON straight from the browser, so there's
no server, nothing to wake up, and it works the same on every device.

## What it shows

**Did Florida beat the spread?** Every completed game graded against the
*closing* line (the last line recorded before kickoff): cover / push / no cover.

**Was FPI right?** Three ways, because a probability is never simply "right":

| Measure | What it means |
|---|---|
| Straight up | Did FPI's favourite win? |
| Margin error | How far its predicted point margin missed by |
| Brier score | Calibration. 0 is perfect; **0.25** is what saying "50%" every week scores |
| FPI vs. the market | Whose number landed closer to the real margin — FPI's or the closing line's |

**How does FPI move?** ESPN has no history endpoint — it only publishes FPI's
*current* number. So this app keeps its own log: whenever a win probability or a
line changes, a row is appended to the `gator_fpi_history` table in Supabase.
The trend chart, the per-game sparklines, and the season-long projected-win line
are all drawn from that log, which means **the history only goes back as far as
the app has been open.** It's shared, so every device adds to the same one.

## Setup

The history table has to exist before devices can share a log. One time:

1. Open the Supabase project → **SQL Editor**
2. Paste in [`supabase-gators.sql`](supabase-gators.sql) and run it
3. Reload the page

Until that's done the app still works — it just keeps a separate history in each
browser and says so in a banner at the top.

## Files

| File | Role |
|---|---|
| `index.html` | Markup, theme, styles |
| `espn.js` | ESPN fetching, normalized to Florida's perspective |
| `analysis.js` | Cover/FPI grading, season roll-up, win-total distribution |
| `store.js` | Shared history (Supabase) + per-device mirror (localStorage) |
| `app.js` | Rendering and the hand-built SVG charts |
| `supabase-gators.sql` | One-time table setup |

## Notes on the data

- **Source**: ESPN's public JSON — the FPI matchup predictor (`gameProjection`,
  `teamPredPtDiff`) and the odds feed (DraftKings line).
- **Missing spreads are normal.** Books post lines a week or two out, so most of
  the season reads `n/a` in September and fills in as it goes.
- ESPN is re-fetched at most every 3 hours, or every 60 seconds while a game is
  being played. FPI itself reruns about once a day, around 7am ET.
- The Supabase key here is the publishable (anon) key, and the table is
  append-only public sports data — same arrangement as the budget and schedule
  apps.
- A local Flask version of this app lives in `Documents\GatorTracker`. It reads
  the same ESPN endpoints but keeps history in a local JSON file; the hosted
  version is the one to use day to day.
