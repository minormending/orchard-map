#!/usr/bin/env node
/**
 * The apple vocabulary, and when each one is actually pickable.
 *
 *   node scripts/import-varieties.mjs            dry run
 *   node scripts/import-varieties.mjs --apply    write src/data/varieties.json
 *
 * Two sources, deliberately kept apart, because conflating them would make the
 * headline feature of this map wrong:
 *
 *   The New York Apple Association's `varieties` post type gives 30 named
 *   varieties with a flavour profile, best uses and a hint. Real data, theirs.
 *
 *   The HARVEST table below gives the weeks each one is on the tree in the
 *   Hudson Valley. Curated here, marked as an estimate, and NOT taken from the
 *   association's own "AVAILABILITY" line.
 *
 * That last point is the whole reason this file is careful. The association
 * publishes availability, which is when you can BUY the apple — Braeburn reads
 * "October through April", Acey Mac "September through June". Those are
 * controlled-atmosphere storage figures. Reading them as picking windows would
 * have this map cheerfully telling somebody to go and pick Braeburns in March,
 * which is the exact failure the project exists to avoid.
 *
 * Harvest windows are also regional and move a week or two with the year, so
 * they are stored as a typical range and always rendered as "usually", never
 * as a fact about a particular farm. A farm's real state can only come from
 * the farm — that is Phase 4.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src', 'data', 'varieties.json')
const UA = 'orchard-map/0.1 (+https://github.com/minormending/orchard-map; polite)'
const APPLY = process.argv.includes('--apply')

/**
 * Typical Hudson Valley picking weeks, as [start, end] month/day pairs.
 *
 * Compiled from Cornell Cooperative Extension harvest charts and the published
 * picking calendars of Hudson Valley orchards. These are averages: a warm
 * spring pulls everything a week earlier, a cold one pushes it later, and a
 * given farm's own trees can sit a week either side of the region.
 *
 * `null` means we do not have a reliable window. It is left null rather than
 * guessed, and such a variety simply does not appear in "ripe now".
 */
const HARVEST = {
  'jersey-mac':       ['08-10', '09-05'],
  'paula-red':        ['08-20', '09-15'],
  'zestar':           ['08-20', '09-10'],
  'sweetango':        ['08-25', '09-15'],
  'ginger-gold':      ['08-25', '09-20'],
  'gala':             ['09-01', '09-25'],
  'acey-mac':         ['09-01', '09-20'],
  'jonamac':          ['09-01', '09-20'],
  '20-ounce':         ['09-01', '09-25'],
  'mcintosh':         ['09-10', '10-10'],
  'honeycrisp':       ['09-10', '10-05'],
  'autumn-crisp':     ['09-10', '10-05'],
  'snapdragon':       ['09-20', '10-15'],
  'cortland':         ['09-20', '10-20'],
  'empire':           ['09-20', '10-20'],
  'macoun':           ['09-25', '10-20'],
  'red-delicious':    ['09-25', '10-15'],
  'jonagold':         ['10-01', '10-25'],
  'golden-delicious': ['10-01', '10-25'],
  'crispin':          ['10-01', '10-25'],
  'idared':           ['10-01', '10-25'],
  'cameo':            ['10-01', '10-20'],
  'fortune':          ['10-01', '10-20'],
  'rome':             ['10-05', '10-30'],
  'rubyfrost':        ['10-10', '11-05'],
  'wildtwist':        ['10-10', '11-01'],
  'fuji':             ['10-10', '11-01'],
  'braeburn':         ['10-10', '11-01'],
  'granny-smith':     ['10-10', '11-01'],
  'evercrisp':        ['10-20', '11-10'],
  'pink-lady':        ['10-20', '11-10'],
}

/**
 * Varieties the association does not list.
 *
 * Its `varieties` post type is a New York growers' vocabulary, and it is
 * complete for what New York promotes rather than for what the farms on this
 * map grow. Pink Lady is the first one that mattered: Andersen Farms in Sparta
 * publishes it among the ten varieties in its orchard, and on 21 September a
 * reader had to leave it unrecorded because the word did not exist here — four
 * of that farm's ten did, and the other three are genuinely obscure. This one
 * is not.
 *
 * Its window comes from the same class of source as every other row in
 * HARVEST: Apple Ridge Orchards in Warwick publishes a ripening schedule
 * putting Pink Lady in "Mid-Late October", alongside Fuji, Evercrisp and
 * Mutsu. It gets Evercrisp's window, which is the latest the table carries,
 * and the same `regional-estimate` label — it is not a fact about anybody's
 * trees and is never rendered as one.
 *
 * `profile`, `best_for` and `hint` are left empty, as Autumn Crisp's and
 * Evercrisp's already are. The association writes that copy for its own
 * varieties and there is none to borrow; inventing tasting notes to fill a
 * column is exactly the sort of plausible detail this project does not
 * publish. An empty list renders as nothing.
 *
 * Provenance is `user`, which `src/lib/sources.ts` already names "a person, by
 * hand". That is what this is, and it is a key the source table knows rather
 * than a new one it would render raw.
 */
const BEYOND_NYAA = [
  { slug: 'pink-lady', name: 'Pink Lady', flavour: 'balanced' },
]

const stripTags = (html) =>
  String(html ?? '')
    .replace(/<sup>[^<]*<\/sup>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&#039;|&apos;|&#8217;|’/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

/** Pull one labelled section out of the association's prose. */
function section(text, label, next) {
  const re = new RegExp(`${label}\\s+(.*?)(?=\\s+(?:${next.join('|')})\\b|$)`, 'i')
  return re.exec(text)?.[1]?.trim() ?? null
}

const LABELS = ['PROFILE', 'BEST USES', 'SPECIAL HINT', 'AVAILABILITY']

/** Sentence-ish splitting of a run-on section into bullet points. */
function bullets(s) {
  if (!s) return []
  return s
    .split(/(?<=[a-z)])\s+(?=[A-Z])/)
    .map((x) => x.replace(/^[-•\s]+/, '').trim())
    .filter((x) => x.length > 2)
    .slice(0, 4)
}

const doy = (mmdd) => {
  const [m, d] = mmdd.split('-').map(Number)
  // A fixed non-leap reference year: these are seasonal averages, and a day of
  // slippage across a leap year is far inside the noise.
  return Math.floor((Date.UTC(2025, m - 1, d) - Date.UTC(2025, 0, 0)) / 86_400_000)
}

/** Sweet / tart / balanced, from the association's own profile words. */
function flavour(profile) {
  const p = (profile ?? '').toLowerCase()
  const sweet = /sweet|honey|sugary/.test(p)
  const tart = /tart|tangy|acid|sharp/.test(p)
  if (sweet && tart) return 'balanced'
  if (sweet) return 'sweet'
  if (tart) return 'tart'
  return 'balanced'
}

const res = await fetch(
  'https://www.applesfromny.com/wp-json/wp/v2/varieties?per_page=100',
  { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30_000) },
)
if (!res.ok) {
  console.error(`the varieties endpoint answered ${res.status}`)
  process.exit(1)
}
const rows = await res.json()

const varieties = []
const missing = []

for (const row of rows) {
  const slug = row.slug
  const name = stripTags(row.title?.rendered)
  const body = stripTags(row.content?.rendered)

  const profile = section(body, 'PROFILE', LABELS.slice(1))
  const uses = section(body, 'BEST USES', LABELS.slice(2))
  const hint = section(body, 'SPECIAL HINT', LABELS.slice(3))

  const window = HARVEST[slug] ?? null
  if (!window) missing.push(`${name} (${slug})`)

  varieties.push({
    slug,
    name,
    flavour: flavour(profile),
    profile: bullets(profile),
    best_for: bullets(uses),
    hint: hint || null,
    /* Picking window. null when we have no reliable figure — such a variety is
       simply absent from "ripe now" rather than guessed into it. */
    start_doy: window ? doy(window[0]) : null,
    end_doy: window ? doy(window[1]) : null,
    harvest_from: window?.[0] ?? null,
    harvest_to: window?.[1] ?? null,
    /* Deliberately NOT the association's AVAILABILITY line — see the header. */
    harvest_source: window ? 'regional-estimate' : null,
    import_source: 'nyaa',
    import_licence: 'unstated',
  })
}

/*
 * The same shape, through the same window lookup, so there is one table of
 * picking dates to read and one place a window can be wrong.
 */
for (const extra of BEYOND_NYAA) {
  if (varieties.some((v) => v.slug === extra.slug)) {
    // The association has started listing it. Theirs is the better row — it
    // carries their profile copy — and this one should come out of the file
    // above rather than quietly shadow it.
    process.stderr.write(`${extra.name} is in the association's list now; drop it from BEYOND_NYAA\n`)
    continue
  }
  const window = HARVEST[extra.slug] ?? null
  if (!window) missing.push(`${extra.name} (${extra.slug})`)

  varieties.push({
    slug: extra.slug,
    name: extra.name,
    flavour: extra.flavour,
    profile: [],
    best_for: [],
    hint: null,
    start_doy: window ? doy(window[0]) : null,
    end_doy: window ? doy(window[1]) : null,
    harvest_from: window?.[0] ?? null,
    harvest_to: window?.[1] ?? null,
    harvest_source: window ? 'regional-estimate' : null,
    import_source: 'user',
    import_licence: 'user-submitted',
  })
}

varieties.sort((a, b) => (a.start_doy ?? 999) - (b.start_doy ?? 999) || a.name.localeCompare(b.name))

const byHand = varieties.filter((v) => v.import_source === 'user')

process.stderr.write(`
${varieties.length} varieties
  from the association: ${varieties.length - byHand.length}
  added by hand: ${byHand.length}${byHand.length ? ` — ${byHand.map((v) => v.name).join(', ')}` : ''}
  with a picking window: ${varieties.filter((v) => v.start_doy !== null).length}
  without one: ${missing.length}${missing.length ? ` — ${missing.join(', ')}` : ''}
`)

if (!APPLY) {
  process.stderr.write('\ndry run — pass --apply to write src/data/varieties.json\n')
} else {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(varieties, null, 2) + '\n')
  process.stderr.write(`\nwrote ${OUT}\n`)
}
