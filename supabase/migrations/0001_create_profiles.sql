-- Boom Club: profiles table linked to Supabase Auth users.
-- Stores the display name and persistent BoomCoins (BC) balance per account.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null,
  coins integer not null default 10000,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Anyone (including anonymous clients) may read profiles - needed to show an
-- opponent's name/coins in the multiplayer HUD.
create policy "Profiles are viewable by everyone"
  on public.profiles
  for select
  using (true);

-- A user may only create the profile row that matches their own auth id.
create policy "Users can insert their own profile"
  on public.profiles
  for insert
  with check (auth.uid() = id);

-- A user may only update their own profile row.
create policy "Users can update their own profile"
  on public.profiles
  for update
  using (auth.uid() = id);
