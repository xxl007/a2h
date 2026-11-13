#!/usr/bin/env bash
# Starts the pinned Keycloak with the a2h-test realm imported, on a random
# port of 127.0.0.1, waits for the realm's discovery document and prints
#   KEYCLOAK_CONTAINER=<name>
#   KEYCLOAK_URL=http://127.0.0.1:<port>
# Stop it with: docker rm -f -v <name>   (never prune).
set -euo pipefail
IMAGE="${A2H_KEYCLOAK_IMAGE:-quay.io/keycloak/keycloak:26.8.2@sha256:723b1d6e254c0fc96d5cffec860c7e0744d6a3277822b865bb538cf891575e41}"
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="${1:-a2h-keycloak-test-$$-$(date +%s)}"
docker run -d --name "$NAME" \
  -p 127.0.0.1::8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin-local-only \
  -v "$HERE/a2h-test-realm.json:/opt/keycloak/data/import/a2h-test-realm.json:ro" \
  "$IMAGE" start-dev --import-realm >/dev/null
PORT="$(docker port "$NAME" 8080/tcp | head -1 | sed 's/.*://')"
URL="http://127.0.0.1:$PORT"
for _ in $(seq 1 180); do
  if curl -fsS "$URL/realms/a2h-test/.well-known/openid-configuration" >/dev/null 2>&1; then
    echo "KEYCLOAK_CONTAINER=$NAME"
    echo "KEYCLOAK_URL=$URL"
    exit 0
  fi
  sleep 1
done
echo "keycloak did not become ready" >&2
docker logs --tail 30 "$NAME" >&2 || true
docker rm -f -v "$NAME" >/dev/null 2>&1 || true
exit 1
