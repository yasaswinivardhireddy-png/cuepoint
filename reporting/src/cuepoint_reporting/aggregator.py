"""Counts impression events into hourly and daily delivery totals, exactly once.

SQS delivers every message at least once, and the ad server may send an event twice. Each batch is
written in one DynamoDB transaction that both records the event IDs (failing if one was already
recorded) and adds to the counters, so a counter can never include an event twice or miss one that
was marked as processed.
"""

from __future__ import annotations

import json
import re
import time
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from botocore.exceptions import ClientError

_EVENT_ID = re.compile(r"^[0-9a-f]{16,64}$")
_CAMPAIGN_ID = re.compile(r"^cmp-[0-9a-f-]{36}$")


class InvalidEvent(ValueError):
    """The message can never be processed; it should end up in the dead-letter queue."""


@dataclass(frozen=True)
class Impression:
    event_id: str
    campaign_id: str
    hour: str  # 2026-11-06T09
    day: str  # 2026-11-06


def parse_event(body: str) -> Impression:
    try:
        data = json.loads(body)
    except json.JSONDecodeError as err:
        raise InvalidEvent(f"not JSON: {err}") from err
    if not isinstance(data, dict) or data.get("type") != "impression":
        raise InvalidEvent("not an impression event")
    event_id, campaign_id, stamp = data.get("eventId"), data.get("campaignId"), data.get("timestamp")
    if not isinstance(event_id, str) or not _EVENT_ID.match(event_id):
        raise InvalidEvent("bad eventId")
    if not isinstance(campaign_id, str) or not _CAMPAIGN_ID.match(campaign_id):
        raise InvalidEvent("bad campaignId")
    if not isinstance(stamp, str):
        raise InvalidEvent("missing timestamp")
    at = parse_time(stamp).astimezone(UTC)
    return Impression(event_id, campaign_id, at.strftime("%Y-%m-%dT%H"), at.strftime("%Y-%m-%d"))


def parse_time(stamp: str) -> datetime:
    # Go writes RFC 3339 with up to 9 fractional digits; Python keeps microseconds.
    match = re.match(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)$", stamp)
    if not match:
        raise InvalidEvent(f"bad timestamp {stamp!r}")
    base, fraction, zone = match.groups()
    fraction = (fraction or ".0")[:7]
    try:
        return datetime.fromisoformat(f"{base}{fraction}{'+00:00' if zone == 'Z' else zone}")
    except ValueError as err:
        raise InvalidEvent(f"bad timestamp {stamp!r}") from err


@dataclass
class BatchResult:
    counted: int = 0
    duplicates: int = 0


class Aggregator:
    def __init__(self, dynamodb: Any, delivery_table: str, processed_table: str, ttl_days: int = 3):
        self.dynamodb = dynamodb
        self.delivery_table = delivery_table
        self.processed_table = processed_table
        self.ttl_seconds = ttl_days * 86400

    def count(self, events: list[Impression]) -> BatchResult:
        """Counts new events and skips ones counted before. Raises on errors worth retrying."""
        result = BatchResult()
        unique = list({e.event_id: e for e in events}.values())
        result.duplicates += len(events) - len(unique)
        # A transaction holds at most 100 items: one marker per event plus up to two counter updates.
        for start in range(0, len(unique), self.MAX_EVENTS_PER_TRANSACTION):
            chunk = self._count_chunk(unique[start : start + self.MAX_EVENTS_PER_TRANSACTION])
            result.counted += chunk.counted
            result.duplicates += chunk.duplicates
        return result

    MAX_EVENTS_PER_TRANSACTION = 30

    def _count_chunk(self, pending: list[Impression]) -> BatchResult:
        result = BatchResult()
        # Each pass either commits or drops at least one event already counted, so this ends.
        while pending:
            try:
                self.dynamodb.transact_write_items(TransactItems=self._items(pending))
                result.counted += len(pending)
                return result
            except ClientError as err:
                if err.response.get("Error", {}).get("Code") != "TransactionCanceledException":
                    raise
                reasons = err.response.get("CancellationReasons", [])
                seen = {
                    pending[i].event_id
                    for i, reason in enumerate(reasons[: len(pending)])
                    if reason.get("Code") == "ConditionalCheckFailed"
                }
                if not seen:
                    raise  # throttling or a conflicting write: retry the whole batch later
                result.duplicates += len(seen)
                pending = [e for e in pending if e.event_id not in seen]
        return result

    def _items(self, events: list[Impression]) -> list[dict[str, Any]]:
        expires = str(int(time.time()) + self.ttl_seconds)
        # The first len(events) items are the event markers, so cancellation reasons map back to events.
        items: list[dict[str, Any]] = [
            {
                "Put": {
                    "TableName": self.processed_table,
                    "Item": {
                        "eventId": {"S": e.event_id},
                        "campaignId": {"S": e.campaign_id},
                        "expiresAt": {"N": expires},
                    },
                    "ConditionExpression": "attribute_not_exists(eventId)",
                }
            }
            for e in events
        ]
        totals: Counter[tuple[str, str]] = Counter()
        for e in events:
            totals[(e.campaign_id, e.hour)] += 1
            totals[(e.campaign_id, e.day)] += 1
        for (campaign_id, period), n in sorted(totals.items()):
            items.append(
                {
                    "Update": {
                        "TableName": self.delivery_table,
                        "Key": {"campaignId": {"S": campaign_id}, "period": {"S": period}},
                        "UpdateExpression": "ADD impressions :n",
                        "ExpressionAttributeValues": {":n": {"N": str(n)}},
                    }
                }
            )
        return items
