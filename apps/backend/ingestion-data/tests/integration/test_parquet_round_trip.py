"""Verify canonical Parquet encoding and decoding across a filesystem round trip."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from adapters.archive.parquet import PyArrowParquetEncoder, athena_schema, read_partition
from contracts.argus.v2.normalizers import NormalizationContext, normalize_row
from contracts.registry import DatasetRegistry


def _records():
    descriptor = DatasetRegistry.load_argus_v2().require("app_error")
    first = normalize_row(
        descriptor,
        {
            "timestamp": 1788220800000,
            "error_code": "E-42",
            "manufacturer": "Acme",
            "errors": 7,
            "devices": None,
        },
    )
    second = normalize_row(
        descriptor,
        {
            "timestamp": 1788220800000,
            "error_code": "E-01",
            "manufacturer": "Acme",
            "errors": 3,
            "devices": 2,
        },
    )
    return descriptor, first, second


def test_round_trip_is_canonical_and_checksum_is_order_independent(tmp_path: Path) -> None:
    """Changing input order must not change the archive bytes or canonical records."""
    descriptor, first, second = _records()
    encoder = PyArrowParquetEncoder()

    left = encoder.write_partition(
        (second, first),
        descriptor,
        tmp_path / "left.parquet",
        dataset_version="dsv_test",
        expected_absent=True,
        idempotency_key="left",
    )
    right = encoder.write_partition(
        (first, second),
        descriptor,
        tmp_path / "right.parquet",
        dataset_version="dsv_test",
        expected_absent=True,
        idempotency_key="right",
    )

    assert left.sha256 == right.sha256
    assert read_partition(left.path) == (second, first)
    assert pq.read_table(left.path).column("error_code").to_pylist() == ["E-01", "E-42"]


def test_encoder_consumes_a_record_iterable_once(tmp_path: Path) -> None:
    """Reiterating a source page could duplicate I/O or hide records from a generator."""
    descriptor, first, second = _records()

    class OnePassRecords:
        def __init__(self) -> None:
            self.iterations = 0

        def __iter__(self):
            self.iterations += 1
            if self.iterations > 1:
                raise AssertionError("records were consumed more than once")
            yield second
            yield first

    records = OnePassRecords()
    encoded = PyArrowParquetEncoder().write_partition(
        records,
        descriptor,
        tmp_path / "part.parquet",
        dataset_version="dsv_test",
        expected_absent=True,
        idempotency_key="one-pass",
    )

    assert records.iterations == 1
    assert encoded.row_count == 2


def test_encoder_accepts_every_sanitized_contract_fixture(tmp_path: Path) -> None:
    """Canonical transformations must not make a descriptor column impossible to archive."""
    fixture_root = Path(__file__).parents[1] / "fixtures"
    rows = json.loads((fixture_root / "argus_v2_legacy_rows.json").read_text())
    rows.update(json.loads((fixture_root / "argus_v2_new_rows.json").read_text()))
    registry = DatasetRegistry.load_argus_v2()
    context = NormalizationContext(valid_sde_ids=frozenset({"sde-synthetic-001"}))

    for dataset, row in rows.items():
        descriptor = registry.require(dataset)
        record = normalize_row(descriptor, row, context)
        encoded = PyArrowParquetEncoder().write_partition(
            (record,),
            descriptor,
            tmp_path / f"{dataset}.parquet",
            dataset_version="dsv_test",
            expected_absent=True,
            idempotency_key=dataset,
        )

        assert read_partition(encoded.path) == (record,)


@pytest.mark.parametrize(
    ("dataset", "column"),
    [
        ("error_cat_hourly", "top_names"),
        ("incidents", "child_incidents"),
        ("rpaas_run", "regions"),
        ("live_event_sde", "tids_jarvis"),
        ("live_event_sde", "tids_epg"),
        ("live_event_sde", "tid_only_epg"),
        ("live_event_sde", "tid_only_jarvis"),
        ("live_event_sde", "epg_teams"),
    ],
)
def test_degraded_json_is_nullable_in_canonical_and_physical_columns(
    tmp_path: Path, dataset: str, column: str
) -> None:
    """Malformed source JSON is archived as null plus its quality flag, not rejected later."""
    fixture_root = Path(__file__).parents[1] / "fixtures"
    rows = json.loads((fixture_root / "argus_v2_legacy_rows.json").read_text())
    rows.update(json.loads((fixture_root / "argus_v2_new_rows.json").read_text()))
    descriptor = DatasetRegistry.load_argus_v2().require(dataset)
    raw = {**rows[dataset], column: "not json"}
    record = normalize_row(descriptor, raw)

    encoded = PyArrowParquetEncoder().write_partition(
        (record,),
        descriptor,
        tmp_path / f"{dataset}-{column}.parquet",
        dataset_version="dsv_test",
        expected_absent=True,
        idempotency_key=f"degraded-{dataset}-{column}",
    )
    table = pq.read_table(encoded.path)

    assert "INVALID_SOURCE_JSON" in record.quality_flags
    assert table.schema.field(column).nullable
    assert table.column(column).to_pylist() == [None]
    assert read_partition(encoded.path) == (record,)


def test_empty_partition_is_a_readable_typed_parquet_file(tmp_path: Path) -> None:
    """An empty window still needs an auditable file with the descriptor's typed columns."""
    descriptor = DatasetRegistry.load_argus_v2().require("app_error")

    encoded = PyArrowParquetEncoder().write_partition(
        (),
        descriptor,
        tmp_path / "empty.parquet",
        dataset_version="dsv_test",
        expected_absent=True,
        idempotency_key="empty",
    )

    assert encoded.row_count == 0
    assert pq.read_table(encoded.path).schema.field("errors").type == pa.int64()
    assert read_partition(encoded.path) == ()


def test_contract_schema_is_identical_for_empty_and_populated_partitions(tmp_path: Path) -> None:
    """Glue table types must not depend on which nullable values a batch happened to contain."""
    fixture_root = Path(__file__).parents[1] / "fixtures"
    rows = json.loads((fixture_root / "argus_v2_legacy_rows.json").read_text())
    rows.update(json.loads((fixture_root / "argus_v2_new_rows.json").read_text()))
    registry = DatasetRegistry.load_argus_v2()
    context = NormalizationContext(valid_sde_ids=frozenset({"sde-synthetic-001"}))
    for dataset, row in rows.items():
        descriptor = registry.require(dataset)
        populated = PyArrowParquetEncoder().write_partition(
            (normalize_row(descriptor, row, context),),
            descriptor,
            tmp_path / f"{dataset}-full.parquet",
            dataset_version="dsv",
            expected_absent=True,
            idempotency_key=f"full-{dataset}",
        )
        empty = PyArrowParquetEncoder().write_partition(
            (),
            descriptor,
            tmp_path / f"{dataset}-empty.parquet",
            dataset_version="dsv",
            expected_absent=True,
            idempotency_key=f"empty-{dataset}",
        )
        populated_schema = pq.read_table(populated.path).schema
        assert populated_schema == pq.read_table(empty.path).schema
        assert all(
            "decimal(" not in field_type for field_type in athena_schema(populated_schema).values()
        )


def test_encoder_writes_large_partitions_in_bounded_batches(tmp_path: Path, monkeypatch) -> None:
    """A one-pass source is spooled and emitted in bounded Arrow batches, not one huge table."""
    descriptor, first, _second = _records()
    import adapters.archive.parquet as parquet_module

    writes: list[int] = []
    real_writer = parquet_module.pq.ParquetWriter

    class TrackingWriter:
        def __init__(self, *args, **kwargs) -> None:
            self.writer = real_writer(*args, **kwargs)

        def __enter__(self):
            self.writer.__enter__()
            return self

        def __exit__(self, *args) -> None:
            self.writer.__exit__(*args)

        def write_table(self, table) -> None:
            writes.append(table.num_rows)
            self.writer.write_table(table)

    monkeypatch.setattr(parquet_module.pq, "ParquetWriter", TrackingWriter)

    def record(index: int):  # type: ignore[no-untyped-def]
        error_code = f"E-{index:05d}"
        return replace(
            first,
            natural_key=(
                ("timestamp", 1_788_220_800_000),
                ("error_code", error_code),
                ("manufacturer", "Acme"),
            ),
            dimensions={"errorCode": error_code, "manufacturer": "Acme"},
        )

    # Canonical-v2 deliberately replaced the legacy 10k-row boundary with a byte target.
    # Fix the target at exactly 1,000 fixture payloads so this integration test still proves
    # bounded, one-pass writes without reinstating a row-count production policy.
    monkeypatch.setattr(
        parquet_module,
        "TARGET_PARQUET_ROW_GROUP_BYTES",
        len(parquet_module._serialize_record(record(0))) * 1_000,
    )

    def records():
        for index in range(10_001):
            yield record(index)

    result = PyArrowParquetEncoder().write_partition(
        records(),
        descriptor,
        tmp_path / "large.parquet",
        dataset_version="dsv_test",
        expected_absent=True,
        idempotency_key="bounded-batches",
    )

    assert result.row_count == 10_001
    assert writes == [1_000] * 10 + [1]
