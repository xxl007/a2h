#!/usr/bin/env bash
# Smoke check of a preview stage on the shared ALB, from any shell with curl.
# Usage: tests/ci/preview-smoke.sh <alb-dns> <pr-number>
#   e.g. tests/ci/preview-smoke.sh AlbLoadBalancer-xxxx.eu-west-3.elb.amazonaws.com 12
# Checks:
#   /pr-<n>/healthz  200  the preview's MCP task is up (listener rule + target healthy)
#   /healthz         200  the dev stage's health on the same ALB still answers
#   /pr-<n>/nope     404  from the app (the preview rule routes /pr-<n>/* to it),
#                         not the ALB's default 403 (Server: awselb/2.0), which
#                         would mean the listener rule is missing
# Then prints the MCP Inspector command the owner runs (Gate 2, step 3).
# Env: A2H_SCHEME (default http; https once a domain is set).
# Exit 0 only when every check passed. Spec: mcp-transport "Load balancer
# probes health"; preview-environments "PR opened".
set -euo pipefail

usage() {
  echo "usage: $0 <alb-dns> <pr-number>" >&2
  exit 2
}

[ "$#" -eq 2 ] || usage
alb="$1"
pr="$2"
[[ "$alb" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || { echo "alb-dns must be a host name (optionally :port), got '$alb'" >&2; usage; }
[[ "$pr" =~ ^[1-9][0-9]*$ ]] || { echo "pr-number must be a positive integer, got '$pr'" >&2; usage; }
scheme="${A2H_SCHEME:-http}"
base="$scheme://$alb"
failures=0

# Prints "<status> <server header>" for a GET, or "000 -" when unreachable.
probe() {
  local url="$1" headers status server
  if ! headers="$(curl -sS -o /dev/null -D - --max-time 10 "$url" 2>/dev/null)"; then
    echo "000 -"
    return
  fi
  status="$(printf '%s\n' "$headers" | awk 'toupper($1) ~ /^HTTP\// { code = $2 } END { print code }')"
  server="$(printf '%s\n' "$headers" | awk -F': *' 'tolower($1) == "server" { gsub(/\r/, "", $2); s = $2 } END { print (s == "" ? "-" : s) }')"
  echo "${status:-000} $server"
}

check() {
  local label="$1" path="$2" want="$3" status server
  read -r status server < <(probe "$base$path")
  if [ "$status" != "$want" ]; then
    echo "FAIL $label: GET $path -> $status (server: $server), want $want"
    failures=$((failures + 1))
  elif [ "$want" = "404" ] && [[ "$server" == awselb* ]]; then
    echo "FAIL $label: GET $path -> 404 from the ALB (server: $server), want the app's 404"
    failures=$((failures + 1))
  else
    echo "ok   $label: GET $path -> $status (server: $server)"
  fi
}

check "preview health" "/pr-$pr/healthz" 200
check "dev health" "/healthz" 200
check "preview routing" "/pr-$pr/nope" 404

echo
echo "List the MCP tools of pr-$pr (MCP Inspector CLI):"
echo "  npx -y @modelcontextprotocol/inspector --cli $base/pr-$pr/mcp --method tools/list"
echo "Call ping:"
echo "  npx -y @modelcontextprotocol/inspector --cli $base/pr-$pr/mcp --method tools/call --tool-name ping"

if [ "$failures" -gt 0 ]; then
  echo
  echo "$failures check(s) failed."
  exit 1
fi
