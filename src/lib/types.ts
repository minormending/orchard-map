/**
 * What the map knows about a place.
 *
 * The rule that governs every optional field here: **null means nobody has
 * said, which is not the same as false.** An orchard with `dogs: null` is one
 * we have not asked about; an orchard with `dogs: false` has told us no. The
 * UI must never render the first as the second — the whole value of this map
 * over a general one is that it is honest about what it does not know.
 */

/** What the New York Apple Association says a place does. */
export type Tag =
  | 'pick_your_own'
  | 'farm_market'
  | 'fresh_cider'
  | 'craft_cider'
  | 'heirloom'
  | 'gift_boxes'
  | 'greenmarket'

export type OrchardStatus = 'active' | 'hidden' | 'removed'

export interface Orchard {
  id: string
  /** Stable, human-readable, and the URL. Collisions get the import id appended. */
  slug: string
  name: string
  lat: number
  lng: number

  address: string | null
  town: string | null
  state: string | null
  zip: string | null
  phone: string | null
  website: string | null

  tags: Tag[]

  /** Provenance. Withdrawing a source is one filter, and the licence travels
   *  with the rows rather than living in somebody's memory. */
  import_source: string
  import_id: string
  import_licence: string
  imported_at: string

  // ---- everything below arrives in Phase 2+ and is null until it does ----

  status?: OrchardStatus

  /** Operator facts: published by the farm, cited to its own site. */
  upick_open?: boolean | null
  hours?: string | null
  admission?: string | null
  reservations_required?: boolean | null

  /** Visitor facts: two independent agreeing claims settle one. */
  dogs?: boolean | null
  restrooms?: boolean | null
  wheelchair_rows?: boolean | null
  cards_accepted?: boolean | null
  picnic_area?: boolean | null
  hayride?: boolean | null
  corn_maze?: boolean | null
  petting_zoo?: boolean | null
  food_on_site?: boolean | null
  cider_donuts?: boolean | null

  /** Variety slugs believed to be growing here. */
  varieties?: string[]

  /** When any of the volatile fields above were last confirmed. A stale "open"
   *  costs somebody a two-hour drive, so this is rendered, never hidden. */
  checked_at?: string | null
}

/** One apple, and roughly when it is ready. */
export interface Variety {
  slug: string
  name: string
  /** Day-of-year the picking window typically opens and closes in this region.
   *  Regional averages, corrected per-orchard by observation once we have any. */
  start_doy: number
  end_doy: number
  /** Sweet / tart / balanced — the thing people actually choose on. */
  flavour: 'sweet' | 'tart' | 'balanced'
  best_for: string[]
  note?: string
}
