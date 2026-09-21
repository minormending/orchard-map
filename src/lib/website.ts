/**
 * What somebody types when a form asks for a website, and what the rest of
 * this project can actually use.
 *
 * The field is new; the column is not. Every one of the 217 websites already
 * in the table is an absolute URL with a scheme, and that is load-bearing
 * rather than tidy. Two things take the stored string exactly as it stands:
 *
 *   `scrape.mjs` groups its targets by `new URL(o.website).host` and skips the
 *   row when that throws. A bare `abmasfarm.com` throws, so the farm drops out
 *   of every future crawl — silently, and for precisely the field whose whole
 *   purpose is to make the crawl possible.
 *
 *   The farm page renders `href={orchard.website}` unaltered. A bare host is a
 *   RELATIVE link: `abmasfarm.com` under `/orchard/abma-s-farm-market` points
 *   at a page that does not exist.
 *
 * Both failures look exactly like a field somebody filled in correctly, which
 * is the kind of wrong this project keeps having to dig out later. So the
 * value is settled here, before it is sent, and shown to the person rather
 * than applied behind them — the same bargain `locate.ts` strikes with the
 * geocoder, for the same reason.
 *
 * The database refuses what this function would not produce. That split is
 * deliberate and matches `STATES`: the browser is where a convenience for the
 * person typing belongs, and the column's own rule has to hold against a
 * caller that never ran this code.
 */

/**
 * Longer than any website in the table by a wide margin, and still short
 * enough that nothing else could be hiding in the field.
 */
export const MAX_WEBSITE = 500

export type Website =
  /** `null` means the field was left empty, which is allowed. */
  | { ok: true; url: string | null }
  | { ok: false; reason: string }

/** The two schemes a website can have. */
const WEB_SCHEME = /^https?:\/\//i

/**
 * Something that opens like `scheme:` and is therefore not a bare host.
 *
 * The dot is what keeps `abmasfarm.com:8080` out of this: a port is part of an
 * address somebody meant, and `mailto`, `javascript` and `ftp` — the three
 * things this is here to catch — have no dot in front of the colon.
 */
const OTHER_SCHEME = /^([a-z][a-z0-9+-]*):/i

/**
 * A host with at least one dot in it, and no empty label at either end.
 *
 * `new URL` is satisfied by `https://abmasfarm`, which is a valid URL and not
 * a website anybody has. A typo that parses is worse than one that does not,
 * because only the second kind gets mentioned to the person who made it.
 */
const HOSTNAME = /^[^.\s]+(?:\.[^.\s]+)+$/

/**
 * Read what was typed, and say what would be stored.
 *
 * Adding a missing scheme is the only change this makes. It is the same class
 * of repair as upper-casing `ct` into `CT` in migration 016 — `abmasfarm.com`
 * is how people write a website down, not a claim about a different address —
 * and everything else the string contains is kept as typed.
 *
 * The scheme it adds is `https`, because that is what a browser's address bar
 * does with a bare host and what half the table already carries. The cost is
 * worth naming: a farm still serving plain HTTP gets a URL the crawler cannot
 * reach, and a host that fails twice is parked, so the row would simply learn
 * nothing — the state it is in now, not a wrong fact on a page. That is also
 * why the result is shown in the form instead of applied quietly: somebody who
 * knows their site has no certificate can type `http://` and be believed.
 */
export function readWebsite(raw: string | null | undefined): Website {
  const typed = String(raw ?? '').trim()
  if (!typed) return { ok: true, url: null }

  if (/\s/.test(typed)) {
    return { ok: false, reason: 'A web address has no spaces in it.' }
  }
  if (typed.length > MAX_WEBSITE) {
    return { ok: false, reason: 'That is too long to be a web address.' }
  }

  /*
   * A scheme that is not the web's is refused rather than repaired. `mailto:`
   * is somebody answering a different question; `javascript:` is somebody
   * answering this one in bad faith, and whatever is stored here ends up in an
   * `href` on a page this project publishes.
   */
  const web = WEB_SCHEME.test(typed)
  const other = web ? null : typed.match(OTHER_SCHEME)
  if (other) {
    return { ok: false, reason: `A website starts with https://, not ${other[1]}:.` }
  }

  const url = web ? typed : `https://${typed}`

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'That does not look like a web address.' }
  }

  if (!HOSTNAME.test(parsed.hostname)) {
    return {
      ok: false,
      reason: 'That needs to be a full domain, like abmasfarm.com.',
    }
  }

  return { ok: true, url }
}
