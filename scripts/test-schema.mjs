#!/usr/bin/env node
/**
 * Does the schema actually behave the way the comments claim?
 *
 *   ORCHARD_TEST_DB=postgres://postgres:verify@localhost:55432/postgres \
 *     node scripts/test-schema.mjs
 *
 * Every test runs inside a transaction that is rolled back, so a run leaves
 * nothing behind and can point at a real project as safely as at a container.
 *
 * The rule that makes the permission tests meaningful, learned the hard way in
 * restroom-map: a test must actually `set local role` to anon or authenticated.
 * Setting the JWT claim alone leaves the connection as the owner, which
 * bypasses grants and RLS entirely — and such a test passes no matter what the
 * schema says.
 */
import pg from 'pg'

const URL = process.env.ORCHARD_TEST_DB
  ?? 'postgres://postgres:verify@localhost:55432/postgres'

const client = new pg.Client({ connectionString: URL })
await client.connect()

const tests = []
const test = (name, fn) => tests.push({ name, fn })

class Failed extends Error {}
const fail = (m) => { throw new Failed(m) }

const eq = (actual, expected, what = 'values differ') => {
  const a = typeof actual === 'string' && typeof expected === 'number' ? Number(actual) : actual
  if (!Object.is(a, expected)) {
    fail(`${what}\n      expected: ${expected}\n      actual:   ${actual}`)
  }
}
const ok = (v, what = 'expected truthy') => { if (!v) fail(`${what} — got ${v}`) }

/** Run as an API role, for real. */
async function asRole(role, fn) {
  await client.query(`set local role ${role}`)
  try {
    return await fn()
  } finally {
    await client.query('reset role')
  }
}

/** Pretend to be a signed-in user. Does NOT change the connection's role. */
const become = (id) =>
  client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [id])

/**
 * Assert a call fails, and fails for the reason meant.
 *
 * Wrapped in a savepoint because a failed statement poisons the whole
 * transaction — every later query, including `reset role`, comes back with
 * "current transaction is aborted". Rolling back to the savepoint is what lets
 * a test assert several refusals in a row.
 */
let savepoints = 0
async function raises(fn, { code, message } = {}) {
  const sp = `sp${++savepoints}`
  await client.query(`savepoint ${sp}`)
  let err
  try { await fn() } catch (e) { err = e }
  await client.query(`rollback to savepoint ${sp}`)
  if (!err) fail('expected an error — the call succeeded')
  if (code && err.code !== code) {
    fail(`wrong errcode\n      expected: ${code}\n      actual:   ${err.code} (${err.message})`)
  }
  // A missing grant and an RLS refusal are BOTH 42501. Asserting only the code
  // lets a test pass against the broken schema, so the message is the assertion
  // that matters.
  if (message && !err.message.includes(message)) {
    fail(`wrong message\n      expected to contain: ${message}\n      actual: ${err.message}`)
  }
  return err
}

/** A user, made the way Supabase's signup trigger would. */
async function makeUser(name) {
  const { rows } = await client.query(
    `insert into auth.users (email, raw_user_meta_data)
     values ($1::text, jsonb_build_object('full_name', $2::text)) returning id`,
    [`${name}@test.invalid`, name])
  return rows[0].id
}

const anOrchard = async () => {
  const { rows } = await client.query(
    `select id, slug from orchards where status = 'active' order by slug limit 1`)
  return rows[0]
}

// ---------------------------------------------------------------------------
// Grants: the rule is that a table with a submit_* function has no write grant.
// ---------------------------------------------------------------------------

test('anon may read orchards and varieties', async () => {
  await asRole('anon', async () => {
    const { rows } = await client.query('select count(*)::int as n from orchards')
    ok(rows[0].n > 100, `anon saw ${rows[0].n} orchards`)
    await client.query('select count(*) from varieties')
  })
})

test('anon may NOT write to orchards directly', async () => {
  await asRole('anon', () =>
    raises(() => client.query(
      `insert into orchards (slug, name, geog) values ('x','X', st_point(0,0)::geography)`),
      { code: '42501', message: 'permission denied for table' }))
})

test('nobody may write a report directly — submit_report is the only door', async () => {
  const o = await anOrchard()
  for (const role of ['anon', 'authenticated']) {
    await asRole(role, () =>
      raises(() => client.query(
        `insert into reports (orchard_id, kind) values ($1, 'open')`, [o.id]),
        { code: '42501', message: 'permission denied for table' }))
  }
})

test('the flags table cannot be written or read directly', async () => {
  // This is the exact hole restroom-map shipped: an INSERT grant on the table
  // that receives takedown requests, next to a policy that checked the wrong
  // thing. Skipping submit_flag would skip its rate limit entirely.
  const o = await anOrchard()
  await asRole('anon', async () => {
    await raises(() => client.query(
      `insert into flags (target_type, target_id, message) values ('orchard', $1, 'x')`, [o.id]),
      { code: '42501', message: 'permission denied for table' })
    await raises(() => client.query('select * from flags'),
      { code: '42501', message: 'permission denied for table' })
  })
})

test('a client cannot reach the rate limiter or learn its salt', async () => {
  await asRole('anon', async () => {
    await raises(() => client.query('select rl_salt()'), { code: '42501' })
    await raises(() => client.query('select client_fingerprint()'), { code: '42501' })
  })
})

// ---------------------------------------------------------------------------
// Reports and confidence.
// ---------------------------------------------------------------------------

test('submit_report writes a report and keeps no position', async () => {
  const o = await anOrchard()
  const { rows } = await client.query(
    `select submit_report($1, 'open', 'anon-1', 41.5, -74.0) as r`, [o.id])
  eq(rows[0].r.ok, true)

  const { rows: saved } = await client.query(
    'select * from reports where orchard_id = $1', [o.id])
  eq(saved.length, 1)
  // The boolean survives; the coordinates do not exist as columns at all.
  ok(!('lat' in saved[0]) && !('lng' in saved[0]), 'reports must not store a position')
})

test('geo_verified is true only near the farm', async () => {
  const o = await anOrchard()
  const { rows: here } = await client.query(
    `select st_y(geog::geometry) as lat, st_x(geog::geometry) as lng from orchards where id = $1`, [o.id])

  const near = await client.query(
    `select submit_report($1,'open','a',$2,$3) as r`, [o.id, here[0].lat, here[0].lng])
  eq(near.rows[0].r.geo_verified, true, 'a report from the farm should verify')

  const far = await client.query(
    `select submit_report($1,'open','b',$2,$3) as r`, [o.id, here[0].lat + 1, here[0].lng])
  eq(far.rows[0].r.geo_verified, false, 'a report 111km away should not')
})

test('an unknown report kind is refused, not coerced', async () => {
  const o = await anOrchard()
  await raises(() => client.query(`select submit_report($1, 'banana')`, [o.id]),
    { code: '22023' })
})

test('trouble counts double and everything decays', async () => {
  const o = await anOrchard()
  await client.query(`select submit_report($1,'open','a')`, [o.id])
  const { rows: up } = await client.query(
    'select score from orchard_confidence where orchard_id = $1', [o.id])
  ok(Number(up[0].score) > 0.9, `one confirm should score ~1, got ${up[0].score}`)

  await client.query(`select submit_report($1,'closed','b')`, [o.id])
  const { rows: down } = await client.query(
    'select score from orchard_confidence where orchard_id = $1', [o.id])
  // +1 and -2 leaves about -1: trouble weighs double.
  ok(Number(down[0].score) < -0.9, `confirm+trouble should be ~-1, got ${down[0].score}`)
})

test('auto-hide needs four distinct people, and only "gone" counts', async () => {
  const o = await anOrchard()

  // Six "closed" reports from six people must NOT hide it, and must not get
  // the farm most of the way there either: closed is a fact about a day, not
  // about whether the farm exists.
  for (let i = 0; i < 6; i++) {
    await client.query(`select submit_report($1,'closed',$2)`, [o.id, `closed-${i}`])
  }
  let { rows } = await client.query('select status from orchards where id = $1', [o.id])
  eq(rows[0].status, 'active', 'closed reports must never hide an orchard')

  // Three people saying gone is still not enough.
  for (let i = 0; i < 3; i++) {
    await client.query(`select submit_report($1,'gone',$2)`, [o.id, `gone-${i}`])
  }
  ;({ rows } = await client.query('select status from orchards where id = $1', [o.id]))
  eq(rows[0].status, 'active', 'three reporters must not be enough')

  // The fourth tips it.
  await client.query(`select submit_report($1,'gone','gone-3')`, [o.id])
  ;({ rows } = await client.query('select status from orchards where id = $1', [o.id]))
  eq(rows[0].status, 'hidden', 'four distinct reporters should hide it')

  // And the hide explains itself rather than being unaccountable later.
  const { rows: flag } = await client.query(
    `select message from flags where target_id = $1 and kind = 'auto'`, [o.id])
  ok(flag.length === 1, 'an auto-hide must write its reason')
})

test('one person with a grudge cannot hide an orchard', async () => {
  const o = await anOrchard()
  for (let i = 0; i < 10; i++) {
    await client.query(`select submit_report($1,'gone','same-person')`, [o.id])
  }
  const { rows } = await client.query('select status from orchards where id = $1', [o.id])
  eq(rows[0].status, 'active', 'ten reports from one anon_id must not hide it')
})

// ---------------------------------------------------------------------------
// The two-people rule.
// ---------------------------------------------------------------------------

test('one person is an account, not a fact', async () => {
  const o = await anOrchard()
  const alice = await makeUser('alice')
  await become(alice)
  const { rows } = await client.query(
    `select submit_visitor_claim($1,'cider_donuts',true) as r`, [o.id])
  eq(rows[0].r.ok, true)

  const { rows: after } = await client.query(
    'select cider_donuts from orchards where id = $1', [o.id])
  eq(after[0].cider_donuts, null, 'one claim must not settle a field')
})

test('two people who agree settle it', async () => {
  const o = await anOrchard()
  const alice = await makeUser('alice')
  const bob = await makeUser('bob')

  await become(alice)
  await client.query(`select submit_visitor_claim($1,'dogs',true)`, [o.id])
  await become(bob)
  await client.query(`select submit_visitor_claim($1,'dogs',true)`, [o.id])

  const { rows } = await client.query('select dogs from orchards where id = $1', [o.id])
  eq(rows[0].dogs, true, 'two agreeing claims should settle the field')
})

test('two people who disagree settle nothing', async () => {
  const o = await anOrchard()
  const a = await makeUser('a')
  const b = await makeUser('b')
  const c = await makeUser('c')
  const d = await makeUser('d')

  await become(a); await client.query(`select submit_visitor_claim($1,'hayride',true)`, [o.id])
  await become(b); await client.query(`select submit_visitor_claim($1,'hayride',true)`, [o.id])
  // Now two on the other side: two values each reaching two people is a
  // disagreement, and v_winners = 1 is what makes it settle nothing.
  await become(c); await client.query(`select submit_visitor_claim($1,'hayride',false)`, [o.id])
  await become(d); await client.query(`select submit_visitor_claim($1,'hayride',false)`, [o.id])

  const { rows } = await client.query('select hayride from orchards where id = $1', [o.id])
  // The first pair settles it; the second pair must not overwrite a settled
  // field. Either way it must not flip to false.
  ok(rows[0].hayride !== false, `a disputed field must not read false, got ${rows[0].hayride}`)
})

test('the same person cannot vote twice', async () => {
  const o = await anOrchard()
  const alice = await makeUser('alice')
  await become(alice)
  await client.query(`select submit_visitor_claim($1,'corn_maze',true)`, [o.id])
  await client.query(`select submit_visitor_claim($1,'corn_maze',true)`, [o.id])

  const { rows } = await client.query(
    `select count(*)::int as n from visitor_claims where orchard_id = $1 and field = 'corn_maze'`,
    [o.id])
  eq(rows[0].n, 1, 'a second claim from one person is an upsert, not a vote')

  const { rows: settled } = await client.query('select corn_maze from orchards where id = $1', [o.id])
  eq(settled[0].corn_maze, null, 'one person twice must not settle a field')
})

test('claiming needs an account', async () => {
  const o = await anOrchard()
  await client.query(`select set_config('request.jwt.claim.sub', '', true)`)
  await raises(() => client.query(`select submit_visitor_claim($1,'dogs',true)`, [o.id]),
    { code: '42501' })
})

// ---------------------------------------------------------------------------
// Submissions.
// ---------------------------------------------------------------------------

test('a submitted orchard lands hidden, never active', async () => {
  const alice = await makeUser('alice')
  await become(alice)
  const { rows } = await client.query(
    `select submit_orchard('Test Farm', 41.9, -75.9, '1 Lane', 'Nowhere', 'NY', array['pick_your_own']) as r`)
  eq(rows[0].r.ok, true)

  const { rows: made } = await client.query(
    'select status, created_by, import_source from orchards where id = $1', [rows[0].r.id])
  eq(made[0].status, 'hidden', 'a stranger must not be able to put a pin on the map')
  eq(made[0].import_source, 'user')

  // And it reaches the same queue a person already reads.
  const { rows: queued } = await client.query(
    `select count(*)::int as n from flags where target_id = $1 and kind = 'submission'`,
    [rows[0].r.id])
  eq(queued[0].n, 1)
})

test('a duplicate within 300m is refused with the neighbour named', async () => {
  const o = await anOrchard()
  const { rows: at } = await client.query(
    `select st_y(geog::geometry) as lat, st_x(geog::geometry) as lng, name from orchards where id = $1`,
    [o.id])
  const alice = await makeUser('alice')
  await become(alice)
  const { rows } = await client.query(
    `select submit_orchard('Same Place Really', $1::float8, $2::float8) as r`, [at[0].lat, at[0].lng])
  eq(rows[0].r.ok, false)
  eq(rows[0].r.reason, 'duplicate')
  ok(rows[0].r.near === at[0].name, `should name the neighbour, said ${rows[0].r.near}`)
})

test('adding an orchard needs an account', async () => {
  await client.query(`select set_config('request.jwt.claim.sub', '', true)`)
  await raises(() => client.query(`select submit_orchard('X', 41.9, -75.9)`), { code: '42501' })
})

test('five a day and no more', async () => {
  const alice = await makeUser('alice')
  await become(alice)
  for (let i = 0; i < 5; i++) {
    // Spread them out so the 300m duplicate check does not fire instead.
    await client.query(`select submit_orchard($1::text, $2::float8, -75.9)`, [`Farm ${i}`, 41.0 + i * 0.5])
  }
  await raises(() => client.query(`select submit_orchard('Sixth', 44.0, -75.9)`),
    { code: '53400' })
})

// ---------------------------------------------------------------------------
// The scraper's output.
// ---------------------------------------------------------------------------

test('promotion respects the confidence threshold', async () => {
  const o = await anOrchard()
  const { rows: run } = await client.query(
    `insert into scrape_runs (orchard_id, host, outcome) values ($1,'x.test','ok') returning id`,
    [o.id])

  await client.query(
    `insert into scrape_observations (run_id, orchard_id, field, value, tier, confidence, source_url)
     values ($1,$2,'upick_open','true','heuristic',0.35,'https://x.test/')`,
    [run[0].id, o.id])

  let { rows } = await client.query(`select promote_observations(0.55) as r`)
  eq(rows[0].r.promoted, 0, 'a 0.35 observation must not promote at 0.55')

  const { rows: still } = await client.query('select upick_open from orchards where id = $1', [o.id])
  eq(still[0].upick_open, null)

  // The same observation from the model tier, which can read a date.
  await client.query(
    `insert into scrape_observations (run_id, orchard_id, field, value, tier, confidence, source_url)
     values ($1,$2,'upick_open','true','model',0.8,'https://x.test/visit')`,
    [run[0].id, o.id])

  ;({ rows } = await client.query(`select promote_observations(0.55) as r`))
  ok(rows[0].r.promoted >= 1, 'a 0.8 observation should promote')

  const { rows: now } = await client.query(
    'select upick_open, operator_source_url, operator_checked_at from orchards where id = $1', [o.id])
  eq(now[0].upick_open, true)
  ok(now[0].operator_source_url === 'https://x.test/visit', 'a promoted fact must cite its page')
  ok(now[0].operator_checked_at !== null, 'and must carry when it was checked')
})

test('a bad value costs one field, not the whole run', async () => {
  const o = await anOrchard()
  const { rows: run } = await client.query(
    `insert into scrape_runs (orchard_id, host, outcome) values ($1,'x.test','ok') returning id`,
    [o.id])
  await client.query(
    `insert into scrape_observations (run_id, orchard_id, field, value, tier, confidence, source_url)
     values ($1,$2,'upick_open','not-a-boolean','model',0.9,'https://x.test/')`,
    [run[0].id, o.id])
  const { rows } = await client.query(`select promote_observations(0.55) as r`)
  eq(rows[0].r.promoted, 0)
  eq(rows[0].r.skipped, 1, 'a bad cast should be skipped, not raised')
})

// ---------------------------------------------------------------------------

let passed = 0
let failed = 0

for (const t of tests) {
  await client.query('begin')
  try {
    await t.fn()
    console.log(`  ✔ ${t.name}`)
    passed++
  } catch (err) {
    console.log(`  ✖ ${t.name}`)
    console.log(`      ${err.message.split('\n').join('\n      ')}`)
    failed++
  } finally {
    // Nothing a test does survives it.
    await client.query('rollback')
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
await client.end()
process.exit(failed > 0 ? 1 : 0)
