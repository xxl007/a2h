# shellcheck shell=bash
# Synthetic fixture values for the tests/ci suites. Sourced, not executed.
# Nothing here is, or looks like, a credential literal: values are built at
# runtime so that secret scanners (GitGuardian) have nothing to match, and no
# JSON secret is ever written out by hand.

# fixture_token <tag> [length]: "fixture<tag>" padded with the tag's first
# character to <length> (default 32), cut to <length>. Alphanumeric, so it
# passes pr-schema.sh's ^[A-Za-z0-9]{32,}$ check at length >= 32.
fixture_token() {
  local tag=$1 len=${2:-32} s="fixture$1"
  while [ "${#s}" -lt "$len" ]; do s+=${tag:0:1}; done
  printf '%s' "${s:0:$len}"
}

# secret_json <username> <password>: the Secrets Manager value pr-schema.sh
# reads and writes, compact, as jq -c prints it.
secret_json() {
  jq -cn --arg u "$1" --arg p "$2" '{username: $u, password: $p}'
}
