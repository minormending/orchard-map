-- A submitted state is a claim, and this one was never checked.
--
-- `AddOrchard` had no state field and sent a hardcoded 'NY' with every
-- submission. The form now asks. That fixes the caller, and leaves the reason
-- the caller could get it wrong for so long without anybody noticing: nothing
-- here ever looked at `p_state`.
--
-- What it did instead was make any input fit. `left(trim(p_state), 2)` turned
-- 'Connecticut' into 'CT' by luck and 'Colorado' into 'CO' by luck, and would
-- have turned 'Cornwall' into 'CO' as well — a Connecticut farm filed under a
-- state 1,800 miles away, stored in exactly the shape a correct answer has.
-- Every consumer treats the column as a two-letter code: the About page groups
-- by it, the map prints it under the farm's name, the importers write it. A
-- silently truncated value is indistinguishable from a real one at every one
-- of those points, which is why it has to be refused at the door instead.
--
-- So: two letters or nothing, and the truncation goes. Case is still fixed
-- silently, because 'ct' is a spelling of Connecticut rather than a claim
-- about a different place.
--
-- Deliberately NOT an allow-list of the states the map covers. That list is an
-- editorial decision about where this map stops — it lives in
-- `src/lib/states.ts`, next to the form that shows it, where widening it is a
-- one-line change rather than a migration against a live database. The
-- database's job here is narrower and more durable: refuse what the column
-- cannot mean.
--
-- The signature is unchanged, so this replaces the function in place. No drop
-- and no re-grant: `create or replace` keeps the existing privileges, and
-- dropping would revoke them for as long as the transaction is open.

set search_path = public, extensions;

create or replace function submit_orchard(
  p_name      text,
  p_lat       float8,
  p_lng       float8,
  p_address   text default null,
  p_town      text default null,
  p_state     text default null,
  p_tags      text[] default '{}',
  p_precision text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user uuid := auth.uid();
  v_slug text;
  v_near text;
  v_id   uuid;
  v_tags orchard_tag[];
  v_prec position_precision;
begin
  if v_user is null then
    raise exception 'sign in to add an orchard' using errcode = '42501';
  end if;
  if coalesce(length(trim(p_name)), 0) < 2 then
    raise exception 'a name is required' using errcode = '22023';
  end if;
  if p_lat is null or p_lng is null
     or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'a position is required' using errcode = '22023';
  end if;

  -- Absent is fine; wrong-shaped is not. See the note at the top: anything
  -- longer used to be cut down to two characters that meant something else.
  if nullif(trim(p_state), '') is not null and trim(p_state) !~ '^[A-Za-z]{2}$' then
    raise exception 'state must be a two-letter code' using errcode = '22023';
  end if;

  /*
   * A submission may say its pin is rough. It may not say its pin is exact.
   *
   * 'exact' means the source states the position — OpenStreetMap's surveys,
   * PA Preferred publishing a member's coordinate. A browser that geocoded a
   * street, or a visitor who clicked a map, is not that, however confident
   * either one feels. Refusing the value outright is better than accepting it
   * and hoping a moderator notices a claim that looks like every other row.
   */
  if p_precision is not null and p_precision <> 'approximate' then
    raise exception 'a submission may only record an approximate position'
      using errcode = '22023';
  end if;
  v_prec := nullif(p_precision, '')::position_precision;

  if not rl_take('orchard:' || client_fingerprint(), interval '1 day', 5) then
    raise exception 'that is enough for today' using errcode = '53400';
  end if;

  -- Orchards are large and far apart; two pins within 300m are the same farm.
  select name into v_near from orchards
  where st_dwithin(geog, st_point(p_lng, p_lat)::geography, 300)
  limit 1;
  if v_near is not null then
    return jsonb_build_object('ok', false, 'reason', 'duplicate', 'near', v_near);
  end if;

  begin
    v_tags := p_tags::orchard_tag[];
  exception when invalid_text_representation then
    raise exception 'unknown tag' using errcode = '22023';
  end;

  v_slug := regexp_replace(lower(trim(p_name) || ' ' || coalesce(trim(p_town), '')),
                           '[^a-z0-9]+', '-', 'g');
  v_slug := trim(both '-' from left(v_slug, 70));
  -- A slug is a URL, so a collision would make two orchards share a page.
  if exists (select 1 from orchards where slug = v_slug) then
    v_slug := v_slug || '-' || left(replace(gen_random_uuid()::text, '-', ''), 6);
  end if;

  insert into orchards (
    slug, name, geog, address, town, state, tags, status, created_by,
    import_source, import_licence, position_precision)
  values (
    v_slug, left(trim(p_name), 200),
    st_point(p_lng, p_lat)::geography,
    nullif(left(trim(p_address), 200), ''),
    nullif(left(trim(p_town), 100), ''),
    -- No `left(..., 2)`: the guard above means there is nothing left to cut,
    -- and truncating here is what made a wrong state look like a right one.
    nullif(upper(trim(p_state)), ''),
    coalesce(v_tags, '{}'),
    'hidden',                -- a moderator decides
    v_user,
    'user', 'user-submitted', v_prec)
  returning id into v_id;

  -- Into the same queue as everything else a person has to look at.
  insert into flags (target_type, target_id, kind, message, reporter_id)
  values ('orchard', v_id, 'submission',
          'new orchard submitted: ' || left(trim(p_name), 200), v_user);

  return jsonb_build_object('ok', true, 'id', v_id, 'status', 'pending review');
end $$;
