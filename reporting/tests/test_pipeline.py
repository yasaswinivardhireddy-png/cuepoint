from __future__ import annotations

import json
import uuid
from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from moto import mock_aws

from cuepoint_reporting.aggregator import Aggregator, Impression, InvalidEvent, parse_event
from cuepoint_reporting.config import Settings
from cuepoint_reporting.report import build_rows, main, to_csv, to_markdown
from cuepoint_reporting.worker import Worker

CAMPAIGN_A = "cmp-" + str(uuid.UUID(int=1))
CAMPAIGN_B = "cmp-" + str(uuid.UUID(int=2))


def event(event_id: str, campaign: str = CAMPAIGN_A, timestamp: str = "2026-11-06T09:15:42.123456789Z") -> str:
    return json.dumps(
        {
            "eventId": event_id,
            "type": "impression",
            "decisionId": "d1",
            "campaignId": campaign,
            "creativeId": "crv-1",
            "timestamp": timestamp,
        }
    )


@pytest.fixture
def aws(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, Any]]:
    for name, value in {
        "AWS_DEFAULT_REGION": "ap-south-1",
        "AWS_ACCESS_KEY_ID": "test",
        "AWS_SECRET_ACCESS_KEY": "test",
    }.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("AWS_ENDPOINT_URL", raising=False)
    with mock_aws():
        ddb = boto3.client("dynamodb")
        sqs = boto3.client("sqs")
        # Shaped like infra/terraform's tables and queues.
        ddb.create_table(
            TableName="delivery",
            BillingMode="PAY_PER_REQUEST",
            AttributeDefinitions=[
                {"AttributeName": "campaignId", "AttributeType": "S"},
                {"AttributeName": "period", "AttributeType": "S"},
            ],
            KeySchema=[
                {"AttributeName": "campaignId", "KeyType": "HASH"},
                {"AttributeName": "period", "KeyType": "RANGE"},
            ],
        )
        ddb.create_table(
            TableName="processed",
            BillingMode="PAY_PER_REQUEST",
            AttributeDefinitions=[{"AttributeName": "eventId", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "eventId", "KeyType": "HASH"}],
        )
        ddb.create_table(
            TableName="campaigns",
            BillingMode="PAY_PER_REQUEST",
            AttributeDefinitions=[{"AttributeName": "id", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "id", "KeyType": "HASH"}],
        )
        dlq = sqs.create_queue(QueueName="events-dlq")["QueueUrl"]
        dlq_arn = sqs.get_queue_attributes(QueueUrl=dlq, AttributeNames=["QueueArn"])["Attributes"]["QueueArn"]
        queue = sqs.create_queue(
            QueueName="events",
            Attributes={
                "VisibilityTimeout": "0",
                "RedrivePolicy": json.dumps({"deadLetterTargetArn": dlq_arn, "maxReceiveCount": "2"}),
            },
        )["QueueUrl"]
        boto3.client("s3").create_bucket(
            Bucket="reports", CreateBucketConfiguration={"LocationConstraint": "ap-south-1"}
        )
        yield {
            "ddb": ddb,
            "sqs": sqs,
            "queue": queue,
            "dlq": dlq,
            "aggregator": Aggregator(ddb, "delivery", "processed"),
        }


def impressions(ddb: Any, campaign: str = CAMPAIGN_A) -> dict[str, int]:
    items = ddb.query(
        TableName="delivery",
        KeyConditionExpression="campaignId = :c",
        ExpressionAttributeValues={":c": {"S": campaign}},
    )["Items"]
    return {i["period"]["S"]: int(i["impressions"]["N"]) for i in items}


def test_parse_event_reads_go_timestamps() -> None:
    e = parse_event(event("a1b2c3d4e5f60718", timestamp="2026-11-06T23:59:59.999999999+05:30"))
    assert e == Impression("a1b2c3d4e5f60718", CAMPAIGN_A, "2026-11-06T18", "2026-11-06")
    for bad in [
        "not json",
        json.dumps({"type": "click"}),
        event("short"),
        event("a1b2c3d4e5f60718", campaign="cmp-x"),
        event("a1b2c3d4e5f60718", timestamp="yesterday"),
    ]:
        with pytest.raises(InvalidEvent):
            parse_event(bad)


def test_counts_each_event_exactly_once(aws: dict[str, Any]) -> None:
    agg: Aggregator = aws["aggregator"]
    e1, e2, e3 = (parse_event(event(f"{i:016x}")) for i in (1, 2, 3))
    late = parse_event(event(f"{4:016x}", timestamp="2026-11-06T10:01:00Z"))

    first = agg.count([e1, e2, e1])
    assert (first.counted, first.duplicates) == (2, 1)
    # A redelivered batch mixing old and new events counts only the new ones.
    second = agg.count([e1, e3, late])
    assert (second.counted, second.duplicates) == (2, 1)
    assert impressions(aws["ddb"]) == {"2026-11-06": 4, "2026-11-06T09": 3, "2026-11-06T10": 1}

    replay = agg.count([e1, e2, e3, late])
    assert (replay.counted, replay.duplicates) == (0, 4)
    assert impressions(aws["ddb"])["2026-11-06"] == 4


def test_worker_deletes_counted_messages_and_dead_letters_bad_ones(aws: dict[str, Any]) -> None:
    sqs, queue, dlq = aws["sqs"], aws["queue"], aws["dlq"]
    bodies = [event(f"{i:016x}", campaign=CAMPAIGN_A if i % 2 else CAMPAIGN_B) for i in range(1, 9)]
    bodies += [event(f"{1:016x}"), event(f"{2:016x}", campaign=CAMPAIGN_B)]  # resent by the ad server
    bodies += ["{broken", json.dumps({"type": "impression", "eventId": "nope"})]
    for start in range(0, len(bodies), 10):
        sqs.send_message_batch(
            QueueUrl=queue, Entries=[{"Id": str(i), "MessageBody": b} for i, b in enumerate(bodies[start : start + 10])]
        )

    worker = Worker(sqs, aws["aggregator"], queue, wait_seconds=0)
    counted = duplicates = invalid = 0
    for _ in range(10):
        result = worker.poll_once()
        counted, duplicates, invalid = (
            counted + result.counted,
            duplicates + result.duplicates,
            invalid + result.invalid,
        )
        if not result.received:
            break

    assert (counted, duplicates) == (8, 2)
    assert impressions(aws["ddb"], CAMPAIGN_A)["2026-11-06"] == 4
    assert impressions(aws["ddb"], CAMPAIGN_B)["2026-11-06"] == 4
    # Each bad message was received maxReceiveCount (2) times, then moved to the dead-letter queue.
    assert invalid == 4
    parked = sqs.receive_message(QueueUrl=dlq, MaxNumberOfMessages=10)["Messages"]
    assert sorted(m["Body"] for m in parked) == sorted(bodies[-2:])


def test_daily_report_lists_delivery_against_goals_and_uploads_csv(
    aws: dict[str, Any], monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    ddb = aws["ddb"]
    for cid, adv, name, status, goal, start in [
        (CAMPAIGN_A, "adv-acme-motors", "Winter Drive", "active", "1000", "2026-11-01"),
        (CAMPAIGN_B, "adv-bluepeak", "Summer Fizz", "paused", "500", "2026-11-01"),
        ("cmp-" + str(uuid.UUID(int=3)), "adv-summit", "Not started", "active", "800", "2026-12-01"),
    ]:
        ddb.put_item(
            TableName="campaigns",
            Item={
                "id": {"S": cid},
                "advertiserId": {"S": adv},
                "name": {"S": name},
                "status": {"S": status},
                "dailyImpressionGoal": {"N": goal},
                "startDate": {"S": start},
                "endDate": {"S": "2026-11-30"},
            },
        )
    aws["aggregator"].count([parse_event(event(f"{i:016x}")) for i in range(1, 951)][:900])

    settings = Settings(
        queue_url="",
        delivery_table="delivery",
        processed_table="processed",
        campaigns_table="campaigns",
        reports_bucket="reports",
    )
    rows = build_rows(ddb, settings, "2026-11-06")
    assert [(r.name, r.delivered, r.verdict) for r in rows] == [
        ("Winter Drive", 900, "delivered"),
        ("Summer Fizz", 0, "paused"),
    ]
    assert "| adv-acme-motors | Winter Drive | 1,000 | 900 | 90.0% | delivered |" in to_markdown(rows, "2026-11-06")
    assert to_csv(rows).splitlines()[1].endswith(",1000,900,90.0,delivered")

    for name, value in {
        "CAMPAIGNS_TABLE": "campaigns",
        "DELIVERY_TABLE": "delivery",
        "REPORTS_BUCKET": "reports",
    }.items():
        monkeypatch.setenv(name, value)
    main(["--day", "2026-11-06"])
    assert "Delivery report for 2026-11-06" in capsys.readouterr().out
    body = (
        boto3.client("s3").get_object(Bucket="reports", Key="reports/2026-11-06/delivery.csv")["Body"].read().decode()
    )
    assert body.startswith("campaign_id,advertiser_id,campaign,status,daily_goal,delivered,percent_of_goal,verdict\n")
