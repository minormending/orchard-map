-- What a submitted pin is claiming.
--
-- `AddOrchard` now offers to geocode the address somebody types, instead of
-- making them hunt for their own rooftop on a slippy map. That is a better
-- form and a worse pin: an address with a house number usually geocodes to the
-- building, but "Rt. 322 Meriden-Waterbury Road" geocodes to a point on a road
-- that runs for miles.
--
-- `submit_orchard` had nowhere to put that difference, so every submission
-- landed with `position_precision` null. Null is not a neutral default here —
-- migration 010 defines it as "nobody recorded a precision", which is true of
-- the imported rows and would have been a quiet lie about a guessed one. The
-- farm page and the map read it: `approximate` is what makes the page say the
-- pin is the road rather than the gate, and makes the map draw the dot hollow.
--
-- Adding a parameter changes the signature, and Postgres would read a plain
-- `create or replace` as a second overload rather than a replacement — so the
-- old one is dropped by its exact argument list and the grant is reissued.

set search_path = public, extensions;

drop function if exists submit_orchard(text, float8, float8, text, text, text, text[]);

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
    nullif(upper(left(trim(p_state), 2)), ''),
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

grant execute on function
  submit_orchard(text, float8, float8, text, text, text, text[], text)
  to authenticated;
