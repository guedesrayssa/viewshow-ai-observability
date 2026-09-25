from __future__ import annotations

import re
from datetime import UTC, datetime

import pytest

from domain.incremental_batches import IncrementalBatchManifest, incremental_batch_id
from domain.models import TimeWindow


def valid_manifest_payload() -> dict[str, object]:
    window = TimeWindow(
        datetime(2026, 9, 17, 10, tzinfo=UTC),
        datetime(2026, 9, 17, 10, 15, tzinfo=UTC),
        900,
    )
    return {
        "contractVersion": "1.0",
        "batchId": incremental_batch_id("ARGUS", "signal_bucket", window, 0, "1.0"),
        "sourceSystem": "ARGUS",
        "sourceDataset": "signal_bucket",
        "window": {"start": "2026-09-17T10:00:00.000Z", "end": "2026-09-17T10:15:00.000Z"},
        "revision": 0,
        "data": {
            "key": "raw/argus/incremental/dataset=signal_bucket/data.parquet",
            "versionId": "version-1",
            "sizeBytes": 1,
            "sha256": "a" * 64,
        },
        "schema": {
            "fingerprint": "b" * 64,
            "columns": [
                {"name": "signal", "physicalType": "VARCHAR", "nullable": False, "ordinal": 1}
            ],
            "extraColumns": [],
        },
        "rowCount": 1,
        "exporterVersion": "1.0",
    }


def test_batch_identity_is_deterministic_and_revision_zero_only() -> None:
    window = TimeWindow(
        datetime(2026, 9, 17, 10, tzinfo=UTC),
        datetime(2026, 9, 17, 10, 15, tzinfo=UTC),
        900,
    )
    first = incremental_batch_id("ARGUS", "signal_bucket", window, 0, "1.0")
    second = incremental_batch_id("ARGUS", "signal_bucket", window, 0, "1.0")
    assert first == second
    assert re.fullmatch(r"bat_[0-9a-f]{64}", first)
    with pytest.raises(ValueError, match="revision=0"):
        incremental_batch_id("ARGUS", "signal_bucket", window, 1, "1.0")


def test_manifest_rejects_unknown_fields_and_data_key_outside_raw_prefix() -> None:
    payload = valid_manifest_payload()
    payload["unexpected"] = True
    with pytest.raises(ValueError, match="manifest fields"):
        IncrementalBatchManifest.from_mapping(payload)
    payload = valid_manifest_payload()
    data = payload["data"]
    assert isinstance(data, dict)
    data["key"] = "canonical/part.parquet"
    with pytest.raises(ValueError, match="raw/argus/incremental"):
        IncrementalBatchManifest.from_mapping(payload)
