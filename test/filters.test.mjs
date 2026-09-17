/**
 * The filter rules, which are the product.
 *
 * The one that is easy to get wrong and expensive to get wrong is that tags
 * AND rather than OR. OR is the more obvious implementation and it makes every
 * extra tick return *more* results, which is the opposite of what ticking a
 * filter is for.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyFilters, matches, distanceM, milesLabel } from '../src/lib/filters.ts'

const at = (name, town, tags) => ({
  id: name, slug: name, name, town, state: 'NY', address: null, zip: null,
  phone: null, website: null, lat: 41.5, lng: -74, tags,
  import_source: 'test', import_id: '1', import_licence: 'unstated', imported_at: '2026-09-17',
})

const FARMS = [
  at('Hilltop', 'Warwick', ['pick_your_own', 'fresh_cider']),
  at('Stonewall', 'Warwick', ['craft_cider']),
  at('Bramble', 'Accord', ['pick_your_own', 'craft_cider', 'farm_market']),
  at('Quiet Acre', 'Milton', []),
]

test('no filters returns everything', () => {
  assert.equal(applyFilters(FARMS, { tags: [], query: '' }).length, 4)
})

test('tags narrow together rather than widening', () => {
  const both = applyFilters(FARMS, { tags: ['pick_your_own', 'craft_cider'], query: '' })
  assert.deepEqual(both.map((f) => f.name), ['Bramble'])

  // The failure this guards: OR would return three here, and each extra tick
  // would grow the list.
  const one = applyFilters(FARMS, { tags: ['pick_your_own'], query: '' })
  assert.equal(one.length, 2)
  assert.ok(both.length < one.length, 'adding a tag must never add results')
})

test('an orchard with no tags survives an empty filter but no tag filter', () => {
  assert.equal(matches(FARMS[3], { tags: [], query: '' }), true)
  assert.equal(matches(FARMS[3], { tags: ['farm_market'], query: '' }), false)
})

test('search matches name, town and is case- and accent-insensitive', () => {
  assert.equal(applyFilters(FARMS, { tags: [], query: 'warwick' }).length, 2)
  assert.equal(applyFilters(FARMS, { tags: [], query: 'HILLTOP' }).length, 1)
  assert.equal(applyFilters(FARMS, { tags: [], query: '  bramble ' }).length, 1)
})

test('every search word must match, so two words narrow', () => {
  // "warwick hilltop" is one place, not everything in Warwick plus everything
  // called Hilltop.
  assert.deepEqual(
    applyFilters(FARMS, { tags: [], query: 'warwick hilltop' }).map((f) => f.name),
    ['Hilltop'],
  )
})

test('search and tags combine', () => {
  const r = applyFilters(FARMS, { tags: ['craft_cider'], query: 'warwick' })
  assert.deepEqual(r.map((f) => f.name), ['Stonewall'])
})

test('distance is roughly right and rounds readably', () => {
  // Poughkeepsie to Kingston, about 25 miles.
  const d = distanceM({ lat: 41.7004, lng: -73.9209 }, { lat: 41.9270, lng: -73.9974 })
  assert.ok(d > 24_000 && d < 28_000, `expected ~26km, got ${Math.round(d)}m`)
  assert.equal(milesLabel(1609.34), '1.0 mi')
  assert.equal(milesLabel(80_467), '50 mi')
})
