-- What the farms' own websites say, and how we came to believe it.
--
-- The scraper never writes a live field. It writes OBSERVATIONS — one row per
-- extracted value, carrying the page it came from, the tier that produced it
-- and a confidence — and a promotion step turns those into operator facts.
--
-- That indirection is the whole design. A confidently wrong "picking is open"
-- is the precise failure this project exists to prevent, and it is worse than
-- no data at all: somebody drives two hours on it. Keeping the raw observation
-- means a wrong promotion can be explained and reversed, rather than appearing
-- as an unattributed value that nobody can account for six months later.

set search_path = public, extensions;

-- One row per crawl of one host, whether or not anything came of it.
create table scrape_runs (
  id          uuid primary key default gen_random_uuid(),
  orchard_id  uuid references orchards(id) on delete cascade,
  host        text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  -- 'ok' | 'not-modified' | 'robots-disallow' | 'timeout' | 'http-404' | ...
  outcome     text not null,
  pages       int not null default 0,
  bytes       int not null default 0,
  -- Highest fetch tier used: 1 plain fetch, 2 headless browser.
  fetch_tier  int,
  -- What the LLM tier cost, if it ran. Null means it did not.
  tokens_in   int,
  tokens_out  int,
  note        text
);

create index scrape_runs_recent on scrape_runs (orchard_id, started_at desc);

create type observation_tier as enum (
  'structured',  -- JSON-LD / microdata. Cheap, reliable, and measured to be
                 -- useless for opening hours: not one sampled site published
                 -- them machine-readably.
  'heuristic',   -- regex and vocabulary matching against page text
  'model'        -- an LLM reading the cleaned text under a strict schema
);

create table scrape_observations (
  id         uuid primary key default gen_random_uuid(),
  run_id     uuid not null references scrape_runs(id) on delete cascade,
  orchard_id uuid not null references orchards(id) on delete cascade,
  -- The operator-fact column this is about: 'upick_open', 'hours', …
  field      text not null,
  -- Kept as text regardless of the column's type, because an observation is a
  -- record of what a page said, not yet a typed value. Casting happens at
  -- promotion, where a failure can be recorded rather than crashing a crawl.
  value      text,
  tier       observation_tier not null,
  confidence numeric(3,2) not null check (confidence between 0 and 1),
  source_url text not null,
  -- The sentence the value came out of, so a human reviewing a promotion can
  -- see what the machine saw without refetching a page that has since changed.
  evidence   text,
  created_at timestamptz not null default now()
);

create index scrape_observations_pending
  on scrape_observations (orchard_id, field, created_at desc);

alter table scrape_runs         enable row level security;
alter table scrape_observations enable row level security;
revoke all on scrape_runs         from anon, authenticated;
revoke all on scrape_observations from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Promotion: an observation becomes an operator fact.
--
-- The threshold starts LOOSE and is meant to be tightened. That is a
-- deliberate choice and the reason it is one number in one place: shipping
-- strict means every field stays empty and nobody can tell whether the
-- pipeline works, while shipping loose means wrong values appear where they
-- can be seen, argued with and measured. The direction of travel is downward
-- — raise MIN_CONFIDENCE as the evidence comes in.
--
-- Whatever the threshold, a promoted value always carries its source URL and
-- its timestamp, and the UI always renders when it was checked. A fact with no
-- date is a fact nobody can second-guess.
-- ---------------------------------------------------------------------------
create or replace function promote_observations(p_min_confidence numeric default 0.55)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_promoted int := 0;
  v_skipped  int := 0;
  r          record;
begin
  for r in
    /*
     * The newest observation per (orchard, field). An older run's answer never
     * overwrites a newer one, whatever their confidences.
     *
     * Confidence is the tie-break, and it is not decorative. `created_at`
     * defaults to now(), which in Postgres is TRANSACTION start time — so
     * every observation written by one run carries an identical timestamp and
     * `distinct on` was free to keep whichever it liked. A test caught it
     * keeping a 0.35 heuristic guess over a 0.8 reading from the model tier,
     * in the same run, for the same field.
     */
    select distinct on (o.orchard_id, o.field)
           o.orchard_id, o.field, o.value, o.confidence, o.source_url, o.created_at
      from scrape_observations o
     where o.created_at > now() - interval '7 days'
     order by o.orchard_id, o.field, o.created_at desc, o.confidence desc
  loop
    if r.confidence < p_min_confidence then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    begin
      if r.field = 'upick_open' then
        update orchards
           set upick_open = (r.value::boolean),
               operator_checked_at = r.created_at,
               operator_source_url = r.source_url
         where id = r.orchard_id;
      elsif r.field in ('hours', 'admission') then
        execute format(
          'update orchards set %I = $1, operator_checked_at = $2, operator_source_url = $3 where id = $4',
          r.field)
          using left(r.value, 500), r.created_at, r.source_url, r.orchard_id;
      elsif r.field = 'reservations_required' then
        update orchards
           set reservations_required = (r.value::boolean),
               operator_checked_at = r.created_at,
               operator_source_url = r.source_url
         where id = r.orchard_id;
      elsif r.field = 'variety' then
        insert into orchard_varieties (orchard_id, variety, source, source_url)
        values (r.orchard_id, r.value, 'scrape', r.source_url)
        on conflict (orchard_id, variety) do update
          set source_url = excluded.source_url, noted_at = now();
      else
        v_skipped := v_skipped + 1;
        continue;
      end if;
      v_promoted := v_promoted + 1;
    exception when others then
      -- A bad cast is one field of one farm, not a failed run.
      v_skipped := v_skipped + 1;
    end;
  end loop;

  return jsonb_build_object('promoted', v_promoted, 'skipped', v_skipped);
end $$;

revoke all on function promote_observations(numeric) from public, anon, authenticated;

-- What a moderator looks at: the machine disagreeing with the people.
--
-- The farm's site says picking is on; several visitors said it was picked out.
-- Neither is wrong — the site states an intention and the visitors state a
-- Saturday — and the detail page shows both. This view is for spotting the
-- ones worth a human ringing up.
create or replace view operator_visitor_conflicts as
select
  o.id as orchard_id,
  o.name,
  o.upick_open,
  o.operator_checked_at,
  o.operator_source_url,
  c.troubles_90d,
  c.trouble_reporters_90d,
  c.score
from orchards o
join orchard_confidence c on c.orchard_id = o.id
where o.upick_open is true
  and c.trouble_reporters_90d >= 2
  and o.status = 'active';

revoke all on operator_visitor_conflicts from public, anon, authenticated;
