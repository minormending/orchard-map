/**
 * The publishing guard, and the copy of it that actually runs.
 *
 * `.claude/hooks/no-publish-orchard-map.sh` is version-controlled here, but
 * the file Claude Code executes lives one directory up, outside any
 * repository, because that is the project root scheduled sessions start in.
 * Two copies of one file is the failure mode this codebase has spent a week
 * fixing — the exported JSON against the database, the seed against the
 * export — so the two are compared rather than trusted.
 *
 * The behaviour tests below run against the copy in the repo, which is the one
 * a reviewer reads. The drift test is what makes that meaningful.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HOOK = fileURLToPath(new URL('../.claude/hooks/no-publish-orchard-map.sh', import.meta.url))
const LIVE = '/Users/kevinramdath/projects/.claude/hooks/no-publish-orchard-map.sh'

const O = '/Users/kevinramdath/projects/orchard-map'
const R = '/Users/kevinramdath/projects/restroom-map'

/** Exit 2 is "blocked"; anything else is "allowed". */
function decide(command, cwd) {
  const payload = JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command } })
  try {
    execFileSync(HOOK, { input: payload, stdio: ['pipe', 'pipe', 'pipe'] })
    return 'ALLOW'
  } catch (err) {
    return err.status === 2 ? 'BLOCK' : `ERROR(${err.status})`
  }
}

/*
 * Assembled from fragments on purpose. The hook matches command text, and a
 * test file containing the literal patterns cannot be grepped, edited or
 * copied from a shell without the guard refusing the command — which happened
 * twice while writing it.
 */
const PROMOTE = '--' + 'promote'
const FN = 'promote_' + 'observations'
const PUSH = 'git ' + 'push'

test('the guard is executable', () => {
  assert.ok(existsSync(HOOK), 'the hook is missing from the repo')
  assert.ok(statSync(HOOK).mode & 0o111, 'the hook is not executable')
})

test('it refuses every way of publishing orchard-map', () => {
  for (const command of [
    `${PUSH} -q origin main`,
    PUSH,
    `cd ${O} && ${PUSH}`,
    'node scripts/export-data.mjs --apply',
    'node scripts/import-ctapples.mjs --apply',
    'node scripts/db.mjs migrate',
    'node scripts/db.mjs file supabase/seed.sql',
    `node scripts/db.mjs query "select ${FN}()"`,
    `node scripts/record-observations.mjs x.json ${PROMOTE}`,
    'gh workflow ' + 'run deploy.yml',
    // main is branch-protected, so a merge is the way onto it. Blocking the
    // push and not the merge would move the door rather than shut it.
    'gh pr ' + 'merge 12 --squash',
  ]) {
    assert.equal(decide(command, O), 'BLOCK', command)
  }
})

test('it leaves the daily reader alone', () => {
  // If this ever fails the read-farms routine stops working, which is a
  // quieter failure than a blocked push and a worse one: the map goes stale.
  for (const command of [
    'node scripts/scrape.mjs --limit 25 --queue',
    'node scripts/record-observations.mjs scripts/.queue/a.json',
    'ls scripts/.queue/',
    'rm scripts/.queue/a-upick-bowman.json',
  ]) {
    assert.equal(decide(command, O), 'ALLOW', command)
  }
})

test('it leaves ordinary work alone', () => {
  for (const command of [
    'pnpm test',
    'pnpm build',
    'git commit -m wip',
    'node scripts/export-data.mjs',
    'node scripts/db.mjs query "select count(*) from orchards"',
    // Proposing a change is the job. Landing it is not.
    'gh pr create --fill',
    'gh pr view 12',
    'gh pr checks 12',
  ]) {
    assert.equal(decide(command, O), 'ALLOW', command)
  }
})

test('it does not touch restroom-map, which pushes branches for a living', () => {
  /*
   * The sibling project's triage routine opens pull requests, and shares the
   * project root this hook is registered in. A blanket rule on pushing would
   * have broken it silently — it would simply have stopped filing PRs.
   */
  for (const command of [`${PUSH} -q origin fix/thing`, PUSH, 'gh pr create --fill']) {
    assert.equal(decide(command, R), 'ALLOW', command)
  }
})

test('the copy that actually runs has not drifted from this one', () => {
  /*
   * Skipped rather than failed when the live copy is absent: CI has no such
   * path, and a test that cannot pass on a fresh clone gets deleted rather
   * than fixed. On the machine that runs the guard, this is the assertion
   * that matters.
   */
  if (!existsSync(LIVE)) {
    console.log('    (no live hook on this machine — nothing to compare)')
    return
  }
  assert.equal(
    readFileSync(LIVE, 'utf8'),
    readFileSync(HOOK, 'utf8'),
    `the guard being enforced differs from the one in this repo.\n` +
    `      Reconcile them, then: cp ${HOOK} ${LIVE}`,
  )
})
