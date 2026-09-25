"""Manifest interval summaries keep sparse canonical history activatable."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

from application.bucket_evidence import BucketEvidence
from domain.models import RecordType
from tests.unit.application.test_projections import record


def test_sparse_manifest_intervals_are_compacted_with_an_explicit_quality_flag(
    tmp_path: Path,
) -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    records = tuple(
        replace(
            record(
                "live_event",
                RecordType.LIVE_EVENT_CONTEXT,
                observed_at=start + timedelta(days=index),
                grain_seconds=None,
            ),
            natural_key=(("event_id", index),),
        )
        for index in range(257)
    )
    evidence = BucketEvidence(tmp_path)
    try:
        evidence.add("live_event", records)

        intervals, watermark, quality_flags = evidence.intervals("live_event")
    finally:
        evidence.close()

    assert intervals == [
        {
            "start": "2026-01-01T00:00:00.000Z",
            "end": "2026-09-14T00:00:00.001Z",
        }
    ]
    assert watermark == "2026-09-14T00:00:00.001Z"
    assert quality_flags == ("SPARSE_INTERVALS_COMPACTED",)


def test_small_sparse_manifest_keeps_exact_intervals_without_quality_flag(
    tmp_path: Path,
) -> None:
    first = datetime(2026, 1, 1, tzinfo=UTC)
    records = tuple(
        record(
            "live_event",
            RecordType.LIVE_EVENT_CONTEXT,
            observed_at=first + timedelta(days=index),
            grain_seconds=None,
        )
        for index in range(2)
    )
    evidence = BucketEvidence(tmp_path)
    try:
        evidence.add("live_event", records)

        intervals, _watermark, quality_flags = evidence.intervals("live_event")
    finally:
        evidence.close()

    assert len(intervals) == 2
    assert quality_flags == ()
