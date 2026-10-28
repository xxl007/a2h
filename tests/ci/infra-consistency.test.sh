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
#
# Since m1-protocol-connector (task 6.1), also:
#   - every environment variable apps/<service> reads is one infra gives that
#     service (infra/service-env.ts serviceEnvNames, executed with node: pure,
#     no SST, no AWS) or one its Dockerfile bakes in;
#   - pr-schema.sh never creates the per-stage secrets SST owns
#     (a2h/pr-<n>/signing, a2h/pr-<n>/approval, infra/stage-secrets.ts);
#   - if pr-schema.sh creates a second schema, it is the stage's jobsSchema.
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
if [ -z "$prefix" ] || [ -z "$cluster_param" ] || [ -z "$secret_param" ]; then
  echo "FAIL - could not read SHARED_PREFIX / SHARED_PARAMETERS.auroraClusterArn / auroraSecretArn from infra/config.ts" >&2
  exit 1
fi

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

# --- m1: per-stage secrets are SST's, never pr-schema.sh's ----------------------
stage_secret_names=$(node --experimental-strip-types --no-warnings --input-type=module -e '
  const { stageSecretName, STAGE_SECRET_KINDS } = await import(process.argv[1]);
  const { stageInfo } = await import(process.argv[2]);
  for (const k of STAGE_SECRET_KINDS) console.log(stageSecretName(stageInfo(`pr-${process.argv[3]}`), k));
' "$ROOT/infra/stage-secrets.ts" "$ROOT/infra/config.ts" "$N") \
  || { echo "FAIL - could not evaluate infra/stage-secrets.ts" >&2; exit 1; }
expect "SST owns two per-stage secrets" "2" "$(grep -c . <<<"$stage_secret_names")"
while IFS= read -r name; do
  if grep -qxF "create $name" "$WORK/stub/names"; then
    nok "pr-schema.sh must not create $name (SST creates it, design D4 amendment)"
  else
    ok "pr-schema.sh leaves $name to SST"
  fi
done <<<"$stage_secret_names"
expect "pr-schema.sh creates only a2h/pr-<n>/db" "$config_secret" "$(sed -nE 's/^create (.*)/\1/p' "$WORK/stub/names" | sort -u | paste -sd' ' -)"

# --- m1: pg-boss schema (design D3) --------------------------------------------
config_jobs=$(sed -nE 's/^[[:space:]]*jobsSchema:[[:space:]]*`([^`]*\$\{[^`]*)`.*/\1/p' "$CONFIG" | head -1 | instantiate)
[ -n "$config_jobs" ] || { echo "FAIL - no pr jobsSchema template in infra/config.ts" >&2; exit 1; }
other_schemas=$(sed -nE 's/^CREATE SCHEMA IF NOT EXISTS ([^ ]+) AUTHORIZATION ([^ ]+)$/\1/p' <<<"$sql" | grep -vxF "$config_schema" || true)
if [ -z "$other_schemas" ]; then
  note "pr-schema.sh creates no jobs schema yet (task 3.4); infra expects $config_jobs"
else
  expect "jobs schema pr_<n>_jobs (jobsSchema)" "$config_jobs" "$other_schemas"
fi

# --- m1: environment the apps read vs. environment infra provides --------------
# Names a service's own code reads: process.env.X, process.env["X"], env["X"],
# and helper calls f(env, "X") as in apps/worker/infra/env.ts. Test files and
# node_modules are excluded.
app_reads() {
  local dir=$1
  { grep -rhoE --include='*.ts' --exclude='*.test.ts' --exclude-dir=node_modules --exclude-dir=test --exclude-dir=dist \
      -e 'process\.env\.[A-Z][A-Z0-9_]*' -e 'env\[["'"'"'][A-Z][A-Z0-9_]*["'"'"']\]' \
      -e '[A-Za-z]+\(env, ["'"'"'][A-Z][A-Z0-9_]*["'"'"']' \
      "$ROOT/apps/$dir/src" "$ROOT/apps/$dir/infra" 2>/dev/null || true; } \
    | grep -oE '[A-Z][A-Z0-9_]*' | grep -vxE 'E|ENV' | sort -u
}
infra_names() { # infra_names <service> <stage>
  node --experimental-strip-types --no-warnings --input-type=module -e '
    const { serviceEnvNames } = await import(process.argv[1]);
    const { stageInfo } = await import(process.argv[2]);
    for (const n of serviceEnvNames(process.argv[3], stageInfo(process.argv[4]))) console.log(n);
  ' "$ROOT/infra/service-env.ts" "$ROOT/infra/config.ts" "$1" "$2"
}
baked() { sed -nE 's/^ENV[[:space:]]+([A-Z][A-Z0-9_]*).*/\1/p' "$ROOT/apps/$1/Dockerfile" | sort -u; }

for svc in mcp worker; do
  reads=$(app_reads "$svc")
  [ -n "$reads" ] || { nok "apps/$svc reads no environment variable at all (pattern broken?)"; continue; }
  for stage in dev prod "pr-$N"; do
    provided=$( { infra_names "$svc" "$stage" && baked "$svc"; } | sort -u) \
      || { nok "could not evaluate infra/service-env.ts for $svc $stage"; continue; }
    missing=$(comm -23 <(printf '%s\n' "$reads") <(printf '%s\n' "$provided"))
    if [ -z "$missing" ]; then
      ok "$svc on $stage: every variable the app reads is provided ($(grep -c . <<<"$reads") read)"
    else
      nok "$svc on $stage: the app reads variables infra does not provide" "$missing"
    fi
  done
  # Provided but not read yet: expected while tasks 4.x and 5.x are open.
  unread=$(comm -13 <(printf '%s\n' "$reads") <(infra_names "$svc" dev | sort -u) | paste -sd' ' -)
  [ -z "$unread" ] || note "$svc: provided, not read by apps/$svc yet: $unread"
done

echo "# pass $pass, fail $fail"
[ "$fail" -eq 0 ]
