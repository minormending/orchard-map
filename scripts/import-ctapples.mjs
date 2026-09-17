#!/usr/bin/env node
/**
 * Connecticut, from the Connecticut Apple Marketing Board.
 *
 *   node scripts/import-ctapples.mjs              dry run
 *   node scripts/import-ctapples.mjs --apply      merge the clean ones
 *   node scripts/import-ctapples.mjs --candidates write the unclear ones for review
 *
 * ctapples.org is Connecticut's direct analogue of applesfromny.com — the
 * state's apple marketing board, listing its member orchards by county. Its
 * robots.txt permits everything but /wp-admin/, and the directory page is
 * server-rendered, so this is one polite request rather than a crawl.
 *
 * WHAT THIS IS NOT: Google Maps. Maps' terms prohibit extracting Content and
 * prohibit using it to build a substitute for Maps, which is exactly what a
 * public orchard directory assembled from its listings would be. Every row in
 * this project carries a licence that is published on the About page; a Google
 * row would have nowhere honest to sit. This source can be named.
 *
 * Two false starts worth recording, because both cost time:
 *
 *   ctgrown.org looked like the obvious source — it is the state's CT Grown
 *   brand site and its robots.txt is wide open. It has no farm directory at
 *   all: its custom post types are `winery` and a calendar. Wrong site.
 *
 *   ctapples.org/pick-your-own 404s, and WordPress serves 404s with a full
 *   200-shaped page. 133KB of "content" that was entirely a not-found page,
 *   analysed for several minutes before the word "Ooops" turned up in the
 *   extracted text. The directory is at /find-a-farm/.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// Placement — geocoding, the box, and the duplicate rules — is shared with the
// Pennsylvania importer. Those rules took several rounds to get right and a
// second copy would be a second place for them to drift.
import { place, slugify, normaliseUrl, BOX } from './lib/directory.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src', 'data', 'orchards.json')
const CANDIDATES = join(ROOT, 'scripts', '.candidates')
const UA = 'orchard-map/0.1 (+https://github.com/minormending/orchard-map; polite)'
const SOURCE = 'https://ctapples.org/find-a-farm/'

const APPLY = process.argv.includes('--apply')
const WRITE_CANDIDATES = process.argv.includes('--candidates')

/** Their vocabulary, mapped onto ours. Wholesale is a fact about their trade,
 *  not about a visit, so it earns no tag. */
const TAGS = {
  'pick-your-own': 'pick_your_own',
  cider: 'fresh_cider',
  retail: 'farm_market',
}

// --- fetch ------------------------------------------------------------------

const res = await fetch(SOURCE, {
  headers: { 'user-agent': UA },
  signal: AbortSignal.timeout(45_000),
})
if (!res.ok) {
  console.error(`${SOURCE} answered ${res.status}`)
  process.exit(1)
}
const html = await res.text()

// --- parse ------------------------------------------------------------------

/**
 * Split into lines, and mind U+2028.
 *
 * The page uses LINE SEPARATOR inside paragraphs, so a naive split on \n glues
 * a farm's town, phone, website and Facebook page into one string and the
 * record falls apart. Splitting on both is the whole trick.
 */
function textLines(raw) {
  let t = raw
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|td)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&rsquo;|&#039;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  return t
    .split(/[\n\u2028\u2029]/)
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
}

const lines = textLines(html)

const TOWN_ZIP = /^(.+?),\s*CT\s+(\d{5})(?:-\d{4})?$/
const PHONE = /^\(?(\d{3})\)?[-.\s]?(\d{3})[-.](\d{4})$/
/* "New Haven County" and "New London County" are two words before "County",
   and a one-word pattern silently absorbed the heading into the next farm's
   name — "New Haven County Bishop's Orchards". */
const COUNTY = /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+County$/
const CATEGORIES = /^[A-Za-z-]+(\s*\|\s*[A-Za-z-]+)+$/

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i
const URLISH = /^(www\.|https?:\/\/)/i

/**
 * A line that belongs to the record ABOVE it, not the one below.
 *
 * Deliberately looser than the patterns used to EXTRACT those fields. Bishop's
 * Orchards lists "203-458-PICK (7425)" — a vanity number a strict phone
 * pattern rejects, so the line was read as part of the next farm's name and
 * carried its email and Facebook page along with it. For deciding where a
 * record ends, "looks like contact information anywhere in the line" is the
 * right test; for deciding what a phone number IS, it is not.
 */
/* Area code AND exchange, not just three digits: the looser version matched
   "278 Leavenworth Road" and swallowed every street address on the page,
   taking the listing count from 43 to 15. A house number is three digits and
   a word; a phone number is three digits, a separator and three more. */
const CONTACTISH = /^\(?\d{3}\)?[-.\s]?\d{3}[-.]|@|www\.|https?:\/\//i
const isTail = (l) => CONTACTISH.test(l) || CATEGORIES.test(l)

/*
 * Records are delimited by their "Town, CT ZIP" line and nothing else — there
 * is no wrapper element to key on. So: find every anchor, and treat the span
 * between one anchor and the next as that record's tail (phone, email, site,
 * categories) followed by the NEXT record's head (name, street).
 *
 * The first attempt walked backwards from each anchor collecting up to four
 * lines, which quietly attached the previous farm's phone number and email to
 * the next farm's name — "860-659-0294 donderoorchards@cox.net Deercrest
 * Farm". Splitting the span on "is this a contact line" is what separates them.
 */
const anchors = []
for (let i = 0; i < lines.length; i++) {
  if (TOWN_ZIP.test(lines[i])) anchors.push(i)
}

const records = []
let county = null

for (let k = 0; k < anchors.length; k++) {
  const i = anchors[k]
  const m = TOWN_ZIP.exec(lines[i])
  const town = m[1].trim()
  const zip = m[2]

  // Head: the lines between the previous anchor's tail and this anchor.
  const headFrom = k === 0 ? 0 : anchors[k - 1] + 1
  const head = []
  for (let j = headFrom; j < i; j++) {
    const l = lines[j]
    const c = COUNTY.exec(l)
    if (c) { county = c[1]; head.length = 0; continue }
    if (isTail(l)) { head.length = 0; continue }
    head.push(l)
  }
  if (head.length === 0) continue

  const address = head.length > 1 ? head[head.length - 1] : null
  const name = (head.length > 1 ? head.slice(0, -1) : head)
    .join(' ').replace(/\s+/g, ' ').trim()

  // Tail: from this anchor to the next, taking only contact-shaped lines.
  const tailTo = k + 1 < anchors.length ? anchors[k + 1] : lines.length
  let phone = null
  let website = null
  let tags = []
  for (let j = i + 1; j < tailTo; j++) {
    const l = lines[j]
    if (COUNTY.test(l)) break
    if (!phone && PHONE.test(l)) phone = l
    else if (!website && URLISH.test(l) && !/facebook\.com/i.test(l)) website = l
    else if (CATEGORIES.test(l)) {
      tags = l.split('|').map((x) => TAGS[x.trim().toLowerCase()]).filter(Boolean)
    }
  }

  records.push({ county, name, address, town, zip, phone, website, tags })
}

process.stderr.write(`parsed ${records.length} listings from ${SOURCE}\n`)

// --- shape ------------------------------------------------------------------

const existing = JSON.parse(readFileSync(OUT, 'utf8'))

const clean = []
const unclear = []
let alreadyKnown = 0

process.stderr.write('geocoding (one a second)\n')

for (const r of records) {
  const base = {
    name: r.name,
    town: r.town,
    state: 'CT',
    zip: r.zip,
    address: r.address,
    phone: r.phone,
    website: normaliseUrl(r.website),
    tags: r.tags,
    county: r.county,
    source: SOURCE,
  }

  const at = await place(
    { name: r.name, address: r.address, town: r.town, state: 'CT', zip: r.zip },
    existing,
    { userAgent: UA, source: 'ctapples' },
  )
  if (at.quiet) { alreadyKnown++; continue }
  if (!at.ok) {
    unclear.push({ ...base, lat: at.lat, lng: at.lng, reason: at.reason, duplicate_of: at.duplicate_of })
    continue
  }
  clean.push({ ...base, ...at })
}

// --- report -----------------------------------------------------------------

const byReason = {}
for (const u of unclear) byReason[u.reason.split(':')[0]] = (byReason[u.reason.split(':')[0]] ?? 0) + 1

process.stderr.write(`
${records.length} listings

  ready to add:  ${clean.length}
  need a look:   ${unclear.length}
  already ours:  ${alreadyKnown}
${Object.entries(byReason).map(([k, v]) => `    ${v}  ${k}`).join('\n')}

  with a website: ${clean.filter((c) => c.website).length}
  pick-your-own:  ${clean.filter((c) => c.tags.includes('pick_your_own')).length}
`)

for (const c of clean.slice(0, 10)) {
  process.stderr.write(`    ${c.name} — ${c.town} [${c.tags.join(', ') || 'no tags'}]\n`)
}

if (WRITE_CANDIDATES) {
  mkdirSync(CANDIDATES, { recursive: true })
  writeFileSync(
    join(CANDIDATES, 'ctapples.json'),
    JSON.stringify({ source: SOURCE, fetched_at: new Date().toISOString(), clean, unclear }, null, 2) + '\n',
  )
  process.stderr.write(`\nwrote scripts/.candidates/ctapples.json\n`)
}

if (APPLY) {
  const bySlug = new Set(existing.map((o) => o.slug))
  const added = clean.map((c) => {
    let slug = slugify(c.name, c.town)
    if (bySlug.has(slug)) slug = `${slug}-ct`
    bySlug.add(slug)
    return {
      id: `ctapples-${slug}`,
      slug,
      name: c.name,
      lat: Number(c.lat.toFixed(6)),
      lng: Number(c.lng.toFixed(6)),
      address: c.address,
      town: c.town,
      state: 'CT',
      zip: c.zip,
      phone: c.phone,
      website: c.website,
      tags: c.tags,
      import_source: 'ctapples',
      import_id: slug,
      // Stated nowhere, like the New York association's. Recorded as ambiguity
      // rather than dressed up as permission.
      import_licence: 'unstated',
      imported_at: new Date().toISOString().slice(0, 10),
    }
  })
  const merged = [...existing, ...added].sort((a, b) => a.slug.localeCompare(b.slug))
  writeFileSync(OUT, JSON.stringify(merged, null, 2) + '\n')
  process.stderr.write(`\nwrote ${merged.length} orchards to ${OUT}\n`)
} else if (!WRITE_CANDIDATES) {
  process.stderr.write('\ndry run — --apply to merge, --candidates to write the unclear ones\n')
}
