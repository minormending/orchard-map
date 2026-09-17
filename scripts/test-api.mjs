#!/usr/bin/env node
/**
 * The layer a container cannot check: PostgREST, as the browser sees it.
 *
 *   node scripts/test-api.mjs
 *
 * Everything in test-schema.mjs runs as the database owner with `set local
 * role`, which proves the grants are right but says nothing about whether the
 * functions are actually *reachable* over HTTP with the anon key in the
 * bundle. Those are different questions and only one of them can be answered
 * from a container.
 *
 * The specific thing this catches: PostgREST resolves a function by ARGUMENT
 * NAME, so a signature is part of the contract with every deployed bundle —
 * including one sitting in somebody's cache from last week. Renaming a
 * parameter is a break that no SQL test can see, and it took restroom-map down
 * for about fifteen minutes.
 *
 * It has to write real rows — a report, a flag and a piece of feedback — because
 * reachability is the thing being tested and there is no dry-run RPC. So it
 * tags everything it writes and deletes it again at the end, over the database
 * connection rather than the anon key, which cannot delete anything. A test
 * that leaves three items in the moderation queue every run is a test somebody
 * stops running.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENV = join(ROOT, '.env')

if (existsSync(ENV)) {
  for (const line of readFileSync(ENV, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m && m[2].trim() && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  }
}

const URL_ = process.env.PUBLIC_SUPABASE_URL
const KEY = process.env.PUBLIC_SUPABASE_ANON_KEY
if (!URL_ || !KEY) {
  console.error('needs PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_ANON_KEY in .env')
  process.exit(1)
}

/*
 * Reads the body exactly once and hands back both forms.
 *
 * The obvious shape — `ok(res.ok, `got ${res.status}: ${await res.text()}`)` —
 * is a trap: a template literal evaluates its parts eagerly, so the body is
 * consumed even when the assertion passes, and the next `res.json()` throws
 * "Body has already been read". Reading up front costs nothing and removes
 * the whole class of mistake.
 */
async function rest(path, init = {}) {
  const res = await fetch(`${URL_}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* keep the text */ }
  return { ok: res.ok, status: res.status, text, json }
}

let passed = 0
let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ✔ ${name}`)
    passed++
  } catch (err) {
    console.log(`  ✖ ${name}\n      ${err.message}`)
    failed++
  }
}
const ok = (v, m) => { if (!v) throw new Error(m) }

console.log(`against ${URL_}\n`)

let anOrchard = null

await check('anon can read orchards over HTTP', async () => {
  const res = await rest('/orchards?select=id,slug,name,tags&limit=3')
  ok(res.ok, `got ${res.status}: ${res.text}`)
  ok(res.json.length === 3, `expected 3 rows, got ${res.json?.length}`)
  anOrchard = res.json[0]
})

await check('anon can read the variety calendar', async () => {
  const res = await rest('/varieties?select=slug,start_doy&limit=5')
  ok(res.ok, `got ${res.status}`)
  ok(res.json.length === 5, `expected 5, got ${res.json?.length}`)
})

await check('anon cannot read the report box', async () => {
  // flags and feedback have no SELECT grant at all, for any API role. The
  // refusal is `permission denied`, which is a stronger answer than a policy
  // returning zero rows — there is no policy to get wrong.
  for (const table of ['flags', 'feedback', 'reports']) {
    const res = await rest(`/${table}?select=id&limit=1`)
    ok(!res.ok, `${table} was readable — it must not be`)
    ok(res.status === 401 || res.status === 403 || res.status === 404,
      `${table} answered ${res.status}`)
  }
})

await check('anon cannot insert an orchard over HTTP', async () => {
  const res = await rest('/orchards', {
    method: 'POST',
    body: JSON.stringify({ slug: 'nope', name: 'Nope' }),
  })
  ok(!res.ok, 'the insert succeeded — every write must go through a function')
})

await check('submit_report is reachable by its argument names', async () => {
  // The signature is the contract. If a parameter is ever renamed, this is
  // where it shows up — as a 404 from PostgREST rather than a SQL error.
  const res = await rest('/rpc/submit_report', {
    method: 'POST',
    body: JSON.stringify({
      p_orchard_id: anOrchard.id,
      p_kind: 'open',
      p_anon_id: `api-check-${Date.now()}`,
      p_lat: null,
      p_lng: null,
    }),
  })
  ok(res.status !== 404, 'PostgREST could not resolve submit_report by argument name')
  ok(res.ok, `got ${res.status}: ${res.text}`)
  ok(res.json?.ok === true, `expected ok:true, got ${res.text}`)
})

await check('submit_report refuses a kind it does not know', async () => {
  const res = await rest('/rpc/submit_report', {
    method: 'POST',
    body: JSON.stringify({ p_orchard_id: anOrchard.id, p_kind: 'banana' }),
  })
  ok(!res.ok, 'an unknown kind was accepted')
})

await check('submit_flag and submit_feedback are reachable', async () => {
  for (const [fn, body] of [
    ['submit_flag', { p_target_type: 'orchard', p_target_id: anOrchard.id, p_message: 'api reachability check' }],
    ['submit_feedback', { p_kind: 'bug', p_message: 'api reachability check', p_build: 'test' }],
  ]) {
    const res = await rest(`/rpc/${fn}`, { method: 'POST', body: JSON.stringify(body) })
    ok(res.status !== 404, `PostgREST could not resolve ${fn}`)
    ok(res.ok, `${fn} got ${res.status}: ${res.text}`)
  }
})

await check('signing in is required to add an orchard', async () => {
  const res = await rest('/rpc/submit_orchard', {
    method: 'POST',
    body: JSON.stringify({ p_name: 'Anon Farm', p_lat: 41.9, p_lng: -75.9 }),
  })
  ok(!res.ok, 'an anonymous caller added an orchard')
})

await check('the rate limiter is not callable from a client', async () => {
  for (const fn of ['rl_salt', 'client_fingerprint', 'promote_observations']) {
    const res = await rest(`/rpc/${fn}`, { method: 'POST', body: '{}' })
    ok(!res.ok, `${fn} was callable with the anon key`)
  }
})

await check('Google is enabled as an auth provider', async () => {
  const res = await fetch(`${URL_}/auth/v1/settings`, { headers: { apikey: KEY } })
  ok(res.ok, `settings endpoint gave ${res.status}`)
  const body = await res.json()
  ok(body?.external?.google === true,
    'Google sign-in is off — turn it on under Authentication → Providers')
})

// --- put it back the way it was ---------------------------------------------

const TAG = 'api reachability check'
try {
  const pg = (await import('pg')).default
  const { dbConfig } = await import('@minormending/map-kit/node/connect')
  const db = new pg.Client(dbConfig({ root: ROOT, applicationName: 'orchard-map/test-api' }))
  await db.connect()
  const r = await db.query(`delete from reports where anon_id like 'api-check-%'`)
  const f = await db.query('delete from flags where message = $1', [TAG])
  const b = await db.query('delete from feedback where message = $1', [TAG])
  await db.end()
  console.log(`\ncleaned up ${r.rowCount} report, ${f.rowCount} flag, ${b.rowCount} feedback`)
} catch (err) {
  console.log(`\ncould not clean up (${err.message})`)
  console.log(`  run: node scripts/db.mjs query "delete from reports where anon_id like 'api-check-%'"`)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
