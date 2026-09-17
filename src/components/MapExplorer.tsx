import { useEffect, useMemo, useRef, useState } from 'react'
import { useEscape } from '@minormending/map-kit'
import { OrchardMap, type MapApi } from './OrchardMap'
import { OrchardDetail } from './OrchardDetail'
import { SeasonBanner } from './SeasonBanner'
import { AuthButton } from './AuthButton'
import { AddOrchard } from './AddOrchard'
import { HAS_DB } from '../lib/db'
import { FILTERS, EMPTY_FILTERS, applyFilters, distanceM, milesLabel, tagLabels, type FilterState } from '../lib/filters'
import type { Orchard, Tag } from '../lib/types'

interface Props {
  orchards: Orchard[]
  base: string
}

type Position = { lat: number; lng: number } | null

export function MapExplorer({ orchards, base }: Props) {
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [selected, setSelected] = useState<string | null>(null)
  const [here, setHere] = useState<Position>(null)
  const [listOpen, setListOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [placing, setPlacing] = useState(false)
  const [placed, setPlaced] = useState<Position>(null)
  const mapApi = useRef<MapApi | null>(null)

  const visible = useMemo(() => {
    const matched = applyFilters(orchards, filters)
    if (!here) return matched
    return [...matched].sort((a, b) => distanceM(here, a) - distanceM(here, b))
  }, [orchards, filters, here])

  const chosen = useMemo(
    () => orchards.find((o) => o.slug === selected) ?? null,
    [orchards, selected],
  )

  useEscape(() => setSelected(null))

  // Asked for once, on a tap, never on load. A permission prompt that appears
  // before somebody has decided they want to be here is a prompt they decline.
  const locate = () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => setHere({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {},
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000 },
    )
  }

  const toggle = (tag: Tag) =>
    setFilters((f) => ({
      ...f,
      tags: f.tags.includes(tag) ? f.tags.filter((t) => t !== tag) : [...f.tags, tag],
    }))

  const pick = (o: Orchard) => {
    setSelected(o.slug)
    mapApi.current?.flyTo(o.lng, o.lat)
    setListOpen(false)
  }

  // Deep links: /?at=<slug> opens straight on a place, which is what a shared
  // link has to do to be worth sharing.
  useEffect(() => {
    const slug = new URLSearchParams(window.location.search).get('at')
    if (!slug) return
    const target = orchards.find((o) => o.slug === slug)
    if (target) {
      setSelected(target.slug)
      // The map may not exist yet on first paint; try again after it does.
      const tick = setInterval(() => {
        if (mapApi.current) {
          mapApi.current.flyTo(target.lng, target.lat)
          clearInterval(tick)
        }
      }, 120)
      setTimeout(() => clearInterval(tick), 6000)
      return () => clearInterval(tick)
    }
  }, [orchards])

  const active = filters.tags.length > 0 || filters.query.trim() !== ''

  return (
    <div className="explorer">
      <aside className={`panel ${listOpen ? 'panel-open' : ''}`}>
        <SeasonBanner base={base} />
        <div className="panel-controls">
          <label className="search">
            <span className="visually-hidden">Search by name or town</span>
            <input
              type="search"
              placeholder="Name or town — try Warwick"
              value={filters.query}
              onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
            />
          </label>

          <div className="chips" role="group" aria-label="Filters">
            {FILTERS.map((f) => {
              const on = filters.tags.includes(f.key)
              return (
                <button
                  key={f.key}
                  type="button"
                  className={`chip ${on ? 'chip-on' : ''}`}
                  aria-pressed={on}
                  title={f.hint}
                  onClick={() => toggle(f.key)}
                >
                  {f.label}
                </button>
              )
            })}
          </div>

          <p className="count">
            <strong>{visible.length}</strong> of {orchards.length}
            {active && (
              <button type="button" className="link" onClick={() => setFilters(EMPTY_FILTERS)}>
                clear
              </button>
            )}
            {!here && (
              <button type="button" className="link" onClick={locate}>
                sort by distance
              </button>
            )}
          </p>
        </div>

        <ul className="list">
          {visible.map((o) => (
            <li key={o.slug}>
              <button
                type="button"
                className={`card ${o.slug === selected ? 'card-on' : ''}`}
                onClick={() => pick(o)}
              >
                <span className="card-name">{o.name}</span>
                <span className="card-where">
                  {[o.town, o.state].filter(Boolean).join(', ')}
                  {here && <em> · {milesLabel(distanceM(here, o))}</em>}
                </span>
                <span className="card-tags">{tagLabels(o).join(' · ') || 'No details yet'}</span>
              </button>
            </li>
          ))}
          {visible.length === 0 && (
            <li className="empty">
              <p>Nothing matches all of those.</p>
              <p className="muted">
                Filters narrow together, so ticking more shows fewer — one trip that
                does everything, rather than a longer list.
              </p>
            </li>
          )}
        </ul>

        {HAS_DB && (
          <div className="panel-foot">
            <AuthButton />
            <button type="button" className="link" onClick={() => { setAdding(true); setPlacing(true) }}>
              Add a missing orchard
            </button>
          </div>
        )}
      </aside>

      <div className="map-wrap">
        <OrchardMap
          orchards={visible}
          selected={selected}
          onSelect={setSelected}
          apiRef={mapApi}
          placing={placing}
          onPlace={(at) => { setPlaced(at); setPlacing(false) }}
        />

        {placing && (
          <p className="placing-hint">Click the farm's position on the map</p>
        )}

        {adding && (
          <AddOrchard
            at={placed}
            onPick={() => setPlacing(true)}
            onClose={() => { setAdding(false); setPlacing(false) }}
          />
        )}
        {chosen && (
          <OrchardDetail
            orchard={chosen}
            base={base}
            onClose={() => setSelected(null)}
            distance={here ? milesLabel(distanceM(here, chosen)) : null}
            position={here}
          />
        )}
      </div>

      <button
        type="button"
        className="list-toggle"
        onClick={() => setListOpen((v) => !v)}
        aria-expanded={listOpen}
      >
        {listOpen ? 'Map' : `List (${visible.length})`}
      </button>
    </div>
  )
}

