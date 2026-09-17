import raw from '../data/orchards.json'
import type { Orchard } from './types'

/**
 * Every orchard, baked into the build.
 *
 * The whole dataset is about 190 rows and 90KB. `restroom-map` fetches its
 * places at runtime through a viewport query capped at 300 rows, which is
 * right for thousands of restrooms across a city where the viewport *is* the
 * query. Here the entire region is smaller than one of those pages, so
 * fetching it is pure latency — and unlike restrooms, this map is found
 * through Google, where a page that renders nothing without a database call
 * ranks for nothing.
 *
 * So: static at build time, and the database is only involved in writes and in
 * the volatile seasonal overlay.
 */
export const ORCHARDS = raw as Orchard[]

export const BY_SLUG = new Map(ORCHARDS.map((o) => [o.slug, o]))

/** Where the map opens: the Hudson Valley, which is where most of them are. */
export const DEFAULT_CENTER: [number, number] = [-74.05, 41.55]
export const DEFAULT_ZOOM = 8.1

export function orchardUrl(base: string, slug: string): string {
  return `${base.replace(/\/$/, '')}/orchard/${slug}`
}

/** A one-line address for a card or a page header. */
export function addressLine(o: Orchard): string {
  return [o.address, o.town, o.state, o.zip].filter(Boolean).join(', ')
}

/**
 * A link that opens directions in whatever the person's device prefers.
 *
 * Coordinates rather than the name, because several of these places are down
 * an unnamed track and a search for "Smith Farm" lands you at a different
 * Smith Farm two counties away. The name rides along as a label.
 */
export function directionsUrl(o: Orchard): string {
  const q = encodeURIComponent(`${o.lat},${o.lng}`)
  return `https://www.google.com/maps/dir/?api=1&destination=${q}`
}

export function telUrl(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`
}
