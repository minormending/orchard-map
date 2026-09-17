/**
 * The extractor, and specifically the ways it has already been wrong.
 *
 * Every case below is a real page fragment from a Hudson Valley orchard site,
 * found by running the scraper rather than by imagining what it might meet.
 * That is the only reason they are the right tests: nothing here is a
 * hypothetical.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  pageText, jsonLd, extractVarieties, extractUpickOpen,
  extractAdmission, extractStructured, rankLinks,
} from '../scripts/lib/extract.mjs'

const VARIETIES = JSON.parse(
  readFileSync(new URL('../src/data/varieties.json', import.meta.url), 'utf8'),
)
const URL_ = 'https://example-farm.test/visit'

const varietiesIn = (text, minConfidence = 0.55) =>
  extractVarieties(text, URL_, VARIETIES)
    .filter((o) => o.confidence >= minConfidence)
    .map((o) => o.value)
    .sort()

test('script and style content is not prose', () => {
  // A variety name inside a JSON blob is not the farm saying they grow it.
  const html = '<script>var x = {"apple":"Honeycrisp"}</script><p>We grow Gala.</p>'
  const text = pageText(html)
  assert.ok(!text.includes('Honeycrisp'), text)
  assert.ok(text.includes('Gala'))
})

test('farms spell McIntosh their own way', () => {
  // Maskers writes "Macintosh". Without aliases the most-grown apple in New
  // York is invisible to the scraper.
  assert.deepEqual(varietiesIn('Ripe for Picking: Macintosh, Cortland'), ['cortland', 'mcintosh'])
  assert.deepEqual(varietiesIn('We grow Mutsu apples'), ['crispin'])
})

test('a variety named as a parent is not a crop', () => {
  // Maskers' ripening schedule, verbatim. Empire is the subject and IS grown
  // here; Macintosh and Red Delicious are its parents and may not be.
  const line = 'Empire Cross between a Macintosh and Red Delicious, sweet tart flavor'
  const promotable = varietiesIn(line)
  assert.ok(promotable.includes('empire'), `expected empire in ${promotable}`)
  assert.ok(!promotable.includes('red-delicious'), `red-delicious should be demoted: ${promotable}`)
  assert.ok(!promotable.includes('mcintosh'), `mcintosh should be demoted: ${promotable}`)
})

test('a demoted variety is still recorded, just not promotable', () => {
  // Observations record what was seen. Promotion decides what it means.
  const all = extractVarieties(
    'Empire Cross between a Macintosh and Red Delicious', URL_, VARIETIES)
  const red = all.find((o) => o.value === 'red-delicious')
  assert.ok(red, 'the sighting should still exist')
  assert.ok(red.confidence < 0.55, `expected it below threshold, got ${red.confidence}`)
})

test('word boundaries keep Rome out of Romeo', () => {
  assert.deepEqual(varietiesIn('Our barn is available for weddings in Romeoville'), [])
  assert.deepEqual(varietiesIn('We grow Rome apples'), ['rome'])
})

test('a regex may never put "picking is open" on the map', () => {
  // Altamont Orchards, read on 17 September:
  //   "PICK YOUR OWN APPLES : Open on September 12 & 13th"
  // True sentence, finished weekend. A pattern match does not know what day
  // it is, so asserting open is the model tier's job.
  const found = extractUpickOpen('PICK YOUR OWN APPLES : Open on September 12 & 13th 10 AM to 4PM', URL_)
  assert.equal(found.length, 1)
  assert.equal(found[0].value, 'true')
  assert.ok(found[0].confidence < 0.55,
    `an open claim from a regex must not be promotable, got ${found[0].confidence}`)
})

test('a closed claim may, and outranks an open one on the same page', () => {
  const closed = extractUpickOpen('Our u-pick is closed for the season. Thank you!', URL_)
  assert.equal(closed[0].value, 'false')
  assert.ok(closed[0].confidence >= 0.55)

  // Closed patterns are checked first, so a page with both says closed.
  const both = extractUpickOpen('U-pick is open daily. UPDATE: u-pick is now closed.', URL_)
  assert.equal(both[0].value, 'false')
})

test('an ambiguous page yields nothing at all', () => {
  assert.deepEqual(extractUpickOpen('Welcome to our farm. We have been growing apples since 1910.', URL_), [])
})

test('admission is copied as written, not normalised', () => {
  const found = extractAdmission('Weekend admission is $5.00 per person, under 3 free.', URL_)
  assert.equal(found.length, 1)
  assert.match(found[0].value, /\$5\.00 per person/)
})

test('JSON-LD hours are trusted above everything else', () => {
  const html = `<script type="application/ld+json">
    {"@type":"LocalBusiness","name":"X","openingHours":"Mo-Su 09:00-17:00"}
  </script>`
  const found = extractStructured(html, URL_)
  assert.equal(found[0].field, 'hours')
  assert.equal(found[0].value, 'Mo-Su 09:00-17:00')
  // The operator published this machine-readably. Nothing beats that.
  assert.ok(found[0].confidence > 0.9)
})

test('broken JSON-LD does not fail a crawl', () => {
  const html = '<script type="application/ld+json">{ not json </script>'
  assert.deepEqual(jsonLd(html), [])
  assert.deepEqual(extractStructured(html, URL_), [])
})

test('link ranking prefers the pages that answer the question', () => {
  const html = `
    <a href="/u-pick">U-Pick Apples</a>
    <a href="/dates-hours-prices">Dates, Hours &amp; Prices</a>
    <a href="/privacy">Privacy policy</a>
    <a href="https://facebook.com/farm">Facebook</a>
    <a href="/weddings">Weddings</a>`
  const links = rankLinks(html, 'https://example-farm.test/')
  assert.ok(links[0].endsWith('/u-pick'), links.join(', '))
  assert.ok(links.some((l) => l.includes('dates-hours-prices')))
  // Off-host links are never followed: a farm's Facebook page is not the
  // farm's website, and following them makes us somebody else's problem.
  assert.ok(!links.some((l) => l.includes('facebook')), links.join(', '))
  assert.ok(!links.some((l) => l.includes('privacy')))
})
