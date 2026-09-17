# The database

**Status: verified against Postgres, not yet applied to a Supabase project.**

Every migration applies cleanly from a clean database, the seed loads, and 22
behaviour tests pass — against Postgres 15 + PostGIS 3.4 in a container, with a
shim supplying the parts of a Supabase project the migrations assume (`auth.uid()`,
`auth.users`, the `anon`/`authenticated` roles, `extensions.pgcrypto`).

```bash
pnpm db:verify      # container -> migrations -> seed -> behaviour tests
```

What remains unproven is the Supabase-specific layer: PostgREST exposing the
`submit_*` functions by argument name, the real signup trigger on `auth.users`,
and Google OAuth. Those need a project.

**Verification earned its place immediately.** The first run found four real
faults, every one of which would otherwise have surfaced on a live project:

| | |
| --- | --- |
| `orchards_import_key` was a **partial** unique index | `ON CONFLICT (cols)` cannot use one unless the statement repeats the predicate, so every upsert in the seed failed. The predicate bought nothing — unique indexes already treat NULLs as distinct. |
| `trouble_reporters_90d` counted `closed` as well as `gone` | The exact opposite of what `apply_auto_hide`'s comment promised. Six people reporting a farm shut on a wet Tuesday pushed the score past -6 and the count past 4, so the next single `gone` report hid the farm outright. |
| `promote_observations` broke ties arbitrarily | `created_at` defaults to `now()`, which is **transaction** start time, so every observation from one crawl shares a timestamp. `distinct on` was free to keep a 0.35 regex guess over a 0.8 model reading of the same field. Confidence is now the tie-break. |
| the verification harness itself raced the image's init | The PostGIS image creates the extension on a socket-only server and accepts queries throughout, so a naive readiness poll ran `create extension postgis` concurrently with its own and killed the container. |

The site does not need any of this. Phase 1 shipped with no database at all,
and `HAS_DB` is false without credentials, which hides every affordance that
would need one rather than showing a button that silently fails.

## Getting it running

1. Create a Supabase project. **Do not reuse restroom-map's** — it already has
   `profiles`, `flags`, `feedback`, `rate_limit` and `reports`, and these
   migrations would collide with all five. `revoke all on profiles` and
   `alter default privileges ... revoke` in particular would reach straight
   into a live app.
2. Put the URL, the anon key and the database password in `.env`
   (see `.env.example`). `.env` is gitignored and must stay that way — the
   database password bypasses RLS entirely.
3. Apply and seed:

```bash
pnpm db:migrate
node scripts/seed-to-sql.mjs > supabase/seed.sql
node scripts/db.mjs file supabase/seed.sql
```

4. Point Auth at the site and switch Google on:

```bash
node scripts/configure-auth.mjs            # shows current vs intended
node scripts/configure-auth.mjs --apply
```

   A fresh project ships with `site_url` set to `http://localhost:3000`, which
   is wrong for every deployed site and will bounce somebody to a dead address
   after they sign in — worth fixing whether or not Google is ready. The
   redirect allow list is a wildcard over the whole site, because sign-in
   returns to the page it started from and that can be any of the 199 orchard
   pages.

   The Google OAuth client itself has to be made by hand in Google Cloud
   Console: it is an interactive login against a Google account, there is no
   API for the consent screen, and there should not be one for handing out an
   account's OAuth credentials. The script prints the exact origins and
   redirect URI to paste in.
5. Add `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` as **repository
   variables** (not secrets — the anon key belongs in the bundle) so the
   deployed build picks them up.

## The migrations

| file | what it does |
| --- | --- |
| `…001_kit_rate_limit` | `rl_take`, `client_fingerprint`, salted and unreachable from any client |
| `…002_kit_profiles` | accounts, and a signup trigger that derives a display name |
| `…003_orchards` | orchards, varieties, orchard_varieties |
| `…004_kit_moderation` | flags, feedback, `moderation_queue` |
| `…005_reports` | reports, confidence with decay, auto-hide, `submit_report` |
| `…006_grants` | who may write what |
| `…007_submissions` | `submit_orchard`, visitor claims, the two-people rule |
| `…008_scraping` | scrape runs, observations, `promote_observations` |

The first two and the fourth are generated from `map-kit` templates by
`scripts/gen-migration.mjs` and then committed as plain SQL. They are written
once and never regenerated: substituting at apply time would make a checksum
depend on the environment, and the runner refuses a migration whose file
changed after it was applied.

## From a crawl to the map

Five steps, and each boundary is a place a wrong "picking is open" can be
stopped before somebody drives two hours on it.

```
scrape.mjs --queue   crawl politely, settle what a regex can, queue the rest
      ↓
a scheduled session  read the queued text, decide, record observations
      ↓
record-observations  validate against closed vocabularies, insert
      ↓
promote_observations at a confidence threshold — a person runs this
      ↓
db:export + deploy   write src/data/orchards.json, rebuild the static site
```

Nothing a visitor reads changes until the last step. The export is deliberately
not something the reader does.

```bash
node scripts/export-data.mjs            # says what would change
node scripts/export-data.mjs --apply
pnpm build
```

Hidden and removed orchards are simply left out of the export, which is how a
soft delete reaches the map: the row and its history stay in the database, the
pin stops being published.

## The two field classes

This is the part worth understanding before changing anything.

`restroom-map`'s rule is that **two people who independently agree settle a
field**. That is right when nobody publishes the answer — no dataset says
whether a toilet has grab bars.

Orchards are different, and only half different. The farm publishes its own
opening hours; one reading of the farm's own website beats two strangers
guessing. But the same farm's site says "open 9–5" on a day the car park filled
at eleven and they turned people away.

So:

| class | examples | settled by |
| --- | --- | --- |
| **operator fact** | hours, picking open, admission, reservations | the farm's own site, via the scraper, with `operator_source_url` and `operator_checked_at` |
| **visitor fact** | dogs, restrooms, stroller-passable rows, cider donuts | two independent agreeing claims |

A conflict between them is **shown, not resolved**: *"The farm says open 9–5.
Two visitors reported it picked out on Sunday."* That is more useful than
either alone, and hiding the disagreement is how the wasted trip happens.

## What is different from restroom-map, and why

**Auto-hide is harder to trigger.** `restroom-map` hides at `score < -3` with 3
distinct reporters. Here it is `score < -6` with 4, and only `gone` counts —
not `closed`, not `busy`, which are facts about a day rather than about whether
the farm exists. An orchard is a named business with a findable address;
wrongly hiding one is a worse error than wrongly hiding a public toilet, and a
competitor will try.

**The geo-verification radius is 800m, not 150m.** A farm is a big place and
its car park is not its centroid.

**Reports need no account.** It is the highest-volume, lowest-risk signal
available, and a sign-in wall would remove nearly all of it.

## The rule that keeps the doors shut

> A table with a `submit_*` function in front of it has no write grant.

`…006_grants.sql` is mostly `revoke`, and that is not paranoia. Supabase ships
default privileges granting the API roles everything on new tables in `public`.
A table created and left alone is one that anybody holding the anon key — which
is in the bundle, by design — can insert into directly, skipping every rate
limit above it.

`restroom-map` shipped exactly that hole on `flags`, the table that receives
takedown requests. Two things that both looked like access control were sitting
there and neither checked the thing that mattered.

**When testing this:** a missing grant and an RLS refusal are both error
`42501`. Assert the *message* — `permission denied for table` is the grant,
`violates row-level security policy` is the policy. A test asserting only the
code passes against the broken schema.

And a permission test must actually `set local role anon`. Setting the JWT
claim alone leaves the connection as the owner, which bypasses grants and RLS
entirely — such a test passes no matter what the schema says. `asRole()` in
`scripts/test-schema.mjs` does the former; `become()` does only the latter and
is for identity, not permissions.
