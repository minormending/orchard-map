#!/usr/bin/env node
/**
 * Read the farms' own websites.
 *
 *   node scripts/scrape.mjs --limit 5           crawl five, print what it found
 *   node scripts/scrape.mjs --limit 5 --model   also use the model tier
 *   node scripts/scrape.mjs --out obs.json      write observations
 *   node scripts/scrape.mjs --sql > obs.sql     emit SQL for a database
 *
 * Writes OBSERVATIONS, never facts. Nothing in this file can change what the
 * map says; promotion is a separate, thresholded step in the database. A
 * confidently wrong "picking is open" is the exact failure this project exists
 * to prevent, and keeping the raw observation is what makes a bad promotion
 * explainable and reversible rather than an unattributed value nobody can
 * account for six months later.
 *
 * Politeness lives in map-kit's PoliteFetcher: robots.txt obeyed, Crawl-delay
 * honoured, one request per host at a time, conditional requests, and a host
 * that fails twice is parked. These are small businesses on shared hosting and
 * the crawler has to be invisible to them.
 *
 * `--queue` writes the pages that still need a reader into scripts/.queue/, one
 * file per farm, for the scheduled session described in
 * .claude/skills/read-farm-sites/SKILL.md to work through.
 *
 * That split is the security boundary, not just a convenience. ALL the
 * network-facing work stays here, in deterministic code where politeness is
 * enforceable and testable. The session that reads the text has Bash and a
 * database connection, and it is reading arbitrary third-party HTML — so it
 * must never be the thing that decides to fetch something. It reads files that
 * are already on disk. A page cannot make it follow a link, because following
 * links is not a capability it has.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PoliteFetcher } from '@minormending/map-kit/node/fetch'
import { extractAll, pageText, rankLinks } from './lib/extract.mjs'
import { extractWithModel, modelTierAvailable, MODEL } from './lib/model-tier.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, 'scripts', '.cache')
const read = (f) => JSON.parse(readFileSync(join(ROOT, 'src', 'data', f), 'utf8'))

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

const LIMIT = Number(value('limit', '0')) || Infinity
const USE_MODEL = flag('model')
const OUT = value('out', null)
const AS_SQL = flag('sql')
const ONLY = value('only', null)
const QUEUE = flag('queue')

/**
 * The kill switch.
 *
 * An unattended loop holding an API key fails as a bill rather than as an
 * outage, which is a worse failure because nothing alerts on it. Both caps are
 * checked before every model call and the run stops dead when either is hit.
 */
const MAX_MODEL_CALLS = Number(process.env.ORCHARD_MAX_MODEL_CALLS ?? 250)
const MAX_TOKENS_TOTAL = Number(process.env.ORCHARD_MAX_TOKENS ?? 2_000_000)

const orchards = read('orchards.json')
const varieties = read('varieties.json')

let targets = orchards.filter((o) => o.website)
if (ONLY) targets = targets.filter((o) => o.slug.includes(ONLY))
targets = targets.slice(0, LIMIT)

if (targets.length === 0) {
  console.error('nothing to crawl')
  process.exit(1)
}

// Conditional requests only pay off across runs, so the etag store is on disk.
mkdirSync(CACHE, { recursive: true })
const ETAGS = join(CACHE, 'etags.json')
const etagStore = new Map(
  existsSync(ETAGS) ? Object.entries(JSON.parse(readFileSync(ETAGS, 'utf8'))) : [],
)

const fetcher = new PoliteFetcher({
  userAgent: 'orchard-map/0.1 (+https://github.com/minormending/orchard-map; polite, obeys robots.txt)',
  minDelayMs: 2000,
  maxPagesPerHost: 6,
  cache: etagStore,
})

const runs = []
const observations = []
const queued = []
let modelCalls = 0
let tokensUsed = 0

process.stderr.write(
  `crawling ${targets.length} farms` +
  (USE_MODEL
    ? modelTierAvailable()
      ? ` · model tier on (${MODEL})`
      : ' · model tier requested but ANTHROPIC_API_KEY is unset — skipping it'
    : ' · heuristics only') +
  '\n\n',
)

for (const orchard of targets) {
  const host = (() => { try { return new URL(orchard.website).host } catch { return null } })()
  if (!host) continue

  const run = {
    orchard_id: orchard.id,
    slug: orchard.slug,
    host,
    started_at: new Date().toISOString(),
    outcome: 'ok',
    pages: 0,
    bytes: 0,
    fetch_tier: 1,
    tokens_in: 0,
    tokens_out: 0,
  }

  process.stderr.write(`${orchard.name} (${host})\n`)

  const home = await fetcher.get(orchard.website)
  if (!home.ok) {
    run.outcome = home.reason ?? 'failed'
    process.stderr.write(`  ${run.outcome}\n`)
    runs.push({ ...run, finished_at: new Date().toISOString() })
    continue
  }
  if (home.notModified) {
    // Nothing has changed since last time. This should be the common case in
    // a nightly run, and it is the reason conditional requests are worth the
    // bookkeeping: most farm sites change twice a season.
    run.outcome = 'not-modified'
    process.stderr.write('  304 not modified\n')
    runs.push({ ...run, finished_at: new Date().toISOString() })
    continue
  }

  run.pages++
  run.bytes += home.body.length

  const pages = [{ url: home.url, html: home.body }]
  for (const link of rankLinks(home.body, home.url, 4)) {
    const page = await fetcher.get(link)
    if (page.ok && page.body) {
      pages.push({ url: page.url, html: page.body })
      run.pages++
      run.bytes += page.body.length
    }
  }

  const found = []
  for (const page of pages) {
    found.push(...extractAll(page.html, page.url, varieties))
  }

  /*
   * The model tier runs only when the cheap tiers came up short on the field
   * that matters, and only on the page most likely to answer it. Spending a
   * model call to confirm something a regex already found is money for nothing.
   */
  const haveOpen = found.some((o) => o.field === 'upick_open' && o.confidence >= 0.55)
  const haveHours = found.some((o) => o.field === 'hours')

  if (USE_MODEL && modelTierAvailable() && (!haveOpen || !haveHours)) {
    if (modelCalls >= MAX_MODEL_CALLS || tokensUsed >= MAX_TOKENS_TOTAL) {
      process.stderr.write('  budget reached — stopping the model tier\n')
    } else {
      // The richest page, which is a decent proxy for the one with the news on
      // it: a farm's homepage banner and its "visit" page are the long ones.
      const best = pages
        .map((p) => ({ ...p, text: pageText(p.html) }))
        .sort((a, b) => b.text.length - a.text.length)[0]

      const result = await extractWithModel(best.text, best.url)
      modelCalls++
      if (result) {
        found.push(...result.observations)
        run.tokens_in = result.usage.tokens_in
        run.tokens_out = result.usage.tokens_out
        tokensUsed += result.usage.tokens_in + result.usage.tokens_out
        process.stderr.write(
          `  model: ${result.observations.length} observations` +
          ` (${result.usage.tokens_in}+${result.usage.tokens_out} tokens)\n`,
        )
      }
    }
  }

  // Keep the best observation per field. Tier and confidence both matter, and
  // structured data beats a regex reading the same page.
  const TIER_RANK = { structured: 3, model: 2, heuristic: 1 }
  const best = new Map()
  for (const o of found) {
    // Varieties are many-per-orchard, so they are never deduplicated by field.
    const key = o.field === 'variety' ? `variety:${o.value}` : o.field
    const prior = best.get(key)
    if (
      !prior ||
      o.confidence > prior.confidence ||
      (o.confidence === prior.confidence && TIER_RANK[o.tier] > TIER_RANK[prior.tier])
    ) {
      best.set(key, o)
    }
  }

  for (const o of best.values()) {
    observations.push({ ...o, orchard_id: orchard.id, orchard_slug: orchard.slug })
  }

  const summary = [...best.values()]
    .filter((o) => o.field !== 'variety')
    .map((o) => `${o.field}=${o.value.slice(0, 40)}`)
  const varietyCount = [...best.values()].filter((o) => o.field === 'variety').length

  process.stderr.write(
    `  ${run.pages} pages · ${summary.join(' · ') || 'nothing'}` +
    (varietyCount ? ` · ${varietyCount} varieties` : '') + '\n',
  )

  /*
   * Anything the cheap tiers could not settle goes to a reader.
   *
   * `upick_open` is the field this exists for: a regex cannot tell a current
   * announcement from a three-day-old one, which is why its open claims are
   * scored below the promotion threshold and why `haveOpen` above requires a
   * promotable one rather than merely any.
   */
  if (QUEUE && (!haveOpen || !haveHours)) {
    queued.push({
      slug: orchard.slug,
      name: orchard.name,
      town: orchard.town,
      state: orchard.state,
      orchard_id: orchard.id,
      queued_at: new Date().toISOString(),
      missing: [!haveOpen && 'upick_open', !haveHours && 'hours'].filter(Boolean),
      // Text, never HTML. The reader has no use for markup and it is a third
      // of the tokens.
      pages: pages.map((p) => ({ url: p.url, text: pageText(p.html).slice(0, 12_000) })),
    })
  }

  runs.push({ ...run, finished_at: new Date().toISOString() })
}

writeFileSync(ETAGS, JSON.stringify(Object.fromEntries(etagStore)))

if (QUEUE) {
  const dir = join(CACHE, '..', '.queue')
  mkdirSync(dir, { recursive: true })
  /*
   * Pick-your-own farms first, because they are what people came for and what
   * changes week to week. A farm shop's hours move far less than whether the
   * trees have anything left on them.
   */
  const priority = (q) => {
    const o = orchards.find((x) => x.slug === q.slug)
    return o?.tags.includes('pick_your_own') ? 0 : 1
  }
  queued.sort((a, b) => priority(a) - priority(b) || a.slug.localeCompare(b.slug))
  /*
   * The priority is in the FILENAME, not just the sort order here.
   *
   * Sorting an array and then writing one file per entry loses the ordering
   * entirely — `ls` is alphabetical and does not care what order the files
   * were created in. The reader's instructions say to work through them in the
   * order `ls` gives, so the prefix is what makes that instruction true rather
   * than merely plausible.
   */
  for (const q of queued) {
    const rank = priority(q) === 0 ? 'a-upick' : 'b-other'
    writeFileSync(join(dir, `${rank}-${q.slug}.json`), JSON.stringify(q, null, 2) + '\n')
  }
  process.stderr.write(`queued ${queued.length} farms for a reader in scripts/.queue/\n`)
}

// --- output -----------------------------------------------------------------

const byOutcome = {}
for (const r of runs) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1

process.stderr.write(`
${runs.length} farms crawled
  ${Object.entries(byOutcome).map(([k, v]) => `${k}: ${v}`).join(', ')}
  fetcher: ${JSON.stringify(fetcher.stats)}
  observations: ${observations.length}
  model calls: ${modelCalls}, tokens: ${tokensUsed}
`)

const q = (v) =>
  v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`

if (AS_SQL) {
  const lines = ['-- Generated by scripts/scrape.mjs. Observations, not facts.', 'begin;']
  for (const o of observations) {
    lines.push(
      `insert into scrape_observations (run_id, orchard_id, field, value, tier, confidence, source_url, evidence) ` +
      `select r.id, o.id, ${q(o.field)}, ${q(o.value)}, ${q(o.tier)}::observation_tier, ${o.confidence}, ${q(o.source_url)}, ${q(o.evidence)} ` +
      `from orchards o, lateral (` +
      `insert into scrape_runs (orchard_id, host, outcome) values (o.id, ${q(new URL(o.source_url).host)}, 'ok') returning id` +
      `) r where o.slug = ${q(o.orchard_slug)};`,
    )
  }
  lines.push('commit;')
  process.stdout.write(lines.join('\n') + '\n')
}

if (OUT) {
  writeFileSync(join(ROOT, OUT), JSON.stringify({ runs, observations }, null, 2) + '\n')
  process.stderr.write(`wrote ${OUT}\n`)
}

if (!AS_SQL && !OUT) {
  for (const o of observations.filter((x) => x.field !== 'variety')) {
    process.stdout.write(
      `${o.orchard_slug}  ${o.field}=${o.value}  [${o.tier} ${o.confidence}]\n` +
      (o.evidence ? `    "${o.evidence.slice(0, 120)}"\n` : ''),
    )
  }
}
