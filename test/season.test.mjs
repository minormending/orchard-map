/**
 * The seasonal claims, which are the most falsifiable thing this map says.
 *
 * The failure guarded hardest here is the one that motivated separating the
 * two date sources in the first place: the association publishes an
 * "availability" line meaning when an apple is on sale out of cold storage —
 * Braeburn reads "October through April". If that ever leaks into the picking
 * window, this map starts telling people to go and pick Braeburns in March.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  VARIETIES, ripeNow, comingSoon, finishingSoon,
  seasonPhase, seasonHeadline, windowLabel, dayOfYear,
} from '../src/lib/season.ts'

const on = (m, d) => new Date(2026, m - 1, d)

test('every variety has a picking window, and it is inside the season', () => {
  for (const v of VARIETIES) {
    assert.ok(v.start_doy !== null, `${v.name} has no window`)
    // August 1 is day 213, November 30 is day 334. Nothing is picked outside
    // that, and anything claiming to be is storage availability that leaked in.
    assert.ok(v.start_doy >= 213, `${v.name} starts before August (doy ${v.start_doy})`)
    assert.ok(v.end_doy <= 334, `${v.name} ends after November (doy ${v.end_doy})`)
    assert.ok(v.end_doy > v.start_doy, `${v.name} ends before it starts`)
  }
})

test('no picking window is longer than about three months', () => {
  // The specific regression: "October through April" is 200+ days and is a
  // shop-shelf figure, not a tree.
  for (const v of VARIETIES) {
    const span = v.end_doy - v.start_doy
    assert.ok(span <= 95, `${v.name} claims a ${span}-day picking window`)
  }
})

test('nothing is ripe in March', () => {
  assert.deepEqual(ripeNow(on(3, 15)), [])
  assert.equal(seasonPhase(on(3, 15)), 'before')
})

test('mid-September is peak, and the famous ones are on', () => {
  const names = ripeNow(on(9, 17)).map((v) => v.name)
  assert.ok(names.includes('Honeycrisp'), `Honeycrisp missing from ${names.join(', ')}`)
  assert.ok(names.includes('McIntosh'), `McIntosh missing from ${names.join(', ')}`)
  assert.ok(names.includes('Gala'))
  assert.equal(seasonPhase(on(9, 17)), 'peak')
})

test('early October picks up the later varieties', () => {
  const names = ripeNow(on(10, 8)).map((v) => v.name)
  assert.ok(names.includes('Macoun'))
  assert.ok(names.includes('Cortland'))
  // And has lost the very earliest.
  assert.ok(!names.includes('Jersey Mac'))
})

test('the season closes and says so', () => {
  assert.equal(seasonPhase(on(12, 20)), 'after')
  assert.match(seasonHeadline(on(12, 20)), /over for this year/)
})

test('the headline never states a farm-level fact', () => {
  const line = seasonHeadline(on(9, 17))
  // "Usually" is the load-bearing word; losing it turns a regional average
  // into a claim about wherever the reader is about to drive.
  assert.match(line, /Usually/)
  assert.match(line, /Honeycrisp|Gala|McIntosh/)
})

test('coming soon and finishing soon are disjoint from and adjacent to now', () => {
  const day = on(9, 17)
  const now = new Set(ripeNow(day).map((v) => v.slug))
  for (const v of comingSoon(day)) {
    assert.ok(!now.has(v.slug), `${v.name} is both ripe and not yet started`)
  }
  for (const v of finishingSoon(day)) {
    assert.ok(now.has(v.slug), `${v.name} is finishing but not currently ripe`)
  }
})

test('window labels read the way people say them', () => {
  // The thirds are 1–10 early, 11–20 mid, 21+ late. Honeycrisp opens on the
  // 10th, which lands on the boundary and reads as early September.
  const honeycrisp = VARIETIES.find((v) => v.slug === 'honeycrisp')
  assert.equal(windowLabel(honeycrisp), 'early September to early October')

  const macoun = VARIETIES.find((v) => v.slug === 'macoun')
  assert.equal(windowLabel(macoun), 'late September to mid October')
})

test('dayOfYear agrees with a known date', () => {
  assert.equal(dayOfYear(new Date(2026, 0, 1)), 1)
  assert.equal(dayOfYear(new Date(2026, 8, 17)), 260)
})
