#!/usr/bin/env bash
# Tests for .github/scripts/allowlist.sh (m1-hosted-connector task 8.3, design
# D7 group 8.3 fact) against the stubbed aws CLI in tests/ci/lib/bin/aws: the
# verify job adds the QA test addresses to a stage's sign-in allow-list before
# it signs in and removes them afterwards, keeping every other address, never
# printing one, and never touching prod.
# Run: bash tests/ci/allowlist.test.sh
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT="$ROOT/.github/scripts/allowlist.sh"
STUB_BIN="$ROOT/tests/ci/lib/bin"
if [ "$(PATH="$STUB_BIN:$PATH" command -v aws)" != "$STUB_BIN/aws" ]; then
  echo "FAIL - aws stub not found at $STUB_BIN/aws; refusing to run against a real aws CLI" >&2
  exit 1
fi
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Synthetic addresses only.
A="qa-principal-a@a2h-protocol.org"
B="qa-principal-b@a2h-protocol.org"
OWNER="owner-fixture@a2h-protocol.org"

pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "ok   - $1"; }
nok() { fail=$((fail + 1)); echo "FAIL - $1"; if [ -n "${2:-}" ]; then printf '%s\n' "$2" | sed 's/^/       /'; fi; }
check() { local label=$1; shift; if "$@"; then ok "$label"; else nok "$label" "rc=$RC
out:
$OUT
ssm:
$SSM
value: $VALUE"; fi; }

# run [SEED=<value>] <mode> <args...>: SEED is the parameter's value before the run (absent: no parameter).
run() {
  local seed="" mode
  if [[ "${1-}" == SEED=* ]]; then seed=${1#SEED=}; shift; fi
  mode=$1; shift
  rm -rf "$WORK/stub"; mkdir -p "$WORK/stub"; : >"$WORK/stub/calls"; : >"$WORK/stub/ssm"
  if [ -n "$seed" ]; then printf '%s' "$seed" >"$WORK/stub/allowlist"; fi
  set +e
  OUT=$(PATH="$STUB_BIN:$PATH" STUB_DIR="$WORK/stub" STUB_MODE="$mode" AWS_REGION=eu-west-3 bash "$SCRIPT" "$@" 2>&1)
  RC=$?
  set -e
  SSM=$(cat "$WORK/stub/ssm")
  VALUE=$(cat "$WORK/stub/allowlist" 2>/dev/null || echo "<absent>")
}

# --- name ---------------------------------------------------------------------
run ok name dev;   check "name dev is the shared parameter" [ "$RC" -eq 0 ] && [ "$OUT" = "/a2h/shared/principal-allowlist" ]
run ok name pr-51; check "name pr-51 is the preview's own parameter" [ "$RC" -eq 0 ] && [ "$OUT" = "/a2h/pr-51/principal-allowlist" ]
prod_refused() { [ "$RC" -eq 64 ] && [[ "$OUT" == *prod* ]]; }
run ok name prod;  check "prod is refused: QA never signs in on prod" prod_refused
run ok name pr-0;  check "pr-0 is not a stage" [ "$RC" -eq 64 ]
run ok name "pr-12; rm -rf /"; check "an injected stage name is refused before any aws call" [ "$RC" -eq 64 ] && [ -z "$SSM" ]

# --- add ----------------------------------------------------------------------
run SEED=none ok add pr-51 "$A,$B"
check "add to an empty list ('none') writes exactly the two addresses" [ "$RC" -eq 0 ] && [ "$VALUE" = "$A,$B" ]
check "add reads with decryption, then writes once" [ "$SSM" = "get /a2h/pr-51/principal-allowlist
put /a2h/pr-51/principal-allowlist" ]
no_address_in_out() { [[ "$OUT" != *"@"* && "$OUT" == *"2 address"* ]]; }
check "add prints counts, never an address" no_address_in_out
secure_overwrite() { grep -q -- "--type SecureString" "$WORK/stub/calls" && grep -q -- "--overwrite" "$WORK/stub/calls"; }
check "the write is a SecureString overwrite" secure_overwrite

run SEED="$OWNER, $A" ok add pr-51 "$(tr '[:lower:]' '[:upper:]' <<<"$A"),$B"
check "add keeps the owner's address and does not duplicate one already there (case-insensitive)" [ "$RC" -eq 0 ] && [ "$VALUE" = "$OWNER,$A,$B" ]

run SEED="$OWNER,$A,$B" ok add pr-51 "$A"
no_put() { [[ "$SSM" != *put* ]]; }
check "adding what is there changes nothing and writes nothing" [ "$RC" -eq 0 ] && [ "$VALUE" = "$OWNER,$A,$B" ] && no_put

run ok add pr-51 "$A"
missing_on_add() { [ "$RC" -eq 1 ] && [[ "$OUT" == *"does not exist"* ]] && no_put; }
check "add fails when the stage's parameter does not exist (the stage's deploy creates it)" missing_on_add

run SEED=none ssm-put-denied add pr-51 "$A"
denied_put() { [ "$RC" -ne 0 ] && [[ "$OUT" == *AccessDenied* && "$OUT" != *"@"* ]]; }
check "a denied write fails the step with the aws error, no address in the output" denied_put

run SEED=none ok add pr-51 "not-an-address"
check "a value without @ is refused before any aws call" [ "$RC" -eq 64 ] && [ -z "$SSM" ]

run SEED=none ok add dev "$A,$B"
dev_shared() { [ "$RC" -eq 0 ] && [ "$VALUE" = "$A,$B" ] && [[ "$SSM" == *"/a2h/shared/principal-allowlist"* ]]; }
check "dev's shared list may receive the test addresses (verify dev)" dev_shared

# --- remove -------------------------------------------------------------------
run SEED="$OWNER,$A,$B" ok remove pr-51 "$A,$B"
check "remove takes the test addresses out and keeps the owner's" [ "$RC" -eq 0 ] && [ "$VALUE" = "$OWNER" ]

run SEED="$A,$B" ok remove pr-51 "$A,$B"
check "removing the last addresses writes 'none' (SSM refuses an empty value; fail closed)" [ "$RC" -eq 0 ] && [ "$VALUE" = "none" ]

run SEED="$OWNER" ok remove pr-51 "$A"
check "removing an absent address changes nothing and writes nothing" [ "$RC" -eq 0 ] && [ "$VALUE" = "$OWNER" ] && no_put

run ok remove pr-51 "$A"
check "remove on a missing parameter (stage already torn down) is a no-op success" [ "$RC" -eq 0 ] && no_put

# --- usage --------------------------------------------------------------------
run ok; check "no arguments is a usage error" [ "$RC" -eq 64 ]
run ok frob pr-51 "$A"; check "an unknown command is a usage error" [ "$RC" -eq 64 ]
run ok add pr-51; check "add without addresses is a usage error" [ "$RC" -eq 64 ]

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
