# Orchard Map

**→ [minormending.github.io/orchard-map](https://minormending.github.io/orchard-map/)**

A map of apple orchards within a day trip of New York, built around the
question the other maps do not answer: **is it worth the drive this weekend?**

**New here? Start with [docs/](docs/README.md)** — how the whole thing works,
in six pages with diagrams, written for somebody who has just cloned it.

Google Maps knows an orchard exists. It does not know whether picking is open
today or the trees are picked out, which varieties are ripe this week, whether
there is hard cider or only the sweet stuff, whether dogs are allowed, or
whether you need a timed ticket. Those are the facts that decide a two-hour
drive with children in the car.

301 orchards, cider mills and farm markets — 100 of them pick-your-own.

| state | listings | source |
| --- | --- | --- |
| NY | 217 | [New York Apple Association](https://www.applesfromny.com/), plus 28 compiled by hand |
| CT | 43 | [Connecticut Apple Marketing Board](https://ctapples.org/find-a-farm/) |
| NJ | 20 | compiled by hand — see below |
| PA | 17 | [PA Preferred](https://papreferred.com/search) |
| MA | 4 | OpenStreetMap leftovers |

New York's source is the only one that publishes categories, so its listings
arrive knowing whether a farm does pick-your-own. The others are rosters —
names, addresses, websites — and the attributes get filled in by reading the
farms' own sites.

Pennsylvania looks thin for a good reason: Adams County, the state's apple
capital, is two hundred miles from New York City and falls outside the
day-trip radius entirely. What is here is the north-east.

New Jersey has no directory to import. `findjerseyfresh.com`, the state's own,
serves `Disallow: /` to every crawler — a clear answer, and it is respected.
So its twenty farms were compiled by hand instead and loaded through
`import-userlist.mjs`, which puts a hand-made list through the same placement
rules as a scraped one: geocoded, boxed, duplicate-checked, and anything it
will not place confidently left in `scripts/.candidates/` for a person.

Those rows carry `import_source = 'user'`, the same as a farm somebody submits
through the site, because in both cases the answer to "who says so" is a
person rather than a directory.

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

Every row records `import_source`, `import_id` and `import_licence`, so
withdrawing a source is one filter rather than an archaeology project.

```bash
node scripts/import-nyaa.mjs            # dry run, says what it would add
node scripts/import-nyaa.mjs --apply    # adds to the database
node scripts/import-nyaa.mjs --fresh    # ignore the local cache
```

The locator caps every response at 25 rows, so the importer sweeps a grid and
subdivides any cell that comes back saturated.

```bash
node scripts/import-osm.mjs            # dry run
node scripts/import-osm.mjs --apply    # add OSM's leftovers

node scripts/import-ctapples.mjs       # Connecticut
node scripts/import-papreferred.mjs    # Pennsylvania
```

### Which way the data flows

`src/data/orchards.json` is a **build artifact**. `export-data.mjs` regenerates
it from the `orchards` table, filtered to `status = 'active'`, and the site
builds from the file. So the direction is one way:

```
directories ──▶ importers ──▶ orchards table ──▶ export-data.mjs ──▶ src/data/orchards.json ──▶ site
```

Editing the file directly works right up until the next export, which reverts
it — and every importer used to do exactly that, so a farm they added lasted
until somebody ran the export and was then silently dropped. That cost three
real Connecticut farms on 2026-09-18. All four now add to the table, and the
export refuses to write when a farm would come off the map:

```bash
node scripts/import-ctapples.mjs --apply   # adds to the database
pnpm db:export -- --apply                  # publishes them to the file
```

`seed-to-sql.mjs` turns the exported file back into SQL, which is how a fresh
database gets seeded. It upserts roster fields only — never the hours, prices
and varieties the reader earns — so re-seeding cannot flatten what a farm's own
website said.

Every importer is a dry run by default and shares one set of placement rules
in `scripts/lib/directory.mjs` — geocoding, the day-trip box, and the
duplicate checks. Shared rather than copied because those rules took several
rounds to get right: the name matcher started generous enough to match
"Beardsley's **Cider Mill** & Orchard" against "The **Cider Mill**, LLC", a
different farm in a different county.

A listing an importer will not place confidently goes to
`scripts/.candidates/` instead of being guessed at, and a weekly routine
reviews them.

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

Here the entire region is smaller than one of those pages — 301 rows, about
160KB — so fetching it is pure latency. And unlike restrooms, this map is found
through Google: "apple picking warwick ny" is the query that matters, and a
single-page app cannot rank for it, because there is one URL and its markup is
a loading state.

So every orchard gets a real static page, and the map is the tool people use
once they arrive.

## Who reads the farms' websites

The crawl is deterministic code; the judgment is a scheduled Claude session.
That split is the security boundary, not a convenience.

`scripts/scrape.mjs --queue` does every network-facing thing — robots.txt,
crawl delays, one request per host, conditional requests — and settles what it
can with structured data and regexes. What it cannot settle, it writes to
`scripts/.queue/` as page **text**.

A daily task then reads those files and decides. It exists because a pattern
match has no idea what day it is: Altamont Orchards, read on 17 September, said
*"PICK YOUR OWN APPLES : Open on September 12 & 13th"* — a true sentence about
a finished weekend. Reading that as "open" is the two-hour wasted drive this
project is built to prevent, which is why regex open-claims score below the
promotion threshold and a reader makes the call.

The reader **never fetches anything**. It reads files already on disk, so a
page cannot make it follow a link — following links is not a capability it
has. It **never writes SQL**: its only write path is
`scripts/record-observations.mjs`, which validates every field against the
same closed vocabularies the schema uses and refuses the rest. And it **never
promotes**; recording an observation is not changing the map.

### Reading a farm before it is on the map

A submitted orchard lands hidden, and the crawler reads its targets out of
`src/data/orchards.json`, which holds what is published. So a submission could
only be crawled *after* somebody approved it — when what the farm's own site
says is most of what decides whether to approve it at all.

```bash
node scripts/export-data.mjs --pending   # writes scripts/.pending.json
node scripts/scrape.mjs --pending --queue
```

The first publishes nothing: it writes the submissions awaiting review to a
gitignored file, because they are unreviewed rows typed by strangers and
committing them is the one thing `hidden` exists to prevent. The second crawls
them first, queues them whatever the regexes found — for a submission the
question underneath is whether this is a real farm at all, and no regex has an
opinion about that — and marks the queue file `pending_review` so the reader
knows the pin is not on the map yet.

That the crawler will now fetch a URL a stranger typed is a genuinely new
thing, and `scripts/lib/hosts.mjs` is the door it goes through: no IP
literals, no `localhost` or `.local` or `.internal`, and a name that resolves
to a private address is refused. The nightly read runs on a laptop inside a
home network, and `http://169.254.169.254/latest/meta-data/` is a thing a URL
can say. What that does *not* close — DNS rebinding between the check and the
fetch — is written down in that file rather than left to be discovered.

The instructions live in `.claude/skills/read-farm-sites/SKILL.md`, versioned
with the code they act on, so they change in the same commit as the schema
they depend on.

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

A hundred and sixteen tests, all guarding things that would otherwise fail
silently:

- **filters** — tags **AND** rather than OR. OR makes every extra tick return
  *more* results, which is the opposite of what a filter is for.
- **data** — unique slugs, positions inside the box, known tags, the right
  licence per source, and no inferred categories on OSM rows.
- **season** — nothing ripe in March, no picking window longer than 95 days.
  Both exist to catch the association's *retail availability* figure leaking
  into a *picking* window; Braeburn's reads "October through April".
- **extract** — the three ways the scraper has already been wrong, each a real
  page fragment rather than a hypothetical.
- **website** — what a submitted URL may be, run over every website already on
  the map: if the rule would reject or rewrite one of them, the rule is wrong.
  Also the private-address ranges, walked at both edges, because the first
  version let `240.0.0.1` through.

## Build and deploy

Push to `main`. GitHub Actions runs the tests, builds with
`BASE_PATH=/<repo>/`, and deploys to Pages.

## Which build am I looking at

Every page carries its build number in the header — `v11`, counted with
`git rev-list --count HEAD`, so v43 is the 43rd commit and maps back to exactly
one:

```bash
git rev-list --reverse HEAD | sed -n '43p'
```

Clicking it forces a genuinely fresh fetch of the document and reloads.

That button exists because of a specific trap: **GitHub Pages serves HTML with
about a ten-minute cache**, so a deploy can be finished and green and still be
invisible in an open tab — and an ordinary reload cheerfully serves the cached
copy again. This cost me several minutes chasing a phone layout that was
"still broken", until I noticed the stylesheet's content hash had not changed
and realised I was not looking at the build I had just shipped. `fetch(url,
{cache: 'reload'})` skips the cache *and replaces the stored entry*, so the
reload after it gets the new document.

`restroom-map` has the same widget for a different reason — its service worker
precaches the bundle and a hard refresh does not go round it. There is no
service worker here, so that fix was not copied along with the idea; this one
clears the Cache API anyway, so it keeps telling the truth if somebody adds one.

`deploy.yml` sets `fetch-depth: 0` because `actions/checkout` clones shallow by
default, which would pin every deployed build at `1` — worse than no version at
all, because it looks like one and never changes. `astro.config.mjs` **fails
the build** if it sees a count of 1 in CI, so removing that line breaks loudly
instead of silently.

## Where this is going

[SPEC.md](SPEC.md) has the five phases. All five are written; what separates
them now is how much of each has actually *run*.

| | |
| --- | --- |
| 1 · the map | **live** |
| 2 · seasons and varieties | **live** |
| 2b–3 · reports, accounts, moderation | schema written, **never applied** |
| 4 · the scraper | runs nightly through the season; a scheduled session reads what a regex cannot |
| 5 · beyond New York | ten OSM rows in; CT and PA directories not done |

The gap is one thing: **there is no Supabase project yet**, so every migration
in `supabase/migrations/` is unapplied and unverified. See
[docs/database.md](docs/database.md). The site does not need it — `HAS_DB` is
false without credentials and every affordance that would need one renders
nothing at all, rather than offering a button that silently fails.
