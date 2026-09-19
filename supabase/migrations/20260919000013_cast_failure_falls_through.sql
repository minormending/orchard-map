-- A value that will not cast blocked every other reading of that field.
--
-- Promotion picked ONE winner per (orchard, field) with `distinct on` and then
-- tried to apply it. If that value would not cast — `not-a-boolean` in
-- upick_open, a number where a boolean belongs — the exception handler counted
-- it as skipped and moved on to the next FIELD. The farm kept nothing, and a
-- perfectly good observation of the same field, one row down the ordering, was
-- never looked at. One malformed reading could hold a field hostage for the
-- whole seven-day window.
--
-- Nothing has hit this yet: the only observations currently below the line are
-- below the confidence threshold rather than malformed. It is a trap set for
-- whenever the reader starts emitting messier values, which is a thing model
-- output does.
--
-- So the candidates for a field are now walked in order and the first one that
-- actually applies wins. A cast failure is still counted, still leaves no
-- promoted_at, and now falls through to the next-best reading instead of
-- ending the field.
--
-- Two things deliberately still stop a field dead, because they are not
-- failures of the value:
--
--   Below the confidence threshold. The newest reading of the site says
--   something we do not trust, and reaching past it to promote an older one
--   would be publishing stale information because the fresh information was
--   poor. The field keeps whatever it already had, which is the right answer.
--
--   A field name nothing knows how to write. No observation of that field can
--   ever apply, so trying the rest is pointless work and a pointlessly
--   inflated count.
--
-- `distinct on` is therefore gone, replaced by walking the full ordered set and
-- tracking which (orchard, field, and value-for-varieties) key has been
-- settled. The ordering is unchanged, so which observation is tried FIRST is
-- exactly what it was.

set search_path = public, extensions;

create or replace function promote_observations(p_min_confidence numeric default 0.55)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_promoted  int := 0;
  v_skipped   int := 0;
  v_unchanged int := 0;
  v_prev_key  text := null;
  v_settled   boolean := false;
  r           record;
begin
  for r in
    /*
     * Every candidate, best first, grouped by the thing it is a claim about.
     *
     * The key is (orchard, field) — plus the value for `variety`, because a
     * farm grows many apples and each is its own claim rather than a competing
     * answer to one question.
     *
     * Ordered by recency, then confidence. `created_at` defaults to now(),
     * which is transaction start time, so everything from one batch shares a
     * timestamp and confidence is what separates them; across batches, the
     * newer reading of a farm's website wins, which is the point.
     *
     * Every observation is here, including ones already promoted. Restrict
     * this to unpromoted rows and the row below each promoted winner becomes
     * the winner, so farms drift backwards into stale values one run at a
     * time. `promoted_at` decides whether to write the winner; it does not get
     * to decide what the winner is.
     */
    select o.id, o.orchard_id, o.field, o.value, o.confidence, o.source_url,
           o.created_at, o.promoted_at,
           o.orchard_id::text || '|' || o.field || '|' ||
             case when o.field = 'variety' then o.value else '' end as key
      from scrape_observations o
     where o.created_at > now() - interval '7 days'
     order by o.orchard_id, o.field,
              case when o.field = 'variety' then o.value else '' end,
              o.created_at desc, o.confidence desc
  loop
    if r.key is distinct from v_prev_key then
      v_prev_key := r.key;
      v_settled := false;
    end if;

    -- Something better already answered this field on this run.
    continue when v_settled;

    if r.confidence < p_min_confidence then
      v_skipped := v_skipped + 1;
      v_settled := true;
      continue;
    end if;

    -- Still the best answer for this field, and already the one on the farm.
    if r.promoted_at is not null then
      v_unchanged := v_unchanged + 1;
      v_settled := true;
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
        -- No observation of this field can ever apply. Settle it.
        v_skipped := v_skipped + 1;
        v_settled := true;
        continue;
      end if;

      /*
       * Stamped inside the same block as the write, after it. A value that
       * would not cast raises before reaching here, so a failed promotion
       * leaves no mark and is reported again next run.
       */
      update scrape_observations set promoted_at = now() where id = r.id;
      v_promoted := v_promoted + 1;
      v_settled := true;
    exception when others then
      /*
       * Counted, unstamped, and NOT settled — the next-best reading of this
       * same field gets its turn on this run rather than waiting for the bad
       * one to age out of the seven-day window.
       */
      v_skipped := v_skipped + 1;
    end;
  end loop;

  return jsonb_build_object(
    'promoted', v_promoted, 'skipped', v_skipped, 'unchanged', v_unchanged);
end $$;

comment on function promote_observations(numeric) is
  'Writes the best recent observation per (orchard, field) onto the farm, '
  'falling through to the next-best when a value will not cast. "promoted" '
  'counts what changed, "unchanged" what was already applied, "skipped" what '
  'was below the threshold or would not cast. The winner is chosen across all '
  'observations; promoted_at only decides whether to write.';

revoke all on function promote_observations(numeric) from public, anon, authenticated;
