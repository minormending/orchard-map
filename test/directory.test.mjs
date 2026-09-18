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
  sameBusiness, matchExisting, distanceM, NAME_MATCH_M,
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
