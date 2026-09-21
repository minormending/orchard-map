-- The address column is a street line, and it has a town in it.
--
-- Abma's Farm Market arrived on 21 September as
--
--     address  700 Lawlins Rd, Wyckoff, NJ 07481
--     town     Wyckoff
--     state    NJ
--     zip      (empty)
--
-- `addressLine()` joins address, town, state and zip, so the farm's page would
-- have read "700 Lawlins Rd, Wyckoff, NJ 07481, Wyckoff, NJ". The JSON-LD was
-- worse: the whole string as `streetAddress` beside its own `addressLocality`
-- and `addressRegion`, which is a structured lie rather than an untidy line.
--
-- It was corrected by hand, and the door it came through stayed open.
--
-- ---------------------------------------------------------------------------
-- Refused, not trimmed
-- ---------------------------------------------------------------------------
--
-- The tempting fix is to cut the tail off here. That is migration 016's
-- mistake in a third column: what comes out is the right shape and may be the
-- wrong place. "1355 Boston Post Road, US Rte. 1, I-95 Exit 57" is a real
-- address on this map whose commas are how somebody finds the farm, and a
-- function confident enough to edit one of those is confident enough to ruin
-- the other ten.
--
-- So the column refuses what it cannot mean, and the browser does the moving
-- where a person can see it and say no — `src/lib/address.ts`, offered in the
-- form, the same split of labour as `STATES` and the website rule.
--
-- ---------------------------------------------------------------------------
-- What exactly is refused
-- ---------------------------------------------------------------------------
--
-- Only the address REPEATING the town or state submitted beside it. Not any
-- comma, not any town-shaped tail. A tail naming some other place is a
-- judgment about somebody's street name and this function has no standing to
-- make it; a tail naming the same place is a duplicate on any reading, and
-- those values already have columns.
--
-- The town is escaped before it reaches a regex, because towns contain regex:
-- St. Johnsville has a dot, and an unescaped one matches any character.
--
-- Also here: `p_zip`, which the function has never accepted. The zip was
-- sitting inside the address string all along — the column existed, nothing
-- could fill it, and nobody should type it twice.
--
-- The signature changes, so the old function is dropped by its exact argument
-- list and the grant reissued. See migration 015.

set search_path = public, extensions;

drop function if exists
  submit_orchard(text, float8, float8, text, text, text, text[], text, text);

create or replace function submit_orchard(
  p_name      text,
  p_lat       float8,
  p_lng       float8,
  p_address   text default null,
  p_town      text default null,
  p_state     text default null,
  p_tags      text[] default '{}',
  p_precision text default null,
  p_website   text default null,
  p_zip       text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user uuid := auth.uid();
  v_slug text;
  v_near text;
  v_id   uuid;
  v_tags orchard_tag[];
  v_prec position_precision;
  v_site text := nullif(trim(p_website), '');
  v_addr text := nullif(trim(p_address), '');
  v_town text := nullif(trim(p_town), '');
  v_zip  text := nullif(trim(p_zip), '');
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

  -- Absent is fine; wrong-shaped is not. Anything longer used to be cut down
  -- to two characters that meant something else. See migration 016.
  if nullif(trim(p_state), '') is not null and trim(p_state) !~ '^[A-Za-z]{2}$' then
    raise exception 'state must be a two-letter code' using errcode = '22023';
  end if;

  /*
   * The street line may not end by repeating the town or the state it is
   * being submitted with. Both patterns require a comma before the tail, so
   * that a street whose own name ends in two letters is left alone — the
   * browser's rule is anchored the same way and the two must agree.
   */
  if v_addr is not null then
    if v_town is not null and v_addr ~* (
      ',\s*' ||
      regexp_replace(v_town, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') ||
      '\s*(,\s*[A-Za-z]{2})?(\s+\d{5}(-\d{4})?)?\s*$')
    then
      raise exception 'the town has its own field — leave it out of the address'
        using errcode = '22023';
    end if;

    if nullif(trim(p_state), '') is not null and v_addr ~* (
      ',\s*[^,]*\y' || upper(trim(p_state)) || '\y(\s+\d{5}(-\d{4})?)?\s*$')
    then
      raise exception 'the state has its own field — leave it out of the address'
        using errcode = '22023';
    end if;
  end if;

  -- Five digits, or five and four. Refused rather than cleaned up, for the
  -- same reason as everything else in here.
  if v_zip is not null and v_zip !~ '^\d{5}(-\d{4})?$' then
    raise exception 'a zip is five digits' using errcode = '22023';
  end if;

  /*
   * A website is optional. What it may not be is a string the crawler cannot
   * parse or a page cannot link to — see migration 017.
   */
  if v_site is not null then
    if length(v_site) > 500 then
      raise exception 'that is too long to be a website' using errcode = '22023';
    end if;
    if v_site ~ '\s' then
      raise exception 'a website has no spaces in it' using errcode = '22023';
    end if;
    if v_site !~* '^https?://[^\s/?#]+\.[^\s/?#]+' then
      raise exception 'a website must start with http:// or https:// and name a domain'
        using errcode = '22023';
    end if;
  end if;

  /*
   * A submission may say its pin is rough. It may not say its pin is exact.
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

  v_slug := regexp_replace(lower(trim(p_name) || ' ' || coalesce(v_town, '')),
                           '[^a-z0-9]+', '-', 'g');
  v_slug := trim(both '-' from left(v_slug, 70));
  -- A slug is a URL, so a collision would make two orchards share a page.
  if exists (select 1 from orchards where slug = v_slug) then
    v_slug := v_slug || '-' || left(replace(gen_random_uuid()::text, '-', ''), 6);
  end if;

  insert into orchards (
    slug, name, geog, address, town, state, zip, tags, status, created_by,
    import_source, import_id, import_licence, position_precision, website)
  values (
    v_slug, left(trim(p_name), 200),
    st_point(p_lng, p_lat)::geography,
    left(v_addr, 200),
    left(v_town, 100),
    -- No `left(..., 2)`: the guard above means there is nothing left to cut.
    nullif(upper(trim(p_state)), ''),
    v_zip,
    coalesce(v_tags, '{}'),
    'hidden',                -- a moderator decides
    v_user,
    -- The slug, settled above and unique by construction. See migration 019.
    'user', v_slug, 'user-submitted', v_prec,
    v_site)
  returning id into v_id;

  -- Into the same queue as everything else a person has to look at.
  insert into flags (target_type, target_id, kind, message, reporter_id)
  values ('orchard', v_id, 'submission',
          'new orchard submitted: ' || left(trim(p_name), 200), v_user);

  return jsonb_build_object('ok', true, 'id', v_id, 'status', 'pending review');
end $$;

grant execute on function
  submit_orchard(text, float8, float8, text, text, text, text[], text, text, text)
  to authenticated;
