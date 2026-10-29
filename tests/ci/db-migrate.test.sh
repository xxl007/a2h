#!/usr/bin/env bash
# shellcheck disable=SC2016 # single-quoted $ is literal on purpose: bash -c bodies
# Tests for .github/scripts/db-migrate.sh (task 3.3, design D2).
#
# Part 1 runs everywhere: argument checks and failures before any statement,
# against the stubbed aws CLI (tests/ci/lib/bin/aws) with no database.
# Part 2 runs the script against a real PostgreSQL 17 in Docker: the stub
# forwards each Data API statement to psql as "master" (the Aurora master user
# without superuser), with transactions replayed on one connection. Statements
# are checked at commit (STUB_TX_CHECK=commit, for speed) except in the failing
# file case, which checks each one as the Data API does. Previews
# are set up by pr-schema.sh create first, as the workflow does.
# Specs: platform/participant-simulation "Redeploy" and "Nothing on production"
# (seed side); preview-environments "Two PRs open" (ownership).
# Needs Docker for part 2; without it part 2 is skipped unless
# DB_MIGRATE_PG_REQUIRED=1 (set it in CI), in which case the test fails.
# Run: bash tests/ci/db-migrate.test.sh
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# DB_MIGRATE_SCRIPT lets a mutated copy be run against these tests.
SCRIPT=${DB_MIGRATE_SCRIPT:-"$ROOT/.github/scripts/db-migrate.sh"}
PR_SCHEMA="$ROOT/.github/scripts/pr-schema.sh"
STUB_BIN="$ROOT/tests/ci/lib/bin"
MIGRATIONS="$ROOT/packages/db/migrations"
if [ "$(PATH="$STUB_BIN:$PATH" command -v aws)" != "$STUB_BIN/aws" ]; then
  echo "FAIL - aws stub not found at $STUB_BIN/aws; refusing to run against a real aws CLI" >&2
  exit 1
fi
IMAGE=${DB_MIGRATE_PG_IMAGE:-postgres:17}
WORK=$(mktemp -d)
C="a2h-db-migrate-test-$$"
cleanup() { docker rm -f "$C" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

# shellcheck source=tests/ci/lib/fixtures.sh
. "$ROOT/tests/ci/lib/fixtures.sh"

pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "ok   - $1"; }
nok() { fail=$((fail + 1)); echo "FAIL - $1"; if [ -n "${2:-}" ]; then printf '%s\n' "$2" | sed 's/^/       /'; fi; }
expect() { # expect <label> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else nok "$1" "expected: $2
actual:   $3
output:
$OUT"; fi
}
check() { # check <label> <command...>
  local label=$1; shift
  if "$@"; then ok "$label"; else nok "$label" "rc=$RC
output:
$OUT
calls:
$CALLS"; fi
}

# migrate [VAR=value...] <stub-dir> <stage>: runs the script; sets RC, OUT,
# CALLS (argv of every aws call), TX (transaction operations), SQL (statements).
migrate() {
  local envs=()
  while [[ "${1-}" == *=* ]]; do envs+=("$1"); shift; done
  local dir=$1; shift
  mkdir -p "$dir"; : >"$dir/calls"; : >"$dir/rds"; : >"$dir/txlog"; rm -f "$dir/rds_count"
  set +e
  OUT=$(env -u GITHUB_ACTIONS PATH="$STUB_BIN:$PATH" STUB_DIR="$dir" \
    DB_MIGRATE_RETRY_SLEEP=0 DB_MIGRATE_MAX_ATTEMPTS=4 STUB_TX_CHECK=commit "${envs[@]}" bash "$SCRIPT" "$@" 2>&1)
  RC=$?
  set -e
  CALLS=$(cat "$dir/calls"); TX=$(cat "$dir/txlog"); SQL=$(cut -f4 "$dir/rds")
}
count() { grep -c -- "$1" <<<"$2" || true; }

echo "# 1. arguments and early failures (no database)"
for bad in "" "staging" "pr-012" "pr-0" "pr-" "pr-1; DROP SCHEMA public" "PR-12" "dev extra" "pr_12"; do
  # shellcheck disable=SC2086 # word splitting is the point
  migrate "$WORK/u" $bad
  if [ "$RC" -eq 64 ] && [ -z "$CALLS" ]; then ok "rejects stage '$bad' with no AWS call"
  else nok "rejects stage '$bad' with no AWS call" "rc=$RC calls=$CALLS"; fi
done
migrate STUB_MODE=ssm-empty "$WORK/u" dev
check "dev not deployed (SSM ARN empty): fails before any statement" \
  bash -c '[ "$1" -ne 0 ] && ! grep -q rds-data <<<"$2"' _ "$RC" "$CALLS"
migrate "$WORK/u" prod
check "prod without A2H_DB_CLUSTER_ARN / A2H_DB_SECRET_ARN: fails before any AWS call, says why" \
  bash -c '[ "$1" -ne 0 ] && [ -z "$2" ] && grep -q "A2H_DB_CLUSTER_ARN" <<<"$3"' _ "$RC" "$CALLS" "$OUT"
migrate DB_MIGRATE_DIR="$WORK/does-not-exist" "$WORK/u" dev
check "missing migrations directory: fails before any AWS call" bash -c '[ "$1" -ne 0 ] && [ -z "$2" ]' _ "$RC" "$CALLS"

if ! docker info >/dev/null 2>&1; then
  if [ "${DB_MIGRATE_PG_REQUIRED:-}" = 1 ]; then echo "FAIL - docker is not available" >&2; exit 1; fi
  echo "skip - docker is not available; db-migrate.sh not run against Postgres"
  echo "# pass $pass, fail $fail"
  [ "$fail" -eq 0 ]
  exit
fi

PG_SUPER=$(fixture_token super)
PG_MASTER=$(fixture_token master)
docker run -d --name "$C" -e POSTGRES_PASSWORD="$PG_SUPER" \
  -e POSTGRES_INITDB_ARGS="--auth-host=scram-sha-256 --auth-local=trust" "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$C" pg_isready -q -h 127.0.0.1 -U postgres 2>/dev/null \
    && docker exec -e PGPASSWORD="$PG_SUPER" "$C" psql -X -q -U postgres -h 127.0.0.1 -c 'select 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$C" psql -X -q -v ON_ERROR_STOP=1 -U postgres >/dev/null <<SQL
CREATE ROLE master LOGIN CREATEROLE CREATEDB PASSWORD '$PG_MASTER';
CREATE DATABASE a2h OWNER master;
CREATE DATABASE a2h_prod OWNER master;
ALTER DATABASE postgres OWNER TO master;
ALTER SCHEMA public OWNER TO master;
SQL
docker exec -i "$C" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d a2h_prod -c 'ALTER SCHEMA public OWNER TO master' >/dev/null
echo "# postgres: $(docker exec "$C" psql -X -tA -U postgres -c 'show server_version')"

PSQL_A2H="docker exec -i $C psql -X -q -v ON_ERROR_STOP=1 -U master -d a2h"
PSQL_PROD="docker exec -i $C psql -X -q -v ON_ERROR_STOP=1 -U master -d a2h_prod"
q() { docker exec "$C" psql -X -tA -v ON_ERROR_STOP=1 -U master -d "${2:-a2h}" -c "$1" 2>&1; }
as_login() { # as_login <role> <password> <sql>
  docker exec -e PGPASSWORD="$2" "$C" psql -X -tA -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$1" -d a2h -c "$3" 2>&1
}
pr_schema() { # pr_schema <n> create|drop <password>
  mkdir -p "$WORK/prs-$1"
  env -u GITHUB_ACTIONS PATH="$STUB_BIN:$PATH" STUB_DIR="$WORK/prs-$1" STUB_PASSWORD="$3" \
    STUB_PSQL="$PSQL_A2H" PR_SCHEMA_RETRY_SLEEP=0 bash "$PR_SCHEMA" "$2" "$1" >/dev/null 2>&1
}
not_owned_by() { # not_owned_by <schema> <role>: objects (relations, functions) in schema owned by someone else
  q "SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = '$1' AND c.relowner <> '$2'::regrole)
          + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = '$1' AND p.proowner <> '$2'::regrole)"
}
files=$(find "$MIGRATIONS" -maxdepth 1 -name "[0-9][0-9][0-9][0-9]_*.sql" -printf "%f\n" | LC_ALL=C sort)
nfiles=$(wc -l <<<"$files" | tr -d ' ')
sums=$(cd "$MIGRATIONS" && for f in $files; do printf '%s|%s\n' "$f" "$(sha256sum "$f" | cut -d' ' -f1)"; done)

echo "# 2. dev, first run: every file applied in public, tracked, seed applied"
migrate STUB_PSQL="$PSQL_A2H" "$WORK/dev" dev
expect "dev first run exits 0" 0 "$RC"
expect "one transaction per migration file plus one for the seed, all committed" \
  "$((nfiles + 1)) $((nfiles + 1)) 0" "$(count '^begin' "$TX") $(count '^commit' "$TX") $(count '^rollback' "$TX")"
expect "schema_migrations lists every file with its sha256, in order" "$sums" \
  "$(q "SELECT name || '|' || checksum FROM public.schema_migrations ORDER BY name")"
expect "Seed on dev: twelve simulated participants" 12 "$(q 'SELECT count(*) FROM public.participants WHERE simulated')"
expect "five personas" 5 "$(q 'SELECT count(*) FROM public.simulated_personas')"
expect "the pg-boss schema pgboss exists on dev (design D3; the worker does not create it)" "master" \
  "$(q "SELECT nspowner::regrole FROM pg_namespace WHERE nspname = 'pgboss'")"
check "no SET ROLE on dev" bash -c '! grep -qi "SET LOCAL ROLE" <<<"$1"' _ "$SQL"
check "every statement on database a2h through the Data API, no SQL on a command line" \
  bash -c '! grep -q -- "--sql" <<<"$1" && grep -q "rds-data begin-transaction --resource-arn arn:aws:rds:eu-west-3:000000000000:cluster:synthetic --secret-arn arn:aws:secretsmanager:eu-west-3:000000000000:secret:synthetic --database a2h" <<<"$1"' _ "$CALLS"

echo "# 3. dev, re-run: no migration applied again, seed upserted, still twelve"
migrate STUB_PSQL="$PSQL_A2H" "$WORK/dev" dev
expect "dev re-run exits 0" 0 "$RC"
expect "re-run: one transaction only (the seed)" 1 "$(count '^begin' "$TX")"
check "re-run says the schema is up to date" grep -q "up to date" <<<"$OUT"
expect "Scenario: Redeploy: still twelve participants, one per handle" "12 12" \
  "$(q 'SELECT count(*) || chr(32) || count(DISTINCT handle) FROM public.participants')"
expect "tracking rows unchanged" "$nfiles" "$(q 'SELECT count(*) FROM public.schema_migrations')"

echo "# 4. preview: SET ROLE pr_<n>, everything in pr_<n> owned by pr_<n>"
PW21=$(fixture_token twentyone)
pr_schema 21 create "$PW21"
before_public=$(q "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'")
migrate STUB_PSQL="$PSQL_A2H" "$WORK/pr21" pr-21
expect "pr-21 exits 0" 0 "$RC"
check "each transaction starts with SET LOCAL ROLE pr_21, then search_path pr_21" \
  bash -c 'grep -qx "SET LOCAL ROLE pr_21" <<<"$1" && grep -qx "SET LOCAL search_path = pr_21" <<<"$1"' _ "$SQL"
expect "tables in pr_21" 12 "$(q "SELECT count(*) FROM pg_tables WHERE schemaname = 'pr_21'")"
expect "every relation and function in pr_21 is owned by pr_21" 0 "$(not_owned_by pr_21 pr_21)"
expect "nothing added to public" "$before_public" \
  "$(q "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'")"
expect "the preview login sees the seeded set through its search_path" 12 "$(as_login pr_21 "$PW21" 'SELECT count(*) FROM participants')"
expect "the preview login is refused an update of an append-only table (owner, trigger)" "append-only" \
  "$(as_login pr_21 "$PW21" "TRUNCATE request_events" | grep -o 'append-only' | head -1)"
check "previews: no jobs schema statement (pr-schema.sh owns pr_<n>_jobs)" bash -c '! grep -qi "CREATE SCHEMA" <<<"$1"' _ "$SQL"
check "no fallback needed when SET ROLE holds" bash -c '! grep -q "fallback" <<<"$1"' _ "$OUT"
migrate STUB_PSQL="$PSQL_A2H" "$WORK/pr21" pr-21
expect "pr-21 re-run: only the seed transaction" "0 1" "$RC $(count '^begin' "$TX")"

echo "# 5. preview, SET ROLE not kept by the Data API: ownership fallback (design D2)"
PW22=$(fixture_token twentytwo)
pr_schema 22 create "$PW22"
migrate STUB_PSQL="$PSQL_A2H" STUB_MODE=no-set-role "$WORK/pr22" pr-22
expect "pr-22 (no SET ROLE) exits 0" 0 "$RC"
check "the run says the fallback reassigned ownership" grep -q "fallback: reassigned" <<<"$OUT"
expect "every relation and function in pr_22 is owned by pr_22 after the fallback" 0 "$(not_owned_by pr_22 pr_22)"
expect "the preview login can still read its tables" 12 "$(as_login pr_22 "$PW22" 'SELECT count(*) FROM participants')"
pr_schema 22 drop unused
expect "drop of the preview removes what the fallback reassigned" 0 "$(q "SELECT count(*) FROM pg_namespace WHERE nspname = 'pr_22'")"

echo "# 6. a failing file: its transaction is rolled back, no tracking row"
cp -r "$MIGRATIONS" "$WORK/broken"
cat >"$WORK/broken/9998_broken.sql" <<'SQL'
CREATE TABLE half_applied (id integer);
--> statement-breakpoint
INSERT INTO no_such_table VALUES (1);
SQL
cp "$WORK/broken/9998_broken.sql" "$WORK/broken/9999_after.sql"
sed -i 's/half_applied/never_reached/' "$WORK/broken/9999_after.sql"
PW23=$(fixture_token twentythree)
pr_schema 23 create "$PW23"
# Per-statement checking here, so the error is reported by the call that caused it.
migrate STUB_PSQL="$PSQL_A2H" STUB_TX_CHECK=each DB_MIGRATE_DIR="$WORK/broken" "$WORK/pr23" pr-23
check "exits non-zero and names the failing file" bash -c '[ "$1" -ne 0 ] && grep -q "9998_broken.sql" <<<"$2"' _ "$RC" "$OUT"
check "the Postgres error is shown" grep -q 'no_such_table' <<<"$OUT"
expect "the failing transaction was rolled back" 1 "$(count '^rollback' "$TX")"
expect "the files before it are applied and tracked" "$nfiles" "$(q "SELECT count(*) FROM pr_23.schema_migrations")"
expect "no tracking row for the failing file" 0 "$(q "SELECT count(*) FROM pr_23.schema_migrations WHERE name = '9998_broken.sql'")"
expect "its first statement left nothing (table absent)" "" "$(q "SELECT to_regclass('pr_23.half_applied')")"
expect "nothing after it ran" "" "$(q "SELECT to_regclass('pr_23.never_reached')")"
check "no seed after a failed migration" bash -c '! grep -q "seed: applied" <<<"$1"' _ "$OUT"

echo "# 7. an applied file that changed is refused before any transaction"
cp -r "$MIGRATIONS" "$WORK/changed"
first=$(head -1 <<<"$files")
echo "-- edited after it was applied" >>"$WORK/changed/$first"
migrate STUB_PSQL="$PSQL_A2H" DB_MIGRATE_DIR="$WORK/changed" "$WORK/dev" dev
check "changed file: exits non-zero, names it, opens no transaction" \
  bash -c '[ "$1" -ne 0 ] && grep -q "$3" <<<"$2" && [ -z "$4" ]' _ "$RC" "$OUT" "$first" "$TX"

echo "# 8. prod: migrations only, never the seed"
migrate STUB_PSQL="$PSQL_PROD" A2H_DB_CLUSTER_ARN=arn:aws:rds:eu-west-3:000000000000:cluster:prod \
  A2H_DB_SECRET_ARN=arn:aws:secretsmanager:eu-west-3:000000000000:secret:prod "$WORK/prod" prod
expect "prod exits 0" 0 "$RC"
expect "prod: one transaction per file, none for a seed" "$nfiles" "$(count '^begin' "$TX")"
expect "Scenario: Nothing on production (seed side): no participant, no persona" "0 0" \
  "$(q 'SELECT (SELECT count(*) FROM public.participants) || chr(32) || (SELECT count(*) FROM public.simulated_personas)' a2h_prod)"
expect "the pg-boss schema pgboss exists on prod" 1 "$(q "SELECT count(*) FROM pg_namespace WHERE nspname = 'pgboss'" a2h_prod)"
check "prod: says the seed is skipped" grep -q "seed: skipped on prod" <<<"$OUT"
check "prod: uses the given ARNs, never SSM" \
  bash -c '! grep -q "ssm get-parameter" <<<"$1" && grep -q "cluster:prod" <<<"$1"' _ "$CALLS"
check "prod: no a2h.stage seed statement was sent" bash -c '! grep -q "a2h.stage" <<<"$1"' _ "$SQL"

echo "# 9. retry while the cluster resumes"
migrate STUB_PSQL="$PSQL_A2H" STUB_MODE=resume-twice "$WORK/dev" dev
expect "two DatabaseResumingException answers, then success" 0 "$RC"
check "the retries are reported" grep -q "resuming or throttled" <<<"$OUT"

echo "# pass $pass, fail $fail"
[ "$fail" -eq 0 ]
