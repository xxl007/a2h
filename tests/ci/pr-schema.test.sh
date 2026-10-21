#!/usr/bin/env bash
# Tests for .github/scripts/pr-schema.sh against a stubbed `aws` CLI.
# No cloud access: the stub records every call and plays scripted responses.
# Run: bash tests/ci/pr-schema.test.sh
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT="$ROOT/.github/scripts/pr-schema.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin"
cat > "$WORK/bin/aws" <<'STUB'
#!/usr/bin/env bash
# Stub: logs args (one call per line) and answers per STUB_MODE.
printf '%s\n' "$*" >> "$STUB_LOG"
case "$1 $2" in
  "ssm get-parameter")
    if [ "${STUB_MODE:-ok}" = "ssm-empty" ]; then echo "None"; exit 0; fi
    case "$*" in
      *aurora-cluster-arn*) echo "arn:aws:rds:eu-west-3:000000000000:cluster:synthetic" ;;
      *aurora-secret-arn*)  echo "arn:aws:secretsmanager:eu-west-3:000000000000:secret:synthetic" ;;
      *) echo "unexpected parameter" >&2; exit 255 ;;
    esac
    exit 0 ;;
  "rds-data execute-statement")
    n=$(( $(cat "$STUB_COUNT" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_COUNT"
    case "${STUB_MODE:-ok}" in
      ok) echo '{"numberOfRecordsUpdated": 0}'; exit 0 ;;
      resume-twice)
        if [ "$n" -le 2 ]; then
          echo "An error occurred (DatabaseResumingException) when calling the ExecuteStatement operation: The Aurora DB instance db-x is resuming after being auto-paused." >&2; exit 254
        fi
        echo '{}'; exit 0 ;;
      throttle-once)
        if [ "$n" -le 1 ]; then
          echo "An error occurred (ThrottlingException) when calling the ExecuteStatement operation (reached max retries: 2): Rate exceeded" >&2; exit 254
        fi
        echo '{}'; exit 0 ;;
      always-resume)
        echo "An error occurred (DatabaseResumingException) when calling the ExecuteStatement operation: resuming" >&2; exit 254 ;;
      bad-request)
        echo "An error occurred (BadRequestException) when calling the ExecuteStatement operation: ERROR: syntax error" >&2; exit 254 ;;
    esac ;;
esac
echo "stub: unexpected call: $*" >&2; exit 255
STUB
chmod +x "$WORK/bin/aws"

pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "ok   - $1"; }
nok() { fail=$((fail + 1)); echo "FAIL - $1"; if [ -n "${2:-}" ]; then printf '       %s\n' "$2"; fi; }

# run <mode> <args...>: sets RC, OUT (stdout+stderr), LOG (aws calls)
run() {
  local mode=$1; shift
  : > "$WORK/log"; rm -f "$WORK/count"
  set +e
  OUT=$(PATH="$WORK/bin:$PATH" STUB_LOG="$WORK/log" STUB_COUNT="$WORK/count" STUB_MODE="$mode" \
        PR_SCHEMA_RETRY_SLEEP=0 PR_SCHEMA_MAX_ATTEMPTS=4 bash "$SCRIPT" "$@" 2>&1)
  RC=$?
  set -e
  LOG=$(cat "$WORK/log")
}
calls() { grep -c "$1" <<<"$LOG" || true; }

# 1. Identifier validation happens before any AWS call or SQL interpolation.
for bad in "12; DROP SCHEMA public" "abc" "-1" "0" "012" "1e3" "" "12 " "pr_12" "1234567890"; do
  run ok create "$bad"
  if [ "$RC" -ne 0 ] && [ -z "$LOG" ]; then ok "rejects PR number '$bad' with no AWS call"
  else nok "rejects PR number '$bad' with no AWS call" "rc=$RC log=$LOG"; fi
done

expect_usage() {
  local label=$1; shift
  run ok "$@"
  if [ "$RC" -ne 0 ] && [ -z "$LOG" ]; then ok "$label"; else nok "$label" "rc=$RC log=$LOG"; fi
}
expect_usage "no arguments: usage error"
expect_usage "unknown action rejected" truncate 12
expect_usage "extra argument rejected" create 12 extra

# 2. create: ARNs from SSM, one statement, database a2h, no --schema.
run ok create 12
if [ "$RC" -eq 0 ] \
  && [ "$(calls 'ssm get-parameter --name /a2h/shared/aurora-cluster-arn')" -eq 1 ] \
  && [ "$(calls 'ssm get-parameter --name /a2h/shared/aurora-secret-arn')" -eq 1 ] \
  && grep -q -- '--resource-arn arn:aws:rds:eu-west-3:000000000000:cluster:synthetic' <<<"$LOG" \
  && grep -q -- '--secret-arn arn:aws:secretsmanager:eu-west-3:000000000000:secret:synthetic' <<<"$LOG" \
  && grep -q -- '--database a2h' <<<"$LOG" \
  && grep -q -- '--sql CREATE SCHEMA IF NOT EXISTS pr_12$' <<<"$LOG" \
  && [ "$(calls 'rds-data execute-statement')" -eq 1 ] \
  && ! grep -q -- '--schema' <<<"$LOG" \
  && grep -q 'pr_12' <<<"$OUT"; then ok "create 12 runs CREATE SCHEMA IF NOT EXISTS pr_12 once, no --schema, reports it"
else nok "create 12" "rc=$RC out=$OUT log=$LOG"; fi

# 3. drop: CASCADE, idempotent form.
run ok drop 13
if [ "$RC" -eq 0 ] && grep -q -- '--sql DROP SCHEMA IF EXISTS pr_13 CASCADE$' <<<"$LOG" \
  && [ "$(calls 'rds-data execute-statement')" -eq 1 ] && ! grep -q -- '--schema' <<<"$LOG"; then
  ok "drop 13 runs DROP SCHEMA IF EXISTS pr_13 CASCADE once"
else nok "drop 13" "rc=$RC out=$OUT log=$LOG"; fi

# 4. Retry on DatabaseResumingException (cluster waking from 0 ACU).
run resume-twice create 7
if [ "$RC" -eq 0 ] && [ "$(calls 'rds-data execute-statement')" -eq 3 ]; then ok "retries on DatabaseResumingException then succeeds (3 calls)"
else nok "retry on resuming" "rc=$RC out=$OUT"; fi

# 5. Retry on throttling.
run throttle-once drop 7
if [ "$RC" -eq 0 ] && [ "$(calls 'rds-data execute-statement')" -eq 2 ]; then ok "retries on ThrottlingException then succeeds (2 calls)"
else nok "retry on throttling" "rc=$RC out=$OUT"; fi

# 6. Gives up loudly after the attempt budget.
run always-resume create 7
if [ "$RC" -ne 0 ] && [ "$(calls 'rds-data execute-statement')" -eq 4 ] && grep -q 'DatabaseResumingException' <<<"$OUT"; then
  ok "fails after PR_SCHEMA_MAX_ATTEMPTS (4) resuming errors, error shown"
else nok "attempt budget" "rc=$RC calls=$(calls 'rds-data execute-statement') out=$OUT"; fi

# 7. Any other error fails immediately, no retry.
run bad-request create 7
if [ "$RC" -ne 0 ] && [ "$(calls 'rds-data execute-statement')" -eq 1 ] && grep -q 'BadRequestException' <<<"$OUT"; then
  ok "non-retryable error fails at once with the AWS message"
else nok "non-retryable error" "rc=$RC out=$OUT"; fi

# 8. Missing SSM parameter (dev not deployed yet) fails before any statement.
run ssm-empty create 7
if [ "$RC" -ne 0 ] && [ "$(calls 'rds-data execute-statement')" -eq 0 ]; then ok "missing /a2h/shared ARN fails before any statement"
else nok "missing SSM" "rc=$RC out=$OUT log=$LOG"; fi

echo "# pass $pass, fail $fail"
[ "$fail" -eq 0 ]
