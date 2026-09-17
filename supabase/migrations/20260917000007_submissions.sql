-- Adding an orchard, and settling what is at one.
--
-- Two mechanisms, and they are separate because they fail differently:
--
--   A SUBMISSION proposes a place that is not on the map. It is rate-limited,
--     duplicate-checked, and lands as `pending` — a moderator decides. There
--     is no path from a signed-in stranger to a live pin.
--
--   A CLAIM answers one visitor-fact field about a place already on the map.
--     Two people who independently give the same answer settle it. One person
--     is an account, not a fact.
--
-- The second is restroom-map's rule, unchanged, because for these fields the
-- situation is identical: nobody publishes whether an orchard's rows are
-- passable with a pushchair. It is deliberately NOT applied to opening hours
-- or whether picking is open — the farm publishes those, and making two
-- strangers agree about a fact the operator has already stated in public would
-- leave the field empty for no reason.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Visitor facts, and only visitor facts. Every one is a boolean, which is what
-- lets the promotion trigger below use a single code path.
-- ---------------------------------------------------------------------------
create type visitor_field as enum (
  'dogs', 'restrooms', 'wheelchair_rows', 'cards_accepted', 'picnic_area',
  'hayride', 'corn_maze', 'petting_zoo', 'food_on_site', 'cider_donuts');

create table visitor_claims (
  orchard_id uuid not null references orchards(id) on delete cascade,
  field      visitor_field not null,
  user_id    uuid not null references profiles(id) on delete cascade,
  value      boolean not null,
  created_at timestamptz not null default now(),
  -- This key is what stops one person voting twice: a second claim from the
  -- same person on the same field is an upsert of their own answer.
  primary key (orchard_id, field, user_id)
);

alter table visitor_claims enable row level security;

-- ---------------------------------------------------------------------------
-- Two people who agree settle a field.
--
-- Three things in here are load-bearing:
--
--   `v_winners = 1`, not `>= 1`. If two values each reach two people, that is
--   a disagreement and nothing settles.
--
--   `and %I is null` on the update. A settled field is never overwritten, even
--   by a race.
--
--   The field name comes from the enum, not from the client, which is what
--   makes format(%I) safe here. This is the only dynamic SQL in the schema.
-- ---------------------------------------------------------------------------
create or replace function promote_visitor_claim()
returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_winners int;
  v_winner  boolean;
begin
  select count(*), min(value::int)::boolean into v_winners, v_winner
  from (
    select value from visitor_claims
    where orchard_id = NEW.orchard_id and field = NEW.field
    group by value having count(*) >= 2
  ) agreed;

  if v_winners = 1 then
    execute format(
      'update orchards set %I = $1 where id = $2 and %I is null',
      NEW.field::text, NEW.field::text)
    using v_winner, NEW.orchard_id;
  end if;

  return NEW;
end $$;

create trigger visitor_claims_promote
  after insert or update on visitor_claims
  for each row execute function promote_visitor_claim();

-- What people have said that has not settled yet. Settled fields are excluded
-- by design — the settled value lives on `orchards` itself, and this view
-- exists to show what is still open.
create or replace view visitor_claim_state as
select
  c.orchard_id,
  c.field,
  count(*)                          as claims,
  count(distinct c.value) > 1       as disputed,
  bool_or(c.value)                  as any_yes
from visitor_claims c
group by c.orchard_id, c.field;

revoke all on visitor_claim_state from public, anon, authenticated;
grant select on visitor_claim_state to anon, authenticated;

create or replace function submit_visitor_claim(
  p_orchard_id uuid,
  p_field      text,
  p_value      boolean)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user  uuid := auth.uid();
  v_field visitor_field;
  v_set   boolean;
begin
  if v_user is null then
    raise exception 'sign in to answer this' using errcode = '42501';
  end if;

  begin
    v_field := p_field::visitor_field;
  exception when invalid_text_representation then
    raise exception 'unknown field: %', p_field using errcode = '22023';
  end;

  perform 1 from orchards where id = p_orchard_id and status = 'active';
  if not found then
    raise exception 'no such orchard' using errcode = 'P0002';
  end if;

  -- Already settled? Say so rather than silently accepting a claim that can
  -- never change anything. Correcting a settled fact is a moderator's job and
  -- has no self-service design yet.
  execute format('select %I is not null from orchards where id = $1', v_field::text)
    into v_set using p_orchard_id;
  if v_set then
    return jsonb_build_object('ok', false, 'reason', 'already_settled');
  end if;

  if not rl_take('claim:' || client_fingerprint(), interval '1 hour', 60) then
    raise exception 'too many answers, try later' using errcode = '53400';
  end if;

  insert into visitor_claims (orchard_id, field, user_id, value)
  values (p_orchard_id, v_field, v_user, p_value)
  on conflict (orchard_id, field, user_id)
    do update set value = excluded.value, created_at = now();

  return jsonb_build_object('ok', true);
end $$;

grant execute on function submit_visitor_claim(uuid, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Proposing a new orchard.
--
-- Lands as `hidden`, never `active`. A signed-in stranger cannot put a pin on
-- the map — a moderator un-hides it, which is the same door an auto-hidden
-- orchard comes back through, so there is one review path rather than two.
-- ---------------------------------------------------------------------------
create or replace function submit_orchard(
  p_name    text,
  p_lat     float8,
  p_lng     float8,
  p_address text default null,
  p_town    text default null,
  p_state   text default null,
  p_tags    text[] default '{}')
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user uuid := auth.uid();
  v_slug text;
  v_near text;
  v_id   uuid;
  v_tags orchard_tag[];
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
    import_source, import_licence)
  values (
    v_slug, left(trim(p_name), 200),
    st_point(p_lng, p_lat)::geography,
    nullif(left(trim(p_address), 200), ''),
    nullif(left(trim(p_town), 100), ''),
    nullif(upper(left(trim(p_state), 2)), ''),
    coalesce(v_tags, '{}'),
    'hidden',                -- a moderator decides
    v_user,
    'user', 'user-submitted')
  returning id into v_id;

  -- Into the same queue as everything else a person has to look at.
  insert into flags (target_type, target_id, kind, message, reporter_id)
  values ('orchard', v_id, 'submission',
          'new orchard submitted: ' || left(trim(p_name), 200), v_user);

  return jsonb_build_object('ok', true, 'id', v_id, 'status', 'pending review');
end $$;

grant execute on function submit_orchard(text, float8, float8, text, text, text, text[])
  to authenticated;

revoke all on visitor_claims from anon, authenticated;
revoke all on function promote_visitor_claim() from public, anon, authenticated;
