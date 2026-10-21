#!/usr/bin/env bash
# Create or drop the Postgres schema of a pull-request preview stage.
#
#   .github/scripts/pr-schema.sh create <pr-number>   # CREATE SCHEMA IF NOT EXISTS pr_<n>
#   .github/scripts/pr-schema.sh drop   <pr-number>   # DROP SCHEMA IF EXISTS pr_<n> CASCADE
#
# Runs one statement through the RDS Data API on database `a2h` of the shared
# dev Aurora cluster, whose ARNs `dev` publishes as SSM parameters
# /a2h/shared/aurora-cluster-arn and /a2h/shared/aurora-secret-arn
# (contract: openspec/changes/m0-foundation/tasks.md, step 4).
#
# The dev cluster scales to 0 ACU when idle; a call that lands while it resumes
# fails with DatabaseResumingException. Those calls, and throttled ones, are
# retried (default 12 attempts, 15 s apart). Any other error fails at once.
# The Data API accepts one statement per call and no --schema parameter is passed.
#
# Credentials come from the environment (the OIDC role in CI). Never run with
# long-lived keys.
set -euo pipefail

DATABASE=a2h
MAX_ATTEMPTS=${PR_SCHEMA_MAX_ATTEMPTS:-12}
RETRY_SLEEP=${PR_SCHEMA_RETRY_SLEEP:-15}
RETRYABLE='DatabaseResumingException|ThrottlingException|TooManyRequestsException|Rate exceeded'

usage() {
  echo "usage: $0 create|drop <pr-number>" >&2
  exit 64
}

[ "$#" -eq 2 ] || usage
action=$1
pr=$2

# Validate before the number is interpolated into SQL: a positive integer,
# no leading zero (pr-7 must map to pr_7, never pr_007), at most 9 digits.
if ! [[ "$pr" =~ ^[1-9][0-9]{0,8}$ ]]; then
  echo "error: PR number must be a positive integer, got '$pr'" >&2
  exit 64
fi

schema="pr_${pr}"
case "$action" in
  create) sql="CREATE SCHEMA IF NOT EXISTS ${schema}" ;;
  drop) sql="DROP SCHEMA IF EXISTS ${schema} CASCADE" ;;
  *) usage ;;
esac

ssm_param() {
  local name=$1 value
  value=$(aws ssm get-parameter --name "$name" --query Parameter.Value --output text)
  if [ -z "$value" ] || [ "$value" = "None" ]; then
    echo "error: SSM parameter $name is empty; has the dev stage been deployed? (docs/runbooks/aws-bootstrap.md §7)" >&2
    exit 1
  fi
  printf '%s' "$value"
}

cluster_arn=$(ssm_param /a2h/shared/aurora-cluster-arn)
secret_arn=$(ssm_param /a2h/shared/aurora-secret-arn)

echo "pr-schema: $action schema $schema on database $DATABASE"
echo "pr-schema: cluster $cluster_arn"

attempt=1
while :; do
  if out=$(aws rds-data execute-statement \
      --resource-arn "$cluster_arn" \
      --secret-arn "$secret_arn" \
      --database "$DATABASE" \
      --sql "$sql" 2>&1); then
    echo "pr-schema: done: $sql (attempt $attempt)"
    exit 0
  fi
  if [ "$attempt" -lt "$MAX_ATTEMPTS" ] && grep -Eq "$RETRYABLE" <<<"$out"; then
    echo "pr-schema: attempt $attempt/$MAX_ATTEMPTS: cluster resuming or throttled; retrying in ${RETRY_SLEEP}s" >&2
    sleep "$RETRY_SLEEP"
    attempt=$((attempt + 1))
    continue
  fi
  echo "$out" >&2
  echo "error: '$sql' failed after $attempt attempt(s)" >&2
  exit 1
done
