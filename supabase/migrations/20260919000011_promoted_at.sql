-- Promotion did not remember what it had already promoted.
--
-- It selects the best observation per (orchard, field) from the last seven
-- days and writes it to the farm. Every night, for the same seven days, it
-- selected the same winners and wrote the same values again — so its returned
-- count was "everything currently promotable", never "what changed". Yesterday
-- it answered 100 twice in a row, minutes apart, with nothing new recorded in
-- between. A number that cannot go down is not a number anybody reads.
--
-- Worse than the noise: re-applying is not free. Between two runs a moderator
-- can correct an hours string the farm's own site got wrong, and the next
-- promotion silently put the scraped value back. Nobody had hit that yet
-- because moderation is not open, but the shape of it was there.
--
-- `promoted_at` is stamped on the observation when it is applied, and an
-- observation that is still the winner and already carries one is left alone.
--
-- The winner is still chosen across ALL observations, not only unstamped ones,
-- and that ordering matters. Picking the best of the *unpromoted* rows would
-- mean a fresh 0.7 observation overwriting a promoted 0.9 one, which is a
-- downgrade dressed as an update. The marker decides whether to write; it does
-- not decide what is best.
--
-- What does NOT get stamped:
--
--   Observations below the threshold. They have not been promoted, and if the
--   threshold is ever lowered they should get their chance.
--
--   Observations whose value will not cast. Those are counted as skipped every
--   run, deliberately: a `not-a-boolean` sitting in upick_open is a standing
--   complaint about the reader, and hiding it after one report would make it
--   somebody's problem in six months instead of today.
--
-- There is no backfill. Everything already recorded has been promoted, but
-- stamping it here would be asserting a time nobody knows, and inventing
-- timestamps to make a first run look tidy is the wrong trade. So the first
-- run after this migration reports a large `promoted` count once, because it
-- is marking what it applies, and every run after that reports what changed.

set search_path = public, extensions;

alter table scrape_observations
  add column promoted_at timestamptz;

comment on column scrape_observations.promoted_at is
  'When this observation was written onto the orchard. NULL means it never was '
  '- either it is not the best one for its field, it is below the confidence '
  'threshold, or its value would not cast.';

-- Only the unpromoted winners are interesting to promotion, and it looks them
-- up by orchard and field.
create index scrape_observations_unpromoted
  on scrape_observations (orchard_id, field)
  where promoted_at is null;

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
     * Newest observation per (orchard, field) — and per VALUE too when the
     * field is `variety`, because a farm grows many apples and each is its own
     * claim. Confidence is the tie-break: `created_at` defaults to now(),
     * which is transaction start time, so everything from one batch shares a
     * timestamp and `distinct on` would otherwise keep whichever it liked.
     *
     * `o.id` is selected because the winner now has to be stamped, and
     * `o.promoted_at` because whether it already carries one is the question
     * this function newly asks.
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

revoke all on function promote_observations(numeric) from public, anon, authenticated;
