/**
 * Getting facts out of a farm's website.
 *
 * Three tiers, tried in order, and the ordering is evidence-based rather than
 * aesthetic. Sampling orchard sites while scoping this project found:
 *
 *   maskers.com        157KB, JSON-LD Place + PostalAddress, no openingHours
 *   hurdsfamilyfarm    1.4MB, JSON-LD LocalBusiness,         no openingHours
 *   duboisfarms.com    5KB of shell, everything rendered in JS
 *
 * So tier 1 is nearly free and answers address and phone, which we already
 * have. It does NOT answer the one thing that matters — whether picking is on
 * today — because not one sampled site publishes that machine-readably. That
 * is the entire justification for tier 3 existing.
 *
 * Every extractor returns observations, never values. An observation carries
 * its source URL, the sentence it came from, and a confidence, so a wrong
 * promotion can be explained rather than appearing as a number nobody can
 * account for.
 */

/** Strip a page to readable text, dropping the parts that lie. */
export function pageText(html) {
  return String(html ?? '')
    // Script and style content is not prose and is full of false positives:
    // a variety name in a JSON blob is not the farm saying they grow it.
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

/** Every JSON-LD block on the page, flattened, bad JSON skipped. */
export function jsonLd(html) {
  const out = []
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(String(html ?? ''))) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim())
      const items = Array.isArray(parsed) ? parsed : [parsed]
      for (const item of items) {
        if (item && typeof item === 'object') {
          out.push(item)
          if (Array.isArray(item['@graph'])) out.push(...item['@graph'])
        }
      }
    } catch {
      // A broken block is common and is not worth failing a crawl over.
    }
  }
  return out
}

const obs = (field, value, tier, confidence, url, evidence) => ({
  field, value: String(value), tier, confidence, source_url: url,
  evidence: evidence ? evidence.slice(0, 300) : null,
})

// --- tier 1: structured data ------------------------------------------------

export function extractStructured(html, url) {
  const found = []
  for (const node of jsonLd(html)) {
    const hours = node.openingHours ?? node.openingHoursSpecification
    if (hours) {
      const text = Array.isArray(hours)
        ? hours.map((h) => (typeof h === 'string' ? h : formatSpec(h))).filter(Boolean).join('; ')
        : typeof hours === 'string' ? hours : formatSpec(hours)
      if (text) {
        // The operator published this in machine-readable form. Nothing else
        // in this file gets to be this confident.
        found.push(obs('hours', text, 'structured', 0.95, url, text))
      }
    }
  }
  return found
}

function formatSpec(spec) {
  if (!spec || typeof spec !== 'object') return null
  const days = [].concat(spec.dayOfWeek ?? []).map((d) => String(d).split('/').pop()).join(',')
  const open = spec.opens
  const close = spec.closes
  if (!open || !close) return null
  return `${days || 'Daily'} ${open}-${close}`
}

// --- tier 2: heuristics -----------------------------------------------------

/**
 * Is picking on?
 *
 * The asymmetry here is deliberate and matters more than the patterns. A false
 * "open" sends somebody on a two-hour drive; a false "closed" costs them a
 * farm they could have visited. So the closed patterns are checked FIRST and
 * carry higher confidence, and an ambiguous page yields nothing rather than a
 * cheerful guess.
 *
 * The open case is deliberately scored BELOW the default promotion threshold,
 * so a regex alone can never put "picking is open" on the map. That is not
 * caution for its own sake — the first real run produced this, from Altamont
 * Orchards on 17 September:
 *
 *     "PICK YOUR OWN APPLES : Open on September 12 & 13th 10 AM to 4PM"
 *
 * which is a true sentence about a weekend that had already passed. A pattern
 * match has no idea what day it is, and no amount of pattern-tuning gives it
 * one. Reading a date against today is a judgment, so asserting "open" is left
 * to the model tier, which is given the date and asked to make it. Closed
 * claims stay promotable: they are rarely time-limited in the same way, and
 * being wrong about them is the cheap direction.
 */
const CLOSED_PATTERNS = [
  /\bu-?pick\b[^.!?\n]{0,40}\b(is\s+)?(now\s+)?clos(ed|ing)\b/i,
  /\b(picking|u-?pick)\b[^.!?\n]{0,40}\bdone for (the|this) (season|year)\b/i,
  /\bno (more )?(u-?pick|picking)\b/i,
  /\bwe are (now )?clos(ed|ing) for the season\b/i,
  /\bpicked out\b/i,
  /\bsold out of (apples|u-?pick)\b/i,
]

const OPEN_PATTERNS = [
  /\bu-?pick\b[^.!?\n]{0,40}\b(is\s+)?(now\s+)?open\b/i,
  /\b(now )?pick(ing)?\s+(your own\s+)?apples?\b[^.!?\n]{0,30}\b(open|now|today|daily)\b/i,
  /\bapple picking is open\b/i,
  /\bopen (daily|weekends|every day)\b[^.!?\n]{0,30}\b(pick|apple)/i,
]

/**
 * A closure that is about TODAY is not a closure of the season.
 *
 * `upick_open` means "their site says picking is running this season". Farms
 * shut the orchard for a day all the time — rain, mud, a wedding — and say so
 * in a banner, which is the most prominent text on the page and therefore the
 * first thing a closed pattern hits. From a real run on 20 September, at
 * Bowman Orchards:
 *
 *     "OUTSIDE Activities (U-Pick/Rides & Attractions) CLOSED TODAY 9/20
 *      due to heavy rains!!"
 *
 * That scored `upick_open=false` at 0.75 — above the promotion threshold —
 * while the same site said "Currently Picking: Apples, & Raspberries" and sold
 * 2026 season picking containers. The banner is evidence the season is ON: a
 * farm does not announce today's rain closure in a season it is not running.
 *
 * Note what this is NOT. It is not a pattern that decides whether the closure
 * has expired — that needs today's date, and a regex has no idea what day it
 * is, which is the same reason open claims are left to the model tier. It only
 * recognises that the sentence is scoped to a day rather than to a season, and
 * declines to answer a seasonal question with a daily one. The farm then falls
 * through to the queue and a reader settles it against the calendar.
 */
const DAY_SCOPED = [
  /\b(today|tonight|tomorrow|this (morning|afternoon|evening)|right now|at this time|currently)\b/i,
  /\b(due to|because of|owing to)\b[^.!?\n]{0,30}\b(weather|rain|storm|wind|snow|ice|frost|fog|lightning|mud|heat|flooding)\b/i,
  /\b(rained out|weather permitting|weather dependent)\b/i,
  /\bclos(ed|ing)\b[^.!?\n]{0,20}\b(mon|tues?|wed(nes)?|thur?s?|fri|sat(ur)?|sun)(day)?s?\b/i,
  /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/,
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i,
]

/**
 * ...unless the sentence says "season" itself, which settles the scope.
 *
 * Checked BEFORE the day patterns and wins over them, so "closed for the
 * season as of October 31" stays a season claim rather than being thrown out
 * for containing a date.
 */
const SEASON_SCOPED =
  /\b(for (the|this) (season|year)|next (season|year)|until next|rest of (the|this) season|season (is|has) (ended|finished|wrapped))\b/i

/** Is this closure about one day rather than about the season? */
function isDayScoped(sentence) {
  if (SEASON_SCOPED.test(sentence)) return false
  return DAY_SCOPED.some((re) => re.test(sentence))
}

/** Every place a pattern matches, not just the first. */
function* allMatches(re, text) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let m
  while ((m = g.exec(text)) !== null) {
    yield m
    if (m.index === g.lastIndex) g.lastIndex++
  }
}

/**
 * A closure repeated down a schedule is a row, not a verdict.
 *
 * `isDayScoped` reads the line the match is on, which is the whole of what a
 * banner is. A calendar is not: it puts the date in one cell and the closure
 * in the next, and `pageText` flattens that into lines where some carry both
 * and some carry only the closure. From a real run on 21 September, at Soons
 * Orchards:
 *
 *     9/5-7 (Labor Day  Weekend): U-Pick apples is closed
 *     **RESERVATIONS required**
 *     U-Pick apples is closed
 *     October weekends
 *     10/3-4: U-Pick apples is closed
 *
 * The bare third line has no date in it and nothing next to it does either, so
 * the day guard passed it and the page scored `upick_open=false` at 0.75 —
 * above the promotion threshold. An April freeze had cut the crop and the farm
 * was running a handful of ticketed dates through October. Promoting that
 * would have told people a working orchard was shut for the year, which is the
 * Altamont mistake with the sign reversed: there a regex read a finished
 * weekend as an open season, here it reads one closed weekend as a closed one.
 *
 * So the scope of a closure is settled by every place the page uses the same
 * words, not only by the line in front of us. A farm announces a season
 * closure once. A schedule says it per row, and at least one of those rows
 * carries its date.
 *
 * Widening the window instead — reading the neighbouring lines — was the first
 * attempt and does not work here: the bare line's neighbours are
 * "**RESERVATIONS required**" and "October weekends", neither of which is a
 * date. The repetition is the signal, not the proximity.
 */
export function extractUpickOpen(text, url) {
  for (const re of CLOSED_PATTERNS) {
    const found = [...allMatches(re, text)].map((m) => ({
      // The matched words alone, so "9/5-7 (Labor Day Weekend): U-Pick apples
      // is closed" and a bare "U-Pick apples is closed" are recognisably the
      // same claim appearing twice.
      phrase: m[0].replace(/\s+/g, ' ').trim().toLowerCase(),
      sentence: sentenceAround(text, m.index),
    }))

    // Phrases this page states somewhere with a date attached.
    const scheduled = new Set(
      found.filter((f) => isDayScoped(f.sentence)).map((f) => f.phrase))

    for (const f of found) {
      /*
       * A sentence that says "season" settles its own scope, whatever the rest
       * of the page does with the same words. Without this the guard would
       * eat the real thing: a page carrying both "10/3-4: u-pick is closed"
       * and "our u-pick is closed for the season" repeats a phrase that is
       * scheduled elsewhere, and the second sentence is still the answer.
       */
      if (!SEASON_SCOPED.test(f.sentence)) {
        // A rain-day banner is not a season claim, and neither is one row of a
        // calendar. Skip and keep reading: the same page may still carry a
        // real "closed for the season" further down, and that one counts.
        if (isDayScoped(f.sentence) || scheduled.has(f.phrase)) continue
      }
      return [obs('upick_open', 'false', 'heuristic', 0.75, url, f.sentence)]
    }
  }
  for (const re of OPEN_PATTERNS) {
    const m = re.exec(text)
    // 0.35 is below the promotion threshold on purpose. The observation is
    // recorded — it is real, and a moderator may want it — but it cannot
    // become a fact without the model tier corroborating it.
    if (m) return [obs('upick_open', 'true', 'heuristic', 0.35, url, sentenceAround(text, m.index))]
  }
  return []
}

/**
 * Spellings farms actually use.
 *
 * Maskers writes "Macintosh"; the association writes "McIntosh". Without this
 * the single most-grown apple in New York is invisible to the scraper, which
 * was found by running it rather than by thinking about it. Aliases must stay
 * specific enough not to collide: "Mac" alone would match "Macoun".
 */
const ALIASES = {
  mcintosh: ['Macintosh', 'Mac Intosh'],
  crispin: ['Mutsu'],
  'golden-delicious': ['Golden Del'],
  'red-delicious': ['Red Del'],
  'granny-smith': ['Granny'],
  evercrisp: ['Ever Crisp'],
  snapdragon: ['Snap Dragon'],
  zestar: ['Zestar'],
  sweetango: ['Sweet Tango', 'SweetTango'],
  rubyfrost: ['Ruby Frost'],
  wildtwist: ['Wild Twist'],
  '20-ounce': ['Twenty Ounce'],
  jonamac: ['Jona Mac'],
  'acey-mac': ['Acey'],
}

/**
 * Which varieties the page mentions.
 *
 * Matched against the known vocabulary rather than guessed, so a page cannot
 * invent an apple. Word-boundary anchored, because "Gala" appears inside
 * "Galaxy" and "Rome" inside "Romeo" — and a farm shop page mentioning a Rome
 * apple is a very different thing from a page about a wedding venue in Rome.
 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Sentences where naming an apple does not mean growing it.
 *
 * Found by running the scraper rather than by imagining it. Maskers' ripening
 * schedule describes Empire as "cross between a Macintosh and Red Delicious",
 * and Jonagold as a "cross between Golden Delicious and Jonathan". Both are
 * parentage. Taking them at face value would have the map claiming two
 * varieties this farm may well not grow.
 *
 * These are demoted rather than dropped, which is the point of storing
 * observations rather than values: the sighting is real and worth keeping, it
 * just must not clear the promotion threshold on its own.
 *
 * Position matters. In "Empire — cross between a Macintosh and Red Delicious",
 * Empire is the subject and IS grown here; Macintosh and Red Delicious are the
 * parents and may not be. So only a match occurring AFTER the parentage phrase
 * is demoted. Demoting the whole sentence loses the one variety it was
 * actually about — which the first version of this did.
 */
const PARENTAGE = /\b(cross(ed)? (between|with)|hybrid|parent|seedling of|descend|similar to|cousin|related to|instead of|rather than)\b/i

export function extractVarieties(text, url, vocabulary) {
  const found = []
  for (const v of vocabulary) {
    // Drop trademark marks and punctuation the page will not have.
    const names = [v.name.replace(/[®™!]/g, '').trim(), ...(ALIASES[v.slug] ?? [])]
    for (const name of names) {
      if (name.length < 4) continue
      const re = new RegExp(`\\b${escapeRe(name)}\\b`, 'i')
      const m = re.exec(text)
      if (m) {
        const lineFrom = Math.max(0, text.lastIndexOf('\n', m.index) + 1)
        const evidence = sentenceAround(text, m.index)
        const offset = m.index - lineFrom
        const parentage = PARENTAGE.exec(evidence)
        const confidence = parentage && offset > parentage.index ? 0.25 : 0.7
        found.push(obs('variety', v.slug, 'heuristic', confidence, url, evidence))
        break
      }
    }
  }
  return found
}

/** Admission and u-pick pricing, when the page states one plainly. */
const PRICE_PATTERNS = [
  /\$\s?\d+(?:\.\d{2})?\s*(?:per|\/)\s*(?:person|adult|car|vehicle|bag|peck|half[- ]peck)/i,
  /\b(?:admission|entry|entrance)\b[^.!?\n]{0,30}\$\s?\d+(?:\.\d{2})?/i,
  /\bfree admission\b/i,
]

export function extractAdmission(text, url) {
  for (const re of PRICE_PATTERNS) {
    const m = re.exec(text)
    if (m) {
      return [obs('admission', m[0].trim(), 'heuristic', 0.6, url, sentenceAround(text, m.index))]
    }
  }
  return []
}

const RESERVATION_PATTERNS = [
  /\b(timed\s+)?(tickets?|reservations?)\s+(are\s+)?required\b/i,
  /\bmust (be )?(purchase|buy|reserve|book)\b[^.!?\n]{0,30}\b(ticket|reservation)/i,
  /\badvance (tickets?|reservations?)\b[^.!?\n]{0,20}\brequired\b/i,
]

export function extractReservations(text, url) {
  for (const re of RESERVATION_PATTERNS) {
    const m = re.exec(text)
    if (m) {
      return [obs('reservations_required', 'true', 'heuristic', 0.65, url, sentenceAround(text, m.index))]
    }
  }
  return []
}

/** The sentence a match sits in, for a human reviewing the promotion. */
export function sentenceAround(text, index) {
  const from = Math.max(0, text.lastIndexOf('\n', index) + 1)
  const stop = text.indexOf('\n', index)
  const to = stop === -1 ? Math.min(text.length, index + 200) : stop
  return text.slice(from, to).trim()
}

/**
 * Everything tier 1 and 2 can find on one page.
 *
 * Deliberately returns an empty array rather than nulls or placeholders: an
 * absent observation and an observation of "we do not know" are different
 * things, and only the first is honest.
 */
export function extractAll(html, url, vocabulary) {
  const text = pageText(html)
  return [
    ...extractStructured(html, url),
    ...extractUpickOpen(text, url),
    ...extractAdmission(text, url),
    ...extractReservations(text, url),
    ...extractVarieties(text, url, vocabulary),
  ]
}

/**
 * Which pages on a farm's site are worth the fetch budget.
 *
 * Six pages per host, so they have to be the right six. Scored by what the
 * link says rather than crawled breadth-first, because the answer is almost
 * always behind a link that says "u-pick" or "visit" and almost never four
 * levels down.
 */
const LINK_SCORES = [
  [/u-?pick|pick.your.own|picking/i, 10],
  [/hours|open|visit|plan.your/i, 8],
  [/apple|orchard|variet|crop/i, 6],
  [/admission|ticket|price|rates/i, 5],
  [/farm.stand|market|store|shop/i, 3],
  [/news|update|blog/i, 2],
]

export function rankLinks(html, baseUrl, limit = 5) {
  const scored = new Map()
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi
  let m
  while ((m = re.exec(String(html ?? ''))) !== null) {
    let href
    try {
      href = new URL(m[1], baseUrl)
    } catch {
      continue
    }
    // Same host only. A farm's Facebook page is not the farm's website, and
    // following off-site links is how a crawler becomes somebody else's problem.
    if (href.host !== new URL(baseUrl).host) continue
    if (!/^https?:$/.test(href.protocol)) continue
    href.hash = ''

    const label = `${m[2].replace(/<[^>]+>/g, ' ')} ${href.pathname}`
    let score = 0
    for (const [pattern, points] of LINK_SCORES) {
      if (pattern.test(label)) score += points
    }
    if (score === 0) continue

    const key = href.href
    if (!scored.has(key) || scored.get(key) < score) scored.set(key, score)
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([url]) => url)
}
