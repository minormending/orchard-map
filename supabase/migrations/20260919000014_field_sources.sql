-- Provenance is per row, and a row can have two sources.
--
-- Every orchard records `import_source`, `import_id` and `import_licence`, and
-- the About page makes a promise about them: "Every listing records where it
-- came from and under what terms, so withdrawing a source is one filter rather
-- than an archaeology project."
--
-- That stopped being true. Rose's Berry Farm is labelled osm / ODbL-1.0 and
-- carries a surveyed OpenStreetMap building as its position — but its address,
-- town and phone come from the Connecticut Apple Marketing Board, because the
-- state's own directory is the better authority on a mailing address than a
-- building polygon's reverse geocode. So the farm page credits OpenStreetMap
-- for an address OpenStreetMap did not supply, and filtering on import_source
-- to withdraw either source would take the wrong fields with it.
--
-- It happened twice before anybody designed for it: the phone in 5cf78f1, then
-- the address in 859220a. A third was going to be somebody's confusing
-- afternoon.
--
-- ONLY THE EXCEPTIONS ARE STORED. A field with no row here came from the
-- orchard's own `import_source`, which is the overwhelmingly common case — 253
-- farms times nine roster fields is a table nobody wants, and almost every
-- entry in it would repeat what the orchard row already says. Absence means
-- "as labelled", which is both smaller and truer.
--
-- Operator facts are deliberately out of scope. `hours`, `upick_open`,
-- `admission` and the varieties already carry `operator_source_url` and
-- `operator_checked_at`, which say something stronger than a source name: the
-- exact page they were read from and when. This table is for the roster —
-- the fields a directory supplies about a farm's existence and how to reach it.

set search_path = public, extensions;

create table orchard_field_sources (
  orchard_id     uuid not null references orchards(id) on delete cascade,
  field          text not null,
  import_source  text not null,
  import_licence text not null,
  /* Why this field came from somewhere else, for whoever reads it next. */
  note           text,
  noted_at       timestamptz not null default now(),

  primary key (orchard_id, field),

  -- The roster fields an importer can supply. Deliberately a closed list: a
  -- typo here would silently produce provenance for a column that does not
  -- exist, which is worse than no provenance because it reads as an answer.
  constraint orchard_field_sources_field check (field in (
    'name', 'geog', 'address', 'town', 'state', 'zip', 'phone', 'website', 'tags'
  ))
);

comment on table orchard_field_sources is
  'Which source supplied a field, WHEN IT WAS NOT the one on the orchard row. '
  'No row means the field came from the orchard''s own import_source.';

create index orchard_field_sources_by_source
  on orchard_field_sources (import_source);

/**
 * What withdrawing a source would touch.
 *
 * The About page's promise, made checkable. Ask it for a source and it returns
 * every orchard that would lose its whole row, and every individual field that
 * would have to be cleared from a row belonging to somebody else.
 */
create or replace view source_withdrawal as
  select o.import_source as source,
         o.slug,
         'whole row' as scope,
         null::text as field
    from orchards o
   union all
  select fs.import_source,
         o.slug,
         'field only',
         fs.field
    from orchard_field_sources fs
    join orchards o on o.id = fs.orchard_id;

grant select on source_withdrawal to anon, authenticated;

-- The two enrichments that prompted this, recorded rather than inferred.
insert into orchard_field_sources (orchard_id, field, import_source, import_licence, note)
select o.id, f.field, 'ctapples', 'unstated', f.note
  from orchards o
  cross join (values
    ('address', 'A state marketing board is a better authority on a mailing address than a building polygon''s reverse geocode: 295 Matson Hill Road, not OSM''s 297.'),
    ('town',    'South Glastonbury, per the directory. OSM said Glastonbury.'),
    ('phone',   'OSM carried no phone for this farm.')
  ) as f(field, note)
 where o.slug = 'rose-s-berry-farm-glastonbury'
on conflict (orchard_id, field) do nothing;
