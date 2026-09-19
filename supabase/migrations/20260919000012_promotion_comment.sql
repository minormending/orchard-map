-- Correcting an explanation, not a behaviour. Nothing here changes what
-- promotion does; the function is recreated only so its body stops carrying a
-- wrong reason for why it is written that way.
--
-- 20260919000011 said that selecting only unpromoted observations "would mean
-- a fresh 0.7 observation overwriting a promoted 0.9 one". That is not what
-- would happen, and it misdescribes the rule it was defending. The winner is
-- ordered `created_at desc, confidence desc` — RECENCY first, with confidence
-- only breaking ties inside a batch, where every row shares a transaction
-- timestamp. A fresh 0.7 beats an older 0.9 already, marker or no marker.
-- Verified rather than reasoned: an 0.9 observation two days old and an 0.6
-- one hour old, promoted together, leave the farm saying the 0.6.
--
-- The real hazard is worse than the one I wrote down. Filter to unpromoted
-- rows and `distinct on` does not pick nothing when the winner is excluded —
-- it picks the next one down. So the run after a field is promoted would hand
-- that field to the newest observation that had ALREADY LOST, and the farm
-- would drift backwards into stale values a day at a time, quietly, while the
-- counts looked healthy.
--
-- Hence: the winner is chosen across all observations, and `promoted_at` only
-- decides whether to write it.

set search_path = public, extensions;

create or replace function promote_observations(p_min_confidence numeric default 0.55)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_promoted  int := 0;
  v_skipped   int := 0;
  v_unchanged int := 0;
  r           record;
begin
  for r in
    /*
     * The winner per (orchard, field) — and per VALUE too when the field is
     * `variety`, because a farm grows many apples and each is its own claim.
     *
     * Ordered by recency, then confidence. `created_at` defaults to now(),
     * which is transaction start time, so everything from one batch shares a
     * timestamp and confidence is what separates them; across batches, the
     * newer reading of a farm's website wins, which is the point.
     *
     * Chosen across ALL observations, including ones already promoted. That
     * is deliberate and it is the part worth not breaking: restrict this to
     * unpromoted rows and `distinct on` hands each promoted field to the
     * newest observation that has already lost, so farms drift backwards into
     * stale values one run at a time. `promoted_at` decides whether to write
     * the winner. It does not get to decide what the winner is.
     */
    select distinct on (o.orchard_id, o.field, case when o.field = 'variety' then o.value else '' end)
           o.id, o.orchard_id, o.field, o.value, o.confidence, o.source_url,
           o.created_at, o.promoted_at
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

    -- Still the best answer for this field, and already the one on the farm.
    if r.promoted_at is not null then
      v_unchanged := v_unchanged + 1;
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

      /*
       * Stamped inside the same block as the write, after it. A value that
       * would not cast raises before reaching here, so a failed promotion
       * leaves no mark and is reported again next run.
       */
      update scrape_observations set promoted_at = now() where id = r.id;
      v_promoted := v_promoted + 1;
    exception when others then
      -- A bad cast is one field of one farm, not a failed run.
      v_skipped := v_skipped + 1;
    end;
  end loop;

  return jsonb_build_object(
    'promoted', v_promoted, 'skipped', v_skipped, 'unchanged', v_unchanged);
end $$;

comment on function promote_observations(numeric) is
  'Writes the best recent observation per (orchard, field) onto the farm. '
  '"promoted" counts what changed, "unchanged" what was already applied, and '
  '"skipped" what was below the threshold or would not cast. The winner is '
  'chosen across all observations; promoted_at only decides whether to write.';

revoke all on function promote_observations(numeric) from public, anon, authenticated;
