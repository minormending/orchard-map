import type { Orchard } from './types'

/**
 * What a dot on the map means, in one place.
 *
 * The colours used to live inline in the MapLibre paint expression, which is
 * fine right up until something else needs to name them — and a legend whose
 * swatches are written out separately is a legend that can quietly stop
 * matching the map. One definition, read by both.
 */
export type Kind = 'upick' | 'cider' | 'other'

export interface KindSpec {
  kind: Kind
  colour: string
  label: string
  /** What a visitor should take from the colour, in a phrase. */
  meaning: string
}

export const KINDS: KindSpec[] = [
  {
    kind: 'upick',
    colour: '#C2384A',
    label: 'Pick your own',
    meaning: 'the farm is listed as letting you pick',
  },
  {
    kind: 'cider',
    colour: '#C8792A',
    label: 'Cider, no picking',
    meaning: 'a cider mill or cidery, with no pick-your-own listed',
  },
  {
    /*
     * The honest label matters more here than in the other two.
     *
     * Green is not "this farm does not do pick-your-own" — it is the bucket
     * for everything we have not been told about, and most of it is the
     * second. The Connecticut and Pennsylvania directories publish rosters
     * without categories, so their listings arrive with an empty tag list and
     * land here. Calling this "farm market" would turn an absence of
     * information into a claim, which is the one thing this map is built not
     * to do.
     */
    kind: 'other',
    colour: '#4A7C4E',
    label: 'Not known yet',
    meaning: 'a farm market, or simply a farm nobody has told us about',
  },
]

export const KIND_BY_NAME = new Map(KINDS.map((k) => [k.kind, k]))

/**
 * Pick-your-own wins when a farm is both, because it is the thing people came
 * here to find.
 */
export function kindOf(orchard: Orchard): Kind {
  if (orchard.tags.includes('pick_your_own')) return 'upick'
  if (orchard.tags.includes('craft_cider') || orchard.tags.includes('fresh_cider')) {
    return 'cider'
  }
  return 'other'
}

/** The MapLibre `match` expression, built from the same list the legend uses. */
export function circleColourExpression(): unknown[] {
  const spec = KINDS.filter((k) => k.kind !== 'other')
  return [
    'match', ['get', 'kind'],
    ...spec.flatMap((k) => [k.kind, k.colour]),
    KIND_BY_NAME.get('other')!.colour,
  ]
}
