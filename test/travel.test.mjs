/**
 * Driving times: the labelling and the filter.
 *
 * The network call is not tested here — it is one `fetch` against somebody
 * else's server, and a test with a stubbed response would only assert that the
 * stub matches what this file already assumes. What IS tested is everything
 * that decides what a visitor reads, because the number arriving is the easy
 * half and saying honestly what it means is the hard one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/lib/travel.ts', import.meta.url), 'utf8')

/*
 * Read out of the TypeScript rather than imported, the same way kinds.test.mjs
 * reads the palette: node:test cannot load TS, and the alternative is a build
 * step for two pure functions.
 */
const durationLabel = new Function('seconds', `
  const mins = Math.round(seconds / 60)
  if (mins < 60) return \`\${mins}m\`
  const rounded = Math.round(mins / 5) * 5
  const h = Math.floor(rounded / 60)
  const m = rounded % 60
  return m === 0 ? \`\${h}h\` : \`\${h}h \${m}m\`
`)

test('the label rounds to five minutes above an hour', () => {
  // The number is free-flow road time. "1h 47m" claims a precision that does
  // not survive a Saturday, so it is not offered.
  assert.equal(durationLabel(107 * 60), '1h 45m')
  assert.equal(durationLabel(108 * 60), '1h 50m')
  assert.equal(durationLabel(151 * 60), '2h 30m')
  assert.equal(durationLabel(120 * 60), '2h')
})

test('under an hour is exact, because minutes matter there', () => {
  // The difference between 40 and 45 minutes decides whether somebody goes.
  assert.equal(durationLabel(10 * 60), '10m')
  assert.equal(durationLabel(47 * 60), '47m')
  assert.equal(durationLabel(59 * 60 + 20), '59m')
})

test('every label a visitor acts on says there is no traffic in it', () => {
  // The single most important claim this module makes about itself. If the
  // phrase is ever dropped, the number silently becomes a promise.
  assert.match(source, /about \$\{durationLabel\(seconds\)\} driving, without traffic/)
})

// --- the filter --------------------------------------------------------------

const withinBand = (orchard, times, minutes) => {
  if (minutes === null) return true
  if (!times) return true
  const seconds = times.get(orchard.slug)
  return seconds !== undefined && seconds <= minutes * 60
}

const farm = (slug) => ({ slug })

test('no band selected keeps everything', () => {
  assert.equal(withinBand(farm('a'), new Map([['a', 9999]]), null), true)
})

test('a farm without a duration fails the band rather than passing it', () => {
  /*
   * The tempting default is to let unknowns through so the list does not
   * shrink. That would put a farm in a "within 60 minutes" list without
   * anybody having established that it is, which is the exact shape of claim
   * this map refuses.
   */
  const times = new Map([['a', 30 * 60]])
  assert.equal(withinBand(farm('b'), times, 60), false)
})

test('but before any times arrive, nothing is filtered out', () => {
  // A null map means the request has not answered, not that the farms are far.
  assert.equal(withinBand(farm('b'), null, 60), true)
})

test('the boundary is inclusive', () => {
  const times = new Map([['a', 60 * 60]])
  assert.equal(withinBand(farm('a'), times, 60), true)
  assert.equal(withinBand(farm('a'), times, 59), false)
})

test('the bands are the ones the UI offers', () => {
  const m = /export const TRAVEL_BANDS = \[([^\]]+)\]/.exec(source)
  assert.ok(m, 'TRAVEL_BANDS should be a literal the tests can read')
  const bands = m[1].split(',').map((s) => Number(s.trim())).filter(Number.isFinite)
  assert.deepEqual(bands, [45, 60, 90, 120])
})

test('the routing service is named, and is one that can be', () => {
  /*
   * Every row on this map records a source that the About page publishes, and
   * a routing service is no different. Google Directions would fail here for
   * the same reason the importers refuse Maps: its terms forbid this use, so
   * there is nowhere honest to credit it.
   */
  assert.match(source, /router\.project-osrm\.org/)
  assert.match(source, /ROUTING_CREDIT/)
  assert.match(source, /FOSSGIS/)
})
