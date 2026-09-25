#!/usr/bin/env python3
"""Build the bounded pilot catalog from prepared Argus aggregates."""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
from collections import defaultdict
from pathlib import Path

DELIVERY = {
    "cdn_live_errors": "cdn_live_err_rate",
    "origin_live_errors": "origin_live_err_rate",
    "origin_cdn_live_errors": "origin_cdn_live_err_rate",
}
QOE_15M = [
    ("active_sessions", "count"), ("active_with_error", "count"),
    ("joins_in_bucket", "count"), ("latency_ms_p50", "ms"),
    ("latency_ms_p95", "ms"), ("bufferratio_avg", "ratio-unconfirmed"),
    ("jointime_s_avg", "seconds"), ("dropped_frames_avg", "count/session"),
]
QOE_1H = [
    ("bufferratio_avg", "ratio-unconfirmed"), ("sessions", "count"),
    ("errors", "count"), ("startup_errors", "count"),
]

def identity(dataset: str, entity: str, metric: str) -> str:
    value = {"logicalDataset": dataset, "source": "argus", "entity": entity,
             "metric": metric, "dimensions": [["channel", entity]]}
    canonical = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return "ts_" + hashlib.sha256(canonical.encode()).hexdigest()

def series(dataset: str, entity: str, metric: str, unit: str, grain: int) -> dict:
    return {"metric": metric, "seriesId": identity(dataset, entity, metric),
            "unit": unit, "grainSeconds": grain}

def build(qoe_path: Path, signals_path: Path, model_path: Path, limit: int) -> list[dict]:
    sessions: defaultdict[str, int] = defaultdict(int)
    with gzip.open(qoe_path, "rt", newline="") as stream:
        for row in csv.DictReader(stream):
            if row["sinal"] != "?": sessions[row["sinal"]] += int(float(row["sessions"]))
    coverage = {source: set() for source in DELIVERY}
    with gzip.open(signals_path, "rt", newline="") as stream:
        for row in csv.DictReader(stream):
            if row["source"] in coverage and row["metric"] == "err_rate": coverage[row["source"]].add(row["entity"])
    model = json.loads(model_path.read_text())
    eligible = set(model["detection"]["scopes"])
    for entities in coverage.values(): eligible &= entities
    channels = sorted(eligible, key=lambda channel: (-sessions[channel], channel))[:limit]
    scopes = []
    for channel in channels:
        definitions = [series("live_active_15min", channel, metric, unit, 900) for metric, unit in QOE_15M]
        definitions += [series("live_qoe_hourly", channel, metric, unit, 3600) for metric, unit in QOE_1H]
        definitions += [series(source, channel, alias, "percent", 900) for source, alias in DELIVERY.items()]
        scopes.append({"id": channel, "source": "argus", "entity": channel, "priority": "P2",
                       "detectorMetrics": [metric for metric, _ in QOE_15M],
                       "materiality": [{"metric": "active_sessions", "minimum": 25}],
                       "episodeWindowSeconds": 7200, "series": definitions})
    if len(scopes) != limit:
        raise RuntimeError(f"only {len(scopes)} scopes satisfy model and delivery coverage; requested {limit}")
    return scopes

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=10)
    args = parser.parse_args()
    catalog = build(args.data / "qoe.csv.gz", args.data / "signal-bucket.csv.gz", args.model, args.limit)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")

if __name__ == "__main__":
    main()
