#!/usr/bin/env node
/**
 * The only way a reader writes anything.
 *
 *   node scripts/record-observations.mjs <file.json>
 *   node scripts/record-observations.mjs -            (read stdin)
 *   node scripts/record-observations.mjs <file.json> --promote
 *
 * A scheduled session reads farm pages and decides what they say. This is how
 * that decision reaches the database — and it is deliberately the ONLY way.
 *
 * The session never runs SQL. It hands this script structured JSON, every
 * field of which is validated here against the same closed vocabularies the
 * schema uses, and anything that does not fit is refused with a reason rather
 * than coerced into something that fits. That matters because the session has
 * been reading arbitrary third-party HTML: if a page could talk a reader into
 * emitting a surprising value, the blast radius has to end at "one refused
 * observation", not "arbitrary statement executed against the database".
 *
 * It writes observations. It does not write facts. Promotion is still the
 * separate thresholded step in the database, and `--promote` merely calls it.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { dbConfig } from '@minormending/map-kit/node/connect'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const source = args.find((a) => !a.startsWith('--'))
const PROMOTE = args.includes('--promote')

if (!source) {
  console.error('usage: record-observations.mjs <file.json|-> [--promote]')
  process.exit(1)
}

const raw = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8')

let payload
try {
  payload = JSON.parse(raw)
} catch (err) {
  console.error(`that is not JSON: ${err.message}`)
  process.exit(1)
}

/** Fields a reader is allowed to have an opinion about, and their shapes. */
const FIELDS = {
  upick_open: 'boolean',
  reservations_required: 'boolean',
  hours: 'text',
  admission: 'text',
  variety: 'variety',
}

const TIERS = new Set(['structured', 'heuristic', 'model'])

const varieties = new Set(
  JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'varieties.json'), 'utf8'))
    .map((v) => v.slug),
)

const problems = []
const clean = []

const items = Array.isArray(payload) ? payload : payload.observations
if (!Array.isArray(items)) {
  console.error('expected an array, or an object with an "observations" array')
  process.exit(1)
}

items.forEach((o, i) => {
  const at = `observation ${i}`
  const bad = (why) => problems.push(`${at}: ${why}`)

  if (!o || typeof o !== 'object') return bad('not an object')
  if (typeof o.orchard_slug !== 'string' || !o.orchard_slug) return bad('no orchard_slug')

  const shape = FIELDS[o.field]
  if (!shape) return bad(`field "${o.field}" is not one a reader may record`)

  if (!TIERS.has(o.tier)) return bad(`tier "${o.tier}" is not known`)

  const c = Number(o.confidence)
  if (!Number.isFinite(c) || c < 0 || c > 1) return bad(`confidence ${o.confidence} is not 0..1`)

  // A source URL is not decoration: a promoted fact carries it, and the page
  // is what a person checks when they disagree with the map.
  if (typeof o.source_url !== 'string' || !/^https?:\/\//.test(o.source_url)) {
    return bad('source_url must be an absolute http(s) URL')
  }

  let value = o.value
  if (shape === 'boolean') {
    if (typeof value === 'boolean') value = String(value)
    if (value !== 'true' && value !== 'false') return bad(`${o.field} must be true or false`)
  } else if (shape === 'variety') {
    // Matched against the closed vocabulary, so a reader cannot invent an
    // apple however confidently a page names one.
    if (!varieties.has(value)) return bad(`"${value}" is not a known variety slug`)
  } else {
    if (typeof value !== 'string' || !value.trim()) return bad(`${o.field} needs text`)
    if (value.length > 500) return bad(`${o.field} is longer than 500 characters`)
    value = value.trim()
  }

  clean.push({
    orchard_slug: o.orchard_slug,
    field: o.field,
    value,
    tier: o.tier,
    confidence: c,
    source_url: o.source_url,
    evidence: typeof o.evidence === 'string' ? o.evidence.slice(0, 300) : null,
  })
})

if (problems.length > 0) {
  console.error(`refused ${problems.length} of ${items.length}:`)
  for (const p of problems.slice(0, 20)) console.error(`  ${p}`)
  if (clean.length === 0) process.exit(1)
  console.error(`\nwriting the ${clean.length} that are well-formed`)
}

const client = new pg.Client(dbConfig({ root: ROOT, applicationName: 'orchard-map/record' }))
await client.connect()

let written = 0
let unknown = 0

try {
  await client.query('begin')

  // One run row for the batch, so every observation is attributable to a
  // moment and a process rather than appearing from nowhere.
  const { rows: run } = await client.query(
    `insert into scrape_runs (host, outcome, note) values ($1, 'ok', $2) returning id`,
    ['session', `recorded by a scheduled reader, ${clean.length} observations`])

  for (const o of clean) {
    const { rows: orchard } = await client.query(
      `select id from orchards where slug = $1 and status = 'active'`, [o.orchard_slug])
    if (orchard.length === 0) { unknown++; continue }

    await client.query(
      `insert into scrape_observations
         (run_id, orchard_id, field, value, tier, confidence, source_url, evidence)
       values ($1, $2, $3, $4, $5::observation_tier, $6, $7, $8)`,
      [run[0].id, orchard[0].id, o.field, o.value, o.tier, o.confidence, o.source_url, o.evidence])
    written++
  }

  await client.query('commit')
} catch (err) {
  await client.query('rollback')
  console.error(`nothing was written: ${err.message}`)
  await client.end()
  process.exit(1)
}

console.log(`recorded ${written} observations` + (unknown ? `, ${unknown} for unknown orchards` : ''))

if (PROMOTE) {
  const { rows } = await client.query('select promote_observations() as r')
  console.log(`promoted ${rows[0].r.promoted}, skipped ${rows[0].r.skipped}`)
}

await client.end()
