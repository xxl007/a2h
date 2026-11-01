#!/usr/bin/env bash
# The sign-in allow-list of a stage (m1-hosted-connector design D7, group 8.3
# fact): add or remove addresses in the stage's SSM SecureString, keeping
# every other address, so the verify job can sign its two synthetic QA
# principals in on a preview (or dev) and take them out again when it ends.
#
# Usage: allowlist.sh name <stage>
#        allowlist.sh add    pr-<n> <address>[,<address>...]
#        allowlist.sh remove pr-<n> <address>[,<address>...]
#   `name` answers for dev and pr-<n>; prod is refused (QA never signs in on
#   prod). `add` and `remove` act on a preview's own parameter only: dev's
#   /a2h/shared/principal-allowlist and prod's are the owner's lists, which CI
#   reads and never writes (runbook aws-bootstrap.md §15; the dev verify job
#   signs in with the QA addresses the owner put there once).
#   The parameter is /a2h/shared/principal-allowlist for dev and
#   /a2h/pr-<n>/principal-allowlist for a preview (infra/config.ts
#   allowlistParameterName; tests/ci/workflows.test.mjs checks they agree).
# Behaviour:
#   add     fails if the parameter does not exist (the stage's deploy creates
#           it); writes only when the set changes; comparison is case-insensitive.
#   remove  a missing parameter (stage torn down) is a no-op; an empty result
#           is written as `none` (SSM refuses empty values; nobody may sign in).
# Output: counts only. Never an address, never the value (SecureString).
# Exit: 0 ok, 1 aws failure or missing parameter on add, 64 usage.
# Credentials: the stage's deploy role (AWS_REGION set by the workflow).
set -euo pipefail

NONE="none"

usage() {
  echo "usage: $0 name <dev|pr-<n>> | $0 add|remove pr-<n> <address>[,<address>...]" >&2
  exit 64
}

parameter_name() {
  case "$1" in
    dev) echo "/a2h/shared/principal-allowlist" ;;
    pr-[1-9]|pr-[1-9][0-9]|pr-[1-9][0-9][0-9]|pr-[1-9][0-9][0-9][0-9]|pr-[1-9][0-9][0-9][0-9][0-9]) echo "/a2h/$1/principal-allowlist" ;;
    prod) echo "prod has no QA sign-in: the owner sets /a2h/prod/principal-allowlist (runbook §15)" >&2; exit 64 ;;
    *) echo "not a stage: expected dev or pr-<n>" >&2; exit 64 ;;
  esac
}

# Splits a list value into lower-cased addresses, one per line, dropping `none`.
split_list() {
  tr -s ', \t\r\n' '\n' <<<"$1" | tr '[:upper:]' '[:lower:]' | grep -v '^$' | grep -vx "$NONE" || true
}

# Lines in a possibly empty value.
count_lines() {
  if [ -z "$1" ]; then echo 0; else wc -l <<<"$1" | tr -d ' '; fi
}

[ "$#" -ge 2 ] || usage
command=$1
stage=$2
name=$(parameter_name "$stage")

case "$command" in
  name)
    [ "$#" -eq 2 ] || usage
    echo "$name"
    exit 0 ;;
  add | remove)
    [ "$#" -eq 3 ] || usage
    case "$stage" in
      pr-*) ;;
      *) echo "allowlist: $command on $stage refused: CI writes a preview's own parameter only; $name is the owner's list (runbook aws-bootstrap.md §15)" >&2; exit 64 ;;
    esac
    ;;
  *) usage ;;
esac

given=$(split_list "$3")
[ -n "$given" ] || usage
while IFS= read -r a; do
  case "$a" in
    *@*.*) ;;
    *) echo "allowlist: not an address (no @): refusing" >&2; exit 64 ;;
  esac
done <<<"$given"
given_count=$(wc -l <<<"$given" | tr -d ' ')

# Read the current list. ParameterNotFound: add fails (the deploy creates the
# parameter), remove has nothing to do.
set +e
current_raw=$(aws ssm get-parameter --name "$name" --with-decryption --query Parameter.Value --output text 2>&1)
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  if [[ "$current_raw" == *ParameterNotFound* ]]; then
    if [ "$command" = add ]; then
      echo "allowlist: $name does not exist; the stage's deploy creates it (infra/allowlist.ts)" >&2
      exit 1
    fi
    echo "allowlist: $stage remove: the parameter does not exist; nothing to do"
    exit 0
  fi
  # The aws error names the parameter and the operation, never the value.
  echo "allowlist: reading $name failed: $current_raw" >&2
  exit 1
fi
current=$(split_list "$current_raw")
current_count=$(count_lines "$current")

if [ "$command" = add ]; then
  next=$(printf '%s\n%s\n' "$current" "$given" | grep -v '^$' | awk '!seen[$0]++')
else
  next=$(grep -vxF -f <(printf '%s\n' "$given") <<<"$current" || true)
fi
next=$(grep -v '^$' <<<"$next" || true)
next_count=$(count_lines "$next")

if [ "$next_count" -eq "$current_count" ]; then
  echo "allowlist: $stage $command: $given_count address(es) given; the list already holds $current_count; nothing written"
  exit 0
fi

if [ -z "$next" ]; then value=$NONE; else value=$(paste -sd, <<<"$next"); fi
set +e
put_out=$(aws ssm put-parameter --name "$name" --type SecureString --overwrite --value "$value" 2>&1 >/dev/null)
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  echo "allowlist: writing $name failed: $put_out" >&2
  exit 1
fi
echo "allowlist: $stage $command: $given_count address(es) given; the list held $current_count and now holds $next_count"
