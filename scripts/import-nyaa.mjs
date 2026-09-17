#!/usr/bin/env node
/**
 * The roster, from the New York Apple Association.
 *
 *   node scripts/import-nyaa.mjs            dry run — says what it would write
 *   node scripts/import-nyaa.mjs --apply    write src/data/orchards.json
 *
 * Why this source and not OpenStreetMap: OSM has the pins but not the
 * attributes. Measured over the day-trip bounding box, `self_harvesting=yes` —
 * the OSM tag for pick-your-own — appears on exactly ONE feature in the whole
 * region, and only 82 `shop=farm` features carry a website. The website is the
 * scraper's only input, so a roster without one is a roster of dead ends.
 *
 * applesfromny.com is the state trade association. Its robots.txt is
 * `Disallow:` — empty, meaning everything is permitted — and it runs WordPress
 * with a WP Store Locator behind it. Two endpoints, joined on the store id:
 *
 *   admin-ajax.php?action=store_search   name, address, lat/lng, phone, url
 *   wp-json/wp/v2/wpsl_stores            the same ids, plus categories
 *
 * The locator caps every response at 25 rows regardless of what you ask for,
 * so coordinates come from an adaptive sweep: query a coarse grid, and
 * subdivide any cell that comes back saturated. That costs a few hundred
 * requests over the whole state rather than a few thousand, which matters when
 * the host is a trade association rather than a CDN.
 *
 * LICENCE: the association states none. That is ambiguity rather than
 * permission, so every row records where it came from and `import_licence` is
 * written as 'unstated' rather than left blank or guessed at. Withdrawing the
 * source is then one filter, and the ambiguity travels with the rows instead
 * of living in somebody's memory.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src', 'data', 'orchards.json')
const CACHE = join(ROOT, 'scripts', '.cache')

const UA = 'orchard-map/0.1 (+https://github.com/minormending/orchard-map; polite)'
const HOST = 'https://www.applesfromny.com'
const APPLY = process.argv.includes('--apply')
const FRESH = process.argv.includes('--fresh')

/**
 * The day-trip radius, as a box. Roughly 2.5 hours from New York City:
 * Hudson Valley, Catskills, Long Island, northern NJ, western CT, NE PA.
 * The association lists NY only, so in practice this clips the roster to its
 * southern half — which is the half a NYC day trip can reach.
 */
const BOX = { south: 40.40, west: -76.50, north: 42.90, east: -71.80 }

/** Taxonomy term ids, read from the live API and pinned here so a silent
 *  renumbering upstream shows up as a mismatch rather than as wrong filters. */
const CATEGORIES = {
  18: 'pick_your_own',
  19: 'heirloom',
  20: 'farm_market',
  21: 'gift_boxes',
  22: 'greenmarket',
  23: 'craft_cider',
  24: 'fresh_cider',
}

// --- polite plumbing -------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let lastHit = 0

async function get(url, { json = true } = {}) {
  // One request at a time, never less than a second apart. This is a trade
  // association's WordPress box, not an API built for us.
  const due = lastHit + 1100 - Date.now()
  if (due > 0) await sleep(due)
  lastHit = Date.now()

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json,*/*' },
        signal: AbortSignal.timeout(30_000),
      })
      if (res.status === 429 || res.status >= 500) {
        await sleep(3000 * (attempt + 1))
        continue
      }
      if (!res.ok) return null
      return json ? await res.json() : await res.text()
    } catch {
      await sleep(2000 * (attempt + 1))
    }
  }
  return null
}

function cached(name, produce) {
  mkdirSync(CACHE, { recursive: true })
  const path = join(CACHE, name)
  if (!FRESH && existsSync(path)) {
    process.stderr.write(`  (cached) ${name}\n`)
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  return produce().then((value) => {
    writeFileSync(path, JSON.stringify(value))
    return value
  })
}

// --- the sweep -------------------------------------------------------------

const SATURATED = 25 // what the locator returns when it is holding back

/**
 * Walk the box, subdividing wherever the cap is hit.
 *
 * A cell that returns exactly 25 is a cell that is probably hiding more, so it
 * is split into four and each quarter is asked again. A cell that returns
 * fewer than 25 is complete and is not touched again.
 */
async function sweep(box, found, depth = 0) {
  const lat = (box.south + box.north) / 2
  const lng = (box.west + box.east) / 2
  // Cover the cell's diagonal, in miles, with a little overlap.
  const dLat = (box.north - box.south) * 69
  const dLng = (box.east - box.west) * 52 // ~52 mi/deg at 41°N
  const radius = Math.ceil(Math.hypot(dLat, dLng) / 2) + 2

  const url = `${HOST}/wp-admin/admin-ajax.php?action=store_search`
    + `&lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}`
    + `&max_results=25&search_radius=${radius}`

  const rows = await get(url)
  const n = Array.isArray(rows) ? rows.length : 0
  const pad = '  '.repeat(depth)
  process.stderr.write(`${pad}[${box.south.toFixed(2)},${box.west.toFixed(2)}] r=${radius}mi -> ${n}\n`)

  for (const r of rows ?? []) found.set(String(r.id), r)

  // Stop subdividing once a cell is smaller than about three miles: below that
  // a saturated cell means 25 genuinely co-located stores, not a hidden tail.
  if (n >= SATURATED && depth < 6 && box.north - box.south > 0.04) {
    const midLat = (box.south + box.north) / 2
    const midLng = (box.west + box.east) / 2
    await sweep({ south: box.south, north: midLat, west: box.west, east: midLng }, found, depth + 1)
    await sweep({ south: box.south, north: midLat, west: midLng, east: box.east }, found, depth + 1)
    await sweep({ south: midLat, north: box.north, west: box.west, east: midLng }, found, depth + 1)
    await sweep({ south: midLat, north: box.north, west: midLng, east: box.east }, found, depth + 1)
  }
}

/** Categories live on the REST records, which the locator does not return. */
async function fetchCategories() {
  const byId = new Map()
  for (let page = 1; page <= 10; page++) {
    const rows = await get(`${HOST}/wp-json/wp/v2/wpsl_stores?per_page=100&page=${page}`)
    if (!Array.isArray(rows) || rows.length === 0) break
    for (const r of rows) {
      byId.set(String(r.id), {
        name: decodeEntities(r.title?.rendered ?? ''),
        terms: r.wpsl_store_category ?? [],
        link: r.link ?? null,
      })
    }
    if (rows.length < 100) break
  }
  return [...byId.entries()]
}

// --- shaping ---------------------------------------------------------------

const decodeEntities = (s) =>
  String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()

function slugify(name, town) {
  const base = `${name} ${town ?? ''}`
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base.slice(0, 70)
}

const inBox = (lat, lng) =>
  lat >= BOX.south && lat <= BOX.north && lng >= BOX.west && lng <= BOX.east

function normaliseUrl(raw) {
  if (!raw) return null
  let u = String(raw).trim()
  if (!u) return null
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`
  try {
    const parsed = new URL(u)
    // Facebook pages are common in this dataset and are useless to the
    // scraper: they render nothing without a session and forbid crawling.
    if (/(^|\.)facebook\.com$/i.test(parsed.hostname)) return null
    return parsed.href.replace(/\/$/, '')
  } catch {
    return null
  }
}

/** The locator holds both 'NY' and 'New York'. One of them is a filter bug. */
const STATE_CODES = {
  'new york': 'NY', 'new jersey': 'NJ', 'connecticut': 'CT',
  'pennsylvania': 'PA', 'massachusetts': 'MA', 'vermont': 'VT',
}
function normaliseState(raw) {
  const v = String(raw ?? '').trim()
  if (!v) return null
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase()
  return STATE_CODES[v.toLowerCase()] ?? v
}

function toOrchard(row, meta) {
  const lat = Number(row.lat)
  const lng = Number(row.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null

  const name = decodeEntities(meta?.name || row.store || '')
  if (!name) return null

  const tags = (meta?.terms ?? [])
    .map((t) => CATEGORIES[t])
    .filter(Boolean)
    .sort()

  const town = decodeEntities(row.city ?? '')

  /**
   * A greenmarket is a folding table on a Manhattan pavement. The association
   * lists them because New York growers sell at them, which is a fact about
   * the grower rather than about the corner of 175th Street — and somebody
   * looking for an orchard to drive to on Saturday does not want 51 street
   * stalls in their results.
   *
   * Dropped only when greenmarket is ALL a record is. Fishkill Farms and
   * Prospect Hill Orchards are real farms that also sell in the city, and they
   * stay, because there the greenmarket tag sits alongside pick_your_own.
   */
  if (tags.length === 1 && tags[0] === 'greenmarket') return null

  return {
    id: `nyaa-${row.id}`,
    slug: slugify(name, town),
    name,
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
    address: [decodeEntities(row.address ?? ''), decodeEntities(row.address2 ?? '')]
      .filter(Boolean).join(', ') || null,
    town: town || null,
    state: normaliseState(row.state),
    zip: (row.zip ?? '').trim() || null,
    phone: (row.phone ?? '').trim() || null,
    website: normaliseUrl(row.url),
    /** What the association says this place does. The only attributes we have
     *  until the scraper runs — everything richer is null, which means nobody
     *  has said, not false. */
    tags,
    // Provenance travels with the row. See the LICENCE note in the header.
    import_source: 'nyaa',
    import_id: String(row.id),
    import_licence: 'unstated',
    imported_at: new Date().toISOString().slice(0, 10),
  }
}

// --- main ------------------------------------------------------------------

const found = new Map()
process.stderr.write('sweeping the store locator\n')
const swept = await cached('nyaa-stores.json', async () => {
  await sweep(BOX, found)
  return [...found.values()]
})
for (const r of swept) found.set(String(r.id), r)

process.stderr.write(`\nfetching categories\n`)
const catPairs = await cached('nyaa-categories.json', fetchCategories)
const categories = new Map(catPairs)

const orchards = []
const skipped = { outside: 0, nocoord: 0, dropped: 0 }

for (const [id, row] of found) {
  const lat = Number(row.lat)
  const lng = Number(row.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) { skipped.nocoord++; continue }
  if (!inBox(lat, lng)) { skipped.outside++; continue }
  const o = toOrchard(row, categories.get(id))
  if (!o) { skipped.dropped++; continue }
  orchards.push(o)
}

// Stable order, so a re-import produces a readable diff rather than a reshuffle.
orchards.sort((a, b) => a.slug.localeCompare(b.slug))

// A slug collision would make two orchards share a URL. Disambiguate with the
// import id rather than dropping one.
const seen = new Map()
for (const o of orchards) {
  const n = (seen.get(o.slug) ?? 0) + 1
  seen.set(o.slug, n)
  if (n > 1) o.slug = `${o.slug}-${o.import_id}`
}

const counts = {}
for (const o of orchards) for (const t of o.tags) counts[t] = (counts[t] ?? 0) + 1

process.stderr.write(`
found ${found.size} stores in and around the sweep box
kept  ${orchards.length} inside the day-trip box
  skipped: ${skipped.outside} outside, ${skipped.nocoord} without coordinates, ${skipped.dropped} greenmarket stalls or unnamed
  with a website: ${orchards.filter((o) => o.website).length}
  by tag:
${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `    ${String(v).padStart(4)}  ${k}`).join('\n')}
`)

if (!APPLY) {
  process.stderr.write('\ndry run — pass --apply to write src/data/orchards.json\n')
} else {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(orchards, null, 2) + '\n')
  process.stderr.write(`\nwrote ${OUT}\n`)
}
