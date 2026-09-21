import { STATES } from './states.ts'

/**
 * The address box holds a street line, and people type whole addresses into it.
 *
 * Abma's Farm Market arrived on 21 September as
 *
 *     address  700 Lawlins Rd, Wyckoff, NJ 07481
 *     town     Wyckoff
 *     state    NJ
 *     zip      (empty)
 *
 * which is not a typo — it is what a form asking for "Address" gets when the
 * person has an address. `addressLine()` joins all four, so the page would
 * have read "700 Lawlins Rd, Wyckoff, NJ 07481, Wyckoff, NJ", and the JSON-LD
 * was worse: the whole string in `streetAddress` beside a separate
 * `addressLocality` and `addressRegion`.
 *
 * ---------------------------------------------------------------------------
 * Why this is not simply "split on commas"
 * ---------------------------------------------------------------------------
 *
 * A comma in a street line is usually load-bearing. Every one of the ten
 * comma-carrying addresses already on the map is a suite or building
 * qualifier that belongs exactly where it is:
 *
 *     18 W Main St, Ste #1
 *     8 Winkler Rd, Building 3
 *     100 Jericho Tpke, Box 648
 *     1355 Boston Post Road, US Rte. 1, I-95 Exit 57
 *
 * So the anchor is not the comma, it is the STATE: a two-letter code, at the
 * end or in front of a five-digit zip, and only one of the codes this form
 * offers. That last condition is what keeps "12 Oak Rd, Unit BB" intact —
 * `BB` is two letters and is not a state, so there is nothing to move.
 *
 * This only ever reports what it found. Moving anything is the form's
 * decision and the person's, because the tail could be part of a street name
 * and only they can say.
 */

const OFFERED = new Set(STATES.map((s) => s.code))

export interface Split {
  /** What the street line should be. */
  street: string
  town: string
  state: string
  /** Five digits, or five plus four. Null when the address did not carry one. */
  zip: string | null
}

/*
 * Two shapes, because people write both and the difference is one comma:
 *
 *   700 Lawlins Rd, Wyckoff, NJ 07481
 *   700 Lawlins Rd, Wyckoff NJ 07481
 *
 * Both require the state to be the last thing before an optional zip, and the
 * zip to be a zip. `.*?` for the street is lazy so that a street with its own
 * commas keeps them: only the final town-and-state tail comes away.
 */
const ZIP = String.raw`(\d{5}(?:-\d{4})?)`
const TAIL = [
  new RegExp(String.raw`^(.*?),\s*([^,]+?),\s*([A-Za-z]{2})(?:\s+${ZIP})?\s*$`),
  new RegExp(String.raw`^(.*?),\s*(.+?)\s+([A-Za-z]{2})(?:\s+${ZIP})?\s*$`),
]

/**
 * Does this address end with a town and state that belong in their own fields?
 *
 * Returns null when it does not, which is the common case and the one that
 * must stay fast to be sure about: an ordinary street line comes back
 * untouched rather than nearly-parsed.
 */
export function splitAddress(raw: string | null | undefined): Split | null {
  const typed = String(raw ?? '').trim()
  if (!typed) return null

  for (const re of TAIL) {
    const m = re.exec(typed)
    if (!m) continue

    const street = m[1].trim()
    const town = m[2].trim()
    const state = m[3].toUpperCase()

    // A street line is what this is for. Nothing to keep means the person
    // typed a town and no street, which is a different problem.
    if (!street || !town) continue
    if (!OFFERED.has(state)) continue

    return { street, town, state, zip: m[4] ?? null }
  }
  return null
}

/**
 * Is this address saying the town and state a second time?
 *
 * The narrower question, and the one the database asks. `splitAddress` finds
 * any town-shaped tail; this asks only whether the tail repeats what is being
 * submitted alongside it — which is the thing the column cannot mean, because
 * those values already have columns of their own.
 *
 * Kept separate from the split on purpose. A tail naming a DIFFERENT town is
 * a judgment about somebody's street name and not ours to overrule; a tail
 * naming the same town is a duplicate however you look at it.
 */
export function repeatsPlace(
  address: string | null | undefined,
  town: string | null | undefined,
  state: string | null | undefined,
): boolean {
  const found = splitAddress(address)
  if (!found) return false

  const same = (a: string, b: string | null | undefined) =>
    !!b && a.trim().toLowerCase() === String(b).trim().toLowerCase()

  return same(found.town, town) || same(found.state, state)
}
