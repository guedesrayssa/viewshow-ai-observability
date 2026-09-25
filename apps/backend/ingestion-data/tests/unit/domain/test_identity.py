"""Verify deterministic identities and version hashes for canonical records."""

from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal

from domain.identity import dataset_version, payload_hash, record_id
from domain.models import CanonicalRecord, RecordType, TimeWindow


def _record() -> CanonicalRecord:
    return CanonicalRecord(
        schema_version="1.0",
        record_type=RecordType.SIGNAL_OBSERVATION,
        source_system="argus",
        source_dataset="signal_bucket",
        natural_key=(
            ("source", "apollo"),
            ("entity", "HomeQuery"),
            ("metric", "rpm"),
            ("bts", 1788220800000),
        ),
        observed_at=datetime(2026, 9, 1, tzinfo=UTC),
        window=TimeWindow.from_epoch_ms(1788220800000, 1788221700000),
        dimensions={"source": "apollo", "entity": "HomeQuery", "metric": "rpm"},
        measures={"value": Decimal("10")},
        quality={},
        quality_flags=(),
    )


def test_record_identity_ignores_run_but_payload_hash_detects_measure_change() -> None:
    base = _record()
    changed = base.with_measures({"value": Decimal("11")})
    assert record_id(base) == record_id(changed)
    assert payload_hash(base) != payload_hash(changed)
    assert len(dataset_version("argus", "a" * 64, "2.0", "1.0")) == 68


def test_record_identity_ignores_window_but_payload_hash_detects_it() -> None:
    base = _record()
    changed = replace(
        base,
        window=TimeWindow.from_epoch_ms(1788220800000, 1788224400000),
    )

    assert record_id(base) == record_id(changed)
    assert payload_hash(base) != payload_hash(changed)


def test_record_identity_ignores_dimensions_but_payload_hash_detects_them() -> None:
    base = _record()
    changed = replace(base, dimensions={**base.dimensions, "entity": "ChangedQuery"})

    assert record_id(base) == record_id(changed)
    assert payload_hash(base) != payload_hash(changed)


def test_record_identity_ignores_quality_but_payload_hash_detects_it() -> None:
    base = _record()
    changed = replace(base, quality={"coverage": "partial"})

    assert record_id(base) == record_id(changed)
    assert payload_hash(base) != payload_hash(changed)
