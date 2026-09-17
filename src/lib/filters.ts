import type { Orchard, Tag } from './types'

export interface FilterDef {
  key: Tag
  label: string
  /** Shown under the label. These are the association's own categories, and
   *  what they mean is not always obvious from the name. */
  hint: string
}

/**
 * Phase 1 filters are exactly the categories the source actually carries.
 *
 * It is tempting to ship the full amenity set now — dogs, hayrides, restrooms,
 * cider donuts — and leave them empty until there is data. That would be a
 * worse map: a filter that always returns nothing teaches people the map is
 * broken, and they do not come back to find out it was fixed. Amenities arrive
 * with the scraper in Phase 4, and the filter arrives with them.
 */
export const FILTERS: FilterDef[] = [
  { key: 'pick_your_own', label: 'Pick your own', hint: 'You can pick the apples yourself' },
  { key: 'fresh_cider', label: 'Fresh cider', hint: 'Sweet cider, pressed on or near the farm' },
  { key: 'craft_cider', label: 'Hard cider & spirits', hint: 'Cidery, taproom or distillery' },
  { key: 'farm_market', label: 'Farm market', hint: 'A shop selling what they grow' },
  { key: 'heirloom', label: 'Heirloom varieties', hint: 'Grows older, less commercial apples' },
  { key: 'gift_boxes', label: 'Ships gift boxes', hint: 'Will post apples to somebody' },
]

export interface FilterState {
  tags: Tag[]
  query: string
}

export const EMPTY_FILTERS: FilterState = { tags: [], query: '' }

const norm = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')

/**
 * Tags are ANDed, not ORed.
 *
 * Someone ticking "pick your own" and "hard cider" wants one trip that does
 * both, not a longer list. OR is the intuitive implementation and the wrong
 * answer: it makes every extra tick produce *more* results, which is the
 * opposite of what ticking a filter is for.
 */
export function matches(orchard: Orchard, filters: FilterState): boolean {
  for (const tag of filters.tags) {
    if (!orchard.tags.includes(tag)) return false
  }

  const q = norm(filters.query.trim())
  if (!q) return true

  const haystack = norm(
    [orchard.name, orchard.town, orchard.address, orchard.zip].filter(Boolean).join(' '),
  )
  // Every word must appear somewhere, so "warwick orchard" narrows rather than
  // widening to everything in Warwick plus everything called Orchard.
  return q.split(/\s+/).every((word) => haystack.includes(word))
}

export function applyFilters(orchards: Orchard[], filters: FilterState): Orchard[] {
  return orchards.filter((o) => matches(o, filters))
}

/** Metres between two points. Good enough for sorting a list by distance. */
export function distanceM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export function milesLabel(metres: number): string {
  const miles = metres / 1609.34
  if (miles < 10) return `${miles.toFixed(1)} mi`
  return `${Math.round(miles)} mi`
}

/** The tags a person would want to read, in a stable order. */
export function tagLabels(orchard: Orchard): string[] {
  return FILTERS.filter((f) => orchard.tags.includes(f.key)).map((f) => f.label)
}
