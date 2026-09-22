import { useEffect, useRef } from 'react'
import { tagLabels } from '../lib/filters'
import { ReportBox } from './ReportBox'
import { VisitorFacts } from './VisitorFacts'
import { FlagLink } from './FlagLink'
import { addressLine, directionsUrl, orchardUrl, telUrl } from '../lib/orchards'
import type { Orchard } from '../lib/types'

interface Props {
  orchard: Orchard
  base: string
  distance: string | null
  /** Already phrased, and already says there is no traffic in it. */
  drive?: string | null
  position: { lat: number; lng: number } | null
  onClose: () => void
}

export function OrchardDetail({ orchard, base, distance, drive, position, onClose }: Props) {
  const tags = tagLabels(orchard)
  const where = addressLine(orchard)

  /*
   * Focus moves here when the sheet opens, and that is not a nicety.
   *
   * The sheet renders after the whole list in the DOM, so picking a farm and
   * leaving focus on the card left the panel 107 tab stops away with the list
   * filtered to 100 — around 300 with no filter — and nothing said it had
   * appeared. Measured on the live site, not guessed. For anybody not using a
   * mouse the detail panel was effectively unreachable.
   *
   * The section takes focus rather than the close button: it carries
   * aria-label={orchard.name}, so what gets announced is the farm you chose
   * rather than the word "Close". `tabindex=-1` makes it focusable
   * programmatically without adding a stop to everyone else's tab order.
   *
   * Re-runs on slug so that picking a second farm from the map, with the
   * sheet already open, announces the new one instead of staying silent.
   */
  /*
   * And hands focus back when it closes.
   *
   * Taking focus without returning it is the other half of the same bug: with
   * the sheet focused, closing it unmounted the focused element and dropped
   * focus to <body>, which puts a keyboard user back at the top of the
   * document needing to tab through the list again to reach where they were.
   * Before the sheet took focus at all this could not happen, so the fix above
   * created it — caught by closing the sheet and looking, not by reasoning.
   *
   * Mount and unmount only, deliberately: picking a different farm reuses this
   * component rather than remounting it — there is no key on it — so the
   * opener recorded here stays the card that opened the sheet in the first
   * place, which is the one worth going back to.
   *
   * `document.contains` because the opener may be gone by the time we return:
   * a farm can be chosen from the map, then filtered out of the list while the
   * sheet is open, and focusing a detached node silently sends focus to <body>
   * — exactly what this exists to prevent.
   */
  const opener = useRef<Element | null>(null)
  useEffect(() => {
    opener.current = document.activeElement
    return () => {
      const el = opener.current
      /* Not <body>: some browsers do not focus a button when it is clicked
         with a mouse, so the opener can be the body itself, and handing focus
         back to it is the same as not handing it back at all. */
      if (el instanceof HTMLElement && el !== document.body && document.contains(el)) el.focus()
    }
  }, [])

  /*
   * Declared AFTER the effect above, and that order is the whole of it.
   *
   * React runs effects in declaration order. With the focus call first, the
   * opener effect ran second and recorded what was focused by then — the sheet
   * itself. On close it tried to hand focus back to the element it was
   * unmounting, `document.contains` said no, and focus fell to <body>: the
   * exact bug this pair exists to fix, reintroduced by writing them the wrong
   * way round. It looked correct and tested wrong.
   */
  const sheet = useRef<HTMLElement>(null)
  useEffect(() => { sheet.current?.focus() }, [orchard.slug])

  return (
    <section className="sheet" aria-label={orchard.name} ref={sheet} tabIndex={-1}>
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

      {/*
        Next to the address and above Directions, because it is the number
        somebody decides on. The phrase "without traffic" travels with it from
        lib/travel.ts rather than being added here, so there is one place that
        can drop it.
      */}
      {drive && <p className="sheet-drive">{drive}</p>}

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
        The sheet has its own Directions button, so it needs its own version of
        this — a visitor who taps it from the map never sees the farm's page.
        Shorter than the page's wording because the sheet is a summary and the
        address is printed two lines above it.
      */}
      {orchard.position_precision === 'approximate' && (
        <p className="sheet-caveat">
          <strong>This pin is approximate.</strong> Addressed from the road
          rather than a house number, so Directions will land on the right road,
          not the gate.
        </p>
      )}

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

      <ReportBox orchard={orchard} position={position} />
      <VisitorFacts orchard={orchard} />

      <a className="sheet-more" href={orchardUrl(base, orchard.slug)}>
        Everything we know about {orchard.name} →
      </a>
      <FlagLink orchard={orchard} />
    </section>
  )
}
