/**
 * What the Add-an-orchard form will accept as a website.
 *
 * The cases that matter here are not exotic. They are what a person types
 * when a box says "Website": the domain off the side of a barn, sometimes
 * with `www`, occasionally pasted out of a browser complete with scheme. The
 * two consumers of the stored value — `scrape.mjs` calling `new URL()`, and
 * an `href` on the farm's page — both need an absolute URL, and both fail
 * quietly when they do not get one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { readWebsite, MAX_WEBSITE } from '../src/lib/website.ts'

const ok = (raw) => {
  const r = readWebsite(raw)
  assert.equal(r.ok, true, `expected ${JSON.stringify(raw)} to be accepted: ${r.reason}`)
  return r.url
}

const refused = (raw) => {
  const r = readWebsite(raw)
  assert.equal(r.ok, false, `expected ${JSON.stringify(raw)} to be refused`)
  return r.reason
}

test('a bare domain is how people write a website down', () => {
  assert.equal(ok('abmasfarm.com'), 'https://abmasfarm.com')
  assert.equal(ok('www.abmasfarm.com'), 'https://www.abmasfarm.com')
  assert.equal(ok('  abmasfarm.com  '), 'https://abmasfarm.com')
})

test('a scheme somebody typed is the one that is kept', () => {
  assert.equal(ok('http://abmasfarm.com'), 'http://abmasfarm.com')
  assert.equal(ok('https://abmasfarm.com'), 'https://abmasfarm.com')
  assert.equal(ok('HTTP://Abmasfarm.com'), 'HTTP://Abmasfarm.com')
})

test('nothing but the scheme is ever added', () => {
  assert.equal(ok('abmasfarm.com/hours'), 'https://abmasfarm.com/hours')
  assert.equal(ok('abmasfarm.com/u-pick?season=2026'), 'https://abmasfarm.com/u-pick?season=2026')
  assert.equal(ok('abmasfarm.com:8080'), 'https://abmasfarm.com:8080')
})

test('an empty field is an answer, and the allowed one', () => {
  assert.equal(ok(''), null)
  assert.equal(ok('   '), null)
  assert.equal(ok(null), null)
  assert.equal(ok(undefined), null)
})

/*
 * The whole point of the field. `scrape.mjs` does `new URL(o.website).host`
 * inside a try/catch whose catch is `continue`, so a value that will not parse
 * removes the farm from every future crawl and says nothing about it.
 */
test('what is accepted always parses, which is what the crawler needs', () => {
  for (const raw of [
    'abmasfarm.com',
    'www.abmasfarm.com',
    'http://abmasfarm.com',
    'abmasfarm.com/hours',
    'abmasfarm.com:8080',
  ]) {
    const url = ok(raw)
    assert.doesNotThrow(() => new URL(url), raw)
    assert.ok(new URL(url).host, raw)
  }
})

/*
 * Stored values are rendered as `href={orchard.website}` with no scheme check
 * at the point of use, so the check has to be here.
 */
test('a scheme that is not the web is refused, not repaired', () => {
  for (const raw of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'mailto:pick@abmasfarm.com',
    'ftp://abmasfarm.com',
    'data:text/html,<script>x</script>',
  ]) {
    assert.match(refused(raw), /starts with https/)
  }
})

test('a host that is one word parses and is still not a website', () => {
  // `new URL('https://abmasfarm')` is perfectly happy. A typo that parses is
  // worse than one that does not — only the second kind gets mentioned.
  assert.match(refused('abmasfarm'), /full domain/)
  assert.match(refused('localhost'), /full domain/)
  assert.match(refused('abmasfarm.com.'), /full domain/)
  assert.match(refused('https://abmasfarm'), /full domain/)
})

test('a sentence in the box is a sentence, not an address', () => {
  assert.match(refused('abmasfarm.com and also on facebook'), /no spaces/)
  assert.match(refused('ask at the farm stand'), /no spaces/)
})

test('too long is refused rather than cut down to something else', () => {
  // Truncating a URL is migration 016's mistake in a different column: what
  // comes out is the right shape and points somewhere else.
  assert.match(refused(`https://abmasfarm.com/${'a'.repeat(MAX_WEBSITE)}`), /too long/)
})

test('not a web address at all', () => {
  assert.match(refused('://'), /does not look like/)
  assert.match(refused('https://'), /does not look like/)
})

/*
 * The strongest case available without a network: every website the map is
 * already publishing has to survive this unchanged. If the rule here would
 * reject or rewrite one of them, the rule is wrong — those URLs have been
 * crawled and linked.
 */
test('every website already on the map passes through untouched', () => {
  const orchards = JSON.parse(readFileSync(new URL('../src/data/orchards.json', import.meta.url)))
  const sites = orchards.map((o) => o.website).filter(Boolean)
  assert.ok(sites.length > 100, `expected the bundled data to have websites, saw ${sites.length}`)
  for (const site of sites) assert.equal(ok(site), site)
})
