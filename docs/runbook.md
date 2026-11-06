# Cuepoint runbook

One entry per alert in [`deploy/observability/alerts.yaml`](../deploy/observability/alerts.yaml).
Every entry covers what the alert means, what to check first, and how to mitigate. Commands assume
`kubectl -n cuepoint`.

## AdDecisionLatencyHigh

**Meaning:** p99 for `GET /v1/pods` is above 50 ms. Video players give the ad call a short time
budget, so a slow decision becomes an empty ad break and lost revenue.

**Check:**
- Is the ad server CPU-bound? Check `kubectl top pods -l app.kubernetes.io/name=adserver` and whether the HPA is at `maxReplicas`.
- `adserver_catalog_campaigns`: a much larger snapshot makes each decision cost more.
- Valkey latency: frequency-cap lookups have a 100 ms timeout.

**Mitigate:**
- Raise the HPA's `maxReplicas`.
- If Valkey is slow, restart it. Caps reset, but ads keep serving.

## AdDecisionErrors

**Meaning:** More than 1% of ad break requests return 5xx.

**Check:**
- `kubectl logs deploy/adserver` for `level=ERROR`.
- `/readyz`: pods without a campaign snapshot report not ready.

**Mitigate:**
- Roll back the last deploy: `kubectl rollout undo deploy/adserver`.

## ImpressionEventsLost

**Meaning:** The ad server dropped impression events (buffer full) or failed to send them to SQS
after retries. Those impressions are never counted, so advertisers are under-billed and pacing
over-delivers.

**Check:**
- `adserver_events_failed_total` points to SQS errors or IAM; `adserver_events_dropped_total` points to sustained overload.
- Logs mentioning `publish`.

**Mitigate:**
- Fix the SQS or IAM issue.
- Add replicas or raise `EVENTS_WORKERS`.
- Dropped events can't be recovered, so record the window for billing.

## CampaignSnapshotStale

**Meaning:** An ad server hasn't fetched campaigns for over 60 s. It keeps serving the last
snapshot, so a paused or out-of-budget campaign may still serve.

**Check:**
- `adserver_catalog_sync_errors_total`.
- API health: `kubectl get pods -l app.kubernetes.io/name=api`.
- The `api-from-web-and-adserver` network policy.

**Mitigate:**
- Restore the API.
- Restart only the stale pods; the others keep serving.

## FrequencyCapStoreErrors

**Meaning:** Valkey calls are failing, so ads serve without frequency caps. Viewers see the same
ad more often.

**Check:**
- `kubectl get pods -l app.kubernetes.io/name=valkey`.
- Valkey memory against `maxmemory`.

**Mitigate:**
- Restart Valkey. Counters reset, which is acceptable because they expire daily anyway.
- Replayed beacons are still deduplicated, by the worker's conditional write in DynamoDB.

## FillRateLow

**Meaning:** Less than half of the requested ad break time is being filled.

**Check:**
- Campaigns may be paused, out of flight dates, or have hit their pacing allowance. The simulator's
  "why skipped" list explains each one.

**Mitigate:**
- Usually a business issue (not enough demand), not an outage. Tell ad operations.

## ImpressionCountingBehind

**Meaning:** Impressions are counted more than 5% slower than they arrive, or no worker is running.
Pacing reads delivered counts, so campaigns can over-deliver while counting lags.

**Check:**
- `kubectl get pods -l app.kubernetes.io/name=worker`.
- The SQS `ApproximateAgeOfOldestMessage` metric.
- DynamoDB throttling.

**Mitigate:**
- Scale the worker: `kubectl scale deploy/worker --replicas=4`. Conditional writes keep counts exactly-once with any number of consumers.

## WorkerBatchesFailing

**Meaning:** Batches fail to write to DynamoDB. They stay on the queue and are retried; after 3
receives they go to the dead-letter queue.

**Check:**
- Worker logs for the exception (IAM, throttling, schema).

**Mitigate:**
- Fix the cause, then redrive the dead-letter queue to the main queue. Redriven events are deduplicated.

## InvalidEventsDeadLettered

**Meaning:** Messages that are not valid impression events reached the queue. They go to the
dead-letter queue untouched.

**Check:**
- Inspect a message in the DLQ. A producer version mismatch is the usual cause.

**Mitigate:**
- Fix the producer. Redrive only after the worker can parse the messages.

## CampaignApiErrors

**Meaning:** More than 2% of campaign API requests fail. Ad operations can't edit campaigns, but
ads keep serving from the ad servers' snapshots.

**Check:**
- `kubectl logs deploy/api` for `unhandled error`.
- DynamoDB health.

**Mitigate:**
- Roll back the last deploy: `kubectl rollout undo deploy/api`.
