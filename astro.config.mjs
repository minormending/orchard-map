import { execSync } from 'node:child_process'
import { defineConfig } from 'astro/config'
import react from '@astrojs/react'
import sitemap from '@astrojs/sitemap'

/**
 * Which build this is, as a number a person can read out.
 *
 * Commits, counted. Monotonic, needs no bumping, and maps back to exactly one
 * commit — v43 is the 43rd, findable with:
 *
 *   git rev-list --reverse HEAD | sed -n '43p'
 *
 * This needs full history. actions/checkout clones shallow unless told
 * otherwise, which would pin every deployed build at 1 — worse than no version
 * at all, because it looks like one and never changes. deploy.yml sets
 * fetch-depth: 0 for exactly this reason.
 */
function buildId() {
  if (process.env.BUILD_ID) return process.env.BUILD_ID
  try {
    return execSync('git rev-list --count HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() || 'dev'
  } catch {
    return 'dev'
  }
}

// GitHub Pages serves project sites from /<repo>/. Derived in CI from the repo
// name so a fork or a rename cannot silently ship the wrong asset paths.
const base = process.env.BASE_PATH ?? '/orchard-map/'

export default defineConfig({
  site: 'https://minormending.github.io',
  base,
  output: 'static',
  trailingSlash: 'ignore',
  integrations: [react(), sitemap()],
  build: { inlineStylesheets: 'auto' },
  vite: {
    define: { __BUILD_ID__: JSON.stringify(buildId()) },
  },
})
