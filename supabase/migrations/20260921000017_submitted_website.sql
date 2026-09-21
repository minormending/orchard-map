-- A submitted farm had no way to ever say anything about itself.
--
-- `AddOrchard` collects a name, a town, a state, an address and some tags.
-- Everything else on the map — hours, whether picking is on, what is ripe —
-- arrives from one place: `scrape.mjs` reading the farm's own website. And
-- that crawler picks its targets with `orchards.filter(o => o.website)`.
--
-- So a row submitted through this function was permanently factless. Not
-- "unknown until somebody gets to it": unreachable, because the field that
-- makes it reachable was the one field the form could not send. The first real
-- submission, Abma's Farm Market on 2026-09-21, landed exactly that way and
-- the only route to a website was a moderator writing SQL by hand.
--
-- ---------------------------------------------------------------------------
-- What is refused, and why it is refused rather than tidied
-- ---------------------------------------------------------------------------
--
-- Two consumers take the stored string exactly as it stands, and both fail
-- silently on anything that is not an absolute URL:
--
--   `scrape.mjs` groups targets by `new URL(o.website).host` inside a
--   try/catch whose catch is `continue`. A bare 'abmasfarm.com' throws, so the
--   farm drops out of every future crawl and nothing anywhere says so. A
--   value that quietly undoes the reason the column exists is worse than no
--   value, because only one of the two looks empty.
--
--   The farm page renders `href={orchard.website}` unaltered. A bare host is a
--   RELATIVE link — under /orchard/abma-s-farm-market it points at a page that
--   does not exist — and a `javascript:` URL is an anchor on a published page
--   pointing at whatever a stranger typed. Restricting the scheme at the door
--   is the cheapest place to settle that, and the only one that holds for
--   every caller.
--
-- And no `left(p_website, n)`. That is migration 016's mistake in a different
-- column: a truncated URL is still a URL, still renders as a link, still gets
-- crawled, and points somewhere else entirely. Too long is refused.
--
-- ---------------------------------------------------------------------------
-- Why this is not the same rule the browser applies
-- ---------------------------------------------------------------------------
--
-- `src/lib/website.ts` turns 'abmasfarm.com' into 'https://abmasfarm.com' and
-- shows the visitor what it did, the way `locate.ts` offers a pin rather than
-- imposing one. That is a kindness to somebody typing, and it belongs next to
-- the form — exactly where `STATES` lives, and for the same reason: it is an
-- editorial convenience, changed in a one-line commit rather than a migration.
--
-- This function's job is narrower and has to hold against a caller that never
-- ran that code: refuse what the column cannot mean. It is therefore the more
-- permissive of the two by design, and the difference is not drift.
--
-- The signature changes, so the old function is dropped by its exact argument
-- list and the grant reissued — `create or replace` would read a new parameter
-- as a second overload rather than a replacement. See migration 015.

set search_path = public, extensions;

drop function if exists
  submit_orchard(text, float8, float8, text, text, text, text[], text);

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
   *
   * The pattern asks for exactly what `new URL()` needs and no more: an http
   * or https scheme, and an authority with a dot in it. 'https://abmasfarm'
   * parses perfectly well and is not a website anybody has.
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
    import_source, import_licence, position_precision, website)
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
    'user', 'user-submitted', v_prec,
    -- Checked above, and stored as typed. A URL is not ours to rewrite.
    v_site)
  returning id into v_id;

  -- Into the same queue as everything else a person has to look at.
  insert into flags (target_type, target_id, kind, message, reporter_id)
  values ('orchard', v_id, 'submission',
          'new orchard submitted: ' || left(trim(p_name), 200), v_user);

  return jsonb_build_object('ok', true, 'id', v_id, 'status', 'pending review');
end $$;

grant execute on function
  submit_orchard(text, float8, float8, text, text, text, text[], text, text)
  to authenticated;
