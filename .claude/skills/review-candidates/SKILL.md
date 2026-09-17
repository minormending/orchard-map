---
name: review-candidates
description: Review orchards a state directory importer could not place confidently — duplicates, failed geocodes, ambiguous listings — and decide which belong on the map. Never publishes; leaves a report.
---

# Reviewing new orchards

A state directory importer has run and written `scripts/.candidates/<source>.json`.
It contains two lists:

- `clean` — parsed, geocoded, and not matching anything we already have. These
  are already merged. You do not need to look at them.
- `unclear` — the importer stopped rather than guess. These are yours.

Each unclear entry has a `reason`, and the reason tells you what kind of
judgment is wanted.

## The kinds of doubt

**`same name as one we have`** — the importer found an existing orchard whose
name looks like this one's. Sometimes that is right and the listing is a
duplicate; often it is two different farms sharing a family name, which is
extremely common in this business. *Rose Orchards* in North Branford and *Rose
Hill Farm* in Red Hook are ninety miles apart and unrelated. Check the town and
the address before calling it a duplicate.

**`within 600m of …`** — two pins landed on top of each other. Usually one of
two things: genuinely the same farm listed twice under slightly different
names, or a geocoder that gave up on both addresses and returned the town
centre for each. The second is much more common and is not a duplicate at all —
the fix there is a better address, not a deletion.

**`could not be geocoded`** — the address defeated the geocoder, usually a
rural route or a PO box. These are often the best-known orchards in the state,
so do not discard them. If you can tell from the listing where the farm is, say
so in your report; a person can add a coordinate.

## What you may do

**Nothing that publishes.** You do not merge, you do not write to
`src/data/orchards.json`, you do not touch the database, you do not build or
deploy. This job ends in a report that a person acts on.

You may read anything in the repo. You may **not** fetch anything: if a
listing's own website would settle it, that is a job for the crawler, which
does it under robots.txt and a crawl delay. Note it in the report instead.

## The report

For each unclear entry, one line: the name, the town, your call, and why.

Group them:

- **Add** — a real farm we do not have. Give the town and, if you can work it
  out from the listing, roughly where it is.
- **Duplicate of `<slug>`** — the same business we already list. Say which
  record looks better.
- **Cannot tell** — and what would settle it.

Then stop. Do not act on your own conclusions.
