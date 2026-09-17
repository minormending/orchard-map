-- "I went. This is what I found."
--
-- No account needed, deliberately. This is the highest-volume and lowest-risk
-- signal the map can collect, and putting sign-in in front of it would kill
-- almost all of it. The account-shaped things — adding an orchard, settling a
-- visitor fact — come later and do need one.
--
-- A report answers a different question from a scrape, and the two are never
-- merged. The farm's website is authoritative about what the farm INTENDS:
-- open nine to five, picking on. A visitor is authoritative about what
-- actually happened: the lot was full at eleven and they turned people away.
-- When they disagree the detail page shows both, because the disagreement is
-- more useful than either alone and hiding it is how the wasted trip happens.

set search_path = public, extensions;

create type report_kind as enum (
  'open',        -- picking was on
  'picked_out',  -- open, but nothing left worth picking
  'closed',      -- shut when it should not have been
  'busy',        -- open, but the queue or car park was the problem
  'gone'         -- not there at all any more
);

create table reports (
  id         uuid primary key default gen_random_uuid(),
  orchard_id uuid not null references orchards(id) on delete cascade,
  kind       report_kind not null,
  user_id    uuid references profiles(id),
  -- Per-browser, so anonymous reporters can be counted as distinct people.
  -- Defeatable by design, which is exactly why auto-hide needs several of
  -- them plus a score threshold rather than trusting any one.
  anon_id    text,
  -- Computed from coordinates that are then DISCARDED. There is no column
  -- anywhere holding where anybody was. A browser coordinate is spoofable
  -- from devtools, which is precisely why it is not worth keeping.
  geo_verified boolean not null default false,
  created_at timestamptz not null default now()
);

create index reports_by_orchard on reports (orchard_id, created_at desc);

alter table reports enable row level security;
-- No grants. submit_report below is the only door.

-- ---------------------------------------------------------------------------
-- How much to believe a listing, with time decay.
--
-- Trouble counts double. That asymmetry is deliberate: a false "it was open"
-- costs somebody a two-hour drive with children in the car, and a false "it
-- was closed" costs a pin that a person can restore. The cheaper mistake gets
-- the lighter weight.
--
-- Everything decays with a thirty-day half-life, so a place confirmed last
-- autumn and reported shut yesterday scores badly, and a place reported shut
-- last autumn and confirmed since recovers. In a business with an eight-week
-- season, a year-old confirmation is worth almost nothing and the maths says so.
-- ---------------------------------------------------------------------------
create or replace view orchard_confidence as
select
  o.id as orchard_id,
  count(*) filter (where r.kind = 'open'   and r.created_at > now() - interval '90 days') as confirms_90d,
  count(*) filter (where r.kind <> 'open'  and r.created_at > now() - interval '90 days') as troubles_90d,
  -- Distinct PEOPLE, not reports. One person with a grudge and a browser
  -- toggle is two addresses; several separate people is a signal.
  --
  -- ONLY 'gone'. This counted 'closed' too until a test caught it, and the
  -- effect was the opposite of what the comment on apply_auto_hide promised:
  -- six people reporting a farm closed on a wet Tuesday pushed the score past
  -- -6 and the reporter count past 4, so the very first 'gone' report hid a
  -- farm outright. "Closed today" and "gone for good" are different claims and
  -- only the second one is about whether the place exists.
  count(distinct coalesce(r.user_id::text, r.anon_id))
    filter (where r.kind = 'gone' and r.created_at > now() - interval '90 days')
    as trouble_reporters_90d,
  max(r.created_at) filter (where r.kind = 'open') as last_confirmed_at,
  coalesce(sum(
    (case when r.kind = 'open' then 1.0 else -2.0 end)
    * exp(-extract(epoch from now() - r.created_at) / 2592000.0)
  ), 0)::numeric(8,3) as score
from orchards o
left join reports r on r.orchard_id = o.id
group by o.id;

revoke all on orchard_confidence from public, anon, authenticated;
grant select on orchard_confidence to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Auto-hide needs TWO conditions, not one.
--
-- Raised above restroom-map's thresholds on purpose. An orchard is a real
-- business with a findable address and a name people know; wrongly hiding one
-- is a worse error than wrongly hiding a public toilet, and a competitor or a
-- disgruntled visitor will try. Only 'gone' counts — 'closed' and 'busy' are
-- facts about a day, not about whether the farm exists.
-- ---------------------------------------------------------------------------
create or replace function apply_auto_hide()
returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_score    numeric;
  v_troubles int;
begin
  if NEW.kind <> 'gone' then
    return NEW;
  end if;

  select score, trouble_reporters_90d into v_score, v_troubles
  from orchard_confidence where orchard_id = NEW.orchard_id;

  if coalesce(v_score, 0) < -6 and coalesce(v_troubles, 0) >= 4 then
    update orchards set status = 'hidden'
    where id = NEW.orchard_id and status = 'active';

    -- The hide writes its own reason, so it is never unexplainable later.
    insert into flags (target_type, target_id, kind, message)
    values ('orchard', NEW.orchard_id, 'auto',
            'auto-hidden: four or more people reported this orchard gone');
  end if;

  return NEW;
end $$;

create trigger reports_auto_hide after insert on reports
  for each row execute function apply_auto_hide();

-- ---------------------------------------------------------------------------
-- The only way to write a report.
-- ---------------------------------------------------------------------------
create or replace function submit_report(
  p_orchard_id uuid,
  p_kind       text,
  p_anon_id    text   default null,
  p_lat        float8 default null,
  p_lng        float8 default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_kind report_kind;
  v_fp   text := client_fingerprint();
  v_geo  boolean := false;
begin
  begin
    v_kind := p_kind::report_kind;
  exception when invalid_text_representation then
    raise exception 'unknown report kind: %', p_kind using errcode = '22023';
  end;

  perform 1 from orchards where id = p_orchard_id and status = 'active';
  if not found then
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
    into v_geo from orchards where id = p_orchard_id;
  end if;

  insert into reports (orchard_id, kind, user_id, anon_id, geo_verified)
  values (p_orchard_id, v_kind, auth.uid(),
          nullif(left(p_anon_id, 64), ''), coalesce(v_geo, false));

  return jsonb_build_object('ok', true, 'geo_verified', coalesce(v_geo, false));
end $$;

grant execute on function submit_report(uuid, text, text, float8, float8)
  to anon, authenticated;
