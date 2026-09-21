-- You may read the farm you proposed.
--
-- `orchards_read` is `using (status = 'active')`, which is right for everybody
-- else and leaves the one person with a stake in a hidden row unable to see
-- it. Somebody signs in, proposes a farm, is told "it goes to a person before
-- it appears on the map — usually within a day or two", and then has no way of
-- ever finding out what happened. Abma's Farm Market sat hidden for four hours
-- on 21 September and its submitter could not have told the difference between
-- that and being thrown away.
--
-- So: active, or yours. Narrow on purpose —
--
--   `created_by` is written by `submit_orchard` and by nothing else. Every
--   imported row has it null, and null is never equal to anything, so this
--   widens the policy for exactly the rows a person typed themselves.
--
--   `auth.uid()` is null for `anon`, and `created_by = null` is NULL rather
--   than true, so the anonymous read is unchanged. That is worth stating
--   rather than trusting: the same shape written as `created_by is not
--   distinct from auth.uid()` would hand every anonymous visitor every
--   imported row in the table.
--
-- It also means a submitter can see that their farm was hidden rather than
-- published. That is deliberate. The reason lives in `flags`, which has its
-- own policy and is not opened here — "this was not published" is theirs to
-- know, and a moderator's note about it is not.
--
-- Nothing else changes: the views that a client can reach either aggregate
-- (orchard_confidence, visitor_claim_state) or are revoked outright
-- (pending_submissions), and none of them is security_invoker, so this policy
-- is not a back door into any of them.

set search_path = public, extensions;

drop policy if exists orchards_read on orchards;

create policy orchards_read on orchards for select to anon, authenticated
  using (status = 'active' or created_by = auth.uid());
