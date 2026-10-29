#!/usr/bin/env bash
# shellcheck disable=SC2016 # single-quoted $ is literal on purpose: bash -c bodies and TS template literals
# Tests for .github/scripts/pr-schema.sh against the stubbed aws CLI in
# tests/ci/lib/bin/aws. No cloud access: the stub records every call and plays
# scripted responses. The SQL itself is executed against a real Postgres 17 by
# tests/ci/pr-schema.pg.test.sh.
# Contract: openspec/changes/m0-foundation/tasks.md, "Contract amendment 1".
# Run: bash tests/ci/pr-schema.test.sh
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
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Synthetic values only, built at runtime (tests/ci/lib/fixtures.sh). PW is
# what get-random-password returns; PW_OLD is the value of a secret that already
# exists; PW_RACE is a secret created concurrently; PW_SHORT is too short.
# shellcheck source=tests/ci/lib/fixtures.sh
. "$ROOT/tests/ci/lib/fixtures.sh"
PW=$(fixture_token A)
PW_OLD=$(fixture_token B)
PW_RACE=$(fixture_token C)
PW_SHORT=$(fixture_token S 6)

pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "ok   - $1"; }
nok() { fail=$((fail + 1)); echo "FAIL - $1"; if [ -n "${2:-}" ]; then printf '%s\n' "$2" | sed 's/^/       /'; fi; }
check() { # check <label> <command...>
  local label=$1; shift
  if "$@"; then ok "$label"; else nok "$label" "rc=$RC
out:
$OUT
calls:
$CALLS
sql:
$SQL"; fi
}

# run [VAR=value...] <mode> <args...>
# Sets RC, OUT (stdout+stderr), CALLS (argv of every aws call), SQL (statements
# in order, whitespace collapsed), RDS (database, resource, secret, sql), NAMES
# (secret operations), SECRET (secret value after the run, empty if absent).
# SEED_SECRET, if set, is the secret's value before the run.
run() {
  local envs=()
  while [[ "${1-}" == *=* ]]; do envs+=("$1"); shift; done
  local mode=$1; shift
  rm -rf "$WORK/stub"; mkdir -p "$WORK/stub"
  : >"$WORK/stub/calls"; : >"$WORK/stub/rds"; : >"$WORK/stub/names"
  if [ -n "${SEED_SECRET:-}" ]; then printf '%s' "$SEED_SECRET" >"$WORK/stub/secret"; fi
  set +e
  OUT=$(env -u GITHUB_ACTIONS "${envs[@]}" PATH="$STUB_BIN:$PATH" STUB_DIR="$WORK/stub" STUB_MODE="$mode" \
        STUB_PASSWORD="$PW" STUB_RACE_SECRET="$(secret_json pr_12 "$PW_RACE")" \
        PR_SCHEMA_RETRY_SLEEP=0 PR_SCHEMA_MAX_ATTEMPTS=4 bash "$SCRIPT" "$@" 2>&1)
  RC=$?
  set -e
  CALLS=$(cat "$WORK/stub/calls")
  RDS=$(cat "$WORK/stub/rds")
  SQL=$(cut -f4 "$WORK/stub/rds")
  NAMES=$(cat "$WORK/stub/names")
  SECRET=$(cat "$WORK/stub/secret" 2>/dev/null || true)
}
count() { grep -c -- "$1" <<<"$2" || true; }
rds_calls() { if [ -z "$RDS" ]; then echo 0; else wc -l <<<"$RDS" | tr -d ' '; fi; }

# matches_in_order <file-of-ERE-lines>: SQL has exactly these statements, in this order.
matches_in_order() {
  local expected=$1 i=0 line want
  [ "$(rds_calls)" -eq "$(wc -l <"$expected" | tr -d ' ')" ] || return 1
  while IFS= read -r want; do
    i=$((i + 1))
    line=$(sed -n "${i}p" <<<"$SQL")
    grep -Eqx -- "$want" <<<"$line" || { echo "statement $i: '$line' does not match '$want'" >&2; return 1; }
  done <"$expected"
}

role_stmt() { # ERE of the role statement for <n> <password>
  local n=$1 p=$2 attrs='WITH LOGIN'
  printf '%s' "DO \\\$\\\$ BEGIN IF EXISTS \\(SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pr_$n'\\) THEN ALTER ROLE pr_$n $attrs PASSWORD '$p'; ELSE CREATE ROLE pr_$n $attrs PASSWORD '$p'; END IF; END \\\$\\\$"
}
create_expected() { # create_expected <n> <password> > file
  local n=$1 p=$2
  role_stmt "$n" "$p"; echo
  cat <<EOF
GRANT pr_$n TO CURRENT_USER
CREATE SCHEMA IF NOT EXISTS pr_$n AUTHORIZATION pr_$n
CREATE SCHEMA IF NOT EXISTS pr_${n}_jobs AUTHORIZATION pr_$n
REVOKE CREATE, USAGE ON SCHEMA public FROM PUBLIC
REVOKE CONNECT ON DATABASE a2h FROM PUBLIC
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC
DO \\\$\\\$ BEGIN IF has_database_privilege\\('public', 'postgres', 'CONNECT'\\) THEN RAISE EXCEPTION 'PUBLIC still has CONNECT on database postgres: the master user must own it'; END IF; END \\\$\\\$
GRANT CONNECT ON DATABASE a2h TO pr_$n
ALTER ROLE pr_$n SET search_path = pr_$n
EOF
}
drop_expected() { # drop_expected <n> > file
  local n=$1
  cat <<EOF
DO \\\$\\\$ BEGIN IF EXISTS \\(SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pr_$n'\\) THEN ALTER ROLE pr_$n WITH NOLOGIN; GRANT pr_$n TO CURRENT_USER; END IF; END \\\$\\\$
SELECT pg_terminate_backend\\(pid\\) FROM pg_stat_activity WHERE usename = 'pr_$n'
DROP SCHEMA IF EXISTS pr_$n CASCADE
DROP SCHEMA IF EXISTS pr_${n}_jobs CASCADE
DO \\\$\\\$ BEGIN IF EXISTS \\(SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pr_$n'\\) THEN DROP OWNED BY pr_$n; END IF; END \\\$\\\$
DROP ROLE IF EXISTS pr_$n
EOF
}
create_expected 12 "$PW" >"$WORK/create12-new"
create_expected 12 "$PW_OLD" >"$WORK/create12-reused"
create_expected 12 "$PW_RACE" >"$WORK/create12-race"
drop_expected 13 >"$WORK/drop13"

no_password_in_output() { ! grep -qF -- "$1" <<<"$OUT"; }
no_password_in_argv()   { ! grep -qF -- "$1" <<<"$CALLS"; }
no_schema_flag()        { ! grep -q -- '--schema' <<<"$CALLS" && ! grep -q -- '--sql' <<<"$CALLS"; }
all_on_a2h() {
  [ -n "$RDS" ] && ! cut -f1-3 <<<"$RDS" | grep -vqxF "a2h	arn:aws:rds:eu-west-3:000000000000:cluster:synthetic	arn:aws:secretsmanager:eu-west-3:000000000000:secret:synthetic"
}

echo "# 1. identifier validation and usage"
for bad in "12; DROP SCHEMA public" "abc" "-1" "0" "012" "1e3" "" "12 " "pr_12" "1234567890"; do
  for action in create drop; do
    run ok "$action" "$bad"
    if [ "$RC" -ne 0 ] && [ -z "$CALLS" ]; then ok "$action rejects PR number '$bad' with no AWS call"
    else nok "$action rejects PR number '$bad' with no AWS call" "rc=$RC calls=$CALLS"; fi
  done
done
for args in "" "truncate 12" "create 12 extra"; do
  # shellcheck disable=SC2086 # word splitting is the point
  run ok $args
  if [ "$RC" -eq 64 ] && [ -z "$CALLS" ]; then ok "usage error for '$args', no AWS call"
  else nok "usage error for '$args'" "rc=$RC calls=$CALLS"; fi
done

echo "# 2. create, no secret yet: secret created, then the ten statements in order"
run ok create 12
check "create 12 exits 0" test "$RC" -eq 0
check "reads both ARNs from SSM once" \
  test "$(count 'ssm get-parameter --name /a2h/shared/aurora-cluster-arn' "$CALLS")$(count 'ssm get-parameter --name /a2h/shared/aurora-secret-arn' "$CALLS")" = 11
check "secret: looks up a2h/pr-12/db, then creates a2h/pr-12/db" test "$NAMES" = "get a2h/pr-12/db
create a2h/pr-12/db"
check "password from get-random-password --exclude-punctuation --password-length 32" \
  grep -q -- 'secretsmanager get-random-password --exclude-punctuation --password-length 32' <<<"$CALLS"
check "secret value is {username: pr_12, password: <generated>}" \
  test "$(jq -c '{username, password}' <<<"$SECRET")" = "$(secret_json pr_12 "$PW")"
check "secret is created before any statement runs" \
  test "$(grep -n 'create-secret' <<<"$CALLS" | cut -d: -f1)" -lt "$(grep -n 'execute-statement' <<<"$CALLS" | head -1 | cut -d: -f1)"
check "statements, in order: role (create or alter, LOGIN, password), GRANT to master, CREATE SCHEMA pr_12 and pr_12_jobs AUTHORIZATION pr_12, REVOKE public, REVOKE CONNECT a2h, REVOKE CONNECT postgres, check postgres revoked, GRANT CONNECT, search_path" \
  matches_in_order "$WORK/create12-new"
check "REVOKE CONNECT ON DATABASE postgres is its own Data API call, sent to database a2h" \
  test "$(awk -F'\t' '$4 == "REVOKE CONNECT ON DATABASE postgres FROM PUBLIC" { print $1 }' <<<"$RDS")" = a2h
check "every statement on database a2h with the SSM ARNs" all_on_a2h
check "one statement per Data API call, no --schema, SQL not on the command line" no_schema_flag
check "password not in stdout/stderr" no_password_in_output "$PW"
check "password not in any aws command line" no_password_in_argv "$PW"
check "no ::add-mask:: outside GitHub Actions" bash -c '! grep -q "::add-mask::" <<<"$1"' _ "$OUT"

echo "# 3. create, secret exists: reused, password unchanged, statements use it"
SEED_SECRET=$(secret_json pr_12 "$PW_OLD") run ok create 12
check "create 12 with existing secret exits 0" test "$RC" -eq 0
check "secret only read, never created" test "$NAMES" = "get a2h/pr-12/db"
check "no new password generated" test "$(count get-random-password "$CALLS")" -eq 0
check "secret value unchanged" test "$SECRET" = "$(secret_json pr_12 "$PW_OLD")"
check "same ten statements, ALTER/CREATE ROLE with the stored password" matches_in_order "$WORK/create12-reused"
check "reports reuse" grep -q 'reusing secret a2h/pr-12/db' <<<"$OUT"
check "stored password not in stdout/stderr" no_password_in_output "$PW_OLD"
check "stored password not in any aws command line" no_password_in_argv "$PW_OLD"

echo "# 4. masking in GitHub Actions"
run GITHUB_ACTIONS=true ok create 12
check "new secret: the only output line holding the password is '::add-mask::<password>'" \
  test "$(grep -F -- "$PW" <<<"$OUT")" = "::add-mask::$PW"
check "new secret: mask is printed before any statement output" \
  test "$(grep -n '::add-mask::' <<<"$OUT" | cut -d: -f1)" -lt "$(grep -n 'pr-schema: ok:' <<<"$OUT" | head -1 | cut -d: -f1)"
SEED_SECRET=$(secret_json pr_12 "$PW_OLD") run GITHUB_ACTIONS=true ok create 12
check "reused secret: the only output line holding the password is '::add-mask::<password>'" \
  test "$(grep -F -- "$PW_OLD" <<<"$OUT")" = "::add-mask::$PW_OLD"
check "reused secret: mask is printed before any statement output" \
  test "$(grep -n '::add-mask::' <<<"$OUT" | cut -d: -f1)" -lt "$(grep -n 'pr-schema: ok:' <<<"$OUT" | head -1 | cut -d: -f1)"

echo "# 5. failures never leak the password"
run bad-request-echo create 12
check "a database error echoing the role statement fails the run" test "$RC" -ne 0
check "the error is shown, with the password replaced by ***" \
  bash -c 'grep -q BadRequestException <<<"$1" && grep -qF "PASSWORD '"'"'***'"'"'" <<<"$1"' _ "$OUT"
check "password not in stdout/stderr on error" no_password_in_output "$PW"
check "stops at the first failed statement" test "$(rds_calls)" -eq 1
run create-race create 12
check "secret created concurrently: exits 0" test "$RC" -eq 0
check "secret created concurrently: the stored password wins" matches_in_order "$WORK/create12-race"
check "secret created concurrently: neither password printed" \
  bash -c '! grep -qF "$2" <<<"$1" && ! grep -qF "$3" <<<"$1"' _ "$OUT" "$PW" "$PW_RACE"

echo "# 6. a malformed or unreadable secret stops before any statement"
SEED_SECRET=$(secret_json someone_else "$PW_OLD") run ok create 12
check "secret for another username: fails, no statement" bash -c '[ "$1" -ne 0 ] && [ "$2" -eq 0 ]' _ "$RC" "$(rds_calls)"
check "secret for another username: password not printed" no_password_in_output "$PW_OLD"
INJECT="x'; DROP SCHEMA pr_13 CASCADE; --AAAAAAAAAAAAAAAAAAAAAAAA"
SEED_SECRET=$(secret_json pr_12 "$INJECT") run ok create 12
check "non-alphanumeric password (SQL injection): fails, no statement" bash -c '[ "$1" -ne 0 ] && [ "$2" -eq 0 ]' _ "$RC" "$(rds_calls)"
check "non-alphanumeric password: not printed" no_password_in_output "$INJECT"
SEED_SECRET=$(secret_json pr_12 "$PW_SHORT") run ok create 12
check "password shorter than 32: fails, no statement" bash -c '[ "$1" -ne 0 ] && [ "$2" -eq 0 ]' _ "$RC" "$(rds_calls)"
run secret-denied create 12
check "secret not readable (access denied): fails, nothing created, no statement" \
  bash -c '[ "$1" -ne 0 ] && [ "$2" -eq 0 ] && ! grep -q create-secret <<<"$3"' _ "$RC" "$(rds_calls)" "$CALLS"

echo "# 7. drop: sessions, schema, owned privileges, role, then the secret"
SEED_SECRET=$(secret_json pr_13 "$PW_OLD") run ok drop 13
check "drop 13 exits 0" test "$RC" -eq 0
check "statements, in order: NOLOGIN + GRANT to master, terminate pr_13 sessions, DROP SCHEMA pr_13 and pr_13_jobs CASCADE, DROP OWNED, DROP ROLE" \
  matches_in_order "$WORK/drop13"
check "every statement on database a2h with the SSM ARNs" all_on_a2h
check "no --schema, SQL not on the command line" no_schema_flag
check "secret deleted with --force-delete-without-recovery, after the last statement" \
  bash -c 'tail -1 <<<"$1" | grep -qx -- "secretsmanager delete-secret --secret-id a2h/pr-13/db --force-delete-without-recovery"' _ "$CALLS"
check "secret gone" test -z "$SECRET"
check "drop never reads, generates or creates a secret" test "$NAMES" = "delete a2h/pr-13/db"
check "drop does not print the secret" no_password_in_output "$PW_OLD"
run ok drop 13
check "drop with no secret (already deleted): exits 0" test "$RC" -eq 0
check "drop with no secret: says so" grep -q 'secret a2h/pr-13/db already absent' <<<"$OUT"
check "drop with no secret: still runs all six statements" matches_in_order "$WORK/drop13"
run delete-denied drop 13
check "secret deletion denied: fails, AWS error shown" bash -c '[ "$1" -ne 0 ] && grep -q AccessDeniedException <<<"$2"' _ "$RC" "$OUT"
run bad-request drop 13
check "drop: failed statement stops the run before the secret is deleted" \
  bash -c '[ "$1" -ne 0 ] && [ "$2" -eq 1 ] && ! grep -q delete-secret <<<"$3"' _ "$RC" "$(rds_calls)" "$CALLS"

echo "# 7b. the script touches no secret but a2h/pr-<n>/db (the signing and approval secrets are SST's, design D4 amendment)"
for action in create drop; do
  SEED_SECRET=$(secret_json pr_12 "$PW_OLD") run ok "$action" 12
  check "$action 12: every secret operation names a2h/pr-12/db" \
    bash -c '[ -n "$1" ] && ! grep -v " a2h/pr-12/db$" <<<"$1" | grep -q .' _ "$NAMES"
  check "$action 12: no aws call mentions a signing or approval secret" \
    bash -c '! grep -Eq "signing|approval" <<<"$1"' _ "$CALLS"
done

echo "# 8. retry while the cluster resumes or the API throttles"
run resume-twice create 7
check "retries the first statement twice on DatabaseResumingException, then completes (10 + 2 calls)" \
  bash -c '[ "$1" -eq 0 ] && [ "$2" -eq 12 ]' _ "$RC" "$(rds_calls)"
run throttle-once drop 7
check "retries on ThrottlingException, then completes (6 + 1 calls)" \
  bash -c '[ "$1" -eq 0 ] && [ "$2" -eq 7 ]' _ "$RC" "$(rds_calls)"
run always-resume create 7
check "fails after PR_SCHEMA_MAX_ATTEMPTS (4) resuming errors, error shown" \
  bash -c '[ "$1" -ne 0 ] && [ "$2" -eq 4 ] && grep -q DatabaseResumingException <<<"$3"' _ "$RC" "$(rds_calls)" "$OUT"
run bad-request create 7
check "non-retryable error fails at once with the AWS message" \
  bash -c '[ "$1" -ne 0 ] && [ "$2" -eq 1 ] && grep -q BadRequestException <<<"$3"' _ "$RC" "$(rds_calls)" "$OUT"

echo "# 9. dev not deployed"
run ssm-empty create 7
check "missing /a2h/shared ARN fails before any secret operation or statement" \
  bash -c '[ "$1" -ne 0 ] && [ "$2" -eq 0 ] && [ -z "$3" ]' _ "$RC" "$(rds_calls)" "$NAMES"

echo "# pass $pass, fail $fail"
[ "$fail" -eq 0 ]
