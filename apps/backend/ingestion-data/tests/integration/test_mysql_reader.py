"""Verify keyset reads and physical-contract validation against MySQL."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime

import pytest

from adapters.sources.mysql_reader import MySqlConnectionSettings, MySqlSourceReader
from contracts.argus.v2.normalizers import normalize_row
from contracts.registry import DatasetRegistry
from domain.datasets import DatasetColumn
from domain.models import TimeWindow
from domain.quality import CoverageStatus
from tests.integration.mysql_test_config import mysql_test_host, mysql_test_port


@pytest.fixture(scope="module")
def registry() -> DatasetRegistry:
    return DatasetRegistry.load_argus_v2()


@pytest.fixture(scope="module")
def mysql_settings() -> MySqlConnectionSettings:
    return MySqlConnectionSettings(
        host=mysql_test_host(),
        port=mysql_test_port(),
        user="ingestion",
        password="ingestion-test-only",
        database="argus",
    )


@pytest.fixture(scope="module")
def mysql_reader(
    registry: DatasetRegistry, mysql_settings: MySqlConnectionSettings
) -> MySqlSourceReader:
    return MySqlSourceReader(registry, mysql_settings)


@pytest.mark.mysql
def test_mysql_reader_pages_fixture_in_cursor_order_without_duplicates(
    mysql_reader: MySqlSourceReader, registry: DatasetRegistry
) -> None:
    descriptor = registry.require("signal_bucket")
    first = mysql_reader.read_page(descriptor, None, None, 2)
    second = mysql_reader.read_page(descriptor, None, first.next_cursor, 2)
    keys = [
        tuple(row[field] for field in descriptor.cursor_key) for row in first.rows + second.rows
    ]

    assert keys == sorted(keys)
    assert len(keys) == len(set(keys)) == 3
    assert first.next_cursor == keys[1]
    assert second.next_cursor == keys[2]


@pytest.mark.mysql
def test_mysql_reader_applies_half_open_window(mysql_reader: MySqlSourceReader) -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")
    page = mysql_reader.read_page(
        descriptor,
        TimeWindow(
            datetime.fromtimestamp(1_787_997_600_000 / 1000, UTC),
            datetime.fromtimestamp(1_787_998_500_000 / 1000, UTC),
            900,
        ),
        None,
        10,
    )

    assert tuple(row["bts"] for row in page.rows) == (1_787_997_600_000,)


@pytest.mark.mysql
def test_mysql_reader_excludes_iso_timestamp_at_window_end(
    mysql_reader: MySqlSourceReader, registry: DatasetRegistry
) -> None:
    page = mysql_reader.read_page(
        registry.require("apollo_run"),
        TimeWindow(
            datetime(2026, 8, 29, 10, 39, tzinfo=UTC),
            datetime(2026, 8, 29, 10, 40, tzinfo=UTC),
            60,
        ),
        None,
        10,
    )

    assert page.rows == ()


@pytest.mark.mysql
def test_mysql_reader_validates_all_allowlisted_physical_schemas(
    mysql_reader: MySqlSourceReader, registry: DatasetRegistry
) -> None:
    observations = tuple(mysql_reader.validate_schema(descriptor) for descriptor in registry)

    assert len(observations) == 23
    assert all(observation.is_compatible for observation in observations)
    assert all(observation.differences == () for observation in observations)
    assert all(len(observation.fingerprint) == 64 for observation in observations)
    assert all(mysql_reader.read_page(descriptor, None, None, 1).rows for descriptor in registry)


@pytest.mark.mysql
def test_schema_validation_detects_name_type_nullability_order_and_primary_key_drift(
    registry: DatasetRegistry, mysql_settings: MySqlConnectionSettings
) -> None:
    canonical = registry.require("signal_bucket")
    variants = (
        replace(
            canonical,
            columns=canonical.columns[:-1] + (DatasetColumn("amount", "DOUBLE", False),),
        ),
        replace(
            canonical,
            columns=canonical.columns[:-1] + (DatasetColumn("value", "BIGINT", False),),
        ),
        replace(
            canonical,
            columns=canonical.columns[:-1] + (DatasetColumn("value", "DOUBLE", True),),
        ),
        replace(
            canonical,
            columns=canonical.columns[:3] + (canonical.columns[4], canonical.columns[3]),
        ),
        replace(canonical, natural_key=("bts", "source", "entity", "metric")),
    )
    canonical_fingerprint = (
        MySqlSourceReader(registry, mysql_settings).validate_schema(canonical).fingerprint
    )

    observations = []
    for variant in variants:
        variant_registry = DatasetRegistry(
            (variant,), registry.schema_fingerprint, registry.snapshot
        )
        observations.append(
            MySqlSourceReader(variant_registry, mysql_settings).validate_schema(variant)
        )

    assert all(not observation.is_compatible for observation in observations)
    assert all(observation.differences for observation in observations)
    assert {observation.fingerprint for observation in observations} == {canonical_fingerprint}


@pytest.mark.mysql
def test_mysql_reader_measures_time_and_snapshot_coverage(
    mysql_reader: MySqlSourceReader, registry: DatasetRegistry
) -> None:
    signal = mysql_reader.measure_coverage(registry.require("signal_bucket"))
    apollo = mysql_reader.measure_coverage(registry.require("apollo_run"))
    metadata = mysql_reader.measure_coverage(registry.require("signal_meta"))
    sde = mysql_reader.measure_coverage(registry.require("live_event_sde"))

    assert signal.status is CoverageStatus.COMPLETE
    assert signal.row_count == 3
    assert signal.observed_window is not None
    assert int(signal.observed_window.start.timestamp() * 1000) == 1_787_997_600_000
    assert int(signal.observed_window.end.timestamp() * 1000) == 1_788_000_300_000
    assert apollo.status is CoverageStatus.COMPLETE
    assert apollo.observed_window is not None
    assert apollo.observed_window.start == datetime(2026, 8, 29, 10, 40, tzinfo=UTC)
    assert apollo.observed_window.end == datetime(2026, 8, 29, 10, 40, 1, tzinfo=UTC)
    assert metadata == metadata.__class__(CoverageStatus.COMPLETE, 2, None)
    assert sde == sde.__class__(CoverageStatus.COMPLETE, 2, None)


@pytest.mark.mysql
def test_mysql_reader_builds_snapshot_normalization_context(
    mysql_reader: MySqlSourceReader, registry: DatasetRegistry
) -> None:
    context = mysql_reader.build_normalization_context()
    error_rows = mysql_reader.read_page(registry.require("error_cat_hourly"), None, None, 10).rows
    event_rows = mysql_reader.read_page(registry.require("live_event"), None, None, 10).rows

    error_records = tuple(
        normalize_row(registry.require("error_cat_hourly"), row, context) for row in error_rows
    )
    event_records = tuple(
        normalize_row(registry.require("live_event"), row, context) for row in event_rows
    )

    assert context.bot_reliable_from_ms == 1_788_004_800_000
    assert context.valid_sde_ids == frozenset({"sde-fixture-001", "sde-fixture-002"})
    assert error_records[0].measures["humanErrors"] is None
    assert error_records[1].measures["humanErrors"] == 7
    assert tuple(record.quality["sportsMatchStatus"] for record in event_records) == (
        "matched_by_sde_id",
        "unmatched",
    )
