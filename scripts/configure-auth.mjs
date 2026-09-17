#!/usr/bin/env node
/**
 * Point Supabase Auth at this site, and switch Google on.
 *
 *   node scripts/configure-auth.mjs            show current vs intended
 *   node scripts/configure-auth.mjs --apply    write it
 *
 * Two halves, and only one of them can be automated.
 *
 * THE HALF THIS DOES: site_url and the redirect allow list, plus enabling the
 * Google provider once credentials exist. A fresh Supabase project ships with
 * `site_url` set to `http://localhost:3000`, which is wrong for every deployed
 * site and is the reason a correctly-configured Google login can still bounce
 * somebody to a dead address after they sign in. It is worth fixing whether or
 * not Google is ready.
 *
 * THE HALF THIS CANNOT: creating the OAuth client. That happens in Google
 * Cloud Console, against a Google account, behind an interactive login —
 * there is no API for the consent screen, and there should not be one for
 * handing out an account's OAuth credentials. See the instructions printed at
 * the bottom when the credentials are missing.
 *
 * Needs SUPABASE_ACCESS_TOKEN in .env. Once auth is configured you can delete
 * that line again; nothing in the app or the deploy reads it.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENV = join(ROOT, '.env')
const APPLY = process.argv.includes('--apply')

if (existsSync(ENV)) {
  for (const line of readFileSync(ENV, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m && m[2].trim() && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  }
}

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN
const PROJECT_URL = process.env.PUBLIC_SUPABASE_URL ?? ''
const REF = /https:\/\/([a-z0-9]+)\.supabase\.co/.exec(PROJECT_URL)?.[1]

if (!TOKEN || !REF) {
  console.error('needs SUPABASE_ACCESS_TOKEN and PUBLIC_SUPABASE_URL in .env')
  process.exit(1)
}

/** Where the deployed site lives, and where it lives in development. */
const SITE = process.env.ORCHARD_SITE_URL ?? 'https://minormending.github.io/orchard-map'
const DEV = 'http://localhost:4321'

/*
 * Sign-in returns to the page it started from — auth.ts uses
 * `window.location.origin + window.location.pathname` — and that can be any
 * of the 199 orchard pages, not just the map. So the allow list is a wildcard
 * over the whole site rather than a list of routes somebody has to remember
 * to extend.
 */
const ALLOW = [
  `${SITE}/**`,
  `${DEV}/**`,
].join(',')

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.supabase.com/v1${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...init.headers,
    },
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* keep text */ }
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${json?.message ?? text}`)
  return json
}

const current = await api(`/projects/${REF}/config/auth`)

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
const haveGoogle = Boolean(clientId && clientSecret)

const intended = {
  site_url: SITE,
  uri_allow_list: ALLOW,
  ...(haveGoogle
    ? {
        external_google_enabled: true,
        external_google_client_id: clientId,
        external_google_secret: clientSecret,
      }
    : {}),
}

const hide = (k, v) =>
  k === 'external_google_secret' && v ? `<${String(v).length} chars>` : JSON.stringify(v)

console.log(`project ${REF}\n`)
for (const [k, v] of Object.entries(intended)) {
  const now = current[k]
  const same = now === v
  console.log(`  ${same ? ' ' : '~'} ${k}`)
  if (!same) {
    console.log(`      from ${hide(k, now)}`)
    console.log(`      to   ${hide(k, v)}`)
  }
}

if (!haveGoogle) {
  console.log(`
  ! external_google_enabled stays ${current.external_google_enabled}

Google needs an OAuth client, and that part cannot be scripted — it is an
interactive login against your Google account. Once you have one, put it in
.env and run this again:

  GOOGLE_OAUTH_CLIENT_ID=....apps.googleusercontent.com
  GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-...

To create it, at https://console.cloud.google.com/apis/credentials :

  1. Pick or create a project.
  2. Configure the OAuth consent screen — External, and while it is in Testing
     only accounts you list can sign in. Publishing it is a separate step and
     needs no review for the basic email/profile scopes this uses.
  3. Create Credentials -> OAuth client ID -> Web application.
  4. Authorised JavaScript origins:
       ${SITE.replace(/\/[^/]*$/, '')}
       ${DEV}
  5. Authorised redirect URI — this one must be exact, and it is Supabase's
     address rather than the site's, because Google redirects to Supabase and
     Supabase then redirects back here:
       ${PROJECT_URL}/auth/v1/callback
`)
}

if (!APPLY) {
  console.log('\ndry run — pass --apply to write it')
  process.exit(0)
}

await api(`/projects/${REF}/config/auth`, {
  method: 'PATCH',
  body: JSON.stringify(intended),
})

const after = await api(`/projects/${REF}/config/auth`)
console.log('\nwritten:')
console.log(`  site_url                 ${after.site_url}`)
console.log(`  uri_allow_list           ${after.uri_allow_list}`)
console.log(`  external_google_enabled  ${after.external_google_enabled}`)
if (after.external_google_enabled) {
  console.log('\n  check it end to end with: node scripts/test-api.mjs')
}
