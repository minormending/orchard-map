import type { Origin } from './travel'

/**
 * Where you usually set off from.
 *
 * "Travelling from" is the control that turns this map from a list of farms
 * into an answer about Saturday, and it is the one thing a visitor has to
 * re-do on every visit — find their roof on a slippy map, or hand over
 * location permission again. Somebody who comes back three weekends running is
 * answering the same question three times.
 *
 * ---------------------------------------------------------------------------
 * Why this is in the browser and not on the account
 * ---------------------------------------------------------------------------
 *
 * It is a home address. It is the most personal thing this project could hold
 * and it is not needed on a server to do its job: the drive times are computed
 * in the browser from a coordinate, and nothing else ever reads it.
 *
 * Putting it on `profiles` would mean a column of where people live, a row per
 * person, in a database whose whole moderation story is about what strangers
 * may see. The cost of keeping it local is that it does not follow you to your
 * phone, which is a real cost and the right one to pay — and it is also why
 * this does not require an account at all. Signing in buys adding a farm and
 * answering a question about one; it does not have to buy this.
 *
 * Same storage idiom as `reports.ts`: every access in a try/catch, because a
 * private window and blocked site data both throw, and a map that works is
 * better than a map that remembers.
 */

const KEY = 'orchard-map.start'

/** Read back only what could have been written: a real position and a label. */
function parse(raw: string): Origin | null {
  const o = JSON.parse(raw) as Partial<Origin>
  if (typeof o?.lat !== 'number' || typeof o?.lng !== 'number') return null
  if (!Number.isFinite(o.lat) || !Number.isFinite(o.lng)) return null
  if (o.lat < -90 || o.lat > 90 || o.lng < -180 || o.lng > 180) return null
  return { lat: o.lat, lng: o.lng, label: String(o.label ?? 'your saved start') }
}

export function readStart(): Origin | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? parse(raw) : null
  } catch {
    // Private window, blocked site data, or something that is not ours in the
    // key. None of them is a reason to fail to draw a map.
    return null
  }
}

export function saveStart(origin: Origin): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      lat: origin.lat,
      lng: origin.lng,
      label: origin.label,
    }))
  } catch {
    /* Saving is a convenience. Not being able to is not an error worth telling
       somebody about in the middle of planning a drive. */
  }
}

export function clearStart(): void {
  try {
    localStorage.removeItem(KEY)
  } catch { /* see above */ }
}
