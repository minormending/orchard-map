-- Who may write what. One file, on purpose.
--
-- THE RULE: a table with a submit_* function in front of it has no write grant.
-- The function is the door, and its rate limits are not optional.
--
-- This migration is mostly `revoke`, and that is not paranoia. Supabase ships
-- default privileges that grant the API roles everything on new tables in
-- `public`. So a table created and left alone is a table anyone with the anon
-- key — which is in the bundle, by design — can insert into directly, skipping
-- every rate limit and duplicate check in the functions above it.
--
-- restroom-map shipped exactly that hole on `flags`, of all tables: the one
-- that receives takedown requests. It had an INSERT grant sitting next to an
-- RLS policy that only checked `reporter_id is null`, so a client could post
-- to it anonymously and without bound. It survived because two things that
-- both LOOKED like access control were there, and neither checked the thing
-- that mattered.
--
-- Revoking first and granting back exactly what reads is the shape that does
-- not have that failure mode.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Start from nothing.
-- ---------------------------------------------------------------------------
revoke all on orchards          from anon, authenticated;
revoke all on varieties         from anon, authenticated;
revoke all on orchard_varieties from anon, authenticated;
revoke all on reports           from anon, authenticated;
revoke all on flags             from anon, authenticated;
revoke all on feedback          from anon, authenticated;
revoke all on rate_limit        from anon, authenticated;
revoke all on profiles          from anon, authenticated;

-- And stop the defaults handing grants to whatever is created next.
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Grant back only reading, and only what is public.
-- ---------------------------------------------------------------------------
grant select on orchards          to anon, authenticated;
grant select on varieties         to anon, authenticated;
grant select on orchard_varieties to anon, authenticated;

-- Display names are public — they appear next to submissions. Nothing else on
-- profiles is, and there is no write grant: the name is derived by the signup
-- trigger. An editor means adding set_display_name() and granting execute on
-- THAT, not restoring a table grant.
grant select on profiles to anon, authenticated;

-- reports, flags and feedback get no SELECT at all, for any API role.
--
-- A report box is not a public wall. The people who write to it have no reason
-- to read what anybody else wrote, and refusing with `permission denied for
-- table` is a stronger answer than a policy that returns zero rows — because
-- there is no policy to get wrong.
--
-- Counts reach the client through orchard_confidence, which aggregates and
-- names nobody.

-- ---------------------------------------------------------------------------
-- The rate limiter must not be reachable from a client at all: it could
-- otherwise read or spend somebody else's bucket, or learn the salt.
-- ---------------------------------------------------------------------------
revoke all on function rl_salt()                          from public, anon, authenticated;
revoke all on function client_fingerprint()               from public, anon, authenticated;
revoke all on function rl_take(text, interval, int)       from public, anon, authenticated;
revoke all on function apply_auto_hide()                  from public, anon, authenticated;
revoke all on function touch_updated_at()                 from public, anon, authenticated;
revoke all on function handle_new_user()                  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The complete list of doors. Anything not here cannot be called.
--
-- PostgREST resolves functions by ARGUMENT NAME, so each signature below is
-- part of the contract with every deployed bundle — including one sitting in
-- somebody's cache from last week. Adding a parameter with a default is safe.
-- Removing or renaming one is not, and has already taken restroom-map down for
-- fifteen minutes.
-- ---------------------------------------------------------------------------
grant execute on function submit_report(uuid, text, text, float8, float8) to anon, authenticated;
grant execute on function submit_flag(text, uuid, text, text)             to anon, authenticated;
grant execute on function submit_feedback(text, text, text, text)         to anon, authenticated;
