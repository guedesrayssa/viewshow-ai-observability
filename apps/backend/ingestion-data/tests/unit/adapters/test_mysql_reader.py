"""Verify MySQL source reads enforce ingestion paging and schema contracts."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal
from typing import Never

import pytest

from adapters.sources.mysql_live import MySqlLiveReader
from adapters.sources.mysql_reader import (
    MAX_PAGE_SIZE,
    MySqlConnectionSettings,
    MySqlSourceReader,
    build_page_query,
    quote_identifier,
)
from contracts.registry import DatasetRegistry
from domain.models import TimeWindow
from domain.quality import CoverageStatus


@pytest.fixture(scope="module")
def registry() -> DatasetRegistry:
    return DatasetRegistry.load_argus_v2()


@pytest.fixture(scope="module")
def settings() -> MySqlConnectionSettings:
    return MySqlConnectionSettings("127.0.0.1", 3306, "ingestion", "secret", "argus")


@pytest.fixture
def window() -> TimeWindow:
    return TimeWindow(
        datetime(2026, 8, 29, tzinfo=UTC),
        datetime(2026, 8, 30, tzinfo=UTC),
        900,
    )


def test_signal_bucket_query_uses_explicit_columns_window_and_keyset_without_offset(
    registry: DatasetRegistry, window: TimeWindow
) -> None:
    sql, params = build_page_query(
        registry.require("signal_bucket"),
        window,
        (1_788_000_000_000, "apollo", "edge-a", "requests"),
        500,
    )

    assert sql.startswith("SELECT `bts`, `source`, `entity`, `metric`, `value` FROM")
    assert "WHERE `bts` >= %s AND `bts` < %s" in sql
    assert (
        "(`bts` > %s OR (`bts` = %s AND `source` > %s) OR "
        "(`bts` = %s AND `source` = %s AND `entity` > %s) OR "
        "(`bts` = %s AND `source` = %s AND `entity` = %s AND `metric` > %s))"
    ) in sql
    assert "ORDER BY `bts`, `source`, `entity`, `metric`" in sql
    assert "OFFSET" not in sql.upper()
    assert "SELECT *" not in sql.upper()
    assert params == (
        1_787_961_600_000,
        1_788_048_000_000,
        1_788_000_000_000,
        1_788_000_000_000,
        "apollo",
        1_788_000_000_000,
        "apollo",
        "edge-a",
        1_788_000_000_000,
        "apollo",
        "edge-a",
        "requests",
        500,
    )


def test_page_query_adds_only_an_explicit_allowlisted_force_index(
    registry: DatasetRegistry,
) -> None:
    descriptor = registry.require("signal_bucket")

    snapshot_sql, _ = build_page_query(
        descriptor,
        None,
        None,
        100,
        forced_index="ix_ingestion_cursor",
    )
    live_sql, _ = build_page_query(descriptor, None, None, 100)

    assert "FROM `signal_bucket` FORCE INDEX (`ix_ingestion_cursor`)" in snapshot_sql
    assert "FORCE INDEX" not in live_sql


def test_page_query_rejects_a_forged_force_index(registry: DatasetRegistry) -> None:
    with pytest.raises(ValueError, match="identifier"):
        build_page_query(
            registry.require("signal_bucket"),
            None,
            None,
            100,
            forced_index="ix_ingestion_cursor; DROP TABLE live_event",
        )


def test_only_snapshot_reader_forces_the_prepared_cursor_index(
    registry: DatasetRegistry, settings: MySqlConnectionSettings
) -> None:
    statements: list[str] = []

    class CapturingSnapshotReader(MySqlSourceReader):
        def __init__(self):  # type: ignore[no-untyped-def]
            super().__init__(registry, settings, force_cursor_index=True)

        def _fetch_all(self, statement, parameters=()):  # type: ignore[no-untyped-def]
            del parameters
            statements.append(statement)
            return ()

    class CapturingLiveReader(MySqlLiveReader):
        def _fetch_all(self, statement, parameters=()):  # type: ignore[no-untyped-def]
            del parameters
            statements.append(statement)
            return ()

    descriptor = registry.require("live_event")
    CapturingSnapshotReader().read_page(descriptor, None, None, 10)
    CapturingLiveReader(registry, settings).read_page(descriptor, None, None, 10)

    assert "FORCE INDEX (`ix_ingestion_cursor`)" in statements[0]
    assert "FORCE INDEX" not in statements[1]


def test_identifier_with_sql_payload_is_rejected() -> None:
    with pytest.raises(ValueError, match="identifier"):
        quote_identifier("signal_bucket; DROP TABLE incidents")


@pytest.mark.parametrize("limit", [True, 0, -1, MAX_PAGE_SIZE + 1, 1.5])
def test_page_query_rejects_invalid_limit(registry: DatasetRegistry, limit: object) -> None:
    with pytest.raises((TypeError, ValueError), match="limit"):
        build_page_query(registry.require("signal_bucket"), None, None, limit)  # type: ignore[arg-type]


def test_page_query_rejects_cursor_shape_and_types(registry: DatasetRegistry) -> None:
    descriptor = registry.require("signal_bucket")

    with pytest.raises(ValueError, match="cursor shape"):
        build_page_query(descriptor, None, (1,), 100)
    with pytest.raises(TypeError, match="cursor.*bts"):
        build_page_query(descriptor, None, (True, "apollo", "edge-a", "requests"), 100)
    with pytest.raises(TypeError, match="cursor.*source"):
        build_page_query(descriptor, None, (1_788_000_000_000, 7, "edge-a", "requests"), 100)


@pytest.mark.parametrize("dataset", ("signal_meta", "live_event_sde"))
def test_page_query_rejects_window_for_snapshot_dataset(
    registry: DatasetRegistry, window: TimeWindow, dataset: str
) -> None:
    with pytest.raises(ValueError, match="snapshot"):
        build_page_query(registry.require(dataset), window, None, 100)


def test_iso_timestamp_window_uses_datetime_cast_not_lexical_comparison(
    registry: DatasetRegistry,
) -> None:
    sql, params = build_page_query(
        registry.require("apollo_run"),
        TimeWindow(
            datetime(2026, 8, 29, 10, 39, tzinfo=UTC),
            datetime(2026, 8, 29, 10, 40, tzinfo=UTC),
            60,
        ),
        None,
        100,
    )

    assert "CAST(`started_at` AS DATETIME(3)) >= %s" in sql
    assert "CAST(`started_at` AS DATETIME(3)) < %s" in sql
    assert params[:2] == ("2026-08-29 10:39:00.000", "2026-08-29 10:40:00.000")


def test_reader_rejects_forged_descriptor_before_connection(
    registry: DatasetRegistry, settings: MySqlConnectionSettings
) -> None:
    connection_attempts = 0

    def connect() -> Never:
        nonlocal connection_attempts
        connection_attempts += 1
        raise AssertionError("connection must not be opened")

    canonical = registry.require("signal_bucket")
    forged = replace(canonical, columns=canonical.columns[:-1])
    reader = MySqlSourceReader(registry, settings, connection_factory=connect)

    with pytest.raises(ValueError, match="registry"):
        reader.read_page(forged, None, None, 10)

    assert connection_attempts == 0


def test_live_reader_construction_does_not_open_connection(
    registry: DatasetRegistry, settings: MySqlConnectionSettings
) -> None:
    connection_attempts = 0

    def connect() -> Never:
        nonlocal connection_attempts
        connection_attempts += 1
        raise AssertionError("connection must not be opened")

    MySqlLiveReader(registry, settings, connection_factory=connect)

    assert connection_attempts == 0


def test_connection_settings_reject_invalid_port_and_empty_credentials() -> None:
    with pytest.raises(ValueError, match="port"):
        MySqlConnectionSettings("127.0.0.1", 0, "ingestion", "secret", "argus")
    with pytest.raises(ValueError, match="user"):
        MySqlConnectionSettings("127.0.0.1", 3306, "", "secret", "argus")
    with pytest.raises(ValueError, match="password"):
        MySqlConnectionSettings("127.0.0.1", 3306, "ingestion", "", "argus")


def test_connection_settings_default_to_shared_reader_policy() -> None:
    settings = MySqlConnectionSettings("127.0.0.1", 3306, "ingestion", "secret", "argus")

    assert settings.read_timeout_seconds == 30
    assert settings.write_timeout_seconds == 30
    assert settings.ddl_timeout_seconds == 1_800
    assert settings.query_max_attempts == 1
    assert settings.query_retry_base_ms == 250
    assert settings.query_retry_max_ms == 4_000


@pytest.mark.parametrize(
    ("field", "value"),
    (
        ("read_timeout_seconds", 0),
        ("read_timeout_seconds", 3_601),
        ("write_timeout_seconds", 0),
        ("write_timeout_seconds", 3_601),
        ("ddl_timeout_seconds", 0),
        ("ddl_timeout_seconds", 7_201),
        ("query_max_attempts", 0),
        ("query_max_attempts", 9),
        ("query_retry_base_ms", 0),
        ("query_retry_max_ms", 0),
    ),
)
def test_connection_settings_reject_invalid_resilience_policy_values(
    field: str, value: int
) -> None:
    with pytest.raises(ValueError, match=field):
        MySqlConnectionSettings(
            "127.0.0.1", 3306, "ingestion", "secret", "argus", **{field: value}
        )


def test_connection_settings_rejects_an_inverted_retry_window() -> None:
    with pytest.raises(ValueError, match="query_retry_base_ms"):
        MySqlConnectionSettings(
            "127.0.0.1",
            3306,
            "ingestion",
            "secret",
            "argus",
            query_retry_base_ms=251,
            query_retry_max_ms=250,
        )


def test_reader_passes_configured_read_and_write_timeouts_to_mysql_driver(
    registry: DatasetRegistry, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, object] = {}
    connection = object()

    def connect(**kwargs: object) -> object:
        captured.update(kwargs)
        return connection

    monkeypatch.setattr("adapters.sources.mysql_reader.pymysql.connect", connect)
    reader = MySqlSourceReader(
        registry,
        MySqlConnectionSettings(
            "127.0.0.1",
            3306,
            "ingestion",
            "secret",
            "argus",
            read_timeout_seconds=300,
            write_timeout_seconds=301,
        ),
    )

    assert reader._connect() is connection
    assert captured["read_timeout"] == 300
    assert captured["write_timeout"] == 301


def test_connection_settings_repr_and_str_do_not_expose_password() -> None:
    secret = "super-secret-marker"
    settings = MySqlConnectionSettings("127.0.0.1", 3306, "ingestion", secret, "argus")

    for rendered in (repr(settings), str(settings)):
        assert secret not in rendered
        assert "password" not in rendered.lower()


@pytest.mark.parametrize("dataset", ("signal_bucket", "signal_meta"))
def test_empty_but_queryable_table_has_complete_zero_coverage(
    registry: DatasetRegistry,
    settings: MySqlConnectionSettings,
    dataset: str,
) -> None:
    class EmptyReader(MySqlSourceReader):
        def _fetch_one(self, statement, parameters=()):  # type: ignore[no-untyped-def]
            del statement, parameters
            return {
                "row_count": 0,
                "timestamped_row_count": 0,
                "min_timestamp": None,
                "max_timestamp": None,
            }

    observation = EmptyReader(registry, settings).measure_coverage(registry.require(dataset))

    assert observation.status is CoverageStatus.COMPLETE
    assert observation.row_count == 0
    assert observation.observed_window is None


def test_bucket_dependency_with_a_middle_gap_is_not_reported_complete(
    registry: DatasetRegistry,
    settings: MySqlConnectionSettings,
) -> None:
    """Min/max timestamps must not turn missing canonical buckets into coverage."""

    class GapReader(MySqlSourceReader):
        statement = ""

        def _fetch_one(self, statement, parameters=()):  # type: ignore[no-untyped-def]
            del parameters
            self.statement = statement
            return {
                "row_count": 3,
                "timestamped_row_count": 3,
                "min_timestamp": 1_788_220_800_000,
                "max_timestamp": 1_788_222_600_000,
                "distinct_bucket_count": 2,
                "canonical_bucket_count": 2,
                "canonical_timestamped_row_count": 3,
            }

    reader = GapReader(registry, settings)
    observation = reader.measure_coverage(registry.require("signal_bucket"))

    assert observation.status is CoverageStatus.PARTIAL
    assert observation.coverage_numerator == 2
    assert observation.coverage_denominator == 3
    assert observation.latest_observed_at == datetime(2026, 9, 1, 0, 30, tzinfo=UTC)
    assert observation.verified_through is None
    assert "COUNT(DISTINCT `bts`) AS distinct_bucket_count" in reader.statement
    assert "COUNT(DISTINCT CASE WHEN MOD(`bts`, 900000) = 0" in reader.statement
    assert "MOD(`bts`, 900000)" in reader.statement


@pytest.mark.parametrize("value", [Decimal("0"), Decimal("3"), Decimal("900")])
def test_coverage_count_accepts_finite_integral_decimals(value: Decimal) -> None:
    from adapters.sources.mysql_reader import _coverage_count

    assert _coverage_count({"row_count": value}, "row_count") == int(value)


@pytest.mark.parametrize(
    "value", [Decimal("1.5"), Decimal("NaN"), Decimal("Infinity"), -Decimal("1")]
)
def test_coverage_count_rejects_non_count_decimals(value: Decimal) -> None:
    from adapters.sources.mysql_reader import _coverage_count

    with pytest.raises(ValueError, match="coverage query"):
        _coverage_count({"row_count": value}, "row_count")
