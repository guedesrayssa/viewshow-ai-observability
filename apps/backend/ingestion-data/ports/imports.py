"""Ports for consuming a pinned staging upload and producing a candidate."""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Protocol

from domain.run import RunPipeline

if TYPE_CHECKING:
    from application.backfill import RunResult
    from scripts.upload_snapshot import SnapshotUploadResult


class StagingDownloader(Protocol):
    def download(
        self,
        bucket: str,
        key: str,
        destination: Path,
        *,
        version_id: str,
        expected_size: int,
        part_size_bytes: int,
        expected_part_count: int,
    ) -> None: ...


class SnapshotPromoter(Protocol):
    def promote(self, path: Path, *, snapshot_extracted_on: date) -> SnapshotUploadResult: ...


class CandidateBackfillRunner(Protocol):
    def run(
        self,
        snapshot: SnapshotUploadResult,
        *,
        import_id: str,
        snapshot_extracted_on: date,
        activate: Literal[False],
        pipeline: RunPipeline,
        materialize_hot_records: bool,
    ) -> RunResult: ...
