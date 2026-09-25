"""Verify canonical ingestion models enforce timestamps, types and time windows."""

from datetime import UTC, datetime

import pytest

from domain.identity import payload_hash, record_id
from domain.models import CanonicalRecord, RecordType, TimeWindow


def test_time_window_uses_utc_and_grain() -> None:
    window = TimeWindow.from_epoch_ms(1788220800000, 1788221700000)
    assert window.start.tzinfo == UTC
    assert window.end.tzinfo == UTC
    assert window.grain_seconds == 900


def test_time_window_rejects_non_positive_ranges() -> None:
    with pytest.raises(ValueError, match="after"):
        TimeWindow.from_epoch_ms(1000, 1000)


def test_canonical_record_rejects_non_utc_datetimes() -> None:
    with pytest.raises(ValueError, match="UTC"):
        CanonicalRecord(
            schema_version="1.0",
            record_type=RecordType.INCIDENT,
            source_system="argus",
            source_dataset="incidents",
            natural_key=(("id", 1),),
            observed_at=datetime(2026, 9, 1),
            window=TimeWindow.from_epoch_ms(1000, 2000),
            dimensions={},
            measures={},
            quality={},
            quality_flags=(),
        )


def test_canonical_record_supports_state_without_observation_or_window() -> None:
    record = CanonicalRecord(
        schema_version="1.0",
        record_type=RecordType.UPSTREAM_SOURCE_HEALTH,
        source_system="argus",
        source_dataset="signal_meta",
        natural_key=(("source", "new-source"),),
        observed_at=None,
        window=None,
        dimensions={"source": "new-source"},
        measures={"rows_total": 0},
        quality={"coverage": "unavailable"},
        quality_flags=(),
    )

    assert record.observed_at is None
    assert record.window is None


def test_canonical_record_rejects_window_without_observation() -> None:
    with pytest.raises(ValueError, match="window requires observed_at"):
        CanonicalRecord(
            schema_version="1.0",
            record_type=RecordType.UPSTREAM_SOURCE_HEALTH,
            source_system="argus",
            source_dataset="signal_meta",
            natural_key=(("source", "new-source"),),
            observed_at=None,
            window=TimeWindow.from_epoch_ms(1000, 2000),
            dimensions={},
            measures={},
            quality={},
            quality_flags=(),
        )


def test_canonical_record_freezes_nested_inputs_and_with_measures() -> None:
    natural_key = [("id", 1)]
    dimensions = {"nested": {"labels": ["before"]}}
    measures = {"values": [1, 2]}
    quality = {"coverage": "complete"}
    quality_flags = ["observed"]
    record = CanonicalRecord(
        schema_version="1.0",
        record_type=RecordType.INCIDENT,
        source_system="argus",
        source_dataset="incidents",
        natural_key=natural_key,
        observed_at=datetime(2026, 9, 1, tzinfo=UTC),
        window=TimeWindow.from_epoch_ms(1000, 2000),
        dimensions=dimensions,
        measures=measures,
        quality=quality,
        quality_flags=quality_flags,
    )
    before = (record_id(record), payload_hash(record))

    natural_key.append(("extra", 2))
    dimensions["nested"]["labels"].append("after")
    measures["values"].append(3)
    quality["coverage"] = "changed"
    quality_flags.append("late")

    assert record.natural_key == (("id", 1),)
    assert record.dimensions["nested"]["labels"] == ("before",)
    assert record.measures["values"] == (1, 2)
    assert record.quality["coverage"] == "complete"
    assert record.quality_flags == ("observed",)
    assert before == (record_id(record), payload_hash(record))

    with pytest.raises(TypeError):
        record.dimensions["nested"]["labels"] += ("blocked",)
    with pytest.raises(TypeError):
        record.measures["values"] += (4,)

    replacement = {"values": [9]}
    updated = record.with_measures(replacement)
    replacement["values"].append(10)
    assert updated.measures["values"] == (9,)
    with pytest.raises(TypeError):
        updated.measures["values"] += (11,)
