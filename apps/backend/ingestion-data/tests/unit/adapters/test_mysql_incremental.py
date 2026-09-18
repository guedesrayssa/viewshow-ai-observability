"""Verify raw incremental MySQL exports preserve observed columns safely."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime

import pytest

from adapters.sources.mysql_incremental import MySqlIncrementalExportSource
from adapters.sources.mysql_reader import MySqlConnectionSettings
from contracts.registry import DatasetRegistry
from domain.incremental_batches import PhysicalColumn
from domain.models import TimeWindow


class RecordingConnection:
    def __init__(self, responses: list[tuple[Mapping[str, object], ...]]) -> None:
        self.executions: list[tuple[str, tuple[object, ...]]] = []
        self._responses = responses

    def cursor(self, _cursor_type: object) -> RecordingConnection:
        return self

    def __enter__(self) -> RecordingConnection:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def execute(self, statement: str, parameters: tuple[object, ...]) -> None:
        self.executions.append((statement, parameters))

    def fetchall(self) -> list[Mapping[str, object]]:
        return list(self._responses.pop(0))

    def close(self) -> None:
        return None


@pytest.fixture
def registry() -> DatasetRegistry:
    return DatasetRegistry.load_argus_v2()


def _settings() -> MySqlConnectionSettings:
    return MySqlConnectionSettings("127.0.0.1", 3306, "reader", "secret", "argus")


def _column_rows(
    descriptor_columns: tuple[tuple[str, str, str, int], ...],
) -> tuple[Mapping[str, object], ...]:
    return tuple(
        {
            "COLUMN_NAME": name,
            "COLUMN_TYPE": physical_type.lower(),
            "IS_NULLABLE": nullable,
            "ORDINAL_POSITION": ordinal,
        }
        for name, physical_type, nullable, ordinal in descriptor_columns
    )


def _observed_columns() -> tuple[tuple[str, str, str, int], ...]:
    return (
        ("bucket_ts", "BIGINT", "NO", 1),
        ("sinal", "VARCHAR(64)", "NO", 2),
        ("active_sessions", "BIGINT", "NO", 3),
        ("active_with_error", "BIGINT", "NO", 4),
        ("joins_in_bucket", "BIGINT", "NO", 5),
        ("latency_ms_p50", "DOUBLE", "YES", 6),
        ("latency_ms_p95", "DOUBLE", "YES", 7),
        ("bufferratio_avg", "DOUBLE", "YES", 8),
        ("jointime_s_avg", "DOUBLE", "YES", 9),
        ("dropped_frames_avg", "DOUBLE", "YES", 10),
        ("nova_coluna", "VARCHAR(64)", "YES", 11),
    )


def test_observe_schema_keeps_allowlisted_columns_and_supported_extras(
    registry: DatasetRegistry,
) -> None:
    """Dropping additive source columns would make a raw batch irrecoverable."""
    connection = RecordingConnection([_column_rows(_observed_columns())])
    reader = MySqlIncrementalExportSource(
        registry, _settings(), connection_factory=lambda: connection  # type: ignore[arg-type]
    )

    columns = reader.observe_schema(registry.require("live_active_15min"))

    assert columns[-1] == PhysicalColumn("nova_coluna", "VARCHAR(64)", True, 11)


def test_read_page_selects_observed_columns_but_filters_with_known_window_and_cursor(
    registry: DatasetRegistry,
) -> None:
    """Selecting raw extras must not let them influence the trusted keyset predicate."""
    connection = RecordingConnection([_column_rows(_observed_columns()), ()])
    reader = MySqlIncrementalExportSource(
        registry, _settings(), connection_factory=lambda: connection  # type: ignore[arg-type]
    )
    descriptor = registry.require("live_active_15min")
    reader.observe_schema(descriptor)

    reader.read_page(
        descriptor,
        TimeWindow(datetime(2026, 9, 1, tzinfo=UTC), datetime(2026, 9, 1, 0, 15, tzinfo=UTC), 900),
        None,
        500,
    )

    statement, parameters = connection.executions[-1]
    assert "`nova_coluna`" in statement
    assert "`bucket_ts` >= %s AND `bucket_ts` < %s" in statement
    assert "ORDER BY `bucket_ts`, `sinal`" in statement
    assert parameters[-1] == 500


def test_read_page_rejects_rows_that_do_not_match_the_observed_schema(
    registry: DatasetRegistry,
) -> None:
    """A database response omitting an observed raw field cannot be encoded faithfully."""
    row = {name: 1 for name, _, _, _ in _observed_columns()}
    row["sinal"] = "fiber"
    row.pop("nova_coluna")
    connection = RecordingConnection([_column_rows(_observed_columns()), (row,)])
    reader = MySqlIncrementalExportSource(
        registry, _settings(), connection_factory=lambda: connection  # type: ignore[arg-type]
    )
    descriptor = registry.require("live_active_15min")
    reader.observe_schema(descriptor)

    with pytest.raises(ValueError, match="source row shape"):
        reader.read_page(
            descriptor,
            TimeWindow(
                datetime(2026, 9, 1, tzinfo=UTC),
                datetime(2026, 9, 1, 0, 15, tzinfo=UTC),
                900,
            ),
            None,
            500,
        )
