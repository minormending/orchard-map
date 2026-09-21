import { geocode, placeLabel } from '@minormending/map-kit'
import { distanceM } from './filters.ts'

/**
 * Turning a typed address into a pin, and being honest about what the pin is.
 *
 * `AddOrchard` used to take the position only from a click on the map, on the
 * grounds that several of these farms are down an unnamed track and geocoding
 * their address lands you at the wrong end of the county. That reasoning was
 * sound about geocoders and wrong about people: it made everybody who knows
 * their own address hunt for a rooftop on a slippy map, to avoid a bad result
 * that only some addresses produce.
 *
 * So the geocoder proposes and the person disposes. Everything here exists to
 * keep that split honest — a lookup may offer a pin, it may never silently
 * replace one somebody placed by hand, and it may not claim to be sure.
 *
 * These rules are a second copy of the ones in `scripts/lib/directory.mjs`.
 * Scripts do not import from `src/` anywhere in this repo and this feature is
 * not the place to start; `test/locate.test.mjs` runs both copies over the
 * same cases instead, so the two cannot drift apart quietly.
 */

const ROUTE = String.raw`(?:rtes?|rt|route|state\s+(?:route|hwy|highway)|us|hwy|highway)\.?\s*\d+[a-z]?`

/**
 * Does this street name a building, or only a road?
 *
 * A leading house number is the difference between "403 Orchard Hill Road",
 * which geocodes to a farm, and "Meriden-Waterbury Road", which geocodes to a
 * road that runs for miles.
 */
export const hasHouseNumber = (street: string | null | undefined): boolean =>
  /^\s*\d/.test(String(street ?? ''))

/**
 * The street line as a geocoder can use it.
 *
 * People write addresses for somebody driving there, not for a parser: a route
 * number bracketed after the street, an `off Rte. 101` tacked on the end, a
 * route designator standing in front of a road that has a name of its own.
 * Photon takes the whole string literally and finds nothing.
 *
 * This only ever SHORTENS the query, and only when something is left to send.
 * What the visitor typed is stored untouched — this is a query, not a
 * correction, and `403 Orchard Hill Road (Rte. 169)` is how the farm tells
 * people to find it.
 */
export function streetForGeocoder(raw: string | null | undefined): string {
  if (!raw) return ''
  const original = String(raw).trim()
  let s = original

  // "403 Orchard Hill Road (Rte. 169)" — the aside is for a driver.
  s = s.replace(new RegExp(String.raw`\s*\(\s*${ROUTE}\s*\)`, 'gi'), '')

  // "1393 North Road, off Rte. 101" — so is the tail, and everything after it.
  s = s.replace(
    new RegExp(String.raw`\s*,?\s*\b(?:just\s+)?(?:off|on|at|near)\s+(?:the\s+)?${ROUTE}\b.*$`, 'i'),
    '',
  )

  // "Rt. 322 Meriden-Waterbury Road" — the road has a name; the route number in
  // front of it is what defeats the lookup. Requires something to follow, so a
  // bare "Rt. 322" survives intact.
  s = s.replace(new RegExp(String.raw`^${ROUTE}\s+(?=\S)`, 'i'), '')

  s = s.replace(/\s+/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '')
  return s || original
}

/**
 * How near the town centroid a result has to be before it is not an address.
 *
 * Tight on purpose. A farm genuinely standing on its town's centre point to
 * within 60m is not a thing that happens, and being tight means a real address
 * is never discarded for being central.
 */
export const TOWN_CENTRE_M = 60

/**
 * Bias for the lookup, rather than a state appended to the query.
 *
 * The form now asks which state the farm is in, so this query could assert it.
 * It still must not. A state in the query is a constraint: Photon answers
 * within it or not at all, so an address that is ambiguous, mistyped, or sits
 * a mile over a state line comes back as a confident pin in the wrong place
 * rather than as no result the visitor can see and correct. The state is also
 * the one field here nobody has checked yet — it is what the submitter says,
 * on its way to a moderator, and a query that trusts it turns a label somebody
 * can fix into a position nobody will question.
 *
 * `near` is the honest version of the same idea: it prefers local results
 * without ruling anything out, so a Connecticut address still resolves in
 * Connecticut, and a wrong answer still looks wrong.
 */
const NEAR: [number, number] = [-74.15, 41.65]

export type Precision = 'approximate' | null

export type Located =
  | { ok: true; at: { lat: number; lng: number }; precision: Precision; label: string }
  | { ok: false; reason: string }

/** One lookup per town for the whole session, not one per keystroke. */
const townCentres = new Map<string, { lat: number; lng: number } | null>()

async function townCentre(town: string, signal?: AbortSignal) {
  const key = town.trim().toLowerCase()
  if (!townCentres.has(key)) {
    const [first] = await geocode(town, { near: NEAR, limit: 1, signal })
    townCentres.set(key, first ? { lat: first.lat, lng: first.lng } : null)
  }
  return townCentres.get(key) ?? null
}

/**
 * Look up what the visitor typed.
 *
 * Returns a reason rather than a pin when the answer is not an address, so the
 * form can say what happened. A refusal here is not a dead end: the map click
 * is still there, and for a farm down an unnamed track it is the only thing
 * that ever worked.
 */
export async function locate(
  { address, town }: { address: string; town: string },
  { signal }: { signal?: AbortSignal } = {},
): Promise<Located> {
  const street = streetForGeocoder(address)
  const query = [street, town.trim()].filter(Boolean).join(', ')
  if (query.length < 4) return { ok: false, reason: 'Type an address and a town.' }

  const [first] = await geocode(query, { near: NEAR, limit: 1, signal })
  if (!first) return { ok: false, reason: 'No address found. Place it on the map instead.' }

  const at = { lat: first.lat, lng: first.lng }

  /*
   * A geocoder that cannot find the address will happily return the town, and
   * a pin on the middle of town is not an answer — it is the absence of one
   * wearing four decimal places.
   */
  if (town.trim()) {
    const centre = await townCentre(town, signal)
    if (centre && distanceM(centre, at) < TOWN_CENTRE_M) {
      return {
        ok: false,
        reason: `That found the middle of ${town.trim()}, not the farm. Place it on the map.`,
      }
    }
  }

  /*
   * Never 'exact'. A house number that geocodes to a rooftop is usually the
   * building, which is why it records no precision at all rather than a claim
   * — null means "nobody said", exactly as it does for the 252 imported rows.
   * Without a house number the result is a point on a road that may run for
   * miles, and that the visitor is entitled to be told.
   */
  return {
    ok: true,
    at,
    precision: hasHouseNumber(street) ? null : 'approximate',
    label: placeLabel(first),
  }
}
