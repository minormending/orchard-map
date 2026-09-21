#!/usr/bin/env node
/**
 * The database, back out to the file the site is built from.
 *
 *   node scripts/export-data.mjs            say what would change
 *   node scripts/export-data.mjs --apply    write src/data/orchards.json
 *   node scripts/export-data.mjs --pending  write scripts/.pending.json
 *
 * This is the step that makes promotion mean anything. The site is static and
 * reads `src/data/orchards.json` at build time; everything upstream of here —
 * crawling, reading, recording, promoting — happens in the database and is
 * invisible to a visitor until this runs and the site rebuilds.
 *
 * It is deliberately a separate, reviewable step rather than something the
 * scheduled reader does. The reader records observations; a person promotes;
 * this publishes. Each boundary is a place a wrong "picking is open" can be
 * stopped before somebody drives two hours on it.
 *
 * Hidden and removed orchards are left out entirely, which is how a soft
 * delete reaches the map: the row and its history stay in the database, the
 * pin stops being published.
 *
 * ---------------------------------------------------------------------------
 * --pending, which publishes nothing
 * ---------------------------------------------------------------------------
 *
 * A submitted farm is hidden, so it is not in `src/data/orchards.json`, and
 * `scrape.mjs` reads its targets from that file — which meant a submission
 * could not be crawled until after it had been approved, and approving it is
 * the decision the crawl was supposed to inform.
 *
 * `--pending` writes the same row shape to `scripts/.pending.json` instead,
 * from the `pending_submissions` view. It lives here rather than in a script
 * of its own so there is one copy of the query and the row mapping; the
 * crawler's idea of a farm cannot drift from the site's if both come out of
 * the same function.
 *
 * That file is **gitignored on purpose**. These are unreviewed rows typed by
 * strangers, and committing them would publish, in a public repository, the
 * exact thing `hidden` exists to withhold. `--pending` therefore never takes
 * `--apply`, never touches `src/data/`, and refuses to be combined with it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { dbConfig } from '@minormending/map-kit/node/connect'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src', 'data', 'orchards.json')
const PENDING_OUT = join(ROOT, 'scripts', '.pending.json')
const APPLY = process.argv.includes('--apply')
const PENDING = process.argv.includes('--pending')

if (PENDING && APPLY) {
  process.stderr.write(
    '--pending and --apply do different jobs and must not be combined:\n' +
    '  --apply   publishes active farms to the site\n' +
    '  --pending hands unreviewed submissions to the crawler, and publishes nothing\n',
  )
  process.exit(1)
}

/*
 * Two sources, one shape. `pending_submissions` is defined in migration 018
 * and is `orchards` narrowed to rows that are hidden with an open submission
 * flag — which is not the same as `status = 'hidden'`, because that is also
 * where a moderator puts a farm that has closed down.
 */
const FROM = PENDING ? 'pending_submissions o' : 'orchards o'
const WHERE = PENDING ? 'true' : `o.status = 'active'`

const client = new pg.Client(dbConfig({ root: ROOT, applicationName: 'orchard-map/export' }))
await client.connect()

const { rows } = await client.query(`
  select
    o.id, o.slug, o.name,
    st_y(o.geog::geometry) as lat,
    st_x(o.geog::geometry) as lng,
    o.address, o.town, o.state, o.zip, o.phone, o.website,
    /* ::text[] is load-bearing. node-postgres ships parsers for the built-in
       array types but not for a custom enum array, so orchard_tag[] comes back
       as the raw literal {pick_your_own,farm_market} -- a string, which then
       serialises into the JSON as a string and quietly breaks every filter on
       the site. The typechecker caught it; nothing at runtime would have.
       (And no backticks in here: this is inside a template literal, and the
       first draft of this comment closed it.) */
    o.tags::text[] as tags,
    o.upick_open, o.hours, o.admission, o.reservations_required,
    o.operator_checked_at, o.operator_source_url,
    o.dogs, o.restrooms, o.wheelchair_rows, o.cards_accepted, o.picnic_area,
    o.hayride, o.corn_maze, o.petting_zoo, o.food_on_site, o.cider_donuts,
    o.position_precision,
    o.import_source, o.import_id, o.import_licence,
    /* Only the fields that came from somewhere other than o.import_source.
       Absent means "as labelled", which is almost every field of almost every
       farm — see migration 014. */
    (select jsonb_object_agg(fs.field, fs.import_source)
       from orchard_field_sources fs
      where fs.orchard_id = o.id) as field_sources,
    coalesce(
      (select array_agg(ov.variety order by v.start_doy nulls last, v.name)
         from orchard_varieties ov
         join varieties v on v.slug = ov.variety
        where ov.orchard_id = o.id),
      '{}') as varieties
  from ${FROM}
  where ${WHERE}
  order by o.slug
`)

await client.end()

/** Drop keys that are null, so the file stays readable and diffs stay small. */
const compact = (obj) => {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue
    if (Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return out
}

const previous = JSON.parse(readFileSync(OUT, 'utf8'))
const byslug = new Map(previous.map((o) => [o.slug, o]))

const exported = rows.map((r) => {
  const prior = byslug.get(r.slug)
  return {
    id: prior?.id ?? `db-${r.id}`,
    slug: r.slug,
    name: r.name,
    lat: Number(Number(r.lat).toFixed(6)),
    lng: Number(Number(r.lng).toFixed(6)),
    address: r.address,
    town: r.town,
    state: r.state,
    zip: r.zip,
    phone: r.phone,
    website: r.website,
    tags: r.tags ?? [],
    ...compact({
      // Only ever 'approximate' in practice — null means nobody recorded a
      // precision, which is not the same as claiming the pin is exact.
      position_precision: r.position_precision,
      upick_open: r.upick_open,
      hours: r.hours,
      admission: r.admission,
      reservations_required: r.reservations_required,
      // Rendered, never hidden. A stale "open" costs somebody a two-hour
      // drive, so the page has to be able to say when it was last checked.
      checked_at: r.operator_checked_at?.toISOString() ?? null,
      source_url: r.operator_source_url,
      dogs: r.dogs,
      restrooms: r.restrooms,
      wheelchair_rows: r.wheelchair_rows,
      cards_accepted: r.cards_accepted,
      picnic_area: r.picnic_area,
      hayride: r.hayride,
      corn_maze: r.corn_maze,
      petting_zoo: r.petting_zoo,
      food_on_site: r.food_on_site,
      cider_donuts: r.cider_donuts,
      varieties: r.varieties,
    }),
    import_source: r.import_source,
    import_id: r.import_id,
    import_licence: r.import_licence,
    ...(r.field_sources ? { field_sources: r.field_sources } : {}),
    imported_at: prior?.imported_at ?? new Date().toISOString().slice(0, 10),
  }
})

/*
 * --pending stops here, before anything that compares against the published
 * file. Every one of those comparisons is about the map, and a submission is
 * not on the map: `gone` would read as "301 farms would come off it", which
 * is true of this array and nonsense as a statement about the site.
 */
if (PENDING) {
  const crawlable = exported.filter((e) => e.website)
  writeFileSync(PENDING_OUT, JSON.stringify(exported, null, 2) + '\n')
  process.stderr.write(
    `${exported.length} submission${exported.length === 1 ? '' : 's'} awaiting review\n` +
    exported
      .map((e) => `    ${e.name} (${[e.town, e.state].filter(Boolean).join(', ')})` +
                  `${e.website ? '' : ' — no website, nothing to read'}`)
      .join('\n') +
    (exported.length ? '\n' : '') +
    `\n${crawlable.length} with a website\nwrote ${PENDING_OUT}\n`,
  )
  process.exit(0)
}

// --- what changed ------------------------------------------------------------

const gone = previous.filter((p) => !exported.some((e) => e.slug === p.slug))
const added = exported.filter((e) => !byslug.has(e.slug))
const enriched = exported.filter((e) => {
  const p = byslug.get(e.slug)
  return p && (e.upick_open !== undefined || e.hours !== undefined || e.varieties)
    && !(p.upick_open !== undefined || p.hours !== undefined || p.varieties)
})

process.stderr.write(`
${exported.length} active orchards from the database

  newly carrying farm-checked data: ${enriched.length}
    ${enriched.map((e) => e.name).join('\n    ') || '(none)'}

  no longer published: ${gone.length}
    ${gone.map((g) => g.name).join('\n    ') || '(none)'}

  new: ${added.length}
`)

/*
 * Removing a farm is not a routine export.
 *
 * This file is generated, so the export is entitled to overwrite it — but a
 * row disappearing means a farm that was on the map yesterday is not on it
 * today, and the reasons for that divide sharply. Hiding one deliberately is
 * ordinary. Its row having been deleted from the table by mistake is not, and
 * the two look identical from here: the query simply returns one fewer row.
 *
 * On 2026-09-18 three Connecticut farms were deleted from the table as
 * duplicates they were not, and the next export would have taken them off the
 * site. The count was printed in the summary above, exactly as designed, and
 * that was not enough — a number in a report is only a safeguard for somebody
 * who reads it, and this export usually runs in the middle of a longer job.
 *
 * So it stops instead, and names them. Passing --allow-removals is how you say
 * you meant it.
 */
const ALLOW_REMOVALS = process.argv.includes('--allow-removals')

if (!APPLY) {
  process.stderr.write('dry run — pass --apply to write src/data/orchards.json\n')
} else if (gone.length > 0 && !ALLOW_REMOVALS) {
  process.stderr.write(
    `refusing to write: ${gone.length} ${gone.length === 1 ? 'farm' : 'farms'} would come off the map\n\n` +
    gone.map((g) => `    ${g.name} (${g.slug})`).join('\n') + '\n\n' +
    'If they were hidden on purpose, pass --allow-removals.\n' +
    'If not, they are missing from the orchards table and want restoring first.\n',
  )
  process.exit(1)
} else {
  writeFileSync(OUT, JSON.stringify(exported, null, 2) + '\n')
  process.stderr.write(`wrote ${OUT}\n`)
}
