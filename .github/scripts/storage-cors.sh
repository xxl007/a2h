#!/usr/bin/env bash
# Does the uploads bucket let a browser on <web-origin> POST a file to it?
# (m2-attachments task 6.1.) The approval page uploads straight to the bucket
# with a presigned POST and an upload-progress listener, so the browser sends
# a CORS preflight first: OPTIONS with Origin and
# Access-Control-Request-Method: POST. This script sends that preflight and
# nothing else (no credentials, no object is written).
#
# The bucket's CORS, S3 → EventBridge and the GuardDuty scanner plan are all
# created by dev's stack (infra/storage.ts), which deploys from main only; a
# preview borrows dev's bucket and creates its own event rule and queue. So
# "allowed" means: this stage's uploads reach storage and their scan results
# can reach its worker. The verify jobs then require the file tests to run
# (A2H_E2E_REQUIRE_FILE_STORAGE=1, A2H_E2E_REQUIRE_FILE_CHECKS=1) instead of
# letting them skip.
#
# Usage: storage-cors.sh <bucket> <web-origin> [region]
# Prints one line. Exit 0: allowed. Exit 1: refused. Exit 2: usage or no answer.
set -euo pipefail

bucket="${1:-}"
origin="${2:-}"
region="${3:-eu-west-3}"
if [[ -z "$bucket" || ! "$origin" =~ ^https?://[^/]+$ ]]; then
  echo "usage: storage-cors.sh <bucket> <web-origin (scheme://host, no path)> [region]" >&2
  exit 2
fi
if [[ ! "$bucket" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]; then
  echo "storage-cors: not a bucket name" >&2
  exit 2
fi

url="https://${bucket}.s3.${region}.amazonaws.com/"
if ! headers=$(curl -sS -o /dev/null -D - --max-time 20 -X OPTIONS \
  -H "Origin: ${origin}" \
  -H "Access-Control-Request-Method: POST" \
  "$url" 2>/dev/null); then
  echo "storage-cors: no answer from the bucket's endpoint"
  exit 2
fi

status=$(printf '%s\n' "$headers" | awk 'toupper($1) ~ /^HTTP\// { code = $2 } END { print code }')
# A header's value: everything after the first colon (an origin has colons of its own).
header() { printf '%s\n' "$headers" | tr -d '\r' | awk -v name="$1" 'index($0, ":") { n = tolower(substr($0, 1, index($0, ":") - 1)); if (n == name) { v = substr($0, index($0, ":") + 1); sub(/^ +/, "", v); print v } }' | tail -n 1; }
allow_origin=$(header access-control-allow-origin)
allow_methods=$(header access-control-allow-methods)

if [[ "$status" == "200" && ( "$allow_origin" == "$origin" || "$allow_origin" == "*" ) && ",${allow_methods// /}," == *",POST,"* ]]; then
  echo "storage-cors: allowed (POST from ${origin})"
  exit 0
fi
echo "storage-cors: refused (HTTP ${status:-none}; POST from ${origin} is not in the bucket's CORS)"
exit 1
