/**
 * The part of importing a state directory that is the same everywhere.
 *
 * Each state publishes its orchards in its own shape — Connecticut as a
 * server-rendered page grouped by county, Pennsylvania behind an ASP.NET
 * search form — so parsing stays in the per-state script. What comes after is
 * identical: give it a position, work out whether we already have it, and sort
 * it into "ready" and "wants a person".
 *
 * These rules are shared rather than copied because they took several rounds
 * to get right, and a second copy would be a second place for them to drift.
 * The name matcher in particular started far too generous: with the generic
 * words stripped, "Beardsley's Cider Mill & Orchard" contains "cider mill",
 * so it matched "The Cider Mill, LLC" — a different farm in a different
 * county.
 */

/** The day-trip radius every importer clips to. */
export const BOX = { south: 40.40, west: -76.50, north: 42.90, east: -71.80 }

export const inBox = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) &&
  lat >= BOX.south && lat <= BOX.north && lng >= BOX.west && lng <= BOX.east

export function distanceM(a, b) {
  const R = 6371000
  const rad = (d) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export const normName = (s) =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(the|inc|llc|farms?|orchards?|company|co|and|s)\b/g, ' ')
    .replace(/\s+/g, ' ').trim()

/**
 * How close two rows must be before a shared name means a shared business.
 *
 * Looser than NEAR_M because a geocoder placing a named farm can land at the
 * end of its drive or at the road it is addressed from, and a name match has
 * already done most of the work. Tighter than the distance between two sites
 * of one business: Bishop's Orchards keeps Guilford and Northford eight miles
 * apart, and those are two rows on this map, correctly.
 */
export const NAME_MATCH_M = 2000

/** How close two rows must be before position alone raises a question. */
export const NEAR_M = 600

/**
 * Are these plausibly the same business, by NAME ALONE?
 *
 * Requiring the FIRST distinctive token to agree is what separates a shared
 * common noun from a shared name. It is not enough on its own, and callers
 * must not use it as though it were: family names are extremely common in
 * this trade, and with the generic words stripped "Rose Orchards" becomes
 * `rose`, which is a prefix of "Rose Hill Farm" -> `rose hill`. Those two are
 * ninety miles apart in different states.
 *
 * Pair it with a distance bound. `matchExisting` is that pairing, and is what
 * importers should call.
 */
export function sameBusiness(a, b) {
  const x = normName(a)
  const y = normName(b)
  if (x.length < 4 || y.length < 4) return false
  if (x === y) return true
  const [fx] = x.split(' ')
  const [fy] = y.split(' ')
  if (fx !== fy) return false
  return x.startsWith(y) || y.startsWith(x)
}

export const slugify = (name, town) =>
  `${name} ${town ?? ''}`.toLowerCase().normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)

export function normaliseUrl(raw) {
  if (!raw) return null
  let u = String(raw).trim().replace(/\s+/g, '')
  if (!u) return null
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`
  try {
    const p = new URL(u)
    // A farm's Facebook page is not the farm's website, and the crawler cannot
    // read one without a session anyway.
    if (/(^|\.)facebook\.com$/i.test(p.hostname)) return null
    return p.href.replace(/\/$/, '')
  } catch { return null }
}

/**
 * Photon: no key, built for autocomplete, and already the geocoder map-kit
 * uses. Nominatim's public instance forbids this.
 *
 * The name fallback matters more than it looks — rural route numbers defeat
 * the geocoder often enough that several of a state's best-known orchards
 * fail on address alone, and those are exactly the ones worth having.
 */
export async function geocode(query, { userAgent, delayMs = 1100 } = {}) {
  const url = new URL('https://photon.komoot.io/api/')
  url.searchParams.set('q', query)
  url.searchParams.set('limit', '1')
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': userAgent },
      signal: AbortSignal.timeout(20_000),
    })
    if (!r.ok) return null
    const f = (await r.json())?.features?.[0]
    if (!f) return null
    return { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }
  } catch {
    return null
  } finally {
    await new Promise((s) => setTimeout(s, delayMs))
  }
}

/**
 * Have we got this listing already, and if not, does it need a person?
 *
 * Returns `null` when the listing is new and clean, `{ quiet: true }` when it
 * is one this importer has already added, and `{ reason, duplicate_of }` when
 * something wants a human eye. It never decides to drop something — a reason
 * is an invitation to look, not a verdict.
 *
 * Both importers call this. Pennsylvania used to carry its own copy of these
 * rules, because it gets coordinates from the directory and so cannot use
 * `place()`, which geocodes. The file header warned that a second copy would
 * be a second place for the rules to drift, and it was: both copies grew the
 * same two faults, and on 2026-09-18 three real Connecticut farms were deleted
 * as duplicates because of them.
 */
export function matchExisting(listing, at, existing, opts = {}) {
  const { source, importId } = opts

  /*
   * Identity first, and exactly.
   *
   * A row this importer already added is not a finding, it is the importer
   * being idempotent — without that, the second run of a weekly job reports
   * every listing it has ever imported, 43 of them every Monday, and a report
   * that cries wolf forty-three times is a report nobody reads.
   *
   * But it has to be the SAME row, matched on the key the importer writes,
   * not on resemblance. Keying it off the fuzzy matchers meant a genuinely new
   * farm that merely looked like one we had was reported as "already imported
   * from this source" and vanished from the candidates file — invisible to the
   * review that exists to catch exactly this. Belltown Hill Orchards sat 600m
   * from Rose's Berry Farm and disappeared that way.
   */
  if (source && importId) {
    const mine = existing.find(
      (o) => o.import_source === source && o.import_id === importId,
    )
    if (mine) return { quiet: true, reason: 'already imported from this source' }
  }

  /*
   * A shared name only means a shared business at a shared place. Farms in
   * this trade are named after families, and two unrelated ones a hundred
   * miles apart are the normal case rather than the exotic one.
   */
  const sameName = existing.find(
    (o) => sameBusiness(o.name, listing.name) && distanceM(o, at) < NAME_MATCH_M,
  )
  if (sameName) {
    return {
      reason: `same name as one we have: ${sameName.name}`,
      duplicate_of: sameName.slug,
    }
  }

  // Weaker than a name match and worth separating: two real farms can share a
  // village, and a geocoder falling back to the town centre puts both on the
  // same point.
  const near = existing.find((o) => distanceM(o, at) < NEAR_M)
  if (near) {
    return {
      reason: `within ${NEAR_M}m of ${near.name} — same farm, or the geocoder gave up on both?`,
      duplicate_of: near.slug,
    }
  }

  return null
}

/**
 * Place one listing: geocode it, box it, and check it against what we have.
 *
 * Returns either `{ ok: true, ...position }` or `{ ok: false, reason }`.
 */
export async function place(listing, existing, opts) {
  const { userAgent, source, importId } = opts
  const where = [listing.address, listing.town, listing.state, listing.zip]
    .filter(Boolean).join(', ')

  let at = listing.address ? await geocode(where, { userAgent }) : null
  if (!at) {
    at = await geocode(`${listing.name}, ${listing.town}, ${listing.state}`, { userAgent })
  }
  if (!at) return { ok: false, reason: 'could not be geocoded' }

  if (!inBox(at.lat, at.lng)) {
    return { ok: false, ...at, reason: 'outside the day-trip box', quiet: true }
  }

  const hit = matchExisting(listing, at, existing, { source, importId })
  if (hit) return { ok: false, ...at, ...hit }

  return { ok: true, ...at }
}
