#!/usr/bin/env bash
# Create or drop the database login, schemas and secret of a pull-request preview.
#
#   .github/scripts/pr-schema.sh create <pr-number>
#   .github/scripts/pr-schema.sh drop   <pr-number>
#
# Contract: openspec/changes/m0-foundation/tasks.md, step 4 and "Contract
# amendment 1" (per-PR database login, teardown order); the jobs schema:
# openspec/changes/m1-protocol-connector/design.md D3.
#
# The only secret this script touches is a2h/pr-<n>/db. The stage secrets
# a2h/pr-<n>/signing and a2h/pr-<n>/approval are SST resources of the preview
# (design D4 amendment), created and removed with the stage.
#
# create <n>
#   1. Reuses the Secrets Manager secret a2h/pr-<n>/db, or creates it with
#      {"username":"pr_<n>","password":<32 random alphanumerics>}.
#   2. Creates login role pr_<n> with that password, or updates its password.
#      Attributes are left at their defaults (no superuser, createdb, createrole,
#      replication): the master user may not even name SUPERUSER or REPLICATION.
#   3. Grants pr_<n> to the master user, which must be able to SET ROLE pr_<n>
#      to create a schema it owns (PostgreSQL 16+) and to drop that schema later.
#   4. CREATE SCHEMA IF NOT EXISTS pr_<n> AUTHORIZATION pr_<n> (Drizzle tables),
#      then pr_<n>_jobs AUTHORIZATION pr_<n> (pg-boss, design D3). The worker
#      names the jobs schema explicitly (DB_JOBS_SCHEMA); search_path stays pr_<n>.
#   5. Revokes CREATE and USAGE on schema public, and CONNECT on databases a2h
#      and postgres, from PUBLIC; grants CONNECT on a2h to pr_<n>. Databases are
#      cluster-wide objects, so the postgres REVOKE is valid while connected to
#      a2h; it needs the master user to own database postgres, as on Aurora/RDS
#      (a non-owner's REVOKE is a silent no-op, so a following statement fails
#      the run if PUBLIC can still connect to postgres).
#      Any future role that must reach database postgres (for example a
#      read-only MCP or debugging role) must be granted CONNECT on it explicitly.
#   6. ALTER ROLE pr_<n> SET search_path = pr_<n>.
#
# drop <n> (run after `sst remove`, so nothing should still be connected)
#   1. Disables login for pr_<n> so nothing reconnects, and grants it to the
#      master user (covers a role created without step 3).
#   2. Terminates the remaining pr_<n> sessions.
#   3. DROP SCHEMA IF EXISTS pr_<n> CASCADE, then pr_<n>_jobs.
#   4. DROP OWNED BY pr_<n> (revokes its CONNECT grant, which would block step 5).
#   5. DROP ROLE IF EXISTS pr_<n>.
#   6. Deletes the secret without recovery; an absent secret is success.
#
# Every statement is idempotent and goes alone through the RDS Data API on
# database a2h of the shared dev Aurora cluster (one statement per call, no
# --schema parameter). The cluster and master-secret ARNs come from the SSM
# parameters /a2h/shared/aurora-cluster-arn and /a2h/shared/aurora-secret-arn,
# which dev publishes (infra/config.ts SHARED_PARAMETERS; checked by
# tests/ci/infra-consistency.test.sh).
#
# The password never reaches a command line, stdout or stderr: statements and
# the secret value are passed through files in a private temp directory, error
# messages are redacted, and in GitHub Actions the value is masked with
# ::add-mask:: before anything else could print it.
#
# The dev cluster scales to 0 ACU when idle; a call that lands while it resumes
# fails with DatabaseResumingException. Those calls, and throttled ones, are
# retried (default 12 attempts, 15 s apart). Any other error fails at once.
#
# Credentials come from the environment (the OIDC preview role in CI). Never run
# with long-lived keys.
set -euo pipefail
umask 077

DATABASE=a2h
SSM_CLUSTER_ARN=/a2h/shared/aurora-cluster-arn
SSM_SECRET_ARN=/a2h/shared/aurora-secret-arn
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
case "$action" in create | drop) ;; *) usage ;; esac

# Validate before the number is interpolated into SQL or names: a positive
# integer, no leading zero (pr-7 must map to pr_7, never pr_007), at most 9 digits.
if ! [[ "$pr" =~ ^[1-9][0-9]{0,8}$ ]]; then
  echo "error: PR number must be a positive integer, got '$pr'" >&2
  exit 64
fi

role="pr_${pr}"
schema="pr_${pr}"
jobs_schema="pr_${pr}_jobs"
secret_id="a2h/pr-${pr}/db"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
password=""

# Replace the password by *** in text about to be printed.
redact() {
  local text=$1
  if [ -n "$password" ]; then text=${text//"$password"/***}; fi
  printf '%s' "$text"
}

# Register the password with the GitHub Actions log masker. This line is the
# only output that ever contains it, and the runner does not display it.
mask_password() {
  if [ -n "${GITHUB_ACTIONS:-}" ] && [ -n "$password" ]; then
    echo "::add-mask::$password"
  fi
}

# Only the alphabet --exclude-punctuation produces, so the value is safe inside
# a single-quoted SQL literal. A reused secret is held to the same rule.
check_password() {
  if ! [[ "$password" =~ ^[A-Za-z0-9]{32,}$ ]]; then
    password=""
    echo "error: secret $secret_id does not hold an alphanumeric password of at least 32 characters" >&2
    exit 1
  fi
}

ssm_param() {
  local name=$1 value
  value=$(aws ssm get-parameter --name "$name" --query Parameter.Value --output text)
  if [ -z "$value" ] || [ "$value" = "None" ]; then
    echo "error: SSM parameter $name is empty; has the dev stage been deployed? (docs/runbooks/aws-bootstrap.md §7)" >&2
    exit 1
  fi
  printf '%s' "$value"
}

# Sets $password from the existing secret. Returns 1 if the secret does not exist.
read_secret() {
  local value username
  if ! value=$(aws secretsmanager get-secret-value --secret-id "$secret_id" \
      --query SecretString --output text 2>"$tmp/err"); then
    if grep -q 'ResourceNotFoundException' "$tmp/err"; then return 1; fi
    cat "$tmp/err" >&2
    echo "error: could not read secret $secret_id" >&2
    exit 1
  fi
  password=$(printf '%s' "$value" | jq -r '.password // empty' 2>/dev/null) || password=""
  mask_password
  username=$(printf '%s' "$value" | jq -r '.username // empty' 2>/dev/null) || username=""
  if [ "$username" != "$role" ]; then
    password=""
    echo "error: secret $secret_id does not hold username $role" >&2
    exit 1
  fi
  check_password
}

# Creates the secret with a fresh random password and sets $password.
create_secret() {
  password=$(aws secretsmanager get-random-password --exclude-punctuation \
    --password-length 32 --query RandomPassword --output text)
  mask_password
  check_password
  PR_SCHEMA_PASSWORD=$password jq -n --arg username "$role" \
    '{username: $username, password: env.PR_SCHEMA_PASSWORD}' >"$tmp/secret.json"
  if ! aws secretsmanager create-secret --name "$secret_id" \
      --description "Database login of preview stage pr-${pr} (pr-schema.sh)" \
      --secret-string "file://$tmp/secret.json" >/dev/null 2>"$tmp/err"; then
    rm -f "$tmp/secret.json"
    if grep -q 'ResourceExistsException' "$tmp/err"; then
      # Created concurrently: use the stored value, not ours.
      password=""
      if read_secret; then return 0; fi
    fi
    redact "$(cat "$tmp/err")" >&2
    echo >&2
    echo "error: could not create secret $secret_id" >&2
    exit 1
  fi
  rm -f "$tmp/secret.json"
}

# run_sql <sql>: one statement through the Data API, retried while the cluster
# resumes or the API throttles. The statement is passed in a file so that the
# password is never on a command line; anything printed is redacted.
run_sql() {
  local sql=$1 out attempt=1 shown
  shown=$(redact "$sql" | tr '\n' ' ' | tr -s ' ')
  PR_SCHEMA_SQL=$sql jq -n \
    --arg resourceArn "$cluster_arn" --arg secretArn "$secret_arn" --arg database "$DATABASE" \
    '{resourceArn: $resourceArn, secretArn: $secretArn, database: $database, sql: env.PR_SCHEMA_SQL}' \
    >"$tmp/statement.json"
  while :; do
    if out=$(aws rds-data execute-statement --cli-input-json "file://$tmp/statement.json" 2>&1); then
      echo "pr-schema: ok: $shown (attempt $attempt)"
      rm -f "$tmp/statement.json"
      return 0
    fi
    if [ "$attempt" -lt "$MAX_ATTEMPTS" ] && grep -Eq "$RETRYABLE" <<<"$out"; then
      echo "pr-schema: attempt $attempt/$MAX_ATTEMPTS: cluster resuming or throttled; retrying in ${RETRY_SLEEP}s" >&2
      sleep "$RETRY_SLEEP"
      attempt=$((attempt + 1))
      continue
    fi
    rm -f "$tmp/statement.json"
    redact "$out" >&2
    echo >&2
    echo "error: '$shown' failed after $attempt attempt(s)" >&2
    exit 1
  done
}

role_exists="SELECT FROM pg_catalog.pg_roles WHERE rolname = '${role}'"

cluster_arn=$(ssm_param "$SSM_CLUSTER_ARN")
secret_arn=$(ssm_param "$SSM_SECRET_ARN")

echo "pr-schema: $action role $role, schemas $schema and $jobs_schema, secret $secret_id, database $DATABASE"
echo "pr-schema: cluster $cluster_arn"

case "$action" in
  create)
    if read_secret; then
      echo "pr-schema: reusing secret $secret_id"
    else
      create_secret
      echo "pr-schema: created secret $secret_id"
    fi

    run_sql "DO \$\$
BEGIN
  IF EXISTS (${role_exists}) THEN
    ALTER ROLE ${role} WITH LOGIN PASSWORD '${password}';
  ELSE
    CREATE ROLE ${role} WITH LOGIN PASSWORD '${password}';
  END IF;
END
\$\$"
    run_sql "GRANT ${role} TO CURRENT_USER"
    run_sql "CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION ${role}"
    run_sql "CREATE SCHEMA IF NOT EXISTS ${jobs_schema} AUTHORIZATION ${role}"
    run_sql "REVOKE CREATE, USAGE ON SCHEMA public FROM PUBLIC"
    run_sql "REVOKE CONNECT ON DATABASE ${DATABASE} FROM PUBLIC"
    # Its own call, still on database a2h. A future read-only role (MCP,
    # debugging) that needs database postgres must be granted CONNECT explicitly.
    run_sql "REVOKE CONNECT ON DATABASE postgres FROM PUBLIC"
    # A REVOKE by a non-owner only warns and changes nothing: fail instead of
    # leaving database postgres open to every login.
    run_sql "DO \$\$
BEGIN
  IF has_database_privilege('public', 'postgres', 'CONNECT') THEN
    RAISE EXCEPTION 'PUBLIC still has CONNECT on database postgres: the master user must own it';
  END IF;
END
\$\$"
    run_sql "GRANT CONNECT ON DATABASE ${DATABASE} TO ${role}"
    run_sql "ALTER ROLE ${role} SET search_path = ${schema}"
    ;;

  drop)
    run_sql "DO \$\$
BEGIN
  IF EXISTS (${role_exists}) THEN
    ALTER ROLE ${role} WITH NOLOGIN;
    GRANT ${role} TO CURRENT_USER;
  END IF;
END
\$\$"
    run_sql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${role}'"
    run_sql "DROP SCHEMA IF EXISTS ${schema} CASCADE"
    run_sql "DROP SCHEMA IF EXISTS ${jobs_schema} CASCADE"
    run_sql "DO \$\$
BEGIN
  IF EXISTS (${role_exists}) THEN
    DROP OWNED BY ${role};
  END IF;
END
\$\$"
    run_sql "DROP ROLE IF EXISTS ${role}"

    if out=$(aws secretsmanager delete-secret --secret-id "$secret_id" --force-delete-without-recovery 2>&1); then
      echo "pr-schema: deleted secret $secret_id"
    elif grep -q 'ResourceNotFoundException' <<<"$out"; then
      echo "pr-schema: secret $secret_id already absent"
    else
      echo "$out" >&2
      echo "error: could not delete secret $secret_id" >&2
      exit 1
    fi
    ;;
esac

echo "pr-schema: $action $schema done"
