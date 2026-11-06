"""Consumes impression events from SQS and counts them with the Aggregator.

A message is deleted only after its event is safely counted (or recognised as a duplicate). Malformed
messages are left alone: SQS redelivers them and, after the queue's maxReceiveCount, moves them to the
dead-letter queue for inspection instead of blocking the pipeline.
"""

from __future__ import annotations

import logging
import signal
import threading
from dataclasses import dataclass, field
from typing import Any

import boto3
from prometheus_client import Counter, start_http_server

from .aggregator import Aggregator, Impression, InvalidEvent, parse_event
from .config import Settings

log = logging.getLogger("cuepoint.worker")

COUNTED = Counter("worker_events_counted_total", "Impressions added to delivery totals.")
DUPLICATES = Counter("worker_events_duplicate_total", "Events skipped because they were already counted.")
INVALID = Counter(
    "worker_messages_invalid_total", "Messages that cannot be processed; they go to the dead-letter queue."
)
FAILED = Counter("worker_batches_failed_total", "Batches left on the queue after an error, to be retried.")


@dataclass
class PollResult:
    received: int = 0
    counted: int = 0
    duplicates: int = 0
    invalid: int = 0
    deleted: list[str] = field(default_factory=list)


class Worker:
    def __init__(self, sqs: Any, aggregator: Aggregator, queue_url: str, wait_seconds: int = 10):
        self.sqs = sqs
        self.aggregator = aggregator
        self.queue_url = queue_url
        self.wait_seconds = wait_seconds

    def poll_once(self) -> PollResult:
        response = self.sqs.receive_message(
            QueueUrl=self.queue_url,
            MaxNumberOfMessages=10,
            WaitTimeSeconds=self.wait_seconds,
            MessageSystemAttributeNames=["ApproximateReceiveCount"],
        )
        messages = response.get("Messages", [])
        result = PollResult(received=len(messages))
        valid: list[tuple[dict[str, Any], Impression]] = []
        for message in messages:
            try:
                valid.append((message, parse_event(message["Body"])))
            except InvalidEvent as err:
                result.invalid += 1
                INVALID.inc()
                log.warning(
                    "invalid message %s (receive %s): %s",
                    message["MessageId"],
                    message.get("Attributes", {}).get("ApproximateReceiveCount", "?"),
                    err,
                )
        if not valid:
            return result
        try:
            counted = self.aggregator.count([event for _, event in valid])
        except Exception:
            FAILED.inc()
            log.exception("could not count %d events; they stay queued for retry", len(valid))
            return result
        result.counted, result.duplicates = counted.counted, counted.duplicates
        COUNTED.inc(counted.counted)
        DUPLICATES.inc(counted.duplicates)
        entries = [{"Id": str(i), "ReceiptHandle": m["ReceiptHandle"]} for i, (m, _) in enumerate(valid)]
        response = self.sqs.delete_message_batch(QueueUrl=self.queue_url, Entries=entries)
        for failure in response.get("Failed", []):
            # Not fatal: the message comes back and is recognised as a duplicate.
            log.warning("could not delete message %s: %s", failure.get("Id"), failure.get("Message"))
        result.deleted = [m["MessageId"] for m, _ in valid]
        return result

    def run(self, stop: threading.Event) -> None:
        log.info("consuming %s", self.queue_url)
        while not stop.is_set():
            try:
                result = self.poll_once()
                if result.received:
                    log.info(
                        "batch: %d received, %d counted, %d duplicates, %d invalid",
                        result.received,
                        result.counted,
                        result.duplicates,
                        result.invalid,
                    )
            except Exception:
                FAILED.inc()
                log.exception("poll failed; retrying")
                stop.wait(2)
        log.info("stopped")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format='{"time":"%(asctime)s","level":"%(levelname)s","msg":"%(message)s"}')
    settings = Settings.from_env()
    if not settings.queue_url:
        raise SystemExit("EVENTS_QUEUE_URL must be set")
    start_http_server(settings.metrics_port)
    aggregator = Aggregator(
        boto3.client("dynamodb"), settings.delivery_table, settings.processed_table, settings.processed_ttl_days
    )
    worker = Worker(boto3.client("sqs"), aggregator, settings.queue_url, settings.wait_seconds)
    stop = threading.Event()
    # Kubernetes sends SIGTERM; finish the current batch, then exit.
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    worker.run(stop)


if __name__ == "__main__":
    main()
