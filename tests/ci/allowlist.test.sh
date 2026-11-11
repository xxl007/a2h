#!/usr/bin/env bash
# Tests for .github/scripts/allowlist.sh (m1-hosted-connector task 8.3, design
# D7 group 8.3 fact) against the stubbed aws CLI in tests/ci/lib/bin/aws: the
# verify job adds the QA test addresses to a stage's sign-in allow-list before
# it signs in and removes them afterwards, keeping every other address, never
# printing one, and never touching prod. On dev (issue #118, owner decision
# 2026-11-11) it adds and removes the per-run QA addresses only: the owner's
# addresses on dev's list are never accepted, so never removed.
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
# The per-run twins the verify jobs use (run id, attempt).
RA="qa-principal-a-43012452475-1@a2h-protocol.org"
RB="qa-principal-b-43012452475-1@a2h-protocol.org"

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

# Cold review of #120, N2: an aws error that quotes the value never reaches the (public) log unredacted.
redacted() { [ "$RC" -eq 1 ] && [[ "$OUT" != *"@"* && "$OUT" == *"<address>"* ]]; }
run SEED="$OWNER" ssm-put-echo add pr-51 "$A"
check "a failed write whose aws error quotes the value prints <address>, never an address" redacted
run SEED="$OWNER" ssm-get-echo add pr-51 "$A"
check "a failed read whose aws error quotes the value prints <address>, never an address" redacted

run SEED=none ok add pr-51 "not-an-address"
check "a value without @ is refused before any aws call" [ "$RC" -eq 64 ] && [ -z "$SSM" ]

# dev (issue #118): the verify job admits its per-run QA principals on dev's
# shared list and takes them out again; the owner's addresses (and the old fixed
# QA ones, which only the owner removes) stay as they are.
# Whole conditions inside check (a bare `check … && [ … ]` would test the rest outside it).
value_is() { [ "$RC" -eq 0 ] && [ "$VALUE" = "$1" ]; }
dev_written() { value_is "$1" && [ "$SSM" = "get /a2h/shared/principal-allowlist
put /a2h/shared/principal-allowlist" ]; }
run SEED="$OWNER,$A,$B" ok add dev "$RA,$RB"
check "dev add: writes the shared parameter, keeping the owner's and the fixed QA addresses" dev_written "$OWNER,$A,$B,$RA,$RB"
check "dev add prints counts, never an address" no_address_in_out
run SEED="$OWNER,$A,$B,$RA,$RB" ok remove dev "$RA,$RB"
check "dev remove: takes the run's addresses out and keeps every other one" dev_written "$OWNER,$A,$B"
check "dev remove prints counts, never an address" no_address_in_out
run SEED="$OWNER,$RA" ok remove dev "$RA,$RB"
check "dev remove when one of the run's addresses is already gone removes the other" dev_written "$OWNER"
# Cold review of #120, N1: a list the owner wrote with duplicates (any case) must not hide the change.
run SEED="$OWNER,$OWNER,$A,$(tr '[:lower:]' '[:upper:]' <<<"$A")" ok add dev "$RA,$RB"
check "dev add over a list with duplicates still admits the run's principals (written once each)" dev_written "$OWNER,$A,$RA,$RB"
run SEED="$OWNER,$OWNER,$RA,$RA,$RB" ok remove dev "$RA,$RB"
check "dev remove over a list with duplicates takes the run's principals out" dev_written "$OWNER"
run SEED="$OWNER,$OWNER" ok add pr-51 "$A"
check "preview add over a list with duplicates writes the new address" value_is "$OWNER,$A"
# On dev only the per-run QA form is accepted: CI can never take the owner's
# address (or anyone else's) off dev's list, nor put one on it.
dev_foreign_refused() { [ "$RC" -eq 64 ] && [ "$VALUE" = "$OWNER,$A,$RA" ] && [ -z "$SSM" ] && [[ "$OUT" != *"@"* ]]; }
run SEED="$OWNER,$A,$RA" ok remove dev "$RA,$OWNER"
check "dev remove with the owner's address among them is refused before any aws call" dev_foreign_refused
run SEED="$OWNER,$A,$RA" ok remove dev "$A"
check "dev remove of a fixed QA address is refused (the owner removes those)" dev_foreign_refused
run SEED="$OWNER,$A,$RA" ok add dev "$OWNER"
check "dev add of an address not of the per-run QA form is refused" dev_foreign_refused
run SEED="$OWNER,$A,$RA" ok add dev "qa-principal-c-1-1@a2h-protocol.org"
check "dev add: only the a and b principals" dev_foreign_refused
run SEED="$OWNER,$A,$RA" ok add dev "qa-principal-a-1-1@a2h-protocol.org.evil.example"
check "dev add: only under the product domain, anchored" dev_foreign_refused
run SEED="$OWNER,$A,$RA" ok add dev "qa-principal-a--1@a2h-protocol.org"
check "dev add: the run id and the attempt are both required" dev_foreign_refused
# A preview's own parameter takes any address (the owner may add theirs there).
run SEED=none ok add pr-51 "$OWNER"
check "a preview still accepts any address" value_is "$OWNER"
run SEED=none ok add prod "$RA"
check "prod: add is refused" prod_refused
run SEED="$OWNER,$RA" ok remove prod "$RA"
prod_untouched() { prod_refused && [ -z "$SSM" ] && [ "$VALUE" = "$OWNER,$RA" ]; }
check "prod: remove is refused before any aws call" prod_untouched

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
