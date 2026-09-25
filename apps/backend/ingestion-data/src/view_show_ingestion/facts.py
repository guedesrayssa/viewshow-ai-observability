"""Canonical time-series facts consumed by the analysis worker."""
from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Mapping

@dataclass(frozen=True)
class SeriesIdentity:
    logical_dataset: str
    source: str
    entity: str
    metric: str
    dimensions: Mapping[str, str]

def canonical_series_identity(identity: SeriesIdentity) -> str:
    value = {
        "logicalDataset": identity.logical_dataset,
        "source": identity.source,
        "entity": identity.entity,
        "metric": identity.metric,
        "dimensions": sorted(identity.dimensions.items()),
    }
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

def series_id(identity: SeriesIdentity) -> str:
    digest = hashlib.sha256(canonical_series_identity(identity).encode()).hexdigest()
    return f"ts_{digest}"

def _instant(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        raise ValueError("observed_at must be an ISO-8601 UTC instant")
    return parsed

def build_fact(*, dataset_version: str, identity: SeriesIdentity, observed_at: str,
               grain_seconds: int, unit: str, value: float | int | None) -> dict:
    """Return the exact DynamoDB item expected by DynamoAnalysisStore.read."""
    if not dataset_version or not unit or grain_seconds not in (900, 3600):
        raise ValueError("invalid fact metadata")
    observed = _instant(observed_at)
    epoch = int(observed.timestamp())
    if epoch % grain_seconds:
        raise ValueError("observed_at is not aligned to grain_seconds")
    if value is not None and (isinstance(value, bool) or not math.isfinite(float(value))):
        raise ValueError("value must be finite or null")
    sid = series_id(identity)
    record_input = f"{dataset_version}|{sid}|{observed_at}|{grain_seconds}"
    record_id = "fact_" + hashlib.sha256(record_input.encode()).hexdigest()
    day = observed.strftime("%Y%m%d")
    return {
        "pk": f"DATASET#{dataset_version}#FACT#TS#{sid}#{day}",
        "sk": f"T#{epoch:010d}",
        "itemType": "time_series_fact",
        "recordId": record_id,
        "datasetVersion": dataset_version,
        "seriesId": sid,
        "observedAt": observed_at,
        "grainSeconds": grain_seconds,
        "source": identity.source,
        "entity": identity.entity,
        "dimensions": dict(sorted(identity.dimensions.items())),
        "payload": {"metric": {"name": identity.metric, "unit": unit, "value": value}},
    }
