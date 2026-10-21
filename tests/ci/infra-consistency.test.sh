#!/usr/bin/env bash
# shellcheck disable=SC2016 # single-quoted $ is literal on purpose: bash -c bodies and TS template literals
# The names .github/scripts/pr-schema.sh uses must be the names infra/ uses:
#   - the SSM parameters holding the Aurora cluster and master-secret ARNs,
#   - the per-PR schema and database user pr_<n>,
#   - the per-PR secret a2h/pr-<n>/db.
# infra/config.ts is read as text (never edited, never executed). The script
# side is observed by running it against the aws stub, so the test checks what
# the script does, not what its comments say.
# Contract: openspec/changes/m0-foundation/tasks.md, step 4 and amendment 1.
# Run: bash tests/ci/infra-consistency.test.sh
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CONFIG="$ROOT/infra/config.ts"
SCRIPT="$ROOT/.github/scripts/pr-schema.sh"
STUB_BIN="$ROOT/tests/ci/lib/bin"
# shellcheck source=tests/ci/lib/fixtures.sh
. "$ROOT/tests/ci/lib/fixtures.sh"
if [ "$(PATH="$STUB_BIN:$PATH" command -v aws)" != "$STUB_BIN/aws" ]; then
  echo "FAIL - aws stub not found at $STUB_BIN/aws; refusing to run against a real aws CLI" >&2
  exit 1
fi
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "ok   - $1"; }
nok() { fail=$((fail + 1)); echo "FAIL - $1"; if [ -n "${2:-}" ]; then printf '%s\n' "$2" | sed 's/^/       /'; fi; }
note() { echo "note - $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1"; else nok "$1" "infra/config.ts: $2
pr-schema.sh:    $3"; fi; }

N=12
# Instantiate a TS template literal for PR number $N: `pr_${n}` -> pr_12.
instantiate() { sed -E "s/\\$\\{[A-Za-z_][A-Za-z0-9_.]*\\}/$N/g"; }

# --- infra/config.ts, as text --------------------------------------------------
prefix=$(sed -nE 's/^export const SHARED_PREFIX = "([^"]+)";.*/\1/p' "$CONFIG")
param() { sed -nE "/SHARED_PARAMETERS = \\{/,/\\}/ s/^[[:space:]]*$1:[[:space:]]*\"([^\"]+)\",?.*/\\1/p" "$CONFIG"; }
cluster_param=$(param auroraClusterArn)
secret_param=$(param auroraSecretArn)
[ -n "$prefix" ] && [ -n "$cluster_param" ] && [ -n "$secret_param" ] \
  || { echo "FAIL - could not read SHARED_PREFIX / SHARED_PARAMETERS.auroraClusterArn / auroraSecretArn from infra/config.ts" >&2; exit 1; }

# pr-<n> schema: StageInfo.dbSchema of the pr branch of stageInfo().
config_schema=$(sed -nE 's/^[[:space:]]*dbSchema:[[:space:]]*`([^`]*\$\{[^`]*)`.*/\1/p' "$CONFIG" | head -1 | instantiate)
[ -n "$config_schema" ] || { echo "FAIL - no pr dbSchema template in infra/config.ts" >&2; exit 1; }

# DB user and secret name: amendment 1 adds them to the pr-<n> stage. Until
# infra/config.ts carries them, the amendment's names are the reference.
config_user=$(sed -nE 's/^[[:space:]]*dbUser:[[:space:]]*`([^`]*)`.*/\1/p' "$CONFIG" | head -1 | instantiate)
if [ -z "$config_user" ]; then
  config_user="pr_$N"
  note "infra/config.ts has no dbUser template yet; checking against the amendment's pr_<n>"
fi
# Any template literal of the form `a2h/...${...}.../db` is the secret name.
config_secret=$(grep -oE '`a2h/[^`]*\$\{[A-Za-z_][A-Za-z0-9_.]*\}[^`]*/db`' "$CONFIG" | head -1 | tr -d '`' | instantiate || true)
if [ -z "$config_secret" ]; then
  config_secret="a2h/pr-$N/db"
  note "infra/config.ts has no a2h/pr-\${n}/db secret name yet; checking against the amendment's a2h/pr-<n>/db"
fi

# --- pr-schema.sh, as run ------------------------------------------------------
mkdir -p "$WORK/stub"
: >"$WORK/stub/calls"; : >"$WORK/stub/rds"; : >"$WORK/stub/names"
PATH="$STUB_BIN:$PATH" STUB_DIR="$WORK/stub" STUB_PASSWORD="$(fixture_token A)" \
  env -u GITHUB_ACTIONS bash "$SCRIPT" create "$N" >"$WORK/out" 2>&1 \
  || { cat "$WORK/out" >&2; echo "FAIL - pr-schema.sh create $N failed against the stub" >&2; exit 1; }
used_params=$(sed -nE 's/^ssm get-parameter --name ([^ ]+).*/\1/p' "$WORK/stub/calls")
used_secret=$(sed -nE 's/^create (.*)/\1/p' "$WORK/stub/names")
used_user=$(jq -r .username "$WORK/stub/secret")
sql=$(cut -f4 "$WORK/stub/rds")
used_schema=$(sed -nE 's/^CREATE SCHEMA IF NOT EXISTS ([^ ]+) AUTHORIZATION ([^ ]+)$/\1/p' <<<"$sql")
used_owner=$(sed -nE 's/^CREATE SCHEMA IF NOT EXISTS ([^ ]+) AUTHORIZATION ([^ ]+)$/\2/p' <<<"$sql")
used_path=$(sed -nE 's/^ALTER ROLE ([^ ]+) SET search_path = ([^ ]+)$/\2/p' <<<"$sql")
used_role=$(sed -nE 's/.*ELSE CREATE ROLE ([^ ]+) WITH LOGIN.*/\1/p' <<<"$sql")

expect "Aurora cluster ARN parameter" "${prefix}${cluster_param}" "$(sed -n 1p <<<"$used_params")"
expect "Aurora master-secret ARN parameter" "${prefix}${secret_param}" "$(sed -n 2p <<<"$used_params")"
expect "no other SSM parameter is read" "2" "$(grep -c . <<<"$used_params")"
expect "schema pr_<n> (dbSchema)" "$config_schema" "$used_schema"
expect "search_path is the stage's schema" "$config_schema" "$used_path"
expect "login role pr_<n> (DB_USER)" "$config_user" "$used_role"
expect "schema owner is the login role" "$config_user" "$used_owner"
expect "secret username is the login role" "$config_user" "$used_user"
expect "secret name a2h/pr-<n>/db" "$config_secret" "$used_secret"

echo "# pass $pass, fail $fail"
[ "$fail" -eq 0 ]
