-- map-kit: flags, feedback, and one queue over both.
--
-- Generated from @minormending/map-kit. Substitutions: 'orchard','comment'.
--
-- Two tables that deliberately have no foreign key to what they describe:
--
--   flags     a complaint about a row. target_id is NOT a reference, so a flag
--             outlives the thing it was about. That is the audit trail —
--             deleting the evidence alongside the thing is how a deletion
--             becomes unexplainable six months later.
--   feedback  a complaint about the app. No target at all, which is why it is
--             not a flag.

set search_path = public, extensions;

create table if not exists flags (
  id            uuid primary key default gen_random_uuid(),
  target_type   text not null check (target_type in ('orchard','comment')),
  target_id     uuid not null,
  reporter_id   uuid references profiles(id),
  kind          text not null default 'user',
  message       text not null,
  contact_email text,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

create index if not exists flags_open on flags (created_at desc) where resolved_at is null;

create type feedback_kind as enum ('bug', 'idea', 'complaint');

create table if not exists feedback (
  id            uuid primary key default gen_random_uuid(),
  kind          feedback_kind not null,
  message       text not null,
  -- Optional, and the only reason to hold an address: so somebody can be told
  -- what happened. Not public, same as flags.contact_email.
  contact_email text,
  user_id       uuid references profiles(id),
  -- Which build they were looking at. The version indicator exists to be read
  -- out when something looks wrong; this saves them reading it.
  build         text,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

create index if not exists feedback_open on feedback (created_at desc) where resolved_at is null;

alter table flags    enable row level security;
alter table feedback enable row level security;

-- No grants at all, for any API role. A client cannot read these back and
-- cannot write to them directly — the refusal is `permission denied for table`
-- rather than an empty result, which is a stronger answer than a policy
-- returning zero rows, because there is no policy to get wrong.
--
-- The submit_* functions below are the only door.

create or replace function submit_flag(
  p_target_type   text,
  p_target_id     uuid,
  p_message       text,
  p_contact_email text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_fp text := client_fingerprint();
begin
  if p_target_type not in ('orchard','comment') then
    raise exception 'unknown target type: %', p_target_type using errcode = '22023';
  end if;
  if coalesce(length(trim(p_message)), 0) = 0 then
    raise exception 'a reason is required' using errcode = '22023';
  end if;

  if not rl_take('flag:' || v_fp, interval '1 day', 10) then
    raise exception 'too many reports, try later' using errcode = '53400';
  end if;

  insert into flags (target_type, target_id, reporter_id, message, contact_email)
  values (p_target_type, p_target_id, auth.uid(),
          left(trim(p_message), 2000), nullif(trim(p_contact_email), ''));

  return jsonb_build_object('ok', true);
end $$;

grant execute on function submit_flag(text, uuid, text, text) to anon, authenticated;

create or replace function submit_feedback(
  p_kind          text,
  p_message       text,
  p_contact_email text default null,
  p_build         text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_fp   text := client_fingerprint();
  v_kind feedback_kind;
begin
  begin
    v_kind := p_kind::feedback_kind;
  exception when invalid_text_representation then
    raise exception 'unknown feedback kind: %', p_kind using errcode = '22023';
  end;

  if coalesce(length(trim(p_message)), 0) = 0 then
    raise exception 'a message is required' using errcode = '22023';
  end if;

  if not rl_take('feedback:' || v_fp, interval '1 day', 5) then
    raise exception 'too many messages, try later' using errcode = '53400';
  end if;

  insert into feedback (kind, message, contact_email, user_id, build)
  values (v_kind, left(trim(p_message), 4000),
          nullif(trim(p_contact_email), ''), auth.uid(), left(p_build, 40));

  return jsonb_build_object('ok', true);
end $$;

grant execute on function submit_feedback(text, text, text, text) to anon, authenticated;

-- One queue over both, with matching column names and types so a reader needs
-- no edit when a new kind of complaint arrives. The null casts must match the
-- other branch exactly: `create or replace view` cannot change a column's
-- type, including its precision.
create or replace view moderation_queue as
  select id, 'flag'::text as source, kind, null::text as subject,
         message, contact_email, target_id, created_at, resolved_at
    from flags
  union all
  select id, 'feedback'::text as source, kind::text, null::text as subject,
         message, contact_email, null::uuid as target_id, created_at, resolved_at
    from feedback;

-- Reachable only as the owner, which is how scripts/db.mjs connects.
revoke all on moderation_queue from public, anon, authenticated;
