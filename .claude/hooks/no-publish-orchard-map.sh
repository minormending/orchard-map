#!/usr/bin/env bash
#
# Publishing orchard-map is a person's decision, not an agent's.
#
# On 2026-09-19 the find-orchards routine — whose prompt forbids, in bold,
# "no database writes, no build, no deploy, no push" — wrote to the orchards
# table, ran the export, committed, pushed and deployed. The change it made was
# correct and well argued. That is not the point: an instruction an agent can
# read is an instruction an agent can talk itself out of, so the control has to
# sit somewhere it cannot.
#
# Scope is orchard-map ONLY. restroom-map's triage routine opens pull requests
# for a living and must keep pushing branches; it shares this project root, so
# a blanket rule on `git push` would have broken it.
#
# This blocks EVERY agent session, including interactive ones, because nothing
# distinguishes a scheduled run from a person's session at this layer. That is
# the trade that was chosen deliberately: an agent proposes the command, a
# person runs it.
#
# Reads the PreToolUse payload on stdin. Exit 2 blocks the call and returns
# stderr to the model; exit 0 allows it.
set -uo pipefail

payload=$(cat)

field() {
  printf '%s' "$payload" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
cur = d
for k in '$1'.split('.'):
    cur = cur.get(k) if isinstance(cur, dict) else None
    if cur is None:
        sys.exit(0)
print(cur)
"
}

command=$(field tool_input.command)
cwd=$(field cwd)

# Nothing to inspect — do not block what we cannot read.
[ -z "$command" ] && exit 0

# Only orchard-map. A command that cd's there counts even when cwd does not.
case "$cwd$command" in
  *orchard-map*) ;;
  *) exit 0 ;;
esac

deny() {
  echo "BLOCKED by .claude/hooks/no-publish-orchard-map.sh: $1" >&2
  echo >&2
  echo "Publishing orchard-map is a person's decision. Hand the exact command" >&2
  echo "to the user and let them run it, or ask them to lift this hook." >&2
  exit 2
}

# Strip quotes so `git push "origin" main` reads the same as the bare form.
flat=$(printf '%s' "$command" | tr -d '"'"'"'\\')

case "$flat" in
  # Branches are fine; main is not.
  #
  # This refused every push when it was written, because main was the only
  # thing to push to and nothing else stood in front of it. main is now
  # branch-protected on GitHub with enforcement on admins, so a direct push to
  # it fails server-side whatever this file says — while refusing feature
  # branches only stopped an agent preparing the pull request it is meant to
  # prepare, and turned every change into four handoffs.
  #
  # Named here anyway rather than leaning on the server alone: the two controls
  # fail in different ways, and a local refusal with a readable reason beats a
  # remote rejection buried in git's output.
  #
  # A bare `git push` while sitting on main is allowed through to GitHub, which
  # rejects it. This cannot see the current branch, and guessing would be worse
  # than letting the authoritative check answer.
  *"git push"*main*)                 deny "pushing to main — open a pull request" ;;
esac

# A write buried in db.mjs query, which is otherwise a read tool.
case "$flat" in
  *db.mjs*query*)
    lowered=$(printf '%s' "$flat" | tr 'A-Z' 'a-z')
    case "$lowered" in
      *insert\ into*|*update\ *set*|*delete\ from*|*"drop "*|*"alter "*|*promote_observations*)
        deny "writing to the database through db.mjs query" ;;
    esac
    ;;
esac

exit 0
