import { useEffect, useMemo, useRef, useState } from 'react'
import { useEscape } from '@minormending/map-kit'
import { OrchardMap, type MapApi } from './OrchardMap'
import { OrchardDetail } from './OrchardDetail'
import { Legend } from './Legend'
import { SeasonBanner } from './SeasonBanner'
import { AuthButton } from './AuthButton'
import { AddOrchard } from './AddOrchard'
import { HAS_DB } from '../lib/db'
import { FILTERS, EMPTY_FILTERS, applyFilters, distanceM, milesLabel, tagLabels, type FilterState } from '../lib/filters'
import { TRAVEL_BANDS, travelTimes, withinBand, durationLabel, drivingLabel, type Origin, type TravelTimes } from '../lib/travel'
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

  /*
   * `origin` is where the visitor says they are travelling FROM, and it is
   * deliberately not `here`.
   *
   * `here` is the device's own position and is passed to the report box, where
   * it verifies that somebody saying "I was here today" was. An origin is a
   * pin the visitor drops anywhere they like, so letting the two be the same
   * value would turn a travel-planning control into a way to claim you are
   * standing in an orchard you have never been to.
   */
  const [origin, setOrigin] = useState<Origin | null>(null)
  const [pickingOrigin, setPickingOrigin] = useState(false)
  const [times, setTimes] = useState<TravelTimes | null>(null)
  const [travel, setTravel] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [band, setBand] = useState<number | null>(null)

  /*
   * One request per origin. OSRM answers for every orchard at once, so this is
   * not per-farm work, and the answer is cached for the session.
   */
  useEffect(() => {
    if (!origin) { setTimes(null); setTravel('idle'); return }
    const ac = new AbortController()
    setTravel('loading')
    travelTimes(origin, orchards, { signal: ac.signal })
      .then((t) => { setTimes(t); setTravel('ready') })
      .catch(() => {
        if (ac.signal.aborted) return
        // Degrade visibly. The list falls back to straight-line distance and
        // the band filter turns itself off rather than silently keeping farms
        // out of a list nobody can see the reason for.
        setTimes(null)
        setTravel('failed')
        setBand(null)
      })
    return () => ac.abort()
  }, [origin, orchards])

  const visible = useMemo(() => {
    const matched = applyFilters(orchards, filters)
      .filter((o) => withinBand(o, times, band))

    // By road when we know it, as the crow flies otherwise. `here` is only a
    // fallback ordering when the visitor has not named an origin.
    const from = origin ?? here
    if (times) {
      return [...matched].sort(
        (a, b) => (times.get(a.slug) ?? Infinity) - (times.get(b.slug) ?? Infinity),
      )
    }
    if (!from) return matched
    return [...matched].sort((a, b) => distanceM(from, a) - distanceM(from, b))
  }, [orchards, filters, here, origin, times, band])

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

  const active = filters.tags.length > 0 || filters.query.trim() !== '' || band !== null

  const useMyLocation = () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        setHere({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        setOrigin({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'your location' })
        setPickingOrigin(false)
      },
      () => setPickingOrigin(false),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000 },
    )
  }

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

          {/*
            * Travelling from. Two ways in, because the obvious one needs a
            * permission prompt that plenty of people decline and the map is
            * still useful to them.
            */}
          <div className="origin">
            {!origin ? (
              <p className="origin-ask">
                Travelling from{' '}
                <button type="button" className="link" onClick={useMyLocation}>
                  your location
                </button>
                {' or '}
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setPickingOrigin(true)
                    setPlacing(false)
                    // On a phone the panel covers the map, so "click the map"
                    // is an instruction the reader cannot follow until the
                    // list gets out of the way. Same move the list makes when
                    // you choose a farm.
                    setListOpen(false)
                  }}
                >
                  a point on the map
                </button>
                ?
              </p>
            ) : (
              <p className="origin-set">
                <span className="origin-dot" aria-hidden="true" />
                From <strong>{origin.label}</strong>
                {travel === 'loading' && <em> · working out drive times…</em>}
                {travel === 'failed' && (
                  <em className="origin-warn"> · drive times unavailable, showing straight-line distance</em>
                )}
                <button
                  type="button"
                  className="link"
                  onClick={() => { setOrigin(null); setBand(null) }}
                >
                  clear
                </button>
              </p>
            )}
            {pickingOrigin && (
              <p className="origin-ask">Click the map to say where you are starting from.</p>
            )}
          </div>

          {travel === 'ready' && (
            <div className="chips" role="group" aria-label="Driving time">
              {TRAVEL_BANDS.map((b) => {
                const on = band === b
                return (
                  <button
                    key={b}
                    type="button"
                    className={`chip ${on ? 'chip-on' : ''}`}
                    aria-pressed={on}
                    title={`Orchards about ${b} minutes' drive or less, without traffic`}
                    onClick={() => setBand(on ? null : b)}
                  >
                    ≤ {b < 60 ? `${b} min` : `${b / 60}h`}
                  </button>
                )
              })}
            </div>
          )}

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
            {/* Redundant once an origin is set: the list is already ordered
                by drive time, or by distance from that origin. */}
            {!here && !origin && (
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
                  {times?.get(o.slug) !== undefined
                    ? <em> · {durationLabel(times.get(o.slug)!)} drive</em>
                    : (origin ?? here) && <em> · {milesLabel(distanceM((origin ?? here)!, o))}</em>}
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
          origin={origin}
          placing={placing || pickingOrigin}
          onPlace={(at) => {
            if (pickingOrigin) {
              setOrigin({
                ...at,
                label: `${at.lat.toFixed(3)}, ${at.lng.toFixed(3)}`,
              })
              setPickingOrigin(false)
              return
            }
            setPlaced(at)
            setPlacing(false)
          }}
        />

        <Legend orchards={visible} />

        {placing && (
          <p className="placing-hint">Click the farm's position on the map</p>
        )}

        {pickingOrigin && (
          <p className="placing-hint">Click where you are travelling from</p>
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
            distance={
              (origin ?? here) ? milesLabel(distanceM((origin ?? here)!, chosen)) : null
            }
            drive={times?.get(chosen.slug) !== undefined
              ? drivingLabel(times.get(chosen.slug)!)
              : null}
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

