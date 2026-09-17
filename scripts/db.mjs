#!/usr/bin/env node
/**
 * Run SQL against the project database. Everything generic lives in map-kit;
 * this file is the part that is specific to orchards.
 *
 *   node scripts/db.mjs                 usage
 *   node scripts/db.mjs status          applied and pending migrations
 *   node scripts/db.mjs migrate         apply pending migrations
 *   node scripts/db.mjs queue           open flags and feedback
 *   node scripts/db.mjs hide <id> "why" take an orchard off the map
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '@minormending/map-kit/node/cli'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

await run({
  root: ROOT,
  app: 'orchard-map',
  schema: {
    queueView: 'moderation_queue',
    placeTable: 'orchards',
    placeLabel: 'name',
  },
})
