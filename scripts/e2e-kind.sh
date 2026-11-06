#!/usr/bin/env bash
# End-to-end test on Kubernetes. Builds the four images, starts a kind cluster with moto standing in
# for AWS, creates the AWS resources with the real Terraform, deploys the kind overlay, then runs:
#   1. the Playwright browser tests, with axe accessibility checks on every page;
#   2. a load test of ad decisions through the nginx edge;
#   3. a counting-accuracy test: N impression beacons, each fired twice, must count exactly N;
#   4. the daily report CronJob, checking that the CSV it writes to S3 matches the API's totals.
# Results go to $OUT (default e2e-out) and, in GitHub Actions, to the job summary.
#
# Needs docker (with compose), kind, kubectl, terraform, jq, and web/ dependencies with Playwright's
# Chromium installed (cd web && npm ci && npx playwright install chromium).
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=cuepoint
OUT=${OUT:-e2e-out}
LOAD_DURATION=${LOAD_DURATION:-30s}
LOAD_CONCURRENCY=${LOAD_CONCURRENCY:-32}
ACCURACY_IMPRESSIONS=${ACCURACY_IMPRESSIONS:-1000}
BASE=http://localhost:8080
BUCKET=cuepoint-local-delivery-reports-123456789012

mkdir -p "$OUT/screenshots"
OUT=$(cd "$OUT" && pwd)
SUMMARY="$OUT/summary.md"
: >"$SUMMARY"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '%s\n' "$*" >>"$SUMMARY"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

wait_for() {
  for _ in $(seq 1 90); do
    curl -fsS -o /dev/null "$1" && return 0
    sleep 2
  done
  fail "timed out waiting for $1"
}

diagnose() {
  {
    kubectl get pods -A -o wide
    kubectl get events -A --sort-by=.lastTimestamp | tail -n 60
    echo "--- logs: moto"
    kubectl -n cuepoint-aws logs deploy/moto --tail=60 --all-containers
    kubectl -n cuepoint-aws logs deploy/moto --tail=60 --all-containers --previous
    for d in api adserver worker web valkey; do
      echo "--- logs: $d"
      kubectl -n cuepoint logs "deploy/$d" --tail=100 --all-containers
    done
  } >"$OUT/diagnostics.txt" 2>&1 || true
  echo "Cluster state written to $OUT/diagnostics.txt" >&2
}
trap 'rc=$?; [ "$rc" -eq 0 ] || diagnose; exit "$rc"' EXIT

# The ad server image also contains the load generator. Host networking lets it reach the edge on
# localhost, where the beacon URLs in ad responses point.
loadgen() {
  docker run --rm --network host --user "$(id -u):$(id -g)" -v "$OUT:/out" --entrypoint /loadgen cuepoint/adserver:local "$@"
}

# Runs Python with boto3 against the emulator (SSE-KMS objects need signed requests, so no curl).
aws_python() {
  docker run --rm -i --network host -e AWS_ENDPOINT_URL=http://localhost:5000 -e AWS_ACCESS_KEY_ID=local \
    -e AWS_SECRET_ACCESS_KEY=local -e AWS_DEFAULT_REGION=ap-south-1 --entrypoint python cuepoint/reporting:local "$@"
}

step "Building images"
docker compose build api adserver worker web

step "Creating the kind cluster"
if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --config deploy/kind/cluster.yaml --wait 120s
fi
kind load docker-image --name "$CLUSTER" cuepoint/api:local cuepoint/adserver:local cuepoint/reporting:local cuepoint/web:local

step "Starting the AWS emulator (moto)"
kubectl apply -f deploy/kind/aws-emulator.yaml
kubectl -n cuepoint-aws rollout status deploy/moto --timeout=180s
wait_for http://localhost:5000/moto-api/

step "Creating the AWS resources with Terraform"
export AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local
terraform -chdir=infra/terraform init -input=false
terraform -chdir=infra/terraform apply -input=false -auto-approve -var-file=environments/local.tfvars -state="$OUT/terraform.tfstate"

step "Deploying Cuepoint"
SECRETS=deploy/k8s/overlays/kind/secrets.env
if [ ! -f "$SECRETS" ]; then
  (
    umask 077
    printf 'JWT_SECRET=%s\nINTERNAL_API_TOKEN=%s\nBEACON_SECRET=%s\nDEMO_PASSWORD=%s\n' \
      "$(openssl rand -hex 32)" "$(openssl rand -hex 24)" "$(openssl rand -hex 32)" "${DEMO_PASSWORD:-cuepoint-demo}" >"$SECRETS"
  )
fi
DEMO_PASSWORD=$(sed -n 's/^DEMO_PASSWORD=//p' "$SECRETS")
export DEMO_PASSWORD
kubectl apply -k deploy/k8s/overlays/kind
for d in valkey api adserver worker web; do
  kubectl -n cuepoint rollout status "deploy/$d" --timeout=300s
done
wait_for "$BASE/"
wait_for "$BASE/api/readyz"
wait_for "$BASE/ads/readyz"
kubectl -n cuepoint get pods -o wide

note "## End-to-end on Kubernetes (kind)"
note ""
note "Runner: $(nproc) CPUs, $(awk '/MemTotal/ {printf "%.0f GB", $2/1048576}' /proc/meminfo) RAM. Kubernetes $(kubectl version -o json | jq -r .serverVersion.gitVersion), all pods under the restricted Pod Security Standard with network policies enforced."
note ""

step "Browser tests (Playwright + axe)"
(cd web && BASE_URL=$BASE SCREENSHOT_DIR="$OUT/screenshots" npx playwright test)
note "- Browser tests (Playwright, with axe WCAG 2.1 AA checks): passed"

step "Load test: ad decisions through the nginx edge"
loadgen -url "$BASE/ads" -c "$LOAD_CONCURRENCY" -d "$LOAD_DURATION" -impressions 0 -out /out/load.json | tee "$OUT/load.md"
note ""
note "### Ad decision load test ($LOAD_CONCURRENCY concurrent clients, $LOAD_DURATION, through nginx)"
note ""
cat "$OUT/load.md" >>"$SUMMARY"

step "Counting accuracy: $ACCURACY_IMPRESSIONS impressions, each fired twice"
token=$(curl -fsS "$BASE/api/v1/auth/login" -H 'content-type: application/json' \
  -d "$(jq -n --arg p "$DEMO_PASSWORD" '{email: "admin@cuepoint.dev", password: $p}')" | jq -r .token)
delivered() { curl -fsS "$BASE/api/v1/campaigns" -H "authorization: Bearer $token" | jq '[.items[].deliveredToday] | add'; }
# Wait for earlier impressions (from the browser tests) to finish counting.
settled() {
  local last=-1 now stable=0
  for _ in $(seq 1 60); do
    now=$(delivered)
    if [ "$now" = "$last" ]; then stable=$((stable + 1)); else stable=0; fi
    [ "$stable" -ge 3 ] && break
    last=$now
    sleep 5
  done
  echo "$now"
}
before=$(settled)
loadgen -url "$BASE/ads" -c 8 -d 20s -impressions 1 -max-beacons "$ACCURACY_IMPRESSIONS" -replay -out /out/accuracy.json | tee "$OUT/accuracy.md"
accepted=$(jq .beaconsAccepted "$OUT/accuracy.json")
replays=$(jq .replays "$OUT/accuracy.json")
expected=$((before + accepted))
for _ in $(seq 1 100); do
  [ "$(delivered)" -ge "$expected" ] && break
  sleep 3
done
sleep 15 # anything counted twice would show up by now
after=$(delivered)
counted=$((after - before))
note ""
note "### Counting accuracy"
note ""
note "| Unique impressions accepted | Replays fired | Counted | Missing | Double-counted |"
note "|---|---|---|---|---|"
note "| $accepted | $replays | $counted | $((counted < accepted ? accepted - counted : 0)) | $((counted > accepted ? counted - accepted : 0)) |"
[ "$counted" -eq "$accepted" ] || fail "counted $counted impressions, expected exactly $accepted"

step "Daily report CronJob"
day=$(date -u +%F)
kubectl -n cuepoint delete job report-e2e --ignore-not-found
kubectl -n cuepoint create job report-e2e --from=cronjob/report --dry-run=client -o json |
  jq --arg day "$day" '.spec.template.spec.containers[0].env += [{name: "REPORT_DAY", value: $day}]' |
  kubectl apply -f -
kubectl -n cuepoint wait --for=condition=complete job/report-e2e --timeout=180s
kubectl -n cuepoint logs job/report-e2e | tee "$OUT/report.md"
aws_python -c 'import boto3, sys
o = boto3.client("s3").get_object(Bucket=sys.argv[1], Key=sys.argv[2])
print("encryption:", o["ServerSideEncryption"], file=sys.stderr)
sys.stdout.write(o["Body"].read().decode())' "$BUCKET" "reports/$day/delivery.csv" >"$OUT/delivery-report.csv"
report_total=$(aws_python -c 'import csv, sys; print(sum(int(r["delivered"]) for r in csv.DictReader(sys.stdin)))' <"$OUT/delivery-report.csv")
note ""
note "- Daily report: s3://$BUCKET/reports/$day/delivery.csv, SSE-KMS, $(($(wc -l <"$OUT/delivery-report.csv") - 1)) campaigns, $report_total impressions (API: $after)"
[ "$report_total" -eq "$after" ] || fail "report total $report_total does not match the API's $after"

step "Done"
cat "$SUMMARY"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat "$SUMMARY" >>"$GITHUB_STEP_SUMMARY"; fi
