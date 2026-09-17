-- map-kit: rate limiting, keyed by a salted hash of the caller's address.
--
-- Generated from @minormending/map-kit. Substitutions: orchard-map.
-- Do not edit the copy in supabase/migrations once it has been applied — the
-- runner's hash check will refuse it, and it is right to. Add another.

set search_path = public, extensions;

create table if not exists rate_limit (
  key    text not null,
  bucket timestamptz not null,
  hits   int not null default 0,
  primary key (key, bucket)
);

alter table rate_limit enable row level security;
-- No policies and no grants, deliberately: only the functions below touch it.

-- A salt makes the stored digests useless on their own. IPv4 is a small enough
-- space that an unsalted hash is reversible by brute force.
create or replace function rl_salt()
returns text language sql immutable as $$ select 'orchard-map/v1'; $$;

create or replace function client_fingerprint()
returns text
language sql stable security definer set search_path = public, extensions as $$
  -- current_setting can come back as '' as well as NULL, and ''::json throws.
  with h as (
    select nullif(current_setting('request.headers', true), '')::json as j
  )
  select encode(digest(
    coalesce(
      nullif(h.j->>'cf-connecting-ip', ''),
      nullif(split_part(h.j->>'x-forwarded-for', ',', 1), ''),
      'unknown'
    ) || rl_salt(), 'sha256'), 'hex')
  from h;
$$;

-- Returns true when the call is within budget, and counts it.
create or replace function rl_take(p_key text, p_window interval, p_limit int)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_bucket timestamptz := to_timestamp(
    floor(extract(epoch from now()) / extract(epoch from p_window))
    * extract(epoch from p_window));
  v_hits int;
begin
  insert into rate_limit (key, bucket, hits) values (p_key, v_bucket, 1)
  on conflict (key, bucket) do update set hits = rate_limit.hits + 1
  returning hits into v_hits;

  -- Opportunistic pruning; cheap enough amortised across calls.
  if random() < 0.01 then
    delete from rate_limit where bucket < now() - interval '2 days';
  end if;

  return v_hits <= p_limit;
end $$;

-- A client must not be able to read or spend somebody else's bucket, and must
-- not be able to learn the salt.
revoke all on function rl_salt() from public, anon, authenticated;
revoke all on function client_fingerprint() from public, anon, authenticated;
revoke all on function rl_take(text, interval, int) from public, anon, authenticated;
