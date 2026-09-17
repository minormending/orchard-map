// The import attribute is required by Node, which runs these modules directly
// in the test suite. Vite tolerates its absence; Node does not.
import varietyData from '../data/varieties.json' with { type: 'json' }
import type { Variety } from './types'

export type VarietyRow = Variety

export const VARIETIES = varietyData as VarietyRow[]
export const VARIETY_BY_SLUG = new Map(VARIETIES.map((v) => [v.slug, v]))

/** Day of the year, 1–366, in local time. */
export function dayOfYear(date: Date = new Date()): number {
  const start = Date.UTC(date.getFullYear(), 0, 0)
  const now = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  return Math.floor((now - start) / 86_400_000)
}

const hasWindow = (v: VarietyRow): boolean =>
  v.start_doy !== null && v.end_doy !== null

/**
 * What is usually on the tree right now.
 *
 * "Usually" is load-bearing and must survive into every string the UI builds
 * out of this. These are regional averages: a warm spring pulls the whole
 * calendar a week earlier, and any given farm sits a week either side of the
 * region. The map knows what is typical for the Hudson Valley in this week of
 * the year. It does not know what is on the trees at one particular farm —
 * only the farm knows that, which is why the detail pages still say their
 * hours are unchecked.
 */
export function ripeNow(date: Date = new Date()): VarietyRow[] {
  const d = dayOfYear(date)
  return VARIETIES.filter((v) => hasWindow(v) && v.start_doy! <= d && d <= v.end_doy!)
}

/** Varieties whose window opens within `days`. */
export function comingSoon(date: Date = new Date(), days = 14): VarietyRow[] {
  const d = dayOfYear(date)
  return VARIETIES.filter(
    (v) => hasWindow(v) && v.start_doy! > d && v.start_doy! <= d + days,
  )
}

/** Varieties whose window closes within `days` — the "go now" list. */
export function finishingSoon(date: Date = new Date(), days = 10): VarietyRow[] {
  const d = dayOfYear(date)
  return VARIETIES.filter(
    (v) => hasWindow(v) && v.end_doy! >= d && v.end_doy! <= d + days,
  )
}

export type SeasonPhase = 'before' | 'early' | 'peak' | 'late' | 'after'

/**
 * Where in the season today falls.
 *
 * Derived from the varieties themselves rather than from hard-coded dates, so
 * correcting a harvest window automatically corrects the banner.
 */
export function seasonPhase(date: Date = new Date()): SeasonPhase {
  const d = dayOfYear(date)
  const windows = VARIETIES.filter(hasWindow)
  if (windows.length === 0) return 'before'

  const first = Math.min(...windows.map((v) => v.start_doy!))
  const last = Math.max(...windows.map((v) => v.end_doy!))

  if (d < first - 14) return 'before'
  if (d < first) return 'early'
  if (d > last) return 'after'
  if (d > last - 14) return 'late'

  // Peak is when the most varieties overlap — mid-September to mid-October in
  // practice, which is when this map is worth opening.
  return ripeNow(date).length >= 4 ? 'peak' : 'early'
}

/** A short, honest sentence for the top of the map. */
export function seasonHeadline(date: Date = new Date()): string {
  const ripe = ripeNow(date)
  const phase = seasonPhase(date)

  if (phase === 'before') return 'Picking season has not started yet — it opens in August.'
  if (phase === 'after') return 'Picking season is over for this year. It starts again in August.'
  if (ripe.length === 0) return 'Between varieties this week — ring ahead before driving.'

  const names = ripe.slice(0, 4).map((v) => v.name)
  const rest = ripe.length - names.length
  const list = names.join(', ') + (rest > 0 ? ` and ${rest} more` : '')
  return `Usually ripe in the Hudson Valley this week: ${list}.`
}

/** "early September" / "mid October" — how people actually say these. */
export function windowLabel(v: VarietyRow): string | null {
  if (!v.harvest_from || !v.harvest_to) return null
  const part = (mmdd: string) => {
    const [m, d] = mmdd.split('-').map(Number)
    const month = new Date(2025, m - 1, 1).toLocaleDateString('en-US', { month: 'long' })
    const where = d <= 10 ? 'early' : d <= 20 ? 'mid' : 'late'
    return `${where} ${month}`
  }
  const from = part(v.harvest_from)
  const to = part(v.harvest_to)
  return from === to ? from : `${from} to ${to}`
}
