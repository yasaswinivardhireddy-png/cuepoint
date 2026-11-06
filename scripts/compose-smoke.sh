#!/usr/bin/env bash
# Smoke test for docker-compose.yml: starts the stack, signs in, requests an ad break, fires one
# impression beacon twice, waits for the worker to count it exactly once, and runs the report job.
# Needs docker (with compose), curl and jq.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE=http://localhost:8080
trap 'rc=$?; if [ "$rc" -ne 0 ]; then docker compose ps -a; docker compose logs --tail=60; fi; docker compose down -v --remove-orphans >/dev/null 2>&1 || true; exit "$rc"' EXIT

wait_for() {
  for _ in $(seq 1 120); do
    curl -fsS -o /dev/null "$1" && return 0
    sleep 2
  done
  echo "timed out waiting for $1" >&2
  return 1
}

docker compose up -d --build
wait_for "$BASE/api/readyz"
wait_for "$BASE/ads/readyz"

token=$(curl -fsS "$BASE/api/v1/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@cuepoint.dev","password":"cuepoint-demo"}' | jq -r .token)
delivered() { curl -fsS "$BASE/api/v1/campaigns" -H "authorization: Bearer $token" | jq '[.items[].deliveredToday] | add'; }

pod=$(curl -fsS "$BASE/ads/v1/pods?pod=60&genre=sports&device=ctv&country=IN&uid=compose-smoke")
echo "$pod" | jq '{filledSec, ads: [.ads[] | .campaignName]}'
beacon=$(echo "$pod" | jq -er '.ads[0].impressionUrl')

before=$(delivered)
for attempt in first replay; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$beacon")
  echo "$attempt beacon: HTTP $code"
  [ "$code" = 204 ] || exit 1
done
for _ in $(seq 1 60); do
  [ "$(delivered)" -gt "$before" ] && break
  sleep 2
done
sleep 10 # a double count would show up by now
after=$(delivered)
echo "delivered today: $before -> $after"
[ "$after" -eq $((before + 1)) ] || { echo "expected exactly one new impression" >&2; exit 1; }

docker compose --profile tools run --rm --no-deps report --day "$(date -u +%F)"
echo "compose smoke test passed"
