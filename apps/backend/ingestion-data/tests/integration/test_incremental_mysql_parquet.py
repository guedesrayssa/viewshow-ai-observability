"""Verify an observed MySQL page can be encoded as a raw Parquet batch."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pyarrow.parquet as pq
import pytest

from adapters.incremental.parquet import RawParquetCodec
from adapters.sources.mysql_incremental import MySqlIncrementalExportSource
from adapters.sources.mysql_reader import MySqlConnectionSettings
from contracts.registry import DatasetRegistry
from domain.models import TimeWindow
from tests.integration.mysql_test_config import mysql_test_host, mysql_test_port


@pytest.mark.integration
@pytest.mark.mysql
def test_observed_mysql_columns_round_trip_as_raw_parquet(tmp_path: Path) -> None:
    """A raw export must retain the source schema rather than the canonical fact shape."""
    registry = DatasetRegistry.load_argus_v2()
    descriptor = registry.require("live_active_15min")
    source = MySqlIncrementalExportSource(
        registry,
        MySqlConnectionSettings(
            mysql_test_host(), mysql_test_port(), "ingestion", "ingestion-test-only", "argus"
        ),
    )

    columns = source.observe_schema(descriptor)
    page = source.read_page(
        descriptor,
        TimeWindow(datetime(2026, 9, 1, tzinfo=UTC), datetime(2026, 9, 1, 0, 15, tzinfo=UTC), 900),
        None,
        1,
    )
    encoded = RawParquetCodec().encode(columns, page.rows, tmp_path / "raw.parquet")

    assert pq.read_table(encoded.path).column_names == [column.name for column in columns]
    assert encoded.row_count == len(page.rows)
