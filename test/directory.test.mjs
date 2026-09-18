/**
 * Whether a directory listing is one we already have.
 *
 * This file exists because nothing tested `directory.mjs`, and on 2026-09-18
 * three real Connecticut farms — Belltown Hill, Rose Orchards and Wright's
 * Orchard — were deleted from the database as duplicates of farms they have
 * nothing to do with. The rules are shared by both state importers, so a fault
 * here is a fault in every import.
 *
 * The cases below are the real ones, with the real names and positions.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sameBusiness, matchExisting, alreadyImported, distanceM, NAME_MATCH_M, TOWN_CENTRE_M,
  streetForGeocoder,
} from '../scripts/lib/directory.mjs'

/** Rows as the exported data carries them: name, slug, lat, lng, import_*. */
const row = (slug, name, lat, lng, source = 'nyaa') => ({
  slug, name, lat, lng, import_source: source, import_id: slug,
})

const ROSE_HILL = row('rose-hill-farm-red-hook', 'Rose Hill Farm', 41.99, -73.87)
const WRIGHT_NY = row('wright-farms-gardiner', 'Wright Farms', 41.68, -74.15)
const ROSES_BERRY = row('rose-s-berry-farm-glastonbury', "Rose's Berry Farm", 41.6516, -72.5765, 'osm')
const BISHOPS_GUILFORD = row('bishop-s-orchards-guilford', "Bishop's Orchards", 41.2879, -72.6815, 'ctapples')

// The three that were lost, at the positions the site publishes for them.
const ROSE_ORCHARDS = { name: 'Rose Orchards', town: 'North Branford', lat: 41.316132, lng: -72.78363 }
const WRIGHTS_CT = { name: "Wright's Orchard & Dried Flower Farm", town: 'Tolland', lat: 41.866231, lng: -72.311334 }
const BELLTOWN = { name: 'Belltown Hill Orchards, LLC', town: 'South Glastonbury', lat: 41.651571, lng: -72.57712 }

// --- the names really do collide ---------------------------------------------

/*
 * sameBusiness is a name predicate and is allowed to say yes here. What went
 * wrong was using it alone. If these ever stop matching, the guard below is
 * passing for the wrong reason and proves nothing.
 */
test('the name matcher alone cannot tell these apart', () => {
  assert.ok(sameBusiness('Rose Orchards', 'Rose Hill Farm'))
  assert.ok(sameBusiness("Wright's Orchard & Dried Flower Farm", 'Wright Farms'))
})

// --- so distance has to do the work ------------------------------------------

test('a shared name across a state line is not a duplicate', () => {
  assert.equal(matchExisting(ROSE_ORCHARDS, ROSE_ORCHARDS, [ROSE_HILL]), null)
  assert.equal(matchExisting(WRIGHTS_CT, WRIGHTS_CT, [WRIGHT_NY]), null)
})

test('the farms in that pair really are far apart', () => {
  // Guards the guard: if the fixtures drifted to the same town, the test above
  // would pass without the distance bound doing anything.
  assert.ok(distanceM(ROSE_HILL, ROSE_ORCHARDS) > 100_000)
  assert.ok(distanceM(WRIGHT_NY, WRIGHTS_CT) > 100_000)
})

test('a shared name at the same place still is a duplicate', () => {
  const alsoBishops = { name: "Bishop's Orchards", town: 'Guilford', lat: 41.2881, lng: -72.6818 }
  const hit = matchExisting(alsoBishops, alsoBishops, [BISHOPS_GUILFORD])
  assert.equal(hit?.duplicate_of, 'bishop-s-orchards-guilford')
})

test('two sites of one business are two rows, not a duplicate', () => {
  // Bishop's keeps Guilford and Northford about eight miles apart, and the map
  // lists both. A name match must not collapse them.
  const northford = { name: "Bishop's Orchards", town: 'Northford', lat: 41.3739, lng: -72.7817 }
  assert.ok(distanceM(BISHOPS_GUILFORD, northford) > NAME_MATCH_M)
  assert.equal(matchExisting(northford, northford, [BISHOPS_GUILFORD]), null)
})

// --- proximity raises a question, and must not silence one -------------------

test('a different farm within 600m is reported, not swallowed', () => {
  /*
   * Belltown Hill is genuinely close to Rose's Berry Farm. Close enough to ask
   * about — but the answer has to reach the candidates file. This is the one
   * that disappeared: it matched a same-source row and was counted as "already
   * imported from this source", so nobody ever saw the question.
   */
  const hit = matchExisting(BELLTOWN, BELLTOWN, [ROSES_BERRY], { source: 'ctapples' })
  assert.ok(hit, 'a neighbouring farm should raise something')
  assert.ok(!hit.quiet, 'and it must not be silent')
  assert.equal(hit.duplicate_of, 'rose-s-berry-farm-glastonbury')
})

test('a row this importer already added is silent', () => {
  const mine = row('belltown-hill-orchards-llc-south-glastonbury', 'Belltown Hill Orchards, LLC',
    41.651571, -72.57712, 'ctapples')
  const hit = matchExisting(BELLTOWN, BELLTOWN, [mine], {
    source: 'ctapples', importId: 'belltown-hill-orchards-llc-south-glastonbury',
  })
  assert.equal(hit?.quiet, true)
})

test('idempotency keys on the import id, not on resemblance', () => {
  // Same source, similar name, different listing: that is a question, not a
  // re-import, and must not be quiet.
  const hit = matchExisting(ROSE_ORCHARDS, ROSE_ORCHARDS, [
    row('rose-hill-farm-red-hook', 'Rose Hill Farm', 41.3165, -72.7840, 'ctapples'),
  ], { source: 'ctapples', importId: 'rose-orchards-north-branford' })
  assert.ok(hit && !hit.quiet, 'a different listing from the same source is still a finding')
})

// --- the check is not vacuous ------------------------------------------------

test('the rule this replaced would have failed these', () => {
  // Name alone, no distance — what both importers did until this commit.
  const old = (listing, existing) => existing.find((o) => sameBusiness(o.name, listing.name))
  assert.ok(old(ROSE_ORCHARDS, [ROSE_HILL]), 'expected the old rule to match across the state line')
  assert.ok(old(WRIGHTS_CT, [WRIGHT_NY]), 'expected the old rule to match across the state line')
})

/**
 * The three Connecticut farms that reported `could not be geocoded` every week.
 *
 * None of them is a hard address — each is a real street with a route number
 * written alongside it for somebody driving there. The directory has said it
 * this way for years, so the importer has to read it, not wait for it to change.
 */
test('a bracketed route number is a note to a driver, not part of the street', () => {
  assert.equal(
    streetForGeocoder('403 Orchard Hill Road (Rte. 169)'),
    '403 Orchard Hill Road',
  )
})

test('directions tacked on the end come off, with whatever follows them', () => {
  assert.equal(streetForGeocoder('1393 North Road, off Rte. 101'), '1393 North Road')
  assert.equal(streetForGeocoder('55 Bishop Lane, just off Route 6A'), '55 Bishop Lane')
})

test('a route number in front of a named road comes off the front', () => {
  assert.equal(
    streetForGeocoder('Rt. 322 Meriden-Waterbury Road'),
    'Meriden-Waterbury Road',
  )
})

/**
 * The stripping only ever shortens, and never to nothing. A farm addressed
 * from the route itself has no other street to offer, and sending an empty
 * query would turn a weak lookup into no lookup at all.
 */
test('an address that is only a route number survives whole', () => {
  assert.equal(streetForGeocoder('Route 169'), 'Route 169')
  assert.equal(streetForGeocoder('Rt. 322'), 'Rt. 322')
})

test('a house number is not a route number', () => {
  assert.equal(streetForGeocoder('322 Meriden-Waterbury Road'), '322 Meriden-Waterbury Road')
  assert.equal(streetForGeocoder('336 Long Bottom Road'), '336 Long Bottom Road')
  assert.equal(streetForGeocoder('19 Rose Hill Farm'), '19 Rose Hill Farm')
})

test('an address with nothing to strip is returned unchanged', () => {
  assert.equal(streetForGeocoder('295 Matson Hill Road'), '295 Matson Hill Road')
  assert.equal(streetForGeocoder(null), null)
})

/**
 * A locality centroid is not an address.
 *
 * The stripped-street query added alongside `streetForGeocoder` gives the
 * geocoder a second chance to answer, and Photon's answer when it cannot find
 * a street is the town. Defazzio Orchard came back as the exact centre of East
 * Killingly — the same point as querying the bare town name — and was reported
 * as ready to add on the strength of its address having a house number in it.
 * The address did. The match did not.
 */
test('the town-centre threshold is tight enough to keep real addresses', () => {
  // The two farms that placed properly sit kilometres from their town centres,
  // so a threshold anywhere near them would be throwing away good answers.
  const LAPSLEY = { lat: 41.8301043, lng: -71.9571078 }
  const POMFRET = { lat: 41.887320, lng: -71.962018 }
  const SUNNYMOUNT = { lat: 41.5546624, lng: -72.8476815 }
  const SOUTHINGTON = { lat: 41.600544, lng: -72.878294 }

  assert.ok(distanceM(POMFRET, LAPSLEY) > TOWN_CENTRE_M * 20)
  assert.ok(distanceM(SOUTHINGTON, SUNNYMOUNT) > TOWN_CENTRE_M * 20)
})

test('a result identical to the town centre is caught', () => {
  // What Photon actually returned for "1393 North Road, East Killingly, CT,
  // 06243" and for "East Killingly, CT": the same point, to six decimals.
  const EAST_KILLINGLY = { lat: 41.849265, lng: -71.818682 }
  assert.ok(distanceM(EAST_KILLINGLY, { lat: 41.8492652, lng: -71.8186818 }) < TOWN_CENTRE_M)
})

test('identity is settled without needing a position', () => {
  /*
   * place() checks this before it geocodes. A farm we already hold should
   * never depend on the geocoder having a good day to be recognised, and
   * should never spend a lookup proving what its import id already says.
   */
  const mine = row('lapsley-orchard-pomfret-center', 'Lapsley Orchard',
    41.83, -71.957, 'ctapples')
  assert.equal(alreadyImported([mine], 'ctapples', 'lapsley-orchard-pomfret-center'), true)
  assert.equal(alreadyImported([mine], 'ctapples', 'defazzio-orchard-east-killingly'), false)
  // A different source with the same id is a different farm.
  assert.equal(alreadyImported([mine], 'nyaa', 'lapsley-orchard-pomfret-center'), false)
})
