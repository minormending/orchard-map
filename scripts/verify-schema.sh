#!/usr/bin/env bash
# Apply every migration to a throwaway Postgres and run the behaviour tests.
#
#   pnpm db:verify
#
# This exists because the alternative is finding out on a real project. It
# already caught four things: a partial unique index that made the seed's
# upsert unreachable, an auto-hide counter that contradicted its own comment,
# a promotion step that picked arbitrarily between same-second observations,
# and a container that died because the shim raced the image's own init.
set -euo pipefail

DOCKER=${DOCKER:-docker}
command -v "$DOCKER" >/dev/null 2>&1 || DOCKER=/Applications/Docker.app/Contents/Resources/bin/docker
NAME=orchard-pg
PORT=${PORT:-55432}
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$DOCKER" rm -f "$NAME" >/dev/null 2>&1 || true
# arm64-native. The official postgis/postgis image is amd64-only and its
# emulated build crashes partway through init on Apple silicon.
"$DOCKER" run -d --name "$NAME" -e POSTGRES_PASSWORD=verify -p "$PORT":5432 \
  imresamu/postgis:15-3.4 >/dev/null

# The image creates PostGIS itself on a socket-only server first, and accepts
# queries the whole time it is doing so. "init process complete" is the only
# marker that means it has actually finished; polling with a query instead
# races its CREATE EXTENSION and kills the container.
for _ in $(seq 1 90); do
  "$DOCKER" logs "$NAME" 2>&1 | grep -q "init process complete" && break
  sleep 2
done
for _ in $(seq 1 30); do
  "$DOCKER" exec "$NAME" psql -U postgres -tc "select 1" >/dev/null 2>&1 && break
  sleep 2
done

cat > /tmp/orchard-shim.sql <<'SQL'
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists auth;
-- No default on id, matching a real Supabase project: GoTrue generates it in
-- the application layer. Defaulting it here let the harness get away with
-- omitting it, and that passed locally and failed on the first real project.
create table if not exists auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
grant usage on schema public, extensions to anon, authenticated;
SQL

"$DOCKER" cp /tmp/orchard-shim.sql "$NAME":/tmp/shim.sql
"$DOCKER" exec "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q -f /tmp/shim.sql >/dev/null

"$DOCKER" cp "$ROOT/supabase/migrations" "$NAME":/tmp/mig
echo "migrations:"
for f in "$ROOT"/supabase/migrations/*.sql; do
  b=$(basename "$f")
  printf "  %-42s " "$b"
  if "$DOCKER" exec "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q --single-transaction \
       -f "/tmp/mig/$b" >/tmp/orchard-mig.log 2>&1; then echo ok
  else echo FAILED; grep -E "ERROR|DETAIL" /tmp/orchard-mig.log | head -4; exit 1; fi
done

node "$ROOT/scripts/seed-to-sql.mjs" > /tmp/orchard-seed.sql 2>/dev/null
"$DOCKER" cp /tmp/orchard-seed.sql "$NAME":/tmp/seed.sql
printf "seed:%40s" ""
"$DOCKER" exec "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q -f /tmp/seed.sql >/dev/null && echo "ok"

echo
ORCHARD_TEST_DB="postgres://postgres:verify@localhost:$PORT/postgres" node "$ROOT/scripts/test-schema.mjs"
