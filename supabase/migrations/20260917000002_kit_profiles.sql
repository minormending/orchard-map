-- map-kit: accounts.
--
-- Generated from @minormending/map-kit. No substitutions.
--
-- profiles is read-only to the API roles. The display name is derived by the
-- signup trigger and there is no function to change it — an editor means
-- adding set_display_name() and granting execute on THAT, not restoring the
-- table grant.

set search_path = public, extensions;

create table if not exists profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  trust_score  int not null default 0,
  created_at   timestamptz not null default now(),
  banned_at    timestamptz
);

alter table profiles enable row level security;

-- Display names are public: they appear next to submissions. Email is not.
create policy profiles_read on profiles for select to anon, authenticated using (true);
grant select on profiles to anon, authenticated;

-- Deliberately no insert/update/delete grant. See the header.

create or replace function handle_new_user()
returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into profiles (id, display_name)
  values (
    NEW.id,
    coalesce(
      nullif(NEW.raw_user_meta_data->>'full_name', ''),
      nullif(NEW.raw_user_meta_data->>'name', ''),
      split_part(NEW.email, '@', 1),
      'Someone'
    )
  )
  on conflict (id) do nothing;
  return NEW;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();
