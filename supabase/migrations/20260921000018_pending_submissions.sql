-- One definition of "awaiting review", because three things now need it.
--
-- A submitted orchard lands `hidden` with an open `submission` flag, and until
-- somebody looks at it the map cannot say anything about it. That was fine
-- while the row was inert. It is not fine now that the crawler is allowed to
-- read a submitted farm's website *before* the decision rather than after,
-- which is the point: what the farm's own site says is most of what settles
-- whether the pin belongs on the map at all.
--
-- Three callers ask the same question and must not answer it differently:
--
--   export-data.mjs --pending      which rows to hand the crawler
--   record-observations.mjs        whose observations it will accept
--   a person, reading the queue
--
-- `status = 'hidden'` alone is the wrong predicate for any of them. Hidden is
-- also where a moderator puts a farm that has closed down or turned out to be
-- a duplicate — Annutto's Farm Stand is sitting there now — and re-crawling
-- those every night, or accepting fresh observations about them, is precisely
-- what hiding them was meant to stop. The open flag is the difference between
-- "nobody has looked yet" and "somebody looked and said no".
--
-- ---------------------------------------------------------------------------
-- Not readable by anyone the site can reach
-- ---------------------------------------------------------------------------
--
-- These are unreviewed rows typed by strangers. A view over `orchards` runs
-- with its owner's privileges unless it says otherwise, so granting select to
-- `anon` here would hand the public exactly the rows `hidden` exists to
-- withhold — including any a moderator hid on purpose, had the predicate been
-- looser. Nothing outside the scripts needs it, so nothing outside the scripts
-- gets it.

set search_path = public, extensions;

create or replace view pending_submissions as
select o.*
from orchards o
where o.status = 'hidden'
  and exists (
    select 1 from flags f
    where f.target_type = 'orchard'
      and f.target_id = o.id
      and f.kind = 'submission'
      and f.resolved_at is null);

revoke all on pending_submissions from public, anon, authenticated;
