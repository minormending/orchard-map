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

  /**
   * How much the pin is claiming, when anyone has said.
   *
   * Absent on almost every row, and absence is not a claim of exactness — it
   * means nobody recorded a precision. 'approximate' is the one that changes
   * what a visitor sees: the page stops presenting the position as the farm's
   * front gate and says to ring ahead, because the address the pin came from
   * had no building in it.
   */
  position_precision?: 'exact' | 'approximate'

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
  /** The page it was read from, so a reader can check us. */
  source_url?: string | null
}

/**
 * One apple, and roughly when it is ready.
 *
 * `start_doy`/`end_doy` are the days of the year the PICKING window typically
 * opens and closes in the Hudson Valley. They are regional averages, and they
 * are deliberately not the association's own "availability" figure — that is
 * when the apple is on sale out of cold storage, which for several varieties
 * runs into the following spring. Null when there is no reliable window; such
 * a variety is left out of "ripe now" rather than guessed into it.
 */
export interface Variety {
  slug: string
  name: string
  /** Sweet / tart / balanced — the thing people actually choose on. */
  flavour: 'sweet' | 'tart' | 'balanced'
  profile: string[]
  best_for: string[]
  hint: string | null
  start_doy: number | null
  end_doy: number | null
  harvest_from: string | null
  harvest_to: string | null
  harvest_source: string | null
  import_source: string
  import_licence: string
}
