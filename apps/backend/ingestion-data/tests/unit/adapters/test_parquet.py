"""Verify Parquet archive encoding preserves canonical ingestion schemas."""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

import adapters.archive.parquet as parquet_module
from adapters.archive.parquet import (
    ParquetEncodingError,
    PyArrowParquetEncoder,
    athena_schema,
    athena_schema_for_descriptor,
    read_partition,
    schema_fingerprint_for_descriptor,
)
from contracts.argus.v2.normalizers import normalize_row
from contracts.registry import EXPECTED_ARGUS_V2_DATASETS, DatasetRegistry
from domain.disk_budget import DiskBudget, DiskBudgetExceeded
from domain.identity import payload_hash, record_id
from ports import IdempotencyConflict
from tests.fakes import FakeParquetEncoder

_CANONICAL_ENVELOPE_NAMES = {
    "schemaVersion",
    "recordId",
    "datasetVersion",
    "recordType",
    "sourceSystem",
    "observedAt",
    "windowStart",
    "windowEnd",
    "windowGrainSeconds",
    "payloadHash",
    "naturalKey",
    "dimensions",
    "measures",
    "quality",
    "qualityFlags",
}


def _app_error_records():
    descriptor = DatasetRegistry.load_argus_v2().require("app_error")
    return descriptor, (
        normalize_row(
            descriptor,
            {
                "timestamp": 1788220800000,
                "error_code": "E-42",
                "manufacturer": "Acme",
                "errors": 7,
                "devices": None,
            },
        ),
    )


def test_dataset_has_typed_columns_not_opaque_json(tmp_path: Path) -> None:
    """Removing descriptor-derived fields would hide analytics data in a payload blob."""
    descriptor, records = _app_error_records()

    encoded = PyArrowParquetEncoder().write_partition(
        records,
        descriptor,
        tmp_path / "part.parquet",
        dataset_version="dsv_test",
        expected_absent=True,
        idempotency_key="unit",
    )
    table = pq.read_table(encoded.path)

    assert table.schema.field("errors").type == pa.int64()
    assert table.schema.field("devices").nullable
    assert "payload" not in table.column_names
    assert table.column("errors").to_pylist() == [7]
    assert encoded.row_count == 1
    assert encoded.dataset == descriptor.table
    assert encoded.dataset_version == "dsv_test"
    assert encoded.schema_version == "1.0"
    assert encoded.schema_fingerprint == schema_fingerprint_for_descriptor(descriptor)


def test_parquet_row_groups_are_bounded_by_estimated_bytes_not_fixed_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    descriptor, records = _app_error_records()
    second = normalize_row(
        descriptor,
        {
            "timestamp": 1788220800000,
            "error_code": "E-43",
            "manufacturer": "Acme",
            "errors": 3,
            "devices": 1,
        },
    )
    monkeypatch.setattr(parquet_module, "TARGET_PARQUET_ROW_GROUP_BYTES", 1)

    encoded = PyArrowParquetEncoder().write_partition(
        (*records, second),
        descriptor,
        tmp_path / "byte-bounded.parquet",
        dataset_version="dsv_test",
        expected_absent=True,
        idempotency_key="byte-bounded",
    )

    assert pq.ParquetFile(encoded.path).metadata.num_row_groups == 2


def test_rejects_duplicate_record_ids_before_creating_a_destination(tmp_path: Path) -> None:
    """A duplicate fact makes output order affect a supposedly deterministic partition."""
    descriptor, records = _app_error_records()
    path = tmp_path / "duplicate.parquet"

    with pytest.raises(ValueError, match="duplicate recordId"):
        PyArrowParquetEncoder().write_partition(
            records * 2,
            descriptor,
            path,
            dataset_version="dsv_test",
            expected_absent=True,
            idempotency_key="duplicates",
        )

    assert not path.exists()


def test_idempotency_replays_the_original_result_and_rejects_changed_input(tmp_path: Path) -> None:
    """A retry must be independent of later path changes but key reuse cannot overwrite data."""
    descriptor, records = _app_error_records()
    path = tmp_path / "part.parquet"
    encoder = PyArrowParquetEncoder()
    encoder.write_partition(
        records,
        descriptor,
        path,
        dataset_version="dsv_test",
        expected_absent=True,
        idempotency_key="retry",
    )
    path.write_bytes(b"changed externally")

    with pytest.raises(ParquetEncodingError, match="does not match its encoded result"):
        encoder.write_partition(
            records,
            descriptor,
            path,
            dataset_version="dsv_test",
            expected_absent=True,
            idempotency_key="retry",
        )
    with pytest.raises(IdempotencyConflict):
        encoder.write_partition(
            (),
            descriptor,
            path,
            dataset_version="dsv_test",
            expected_absent=False,
            idempotency_key="retry",
        )


def test_idempotency_recreates_a_partition_when_workspace_cleanup_removed_the_cached_path(
    tmp_path: Path,
) -> None:
    descriptor, records = _app_error_records()
    path = tmp_path / "cleaned.parquet"
    encoder = PyArrowParquetEncoder()
    first = encoder.write_partition(
        records,
        descriptor,
        path,
        dataset_version="dsv_test",
        expected_absent=True,
        idempotency_key="cleaned-retry",
    )
    path.unlink()

    replay = encoder.write_partition(
        records,
        descriptor,
        path,
        dataset_version="dsv_test",
        expected_absent=True,
        idempotency_key="cleaned-retry",
    )

    assert replay == first
    assert path.is_file()
    assert read_partition(path) == records


def test_double_uses_athena_compatible_float64_and_round_trips_decimal(tmp_path: Path) -> None:
    """A finite SQL DOUBLE cannot be narrowed to an Athena-incompatible decimal."""
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")
    record = normalize_row(
        descriptor,
        {
            "bts": 1_788_220_800_000,
            "source": "argus",
            "entity": "edge-a",
            "metric": "rpm",
            "value": 1e100,
        },
    )
    encoded = PyArrowParquetEncoder().write_partition(
        (record,),
        descriptor,
        tmp_path / "double.parquet",
        dataset_version="dsv_test",
        expected_absent=True,
        idempotency_key="double",
    )
    table = pq.read_table(encoded.path)

    assert table.schema.field("value").type == pa.float64()
    assert athena_schema(table.schema)["value"] == "double"


def test_canonical_decimal_envelope_remains_lossless_while_double_is_analytic(
    tmp_path: Path,
) -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")
    precise = Decimal("0.12345678901234567890123456789012345678")
    record = normalize_row(
        descriptor,
        {
            "bts": 1_788_220_800_000,
            "source": "argus",
            "entity": "edge",
            "metric": "rpm",
            "value": precise,
        },
    )
    encoded = PyArrowParquetEncoder().write_partition(
        (record,),
        descriptor,
        tmp_path / "precise.parquet",
        dataset_version="dsv",
        expected_absent=True,
        idempotency_key="precise",
    )
    row = pq.read_table(encoded.path).to_pylist()[0]

    assert read_partition(encoded.path) == (record,)
    assert row["measures"]["value"] == "0.12345678901234567890123456789012345678"
    assert row["recordId"] == record_id(record)
    assert row["payloadHash"] == payload_hash(record)


@pytest.mark.parametrize(
    ("left_value", "right_value", "expected_text"),
    [
        (Decimal("1.2300"), Decimal("1.23"), "1.23"),
        (Decimal("-0.0"), Decimal("0"), "0"),
        (Decimal("123E-2"), Decimal("1.23"), "1.23"),
    ],
)
def test_equivalent_decimals_produce_identical_utf8_envelopes(
    tmp_path: Path,
    left_value: Decimal,
    right_value: Decimal,
    expected_text: str,
) -> None:
    """Lexical Decimal variations cannot change canonical Parquet bytes or checksums."""
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")

    def archive(value: Decimal, name: str):
        record = normalize_row(
            descriptor,
            {
                "bts": 1_788_220_800_000,
                "source": "argus",
                "entity": "edge",
                "metric": "rpm",
                "value": value,
            },
        )
        encoded = PyArrowParquetEncoder().write_partition(
            (record,),
            descriptor,
            tmp_path / f"{name}.parquet",
            dataset_version="dsv",
            expected_absent=True,
            idempotency_key=name,
        )
        return record, encoded

    left_record, left = archive(left_value, "left")
    right_record, right = archive(right_value, "right")
    left_table = pq.read_table(left.path)

    assert left.path.read_bytes() == right.path.read_bytes()
    assert left.sha256 == right.sha256
    assert record_id(left_record) == record_id(right_record)
    assert payload_hash(left_record) == payload_hash(right_record)
    assert left_table.schema.field("measures").type.field("value").type == pa.string()
    assert left_table.to_pylist()[0]["measures"]["value"] == expected_text
    assert left_table.schema.field("value").type == pa.float64()


def test_athena_catalog_exposes_complete_typed_schema_for_all_datasets() -> None:
    """Dropping envelope columns would prevent Athena reconciliation and deduplication."""
    registry = DatasetRegistry.load_argus_v2()
    schemas = {
        descriptor.table: athena_schema_for_descriptor(descriptor) for descriptor in registry
    }

    assert set(schemas) == set(EXPECTED_ARGUS_V2_DATASETS)
    for descriptor in registry:
        catalog = schemas[descriptor.table]
        expected_names = _CANONICAL_ENVELOPE_NAMES | {column.name for column in descriptor.columns}
        assert set(catalog) == expected_names, descriptor.table
        assert catalog["recordId"] == "string"
        assert catalog["datasetVersion"] == "string"
        assert catalog["observedAt"] == "timestamp"
        assert catalog["qualityFlags"] == "array<string>"
        assert catalog["dimensions"].startswith("struct<")
        assert catalog["measures"].startswith("struct<")
        assert catalog["quality"].startswith("struct<")
        assert all("decimal(" not in field_type for field_type in catalog.values())

    assert schemas["signal_bucket"]["measures"] == "struct<value:string>"
    assert schemas["signal_bucket"]["value"] == "double"
    expected_json_types = {
        ("error_cat_hourly", "top_names"): "array<struct<name:string,errors:bigint>>",
        ("incidents", "child_incidents"): "array<string>",
        ("rpaas_run", "regions"): "array<string>",
        ("live_event_sde", "tids_jarvis"): "array<bigint>",
        ("live_event_sde", "tids_epg"): "array<bigint>",
        ("live_event_sde", "tid_only_epg"): "array<bigint>",
        ("live_event_sde", "tid_only_jarvis"): "array<bigint>",
        ("live_event_sde", "epg_teams"): "array<string>",
    }
    assert {key: schemas[key[0]][key[1]] for key in expected_json_types} == expected_json_types


def test_normalized_json_is_an_analytic_list_not_a_json_string(tmp_path: Path) -> None:
    """Normalized JSON arrays remain queryable columns for Athena instead of opaque TEXT."""
    descriptor = DatasetRegistry.load_argus_v2().require("live_event_sde")
    record = normalize_row(
        descriptor,
        {
            "sde_id": "sde-1",
            "team_home": "Home",
            "team_away": "Away",
            "competition": "Cup",
            "kickoff_ts": 1_788_220_800_000,
            "status": "finished",
            "is_finished": 1,
            "tids_jarvis": "[101,102]",
            "tids_epg": "[]",
            "tid_only_epg": "[]",
            "tid_only_jarvis": "[]",
            "name_mismatch": 0,
            "epg_teams": '["Home","Away"]',
            "updated_at": 1_788_220_800_000,
        },
    )
    encoded = PyArrowParquetEncoder().write_partition(
        (record,),
        descriptor,
        tmp_path / "json.parquet",
        dataset_version="dsv_test",
        expected_absent=True,
        idempotency_key="json",
    )
    table = pq.read_table(encoded.path)

    assert table.schema.field("tids_jarvis").type == pa.list_(
        pa.field("element", pa.int64(), nullable=False)
    )
    assert table.column("tids_jarvis").to_pylist() == [[101, 102]]
    assert athena_schema(table.schema)["tids_jarvis"] == "array<bigint>"


def test_spool_initialization_failure_removes_its_temporary_files(
    tmp_path: Path, monkeypatch
) -> None:
    """A failed SQLite setup may not leak a record spool beside the destination."""
    import adapters.archive.parquet as parquet_module

    descriptor, records = _app_error_records()

    def fail_connect(_path):
        raise RuntimeError("sqlite unavailable")

    monkeypatch.setattr(parquet_module.sqlite3, "connect", fail_connect)
    with pytest.raises(RuntimeError, match="sqlite unavailable"):
        PyArrowParquetEncoder().write_partition(
            records,
            descriptor,
            tmp_path / "part.parquet",
            dataset_version="dsv_test",
            expected_absent=True,
            idempotency_key="spool-init",
        )

    assert not list(tmp_path.glob(".parquet-records.*"))


def test_real_parquet_writer_fails_before_creating_a_spool_when_disk_budget_is_unavailable(
    tmp_path: Path,
) -> None:
    """The free-space preflight must happen before SQLite and Arrow can allocate."""
    descriptor, records = _app_error_records()
    budget = DiskBudget(tmp_path, 1024, free_bytes=lambda _path: 0)

    with pytest.raises(DiskBudgetExceeded, match="free disk"):
        PyArrowParquetEncoder().write_partition(
            records,
            descriptor,
            tmp_path / "budget.parquet",
            dataset_version="dsv_test",
            expected_absent=True,
            idempotency_key="disk-budget",
            disk_budget=budget,
        )

    assert not list(tmp_path.glob(".parquet-records.*"))


def test_post_link_unlink_failure_is_non_fatal_and_cleanup_retries(
    tmp_path: Path, monkeypatch
) -> None:
    """Once the final hard link exists, temp-name cleanup cannot report false failure."""
    descriptor, records = _app_error_records()
    encoder = PyArrowParquetEncoder()
    path = tmp_path / "published.parquet"
    original_unlink = Path.unlink
    failed_once = False

    def fail_first_temp_unlink(candidate: Path, *args, **kwargs):
        nonlocal failed_once
        if candidate.suffix == ".tmp" and not failed_once:
            failed_once = True
            raise OSError("post-publish unlink failed")
        return original_unlink(candidate, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_first_temp_unlink)

    encoded = encoder.write_partition(
        records,
        descriptor,
        path,
        dataset_version="dsv_test",
        expected_absent=True,
        idempotency_key="post-link",
    )
    replay = encoder.write_partition(
        records,
        descriptor,
        path,
        dataset_version="dsv_test",
        expected_absent=True,
        idempotency_key="post-link",
    )

    assert failed_once
    assert encoded == replay
    assert read_partition(path) == records
    assert not list(tmp_path.glob(".*.tmp"))


def test_writer_failure_preserves_root_cause_and_attempts_every_cleanup(
    tmp_path: Path, monkeypatch
) -> None:
    """A writer error must survive temp cleanup failure while all spool sidecars are tried."""
    import adapters.archive.parquet as parquet_module

    descriptor, records = _app_error_records()
    attempted: list[str] = []
    original_unlink = Path.unlink

    class FailingWriter:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def __enter__(self):
            raise RuntimeError("writer root")

        def __exit__(self, *args) -> None:
            pass

    def fail_selected_cleanup(candidate: Path, *args, **kwargs):
        attempted.append(candidate.name)
        if candidate.suffix == ".tmp" or candidate.name.endswith(".sqlite3"):
            raise OSError("cleanup failed")
        return original_unlink(candidate, *args, **kwargs)

    monkeypatch.setattr(parquet_module.pq, "ParquetWriter", FailingWriter)
    monkeypatch.setattr(Path, "unlink", fail_selected_cleanup)

    with pytest.raises(RuntimeError, match="writer root"):
        PyArrowParquetEncoder().write_partition(
            records,
            descriptor,
            tmp_path / "writer.parquet",
            dataset_version="dsv_test",
            expected_absent=True,
            idempotency_key="writer-root",
        )

    assert not (tmp_path / "writer.parquet").exists()
    assert any(name.endswith(".tmp") for name in attempted)
    assert any(name.endswith(".sqlite3") for name in attempted)
    assert any(name.endswith(".sqlite3-journal") for name in attempted)
    assert any(name.endswith(".sqlite3-wal") for name in attempted)
    assert any(name.endswith(".sqlite3-shm") for name in attempted)


@pytest.mark.parametrize("encoder_factory", [PyArrowParquetEncoder, FakeParquetEncoder])
def test_real_and_fake_reject_the_same_closed_canonical_shape(
    tmp_path: Path, encoder_factory
) -> None:
    """Application tests cannot accept a namespace that the real archive rejects."""
    descriptor, records = _app_error_records()
    invalid = replace(records[0], measures={**records[0].measures, "unexpected": 1})

    with pytest.raises(ValueError, match="closed canonical schema"):
        encoder_factory().write_partition(
            (invalid,),
            descriptor,
            tmp_path / f"{encoder_factory.__name__}.parquet",
            dataset_version="dsv_test",
            expected_absent=True,
            idempotency_key=f"invalid-{encoder_factory.__name__}",
        )


@pytest.mark.parametrize("encoder_factory", [PyArrowParquetEncoder, FakeParquetEncoder])
@pytest.mark.parametrize("invalid_field", ["coverage", "quality-flag"])
def test_real_and_fake_reject_required_nested_nulls_before_writer(
    tmp_path: Path, monkeypatch, encoder_factory, invalid_field: str
) -> None:
    """The common preflight must reject nested nulls without relying on ArrowWriter."""
    import adapters.archive.parquet as parquet_module

    descriptor, records = _app_error_records()
    if invalid_field == "coverage":
        invalid = replace(records[0], quality={"coveragePolicy": None})
        expected = "quality.coveragePolicy does not allow null"
    else:
        invalid = replace(records[0], quality_flags=(None,))  # type: ignore[arg-type]
        expected = "qualityFlags.element does not allow null"

    def writer_must_not_start(*args, **kwargs):
        raise AssertionError("writer started before validation")

    monkeypatch.setattr(parquet_module.pq, "ParquetWriter", writer_must_not_start)
    with pytest.raises(ValueError, match=expected):
        encoder_factory().write_partition(
            (invalid,),
            descriptor,
            tmp_path / f"{encoder_factory.__name__}-{invalid_field}.parquet",
            dataset_version="dsv_test",
            expected_absent=True,
            idempotency_key=f"nested-null-{encoder_factory.__name__}-{invalid_field}",
        )


@pytest.mark.parametrize("encoder_factory", [PyArrowParquetEncoder, FakeParquetEncoder])
def test_real_and_fake_reject_decimal_that_cannot_project_to_finite_double(
    tmp_path: Path, monkeypatch, encoder_factory
) -> None:
    """A finite canonical Decimal still cannot silently become infinity in SQL DOUBLE."""
    import adapters.archive.parquet as parquet_module

    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")
    record = normalize_row(
        descriptor,
        {
            "bts": 1_788_220_800_000,
            "source": "argus",
            "entity": "edge",
            "metric": "rpm",
            "value": Decimal("1"),
        },
    )
    invalid = replace(record, measures={"value": Decimal("1e10000")})

    def writer_must_not_start(*args, **kwargs):
        raise AssertionError("writer started before validation")

    monkeypatch.setattr(parquet_module.pq, "ParquetWriter", writer_must_not_start)
    with pytest.raises(ValueError, match="value must fit finite DOUBLE range"):
        encoder_factory().write_partition(
            (invalid,),
            descriptor,
            tmp_path / f"{encoder_factory.__name__}-overflow.parquet",
            dataset_version="dsv_test",
            expected_absent=True,
            idempotency_key=f"overflow-{encoder_factory.__name__}",
        )


def test_schema_is_compiled_once_and_rows_are_built_once_per_batch(
    tmp_path: Path, monkeypatch
) -> None:
    """Preflight must stay pure instead of recompiling Arrow work for every record."""
    import adapters.archive.parquet as parquet_module

    descriptor, records = _app_error_records()
    second = replace(
        records[0],
        natural_key=(
            ("timestamp", 1_788_220_800_000),
            ("error_code", "E-43"),
            ("manufacturer", "Acme"),
        ),
        dimensions={"errorCode": "E-43", "manufacturer": "Acme"},
    )
    schema_calls = 0
    row_calls = 0
    real_schema = parquet_module._schema
    real_row = parquet_module._row

    def tracked_schema(current_descriptor):
        nonlocal schema_calls
        schema_calls += 1
        return real_schema(current_descriptor)

    def tracked_row(*args, **kwargs):
        nonlocal row_calls
        row_calls += 1
        return real_row(*args, **kwargs)

    monkeypatch.setattr(parquet_module, "_schema", tracked_schema)
    monkeypatch.setattr(parquet_module, "_row", tracked_row)

    PyArrowParquetEncoder().write_partition(
        (records[0], second),
        descriptor,
        tmp_path / "single-compile.parquet",
        dataset_version="dsv_test",
        expected_absent=True,
        idempotency_key="single-compile",
    )

    assert schema_calls == 1
    assert row_calls == 2
