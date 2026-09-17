import { useState } from 'react'
import { HAS_DB } from '../lib/db'
import { REPORT_LABELS, alreadyReported, submitReport, type ReportKind } from '../lib/reports'
import type { Orchard } from '../lib/types'

const ORDER: ReportKind[] = ['open', 'picked_out', 'closed', 'busy', 'gone']

/**
 * "I went. This is what I found."
 *
 * No account, deliberately. This is the highest-volume and lowest-risk signal
 * the map can collect, and a sign-in wall in front of it would remove almost
 * all of it.
 *
 * Nothing here is shown when there is no database configured. An affordance
 * that silently does nothing is worse than an absent one — it spends the
 * goodwill of somebody who was willing to help.
 */
export function ReportBox({
  orchard,
  position,
}: {
  orchard: Orchard
  position: { lat: number; lng: number } | null
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<ReportKind | null>(null)
  const [said, setSaid] = useState<string | null>(
    alreadyReported(orchard.slug) ? 'Thank you — you already told us about today.' : null,
  )

  if (!HAS_DB) return null

  const send = async (kind: ReportKind) => {
    setBusy(kind)
    const result = await submitReport(orchard, kind, position)
    setBusy(null)
    setSaid(result.message)
  }

  if (said) return <p className="report-said">{said}</p>

  if (!open) {
    return (
      <button type="button" className="link report-open" onClick={() => setOpen(true)}>
        Been here today? Tell the next person
      </button>
    )
  }

  return (
    <div className="report">
      <p className="report-q">How was it?</p>
      <div className="report-options">
        {ORDER.map((kind) => (
          <button
            key={kind}
            type="button"
            className="chip"
            disabled={busy !== null}
            onClick={() => send(kind)}
          >
            {busy === kind ? 'Sending…' : REPORT_LABELS[kind]}
          </button>
        ))}
      </div>
      <p className="report-note">
        Your location is used to work out whether you were plausibly there, and then
        thrown away. Nothing records where you have been.
      </p>
    </div>
  )
}
