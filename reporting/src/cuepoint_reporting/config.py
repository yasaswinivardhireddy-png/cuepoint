"""Settings from environment variables. AWS credentials, region and endpoint (AWS_ENDPOINT_URL) use
the standard AWS variables, or IRSA on EKS."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    queue_url: str
    delivery_table: str
    processed_table: str
    campaigns_table: str
    reports_bucket: str
    wait_seconds: int = 10
    metrics_port: int = 9102
    processed_ttl_days: int = 3

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> Settings:
        env = dict(os.environ if env is None else env)
        return cls(
            queue_url=env.get("EVENTS_QUEUE_URL", ""),
            delivery_table=env.get("DELIVERY_TABLE", "cuepoint-local-delivery"),
            processed_table=env.get("PROCESSED_EVENTS_TABLE", "cuepoint-local-processed-events"),
            campaigns_table=env.get("CAMPAIGNS_TABLE", "cuepoint-local-campaigns"),
            reports_bucket=env.get("REPORTS_BUCKET", ""),
            wait_seconds=int(env.get("WAIT_SECONDS", "10")),
            metrics_port=int(env.get("METRICS_PORT", "9102")),
        )
