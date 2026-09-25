"""Verify snapshot cursor-index preparation against MySQL."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pymysql
import pytest
from pymysql.cursors import DictCursor

from adapters.sources.mysql_reader import MySqlConnectionSettings
from adapters.sources.mysql_snapshot_preparer import MySqlSnapshotPreparer
from contracts.registry import DatasetRegistry
from scripts.benchmark_snapshot_reader import restore_snapshot
from scripts.build_benchmark_snapshot import build_benchmark_snapshot
from tests.integration.mysql_test_config import mysql_test_host, mysql_test_port


@pytest.mark.mysql
def test_prepare_full_registry_after_restoring_complete_synthetic_fixture(
    tmp_path: Path,
) -> None:
    benchmark = tmp_path / "benchmark" / "argus_dump.sql.gz"
    minimal = tmp_path / "minimal" / "argus_dump.sql.gz"
    build_benchmark_snapshot(
        rows=10_030,
        snapshot_extracted_on=date(2026, 9, 1),
        variant="full-preflight",
        output=benchmark,
        manifest=tmp_path / "benchmark" / "manifest.json",
    )
    build_benchmark_snapshot(
        rows=29,
        snapshot_extracted_on=date(2026, 9, 1),
        variant="minimal-restore",
        output=minimal,
        manifest=tmp_path / "minimal" / "manifest.json",
    )
    registry = DatasetRegistry.load_argus_v2()
    settings = MySqlConnectionSettings(
        host=mysql_test_host(),
        port=mysql_test_port(),
        user="ingestion",
        password="ingestion-test-only",
        database="argus",
    )

    restore_snapshot(benchmark)
    try:
        evidence = MySqlSnapshotPreparer(registry, settings).prepare(tuple(registry))
    finally:
        restore_snapshot(minimal)

    assert len(evidence) == 23
    assert {item.dataset for item in evidence} == {item.table for item in registry}
    assert {item.dataset for item in evidence if item.created} == {
        "signal_bucket",
        "finding_status_log",
        "live_event",
    }


@pytest.mark.mysql
def test_prepare_creates_one_compatible_index_for_an_incompatible_primary_key() -> None:
    registry = DatasetRegistry.load_argus_v2()
    descriptor = registry.require("live_event")
    settings = MySqlConnectionSettings(
        host=mysql_test_host(),
        port=mysql_test_port(),
        user="ingestion",
        password="ingestion-test-only",
        database="argus",
    )
    connection = pymysql.connect(
        host=settings.host,
        port=settings.port,
        user=settings.user,
        password=settings.password,
        database=settings.database,
        autocommit=True,
        cursorclass=DictCursor,
    )
    renamed = False
    try:
        with connection.cursor() as cursor:
            cursor.execute("RENAME TABLE `live_event` TO `live_event_preparer_fixture`")
            renamed = True
            cursor.execute("CREATE TABLE `live_event` LIKE `live_event_preparer_fixture`")
            cursor.execute(
                "INSERT INTO `live_event` SELECT * FROM `live_event_preparer_fixture`"
            )
        preparer = MySqlSnapshotPreparer(registry, settings)
        first = preparer.prepare((descriptor,))
        second = preparer.prepare((descriptor,))
        with connection.cursor() as cursor:
            cursor.execute(
                """SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s AND INDEX_NAME = %s
ORDER BY SEQ_IN_INDEX""",
                (settings.database, descriptor.table, "ix_ingestion_cursor"),
            )
            rows = cursor.fetchall()
    finally:
        if renamed:
            with connection.cursor() as cursor:
                cursor.execute("DROP TABLE IF EXISTS `live_event`")
                cursor.execute(
                    "RENAME TABLE `live_event_preparer_fixture` TO `live_event`"
                )
        connection.close()

    assert first[0].created is True
    assert second[0].created is False
    assert tuple(row["COLUMN_NAME"] for row in rows) == descriptor.cursor_key
    assert {row["INDEX_NAME"] for row in rows} == {"ix_ingestion_cursor"}
