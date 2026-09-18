#!/usr/bin/env node
/**
 * OpenStreetMap, as a cross-reference rather than a roster.
 *
 *   node scripts/import-osm.mjs            dry run
 *   node scripts/import-osm.mjs --apply    add the new ones to the database
 *
 * Why this is second and not first: measured over this bounding box, OSM has
 * the pins and not the attributes. `self_harvesting=yes` — the tag that means
 * pick-your-own — appears on ONE feature in the entire region. Of 322 named
 * farm and orchard features, 89 carry a website and 29 mention apples in any
 * tag at all. As a roster it is hopeless.
 *
 * As a cross-reference it earns its place, for two reasons:
 *
 *   It covers New Jersey, Connecticut and Pennsylvania, where the New York
 *   Apple Association by definition does not. Those states' own directories
 *   are not all available to us — see the licence note below.
 *
 *   It has a REAL LICENCE. OSM is ODbL-1.0: attribution and share-alike, which
 *   is a known quantity. The association states no licence at all, which is
 *   ambiguity rather than permission. These rows are the only ones in the
 *   dataset whose terms are not a guess.
 *
 * NEW JERSEY: the state's own directory, findjerseyfresh.com, serves
 * `Disallow: /` — the whole site, to every crawler. That is a clear answer and
 * it is respected: nothing here touches it, and no amount of "it is public
 * data" changes what the site asked for. New Jersey coverage therefore comes
 * from OSM and from people adding farms themselves, and the About page says
 * so rather than letting the thin coverage look like an absence of farms.
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRoster, addOrchards } from './lib/roster.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const UA = 'orchard-map/0.1 (+https://github.com/minormending/orchard-map; polite)'
const APPLY = process.argv.includes('--apply')

const BOX = { south: 40.40, west: -76.50, north: 42.90, east: -71.80 }

const QUERY = `[out:json][timeout:200];
(
  nwr["shop"="farm"]["name"](${BOX.south},${BOX.west},${BOX.north},${BOX.east});
  nwr["landuse"="orchard"]["name"](${BOX.south},${BOX.west},${BOX.north},${BOX.east});
  nwr["craft"="cider"]["name"](${BOX.south},${BOX.west},${BOX.north},${BOX.east});
);
out center tags;`

/**
 * Is this feature plausibly an apple place?
 *
 * OSM's `shop=farm` covers vegetable stands, egg honesty boxes and garden
 * centres. Including all of them would bury 189 checked orchards under a few
 * hundred unchecked shops, which is how a useful map becomes a worse Google
 * Maps. Two ways in: the tags say apple or cider, or the name does.
 */
const APPLEISH_TAG = /apple|cider|orchard/i
const APPLEISH_NAME = /\b(orchard|apple|cider|fruit farm|fruit)\b/i

/**
 * Shops that are not farms.
 *
 * `shop=farm` is used loosely, and the first run pulled in "A & N Fruit Store"
 * and "Luna Brothers Fruit Plaza" — greengrocers in Manhattan. A shop selling
 * apples is not a place to spend Saturday picking them.
 */
const RETAIL_NAME = /\b(store|plaza|stand|deli|grocer|market place|supermarket)\b/i
const FARM_NAME = /\b(orchard|farm|cider|hill|valley|acres)\b/i

function isAppleish(tags) {
  if (tags.craft === 'cider') return true

  /*
   * A bare `landuse=orchard` is LAND, not a business — it is the trees. This
   * was measured while scoping: 569 orchard polygons in this box, 50 with a
   * name, and the named ones are as often "Old Atamont Orchard Field" as a
   * farm anybody can visit. So a polygon has to show some evidence of being
   * open to the public before it earns a pin.
   */
  if (tags.landuse === 'orchard') {
    const isBusiness = tags.website || tags['contact:website'] || tags.phone ||
      tags['contact:phone'] || tags.opening_hours || tags.shop
    if (!isBusiness) return false
  }

  if (RETAIL_NAME.test(tags.name ?? '') && !FARM_NAME.test(tags.name ?? '')) return false

  for (const [key, value] of Object.entries(tags)) {
    if (/^(produce|crop|trees|cuisine|description|shop|craft)$/.test(key) && APPLEISH_TAG.test(value)) {
      return true
    }
  }
  return APPLEISH_NAME.test(tags.name ?? '')
}

const STATE_FROM_TAG = (tags) => {
  const raw = (tags['addr:state'] ?? '').trim()
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase()
  const named = {
    'new york': 'NY', 'new jersey': 'NJ', connecticut: 'CT',
    pennsylvania: 'PA', massachusetts: 'MA', vermont: 'VT',
  }[raw.toLowerCase()]
  return named ?? null
}

const slugify = (name, town) =>
  `${name} ${town ?? ''}`.toLowerCase().normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)

function normaliseUrl(raw) {
  if (!raw) return null
  let u = String(raw).trim()
  if (!u) return null
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`
  try {
    const parsed = new URL(u)
    if (/(^|\.)facebook\.com$/i.test(parsed.hostname)) return null
    return parsed.href.replace(/\/$/, '')
  } catch {
    return null
  }
}

/** Metres between two points. */
function distanceM(a, b) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

const normName = (s) =>
  String(s ?? '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(the|inc|llc|farms?|orchards?|company|co|and)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

// --- fetch ------------------------------------------------------------------

/*
 * Overpass is a free, shared, volunteer-run service and answers 429 or 504
 * whenever it is busy — which it was, on the second run of this script. That
 * is not a failure worth aborting an import over, so: try the mirrors in turn,
 * back off between attempts, and only give up when all of them are unwell.
 */
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
]

async function overpass(query) {
  for (let attempt = 0; attempt < MIRRORS.length * 2; attempt++) {
    const endpoint = MIRRORS[attempt % MIRRORS.length]
    process.stderr.write(`querying ${new URL(endpoint).host}\n`)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(240_000),
      })
      if (res.ok) return await res.json()
      process.stderr.write(`  answered ${res.status}\n`)
    } catch (err) {
      process.stderr.write(`  ${err.name}\n`)
    }
    // Longer each time round. A busy Overpass stays busy for a while.
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)))
  }
  console.error('every Overpass mirror is unwell — try again later')
  process.exit(1)
}

const { elements = [] } = await overpass(QUERY)

/* From the table, not from the exported file — see lib/roster.mjs. */
const existing = await loadRoster(ROOT, 'import-osm')
const bySlug = new Set(existing.map((o) => o.slug))

const skipped = { notAppleish: 0, noPosition: 0, duplicate: 0, outside: 0 }
const added = []

for (const el of elements) {
  const tags = el.tags ?? {}
  const lat = el.lat ?? el.center?.lat
  const lng = el.lon ?? el.center?.lon

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) { skipped.noPosition++; continue }
  if (lat < BOX.south || lat > BOX.north || lng < BOX.west || lng > BOX.east) {
    skipped.outside++; continue
  }
  if (!isAppleish(tags)) { skipped.notAppleish++; continue }

  const name = (tags.name ?? '').trim()
  if (!name) { skipped.noPosition++; continue }

  /*
   * Deduplication is position-first, name-second, and generous on position.
   * A farm's OSM node is often on its shop door while the association's
   * coordinate is on the road entrance, several hundred metres apart. Adding
   * a second pin for a farm already checked is worse than missing one: it
   * makes the map look careless in exactly the place somebody is deciding
   * whether to trust it.
   */
  const near = existing.find((o) => distanceM(o, { lat, lng }) < 600)
  const sameName = existing.find((o) => {
    const a = normName(o.name)
    const b = normName(name)
    return a.length > 3 && (a === b || a.includes(b) || b.includes(a))
  })
  if (near || sameName) { skipped.duplicate++; continue }

  const town = (tags['addr:city'] ?? '').trim() || null
  let slug = slugify(name, town)
  if (!slug) { skipped.noPosition++; continue }
  if (bySlug.has(slug)) slug = `${slug}-osm${el.id}`
  bySlug.add(slug)

  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ')

  added.push({
    slug,
    name,
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
    address: street || null,
    town,
    state: STATE_FROM_TAG(tags),
    zip: (tags['addr:postcode'] ?? '').trim() || null,
    phone: (tags.phone ?? tags['contact:phone'] ?? '').trim() || null,
    website: normaliseUrl(tags.website ?? tags['contact:website']),
    /*
     * Deliberately empty, not guessed.
     *
     * OSM carries nothing that maps onto the association's categories. It is
     * tempting to infer pick_your_own from a name containing "U-Pick", and
     * that is exactly the sort of inference that puts a family in a car. An
     * empty tag list renders as "No details yet", which is true.
     */
    tags: tags.craft === 'cider' ? ['craft_cider'] : [],
    import_source: 'osm',
    import_id: `${el.type}/${el.id}`,
    // A real licence, unlike everything else in this file's sibling importer.
    // ODbL requires attribution, which the footer already carries for tiles.
    import_licence: 'ODbL-1.0',
  })
}

/*
 * Most OSM features carry no addr:state, and "somewhere in the northeast" is
 * not a useful thing to print under a farm's name. Photon is the geocoder
 * map-kit already uses — no key, built for this, and asked politely one at a
 * time. A failure leaves the state null, which the UI renders as absent.
 */
const STATE_NAMES = {
  'new york': 'NY', 'new jersey': 'NJ', connecticut: 'CT', pennsylvania: 'PA',
  massachusetts: 'MA', vermont: 'VT', 'new hampshire': 'NH', 'rhode island': 'RI',
}

const missing = added.filter((o) => !o.state)
if (missing.length > 0) {
  process.stderr.write(`resolving ${missing.length} states from coordinates\n`)
  for (const o of missing) {
    try {
      const url = new URL('https://photon.komoot.io/reverse')
      url.searchParams.set('lat', String(o.lat))
      url.searchParams.set('lon', String(o.lng))
      const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) })
      if (r.ok) {
        const body = await r.json()
        const state = body?.features?.[0]?.properties?.state
        if (state) o.state = STATE_NAMES[String(state).toLowerCase()] ?? null
      }
    } catch {
      // Leave it null rather than guessing from the bounding box: the NY/CT/MA
      // borders are not straight lines and a wrong state is worse than none.
    }
    await new Promise((r) => setTimeout(r, 1100))
  }
}

const byState = {}
for (const o of added) byState[o.state ?? 'unknown'] = (byState[o.state ?? 'unknown'] ?? 0) + 1

process.stderr.write(`
${elements.length} named features from OSM
  skipped: ${skipped.notAppleish} not apple-related, ${skipped.duplicate} already known,
           ${skipped.outside} outside the box, ${skipped.noPosition} unusable
  new: ${added.length}
  by state: ${Object.entries(byState).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}
  with a website: ${added.filter((o) => o.website).length}
`)

if (!APPLY) {
  for (const o of added.slice(0, 15)) {
    process.stderr.write(`    ${o.name} — ${o.town ?? '?'}, ${o.state ?? '?'}\n`)
  }
  process.stderr.write('\ndry run — pass --apply to add them to the database\n')
} else {
  const { inserted, skipped: already } = await addOrchards(ROOT, 'import-osm', added)
  process.stderr.write(`\nadded ${inserted.length} orchards to the database\n`)
  for (const slug of inserted.slice(0, 15)) process.stderr.write(`    + ${slug}\n`)
  if (inserted.length > 15) process.stderr.write(`    … and ${inserted.length - 15} more\n`)
  if (already.length > 0) {
    process.stderr.write(`\n${already.length} already present, which the duplicate check above should have caught\n`)
  }
  if (inserted.length > 0) {
    process.stderr.write('\nrun `pnpm db:export -- --apply` to publish them to the site\n')
  }
}
