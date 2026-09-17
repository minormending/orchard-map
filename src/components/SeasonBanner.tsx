import { useMemo, useState } from 'react'
import { ripeNow, finishingSoon, comingSoon, seasonPhase, windowLabel } from '../lib/season'

/**
 * What is usually ripe, right now.
 *
 * Computed in the browser rather than at build time, and that is the point. A
 * static build freezes "this week" at whatever week it was deployed, and the
 * first thing this map says would be wrong by the following Saturday. The
 * nightly rebuild keeps the crawlable HTML fresh; this keeps the human's copy
 * correct between rebuilds.
 */
export function SeasonBanner({ base }: { base: string }) {
  const [open, setOpen] = useState(false)

  const { ripe, ending, soon, phase } = useMemo(() => {
    const now = new Date()
    return {
      ripe: ripeNow(now),
      ending: finishingSoon(now),
      soon: comingSoon(now),
      phase: seasonPhase(now),
    }
  }, [])

  if (phase === 'before' || phase === 'after') {
    return (
      <div className="season season-off">
        <p>
          {phase === 'before'
            ? 'Picking season has not started yet — it opens in August.'
            : 'Picking season is over for this year. It starts again in August.'}
        </p>
      </div>
    )
  }

  const endingSlugs = new Set(ending.map((v) => v.slug))

  return (
    <div className="season">
      <button
        type="button"
        className="season-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="season-label">Usually ripe this week</span>
        <span className="season-names">
          {ripe.length > 0
            ? /* Collapsed, this is a headline, not a list — eight names wrap to
                 four lines and push the filters off a phone screen. */
              ripe.slice(0, 3).map((v) => v.name).join(' · ') +
              (ripe.length > 3 ? ` · and ${ripe.length - 3} more` : '')
            : 'Between varieties — ring ahead'}
        </span>
        <span className="season-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="season-body">
          {/*
            The caveat is not decoration. These are regional averages: a warm
            spring moves the whole calendar a week, and any one farm sits a week
            either side of the region. The map knows what is typical for the
            Hudson Valley in this week of the year — it does not know what is on
            the trees at the farm you are about to drive to.
          */}
          <p className="season-caveat">
            Typical Hudson Valley timing, not a report from any particular farm.
            Seasons move a week or two with the weather — <strong>ring ahead</strong>.
          </p>

          {ripe.length > 0 && (
            <ul className="season-list">
              {ripe.map((v) => (
                <li key={v.slug}>
                  <strong>{v.name}</strong>
                  <span className="season-when"> {windowLabel(v)}</span>
                  {endingSlugs.has(v.slug) && <em className="season-ending"> · finishing soon</em>}
                </li>
              ))}
            </ul>
          )}

          {soon.length > 0 && (
            <p className="season-soon">
              Starting within a fortnight: {soon.map((v) => v.name).join(', ')}.
            </p>
          )}

          <a href={`${base}varieties`}>The whole picking calendar →</a>
        </div>
      )}
    </div>
  )
}
