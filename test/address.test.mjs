/**
 * Telling a street line from a whole address.
 *
 * The cases that matter are not the ones that split. They are the ten
 * comma-carrying addresses already on the map, every one of which is a suite
 * or building qualifier that must survive untouched — a rule that trims
 * "18 W Main St, Ste #1" down to "18 W Main St" has taken away the only part
 * that finds the door.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { splitAddress, repeatsPlace } from '../src/lib/address.ts'

const ORCHARDS = JSON.parse(
  readFileSync(new URL('../src/data/orchards.json', import.meta.url), 'utf8'),
)

test('the address that started this', () => {
  // Abma's Farm Market, as submitted on 21 September.
  assert.deepEqual(splitAddress('700 Lawlins Rd, Wyckoff, NJ 07481'), {
    street: '700 Lawlins Rd',
    town: 'Wyckoff',
    state: 'NJ',
    zip: '07481',
  })
})

test('the shapes people actually write', () => {
  // One comma or two, zip or no zip, lower case or not.
  assert.deepEqual(splitAddress('700 Lawlins Rd, Wyckoff NJ 07481'),
    { street: '700 Lawlins Rd', town: 'Wyckoff', state: 'NJ', zip: '07481' })
  assert.deepEqual(splitAddress('700 Lawlins Rd, Wyckoff, NJ'),
    { street: '700 Lawlins Rd', town: 'Wyckoff', state: 'NJ', zip: null })
  assert.deepEqual(splitAddress('  700 Lawlins Rd , Wyckoff , nj 07481-1234 '),
    { street: '700 Lawlins Rd', town: 'Wyckoff', state: 'NJ', zip: '07481-1234' })
  // A street with its own comma keeps it; only the tail comes away.
  assert.deepEqual(splitAddress('18 W Main St, Ste #1, Beacon, NY 12508'),
    { street: '18 W Main St, Ste #1', town: 'Beacon', state: 'NY', zip: '12508' })
})

/*
 * The whole reason this is not a comma split.
 */
test('a suite, a building or a route number is part of the street', () => {
  for (const street of [
    '18 W Main St, Ste #1',
    '8 Winkler Rd, Building 3',
    '52-05 Flushing Ave., Suite 209',
    '100 Jericho Tpke, Box 648',
    '150 Water St, Basement Level',
    '817 Broadway, 10th Floor',
    '200 Wilson St, Building E, Unit 3',
    '780 E 133rd St, 1st Fl',
    '2711 Sound Ave, Unit C1 & C2',
    '1355 Boston Post Road, US Rte. 1, I-95 Exit 57',
    'Greenwich Street &, Reade St',
  ]) {
    assert.equal(splitAddress(street), null, `would have cut "${street}"`)
  }
})

test('two letters that are not a state are two letters', () => {
  // `BB` is a unit, not Barbados, and this form does not offer it either way.
  assert.equal(splitAddress('12 Oak Rd, Unit BB'), null)
  // Vermont is a real state and not one this map takes submissions for, so
  // there is nowhere to put it and nothing is moved.
  assert.equal(splitAddress('5 Maple Ln, Brattleboro, VT 05301'), null)
})

test('nothing to split is null, not a half answer', () => {
  for (const raw of ['', '   ', null, undefined, '700 Lawlins Rd', 'Wyckoff, NJ']) {
    assert.equal(splitAddress(raw), null, `${JSON.stringify(raw)}`)
  }
})

/*
 * The strongest case available: every street line the map already publishes
 * has to come through unchanged. If this rule would cut one of them, the rule
 * is wrong — those addresses are how people find the farm.
 */
test('no address already on the map would be cut', () => {
  const addresses = ORCHARDS.map((o) => o.address).filter(Boolean)
  assert.ok(addresses.length > 250, `expected the bundled data, saw ${addresses.length}`)
  for (const address of addresses) {
    assert.equal(splitAddress(address), null, `would have cut "${address}"`)
  }
})

test('repeating the town is the narrower question', () => {
  // Said twice: the tail is the town and state being submitted alongside it.
  assert.equal(repeatsPlace('700 Lawlins Rd, Wyckoff, NJ 07481', 'Wyckoff', 'NJ'), true)
  assert.equal(repeatsPlace('700 Lawlins Rd, Wyckoff, NJ', 'wyckoff', 'nj'), true)
  // The state alone is enough — the column still cannot mean it twice.
  assert.equal(repeatsPlace('700 Lawlins Rd, Wyckoff, NJ', 'Franklin Lakes', 'NJ'), true)

  /*
   * A tail naming a different place in a different state is a judgment about
   * somebody's street name, and not one to make for them.
   */
  assert.equal(repeatsPlace('700 Lawlins Rd, Wyckoff, NJ', 'Warwick', 'NY'), false)
  assert.equal(repeatsPlace('18 W Main St, Ste #1', 'Beacon', 'NY'), false)
  assert.equal(repeatsPlace('700 Lawlins Rd', 'Wyckoff', 'NJ'), false)
  assert.equal(repeatsPlace(null, 'Wyckoff', 'NJ'), false)
  // Nothing to repeat is nothing to refuse.
  assert.equal(repeatsPlace('700 Lawlins Rd, Wyckoff, NJ', null, null), false)
})
