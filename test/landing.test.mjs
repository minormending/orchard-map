/**
 * Where a request ended up, rather than where it was sent.
 *
 * `scrape.mjs` groups its targets by the host on the row, before anything is
 * fetched, and holds back the deterministic observations when a host serves
 * more than one listing — a regex cannot tell which of two businesses a
 * sentence is about. A redirect walks straight past that: two rows for Soons
 * Orchards in New Hampton, one carrying soonsorchards.com and one carrying
 * upickapples.com which answers as the first, looked like two sites. Both
 * were crawled, and the same observations from the same five pages were
 * attributed to each listing independently.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { siteReached, foldLanding } from '../scripts/lib/hosts.mjs'

const listing = (slug) => ({ slug, name: slug, town: 'New Hampton' })

test('the site is the one that answered', () => {
  // The real pair, as crawled on 21 September.
  assert.equal(
    siteReached('https://www.soonsorchards.com/upick-apples', 'upickapples.com'),
    'soonsorchards.com')

  // No redirect: what was asked for is what answered.
  assert.equal(siteReached('https://abmasfarm.com/', 'abmasfarm.com'), 'abmasfarm.com')

  // The two hops that are not a different site.
  assert.equal(siteReached('https://www.abmasfarm.com/', 'abmasfarm.com'), 'abmasfarm.com')
  assert.equal(siteReached('https://abmasfarm.com/', 'abmasfarm.com'), 'abmasfarm.com')
})

test('a final URL that will not parse falls back to what was asked for', () => {
  // Should not happen for a response just read, and is not worth losing a
  // crawl over if it does.
  assert.equal(siteReached('', 'abmasfarm.com'), 'abmasfarm.com')
  assert.equal(siteReached('not a url', 'abmasfarm.com'), 'abmasfarm.com')
})

test('two listings that arrive at one site become one group', () => {
  const sites = new Map()

  const first = foldLanding(sites, 'soonsorchards.com', [listing('soons-orchards-inc')])
  assert.equal(first, null, 'the first landing is a site to crawl, not a join')

  const second = foldLanding(sites, 'soonsorchards.com', [listing('apple-picking-soons')])
  assert.ok(second, 'the second landing joins the first')
  assert.deepEqual(second.listings.map((o) => o.slug),
    ['soons-orchards-inc', 'apple-picking-soons'])

  // One group, so one crawl and one queue entry naming both.
  assert.equal(sites.size, 1)
})

test('listings that stay apart stay apart', () => {
  const sites = new Map()
  assert.equal(foldLanding(sites, 'abmasfarm.com', [listing('abmas')]), null)
  assert.equal(foldLanding(sites, 'appledavesorchards.com', [listing('apple-daves')]), null)
  assert.equal(sites.size, 2)
  for (const g of sites.values()) assert.equal(g.listings.length, 1)
})

test('the same-URL case still groups the way it always did', () => {
  // Two listings on one row's worth of host arrive together, already grouped
  // by `byHost`. Barton Orchards: a farm and its farm stand.
  const sites = new Map()
  const together = [listing('barton-orchards'), listing('barton-apple-core')]
  assert.equal(foldLanding(sites, 'bartonorchards.com', together), null)
  assert.equal(sites.get('bartonorchards.com').listings.length, 2,
    'both are in the group, so both are held back')
})

test('the group is a copy, so the caller cannot mutate it by accident', () => {
  const sites = new Map()
  const passed = [listing('one')]
  foldLanding(sites, 'example.com', passed)
  passed.push(listing('two'))
  assert.equal(sites.get('example.com').listings.length, 1)
})

test('a third listing joins the same group rather than starting another', () => {
  const sites = new Map()
  foldLanding(sites, 'example.com', [listing('one')])
  foldLanding(sites, 'example.com', [listing('two')])
  const third = foldLanding(sites, 'example.com', [listing('three')])
  assert.equal(third.listings.length, 3)
  assert.equal(sites.size, 1)
})
