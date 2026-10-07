"""Verify benchmark dumps are bounded, deterministic and restorable."""

from __future__ import annotations

import gzip
import hashlib
import json
import re
from datetime import date
from pathlib import Path

import pymysql
import pytest

from contracts.registry import DatasetRegistry
from scripts.benchmark_snapshot_reader import restore_snapshot
from scripts.build_benchmark_snapshot import BenchmarkSnapshotError, build_benchmark_snapshot
from tests.integration.mysql_test_config import mysql_test_host, mysql_test_port


def _insert_sizes(sql: str, table: str) -> tuple[int, ...]:
    statements = re.findall(
        rf"INSERT INTO {re.escape(table)}\b.*?;",
        sql,
        flags=re.DOTALL,
    )
    return tuple(
        sum(1 for line in statement.splitlines() if line.lstrip().startswith("("))
        for statement in statements
    )


def _build(tmp_path: Path, name: str, *, rows: int, variant: str = "baseline") -> tuple[Path, Path]:
    output = tmp_path / name / "argus_dump.sql.gz"
    manifest = tmp_path / name / "manifest.json"
    build_benchmark_snapshot(
        rows=rows,
        snapshot_extracted_on=date(2026, 9, 1),
        variant=variant,
        output=output,
        manifest=manifest,
    )
    return output, manifest


@pytest.mark.mysql
def test_benchmark_snapshot_is_deterministic_and_restores_all_1003_rows(
    tmp_path: Path,
) -> None:
    first, first_manifest_path = _build(tmp_path, "first", rows=1_003)
    second, _ = _build(tmp_path, "second", rows=1_003)
    changed, changed_manifest_path = _build(
        tmp_path,
        "changed",
        rows=1_003,
        variant="retry-canary",
    )

    first_bytes = first.read_bytes()
    first_manifest = json.loads(first_manifest_path.read_text(encoding="utf-8"))
    changed_manifest = json.loads(changed_manifest_path.read_text(encoding="utf-8"))
    assert first_bytes == second.read_bytes()
    assert first_manifest == {
        "compressedBytes": len(first_bytes),
        "rowCount": 1_003,
        "sha256": hashlib.sha256(first_bytes).hexdigest(),
        "snapshotExtractedOn": "2026-09-01",
        "tableCounts": first_manifest["tableCounts"],
        "variant": "baseline",
    }
    assert len(first_manifest["tableCounts"]) == 23
    assert sum(first_manifest["tableCounts"].values()) == 1_003
    assert all(count >= 1 for count in first_manifest["tableCounts"].values())
    assert changed.read_bytes() != first_bytes
    assert changed_manifest["sha256"] != first_manifest["sha256"]

    restore_snapshot(first)
    connection = pymysql.connect(
        host=mysql_test_host(),
        port=mysql_test_port(),
        user="ingestion",
        password="ingestion-test-only",
        database="argus",
        autocommit=True,
    )
    try:
        observed: dict[str, int] = {}
        with connection.cursor() as cursor:
            for descriptor in DatasetRegistry.load_argus_v2():
                cursor.execute(f"SELECT COUNT(*) FROM `{descriptor.table}`")
                row = cursor.fetchone()
                assert row is not None
                observed[descriptor.table] = int(row[0])
    finally:
        connection.close()

    assert observed == first_manifest["tableCounts"]
    assert sum(observed.values()) == 1_003


def test_benchmark_snapshot_caps_each_insert_at_1000_rows(tmp_path: Path) -> None:
    output, _ = _build(tmp_path, "bounded", rows=2_030)

    with gzip.open(output, "rt", encoding="utf-8") as stream:
        sizes = _insert_sizes(stream.read(), "signal_bucket")

    assert sizes[-3:] == (1_000, 1_000, 1)
    assert max(sizes) <= 1_000


def _build_windowed(tmp_path: Path, *, rows: int, rows_per_window: int) -> tuple[Path, Path]:
    output = tmp_path / "windowed" / "argus_dump.sql.gz"
    manifest = tmp_path / "windowed" / "manifest.json"
    build_benchmark_snapshot(
        rows=rows,
        snapshot_extracted_on=date(2026, 9, 1),
        variant="baseline",
        output=output,
        manifest=manifest,
        rows_per_window=rows_per_window,
    )
    return output, manifest


def test_rows_per_window_shares_aligned_buckets_with_distinct_entities(tmp_path: Path) -> None:
    output, manifest_path = _build_windowed(tmp_path, rows=2_030, rows_per_window=1_000)

    with gzip.open(output, "rt", encoding="utf-8") as stream:
        rows = re.findall(
            r"^    \((\d+), 'benchmark-baseline', '([^']+)', 'row-count'",
            stream.read(),
            flags=re.MULTILINE,
        )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    buckets = [int(bucket) for bucket, _ in rows]

    assert manifest["rowsPerWindow"] == 1_000
    assert all(bucket % 900_000 == 0 for bucket in buckets)
    assert len(set(buckets)) == 3
    assert buckets[0] == buckets[999] != buckets[1_000]
    assert len(set(rows)) == len(rows)
    assert rows[0][1] == rows[1_000][1] == "benchmark-baseline-000000"


def test_rows_per_window_must_be_positive(tmp_path: Path) -> None:
    with pytest.raises(BenchmarkSnapshotError):
        _build_windowed(tmp_path, rows=1_003, rows_per_window=0)
