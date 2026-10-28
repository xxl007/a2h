#!/usr/bin/env bash
# Apply the database migrations of a stage, then the simulated set off prod.
#
#   .github/scripts/db-migrate.sh dev | prod | pr-<n>
#
# Contract: openspec/changes/m1-protocol-connector/design.md D2 and D8,
# tasks.md 3.3. Runs in the deploy workflows after credentials and before
# `sst deploy`; on previews after `pr-schema.sh create <n>`.
#
# Target
#   dev      schema public of database a2h on the shared dev cluster.
#   pr-<n>   schema pr_<n> of the same database; every transaction starts with
#            SET LOCAL ROLE pr_<n>, so the preview login owns what it creates.
#   prod     schema public; the cluster and secret ARNs must be given in
#            A2H_DB_CLUSTER_ARN and A2H_DB_SECRET_ARN (prod's cluster has no
#            Data API today, infra/database.ts: decide before the first prod
#            deploy). The seed never runs on prod.
#   dev and pr-<n> read the ARNs from the SSM parameters
#   /a2h/shared/aurora-cluster-arn and /a2h/shared/aurora-secret-arn (as
#   pr-schema.sh does), unless A2H_DB_CLUSTER_ARN / A2H_DB_SECRET_ARN are set.
#
# Migrations
#   Files NNNN_*.sql in packages/db/migrations (DB_MIGRATE_DIR overrides),
#   in name order, statements separated by drizzle-kit's
#   "--> statement-breakpoint". Applied files are listed with their SHA-256 in
#   <schema>.schema_migrations (created by the first migration). Each pending
#   file runs in one Data API transaction: role, search_path, a check that the
#   search_path took, the file's statements, the ownership fallback (previews),
#   the tracking row, commit. Any error rolls the transaction back, so a failed
#   file leaves neither objects nor a tracking row, and the run stops there.
#   An applied file whose checksum changed stops the run before anything else:
#   migrations are forward-only; write a new file instead.
#
# Jobs schema (design D3)
#   dev and prod: CREATE SCHEMA IF NOT EXISTS pgboss before the migrations
#   (pg-boss runs with createSchema false). Previews: pr_<n>_jobs is created by
#   pr-schema.sh with the preview login as owner, not here.
#
# Ownership fallback (design D2, previews only)
#   If the Data API did not keep SET ROLE across the transaction's statements,
#   the objects would belong to the master user. Before commit, the script
#   counts objects in pr_<n> that pr_<n> does not own and, if any, reassigns
#   them with ALTER ... OWNER TO pr_<n> in the same transaction, and says so.
#
# Seed (dev and previews only)
#   packages/db/seed/seed.sql (DB_MIGRATE_SEED overrides) in one transaction
#   with a2h.stage set to the stage; the SQL refuses to run on prod or without
#   that setting. Upserts by handle: running it again leaves one copy.
#
# Every call goes through the RDS Data API (`aws rds-data`), one statement per
# call, SQL passed in a file, never on a command line. Calls that land while
# the dev cluster resumes from 0 ACU, or are throttled, are retried (default
# 12 attempts, 15 s apart). Credentials come from the environment (the OIDC
# deploy role in CI). Nothing secret is handled: the master secret is named by
# ARN only, and the Data API reads it.
set -euo pipefail
umask 077

DATABASE=a2h
SSM_CLUSTER_ARN=/a2h/shared/aurora-cluster-arn
SSM_SECRET_ARN=/a2h/shared/aurora-secret-arn
MAX_ATTEMPTS=${DB_MIGRATE_MAX_ATTEMPTS:-12}
RETRY_SLEEP=${DB_MIGRATE_RETRY_SLEEP:-15}
RETRYABLE='DatabaseResumingException|ThrottlingException|TooManyRequestsException|Rate exceeded'
BREAKPOINT='--> statement-breakpoint'

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MIGRATIONS_DIR=${DB_MIGRATE_DIR:-"$ROOT/packages/db/migrations"}
SEED_FILE=${DB_MIGRATE_SEED:-"$ROOT/packages/db/seed/seed.sql"}

usage() {
  echo "usage: $0 dev|prod|pr-<n>" >&2
  exit 64
}

[ "$#" -eq 1 ] || usage
stage=$1
role=""
case "$stage" in
  dev | prod) schema=public ;;
  pr-*)
    n=${stage#pr-}
    # Same rule as pr-schema.sh: a positive integer, no leading zero, at most 9 digits.
    [[ "$n" =~ ^[1-9][0-9]{0,8}$ ]] || usage
    schema="pr_${n}"
    role="pr_${n}"
    ;;
  *) usage ;;
esac

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "error: migrations directory $MIGRATIONS_DIR not found" >&2
  exit 1
fi
if [ "$stage" != prod ] && [ ! -f "$SEED_FILE" ]; then
  echo "error: seed file $SEED_FILE not found" >&2
  exit 1
fi
if [ "$stage" = prod ] && { [ -z "${A2H_DB_CLUSTER_ARN:-}" ] || [ -z "${A2H_DB_SECRET_ARN:-}" ]; }; then
  echo "error: prod needs A2H_DB_CLUSTER_ARN and A2H_DB_SECRET_ARN (prod's own cluster; /a2h/shared/ names dev's)" >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

ssm_param() {
  local name=$1 value
  value=$(aws ssm get-parameter --name "$name" --query Parameter.Value --output text)
  if [ -z "$value" ] || [ "$value" = "None" ]; then
    echo "error: SSM parameter $name is empty; has the dev stage been deployed? (docs/runbooks/aws-bootstrap.md §7)" >&2
    exit 1
  fi
  printf '%s' "$value"
}

# aws_retry <aws args...>: runs an aws call, retried while the cluster resumes
# or the API throttles. Prints the call's stdout; on final failure prints the
# error to stderr and returns 1.
aws_retry() {
  local out attempt=1
  while :; do
    if out=$(aws "$@" 2>&1); then
      printf '%s' "$out"
      return 0
    fi
    if [ "$attempt" -lt "$MAX_ATTEMPTS" ] && grep -Eq "$RETRYABLE" <<<"$out"; then
      echo "db-migrate: attempt $attempt/$MAX_ATTEMPTS: cluster resuming or throttled; retrying in ${RETRY_SLEEP}s" >&2
      sleep "$RETRY_SLEEP"
      attempt=$((attempt + 1))
      continue
    fi
    printf '%s\n' "$out" >&2
    return 1
  done
}

# execute <sql> [transaction-id] [json]: one statement through the Data API.
# With "json", prints the records as a JSON array (formatRecordsAs JSON).
execute() {
  local sql=$1 txid=${2:-} json=${3:-} out
  DB_MIGRATE_SQL=$sql jq -n \
    --arg resourceArn "$cluster_arn" --arg secretArn "$secret_arn" --arg database "$DATABASE" \
    --arg transactionId "$txid" --arg json "$json" \
    '{resourceArn: $resourceArn, secretArn: $secretArn, database: $database, sql: env.DB_MIGRATE_SQL}
     + (if $transactionId != "" then {transactionId: $transactionId} else {} end)
     + (if $json != "" then {formatRecordsAs: "JSON"} else {} end)' >"$tmp/statement.json"
  out=$(aws_retry rds-data execute-statement --cli-input-json "file://$tmp/statement.json") || return 1
  if [ -n "$json" ]; then jq -r '.formattedRecords // "[]"' <<<"$out"; fi
}

begin_tx() {
  aws_retry rds-data begin-transaction --resource-arn "$cluster_arn" --secret-arn "$secret_arn" \
    --database "$DATABASE" | jq -r .transactionId
}
commit_tx() {
  aws_retry rds-data commit-transaction --resource-arn "$cluster_arn" --secret-arn "$secret_arn" \
    --transaction-id "$1" >/dev/null
}
rollback_tx() {
  aws_retry rds-data rollback-transaction --resource-arn "$cluster_arn" --secret-arn "$secret_arn" \
    --transaction-id "$1" >/dev/null || echo "db-migrate: rollback of $1 failed; the Data API ends it on timeout" >&2
}

# statements_of <file>: writes each statement of the file to $tmp/stmt.<i>,
# split on drizzle-kit's breakpoint marker; sets $nstmt.
statements_of() {
  rm -f "$tmp"/stmt.*
  nstmt=$(awk -v dir="$tmp" -v bp="$BREAKPOINT" '
    BEGIN { i = 0; buf = "" }
    function flush() { if (buf ~ /[^[:space:]]/) { i++; printf "%s", buf > (dir "/stmt." i); close(dir "/stmt." i) } buf = "" }
    {
      line = $0
      while ((p = index(line, bp)) > 0) { buf = buf substr(line, 1, p - 1) "\n"; flush(); line = substr(line, p + length(bp)) }
      buf = buf line "\n"
    }
    END { flush(); print i }' "$1")
}

# Statements every transaction starts with: role (previews), search_path, and
# a check that the search_path is in force on this connection.
tx_prologue() {
  local txid=$1
  if [ -n "$role" ]; then execute "SET LOCAL ROLE ${role}" "$txid" || return 1; fi
  execute "SET LOCAL search_path = ${schema}" "$txid" || return 1
  execute "DO \$\$
BEGIN
  IF current_schema() IS DISTINCT FROM '${schema}' THEN
    RAISE EXCEPTION 'db-migrate: search_path did not take (current schema %, expected ${schema})', current_schema();
  END IF;
END
\$\$" "$txid"
}

# Objects in the preview schema that the preview login does not own.
NOT_OWNED="SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = '${schema}' AND c.relowner <> '${role:-x}'::regrole)
       + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = '${schema}' AND p.proowner <> '${role:-x}'::regrole)
       + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = '${schema}' AND t.typtype IN ('e', 'd', 'c', 'r') AND t.typrelid = 0
            AND t.typowner <> '${role:-x}'::regrole) AS n"

# Reassigns them (tables first: their indexes and identity sequences follow).
REASSIGN="DO \$\$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = '${schema}' AND c.relkind IN ('r', 'p', 'f', 'v', 'm')
             AND c.relowner <> '${role:-x}'::regrole LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO %I',
      CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      '${schema}', r.relname, '${role:-x}');
  END LOOP;
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = '${schema}' AND c.relkind = 'S' AND c.relowner <> '${role:-x}'::regrole LOOP
    EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO %I', '${schema}', r.relname, '${role:-x}');
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS sig, p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = '${schema}' AND p.proowner <> '${role:-x}'::regrole LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I', CASE r.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, r.sig, '${role:-x}');
  END LOOP;
  FOR r IN SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = '${schema}' AND t.typtype IN ('e', 'd', 'c', 'r') AND t.typrelid = 0
             AND t.typowner <> '${role:-x}'::regrole LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO %I', '${schema}', r.typname, '${role:-x}');
  END LOOP;
END
\$\$"

# ownership_fallback <txid>: previews only; no-op when SET ROLE held.
ownership_fallback() {
  local txid=$1 records count
  [ -n "$role" ] || return 0
  records=$(execute "$NOT_OWNED" "$txid" json) || return 1
  count=$(jq -r '.[0].n // 0' <<<"$records")
  if [ "$count" != 0 ]; then
    execute "$REASSIGN" "$txid" || return 1
    echo "db-migrate: SET ROLE ${role} was not kept by the Data API; fallback: reassigned ${count} object(s) to ${role} (design D2)"
  fi
}

# run_statements <label> <txid>: the statements split by statements_of, in order.
run_statements() {
  local label=$1 txid=$2 i
  for i in $(seq 1 "$nstmt"); do
    if ! execute "$(cat "$tmp/stmt.$i")" "$txid"; then
      echo "error: $label: statement $i of $nstmt failed" >&2
      return 1
    fi
  done
}

# run_file_tx <label> <file> <extra-sql-after-prologue> <tracking-sql>: one transaction.
run_file_tx() {
  local label=$1 file=$2 extra=$3 tracking=$4 txid
  statements_of "$file"
  txid=$(begin_tx) || { echo "error: $label: could not begin a transaction" >&2; return 1; }
  if ! {
    tx_prologue "$txid" &&
      { [ -z "$extra" ] || execute "$extra" "$txid"; } &&
      run_statements "$label" "$txid" &&
      ownership_fallback "$txid" &&
      { [ -z "$tracking" ] || execute "$tracking" "$txid"; } &&
      commit_tx "$txid"
  }; then
    rollback_tx "$txid"
    echo "error: $label failed; its transaction was rolled back, nothing of it is applied" >&2
    return 1
  fi
}

if [ -n "${A2H_DB_CLUSTER_ARN:-}" ] && [ -n "${A2H_DB_SECRET_ARN:-}" ]; then
  cluster_arn=$A2H_DB_CLUSTER_ARN
  secret_arn=$A2H_DB_SECRET_ARN
else
  cluster_arn=$(ssm_param "$SSM_CLUSTER_ARN")
  secret_arn=$(ssm_param "$SSM_SECRET_ARN")
fi

echo "db-migrate: stage $stage, schema $schema${role:+, role $role}, database $DATABASE"
echo "db-migrate: cluster $cluster_arn"

if [ -z "$role" ]; then
  execute "CREATE SCHEMA IF NOT EXISTS pgboss" || exit 1
  echo "db-migrate: jobs schema pgboss present"
fi

# Applied files and their checksums (none before the first migration ran).
applied="[]"
exists=$(execute "SELECT to_regclass('${schema}.schema_migrations') IS NOT NULL AS present" "" json) || exit 1
if [ "$(jq -r '.[0].present' <<<"$exists")" = true ]; then
  applied=$(execute "SELECT name, checksum FROM ${schema}.schema_migrations ORDER BY name" "" json) || exit 1
fi

mapfile -t files < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]_*.sql' -printf '%f\n' | LC_ALL=C sort)
if [ "${#files[@]}" -eq 0 ]; then
  echo "error: no migration files in $MIGRATIONS_DIR" >&2
  exit 1
fi

# Check every applied file first: a changed one stops the run before anything runs.
pending=()
for f in "${files[@]}"; do
  if ! [[ "$f" =~ ^[0-9]{4}_[a-z0-9_]+\.sql$ ]]; then
    echo "error: migration file name $f is not NNNN_lower_snake.sql" >&2
    exit 1
  fi
  sum=$(sha256sum "$MIGRATIONS_DIR/$f" | cut -d' ' -f1)
  recorded=$(jq -r --arg f "$f" '.[] | select(.name == $f) | .checksum' <<<"$applied")
  if [ -z "$recorded" ]; then
    pending+=("$f")
  elif [ "$recorded" != "$sum" ]; then
    echo "error: $f was applied with checksum $recorded but now has $sum; migrations are forward-only, add a new file" >&2
    exit 1
  fi
done

if [ "${#pending[@]}" -eq 0 ]; then
  echo "db-migrate: schema $schema is up to date (${#files[@]} file(s) applied)"
fi
for f in "${pending[@]}"; do
  sum=$(sha256sum "$MIGRATIONS_DIR/$f" | cut -d' ' -f1)
  run_file_tx "$f" "$MIGRATIONS_DIR/$f" "" \
    "INSERT INTO schema_migrations (name, checksum) VALUES ('${f}', '${sum}')" || exit 1
  echo "db-migrate: applied $f"
done

if [ "$stage" = prod ]; then
  echo "db-migrate: seed: skipped on prod (simulated participants never exist there)"
else
  run_file_tx "seed" "$SEED_FILE" "SELECT set_config('a2h.stage', '${stage}', true)" "" || exit 1
  echo "db-migrate: seed: applied the simulated set to $schema"
fi
echo "db-migrate: $stage done"
