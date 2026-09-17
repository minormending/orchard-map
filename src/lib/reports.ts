import { supabase } from './db'
import type { Orchard } from './types'

export type ReportKind = 'open' | 'picked_out' | 'closed' | 'busy' | 'gone'

export const REPORT_LABELS: Record<ReportKind, string> = {
  open: 'Picking was on',
  picked_out: 'Picked out',
  closed: 'Closed when it should not have been',
  busy: 'Too busy to park',
  gone: 'Not there any more',
}

const ANON_KEY = 'orchard-map.anon'

/**
 * A per-browser identity, so anonymous reports can be counted as distinct
 * people without an account.
 *
 * Defeatable — clearing storage makes a new one — and that is understood
 * rather than worked around: it is exactly why auto-hide needs four separate
 * reporters plus a score threshold instead of trusting any single one.
 */
export function anonId(): string {
  try {
    const existing = localStorage.getItem(ANON_KEY)
    if (existing) return existing
    const made = crypto.randomUUID()
    localStorage.setItem(ANON_KEY, made)
    return made
  } catch {
    // Private windows and blocked site data both throw here. A report without
    // an anon id still counts; it just cannot be deduplicated.
    return ''
  }
}

const REPORTED_KEY = 'orchard-map.reported'

/** What this browser has already said, so the UI can thank rather than re-ask. */
export function alreadyReported(slug: string): boolean {
  try {
    const raw = localStorage.getItem(REPORTED_KEY)
    if (!raw) return false
    const map = JSON.parse(raw) as Record<string, number>
    const at = map[slug]
    // A report is about a day, so yesterday's does not silence today's.
    return typeof at === 'number' && Date.now() - at < 20 * 3_600_000
  } catch {
    return false
  }
}

function remember(slug: string): void {
  try {
    const raw = localStorage.getItem(REPORTED_KEY)
    const map = raw ? (JSON.parse(raw) as Record<string, number>) : {}
    map[slug] = Date.now()
    localStorage.setItem(REPORTED_KEY, JSON.stringify(map))
  } catch {
    /* nothing to do; the report still went through */
  }
}

export interface ReportResult {
  ok: boolean
  message: string
}

/**
 * Coordinates go up and are not stored. The server computes one boolean — were
 * you plausibly at this farm — and discards the position. There is no column
 * anywhere holding where anybody was.
 */
export async function submitReport(
  orchard: Orchard,
  kind: ReportKind,
  position: { lat: number; lng: number } | null,
): Promise<ReportResult> {
  if (!supabase) {
    return { ok: false, message: 'Reporting is not switched on yet.' }
  }

  const { error } = await supabase.rpc('submit_report', {
    p_orchard_id: orchard.id,
    p_kind: kind,
    p_anon_id: anonId(),
    p_lat: position?.lat ?? null,
    p_lng: position?.lng ?? null,
  })

  if (error) {
    // Error codes are the contract with the database; the English text is not.
    if (error.code === '53400') {
      return { ok: false, message: 'That is a lot of reports — try again later.' }
    }
    if (error.code === 'P0002') {
      return { ok: false, message: 'This orchard is no longer on the map.' }
    }
    return { ok: false, message: 'That did not go through. Try again in a moment.' }
  }

  remember(orchard.slug)
  return { ok: true, message: 'Thank you — that helps the next person.' }
}
