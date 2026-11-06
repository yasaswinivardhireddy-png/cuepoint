"""Daily delivery report: each campaign's impressions against its goal, as CSV and Markdown, uploaded
to S3. Runs as a Kubernetes CronJob after midnight, or by hand for any day."""

from __future__ import annotations

import argparse
import csv
import io
import logging
import os
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import boto3

from .config import Settings

log = logging.getLogger("cuepoint.report")


@dataclass(frozen=True)
class Row:
    campaign_id: str
    advertiser_id: str
    name: str
    status: str
    goal: int
    delivered: int

    @property
    def percent(self) -> float:
        return 100.0 * self.delivered / self.goal if self.goal else 0.0

    @property
    def verdict(self) -> str:
        # Delivery was paced to within 10% above the goal; 90% or more counts as delivered.
        if self.status != "active":
            return "paused"
        if self.percent >= 90:
            return "delivered"
        return "under-delivered" if self.delivered else "no delivery"


def scan_campaigns(dynamodb: Any, table: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    kwargs: dict[str, Any] = {"TableName": table}
    while True:
        page = dynamodb.scan(**kwargs)
        items.extend(page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def daily_totals(dynamodb: Any, table: str, campaign_ids: list[str], day: str) -> dict[str, int]:
    totals = dict.fromkeys(campaign_ids, 0)
    for start in range(0, len(campaign_ids), 100):
        keys: list[dict[str, Any]] = [
            {"campaignId": {"S": c}, "period": {"S": day}} for c in campaign_ids[start : start + 100]
        ]
        while keys:
            out = dynamodb.batch_get_item(RequestItems={table: {"Keys": keys}})
            for item in out.get("Responses", {}).get(table, []):
                totals[item["campaignId"]["S"]] = int(item["impressions"]["N"])
            keys = out.get("UnprocessedKeys", {}).get(table, {}).get("Keys", [])
    return totals


def build_rows(dynamodb: Any, settings: Settings, day: str) -> list[Row]:
    campaigns = [
        c for c in scan_campaigns(dynamodb, settings.campaigns_table) if c["startDate"]["S"] <= day <= c["endDate"]["S"]
    ]
    totals = daily_totals(dynamodb, settings.delivery_table, [c["id"]["S"] for c in campaigns], day)
    rows = [
        Row(
            campaign_id=c["id"]["S"],
            advertiser_id=c["advertiserId"]["S"],
            name=c["name"]["S"],
            status=c["status"]["S"],
            goal=int(c["dailyImpressionGoal"]["N"]),
            delivered=totals[c["id"]["S"]],
        )
        for c in campaigns
    ]
    return sorted(rows, key=lambda r: (r.advertiser_id, r.name))


def to_csv(rows: list[Row]) -> str:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(
        ["campaign_id", "advertiser_id", "campaign", "status", "daily_goal", "delivered", "percent_of_goal", "verdict"]
    )
    for r in rows:
        writer.writerow(
            [r.campaign_id, r.advertiser_id, r.name, r.status, r.goal, r.delivered, f"{r.percent:.1f}", r.verdict]
        )
    return out.getvalue()


def to_markdown(rows: list[Row], day: str) -> str:
    lines = [
        f"### Delivery report for {day}",
        "",
        "| Advertiser | Campaign | Goal | Delivered | % of goal | Verdict |",
        "|---|---|---:|---:|---:|---|",
    ]
    lines += [
        f"| {r.advertiser_id} | {r.name} | {r.goal:,} | {r.delivered:,} | {r.percent:.1f}% | {r.verdict} |"
        for r in rows
    ]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description=__doc__)
    yesterday = (datetime.now(UTC) - timedelta(days=1)).strftime("%Y-%m-%d")
    parser.add_argument(
        "--day",
        default=os.environ.get("REPORT_DAY") or yesterday,
        help="UTC day to report (default: REPORT_DAY or yesterday)",
    )
    parser.add_argument("--markdown", help="also write the Markdown table to this file")
    args = parser.parse_args(argv)

    settings = Settings.from_env()
    rows = build_rows(boto3.client("dynamodb"), settings, args.day)
    body = to_csv(rows)
    print(to_markdown(rows, args.day))
    if args.markdown:
        with open(args.markdown, "w", encoding="utf-8") as f:
            f.write(to_markdown(rows, args.day))
    if settings.reports_bucket:
        key = f"reports/{args.day}/delivery.csv"
        boto3.client("s3").put_object(
            Bucket=settings.reports_bucket, Key=key, Body=body.encode(), ContentType="text/csv"
        )
        log.info("uploaded s3://%s/%s (%d campaigns)", settings.reports_bucket, key, len(rows))


if __name__ == "__main__":
    main()
