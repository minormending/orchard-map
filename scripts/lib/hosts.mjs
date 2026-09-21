/**
 * Which hosts the crawler is allowed to visit.
 *
 * This did not need to exist while every website on the map came from a state
 * apple directory or from OpenStreetMap. Those URLs were chosen by an
 * organisation and read by a person before they were imported, and the worst
 * one of them could do was 404.
 *
 * A submitted orchard changes that. Anybody with an account can now type a URL
 * and have this project's crawler fetch it, unattended, from whichever machine
 * runs the nightly read — which for the daily routine is a laptop, sitting
 * inside a home network. `http://192.168.1.1/`, `http://127.0.0.1:3000/` and
 * `http://169.254.169.254/latest/meta-data/` are all things a URL can say, and
 * `PoliteFetcher` checks only that the scheme is http or https.
 *
 * So the crawler decides what it will visit, rather than the person who typed
 * the address. Two checks, in the order they get cheaper to be wrong about:
 *
 *   `crawlable()`   is this a public name at all — syntax only, no network
 *   `resolves()`    and does it point at a public address
 *
 * ---------------------------------------------------------------------------
 * What this does not do
 * ---------------------------------------------------------------------------
 *
 * `resolves()` looks the name up and then hands the URL to `fetch`, which
 * looks it up again. A name that answers differently between those two moments
 * — DNS rebinding — gets through. Closing that properly means resolving once
 * and connecting to the address, which is a custom agent and a different
 * amount of work than this is worth today.
 *
 * It is worth being precise about what remains, rather than implying the door
 * is shut: an attacker who controls a domain's DNS can make one GET request
 * from the crawling machine to an address of their choosing, and read nothing
 * back — the response text goes into a queue file on that machine, not to
 * them. The check below stops the whole class of attack that needs no DNS at
 * all, which is the one somebody actually tries.
 */
import { lookup } from 'node:dns/promises'

/** Hosts that are a machine here rather than a farm somewhere. */
const LOCAL_SUFFIX = /(?:^|\.)(?:localhost|local|internal|home\.arpa|localdomain)$/i

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * Is this an address rather than a name?
 *
 * No farm's website is an IP literal — there are 216 on the map and not one of
 * them — so refusing the whole shape costs nothing and removes every numeric
 * way of asking for a machine on the crawling host's own network.
 */
const isIpLiteral = (hostname) =>
  IPV4.test(hostname) || hostname.includes(':') || /^\[.*\]$/.test(hostname)

/**
 * Syntax only. Returns the host to group by and the one to look up, or why the
 * URL will not be visited.
 *
 * Two of them because they are different questions. `host` drops `www.` so a
 * farm and its cidery on the same site are crawled once; `hostname` is what
 * will actually be connected to, and plenty of sites answer on `www.` and not
 * on the bare domain — looking up the grouped name would refuse those.
 *
 * `src/lib/website.ts` applies the same rule in the browser so somebody typing
 * a URL is told rather than ignored. That is a second copy and it is checked
 * against this one in `test/website.test.mjs`, the way `locate.ts` is checked
 * against `directory.mjs` — scripts do not import from `src/` anywhere here.
 */
export function crawlable(website) {
  let url
  try {
    url = new URL(String(website ?? ''))
  } catch {
    return { ok: false, reason: 'not a URL' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `not a web address (${url.protocol})` }
  }

  const hostname = url.hostname.replace(/\.$/, '').toLowerCase()

  if (!hostname) return { ok: false, reason: 'no host' }
  if (isIpLiteral(hostname)) return { ok: false, reason: 'an IP address, not a farm' }
  if (LOCAL_SUFFIX.test(hostname)) return { ok: false, reason: `a local name (${hostname})` }
  if (!hostname.includes('.')) return { ok: false, reason: `not a domain (${hostname})` }

  return { ok: true, host: hostname.replace(/^www\./, ''), hostname }
}

/**
 * Ranges that are somewhere on the crawling machine's own network rather than
 * on the internet. The metadata address, 169.254.169.254, is inside the
 * link-local block and is the reason this list is not just "the RFC 1918
 * three".
 */
const PRIVATE_V4 = [
  '0.0.0.0/8',        // this network
  '10.0.0.0/8',       // RFC 1918
  '100.64.0.0/10',    // carrier-grade NAT
  '127.0.0.0/8',      // loopback
  '169.254.0.0/16',   // link-local, and the cloud metadata endpoint inside it
  '172.16.0.0/12',    // RFC 1918
  '192.0.0.0/24',     // IETF protocol assignments
  '192.168.0.0/16',   // RFC 1918
  '198.18.0.0/15',    // benchmarking
  '224.0.0.0/4',      // multicast
  '240.0.0.0/4',      // reserved, and broadcast at the very top
]

/*
 * Written as CIDR and compared as integers, after the first draft stored the
 * prefixes as octets and quietly let 240.0.0.1 through: `224.0.0.0/4` spans
 * 224 to 239, and matching the first octet against 224 alone is not that
 * range. The test below walks both edges of every block for this reason.
 */
const toInt = (a) => a.split('.').reduce((n, o) => n * 256 + Number(o), 0)

const BLOCKS = PRIVATE_V4.map((cidr) => {
  const [base, bits] = cidr.split('/')
  const mask = bits === '0' ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0
  // `&` yields a SIGNED int32, so both sides are forced back to unsigned —
  // without that, every block whose first octet is 128 or more compares a
  // negative base against a positive address and never matches.
  return { base: (toInt(base) & mask) >>> 0, mask }
})

export function isPrivateAddress(address, family) {
  const a = String(address).toLowerCase()

  if (family === 6 || a.includes(':')) {
    // IPv4 mapped into v6 is still the v4 address it names.
    const mapped = a.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
    if (mapped) return isPrivateAddress(mapped[1], 4)
    if (a === '::' || a === '::1') return true
    if (/^f[cd][0-9a-f]{2}:/.test(a)) return true  // unique local, fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(a)) return true  // link local, fe80::/10
    return false
  }

  const octets = a.split('.').map(Number)
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true  // unparseable is not a public address anybody meant
  }

  const ip = toInt(a)
  return BLOCKS.some((b) => ((ip & b.mask) >>> 0) === b.base)
}

/**
 * Does this name point somewhere on the internet?
 *
 * Every address it resolves to has to be public. One private answer is enough
 * to refuse the host — a name with both is a name doing something deliberate.
 */
export async function resolves(host) {
  let addresses
  try {
    addresses = await lookup(host, { all: true })
  } catch (err) {
    return { ok: false, reason: `does not resolve (${err.code ?? 'lookup failed'})` }
  }
  if (addresses.length === 0) return { ok: false, reason: 'does not resolve' }

  const priv = addresses.find((a) => isPrivateAddress(a.address, a.family))
  if (priv) return { ok: false, reason: `resolves to a private address (${priv.address})` }

  return { ok: true }
}
