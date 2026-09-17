-- Varieties are many per orchard. Promotion was treating them as one.
--
-- `promote_observations` picks the newest observation per (orchard, field) so
-- that an older crawl never overwrites a newer one. That is right for
-- `upick_open` and `hours`, which have a single value each — and wrong for
-- `variety`, where every observation shares the field name and only the value
-- differs. `distinct on (orchard_id, field)` therefore kept exactly ONE apple
-- per farm and silently discarded the rest.
--
-- Found by running it: the first real batch recorded 68 variety observations
-- and promoted 6. Nothing failed, nothing was logged, and the counts only
-- looked wrong next to each other.
--
-- The fix is to include the value in the dedupe key for varieties only, so
-- each apple is deduped against itself rather than against its neighbours.

set search_path = public, extensions;

create or replace function promote_observations(p_min_confidence numeric default 0.55)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_promoted int := 0;
  v_skipped  int := 0;
  r          record;
begin
  for r in
    /*
     * Newest observation per (orchard, field) — and per VALUE too when the
     * field is `variety`, because a farm grows many apples and each is its own
     * claim. Confidence is the tie-break: `created_at` defaults to now(),
     * which is transaction start time, so everything from one batch shares a
     * timestamp and `distinct on` would otherwise keep whichever it liked.
     */
    select distinct on (o.orchard_id, o.field, case when o.field = 'variety' then o.value else '' end)
           o.orchard_id, o.field, o.value, o.confidence, o.source_url, o.created_at
      from scrape_observations o
     where o.created_at > now() - interval '7 days'
     order by o.orchard_id, o.field,
              case when o.field = 'variety' then o.value else '' end,
              o.created_at desc, o.confidence desc
  loop
    if r.confidence < p_min_confidence then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    begin
      if r.field = 'upick_open' then
        update orchards
           set upick_open = (r.value::boolean),
               operator_checked_at = r.created_at,
               operator_source_url = r.source_url
         where id = r.orchard_id;
      elsif r.field in ('hours', 'admission') then
        execute format(
          'update orchards set %I = $1, operator_checked_at = $2, operator_source_url = $3 where id = $4',
          r.field)
          using left(r.value, 500), r.created_at, r.source_url, r.orchard_id;
      elsif r.field = 'reservations_required' then
        update orchards
           set reservations_required = (r.value::boolean),
               operator_checked_at = r.created_at,
               operator_source_url = r.source_url
         where id = r.orchard_id;
      elsif r.field = 'variety' then
        insert into orchard_varieties (orchard_id, variety, source, source_url)
        values (r.orchard_id, r.value, 'scrape', r.source_url)
        on conflict (orchard_id, variety) do update
          set source_url = excluded.source_url, noted_at = now();
      else
        v_skipped := v_skipped + 1;
        continue;
      end if;
      v_promoted := v_promoted + 1;
    exception when others then
      -- A bad cast is one field of one farm, not a failed run.
      v_skipped := v_skipped + 1;
    end;
  end loop;

  return jsonb_build_object('promoted', v_promoted, 'skipped', v_skipped);
end $$;

revoke all on function promote_observations(numeric) from public, anon, authenticated;
