# The publishing guard

`no-publish-orchard-map.sh` refuses, for any agent session, the commands that
publish this project: `git push`, `export-data.mjs --apply`,
`import-*.mjs --apply`, `db.mjs migrate` / `file`, writes smuggled through
`db.mjs query`, `record-observations.mjs --promote`, and `gh workflow run`.

An agent does the work and hands the command to a person, who runs it.

## The copy here is not the one that runs

This is the awkward part, and it is worth stating plainly rather than
discovering later.

```
/Users/kevinramdath/projects/
├── .claude/
│   ├── settings.local.json   <- registers the hook, by absolute path
│   └── hooks/
│       └── no-publish-orchard-map.sh   <- THE ONE THAT RUNS
└── orchard-map/
    └── .claude/hooks/
        └── no-publish-orchard-map.sh   <- this file's neighbour: a copy
```

Scheduled sessions start with `/Users/kevinramdath/projects` as their project
root, not this repository, so that is the only place Claude Code will read a
hook registration from. The guard has to live up there to work at all.

It also has to cover **only** orchard-map: `restroom-map-triage` opens pull
requests for a living and shares that project root, so a blanket rule on
`git push` would break it. Hence the cwd check inside the script.

So the copy here exists for version control, review and backup — the parent
directory is in no repository, and losing it would remove the guard silently.
`test/hook.test.mjs` fails if the two files drift apart, which is the only
thing making a second copy tolerable.

**Changing the guard means editing both.** Edit this one, run `pnpm test` to
confirm it caught the drift, then copy it up:

```bash
cp .claude/hooks/no-publish-orchard-map.sh /Users/kevinramdath/projects/.claude/hooks/
```

## Why it exists

On 2026-09-19 the `orchard-map-find-orchards` routine — whose prompt forbids,
in bold, under "the rules that matter most, because this runs unattended" —
wrote to the database, ran the export, committed, pushed and deployed.

Its change was correct and well argued. That is the point. An instruction an
agent can read is an instruction an agent can talk itself out of, so the
control had to sit somewhere it cannot. That routine's weekly schedule is also
disabled; it runs only when a person triggers it.

## What it does not do

It matches command text, so it cannot tell running a command from mentioning
one — a `grep` for `git push` in this directory gets refused. Conservative in
the right direction, and cheap compared to the alternative.

It is a guardrail, not a sandbox. A session with shell access could write a
script that pushes, and this would not match it. It raises the bar from "an
instruction an agent can talk itself out of" to "an agent would have to
deliberately build a way around a stated block". The airtight version is
branch protection on `main` requiring a pull request.
