#!/usr/bin/env bash
# Runs the SQL of .github/scripts/pr-schema.sh against a real PostgreSQL 17
# (Aurora's engine version in infra/database.ts) in a throwaway local container.
# The aws CLI is the stub in tests/ci/lib/bin/aws, which pipes each Data API
# statement to psql as "master": a non-superuser with CREATEROLE and CREATEDB
# that owns database a2h, i.e. the Aurora master user without rds_superuser
# extras, so anything that passes here does not rely on superuser rights.
#
# Spec: preview-environments "Two PRs open" (isolation) and "PR closed" (drop).
# Needs Docker. Without it the test is skipped, unless PR_SCHEMA_PG_REQUIRED=1
# (set in CI), in which case it fails.
# Run: bash tests/ci/pr-schema.pg.test.sh
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# PR_SCHEMA_SCRIPT lets a mutated copy be run against these tests.
SCRIPT=${PR_SCHEMA_SCRIPT:-"$ROOT/.github/scripts/pr-schema.sh"}
STUB_BIN="$ROOT/tests/ci/lib/bin"
# Never fall through to a real aws CLI: the stub must be what PATH resolves.
if [ "$(PATH="$STUB_BIN:$PATH" command -v aws)" != "$STUB_BIN/aws" ]; then
  echo "FAIL - aws stub not found at $STUB_BIN/aws; refusing to run against a real aws CLI" >&2
  exit 1
fi
IMAGE=${PR_SCHEMA_PG_IMAGE:-postgres:17}

if ! docker info >/dev/null 2>&1; then
  if [ "${PR_SCHEMA_PG_REQUIRED:-}" = 1 ]; then echo "FAIL - docker is not available" >&2; exit 1; fi
  echo "skip - docker is not available; pr-schema SQL not run against Postgres"
  exit 0
fi

WORK=$(mktemp -d)
C="a2h-pr-schema-test-$$"
cleanup() { docker rm -f "$C" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

# Synthetic credentials for a container that lives for the duration of this test,
# built at runtime (tests/ci/lib/fixtures.sh).
# shellcheck source=tests/ci/lib/fixtures.sh
. "$ROOT/tests/ci/lib/fixtures.sh"
PG_SUPER=$(fixture_token super)
PG_MASTER=$(fixture_token master)
PG_OUTSIDER=$(fixture_token outsider)
PG_WRONG=$(fixture_token wrong)
# Password authentication over TCP (the image trusts 127.0.0.1 by default,
# which would let a wrong password through); the socket stays trusted for setup.
docker run -d --name "$C" -e POSTGRES_PASSWORD="$PG_SUPER" \
  -e POSTGRES_INITDB_ARGS="--auth-host=scram-sha-256 --auth-local=trust" "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  # The image restarts the server once after init; wait for the final one.
  if docker exec "$C" pg_isready -q -h 127.0.0.1 -U postgres 2>/dev/null \
    && docker exec -e PGPASSWORD="$PG_SUPER" "$C" psql -X -q -U postgres -h 127.0.0.1 -c 'select 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$C" psql -X -q -v ON_ERROR_STOP=1 -U postgres >/dev/null <<SQL
CREATE ROLE master LOGIN CREATEROLE CREATEDB PASSWORD '$PG_MASTER';
CREATE DATABASE a2h OWNER master;
-- As on Aurora/RDS, the master user (not a superuser) owns database postgres.
ALTER DATABASE postgres OWNER TO master;
CREATE ROLE outsider LOGIN PASSWORD '$PG_OUTSIDER';
SQL
echo "# postgres: $(docker exec "$C" psql -X -tA -U postgres -c 'show server_version')"

pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "ok   - $1"; }
nok() { fail=$((fail + 1)); echo "FAIL - $1"; if [ -n "${2:-}" ]; then printf '%s\n' "$2" | sed 's/^/       /'; fi; }

# pr_schema <n> <action> [random-password]: one stub state directory per PR, so
# each PR keeps its own secret across runs.
pr_schema() {
  local n=$1 action=$2 pw=${3:-unused}
  mkdir -p "$WORK/stub-$n"
  set +e
  OUT=$(env -u GITHUB_ACTIONS PATH="$STUB_BIN:$PATH" STUB_DIR="$WORK/stub-$n" STUB_PASSWORD="$pw" \
    STUB_PSQL="docker exec -i $C psql -X -q -v ON_ERROR_STOP=1 -U master -d a2h" \
    PR_SCHEMA_RETRY_SLEEP=0 bash "$SCRIPT" "$action" "$n" 2>&1)
  RC=$?
  set -e
}
secret_password() { jq -r .password "$WORK/stub-$1/secret"; }

# as <role> <password> <sql>: runs over TCP with password authentication, on a2h.
# as_db <database> <role> <password> <sql>: the same on another database.
as_db() {
  docker exec -e PGPASSWORD="$3" "$C" psql -X -tA -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$2" -d "$1" -c "$4" 2>&1
}
as() { as_db a2h "$@"; }
as_master() { as master "$PG_MASTER" "$1"; }
expect() { # expect <label> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else nok "$1" "expected: $2
actual:   $3"; fi
}
expect_denied() { # expect_denied <label> <actual output> <pattern>
  if grep -Eq "$3" <<<"$2"; then ok "$1"; else nok "$1" "expected /$3/, got: $2"; fi
}

echo "# before any create: database postgres is open to PUBLIC (the default)"
expect "outsider can connect to database postgres before pr-schema.sh runs" "1" \
  "$(as_db postgres outsider "$PG_OUTSIDER" 'select 1' || true)"

PW12=$(fixture_token twelve)
PW13=$(fixture_token thirteen)

echo "# create pr_12 and pr_13"
pr_schema 12 create "$PW12"; expect "create 12 exits 0" 0 "$RC"; [ "$RC" -eq 0 ] || echo "$OUT"
pr_schema 13 create "$PW13"; expect "create 13 exits 0" 0 "$RC"; [ "$RC" -eq 0 ] || echo "$OUT"
expect "secret a2h/pr-12/db holds the generated password" "$PW12" "$(secret_password 12)"
expect "schema pr_12 is owned by pr_12" "pr_12" "$(as_master "select nspowner::regrole from pg_namespace where nspname = 'pr_12'")"
expect "pr_12 is a plain login role" "t|f|f|f" \
  "$(as_master "select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname = 'pr_12'")"

echo "# Two PRs open: each login sees only its own schema"
expect "pr_12 logs in with the secret's password; search_path is pr_12" "pr_12" "$(as pr_12 "$PW12" 'show search_path')"
expect "pr_13 search_path is pr_13" "pr_13" "$(as pr_13 "$PW13" 'show search_path')"
as pr_12 "$PW12" 'create table items (id int); insert into items values (12)' >/dev/null
as pr_13 "$PW13" 'create table items (id int); insert into items values (13)' >/dev/null
expect "an unqualified table created by pr_12 lands in pr_12" "pr_12" \
  "$(as_master "select schemaname from pg_tables where tablename = 'items' and tableowner = 'pr_12'")"
expect "pr_12 reads its own row" "12" "$(as pr_12 "$PW12" 'select id from items')"
expect "pr_13 reads its own row, not pr_12's" "13" "$(as pr_13 "$PW13" 'select id from items')"
expect_denied "pr_13 cannot read pr_12.items" "$(as pr_13 "$PW13" 'select * from pr_12.items' || true)" 'permission denied for schema pr_12'
expect_denied "pr_13 cannot create in pr_12" "$(as pr_13 "$PW13" 'create table pr_12.x (id int)' || true)" 'permission denied for schema pr_12'
expect_denied "pr_13 cannot create in public" "$(as pr_13 "$PW13" 'create table public.x (id int)' || true)" 'permission denied for schema public'
expect "pr_13 cannot even resolve public objects (USAGE revoked)" "f" \
  "$(as pr_13 "$PW13" "select has_schema_privilege('public', 'USAGE')")"
expect_denied "a role without the grant cannot connect to a2h (CONNECT revoked from PUBLIC)" \
  "$(as outsider "$PG_OUTSIDER" 'select 1' || true)" 'permission denied for database "a2h"|User does not have CONNECT privilege'
expect_denied "pr_13 cannot connect to database postgres (CONNECT revoked from PUBLIC)" \
  "$(as_db postgres pr_13 "$PW13" 'select 1' || true)" 'permission denied for database "postgres"|User does not have CONNECT privilege'
expect_denied "a role without any grant cannot connect to database postgres either" \
  "$(as_db postgres outsider "$PG_OUTSIDER" 'select 1' || true)" 'permission denied for database "postgres"|User does not have CONNECT privilege'
expect "the master user still connects to database postgres (owner)" "1" "$(as_db postgres master "$PG_MASTER" 'select 1')"
expect_denied "a wrong password is refused" "$(as pr_12 "$PG_WRONG" 'select 1' || true)" 'password authentication failed'

echo "# create is idempotent and keeps the password"
pr_schema 12 create "$(fixture_token neverused)"
expect "second create 12 exits 0" 0 "$RC"; [ "$RC" -eq 0 ] || echo "$OUT"
expect "second create 12 reuses the secret" "$PW12" "$(secret_password 12)"
expect "pr_12 still logs in with the same password and keeps its data" "12" "$(as pr_12 "$PW12" 'select id from items')"

echo "# PR closed: drop with a session still open"
docker exec -e PGPASSWORD="$PW12" "$C" psql -X -tA -h 127.0.0.1 -U pr_12 -d a2h -c 'select pg_sleep(120)' >"$WORK/session.log" 2>&1 &
session=$!
for _ in $(seq 1 20); do
  [ "$(as_master "select count(*) from pg_stat_activity where usename = 'pr_12'")" -ge 1 ] && break
  sleep 0.5
done
expect "a pr_12 session is open before the drop" "1" "$(as_master "select count(*) from pg_stat_activity where usename = 'pr_12'")"
pr_schema 12 drop
expect "drop 12 exits 0" 0 "$RC"; [ "$RC" -eq 0 ] || echo "$OUT"
wait "$session" || true
expect_denied "the open pr_12 session was terminated" "$(cat "$WORK/session.log")" 'terminating connection|server closed the connection'
expect "schema pr_12 no longer exists" "0" "$(as_master "select count(*) from pg_namespace where nspname = 'pr_12'")"
expect "role pr_12 no longer exists" "0" "$(as_master "select count(*) from pg_roles where rolname = 'pr_12'")"
expect "secret a2h/pr-12/db deleted" "absent" "$([ -f "$WORK/stub-12/secret" ] && echo present || echo absent)"
pr_schema 12 drop
expect "drop 12 again (nothing left) exits 0" 0 "$RC"
expect "pr_13 is untouched by the drop of pr_12" "13" "$(as pr_13 "$PW13" 'select id from items')"

echo "# drop of a PR that never had a preview"
pr_schema 14 drop
expect "drop 14 (no role, schema or secret) exits 0" 0 "$RC"; [ "$RC" -eq 0 ] || echo "$OUT"

echo "# the postgres REVOKE is not silently a no-op"
# A non-owner's REVOKE only warns ("no privileges could be revoked"). If the
# master user does not own database postgres, create must fail, not succeed
# with database postgres still open to every login.
docker exec -i "$C" psql -X -q -v ON_ERROR_STOP=1 -U postgres >/dev/null <<SQL
ALTER DATABASE postgres OWNER TO postgres;
GRANT CONNECT ON DATABASE postgres TO PUBLIC;
SQL
pr_schema 15 create "$(fixture_token fifteen)"
expect "create fails when the master user does not own database postgres" "1" "$([ "$RC" -ne 0 ] && echo 1 || echo 0)"
expect_denied "the failure says why" "$OUT" 'PUBLIC still has CONNECT on database postgres'

echo "# pass $pass, fail $fail"
[ "$fail" -eq 0 ]
