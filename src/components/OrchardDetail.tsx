import { tagLabels } from '../lib/filters'
import { addressLine, directionsUrl, orchardUrl, telUrl } from '../lib/orchards'
import type { Orchard } from '../lib/types'

interface Props {
  orchard: Orchard
  base: string
  distance: string | null
  onClose: () => void
}

export function OrchardDetail({ orchard, base, distance, onClose }: Props) {
  const tags = tagLabels(orchard)
  const where = addressLine(orchard)

  return (
    <section className="sheet" aria-label={orchard.name}>
      <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
        ×
      </button>

      <h2>{orchard.name}</h2>
      {where && (
        <p className="sheet-where">
          {where}
          {distance && <em> · {distance} away</em>}
        </p>
      )}

      {tags.length > 0 && (
        <ul className="sheet-tags">
          {tags.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}

      <div className="sheet-actions">
        <a className="button" href={directionsUrl(orchard)} target="_blank" rel="noreferrer">
          Directions
        </a>
        {orchard.phone && (
          <a className="button button-quiet" href={telUrl(orchard.phone)}>
            {orchard.phone}
          </a>
        )}
        {orchard.website && (
          <a
            className="button button-quiet"
            href={orchard.website}
            target="_blank"
            rel="noreferrer nofollow"
          >
            Website
          </a>
        )}
      </div>

      {/*
        The most important sentence on the page.

        Everything above came from a trade-association listing, which is a
        roster rather than a report: it says this farm exists and sells apples,
        not that anybody can pick them this weekend. Saying so is what separates
        this from a map that quietly implies it knows.
      */}
      <p className="sheet-caveat">
        Hours and whether picking is open <strong>have not been checked</strong>.
        {orchard.website ? ' Ring ahead or check their site before driving.' : ' Ring ahead before driving.'}
      </p>

      <a className="sheet-more" href={orchardUrl(base, orchard.slug)}>
        Everything we know about {orchard.name} →
      </a>
    </section>
  )
}
