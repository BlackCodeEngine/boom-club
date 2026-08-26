-- Boom Club: stores items granted to a player, starting with the free dice
-- awarded every 5 levels (see server.js `awardXp`). Serves as the basis for
-- a future shop/inventory feature.

create table if not exists public.player_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  item_type text not null,
  item_name text not null,
  acquired_at timestamptz not null default now()
);

alter table public.player_items enable row level security;

-- A user may only see their own items. All inserts happen server-side via
-- the service_role key (bypasses RLS), so no insert policy is needed.
create policy "Users can view their own items"
  on public.player_items
  for select
  using (auth.uid() = user_id);
