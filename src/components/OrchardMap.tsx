import { useEffect, useRef } from 'react'
import maplibregl, { type Map as MlMap, type GeoJSONSource } from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'
import { CARTO_DARK, CARTO_LIGHT } from '@minormending/map-kit'
import type { Orchard } from '../lib/types'
import { DEFAULT_CENTER, DEFAULT_ZOOM } from '../lib/orchards'

const SOURCE = 'orchards'

/** What the container is allowed to ask the map to do. */
export interface MapApi {
  flyTo(lng: number, lat: number): void
}

interface Props {
  orchards: Orchard[]
  selected: string | null
  onSelect: (slug: string | null) => void
  /** Filled in once the map exists, so the list can move it without the
   *  container having to know anything about MapLibre. */
  apiRef?: { current: MapApi | null }
  /** While true, a click on the map places a pin instead of selecting one. */
  placing?: boolean
  onPlace?: (at: { lat: number; lng: number }) => void
}

function toGeoJSON(orchards: Orchard[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: orchards.map((o) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [o.lng, o.lat] },
      properties: {
        slug: o.slug,
        name: o.name,
        // The dot's colour says what the place is, so the map is readable
        // before anything is clicked. Pick-your-own wins when a place is both,
        // because it is the thing people came here to find.
        kind: o.tags.includes('pick_your_own')
          ? 'upick'
          : o.tags.includes('craft_cider') || o.tags.includes('fresh_cider')
            ? 'cider'
            : 'other',
      },
    })),
  }
}

export function OrchardMap({ orchards, selected, onSelect, apiRef, placing, onPlace }: Props) {
  const holder = useRef<HTMLDivElement>(null)
  const map = useRef<MlMap | null>(null)
  const ready = useRef(false)
  // Kept in refs so the handlers registered once on `load` always see current
  // values rather than the ones from the first render. The map takes a moment
  // to load its style, and a filter ticked in that window would otherwise be
  // applied to nothing and then silently dropped.
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const orchardsRef = useRef(orchards)
  orchardsRef.current = orchards
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const placingRef = useRef(placing)
  placingRef.current = placing
  const onPlaceRef = useRef(onPlace)
  onPlaceRef.current = onPlace

  useEffect(() => {
    if (!holder.current || map.current) return

    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
    const m = new maplibregl.Map({
      container: holder.current,
      style: dark ? CARTO_DARK : CARTO_LIGHT,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      attributionControl: { compact: true },
    })
    map.current = m

    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    m.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: false,
      }),
      'top-right',
    )

    m.on('load', () => {
      m.addSource(SOURCE, { type: 'geojson', data: toGeoJSON(orchardsRef.current) })

      m.addLayer({
        id: 'orchard-dots',
        type: 'circle',
        source: SOURCE,
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            6, 4,
            10, 7,
            14, 10,
          ],
          'circle-color': [
            'match', ['get', 'kind'],
            'upick', '#C2384A',
            'cider', '#C8792A',
            /* other */ '#4A7C4E',
          ],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#FFFFFF',
          'circle-opacity': 0.92,
        },
      })

      // A separate layer rather than a paint expression on the one above, so
      // the selected dot draws on top of its neighbours instead of under them.
      m.addLayer({
        id: 'orchard-selected',
        type: 'circle',
        source: SOURCE,
        filter: ['==', ['get', 'slug'], selectedRef.current ?? ''],
        paint: {
          'circle-radius': 12,
          'circle-color': '#1F2933',
          'circle-stroke-width': 3,
          'circle-stroke-color': '#FFFFFF',
        },
      })

      m.on('click', 'orchard-dots', (e) => {
        // While placing a new pin, a click on an existing one is still a
        // placement — otherwise the one spot you cannot put a farm is next to
        // another farm, which is exactly where orchards are.
        if (placingRef.current) return
        const slug = e.features?.[0]?.properties?.slug
        if (typeof slug === 'string') onSelectRef.current(slug)
      })
      // Tapping the background closes the sheet, which is the other half of
      // "anything covering the screen needs a way out".
      m.on('click', (e) => {
        if (placingRef.current) {
          onPlaceRef.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng })
          return
        }
        const hits = m.queryRenderedFeatures(e.point, { layers: ['orchard-dots'] })
        if (hits.length === 0) onSelectRef.current(null)
      })
      m.on('mouseenter', 'orchard-dots', () => { m.getCanvas().style.cursor = 'pointer' })
      m.on('mouseleave', 'orchard-dots', () => { m.getCanvas().style.cursor = '' })

      ready.current = true
    })

    /*
     * MapLibre measures its container once and then trusts that measurement.
     * If the container is zero-height at mount — a stylesheet still landing, a
     * parent that has not resolved its grid row yet — the map builds a canvas
     * of nothing and never revisits it, which reads as "the tiles are broken"
     * rather than as a layout bug. This already happened once here.
     */
    const ro = new ResizeObserver(() => m.resize())
    ro.observe(holder.current)

    if (apiRef) {
      apiRef.current = {
        flyTo(lng, lat) {
          // Never zoom out to get there: somebody who has zoomed in to read
          // street names has told you what detail they want.
          m.flyTo({ center: [lng, lat], zoom: Math.max(m.getZoom(), 11), speed: 1.2 })
        },
      }
    }

    return () => {
      ro.disconnect()
      m.remove()
      map.current = null
      ready.current = false
      if (apiRef) apiRef.current = null
    }
    // Built once. Data changes are pushed through setData below rather than by
    // rebuilding the map, which would throw away the user's pan and zoom every
    // time they ticked a filter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const m = map.current
    if (!m || !ready.current) return
    const src = m.getSource(SOURCE) as GeoJSONSource | undefined
    src?.setData(toGeoJSON(orchards))
  }, [orchards])

  useEffect(() => {
    const m = map.current
    if (!m || !ready.current || !m.getLayer('orchard-selected')) return
    m.setFilter('orchard-selected', ['==', ['get', 'slug'], selected ?? ''])
  }, [selected])

  return <div ref={holder} className="map-canvas" aria-label="Map of orchards" />
}
