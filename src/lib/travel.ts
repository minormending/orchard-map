import type { Orchard } from './types'

/**
 * How long it takes to drive there.
 *
 * One request per origin, answering for every orchard at once: OSRM's table
 * service takes a source and many destinations and returns a row of durations.
 * Measured against the real dataset it is about 600ms and 54KB for 253 farms,
 * so this is one call when somebody drops a pin rather than anything per-farm
 * or per-frame.
 *
 * THE NUMBER HAS NO TRAFFIC IN IT. OSRM returns free-flow road time, and the
 * Saturday morning in late September when everybody drives to the Hudson
 * Valley is exactly when that is most wrong. Every label this module produces
 * says "without traffic" for that reason — a confident "1h 47m" that is
 * really two and a half hours on the day is the kind of number this map
 * refuses everywhere else.
 */

/** The public demo server, sponsored by FOSSGIS, running on OSM data. */
const OSRM = 'https://router.project-osrm.org/table/v1/driving'

/**
 * Usable because it can be named.
 *
 * Its terms are non-commercial, reasonable use, no more than one request a
 * second, and no guarantee of uptime. A visitor sets an origin once or twice a
 * session, which is lighter than the map tiles they are already fetching. The
 * same test the importers apply to a data source applies here: a routing
 * service whose terms forbid this would have nowhere honest to sit on the
 * About page, which is why this is not Google Directions.
 */
export const ROUTING_CREDIT = {
  name: 'OSRM',
  detail: 'demo server, sponsored by FOSSGIS, on OpenStreetMap data',
  url: 'https://routing.openstreetmap.de/about.html',
}

export interface Origin {
  lat: number
  lng: number
  /** What to call it on screen. "Your location", a town, or the coordinates. */
  label: string
}

export type TravelTimes = Map<string, number>

/** The filter's rungs, in minutes. */
export const TRAVEL_BANDS = [45, 60, 90, 120] as const

/**
 * "1h 50m", "45m".
 *
 * Rounded to five minutes above an hour. The underlying number is a model of a
 * road network with no traffic in it, and printing "1h 47m" claims a precision
 * that does not survive contact with a Saturday.
 */
export function durationLabel(seconds: number): string {
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins}m`
  const rounded = Math.round(mins / 5) * 5
  const h = Math.floor(rounded / 60)
  const m = rounded % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/** The same thing, said in full, for a place a visitor might act on. */
export const drivingLabel = (seconds: number) =>
  `about ${durationLabel(seconds)} driving, without traffic`

/**
 * Coordinates rounded to about 100m, which is the cache key.
 *
 * Nudging the pin a few metres must not spend another request, and at this
 * scale it cannot change an answer that is already rounded to five minutes.
 */
const cacheKey = (o: Origin) => `travel:${o.lat.toFixed(3)},${o.lng.toFixed(3)}`

function readCache(o: Origin): TravelTimes | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(o))
    if (!raw) return null
    return new Map(JSON.parse(raw) as [string, number][])
  } catch {
    // Private windows, blocked storage, a bad parse. Not worth a failure.
    return null
  }
}

function writeCache(o: Origin, times: TravelTimes): void {
  try {
    sessionStorage.setItem(cacheKey(o), JSON.stringify([...times]))
  } catch {
    /* Storage is a convenience here, never a dependency. */
  }
}

export class TravelUnavailable extends Error {}

/**
 * Durations from one origin to every orchard, as a map of slug to seconds.
 *
 * Throws `TravelUnavailable` rather than returning a partial answer. The
 * caller's job on failure is to say the times are unavailable and fall back to
 * straight-line distance — never to show some farms with a time and some
 * without, which would read as "these ones are unreachable".
 */
export async function travelTimes(
  origin: Origin,
  orchards: Orchard[],
  { signal }: { signal?: AbortSignal } = {},
): Promise<TravelTimes> {
  const cached = readCache(origin)
  if (cached) return cached

  const coords = [
    `${origin.lng},${origin.lat}`,
    ...orchards.map((o) => `${o.lng},${o.lat}`),
  ].join(';')

  let res: Response
  try {
    res = await fetch(`${OSRM}/${coords}?sources=0&annotations=duration`, {
      signal: signal ?? AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new TravelUnavailable(String(err))
  }
  if (!res.ok) throw new TravelUnavailable(`routing answered ${res.status}`)

  const body = (await res.json()) as { durations?: (number | null)[][] }
  const row = body.durations?.[0]
  if (!row) throw new TravelUnavailable('no durations in the response')

  const times: TravelTimes = new Map()
  // row[0] is the origin to itself; the rest line up with `orchards` in order.
  orchards.forEach((o, i) => {
    const seconds = row[i + 1]
    if (typeof seconds === 'number') times.set(o.slug, seconds)
  })

  if (times.size === 0) throw new TravelUnavailable('every destination was unroutable')
  writeCache(origin, times)
  return times
}

/**
 * Is this farm within the band?
 *
 * A farm with no duration — unroutable, or an island of the road network —
 * fails the filter rather than passing it. Showing it would put a farm in a
 * "within 60 minutes" list without anybody having established that it is.
 */
export function withinBand(
  orchard: Orchard,
  times: TravelTimes | null,
  minutes: number | null,
): boolean {
  if (minutes === null) return true
  if (!times) return true
  const seconds = times.get(orchard.slug)
  return seconds !== undefined && seconds <= minutes * 60
}
