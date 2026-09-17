#!/usr/bin/env node
/**
 * Materialise one of map-kit's SQL templates into a migration here.
 *
 *   node scripts/gen-migration.mjs rate_limit 20260917000001_kit_rate_limit
 *
 * The output is committed as plain SQL and never regenerated. Substituting at
 * apply time would make a migration's checksum depend on the environment, and
 * the runner refuses a migration whose file changed after it was applied —
 * correctly, because that is how a database and its history drift apart.
 */
import { writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readKitSql } from '@minormending/map-kit/node/sql'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const [template, name] = process.argv.slice(2)

if (!template || !name) {
  console.error('usage: gen-migration.mjs <template> <migration-name>')
  process.exit(1)
}

const VARS = {
  APP: 'orchard-map',
  // A flag is about an orchard or about a note somebody left on one.
  TARGET_TYPES: "'orchard','comment'",
}

const out = join(ROOT, 'supabase', 'migrations', `${name}.sql`)
if (existsSync(out)) {
  console.error(`${name}.sql already exists — migrations are written once`)
  process.exit(1)
}

writeFileSync(out, readKitSql(template, VARS))
console.log(`wrote supabase/migrations/${name}.sql`)
