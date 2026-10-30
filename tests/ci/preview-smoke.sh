#!/usr/bin/env bash
# Smoke check of a preview stage (or of dev) on the shared ALB, from any shell with curl.
# Usage: tests/ci/preview-smoke.sh <base-url>|<alb-dns> <pr-number>|dev
#   <base-url> is http(s)://<host>[:port], no path: the scheme and host of the
#   `mcp` deploy output, which is how deploy.yml and preview.yml call it.
#   e.g. tests/ci/preview-smoke.sh https://mcp.dev.a2h-protocol.org 12
#        tests/ci/preview-smoke.sh https://mcp.dev.a2h-protocol.org dev
#        tests/ci/preview-smoke.sh AlbLoadBalancer-xxxx.eu-west-3.elb.amazonaws.com dev
# Checks for a preview:
#   /pr-<n>/healthz  200  the preview's MCP task is up (listener rule + target healthy)
#   /healthz         200  the dev stage's health on the same ALB still answers
#   /pr-<n>/nope     404  from the app (the preview rule routes /pr-<n>/* to it),
#                         not the ALB's default 403 (Server: awselb/2.0), which
#                         would mean the listener rule is missing
# Checks for dev (deploy.yml, after each deploy from main):
#   /healthz         200  the dev stage's MCP task is up
# Over https, also (spec hosted-endpoint "HTTP redirected"):
#   http://<host><health path>  301 with Location the same URL over https
#                               (an explicit :443 is the same URL)
# Then prints the MCP Inspector command the owner runs (Gate 2, step 3).
# Env: A2H_SCHEME, used only with a bare host (default http). A scheme in
# <base-url> wins.
# Exit 0 only when every check passed. Spec: mcp-transport "Load balancer
# probes health"; preview-environments "PR opened", "Preview verified",
# "Merge to main verified".
set -euo pipefail

usage() {
  echo "usage: $0 <alb-dns> <pr-number>|dev" >&2
  exit 2
}

[ "$#" -eq 2 ] || usage
target="$1"
pr="$2"
if [[ "$target" =~ ^(https?)://([A-Za-z0-9.-]+(:[0-9]+)?)$ ]]; then
  scheme="${BASH_REMATCH[1]}"
  alb="${BASH_REMATCH[2]}"
elif [[ "$target" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  scheme="${A2H_SCHEME:-http}"
  alb="$target"
else
  echo "first argument must be http(s)://<host>[:port] or a host name (optionally :port), got '$target'" >&2
  usage
fi
[[ "$pr" =~ ^[1-9][0-9]*$ ]] || [ "$pr" = "dev" ] || { echo "second argument must be a positive PR number or 'dev', got '$pr'" >&2; usage; }
[ "$scheme" = "http" ] || [ "$scheme" = "https" ] || { echo "A2H_SCHEME must be http or https, got '$scheme'" >&2; usage; }
base="$scheme://$alb"
failures=0

# Prints "<status> <server header> <location header>" for a GET (no redirect
# followed), "-" for an absent header, or "000 - -" when unreachable.
probe() {
  local url="$1" headers status server location
  if ! headers="$(curl -sS -o /dev/null -D - --max-time 10 "$url" 2>/dev/null)"; then
    echo "000 - -"
    return
  fi
  status="$(printf '%s\n' "$headers" | awk 'toupper($1) ~ /^HTTP\// { code = $2 } END { print code }')"
  server="$(printf '%s\n' "$headers" | awk -F': *' 'tolower($1) == "server" { gsub(/\r/, "", $2); s = $2 } END { print (s == "" ? "-" : s) }')"
  location="$(printf '%s\n' "$headers" | awk 'tolower($1) == "location:" { gsub(/\r/, "", $2); l = $2 } END { print (l == "" ? "-" : l) }')"
  echo "${status:-000} $server $location"
}

check() {
  local label="$1" path="$2" want="$3" status server
  read -r status server _ < <(probe "$base$path")
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

# Plain HTTP must answer 301 to the same URL over HTTPS (":443" allowed:
# the ALB's redirect action writes the port it was given).
check_redirect() {
  local path="$1" status server location host="${alb%:443}"
  read -r status server location < <(probe "http://$host$path")
  if [ "$status" = "301" ] && { [ "$location" = "https://$host$path" ] || [ "$location" = "https://$host:443$path" ]; }; then
    echo "ok   HTTP redirected: GET http://$host$path -> 301 $location"
  else
    echo "FAIL HTTP redirected: GET http://$host$path -> $status (server: $server, location: $location), want 301 to https://$host$path"
    failures=$((failures + 1))
  fi
}

if [ "$pr" = "dev" ]; then
  check "dev health" "/healthz" 200
  prefix=""
  stage="dev"
else
  check "preview health" "/pr-$pr/healthz" 200
  check "dev health" "/healthz" 200
  check "preview routing" "/pr-$pr/nope" 404
  prefix="/pr-$pr"
  stage="pr-$pr"
fi
if [ "$scheme" = "https" ]; then
  check_redirect "$prefix/healthz"
fi

echo
echo "List the MCP tools of $stage (MCP Inspector CLI):"
echo "  npx -y @modelcontextprotocol/inspector --cli $base$prefix/mcp --method tools/list"
echo "Call ping:"
echo "  npx -y @modelcontextprotocol/inspector --cli $base$prefix/mcp --method tools/call --tool-name ping"

if [ "$failures" -gt 0 ]; then
  echo
  echo "$failures check(s) failed."
  exit 1
fi
