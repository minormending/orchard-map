#!/usr/bin/env node
/**
 * Create the Supabase project this app needs, and write its keys into .env.
 *
 *   node scripts/provision-supabase.mjs            say what it would do
 *   node scripts/provision-supabase.mjs --apply    actually create it
 *
 * Dry run by default, like every other importer here, because this one
 * provisions infrastructure on somebody's account rather than writing a file.
 *
 * Needs SUPABASE_ACCESS_TOKEN in .env — a personal access token from
 * supabase.com/dashboard/account/tokens. That token can create and delete
 * projects across the whole account, which makes it a bigger secret than the
 * database password: delete it from .env once the project exists. Nothing in
 * the app or the deploy ever reads it.
 *
 * WHY A SEPARATE PROJECT, and not restroom-map's: that database already has
 * profiles, flags, feedback, rate_limit and reports. These migrations collide
 * with all five, and two statements in the grants migration — `revoke all on
 * profiles` and `alter default privileges ... revoke` — would reach straight
 * into a live application. It would also fail partway through, on `create type
 * feedback_kind`, leaving that database holding half an orchard schema.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENV = join(ROOT, '.env')
const API = 'https://api.supabase.com/v1'
const APPLY = process.argv.includes('--apply')

const NAME = process.env.ORCHARD_PROJECT_NAME ?? 'orchard-map'
// The audience is a two-hour drive from New York City.
const REGION = process.env.ORCHARD_PROJECT_REGION ?? 'us-east-1'

function loadEnv() {
  if (!existsSync(ENV)) return
  for (const line of readFileSync(ENV, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const value = m[2].trim().replace(/^["']|["']$/g, '')
    if (value && !(m[1] in process.env)) process.env[m[1]] = value
  }
}
loadEnv()

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN
if (!TOKEN) {
  console.error(`No SUPABASE_ACCESS_TOKEN.

Create one at https://supabase.com/dashboard/account/tokens and put it in
.env (which is gitignored):

  SUPABASE_ACCESS_TOKEN=sbp_...

Delete the line once the project exists — nothing else here needs it.`)
  process.exit(1)
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* keep the text */ }
  if (!res.ok) {
    // The API's own message is far more useful than anything invented here,
    // especially for quota and plan refusals.
    throw new Error(`${method} ${path} → ${res.status}: ${parsed?.message ?? text}`)
  }
  return parsed
}

// --- look before leaping -----------------------------------------------------

const orgs = await api('/organizations')
if (!orgs?.length) {
  console.error('That token can see no organizations.')
  process.exit(1)
}

const projects = await api('/projects')

process.stderr.write(`organizations:\n`)
for (const o of orgs) process.stderr.write(`  ${o.id}  ${o.name}\n`)

process.stderr.write(`\nprojects already on this account:\n`)
for (const p of projects) {
  process.stderr.write(`  ${p.name.padEnd(24)} ${p.region.padEnd(14)} ${p.status}\n`)
}

const existing = projects.find((p) => p.name === NAME)
if (existing) {
  process.stderr.write(`\n"${NAME}" already exists (${existing.id}, ${existing.status}).\n`)
  if (!APPLY) process.exit(0)
}

const org = orgs.find((o) => o.id === process.env.ORCHARD_ORG_ID) ?? orgs[0]

if (!existing) {
  process.stderr.write(`
would create:
  name:     ${NAME}
  org:      ${org.name} (${org.id})
  region:   ${REGION}
  password: generated here, 32 chars, written to .env
`)
  // The free plan allows two active projects per organization. restroom-map is
  // probably one of them, so say so plainly rather than letting the API's
  // refusal be the first anybody hears of it.
  const active = projects.filter((p) => p.status === 'ACTIVE_HEALTHY').length
  process.stderr.write(`\n  (${active} active project${active === 1 ? '' : 's'} on this account already)\n`)
}

if (!APPLY) {
  process.stderr.write('\ndry run — pass --apply to create it\n')
  process.exit(0)
}

// --- create ------------------------------------------------------------------

let project = existing
if (!project) {
  // Generated here rather than asked for, so it is never typed, never reused
  // from somewhere else, and long enough not to matter.
  const dbPass = randomBytes(24).toString('base64url')

  process.stderr.write('\ncreating the project (this takes a couple of minutes)\n')
  project = await api('/projects', {
    method: 'POST',
    body: {
      name: NAME,
      organization_id: org.id,
      region: REGION,
      db_pass: dbPass,
      plan: 'free',
    },
  })
  upsertEnv('SUPABASE_DB_PASSWORD', dbPass)
  process.stderr.write(`  ref: ${project.id}\n`)
}

// Wait for it to come up. A fresh project answers requests long before its
// database accepts connections.
let status = project.status
for (let i = 0; i < 60 && status !== 'ACTIVE_HEALTHY'; i++) {
  await new Promise((r) => setTimeout(r, 10_000))
  const now = await api(`/projects/${project.id}`)
  if (now.status !== status) process.stderr.write(`  ${now.status}\n`)
  status = now.status
}
if (status !== 'ACTIVE_HEALTHY') {
  console.error(`project is ${status} after ten minutes — check the dashboard`)
  process.exit(1)
}

// The anon key is meant to be public: it identifies the project and authorises
// nothing. Every restriction is a grant or an RLS policy.
const keys = await api(`/projects/${project.id}/api-keys?reveal=true`)
const anon = keys.find((k) => k.name === 'anon' || k.type === 'anon')
if (!anon?.api_key) {
  console.error('could not read the anon key — check the token has secrets:read')
  process.exit(1)
}

upsertEnv('PUBLIC_SUPABASE_URL', `https://${project.id}.supabase.co`)
upsertEnv('PUBLIC_SUPABASE_ANON_KEY', anon.api_key)

process.stderr.write(`
ready.

  url:  https://${project.id}.supabase.co
  keys: written to .env

next:
  pnpm db:migrate
  node scripts/seed-to-sql.mjs > supabase/seed.sql
  node scripts/db.mjs file supabase/seed.sql
`)

/** Set a key in .env, replacing any existing line for it. */
function upsertEnv(key, value) {
  const current = existsSync(ENV) ? readFileSync(ENV, 'utf8') : ''
  const line = `${key}=${value}`
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm')
  const next = re.test(current)
    ? current.replace(re, line)
    : current.replace(/\n*$/, '\n') + line + '\n'
  writeFileSync(ENV, next)
  process.stderr.write(`  .env: ${key} set\n`)
}
