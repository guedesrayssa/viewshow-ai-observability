"""Linhas, registros e caminhos compartilhados pelos testes do contrato de fatos do worker."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from contracts.argus.v2.normalizers import normalize_row
from contracts.registry import DatasetRegistry
from domain.models import CanonicalRecord

AGENTIC = Path(__file__).parents[2] / "agentic"
PILOT_CATALOG = AGENTIC / "config" / "scope-catalog.pilot.json"
FROZEN_FACT = AGENTIC / "contracts" / "fixtures" / "time-series-fact.v1.json"
DATASET_VERSION = "dsv_contract_v1"
REGISTRY = DatasetRegistry.load_argus_v2()

QOE_15M = (
    "active_sessions",
    "active_with_error",
    "joins_in_bucket",
    "latency_ms_p50",
    "latency_ms_p95",
    "bufferratio_avg",
    "jointime_s_avg",
    "dropped_frames_avg",
)
QOE_1H = ("bufferratio_avg", "sessions", "errors", "startup_errors")
DELIVERY = {
    "cdn_live_errors": "cdn_live_err_rate",
    "origin_live_errors": "origin_live_err_rate",
    "origin_cdn_live_errors": "origin_cdn_live_err_rate",
}


def epoch_ms(*args: int) -> int:
    return int(datetime(*args, tzinfo=UTC).timestamp() * 1000)


BUCKET_15M = epoch_ms(2026, 9, 6, 14, 45)
BUCKET_1H = epoch_ms(2026, 9, 6, 14)


def pilot_scopes() -> list[dict[str, Any]]:
    scopes: list[dict[str, Any]] = json.loads(PILOT_CATALOG.read_text())
    return scopes


def live_active_row(channel: str, bucket_ms: int = BUCKET_15M) -> dict[str, object]:
    return {
        "bucket_ts": bucket_ms,
        "sinal": channel,
        "active_sessions": 120,
        "active_with_error": 3,
        "joins_in_bucket": 40,
        "latency_ms_p50": 210.5,
        "latency_ms_p95": 480.25,
        "bufferratio_avg": 0.12,
        "jointime_s_avg": 1.5,
        "dropped_frames_avg": 0.75,
    }


def live_qoe_row(channel: str, hour_ms: int = BUCKET_1H) -> dict[str, object]:
    return {
        "hour_ts": hour_ms,
        "sinal": channel,
        "sessions": 900,
        "errors": 12,
        "startup_errors": 4,
        "latency_ms_avg": 300.0,
        "latency_ms_p50": 200.0,
        "latency_ms_p95": 500.0,
        "bufferratio_avg": 0.1,
        "jointime_s_avg": 1.2,
        "dropped_frames_avg": 0.5,
        "stalls_avg": 0.3,
        "bitrate_mbps_avg": 3.2,
        "bitrate_mbps_p50": 3.0,
    }


def signal_row(
    source: str, channel: str, metric: str = "err_rate", bts: int = BUCKET_15M
) -> dict[str, object]:
    return {"bts": bts, "source": source, "entity": channel, "metric": metric, "value": 1.25}


def normalized(dataset: str, row: dict[str, object]) -> CanonicalRecord:
    return normalize_row(REGISTRY.require(dataset), row)


def channel_records(channel: str) -> list[CanonicalRecord]:
    """Registros que a ingestão normaliza e que juntos cobrem as 15 séries de um canal."""
    return [
        normalized("live_active_15min", live_active_row(channel)),
        normalized("live_qoe_hourly", live_qoe_row(channel)),
        *(normalized("signal_bucket", signal_row(source, channel)) for source in DELIVERY),
    ]
