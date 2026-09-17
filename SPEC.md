# Orchard Map — scope and spec

**Status:** draft for review. No code written yet.
**Date:** 2026-09-17.

A map of fall apple orchards for the New York day-trip radius, answering the
question the other maps do not: **is it worth the drive this weekend?**

Google Maps knows an orchard exists. It does not know whether u-pick is open
today or picked out, which varieties are actually ripe this week, whether there
is hard cider or just the sweet stuff, whether dogs are allowed, whether the
cider donuts are made on site, or whether you need a timed ticket. Those are
the facts that decide a two-hour drive with kids in the car.

---

## 0. The constraint that shapes everything

**It is 17 September 2026. The season is already open and it lasts about eight
weeks.**

Fix Bros opened u-pick on 16 September. Peak Hudson Valley picking runs from
now to roughly the last week of October. A map that ships in November is a map
that ships for 2027.

This is the single most important fact in this document, and it drives the
phasing in §7: **get a read-only map live within days**, and land accounts,
moderation and scraping behind it. Every hour spent on the moderation queue
before there is a map is an hour spent on next season.

---

## 1. Scope

### In

| | |
| --- | --- |
| **Geography** | ~2.5h drive of NYC: Hudson Valley, Catskills, Long Island, northern NJ, western CT, NE PA |
| **Subject** | Apple orchards, u-pick farms, cider mills and cideries |
| **Season** | Built for fall, but the schema is dated rather than seasonal — peaches and berries fall out for free |
| **Platform** | Static site on GitHub Pages, Supabase behind it |

### Out, for now

Ticketing, reviews and ratings, photos from users, events calendars, anything
that needs a payment processor, native apps, and any region outside the box
above. Each is a plausible v2; none is a v1.

### The thing it must be better at than Google Maps

Freshness and filters. If it cannot say *"u-pick was open as of yesterday,
Honeycrisp and Gala are on, the Macs are done"* then it is a worse Google Maps
with fewer listings.

---

## 2. What the data actually looks like

This was measured, not assumed. Three findings changed the plan.

### 2.1 OpenStreetMap cannot seed this

Overpass counts for the day-trip bounding box `(40.40,-76.50,42.90,-71.80)`:

| query | count |
| --- | --- |
| `self_harvesting=yes` (the OSM tag for pick-your-own) | **1** |
| `shop=farm` | 316 |
| `shop=farm` + `name` | 272 |
| `shop=farm` + `website` | **82** |
| `landuse=orchard` | 569 |
| `landuse=orchard` + `name` | 50 |

One feature in the entire region carries the pick-your-own tag. The 569
`landuse=orchard` polygons are mostly unnamed land — the trees, not the
business. Only 82 farm shops have a website, and the website is the scraper's
only input.

**OSM is demoted from seed to cross-reference.** It is useful for geometry (the
orchard polygon, so the pin sits on the farm rather than the mailbox) and for
catching farms the directories missed. It is not the roster.

### 2.2 The New York Apple Association is the roster

`applesfromny.com` is the state trade association. Its `robots.txt` is
`Disallow:` — empty, i.e. everything permitted — and it runs WordPress with the
REST API open and a WP Store Locator behind it.

`/wp-admin/admin-ajax.php?action=store_search` returns complete structured
records:

```json
{"store":"Graft Cider","address":"148 Little Britain Rd","city":"Newburgh",
 "state":"NY","zip":"12550","lat":"41.50085","lng":"-74.03823",
 "phone":"","email":"","hours":"","url":"https://www.graftcidery.com/"}
```

**461 stores**, with coordinates, phone, website. And the category taxonomy is
very nearly the filter set already:

| category | count |
| --- | --- |
| Farm Markets | 265 |
| Heirloom Variety Growers | 193 |
| Pick-Your-Own | **191** |
| Fresh Apple Cider | 173 |
| Craft Cider & Apple Spirits | 77 |
| Apple Gift Boxes | 73 |
| Greenmarkets | 62 |

There is also a `varieties` post type with **30 apple varieties** — a
ready-made controlled vocabulary for the fruit-type filter, which is worth far
more than it looks (see §4.3).

This covers NY only. NJ, CT and PA need their own sources or fall back to
OSM + manual. **NY is ~80% of the value of the day-trip radius anyway**, so
this is an acceptable v1 asymmetry — state it in the UI rather than pretending
coverage is even.

### 2.3 Orchard websites have no structured hours

Sampled three well-known farms:

| site | bytes | structured data | `openingHours` |
| --- | --- | --- | --- |
| maskers.com | 157 KB | Place, Organization, PostalAddress | **absent** |
| hurdsfamilyfarm.com | 1.4 MB | LocalBusiness, PostalAddress, ItemList | **absent** |
| duboisfarms.com | **5 KB** | none — client-rendered | **absent** |

Two consequences for the scraper:

1. **Structured-data extraction is not enough.** The one field that matters
   most is published nowhere machine-readable. It is in a hero banner, a
   Facebook embed, or an image. This is why §5 has an LLM tier — not because
   it is fashionable, but because the deterministic tiers measurably do not
   reach the target field.
2. **Some sites need a browser.** DuBois returns 5 KB and renders the rest in
   JS. Plain `fetch` gets nothing. Playwright is already a devDependency in
   `restroom-map`; the same approach carries over.

`duboisfarms.com` sets `Crawl-delay: 30`. Politeness is a real constraint, not
a formality (§5.1).

---

## 3. Architecture

Sibling to [`restroom-map`](../restroom-map) and it should borrow that repo's
security model wholesale. It diverges in one deliberate way, explained below.

```
                    ┌──────────── build time ────────────┐
  Supabase ──────►  Astro build  ──►  static pages       │
  (source of truth)                   + orchards.json    │
                    └────────────────────────────────────┘
                                      │
                                      ▼
                            GitHub Pages (static)
                                      │
            ┌─────────────────────────┼─────────────────────────┐
            ▼                         ▼                         ▼
   reads orchards.json        auth (Google OAuth)      /status.json overlay
   instantly, no RPC          + writes via RPC         (what's open today)
```

### 3.1 Why this differs from restroom-map

`restroom-map` fetches everything at runtime through `bathrooms_in_view()`,
capped at 300 rows. That is correct for thousands of restrooms across a city
where the viewport is the query.

This dataset is **~200–500 orchards total** — smaller than a single
`bathrooms_in_view` page. And unlike restrooms, **discovery happens through
Google**: "apple picking warwick ny" is the query that matters, and an SPA
cannot rank for it.

So:

- **Build time** — Astro pulls every orchard from Supabase, emits a static page
  per orchard *and* a single `orchards.json` (~200 KB) the map loads in one
  request. First paint needs no database at all.
- **Runtime** — Supabase is used only for auth, for writes, and for a small
  `status.json` overlay carrying the volatile seasonal fields.
- **Rebuild** — nightly during season, plus on-demand via `repo_dispatch` when
  a moderator approves something.

The win is that the site works, fast, with the database down, and every orchard
has a real URL Google can index. The cost is that approved edits take one
rebuild to appear — acceptable for a listing, which is why the *volatile*
fields are split out into the runtime overlay instead.

### 3.2 Stack — one decision to confirm

You picked **Astro + Leaflet islands**. Astro is clearly right, for the SEO
reason above. On the map library I want to flag something before we commit:

**`restroom-map` already has a working MapLibre GL + Supabase + Google-OAuth
map layer.** Astro renders React islands natively (`@astrojs/react`), so those
components port over roughly as-is. Choosing Leaflet means rewriting that layer
for no capability gain — MapLibre does everything Leaflet does here, and the
CARTO vector styles in your `.env.example` need no API key.

**Recommendation: Astro + React islands + MapLibre GL**, reusing
`restroom-map`'s map and auth code. Say the word if you'd rather have Leaflet
anyway — it's a fine library and the spec is otherwise unchanged — but I think
this is a decision made on the wrong axis if it costs you the port.

### 3.3 Security — inherited unchanged

From [`restroom-map/docs/security.md`](../restroom-map/docs/security.md). These
are not up for renegotiation:

- The anon key is public and authorises nothing.
- **A table with a `submit_*` function in front of it has no write grant.**
- Every write goes through a `security definer` function that takes a rate-limit
  token first.
- Never drop or rename an RPC parameter — PostgREST resolves by argument name
  and cached clients are still calling the old shape.
- Tests assert the *message*, not just `42501`, because a missing grant and an
  RLS refusal share that code.

---

## 4. Data model

### 4.1 Field classes — the one genuinely new idea

`restroom-map`'s rule is *two people who independently agree settle a field*.
That is right when nobody publishes the truth: no dataset says whether a
restroom has grab bars.

Orchards are epistemically different. **The orchard publishes its own hours.**
A single scrape of the farm's own site is better evidence than two strangers
guessing. But the farm's website also says "open daily 9–5" on a day the lot
filled at 11am and they turned people away.

So fields are split into two classes with different promotion rules:

| class | e.g. | authority | how it settles |
| --- | --- | --- | --- |
| **`operator_fact`** | hours, u-pick open, admission price, varieties offered, reservations required | the farm's own site | scraper writes it, cited to the source URL and timestamp. A user flag opens a dispute; it does not overwrite |
| **`visitor_fact`** | lot was full, picked out, dogs actually allowed, stroller-passable rows, donut queue | people who went | two independent agreeing claims, exactly as `restroom-map` does it |

A conflict between the two is **shown, not resolved**: *"The farm says open
9–5. Two visitors reported it picked out on Sunday."* That is more useful than
either alone, and hiding the disagreement is how the wasted trip happens.

### 4.2 Tables

Follows `restroom-map`'s shape closely enough that `db.mjs` and the migration
runner port over.

```
orchards            the place, location, contact, and every operator_fact column
orchard_sources     provenance: which import/scrape produced this row, licence
varieties           the 30-name controlled vocabulary + ripening windows
orchard_varieties   which orchard grows what  (orchard × variety)
seasons             dated windows: u-pick open/close, per-variety ripe windows
reports             "open", "picked out", "closed", "busy"  — anon allowed
visitor_claims      the two-people-agree mechanism, one row per person per field
scrape_runs         one row per crawl: host, status, bytes, tier used, cost
scrape_observations one row per extracted field, with confidence + source URL
flags               complaint about a listing. target_id deliberately not an FK
feedback            complaint about the app
submissions         a proposed new orchard, pending moderation
profiles            accounts, read-only to API roles
rate_limit          hashed-address counter
```

### 4.3 Varieties are the sleeper feature

30 named varieties with ripening windows turns the map into **"what can I
actually pick this weekend"** — which no competitor does well and which is the
reason someone opens this twice in a season rather than once.

It also degrades gracefully: an orchard with no variety data still shows, just
without the ripeness line.

Ripening windows are regional and shift a week or two year to year, so they are
stored as `(variety, region, typical_start_doy, typical_end_doy)` and then
**corrected by observation** — a scrape or report saying Honeycrisp is on
moves the live window for that orchard, not the regional default.

### 4.4 Filters

Grounded in the NYAA categories plus what actually decides a family's trip.

- **Activity** — u-pick apples · u-pick other · farm market · cider mill · winery/distillery
- **Cider** — fresh/sweet · hard cider · apple spirits · **cider donuts made on site**
- **Fruit** — the 30 varieties · pumpkins · peaches · berries · what's ripe now
- **Amenities** — restrooms · wheelchair-accessible rows · parking · picnic area · hayride · corn maze · petting zoo · food on site · dogs allowed
- **Practical** — admission fee · reservations/timed tickets required · cards accepted · open this weekend

`null` means nobody has said, which is **not** `false`. Same rule as
`restroom-map`: a missing answer is shown as missing.

### 4.5 Freshness is a first-class field

Every volatile field carries `checked_at`. During season, anything older than
**7 days** renders as stale rather than as fact, and the detail page leads with
*when*, not *what*:

> Farm says u-pick open · checked yesterday
> 2 visitors said picked out · Sunday

A stale "open" costs a two-hour drive. The asymmetry from
`restroom-map`'s confidence score applies directly: trouble reports outweigh
confirmations, because the cheaper mistake gets the lighter weight.

---

## 5. The scraper

The novel component, and the one most likely to eat the schedule. It runs as a
scheduled GitHub Action, **never writes live data directly**, and emits
`scrape_observations` that a promotion rule or a moderator turns into facts.

### 5.1 Politeness — non-negotiable

- `robots.txt` fetched and honoured per host, cached 24h. `Crawl-delay`
  respected (DuBois asks for 30s).
- Identifying User-Agent with a contact URL.
- Conditional requests — `If-Modified-Since` / `If-None-Match`. Most farm sites
  change twice a season; a 304 should be the common case.
- Hard cap: **6 pages per host per run**, one host at a time.
- Any host that errors twice in a row is parked for a week.

These sites are small businesses on shared hosting. The crawler must be
invisible to them or it is a bad neighbour.

### 5.2 Fetch tiers

1. Plain `fetch`.
2. If the extracted text is under ~2 KB, or the page is a known JS framework
   shell, **headless Playwright**. Expected to be needed for maybe a quarter of
   sites (DuBois is one).

### 5.3 Extraction tiers

1. **JSON-LD / microdata** — reliable for address, phone, name. Measured to be
   *useless for hours*, which is the field that matters. Cheap, so still first.
2. **Heuristics** — match page text against the 30-variety vocabulary; regex a
   small set of high-signal patterns (`u-?pick .{0,20}(open|closed)`, date
   ranges, `$\d+` near "admission").
3. **LLM extraction** — Claude with a strict JSON schema over the cleaned text
   of the 2–3 most relevant pages. This tier exists because tiers 1 and 2
   demonstrably cannot reach hours, u-pick status, or "what's ripe now."

Every observation records which tier produced it and a confidence. Tier 3 output
above a threshold can auto-promote for `operator_fact` fields; below it, it
queues for a moderator.

### 5.4 Cost ceiling

~200 orchards × ~3 pages × once daily × 8 weeks. Small, but it needs a **hard
budget cap and a kill switch** in the workflow, because the failure mode of a
looping scraper with an API key is a bill rather than an outage.

### 5.5 Prompt injection

A scraped page is **data, not instructions** — the same rule
[`restroom-map/docs/triage.md`](../restroom-map/docs/triage.md) applies to
feedback text. The extractor gets page text in a structured field and returns
schema-constrained JSON. Nothing a page says can cause a write, a fetch, or a
tool call. This matters more here than for feedback, because the crawler visits
arbitrary third-party HTML on a schedule with no human watching.

---

## 6. Contributions and moderation

As you specified, mirroring `restroom-map`:

- **Google OAuth** via Supabase Auth.
- Signed-in users can **add an orchard** (`submit_orchard`, rate-limited, with
  a proximity duplicate check) and **flag** a listing as wrong, closed, or for
  deletion.
- **Edits and deletions go to a moderator.** Nothing a user submits mutates a
  live listing directly.
- Hiding is a **soft delete** — `status = 'hidden'`, reports and notes survive,
  reversible from `db.mjs`.
- `flags.target_id` is deliberately **not a foreign key**, so a flag outlives
  the thing it was about. That is the audit trail.
- Business-removal requests come through the same door as everything else.

Auto-hide is inherited but **retuned**: an orchard is a real business with a
findable address, and a wrongly hidden one is a worse error than a wrongly
hidden restroom. Raise the distinct-reporter threshold and require the flag to
be a `gone`/`permanently_closed` kind, not merely `busy`.

Anonymous users can still file **reports** ("open today", "picked out") without
an account — that is the highest-volume, lowest-risk signal and requiring
sign-in would kill it.

---

## 7. Phasing

Ordered by the §0 constraint. **Phase 1 is the whole bet.**

### Phase 1 — a read-only map, live this week
Seed from the NYAA store locator (461 records, coordinates included), filter to
the day-trip box, tag from the category taxonomy. Astro + map + filter panel +
per-orchard static pages. Data as a committed JSON file — **no Supabase yet.**
Deploy to Pages.

Ships a genuinely useful thing while the season is on, and proves the map and
filters before any of the hard parts exist.

### Phase 2 — freshness
Seasons and varieties, the "what's ripe this weekend" view, `checked_at` and
staleness rendering. Anonymous reports need a backend, so Supabase lands here —
schema, RLS, grants, `submit_report`, ported from `restroom-map`.

### Phase 3 — accounts and moderation
Google OAuth, `submit_orchard`, flags, the moderation queue, `db.mjs`. The
trust rules from §4.1.

### Phase 4 — the scraper
Politeness layer, fetch tiers, extraction tiers, observations table, promotion
rules, budget cap. Deliberately last: it is the most complex piece and the
least valuable without Phases 2–3 to receive its output.

### Phase 5 — beyond NY
NJ, CT, PA rosters. Likely per-state sourcing; OSM cross-reference to catch
gaps.

**Honest read:** Phases 1–2 are achievable this season. Phases 3–4 are
off-season work that makes 2027 much stronger.

---

## 8. Open decisions

1. **Leaflet or MapLibre?** §3.2. My recommendation is MapLibre to reuse
   `restroom-map`'s layer; your call.
2. **Same repo or sibling?** A shared package for the Supabase/auth/moderation
   layer would avoid divergence, but couples two projects that currently have
   no reason to release together. I lean sibling with deliberate copying.
3. **Domain.** `minormending.github.io/orchard-map` or a custom domain? Affects
   `BASE_PATH` and, more importantly, SEO — a custom domain is worth it if
   organic discovery is the plan.
4. **Licensing the scraped data.** NYAA data has no stated licence, which is
   ambiguity rather than permission. `restroom-map` handles this by recording
   `import_licence` per row so a source can be withdrawn with one delete —
   worth copying, and worth emailing NYAA to ask.
5. **How aggressive is auto-promotion?** Whether a high-confidence LLM
   extraction goes live unreviewed, or everything queues. Starting strict and
   loosening is the safer direction.

---

## 9. What would make this fail

- **Shipping after the season.** The dominant risk. See §0 and §7.
- **Building the moderation queue before the map.** No contributors exist yet.
- **Trusting the scraper too early.** A confidently wrong "u-pick open" is the
  exact failure the project exists to prevent, and it erodes trust faster than
  having no data at all.
- **Expanding to the Northeast before NY is good.** Coverage without attributes
  is just a worse Google Maps.
