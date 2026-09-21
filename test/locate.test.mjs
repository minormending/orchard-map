/**
 * The address rules the browser uses, and the fact that there are two copies.
 *
 * `src/lib/locate.ts` restates the query-cleaning rules from
 * `scripts/lib/directory.mjs`, because scripts do not import from `src/`
 * anywhere in this repo and a feature is a poor reason to be the first. The
 * cost of a second copy is that it can drift; this pays that cost explicitly
 * by running both over the same cases and failing when they disagree.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as browser from '../src/lib/locate.ts'
import * as script from '../scripts/lib/directory.mjs'

/*
 * Everything the state directories actually write, plus what a person typing
 * into a form plausibly writes. A case added here is checked against both
 * implementations at once, which is the point.
 */
const STREETS = [
  '403 Orchard Hill Road (Rte. 169)',
  '1393 North Road, off Rte. 101',
  '55 Bishop Lane, just off Route 6A',
  'Rt. 322 Meriden-Waterbury Road',
  'Route 169',
  'Rt. 322',
  '322 Meriden-Waterbury Road',
  '336 Long Bottom Road',
  '19 Rose Hill Farm',
  '295 Matson Hill Road',
  '  17 Elm Street  ',
  'State Route 9W',
  'US 44 Sharon Turnpike',
  'Hwy. 6 Depot Road',
  '',
]

test('the two copies of streetForGeocoder agree', () => {
  for (const s of STREETS) {
    assert.equal(
      browser.streetForGeocoder(s),
      script.streetForGeocoder(s) ?? '',
      `disagreed on ${JSON.stringify(s)}`,
    )
  }
})

test('the two copies of hasHouseNumber agree', () => {
  for (const s of STREETS) {
    const cleaned = browser.streetForGeocoder(s)
    assert.equal(
      browser.hasHouseNumber(cleaned),
      script.hasHouseNumber(cleaned),
      `disagreed on ${JSON.stringify(s)}`,
    )
  }
})

test('the town-centre threshold is the same number in both', () => {
  assert.equal(browser.TOWN_CENTRE_M, script.TOWN_CENTRE_M)
})

/*
 * The one deliberate difference, recorded so it is not mistaken for drift.
 * The script takes whatever a scraped directory row holds, including null, and
 * hands it back unchanged. The browser copy is only ever called with an input
 * element's value, so it is typed `string` and normalises the empty case.
 */
test('empty input is the one place they differ, on purpose', () => {
  assert.equal(browser.streetForGeocoder(null), '')
  assert.equal(script.streetForGeocoder(null), null)
})

test('a route number for a driver is not part of the query', () => {
  assert.equal(browser.streetForGeocoder('403 Orchard Hill Road (Rte. 169)'), '403 Orchard Hill Road')
  assert.equal(browser.streetForGeocoder('Rt. 322 Meriden-Waterbury Road'), 'Meriden-Waterbury Road')
})

test('an address that is only a route number survives whole', () => {
  assert.equal(browser.streetForGeocoder('Route 169'), 'Route 169')
  assert.equal(browser.streetForGeocoder('Rt. 322'), 'Rt. 322')
})

/*
 * The precision rule, which is the part a visitor actually sees. Claiming
 * 'exact' is the one thing this must never do: null means nobody recorded a
 * precision, and inventing exactness for a rooftop guess is the failure the
 * whole precision column exists to prevent.
 */
test('a house number claims nothing, a bare road says approximate', () => {
  const precision = (s) =>
    browser.hasHouseNumber(browser.streetForGeocoder(s)) ? null : 'approximate'

  assert.equal(precision('403 Orchard Hill Road (Rte. 169)'), null)
  assert.equal(precision('1393 North Road, off Rte. 101'), null)
  assert.equal(precision('Rt. 322 Meriden-Waterbury Road'), 'approximate')
  assert.equal(precision('Route 169'), 'approximate')
  assert.equal(precision(''), 'approximate')
})
