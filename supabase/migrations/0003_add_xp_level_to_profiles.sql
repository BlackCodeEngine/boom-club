-- Boom Club: adds XP/level progression to profiles.
-- level starts at 1, xp accumulates from online game wins/losses (see
-- server.js `awardXp`). The XP-per-level threshold lives in server.js
-- (XP_PER_LEVEL) so it can be tuned without a migration.

alter table public.profiles
  add column if not exists level integer not null default 1,
  add column if not exists xp integer not null default 0;
