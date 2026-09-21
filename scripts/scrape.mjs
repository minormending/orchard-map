#!/usr/bin/env node
/**
 * Read the farms' own websites.
 *
 *   node scripts/scrape.mjs --limit 5           crawl five, print what it found
 *   node scripts/scrape.mjs --limit 5 --model   also use the model tier
 *   node scripts/scrape.mjs --out obs.json      write observations
 *   node scripts/scrape.mjs --sql > obs.sql     emit SQL for a database
 *   node scripts/scrape.mjs --pending           include farms awaiting review
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
import { crawlable, resolves } from './lib/hosts.mjs'

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
const PENDING = flag('pending')

/**
 * The kill switch.
 *
 * An unattended loop holding an API key fails as a bill rather than as an
 * outage, which is a worse failure because nothing alerts on it. Both caps are
 * checked before every model call and the run stops dead when either is hit.
 */
const MAX_MODEL_CALLS = Number(process.env.ORCHARD_MAX_MODEL_CALLS ?? 250)
const MAX_TOKENS_TOTAL = Number(process.env.ORCHARD_MAX_TOKENS ?? 2_000_000)

const varieties = read('varieties.json')

/*
 * Farms awaiting review, when asked for.
 *
 * `src/data/orchards.json` holds what is published, and a submitted farm is
 * deliberately not in it. That made the order of events wrong: a submission
 * could only be crawled after somebody approved it, when reading the farm's
 * own website is most of what decides whether to approve it at all.
 *
 * `export-data.mjs --pending` writes these out of the database; the file is
 * gitignored because the rows are unreviewed and typed by strangers. Absent
 * is the normal case — CI has no database credentials and crawls the
 * published file alone — so a missing file is not an error here.
 */
const PENDING_FILE = join(ROOT, 'scripts', '.pending.json')
const pending = PENDING && existsSync(PENDING_FILE)
  ? JSON.parse(readFileSync(PENDING_FILE, 'utf8')).map((o) => ({ ...o, pending: true }))
  : []

if (PENDING && pending.length === 0) {
  process.stderr.write(
    existsSync(PENDING_FILE)
      ? 'no submissions awaiting review\n'
      : `no ${PENDING_FILE} — run: node scripts/export-data.mjs --pending\n`,
  )
}

const orchards = [...pending, ...read('orchards.json')]

let targets = orchards.filter((o) => o.website)
if (ONLY) targets = targets.filter((o) => o.slug.includes(ONLY))

/*
 * Group by host, because four websites in this dataset serve two listings each
 * — a farm and its cidery, or two locations of one business. Crawling per
 * listing meant visiting those sites twice per run, which is the opposite of
 * what the polite fetcher is for, and then attributing whatever was found to
 * BOTH listings.
 *
 * That second part produced a real error on the first live run: Barton
 * Orchards' u-pick price of $25 a peck, which belongs to the Poughquag farm,
 * was attached to the Apple Core farm stand in Poughkeepsie as well, because
 * both carry bartonorchards.com. A reader caught it. Nothing in the code would
 * have.
 *
 * So: one crawl per host, and where a host serves several listings the
 * deterministic observations are held back entirely — a regex cannot tell
 * which of two businesses a sentence is about, and guessing is how a farm
 * stand acquires a u-pick price it does not charge.
 */
const byHost = new Map()
const refused = []
for (const o of targets) {
  /*
   * `lib/hosts.mjs` replaced a bare `new URL(...).host` in a try/catch here.
   * The old version dropped anything that would not parse and said nothing,
   * which was tolerable while every URL came from a state directory and is
   * not now that one can come from a submission: the crawler decides what it
   * will visit, and a refusal is worth printing either way.
   */
  const where = crawlable(o.website)
  if (!where.ok) {
    refused.push({ slug: o.slug, name: o.name, website: o.website, reason: where.reason })
    continue
  }
  if (!byHost.has(where.host)) byHost.set(where.host, [])
  // The name to look up travels with the listing: it is the one the fetch will
  // connect to, `www.` and all.
  byHost.get(where.host).push({ ...o, hostname: where.hostname })
}

/*
 * Submissions first. There are rarely more than a handful, somebody is
 * waiting on each one, and `--limit` would otherwise spend the whole run on
 * the published farms it happened to sort before them.
 */
const hosts = [...byHost.entries()]
  .sort(([, a], [, b]) => (b[0].pending ? 1 : 0) - (a[0].pending ? 1 : 0))
  .slice(0, LIMIT)

if (refused.length) {
  process.stderr.write(
    `not crawling ${refused.length}:\n` +
    refused.map((r) => `  ${r.name}: ${r.website} — ${r.reason}`).join('\n') + '\n\n',
  )
}

if (hosts.length === 0) {
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
  `crawling ${hosts.length} sites (${targets.length - refused.length} listings)` +
  (USE_MODEL
    ? modelTierAvailable()
      ? ` · model tier on (${MODEL})`
      : ' · model tier requested but ANTHROPIC_API_KEY is unset — skipping it'
    : ' · heuristics only') +
  '\n\n',
)

for (const [host, sharing] of hosts) {
  const orchard = sharing[0]
  const shared = sharing.length > 1

  const run = {
    orchard_id: orchard.id,
    slug: orchard.slug,
    host,
    pending: orchard.pending === true,
    started_at: new Date().toISOString(),
    outcome: 'ok',
    pages: 0,
    bytes: 0,
    fetch_tier: 1,
    tokens_in: 0,
    tokens_out: 0,
  }

  process.stderr.write(
    (shared
      ? `${sharing.map((o) => o.name).join(' + ')} (${host}, shared)`
      : `${orchard.name} (${host})`) +
    (orchard.pending ? ' — awaiting review' : '') + '\n',
  )

  /*
   * The name is checked against what it resolves to, not just how it is
   * spelled — `farm.example.com` pointing at 192.168.1.1 is the interesting
   * case, and the syntax check above cannot see it. See lib/hosts.mjs for
   * what this does and does not close.
   */
  const reachable = await resolves(orchard.hostname)
  if (!reachable.ok) {
    run.outcome = reachable.reason
    process.stderr.write(`  ${run.outcome}\n`)
    runs.push({ ...run, finished_at: new Date().toISOString() })
    continue
  }

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

  // See the grouping note above: on a shared host a deterministic observation
  // has no way to know which of the listings it is about, so it is not made.
  if (!shared) {
    for (const o of best.values()) {
      observations.push({ ...o, orchard_id: orchard.id, orchard_slug: orchard.slug })
    }
  }

  const summary = [...best.values()]
    .filter((o) => o.field !== 'variety')
    .map((o) => `${o.field}=${o.value.slice(0, 40)}`)
  const varietyCount = [...best.values()].filter((o) => o.field === 'variety').length

  process.stderr.write(
    `  ${run.pages} pages · ${summary.join(' · ') || 'nothing'}` +
    (varietyCount ? ` · ${varietyCount} varieties` : '') +
    // Otherwise the line reads as a list of things that were recorded, when
    // on a shared host every one of them is being thrown away on purpose.
    (shared ? ' — held back, shared site, left to the reader' : '') + '\n',
  )

  /*
   * Anything the cheap tiers could not settle goes to a reader.
   *
   * `upick_open` is the field this exists for: a regex cannot tell a current
   * announcement from a three-day-old one, which is why its open claims are
   * scored below the promotion threshold and why `haveOpen` above requires a
   * promotable one rather than merely any.
   *
   * A farm awaiting review is queued whatever the cheap tiers found. For a
   * published farm the question is narrow — are they picking, when are they
   * open — and a structured answer settles it. For a submission the question
   * underneath is whether this is a real farm that belongs on the map at all,
   * and no regex has an opinion about that.
   */
  if (QUEUE && (orchard.pending || !haveOpen || !haveHours)) {
    queued.push({
      slug: orchard.slug,
      name: orchard.name,
      town: orchard.town,
      state: orchard.state,
      orchard_id: orchard.id,
      /* Not on the map. Somebody submitted it and nobody has decided yet —
         which is why this file exists before the decision instead of after. */
      ...(orchard.pending
        ? { pending_review: true, address: orchard.address ?? null }
        : {}),
      /* When a site serves more than one listing, the reader is told so and
         attributes each observation itself — it is the only party that can. */
      shares_site_with: shared
        ? sharing.slice(1).map((o) => ({ slug: o.slug, name: o.name, town: o.town }))
        : [],
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
   * Submissions first, then pick-your-own.
   *
   * A submission is somebody waiting on a decision, and there are rarely more
   * than a couple. After those, pick-your-own farms are what people came for
   * and what changes week to week — a farm shop's hours move far less than
   * whether the trees have anything left on them.
   */
  const priority = (q) => {
    if (q.pending_review) return 0
    const o = orchards.find((x) => x.slug === q.slug)
    return o?.tags.includes('pick_your_own') ? 1 : 2
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
  const RANK = ['a-pending', 'b-upick', 'c-other']
  for (const q of queued) {
    const rank = RANK[priority(q)]
    writeFileSync(join(dir, `${rank}-${q.slug}.json`), JSON.stringify(q, null, 2) + '\n')
  }
  process.stderr.write(`queued ${queued.length} farms for a reader in scripts/.queue/\n`)
}

// --- output -----------------------------------------------------------------

const byOutcome = {}
for (const r of runs) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1

process.stderr.write(`
${runs.length} farms crawled${runs.some((r) => r.pending)
  ? `, ${runs.filter((r) => r.pending).length} of them awaiting review`
  : ''}
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
  // join() with an absolute second argument silently nests it under ROOT, so
  // `--out /tmp/x.json` wrote to <repo>/tmp/x.json and looked like it had done
  // nothing at all.
  const out = OUT.startsWith('/') ? OUT : join(ROOT, OUT)
  writeFileSync(out, JSON.stringify({ runs, observations }, null, 2) + '\n')
  process.stderr.write(`wrote ${out}\n`)
}

if (!AS_SQL && !OUT) {
  for (const o of observations.filter((x) => x.field !== 'variety')) {
    process.stdout.write(
      `${o.orchard_slug}  ${o.field}=${o.value}  [${o.tier} ${o.confidence}]\n` +
      (o.evidence ? `    "${o.evidence.slice(0, 120)}"\n` : ''),
    )
  }
}
