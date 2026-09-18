import { useMemo, useState } from 'react'
import { KINDS, kindOf } from '../lib/kinds'
import type { Orchard } from '../lib/types'

/**
 * What the colours mean, with a count of what is on screen.
 *
 * The counts are of the CURRENTLY VISIBLE orchards, not the whole dataset, so
 * the legend answers "what am I looking at" rather than "what exists". Tick a
 * filter and it follows.
 *
 * It sits top-left because everything else in the map already has a corner:
 * MapLibre's zoom and geolocate controls are top-right, the detail sheet is
 * bottom-left, the attribution is bottom-right, and on a phone the list button
 * is bottom-centre and the placing hint is top-centre.
 */
export function Legend({ orchards }: { orchards: Orchard[] }) {
  const [open, setOpen] = useState(true)

  const counts = useMemo(() => {
    const n = new Map(KINDS.map((k) => [k.kind, 0]))
    for (const o of orchards) n.set(kindOf(o), (n.get(kindOf(o)) ?? 0) + 1)
    return n
  }, [orchards])

  if (!open) {
    return (
      <button
        type="button"
        className="legend-show"
        onClick={() => setOpen(true)}
        aria-label="Show what the map colours mean"
      >
        Key
      </button>
    )
  }

  return (
    <aside className="legend" aria-label="What the colours mean">
      <button
        type="button"
        className="legend-hide"
        onClick={() => setOpen(false)}
        aria-label="Hide the key"
      >
        ×
      </button>
      <ul>
        {KINDS.map((k) => (
          <li key={k.kind}>
            <span
              className="legend-dot"
              style={{ background: k.colour }}
              aria-hidden="true"
            />
            <span className="legend-label">
              {k.label}
              {/* The meaning is the title rather than always-visible text: three
                  full sentences would make this a paragraph sitting on the map. */}
              <em title={k.meaning}> {counts.get(k.kind) ?? 0}</em>
            </span>
          </li>
        ))}
      </ul>
      <p className="legend-note">
        Green means nobody has told us, not that there is no picking.
      </p>
    </aside>
  )
}
