-- The key the site actually has.
--
-- Every write function took the orchard's uuid, and a browser has never held
-- one. The pages are static: they are built from `src/data/orchards.json`,
-- whose `id` is an export artifact — `nyaa-4893`, `ctapples-…`, `db-<uuid>` —
-- and never the primary key. So the answer to "are dogs allowed" arrived as
--
--   22P02  invalid input syntax for type uuid: "db-bc9b70df-aae3-4ad7-…"
--
-- and so did every report and every flag. Not one of the 302 published rows
-- carries an id that would have cast, so this was the whole write surface of
-- the site rather than an edge case.
--
-- It survived both suites because each hands the function an id it read from
-- the database a moment earlier — `test-schema.mjs` selects one, `test-api.mjs`
-- fetched one over REST. Neither used the key a visitor's bundle has, which is
-- the only key that matters here.
--
-- That key is the slug, and it is already the one every other boundary in this
-- project crosses: it is the URL of the page, the unique column on `orchards`,
-- what `record-observations.mjs` resolves an observation against, and what the
-- export joins a rebuild onto. The uuid stays where it is generated and does
-- not leave the database. A slug also survives what a uuid does not: a row
-- reseeded from the export is the same farm with a new primary key, and this
-- is exactly the reasoning `seed-to-sql.mjs` already applies to provenance.
--
-- The signatures change, so each function is dropped by its exact argument list
-- and its grant reissued — `create or replace` would read a differently typed
-- parameter as a second overload rather than a replacement. See migration 015.
-- PostgREST resolves a function by argument NAME, so a bundle still sending
-- `p_orchard_id` now gets a 404 instead of a failed cast; it could not have
-- written anything either way.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- A visitor fact, answered by somebody who went.
-- ---------------------------------------------------------------------------
drop function if exists submit_visitor_claim(uuid, text, boolean);

create or replace function submit_visitor_claim(
  p_orchard_slug text,
  p_field        text,
  p_value        boolean)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user    uuid := auth.uid();
  v_orchard uuid;
  v_field   visitor_field;
  v_set     boolean;
begin
  if v_user is null then
    raise exception 'sign in to answer this' using errcode = '42501';
  end if;

  begin
    v_field := p_field::visitor_field;
  exception when invalid_text_representation then
    raise exception 'unknown field: %', p_field using errcode = '22023';
  end;

  select id into v_orchard from orchards
   where slug = p_orchard_slug and status = 'active';
  if v_orchard is null then
    raise exception 'no such orchard' using errcode = 'P0002';
  end if;

  -- Already settled? Say so rather than silently accepting a claim that can
  -- never change anything. Correcting a settled fact is a moderator's job and
  -- has no self-service design yet.
  execute format('select %I is not null from orchards where id = $1', v_field::text)
    into v_set using v_orchard;
  if v_set then
    return jsonb_build_object('ok', false, 'reason', 'already_settled');
  end if;

  if not rl_take('claim:' || client_fingerprint(), interval '1 hour', 60) then
    raise exception 'too many answers, try later' using errcode = '53400';
  end if;

  insert into visitor_claims (orchard_id, field, user_id, value)
  values (v_orchard, v_field, v_user, p_value)
  on conflict (orchard_id, field, user_id)
    do update set value = excluded.value, created_at = now();

  return jsonb_build_object('ok', true);
end $$;

grant execute on function submit_visitor_claim(text, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- "I went. This is what I found."
-- ---------------------------------------------------------------------------
drop function if exists submit_report(uuid, text, text, float8, float8);

create or replace function submit_report(
  p_orchard_slug text,
  p_kind         text,
  p_anon_id      text   default null,
  p_lat          float8 default null,
  p_lng          float8 default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_orchard uuid;
  v_kind    report_kind;
  v_fp      text := client_fingerprint();
  v_geo     boolean := false;
begin
  begin
    v_kind := p_kind::report_kind;
  exception when invalid_text_representation then
    raise exception 'unknown report kind: %', p_kind using errcode = '22023';
  end;

  select id into v_orchard from orchards
   where slug = p_orchard_slug and status = 'active';
  if v_orchard is null then
    raise exception 'no such orchard' using errcode = 'P0002';
  end if;

  if not rl_take('report:' || v_fp, interval '1 hour', 40) then
    raise exception 'too many reports, try later' using errcode = '53400';
  end if;

  -- An orchard is a big place and its car park is not its centroid, so the
  -- radius is generous: 800m says "you were plausibly at this farm" after the
  -- fact. It is far too loose to name a place unprompted, which is a different
  -- job with a different radius.
  if p_lat is not null and p_lng is not null then
    select st_dwithin(geog, st_point(p_lng, p_lat)::geography, 800)
    into v_geo from orchards where id = v_orchard;
  end if;

  insert into reports (orchard_id, kind, user_id, anon_id, geo_verified)
  values (v_orchard, v_kind, auth.uid(),
          nullif(left(p_anon_id, 64), ''), coalesce(v_geo, false));

  return jsonb_build_object('ok', true, 'geo_verified', coalesce(v_geo, false));
end $$;

grant execute on function submit_report(text, text, text, float8, float8)
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- "Something here is wrong."
--
-- `submit_flag` is the kit's, shared with restroom-map, and its target is a
-- uuid because it also takes comments. Rather than fork it, this is the one
-- door the orchard pages use: it turns the key the page has into the key that
-- table wants and hands the work straight back. The rate limit, the length cap
-- and the reporter id stay in one place, which is what stops the two drifting.
-- ---------------------------------------------------------------------------
create or replace function submit_orchard_flag(
  p_orchard_slug  text,
  p_message       text,
  p_contact_email text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_orchard uuid;
begin
  -- Deliberately not filtered to `status = 'active'`, unlike the two above.
  -- "This is my farm and I would like it removed" arrives through this box,
  -- and so does the appeal of an auto-hide — both about a farm the map is not
  -- showing. Refusing them because the row is already hidden would close the
  -- door on the two messages it most needs to carry.
  select id into v_orchard from orchards where slug = p_orchard_slug;
  if v_orchard is null then
    raise exception 'no such orchard' using errcode = 'P0002';
  end if;

  return submit_flag('orchard', v_orchard, p_message, p_contact_email);
end $$;

grant execute on function submit_orchard_flag(text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- The complete list of doors, restated because two of them changed shape.
--
-- Migration 006 carries this list and cannot be edited — the runner checksums
-- an applied file and would report it as changed forever — so this is where it
-- is correct now:
--
--   submit_report(text, text, text, float8, float8)         anon, authenticated
--   submit_orchard_flag(text, text, text)                   anon, authenticated
--   submit_flag(text, uuid, text, text)                     anon, authenticated
--   submit_feedback(text, text, text, text)                 anon, authenticated
--   submit_orchard(text, float8, float8, text, text, text,
--                  text[], text, text)                      authenticated
--   submit_visitor_claim(text, text, boolean)               authenticated
--
-- The uuid-taking `submit_report` and `submit_visitor_claim` are dropped rather
-- than left alongside the new ones. An overload that differs only in a
-- parameter's type is how PostgREST starts answering "could not choose the best
-- candidate function", and neither of them could ever have been called
-- successfully from a page on this site.
-- ---------------------------------------------------------------------------
