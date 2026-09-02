-- Gator Tracker: season-odds history — run ONCE in the Supabase SQL Editor.
--
-- Companion to gator_fpi_history. That table logs the per-game FPI numbers;
-- this one logs the team-level ones ESPN's FPI page shows — playoff odds,
-- national title odds, conference odds, the FPI rating itself — so they can be
-- charted across the season.
--
-- Same reasoning as before: ESPN publishes only the CURRENT value. If nothing
-- writes it down, the history doesn't exist.
--
-- Same shape as the other table: public sports data, anon read + append, no
-- update and no delete, so the log can't be rewritten.

create table if not exists public.gator_team_history (
  id             bigserial primary key,
  season         int not null default 2026,
  recorded_at    timestamptz not null default now(),
  fpi            numeric,   -- FPI rating (points better than average)
  fpi_rank       int,       -- national rank
  proj_wins      numeric,
  prob_playoff   numeric,   -- % to make the College Football Playoff
  prob_title_game numeric,  -- % to reach the national title game
  prob_win_title numeric,   -- % to win the national championship
  prob_win_conf  numeric,   -- % to win the SEC
  prob_six_wins  numeric,   -- % to reach bowl eligibility
  prob_win_out   numeric
);

create index if not exists gator_team_history_lookup
  on public.gator_team_history (season, recorded_at);

alter table public.gator_team_history enable row level security;

drop policy if exists gator_team_history_read on public.gator_team_history;
create policy gator_team_history_read
  on public.gator_team_history
  for select
  to anon, authenticated
  using (true);

drop policy if exists gator_team_history_append on public.gator_team_history;
create policy gator_team_history_append
  on public.gator_team_history
  for insert
  to anon, authenticated
  with check (true);
