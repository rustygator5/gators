-- Gator Tracker history — run ONCE in the Supabase SQL Editor.
--
-- Why this table exists: ESPN only ever publishes FPI's *current* number for a
-- game. There is no history endpoint. The only way to chart how a win
-- probability moved across the season is to log every change ourselves, and
-- this table is that log — shared, so your PC, laptop, and phone all read and
-- add to the same one.
--
-- Everything in here is public sports data (win probabilities and betting
-- lines). Nothing personal, so anon read/insert is fine.
--
-- Append-only by design: rows are never updated or deleted, so a bad write on
-- one device can't wipe a season of history.

create table if not exists public.gator_fpi_history (
  id           bigserial primary key,
  season       int  not null default 2026,
  event_id     text not null,
  recorded_at  timestamptz not null default now(),
  win_pct      numeric,
  pred_margin  numeric,
  spread       numeric,
  over_under   numeric
);

create index if not exists gator_fpi_history_lookup
  on public.gator_fpi_history (season, event_id, recorded_at);

alter table public.gator_fpi_history enable row level security;

-- Read and append only. No update, no delete — the log can't be rewritten.
drop policy if exists gator_fpi_history_read on public.gator_fpi_history;
create policy gator_fpi_history_read
  on public.gator_fpi_history
  for select
  to anon, authenticated
  using (true);

drop policy if exists gator_fpi_history_append on public.gator_fpi_history;
create policy gator_fpi_history_append
  on public.gator_fpi_history
  for insert
  to anon, authenticated
  with check (true);
