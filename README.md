# Orchard Map

**→ [minormending.github.io/orchard-map](https://minormending.github.io/orchard-map/)**

A map of apple orchards within a day trip of New York, built around the
question the other maps do not answer: **is it worth the drive this weekend?**

Google Maps knows an orchard exists. It does not know whether picking is open
today or the trees are picked out, which varieties are ripe this week, whether
there is hard cider or only the sweet stuff, whether dogs are allowed, or
whether you need a timed ticket. Those are the facts that decide a two-hour
drive with children in the car.

199 orchards, cider mills and farm markets — 94 of them pick-your-own.

Coverage is uneven and the About page says exactly how: New York is thorough
because the state has a trade association with a member directory; Connecticut,
Pennsylvania and Massachusetts are OpenStreetMap leftovers. New Jersey's own
directory serves `Disallow: /` to every crawler, so it depends on OSM and on
people adding farms themselves.

Static site on GitHub Pages, Postgres behind it, no server in between. The
browser can read public data and propose writes; it never decides whether a
write is legitimate. Shared pieces live in
[`map-kit`](https://github.com/minormending/map-kit), alongside
[`restroom-map`](https://github.com/minormending/restroom-map).

## Running it

```bash
pnpm install
pnpm dev
```

Opens on the bundled dataset — no Supabase project needed, and that is a
supported state rather than a degraded one. The map works with no database at
all; the database is only involved in writes.

> **If the dev server serves stale code** after an edit, its watcher has missed
> the change — restart it. This cost an hour here already: a CSS fix and a
> layout fix both appeared to do nothing, and neither had been served.

## Where the data comes from

Two sources, with genuinely different terms, both recorded per row.

The [New York Apple Association](https://www.applesfromny.com/) member
directory, via its WordPress store locator — names, addresses, coordinates,
phone numbers, websites and categories, for New York. It states **no licence**,
which is ambiguity rather than permission.

[OpenStreetMap](https://www.openstreetmap.org/) as a cross-reference, under
**ODbL 1.0** — the only rows here whose terms are not a guess. It is second and
not first because measured across this region:

| | |
| --- | --- |
| `self_harvesting=yes` — the OSM tag for pick-your-own | **1 feature** |
| `shop=farm` with a website | 82 |
| `landuse=orchard` with a name | 50 of 569 |

OSM is a good source of orchard *polygons* and a poor source of orchard
*facts*. It stays as a cross-reference, not a roster.

The association states no licence. That is ambiguity rather than permission, so
every row records `import_source`, `import_id` and `import_licence` —
withdrawing the source is one filter rather than an archaeology project.

```bash
node scripts/import-nyaa.mjs            # dry run, says what it would write
node scripts/import-nyaa.mjs --apply    # writes src/data/orchards.json
node scripts/import-nyaa.mjs --fresh    # ignore the local cache
```

The locator caps every response at 25 rows, so the importer sweeps a grid and
subdivides any cell that comes back saturated.

```bash
node scripts/import-osm.mjs            # dry run
node scripts/import-osm.mjs --apply    # merge OSM's leftovers in
```

OSM rows arrive with **no categories at all** unless `craft=cider` says
otherwise. Inferring pick-your-own from a name containing "U-Pick" is exactly
the sort of guess that puts a family in a car; an empty tag list renders as "No
details yet", which is true.

### Greenmarkets are not on the map

The directory also lists 51 New York City greenmarket stalls — a folding table
on a pavement on 175th Street. That is a fact about the grower who drives down,
not about the corner, and it is dropped. Farms that sell at greenmarkets *and*
grow apples, like Fishkill Farms, stay.

## Why Astro, and why static

`restroom-map` fetches its places at runtime through a viewport query capped at
300 rows. That is right for thousands of restrooms across a city, where the
viewport *is* the query.

Here the entire region is smaller than one of those pages — 199 rows, about
95KB — so fetching it is pure latency. And unlike restrooms, this map is found
through Google: "apple picking warwick ny" is the query that matters, and a
single-page app cannot rank for it, because there is one URL and its markup is
a loading state.

So every orchard gets a real static page, and the map is the tool people use
once they arrive.

## The rule that governs the schema

> **`null` means nobody has said. It does not mean no.**

An orchard with `dogs: null` is one nobody has asked about; `dogs: false` has
told us no. The UI must never render the first as the second. A wrong "open"
costs somebody a two-hour drive, and the only thing worse than a map that does
not know is one that pretends to — which is why every orchard page currently
says, in as many words, that its hours have not been checked.

## Tests

```bash
pnpm test
```

Two suites, both guarding things that would otherwise fail silently: the filter
rules (tags **AND** rather than OR — OR makes every extra tick return *more*
results, which is the opposite of what a filter is for), and the integrity of
the generated dataset (unique slugs, positions inside the box, known tags,
provenance on every row).

## Build and deploy

Push to `main`. GitHub Actions runs the tests, builds with
`BASE_PATH=/<repo>/`, and deploys to Pages.

The bundle carries a build number — `git rev-list --count HEAD`. `deploy.yml`
sets `fetch-depth: 0` because `actions/checkout` clones shallow by default,
which would pin every deployed build at `1`: worse than no version at all,
because it looks like one and never changes.

## Where this is going

See [SPEC.md](SPEC.md). Phase 1 — this — is the read-only map. Then seasons and
varieties, then accounts and moderation, then a scraper that reads the farms'
own sites, then the states beyond New York.
