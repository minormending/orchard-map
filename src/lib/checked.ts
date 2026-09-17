import { freshnessOf, agoLabel, type Freshness } from '@minormending/map-kit'
import type { Orchard } from './types'

/**
 * How to talk about something a farm told us, and when.
 *
 * The rule the whole project turns on: a stale "picking is open" costs
 * somebody a two-hour drive with children in the car. So nothing here ever
 * renders a value without also rendering when it was checked, and a value that
 * has gone stale is downgraded in the wording rather than quietly presented as
 * current.
 *
 * The windows are short because the subject is: an apple season is about eight
 * weeks, and a farm can pick out in a weekend. A fortnight-old "open" is not a
 * fact about this Saturday.
 */
export const PICKING_FRESHNESS = { freshDays: 5, staleDays: 14 }

/** Hours move far less than whether the trees have anything left. */
export const HOURS_FRESHNESS = { freshDays: 21, staleDays: 60 }

export interface Checked {
  freshness: Freshness
  /** "yesterday", "3 days ago" — always leads with *when*. */
  ago: string
  /** Where it came from, so a reader can disagree with us. */
  source: string | null
}

export function checkedState(
  orchard: Orchard,
  rule = PICKING_FRESHNESS,
  now: Date = new Date(),
): Checked | null {
  if (!orchard.checked_at) return null
  return {
    freshness: freshnessOf(orchard.checked_at, rule, now),
    ago: agoLabel(orchard.checked_at, now),
    source: (orchard as { source_url?: string }).source_url ?? null,
  }
}

/**
 * The sentence for whether picking is on.
 *
 * `null` for "nobody has checked" is a different answer from `false`, and both
 * are different from a stale `true` — which is the one that has to be hedged,
 * because it is the one that costs a journey.
 */
export function pickingLine(orchard: Orchard, now: Date = new Date()): string {
  const state = checkedState(orchard, PICKING_FRESHNESS, now)

  if (orchard.upick_open === undefined || orchard.upick_open === null) {
    /*
     * Three different answers, and collapsing them misleads.
     *
     * "Nobody has checked" alongside "read from their website today" is a
     * contradiction a reader will notice — and the second case is the more
     * interesting one anyway: we DID read the site, and it did not say. Barton
     * Orchards is the live example: their homepage led with "WE ARE OPEN
     * TODAY!" dated four days earlier and their u-pick page said "See You Next
     * Season!", so the honest answer is that the site is ambiguous, not that
     * nobody looked.
     */
    return state
      ? `We read their site ${state.ago}, and it did not say plainly whether picking is on.`
      : 'Nobody has checked whether picking is open.'
  }

  if (!state) return 'Nobody has checked whether picking is open.'

  if (orchard.upick_open === false) {
    return `The farm said picking was not on, ${state.ago}.`
  }

  switch (state.freshness) {
    case 'fresh':
      return `The farm's own site said picking was on, ${state.ago}.`
    case 'recent':
      return `The farm's site said picking was on ${state.ago} — worth ringing to confirm.`
    default:
      // Deliberately does not say "open". At this age it is history.
      return `The farm's site said picking was on back ${state.ago}. That is too old to rely on — ring ahead.`
  }
}

/** Does this orchard carry anything a farm actually told us? */
export function hasFarmData(orchard: Orchard): boolean {
  return Boolean(
    orchard.checked_at &&
      (orchard.upick_open !== undefined ||
        orchard.hours ||
        orchard.admission ||
        orchard.reservations_required !== undefined),
  )
}
