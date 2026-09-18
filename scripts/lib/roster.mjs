/**
 * The roster, as the database holds it — for importers that add to it.
 *
 * Both state importers used to read `src/data/orchards.json` to decide what we
 * already had, and `--apply` wrote new farms back into that same file. That
 * made sense when the JSON *was* the dataset. It stopped making sense when the
 * database arrived, and nobody noticed, because the importers kept working:
 * they only ever added Connecticut and Pennsylvania farms at a moment when the
 * file and the table happened to agree.
 *
 * They do not always agree. `export-data.mjs` rebuilds that file from
 * `where status = 'active'`, so a farm written to the file and not to the table
 * survives exactly until the next export and is then deleted, silently as far
 * as the farm is concerned. Three Connecticut farms were lost on 2026-09-18
 * and only found because an unrelated job tripped over the two-row difference.
 *
 * So the flow has one direction now: importers add to the table, the export
 * produces the file, the file is a build artifact nobody writes by hand.
 */
import pg from 'pg'
import { dbConfig } from '@minormending/map-kit/node/connect'

/**
 * Connect, do one thing, disconnect.
 *
 * Deliberately not a connection the caller holds. The first version handed one
 * back, and every importer opened it, then spent ten or twenty minutes
 * geocoding one listing a second before it wrote anything — and a pooled
 * connection sitting idle that long gets closed from the other end. The run
 * died on an ECONNRESET from a socket nobody was awaiting, after all the
 * network work was already done and thrown away.
 *
 * The slow part of an import is the directory and the geocoder. The database
 * is wanted twice, briefly, at either end of it.
 */
async function withClient(root, name, fn) {
  const client = new pg.Client(dbConfig({ root, applicationName: `orchard-map/${name}` }))
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/**
 * Every row we have, in the shape the matchers want.
 *
 * Deliberately NOT filtered to `status = 'active'`, which is the filter the
 * exported file carries. A hidden farm is still one we have — Annutto's Farm
 * Stand is hidden because somebody decided it should be — and an importer that
 * cannot see it would cheerfully add it back every week. Reading the file
 * instead of the table had exactly that blind spot.
 */
export async function loadRoster(root, name) {
  return withClient(root, name, async (client) => {
    const { rows } = await client.query(`
      select slug, name,
             st_y(geog::geometry) as lat,
             st_x(geog::geometry) as lng,
             import_source, import_id, status
        from orchards
    `)
    return rows.map((r) => ({ ...r, lat: Number(r.lat), lng: Number(r.lng) }))
  })
}

/**
 * Add farms, refusing to overwrite anything.
 *
 * `on conflict do nothing` rather than an upsert: this job's business is farms
 * we do not have. A row that already exists has since been enriched by the
 * reader with hours, prices and varieties nobody wants replaced by a roster
 * line, and the matchers upstream should have caught it long before here.
 * A conflict reaching this point is a bug worth reporting, so the count of
 * rows that did not insert is returned rather than swallowed.
 */
export async function addOrchards(root, name, rows) {
  if (rows.length === 0) return { inserted: [], skipped: [] }

  return withClient(root, name, async (client) => {
    const inserted = []
    await client.query('begin')
    try {
      for (const o of rows) {
        const { rows: out } = await client.query(
          `insert into orchards
             (slug, name, geog, address, town, state, zip, phone, website, tags,
              import_source, import_id, import_licence)
           values ($1, $2, st_point($3, $4)::geography, $5, $6, $7, $8, $9, $10,
                   $11::text[]::orchard_tag[], $12, $13, $14)
           on conflict (import_source, import_id) do nothing
           returning slug`,
          [
            o.slug, o.name, o.lng, o.lat, o.address, o.town, o.state, o.zip,
            o.phone, o.website, o.tags ?? [],
            o.import_source, o.import_id, o.import_licence,
          ],
        )
        if (out.length > 0) inserted.push(out[0].slug)
      }
      await client.query('commit')
    } catch (err) {
      await client.query('rollback')
      throw err
    }

    const got = new Set(inserted)
    return { inserted, skipped: rows.filter((o) => !got.has(o.slug)).map((o) => o.slug) }
  })
}

/**
 * A slug nothing else is using.
 *
 * Slugs are the page URLs, so a collision would put two farms on one address.
 * The suffix is the state, which is the thing that actually differs when two
 * farms of the same name in the same-named town turn up from two directories.
 */
export function freeSlug(base, taken, suffix) {
  if (!taken.has(base)) return base
  let slug = `${base}-${suffix}`
  let n = 2
  while (taken.has(slug)) slug = `${base}-${suffix}-${n++}`
  return slug
}
