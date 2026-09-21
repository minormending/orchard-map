#!/usr/bin/env node
/**
 * A list of farms a person compiled by hand.
 *
 *   node scripts/import-userlist.mjs <file.json>              dry run
 *   node scripts/import-userlist.mjs <file.json> --candidates write the unclear ones
 *   node scripts/import-userlist.mjs <file.json> --apply      add the clean ones
 *
 * Every other importer reads a directory that publishes its own terms. This one
 * reads a file somebody assembled themselves, which is why the rows land as
 * `user` / `user-submitted` — a licence the schema already knows, and the only
 * honest label for "a person looked this up and typed it in".
 *
 * THE COORDINATES ARE TAKEN AS GIVEN. Unlike Connecticut, nothing here is
 * geocoded: the list arrives with positions, and Photon's guess at a rural
 * address is worse than a person's. That also means the usual protection
 * against a geocoder answering with a town centre does not apply, so the only
 * position check is the day-trip box.
 *
 * It decides nothing. A listing that looks wrong is reported with a reason, the
 * same as everywhere else in this pipeline — a reason is an invitation for a
 * person to look, not a verdict.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inBox, matchExisting, slugify, normaliseUrl, distanceM } from './lib/directory.mjs'
import { loadRoster, addOrchards, freeSlug } from './lib/roster.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CANDIDATES = join(ROOT, 'scripts', '.candidates')

const args = process.argv.slice(2)
const FILE = args.find((a) => !a.startsWith('--'))
const APPLY = args.includes('--apply')
const WRITE_CANDIDATES = args.includes('--candidates')

if (!FILE) {
  console.error('usage: import-userlist.mjs <file.json> [--candidates] [--apply]')
  process.exit(1)
}

/**
 * Names that are probably not a farm you can drive to.
 *
 * A supermarket, a salad chain and a four-bedroom holiday rental all turned up
 * in the first list this ran against, because "apple" matches a lot of things.
 * This does NOT drop them — it routes them to the report with a reason, so a
 * person decides. Being wrong in that direction costs somebody thirty seconds
 * of reading; being wrong the other way puts a kosher supermarket on a map of
 * orchards.
 *
 * Farmers' markets are on the list for the reason the About page already gives
 * about greenmarket stalls: a stall is a fact about the grower who drives to
 * it, not about the corner, and somebody looking for a Saturday out does not
 * want them in the results.
 */
const PROBABLY_NOT_A_FARM =
  /salad|kosher|discount|supermarket|candy|house and gardens|urban farm|milk \+|market inc|bedroom|farmers.? market|caterers|chamber|creamery|\binn\b/i

/*
 * Deliberately NOT on that list: winery, distillery, cidery, brewery, taproom.
 *
 * The first version of this caught all five and flagged Warwick Valley Winery,
 * Distillery & Orchard, Applewood Winery, Weed Orchards & Winery and Apple
 * Dave's Distillery as "not an orchard" — four real places, one of which is
 * literally called an orchard. `craft_cider` is an existing filter on this map,
 * described to visitors as "Cidery, taproom or distillery", and 2 Way Brewing
 * Company is already a row. A tempting word is not the same as a wrong place.
 */

const listings = JSON.parse(readFileSync(FILE, 'utf8'))
process.stderr.write(`read ${listings.length} listings from ${FILE}\n`)

const existing = await loadRoster(ROOT, 'import-userlist')
process.stderr.write(`comparing against ${existing.length} orchards we already have\n`)

const clean = []
const unclear = []
let alreadyKnown = 0
let outsideBox = 0

/*
 * Accepted listings join `existing` as we go, so two entries for the same farm
 * in one file are caught by the same rule that catches a duplicate of a row we
 * already hold. The first list had four pins for Ochs Orchard.
 */
const pool = [...existing]

for (const l of listings) {
  const base = {
    name: (l.name ?? '').trim(),
    address: l.address ?? null,
    town: l.town ?? null,
    state: l.state ?? null,
    zip: l.zip ?? null,
    phone: l.phone ?? null,
    website: normaliseUrl(l.website),
    source: FILE,
    lat: l.lat,
    lng: l.lng,
  }

  if (!base.name) { unclear.push({ ...base, reason: 'no name' }); continue }
  if (!Number.isFinite(l.lat) || !Number.isFinite(l.lng)) {
    unclear.push({ ...base, reason: 'no coordinates' })
    continue
  }
  if (!inBox(l.lat, l.lng)) { outsideBox++; continue }

  if (PROBABLY_NOT_A_FARM.test(base.name)) {
    unclear.push({ ...base, reason: 'the name does not read like an orchard' })
    continue
  }

  const importId = slugify(base.name, base.town)
  const hit = matchExisting(base, { lat: l.lat, lng: l.lng }, pool, {
    source: 'user',
    importId,
  })
  if (hit?.quiet) { alreadyKnown++; continue }
  if (hit) {
    unclear.push({ ...base, reason: hit.reason, duplicate_of: hit.duplicate_of })
    continue
  }

  const entry = { ...base, import_id: importId }
  clean.push(entry)
  // So the next listing sees this one.
  pool.push({ slug: importId, name: base.name, lat: l.lat, lng: l.lng,
              import_source: 'user', import_id: importId, status: 'active' })
}

const byReason = {}
for (const u of unclear) byReason[u.reason.split(':')[0]] = (byReason[u.reason.split(':')[0]] ?? 0) + 1

process.stderr.write(`
${listings.length} listings

  ready to add:  ${clean.length}
  need a look:   ${unclear.length}
  already ours:  ${alreadyKnown}
  outside the day-trip box: ${outsideBox}
${Object.entries(byReason).map(([k, v]) => `    ${v}  ${k}`).join('\n')}

  with a website: ${clean.filter((c) => c.website).length}
`)

for (const c of clean.slice(0, 15)) {
  process.stderr.write(`    ${c.name} — ${c.town}, ${c.state}\n`)
}
if (clean.length > 15) process.stderr.write(`    … and ${clean.length - 15} more\n`)

if (WRITE_CANDIDATES) {
  mkdirSync(CANDIDATES, { recursive: true })
  writeFileSync(
    join(CANDIDATES, 'userlist.json'),
    JSON.stringify({ source: FILE, fetched_at: new Date().toISOString(), clean, unclear }, null, 2) + '\n',
  )
  process.stderr.write('\nwrote scripts/.candidates/userlist.json\n')
}

if (APPLY) {
  const taken = new Set(existing.map((o) => o.slug))
  const rows = clean.map((c) => {
    const slug = freeSlug(c.import_id, taken, (c.state ?? 'x').toLowerCase())
    taken.add(slug)
    return {
      slug,
      name: c.name,
      lat: Number(c.lat.toFixed(6)),
      lng: Number(c.lng.toFixed(6)),
      address: c.address,
      town: c.town,
      state: c.state,
      zip: c.zip,
      phone: c.phone,
      website: c.website,
      /*
       * No tags. The list says a farm exists and how to reach it; what it does
       * is for the crawler to read off the farm's own site. Guessing
       * pick_your_own from a name containing "Orchard" is the inference that
       * puts a family in a car.
       */
      tags: [],
      position_precision: null,
      import_source: 'user',
      import_id: c.import_id,
      import_licence: 'user-submitted',
    }
  })

  const { inserted, skipped } = await addOrchards(ROOT, 'import-userlist', rows)
  process.stderr.write(`\nadded ${inserted.length} orchards to the database\n`)
  for (const slug of inserted.slice(0, 20)) process.stderr.write(`    + ${slug}\n`)
  if (inserted.length > 20) process.stderr.write(`    … and ${inserted.length - 20} more\n`)
  if (skipped.length > 0) {
    process.stderr.write(`\n${skipped.length} already present, which the checks above should have caught\n`)
  }
  if (inserted.length > 0) {
    process.stderr.write('\nrun `pnpm db:export -- --apply` to publish them to the site\n')
  }
} else if (!WRITE_CANDIDATES) {
  process.stderr.write('\ndry run — --apply to add them, --candidates to write the unclear ones\n')
}
