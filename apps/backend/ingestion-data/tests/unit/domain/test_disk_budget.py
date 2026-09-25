"""Verify ingestion disk-budget accounting prevents unsafe local exhaustion."""

from __future__ import annotations

import errno
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from application.bucket_evidence import BucketEvidence
from contracts.argus.v2.normalizers import NormalizationContext, normalize_row
from contracts.registry import DatasetRegistry
from domain.disk_budget import (
    FARGATE_EPHEMERAL_STORAGE_BYTES,
    MAX_INGESTION_DISK_BUDGET_BYTES,
    DiskBudget,
    DiskBudgetExceeded,
)
from domain.models import TimeWindow


class DiskUsageRecorder:
    def __init__(self) -> None:
        self.calls: list[tuple[int, int, int, str]] = []

    def report_disk_usage(
        self,
        current_bytes: int,
        peak_bytes: int,
        budget_bytes: int,
        *,
        reason: str,
    ) -> None:
        self.calls.append((current_bytes, peak_bytes, budget_bytes, reason))


def test_disk_budget_accepts_the_exact_limit_then_rejects_the_next_byte(tmp_path: Path) -> None:
    budget = DiskBudget(tmp_path, 16, free_bytes=lambda _path: 16)

    budget.preflight("test workspace")
    budget.reserve(16, "exact allocation")
    (tmp_path / "records.jsonl").write_bytes(b"x" * 16)

    usage = budget.observe()

    assert usage.used_bytes == 16
    assert usage.peak_bytes == 16
    assert usage.artifacts == {"jsonlBytes": 16}
    with pytest.raises(DiskBudgetExceeded, match="disk budget"):
        budget.reserve(1, "one byte too many")


def test_disk_budget_preflight_rejects_a_cap_larger_than_free_space(tmp_path: Path) -> None:
    snapshot_budget = 64 * 1024**3
    budget = DiskBudget(
        tmp_path,
        snapshot_budget,
        free_bytes=lambda _path: snapshot_budget - 1,
    )

    with pytest.raises(DiskBudgetExceeded, match="free disk"):
        budget.preflight("snapshot restore and extraction")


def test_disk_budget_reports_observe_reserve_heartbeat_and_fatal_snapshots(
    tmp_path: Path,
) -> None:
    recorder = DiskUsageRecorder()
    budget = DiskBudget(
        tmp_path,
        100,
        free_bytes=lambda _path: 1_000,
        usage_reporter=recorder,
    )
    artifact = tmp_path / "records.jsonl"

    artifact.write_bytes(b"x" * 79)
    budget.observe()
    artifact.write_bytes(b"x" * 81)
    budget.reserve(1, "next batch")
    artifact.write_bytes(b"x" * 91)
    budget.heartbeat()
    artifact.write_bytes(b"x" * 101)
    with pytest.raises(DiskBudgetExceeded, match="configured budget"):
        budget.observe()

    assert recorder.calls == [
        (79, 79, 100, "observe"),
        (81, 81, 100, "reserve"),
        (91, 91, 100, "heartbeat"),
        (101, 101, 100, "fatal"),
    ]


def test_failed_reservation_reports_current_and_peak_before_raising(tmp_path: Path) -> None:
    recorder = DiskUsageRecorder()
    budget = DiskBudget(
        tmp_path,
        100,
        free_bytes=lambda _path: 1_000,
        usage_reporter=recorder,
    )
    (tmp_path / "records.jsonl").write_bytes(b"x" * 95)

    with pytest.raises(DiskBudgetExceeded, match="next batch"):
        budget.reserve(6, "next batch")

    assert recorder.calls[-1] == (95, 95, 100, "fatal")


def test_free_space_probe_failure_reports_fatal_without_escaping_report_fatal(
    tmp_path: Path,
) -> None:
    recorder = DiskUsageRecorder()

    def unavailable(_path: Path) -> int:
        raise OSError("probe unavailable")

    budget = DiskBudget(
        tmp_path,
        100,
        free_bytes=unavailable,
        usage_reporter=recorder,
    )

    with pytest.raises(DiskBudgetExceeded, match="filesystem free space"):
        budget.observe()
    budget.report_fatal()

    assert recorder.calls == [(0, 0, 100, "fatal")]


def test_disk_scan_ignores_only_an_entry_that_disappears_before_lstat(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stable = tmp_path / "stable.jsonl"
    disappearing = tmp_path / "disappearing.parquet"
    stable.write_bytes(b"stable")
    disappearing.write_bytes(b"gone")
    original_lstat = Path.lstat

    def concurrent_lstat(path: Path, *args: object, **kwargs: object):
        if path == disappearing:
            raise FileNotFoundError(errno.ENOENT, "entry disappeared", path)
        return original_lstat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", concurrent_lstat)
    usage = DiskBudget(tmp_path, 100, free_bytes=lambda _path: 1_000).observe()

    assert usage.used_bytes == len(b"stable")
    assert usage.artifacts == {"jsonlBytes": len(b"stable")}


@pytest.mark.parametrize("failure", [PermissionError(errno.EACCES), OSError(errno.EIO)])
def test_disk_scan_keeps_non_enoent_lstat_failures_fatal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: OSError,
) -> None:
    target = tmp_path / "unreadable.jsonl"
    target.write_bytes(b"data")
    original_lstat = Path.lstat

    def failing_lstat(path: Path, *args: object, **kwargs: object):
        if path == target:
            raise failure
        return original_lstat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", failing_lstat)

    with pytest.raises(DiskBudgetExceeded, match="ingestion-owned disk artifacts") as captured:
        DiskBudget(tmp_path, 100, free_bytes=lambda _path: 1_000).observe()

    assert captured.value.__cause__ is failure


def test_disk_budget_rejects_a_budget_above_the_fargate_ingestion_ceiling(tmp_path: Path) -> None:
    assert MAX_INGESTION_DISK_BUDGET_BYTES == 128 * 1024**3

    with pytest.raises(ValueError, match="128"):
        DiskBudget(tmp_path, MAX_INGESTION_DISK_BUDGET_BYTES + 1)


def test_documented_fargate_capacity_matches_the_provisioned_import_task() -> None:
    assert FARGATE_EPHEMERAL_STORAGE_BYTES == 200 * 1024**3


def test_sqlite_evidence_fails_before_creating_a_default_sized_database_at_four_kib(
    tmp_path: Path,
) -> None:
    budget = DiskBudget(tmp_path, 4096, free_bytes=lambda _path: 4096)

    with pytest.raises(DiskBudgetExceeded, match="SQLite initialization"):
        BucketEvidence(tmp_path, disk_budget=budget)

    assert not list(tmp_path.glob(".bucket-evidence.*"))


def test_bucket_evidence_persists_only_a_bounded_tail_after_a_long_scan(tmp_path: Path) -> None:
    registry = DatasetRegistry.load_argus_v2()
    descriptor = registry.require("signal_bucket")
    fixture_path = Path(__file__).parents[2] / "fixtures" / "argus_v2_legacy_rows.json"
    row = json.loads(fixture_path.read_text(encoding="utf-8"))["signal_bucket"]
    assert isinstance(row, dict)
    start = datetime(2026, 9, 1, tzinfo=UTC)
    records = tuple(
        normalize_row(
            descriptor,
            {**row, "bts": int((start + timedelta(minutes=15 * offset)).timestamp() * 1000)},
            NormalizationContext(),
        )
        for offset in range(2_001)
    )
    evidence = BucketEvidence(tmp_path)
    try:
        evidence.add("signal_bucket", records)
        tail = evidence.snapshot("signal_bucket", horizon_seconds=3600)

        assert len(tail) == 1
        assert tail[0][1] == int((start + timedelta(minutes=15 * 1_997)).timestamp() * 1000)
        assert tail[-1][2] == int((start + timedelta(minutes=15 * 2_001)).timestamp() * 1000)
        assert evidence.requested_complete_window(
            ("signal_bucket",),
            TimeWindow(start, start + timedelta(minutes=15 * 2_001), 900),
            900,
        ) == TimeWindow(start, start + timedelta(minutes=15 * 2_001), 900)
    finally:
        evidence.close()


def test_bucket_evidence_restores_a_legacy_raw_tail_then_compacts_it(tmp_path: Path) -> None:
    start = datetime(2026, 9, 1, tzinfo=UTC)
    start_ms = int(start.timestamp() * 1000)
    intervals = tuple(
        ("signal_bucket", start_ms + offset * 900_000, start_ms + (offset + 1) * 900_000, 900)
        for offset in range(1_500)
    )
    evidence = BucketEvidence(tmp_path)
    try:
        evidence.restore(intervals)

        assert evidence.requested_complete_window(
            ("signal_bucket",),
            TimeWindow(start, start + timedelta(minutes=15 * 1_500), 900),
            900,
        ) == TimeWindow(start, start + timedelta(minutes=15 * 1_500), 900)
        assert len(evidence.snapshot("signal_bucket", horizon_seconds=3600)) == 1
    finally:
        evidence.close()
