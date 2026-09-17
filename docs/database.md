# The database

**Status: written, not yet run.** There is no Supabase project for this yet, so
every migration in `supabase/migrations/` is unapplied and unverified. They are
committed because the schema is the design and the design is reviewable — but
nobody should describe them as working until `pnpm db:migrate` has succeeded
once against a real project. Expect to fix something on the first run.

The site does not need any of this. Phase 1 shipped with no database at all,
and `HAS_DB` is false without credentials, which hides every affordance that
would need one rather than showing a button that silently fails.

## Getting it running

1. Create a Supabase project.
2. Put the URL, the anon key and the database password in `.env`
   (see `.env.example`). `.env` is gitignored and must stay that way — the
   database password bypasses RLS entirely.
3. Apply and seed:

```bash
pnpm db:migrate
node scripts/seed-to-sql.mjs > supabase/seed.sql
node scripts/db.mjs file supabase/seed.sql
```

4. Enable Google in Authentication → Providers.
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

The first two and the fourth are generated from `map-kit` templates by
`scripts/gen-migration.mjs` and then committed as plain SQL. They are written
once and never regenerated: substituting at apply time would make a checksum
depend on the environment, and the runner refuses a migration whose file
changed after it was applied.

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
