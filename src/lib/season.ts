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

/*
 * Where a variety's window sits on the picking calendar, as percentages.
 *
 * This lived inline in varieties.astro, which was fine while one page drew
 * bars. The orchard pages want the same picture for the farm's own varieties,
 * and a second copy of the arithmetic is a second chance for the two calendars
 * to disagree about where September is.
 *
 * The axis runs 1 August to 15 November — the picking season with a margin,
 * not the year, because eight months of empty track either side would make
 * every bar a sliver. Both ends clamp, so a variety reaching past the axis is
 * drawn to the edge rather than overflowing its track.
 */
const AXIS_START = dayOfYear(new Date(2025, 7, 1))
const AXIS_END = dayOfYear(new Date(2025, 10, 15))
const AXIS_SPAN = AXIS_END - AXIS_START

export interface CalendarBar {
  /** Percent from the left of the track. */
  left: number
  /** Percent of the track's width. Never below 2, so a short window is still
   *  a visible mark rather than a hairline. */
  width: number
  /** Whether today falls inside this variety's window. */
  ripeToday: boolean
}

export function calendarBar(v: VarietyRow, date: Date = new Date()): CalendarBar | null {
  if (!hasWindow(v)) return null
  const today = dayOfYear(date)
  const left = Math.max(0, ((v.start_doy! - AXIS_START) / AXIS_SPAN) * 100)
  const width = ((v.end_doy! - v.start_doy!) / AXIS_SPAN) * 100
  return {
    left,
    width: Math.max(2, Math.min(100 - left, width)),
    ripeToday: v.start_doy! <= today && today <= v.end_doy!,
  }
}
