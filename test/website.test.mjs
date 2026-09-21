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
import { crawlable, isPrivateAddress } from '../scripts/lib/hosts.mjs'

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
  assert.match(refused('https://abmasfarm'), /full domain/)
})

test('a trailing dot is a spelling of the same name', () => {
  // `abmasfarm.com.` is a fully-qualified name and `fetch` is happy with it.
  // Both copies drop the dot when grouping, so both have to accept it.
  assert.equal(ok('https://abmasfarm.com.'), 'https://abmasfarm.com.')
  assert.equal(crawlable('https://abmasfarm.com.').host, 'abmasfarm.com')
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

/*
 * A submitted website is a URL a stranger chose, fetched unattended by this
 * project's crawler — on the machine that runs the nightly read, which is a
 * laptop inside a home network. `PoliteFetcher` checks the scheme and nothing
 * else, so these two rules are the whole of the door.
 */
test('a machine on the crawling host\'s own network is not a farm', () => {
  for (const raw of [
    'http://127.0.0.1:3000/',
    'https://192.168.1.1',
    'http://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/farm',
    'https://[::1]/',
  ]) {
    assert.match(refused(raw), /IP address/)
  }
  for (const raw of ['https://localhost', 'http://router.local', 'https://api.internal']) {
    assert.match(refused(raw), /one machine/)
  }
})

/*
 * Two copies of one rule, checked against each other — `src/lib/website.ts`
 * for the person typing and `scripts/lib/hosts.mjs` for the crawler that acts
 * on it. Scripts do not import from `src/` anywhere in this repo, so the cost
 * of the second copy is paid here, the way locate.test.mjs pays it.
 *
 * Only the VERDICTS have to agree. The wording does not: one is shown to
 * somebody filling in a form and the other is printed in a crawl report.
 */
test('the browser and the crawler refuse the same hosts', () => {
  const URLS = [
    'https://abmasfarm.com',
    'http://abmasfarm.com',
    'https://www.abmasfarm.com/hours',
    'https://abmasfarm.com:8080',
    'https://abmasfarm.com.',
    'https://abmasfarm',
    'https://localhost',
    'http://router.local',
    'https://api.internal',
    'https://x.home.arpa',
    'http://127.0.0.1:3000/',
    'https://192.168.1.1',
    'http://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/farm',
    'https://[::1]/',
    'ftp://abmasfarm.com',
    'javascript:alert(1)',
    'not a url',
  ]
  for (const url of URLS) {
    assert.equal(
      readWebsite(url).ok, crawlable(url).ok,
      `${url}: browser says ${readWebsite(url).ok}, crawler says ${crawlable(url).ok}`,
    )
  }
})

test('and they agree about every website already on the map', () => {
  const orchards = JSON.parse(readFileSync(new URL('../src/data/orchards.json', import.meta.url)))
  for (const site of orchards.map((o) => o.website).filter(Boolean)) {
    assert.equal(crawlable(site).ok, true, `the crawler would now skip ${site}`)
  }
})

test('the crawler groups by host the way it always did', () => {
  assert.equal(crawlable('https://www.abmasfarm.com/hours').host, 'abmasfarm.com')
  assert.equal(crawlable('http://ABMASFARM.com').host, 'abmasfarm.com')
})

test('but looks up the name it will actually connect to', () => {
  // Grouping drops `www.` so a farm and its cidery on one site are crawled
  // once. Plenty of sites answer on `www.` and not on the bare domain, so
  // resolving the grouped name would refuse them.
  const at = crawlable('https://www.abmasfarm.com/hours')
  assert.equal(at.host, 'abmasfarm.com')
  assert.equal(at.hostname, 'www.abmasfarm.com')
})

/*
 * Walked at both edges of every block, because the first version of this
 * stored the prefixes as octets and let 240.0.0.1 through: 224.0.0.0/4 spans
 * 224 to 239, which is not "the first octet is 224".
 */
test('private address ranges, at their edges', () => {
  const PRIVATE = [
    '0.0.0.0', '0.255.255.255', '10.0.0.0', '10.255.255.255',
    '100.64.0.0', '100.127.255.255', '127.0.0.1', '169.254.169.254',
    '172.16.0.0', '172.31.255.255', '192.0.0.1', '192.168.0.0',
    '192.168.255.255', '198.18.0.0', '198.19.255.255',
    '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
  ]
  const PUBLIC = [
    '1.0.0.0', '8.8.8.8', '9.255.255.255', '11.0.0.0', '93.184.216.34',
    '100.63.255.255', '100.128.0.0', '126.255.255.255', '128.0.0.0',
    '169.253.255.255', '169.255.0.0', '172.15.255.255', '172.32.0.0',
    '192.0.1.1', '192.167.255.255', '192.169.0.0', '198.17.255.255',
    '198.20.0.0', '223.255.255.255',
  ]
  for (const a of PRIVATE) assert.equal(isPrivateAddress(a, 4), true, a)
  for (const a of PUBLIC) assert.equal(isPrivateAddress(a, 4), false, a)
})

test('and the v6 ones, including v4 wearing a v6 hat', () => {
  for (const a of ['::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'febf::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(a, 6), true, a)
  }
  for (const a of ['2606:4700::1111', 'fec0::1', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(a, 6), false, a)
  }
})
