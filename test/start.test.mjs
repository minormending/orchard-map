/**
 * The starting point kept in the browser.
 *
 * Everything here is about reading back something that may not be ours. The
 * key is a string in somebody's localStorage: an older version of this app
 * could have written it, an extension could have touched it, and a hand-edited
 * value is one devtools tab away. A bad coordinate that survives reading is a
 * drive time computed from the middle of the sea.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/*
 * A localStorage that behaves like the real one, including throwing the way a
 * private window does. Node has no DOM, and the alternative — a test that only
 * runs in a browser — would mean these rules are never checked at all.
 */
class Storage {
  constructor({ throws = false } = {}) {
    this.map = new Map()
    this.throws = throws
  }
  getItem(k) { if (this.throws) throw new Error('blocked'); return this.map.get(k) ?? null }
  setItem(k, v) { if (this.throws) throw new Error('blocked'); this.map.set(k, String(v)) }
  removeItem(k) { if (this.throws) throw new Error('blocked'); this.map.delete(k) }
}

const withStorage = async (storage, fn) => {
  globalThis.localStorage = storage
  try {
    // Imported inside, so the module sees the storage this test installed.
    const start = await import('../src/lib/start.ts')
    return await fn(start)
  } finally {
    delete globalThis.localStorage
  }
}

const KEY = 'orchard-map.start'
const WARWICK = { lat: 41.2565, lng: -74.3599, label: 'Warwick, NY' }

test('a saved start comes back as it went in', async () => {
  const store = new Storage()
  await withStorage(store, ({ saveStart, readStart }) => {
    saveStart(WARWICK)
    assert.deepEqual(readStart(), WARWICK)
  })
})

test('nothing saved is null, not a guess', async () => {
  await withStorage(new Storage(), ({ readStart }) => {
    assert.equal(readStart(), null)
  })
})

test('forgetting it forgets it', async () => {
  const store = new Storage()
  await withStorage(store, ({ saveStart, clearStart, readStart }) => {
    saveStart(WARWICK)
    clearStart()
    assert.equal(readStart(), null)
  })
})

test('only the three fields are stored, whatever else is passed', async () => {
  const store = new Storage()
  await withStorage(store, ({ saveStart }) => {
    saveStart({ ...WARWICK, secret: 'do not keep this', accuracy: 12 })
    const kept = JSON.parse(store.map.get(KEY))
    assert.deepEqual(Object.keys(kept).sort(), ['label', 'lat', 'lng'])
  })
})

test('a position that is not one is refused rather than trusted', async () => {
  for (const bad of [
    '{"lat":"41.2","lng":-74.3}',           // strings from a hand edit
    '{"lat":null,"lng":null}',
    '{"lng":-74.3}',                         // half a coordinate
    '{"lat":91,"lng":-74.3}',                // off the planet
    '{"lat":41.2,"lng":181}',
    '{"lat":null,"lng":null,"label":"home"}',
    'null',
    '[]',
    'not json at all',
  ]) {
    const store = new Storage()
    store.map.set(KEY, bad)
    await withStorage(store, ({ readStart }) => {
      assert.equal(readStart(), null, `accepted ${bad}`)
    })
  }
})

test('a missing label is filled in, because only the position matters', async () => {
  const store = new Storage()
  store.map.set(KEY, '{"lat":41.2565,"lng":-74.3599}')
  await withStorage(store, ({ readStart }) => {
    const back = readStart()
    assert.equal(back.lat, 41.2565)
    assert.ok(back.label, 'something to print next to the dot')
  })
})

test('a private window is a map that works, not a map that throws', async () => {
  // Safari private browsing and blocked site data both throw on every access.
  await withStorage(new Storage({ throws: true }), ({ readStart, saveStart, clearStart }) => {
    assert.equal(readStart(), null)
    assert.doesNotThrow(() => saveStart(WARWICK))
    assert.doesNotThrow(() => clearStart())
  })
})

/*
 * The status wording is a decision, not a label, so it is pinned here.
 *
 * `hidden` is both "waiting for a person" and "a person decided against it",
 * and the client cannot tell which apart — `flags` is revoked from clients
 * outright, deliberately. Anything that reads like a promise about the outcome
 * would be wrong for half the rows it describes, and a hopeful status on a
 * farm that was quietly declined is the same species of lie as a stale
 * "picking is open".
 *
 * Read as text rather than imported: `src/lib/submissions.ts` pulls in the
 * Supabase client through `./db`, which reads `import.meta.env` and cannot be
 * evaluated in plain node. Same reason `states.ts` is read this way in
 * data.test.mjs.
 */
test('a submission is never told it is still being reviewed', () => {
  const source = readFileSync(new URL('../src/lib/submissions.ts', import.meta.url), 'utf8')
  const fn = source.slice(source.indexOf('export function submissionState'))
  assert.ok(fn.length > 0, 'submissionState has moved — this test has gone stale')

  const said = [...fn.matchAll(/return '([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(said, ['On the map', 'Taken off the map', 'Not on the map'])

  for (const phrase of said) {
    assert.doesNotMatch(phrase, /review|pending|soon|waiting|shortly/i,
      `"${phrase}" promises an outcome the client cannot know`)
  }
})
