-- A submitted farm arrived with no handle to withdraw it by.
--
-- `submit_orchard` has always set `import_source = 'user'` and
-- `import_licence = 'user-submitted'` and left `import_id` null. That went
-- unnoticed for as long as it did because no submission had ever reached the
-- map: the 48 other `user` rows were loaded by `import-userlist.mjs`, which
-- sets one. Abma's Farm Market was the first through the form, and
-- `test/data.test.mjs` refused to let it be published:
--
--     Abma's Farm Market has no import id
--
-- That test is the reason the column exists. From the README: every row
-- records its source, its id and its licence "so withdrawing a source is one
-- filter rather than an archaeology project". A row with a source and no id
-- is in the filter but cannot be picked out of it — and `alreadyImported()`,
-- which is how every importer avoids adding the same farm twice, matches on
-- exactly that pair.
--
-- The value is the slug, which the function has already computed by this
-- point and which is the same shape the importers write
-- ('secor-farms-mahwah'). It is unique by construction: a slug collision is
-- resolved a few lines above, so two people proposing the same farm get two
-- different ids rather than one ambiguous one.
--
-- The signature does not change, so this replaces the function in place and
-- keeps its grants. See migration 016.

set search_path = public, extensions;

create or replace function submit_orchard(
  p_name      text,
  p_lat       float8,
  p_lng       float8,
  p_address   text default null,
  p_town      text default null,
  p_state     text default null,
  p_tags      text[] default '{}',
  p_precision text default null,
  p_website   text default null)
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
   * A website is optional. What it may not be is a string the crawler cannot
   * parse or a page cannot link to — those are the two things the column is
   * for, and both fail without saying anything.
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
   * 'exact' means the source states the position; a browser that geocoded a
   * street, or a visitor who clicked a map, is not that.
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
    import_source, import_id, import_licence, position_precision, website)
  values (
    v_slug, left(trim(p_name), 200),
    st_point(p_lng, p_lat)::geography,
    nullif(left(trim(p_address), 200), ''),
    nullif(left(trim(p_town), 100), ''),
    -- No `left(..., 2)`: the guard above means there is nothing left to cut.
    nullif(upper(trim(p_state)), ''),
    coalesce(v_tags, '{}'),
    'hidden',                -- a moderator decides
    v_user,
    -- The slug, settled above and unique by construction. Same shape the
    -- importers write, so one filter withdraws a source whatever added it.
    'user', v_slug, 'user-submitted', v_prec,
    v_site)
  returning id into v_id;

  -- Into the same queue as everything else a person has to look at.
  insert into flags (target_type, target_id, kind, message, reporter_id)
  values ('orchard', v_id, 'submission',
          'new orchard submitted: ' || left(trim(p_name), 200), v_user);

  return jsonb_build_object('ok', true, 'id', v_id, 'status', 'pending review');
end $$;

-- The rows that came through the old function. Exactly one today, Abma's Farm
-- Market, which is already on the map and cannot be exported again until it
-- has an id. Scoped to 'user' and to nulls, so it cannot touch an imported row
-- or overwrite an id somebody already has.
update orchards
   set import_id = slug
 where import_source = 'user'
   and import_id is null;
