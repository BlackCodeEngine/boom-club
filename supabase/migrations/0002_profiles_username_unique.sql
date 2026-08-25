-- Boom Club: enforce unique usernames on the profiles table.
-- This backs the live availability check on the registration screen
-- (socket event "checkUsernameAvailable") with a real database guarantee.

alter table public.profiles
  add constraint profiles_username_key unique (username);
