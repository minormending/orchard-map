#!/usr/bin/env node
/**
 * Pennsylvania, from PA Preferred.
 *
 *   node scripts/import-papreferred.mjs              dry run
 *   node scripts/import-papreferred.mjs --apply      merge the clean ones
 *   node scripts/import-papreferred.mjs --candidates write the unclear ones
 *
 * Pennsylvania has no working apple marketing board — pennsylvaniaapples.org
 * is an abandoned default WordPress install still showing "Hello world!" from
 * 2021. So this uses PA Preferred, the state Department of Agriculture's
 * branding programme, whose member directory can be searched by product.
 *
 * The site serves no robots.txt at all, so nothing is disallowed. The search
 * is an ASP.NET form with an anti-forgery token, which this obtains the way a
 * browser does: GET the page, keep the cookie, post the token back. That token
 * protects the site's users from cross-site request forgery; it is not an
 * access control against readers, and nothing here bypasses a login, a paywall
 * or a CAPTCHA.
 *
 * NOT Google Maps, Places, or any of the third-party u-pick aggregators. Maps'
 * terms prohibit extracting Content and building a substitute for it. The
 * aggregators are a subtler version of the same objection: their compiled
 * listings are their product, and copying one to build a competing directory
 * is the thing this project would not want done to it. Every row here carries
 * a licence published on the About page.
 *
 * WHAT COMES BACK IS STATEWIDE, and most of Pennsylvania is nowhere near New
 * York. Adams County is the state's apple capital and sits around -77.2°,
 * outside the day-trip box; the part of PA within reach is the north-east —
 * the Lehigh Valley, Bucks County, the Pocono foothills. The box filter does
 * that work, and the dry run reports how many were dropped for it so the
 * number never looks like a parsing failure.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inBox, matchExisting, slugify, normaliseUrl } from './lib/directory.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src', 'data', 'orchards.json')
const CANDIDATES = join(ROOT, 'scripts', '.candidates')
const UA = 'orchard-map/0.1 (+https://github.com/minormending/orchard-map; polite)'
const HOST = 'https://papreferred.com'

const APPLY = process.argv.includes('--apply')
const WRITE_CANDIDATES = process.argv.includes('--candidates')

// --- the search -------------------------------------------------------------

const cookies = new Map()
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')

function keepCookies(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const i = pair.indexOf('=')
    if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function token() {
  const res = await fetch(`${HOST}/search`, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(45_000),
  })
  if (!res.ok) throw new Error(`/search answered ${res.status}`)
  keepCookies(res)
  const html = await res.text()
  const m = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(html)
  if (!m) throw new Error('no anti-forgery token on /search — the form has changed')
  return m[1]
}

async function searchPage(tok, page) {
  const body = new URLSearchParams({
    SearchType: 'Products',
    SearchTerms: 'Apples',
    UserLatitude: '', UserLongitude: '',
    HiddenSearchTerms: '', ProductImageSearchTerm: '', BusinessTypeButtonSearchTerm: '',
    ResetSearchFilter: 'False',
    /*
     * CurrentPage is the control; PreviousPage is where you came from.
     * Driving PreviousPage alone returns page one every time, which looked
     * like eight successful requests and ten members — the same ten, eight
     * times over. The response says "Showing 1 to 10 of 75 results", and
     * comparing those two numbers is what surfaced it.
     */
    PreviousPage: String(Math.max(1, page - 1)),
    CurrentPage: String(page),
    __RequestVerificationToken: tok,
  })
  const res = await fetch(`${HOST}/api/Search`, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded',
      'x-requested-with': 'XMLHttpRequest',
      cookie: cookieHeader(),
    },
    body,
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`/api/Search page ${page} answered ${res.status}`)
  keepCookies(res)
  return res.text()
}

// --- parsing ----------------------------------------------------------------

const decode = (s) =>
  String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
    .replace(/&#39;|&#039;|&rsquo;|&#8217;/g, "'")
    .trim()

const strip = (s) => decode(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

/**
 * Each member is a card, and the card carries its own data attributes:
 *
 *   data-company-name / -address1 / -city / -state / -zip / -phone
 *   data-gis-location="POINT (-79.29584 41.57385)"
 *
 * That last one is the find. The site publishes each member's coordinates, so
 * this importer does no geocoding at all — no Photon calls, no rural-route
 * failures, no town-centre fallbacks putting two farms on one point. The first
 * version of this parser read the address out of the Google directions link
 * instead and got "15255" for every farm, because the link is HTML-encoded and
 * `&#x2B;` (a plus sign) contains an ampersand, which truncated the match.
 * The attributes were there the whole time.
 */
const attr = (chunk, name) => {
  const m = new RegExp(`data-${name}="([^"]*)"`).exec(chunk)
  return m ? decode(m[1]) || null : null
}

function parseMembers(html) {
  const out = []
  const chunks = html.split(/<div class="card card-search-result"/).slice(1)

  for (const chunk of chunks) {
    const name = attr(chunk, 'company-name')
    if (!name) continue

    // WKT is (longitude latitude) — the opposite order to how it is written
    // everywhere else in this repo.
    const point = /POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/.exec(attr(chunk, 'gis-location') ?? '')
    const lng = point ? Number(point[1]) : null
    const lat = point ? Number(point[2]) : null

    const products = (() => {
      const m = /<div class="member-location-member-products">([\s\S]*?)<\/div>/.exec(chunk)
      return m ? strip(m[1]).split(',').map((x) => x.trim()).filter(Boolean) : []
    })()

    const site = /href="(https?:\/\/(?!www\.google\.com)[^"]+)"/.exec(chunk)

    out.push({
      name,
      address: [attr(chunk, 'company-address1'), attr(chunk, 'company-address2')]
        .filter(Boolean).join(', ') || null,
      town: attr(chunk, 'company-city'),
      state: attr(chunk, 'company-state') ?? 'PA',
      zip: attr(chunk, 'company-zip'),
      phone: attr(chunk, 'company-phone'),
      lat, lng,
      products,
      website: normaliseUrl(site ? decode(site[1].replace(/<wbr\s*\/?>/g, '')) : null),
    })
  }
  return out
}

// --- run --------------------------------------------------------------------

process.stderr.write('searching PA Preferred for apple growers\n')
const tok = await token()
await sleep(2000)

const seen = new Map()
let total = null
for (let page = 1; page <= 20; page++) {
  const html = await searchPage(tok, page)
  const members = parseMembers(html)
  if (total === null) {
    const m = /Showing\s+\d+\s+to\s+\d+\s+of\s+(\d+)\s+results/i.exec(html)
    total = m ? Number(m[1]) : null
    if (total) process.stderr.write(`  ${total} members sell apples statewide\n`)
  }
  const before = seen.size
  for (const m of members) seen.set(`${m.name}|${m.town}`, m)
  process.stderr.write(`  page ${page}: ${members.length} members, ${seen.size - before} new\n`)
  // A page that adds nothing means pagination is not working, not that the
  // list has ended — stop rather than hammer the same page twenty times.
  if (members.length === 0 || seen.size === before) break
  if (total && seen.size >= total) break
  await sleep(2500)
}

// The product search returns anyone who sells apples, including beekeepers and
// farm shops that buy them in. Requiring "Apples" in the products list is the
// cheapest filter that means anything.
const growers = [...seen.values()].filter((m) =>
  m.products.some((p) => /^apples?$/i.test(p)))

process.stderr.write(
  `\n${seen.size} members returned, ${growers.length} listing apples as a product\n`,
)

const existing = JSON.parse(readFileSync(OUT, 'utf8'))
const clean = []
const unclear = []
let outsideBox = 0
let alreadyKnown = 0

for (const g of growers) {
  const base = { ...g, source: `${HOST}/search`, tags: [] }

  if (!Number.isFinite(g.lat) || !Number.isFinite(g.lng)) {
    unclear.push({ ...base, reason: 'the listing carries no coordinates' })
    continue
  }
  if (!inBox(g.lat, g.lng)) { outsideBox++; continue }

  /*
   * One rule, shared with Connecticut. This used to be a hand copy of what
   * place() does, because the site publishes coordinates and so there is no
   * geocoding to share — and the copy drifted exactly as the shared file's
   * header predicted it would.
   */
  const hit = matchExisting(g, g, existing, {
    source: 'papreferred',
    importId: slugify(g.name, g.town),
  })
  if (hit?.quiet) { alreadyKnown++; continue }
  if (hit) {
    unclear.push({ ...base, reason: hit.reason, duplicate_of: hit.duplicate_of })
    continue
  }
  clean.push(base)
}

process.stderr.write(`
  ready to add:  ${clean.length}
  need a look:   ${unclear.length}
  already ours:  ${alreadyKnown}
  outside the day-trip box: ${outsideBox}
    (most of Pennsylvania is — Adams County, the state's apple capital, is
     about 200 miles from New York City)

  with a website: ${clean.filter((c) => c.website).length}
`)

for (const c of clean.slice(0, 12)) {
  process.stderr.write(`    ${c.name} — ${c.town}\n`)
}
for (const u of unclear) {
  process.stderr.write(`    ? ${u.name} — ${u.town}: ${u.reason}\n`)
}

if (WRITE_CANDIDATES) {
  mkdirSync(CANDIDATES, { recursive: true })
  writeFileSync(
    join(CANDIDATES, 'papreferred.json'),
    JSON.stringify({ source: `${HOST}/search`, fetched_at: new Date().toISOString(), clean, unclear }, null, 2) + '\n',
  )
  process.stderr.write('\nwrote scripts/.candidates/papreferred.json\n')
}

if (APPLY) {
  const bySlug = new Set(existing.map((o) => o.slug))
  const added = clean.map((c) => {
    let slug = slugify(c.name, c.town)
    if (bySlug.has(slug)) slug = `${slug}-pa`
    bySlug.add(slug)
    return {
      id: `papreferred-${slug}`,
      slug,
      name: c.name,
      lat: Number(c.lat.toFixed(6)),
      lng: Number(c.lng.toFixed(6)),
      address: c.address,
      town: c.town,
      state: 'PA',
      zip: c.zip,
      phone: null,
      website: c.website,
      // PA Preferred says what a member sells, not whether you may pick it
      // yourself. Inferring pick_your_own from "Apples" would be a guess that
      // puts a family in a car.
      tags: [],
      import_source: 'papreferred',
      import_id: slug,
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
