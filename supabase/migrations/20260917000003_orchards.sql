-- The map itself: orchards, the apple vocabulary, and which grows what.
--
-- The column layout encodes the one idea this schema exists for. Fields split
-- into two classes with different rules about who may settle them:
--
--   OPERATOR FACTS — hours, whether picking is open, admission, reservations.
--     The farm publishes these about itself. One scrape of the farm's own site
--     outranks two strangers guessing, so these carry a source URL and a
--     timestamp and are written by the scraper, not voted on.
--
--   VISITOR FACTS — dogs, restrooms, stroller-passable rows, cider donuts,
--     whether the lot was full. Nobody publishes these. They need two people
--     who independently agree, exactly as restroom-map settles accessibility.
--
-- restroom-map has only the second kind, because nobody publishes whether a
-- toilet has grab bars. Applying its two-people rule to opening hours would be
-- the wrong epistemics: it would leave a field empty that the farm has already
-- answered in public.
--
-- And across both: NULL means nobody has said. It does not mean no.

set search_path = public, extensions;

create extension if not exists postgis;
create extension if not exists pgcrypto;

create type orchard_status as enum ('active', 'hidden', 'removed');

create type orchard_tag as enum (
  'pick_your_own', 'farm_market', 'fresh_cider', 'craft_cider',
  'heirloom', 'gift_boxes', 'greenmarket');

create table orchards (
  id            uuid primary key default gen_random_uuid(),
  -- Stable and human-readable, because it is also the URL of a static page.
  slug          text not null unique,
  name          text not null,
  geog          geography(point, 4326) not null,

  address       text,
  town          text,
  state         text,
  zip           text,
  phone         text,
  website       text,

  tags          orchard_tag[] not null default '{}',
  status        orchard_status not null default 'active',

  -- ---- operator facts -----------------------------------------------------
  upick_open            boolean,
  hours                 text,
  admission             text,
  reservations_required boolean,
  -- Where the above came from and when. Rendered, never hidden: a stale "open"
  -- costs somebody a two-hour drive, so the page leads with when it was checked.
  operator_checked_at   timestamptz,
  operator_source_url   text,

  -- ---- visitor facts ------------------------------------------------------
  dogs            boolean,
  restrooms       boolean,
  wheelchair_rows boolean,
  cards_accepted  boolean,
  picnic_area     boolean,
  hayride         boolean,
  corn_maze       boolean,
  petting_zoo     boolean,
  food_on_site    boolean,
  cider_donuts    boolean,

  -- ---- provenance ---------------------------------------------------------
  -- Withdrawing a source is one delete, and the licence travels with the rows
  -- rather than living in somebody's memory. The association states none,
  -- which is ambiguity rather than permission, so it is recorded as
  -- 'unstated' rather than left blank.
  import_source  text,
  import_id      text,
  import_licence text,

  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

/*
 * Not a partial index, and that is load-bearing.
 *
 * This started as `... where import_source is not null`, which looks tidier
 * and quietly breaks the seed loader: `ON CONFLICT (cols)` cannot use a
 * partial index unless the statement repeats the predicate, so every upsert
 * failed with "no unique or exclusion constraint matching the ON CONFLICT
 * specification". Found by running it.
 *
 * The predicate bought nothing anyway. Unique indexes treat NULLs as distinct,
 * so user-submitted rows — which carry import_source 'user' and no import_id —
 * do not collide with each other regardless.
 */
create unique index orchards_import_key on orchards (import_source, import_id);
create index orchards_geog on orchards using gist (geog);
create index orchards_live on orchards (status) where status = 'active';
create index orchards_tags on orchards using gin (tags);

-- ---------------------------------------------------------------------------
-- The apple vocabulary.
--
-- start_doy/end_doy are PICKING windows, not shop availability. The
-- association's own "availability" line runs to April for Braeburn, because
-- that is cold storage. Storing that here would have the map recommending a
-- March picking trip. See scripts/import-varieties.mjs.
-- ---------------------------------------------------------------------------
create table varieties (
  slug           text primary key,
  name           text not null,
  flavour        text not null check (flavour in ('sweet', 'tart', 'balanced')),
  profile        text[] not null default '{}',
  best_for       text[] not null default '{}',
  hint           text,
  -- Null when there is no reliable window. Such a variety is left out of
  -- "ripe now" rather than guessed into it.
  start_doy      int check (start_doy between 1 and 366),
  end_doy        int check (end_doy between 1 and 366),
  harvest_source text,
  import_source  text,
  import_licence text
);

-- Which orchard grows what. Empty for every row until the scraper runs, which
-- is why the variety filter does not exist in the UI yet: a filter that always
-- returns nothing teaches people the map is broken.
create table orchard_varieties (
  orchard_id uuid not null references orchards(id) on delete cascade,
  variety    text not null references varieties(slug) on delete cascade,
  -- How we came to believe it: 'scrape', 'visitor', 'operator'.
  source     text not null,
  source_url text,
  noted_at   timestamptz not null default now(),
  primary key (orchard_id, variety)
);

alter table orchards          enable row level security;
alter table varieties         enable row level security;
alter table orchard_varieties enable row level security;

-- Reading is public; writing is not. Grants are handled in one place, in the
-- grants migration, so there is a single file to read when asking "who can
-- write to what".
create policy orchards_read on orchards for select to anon, authenticated
  using (status = 'active');
create policy varieties_read on varieties for select to anon, authenticated
  using (true);
create policy orchard_varieties_read on orchard_varieties for select to anon, authenticated
  using (true);

create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  NEW.updated_at := now();
  return NEW;
end $$;

create trigger orchards_touch before update on orchards
  for each row execute function touch_updated_at();
