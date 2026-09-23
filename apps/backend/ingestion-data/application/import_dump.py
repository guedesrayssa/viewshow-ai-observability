"""Claim an uploaded dump, promote its immutable snapshot, and build a candidate."""

from __future__ import annotations

import os
import shutil
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from adapters.archive.athena import AthenaQueryError
from adapters.archive.glue import GlueCatalogError
from adapters.archive.s3 import ArchiveChecksumMismatch, ArchiveStorageError
from adapters.archive.s3_canonical_sets import (
    CanonicalSetChecksumMismatch,
    CanonicalSetConflict,
    CanonicalSetEvidenceError,
    CanonicalSetStorageError,
)
from adapters.dynamodb.client import DynamoDbThrottled
from adapters.sources.mysql_retry import MySqlQueryRetriesExhausted
from adapters.sources.mysql_snapshot_preparer import QueryPlanInvalid
from application.archive_partition import ArchivePublicationError
from application.backfill import DataReconciliationError, RunResult, SourceSchemaInvalid
from domain.disk_budget import DiskBudgetExceeded
from domain.import_job import (
    PUBLIC_IMPORT_ERROR_MESSAGES,
    ImportJobRepository,
    ImportState,
    ImportStateConflict,
    import_request_id,
    validate_import_id,
)
from domain.run import RunStage, materialize_hot_records_for
from ports import ArchiveReconciliationError, SnapshotChecksumMismatch
from ports.imports import CandidateBackfillRunner, SnapshotPromoter, StagingDownloader
from scripts.upload_snapshot import DEFAULT_UPLOAD_LIMITS, SnapshotUploadError


def import_run_id(import_id: str) -> str:
    return "run_import_" + validate_import_id(import_id).removeprefix("imp_")


@dataclass(frozen=True, slots=True)
class ImportFailure:
    code: str
    message: str
    stage: str | None = None
    retryable: bool = False
    attempt: int = 1
    max_attempts: int | None = None


def _failure(
    code: str,
    *,
    stage: str | None = None,
    retryable: bool = False,
    attempt: int = 1,
    max_attempts: int | None = None,
) -> ImportFailure:
    return ImportFailure(
        code=code,
        message=PUBLIC_IMPORT_ERROR_MESSAGES.get(code, "Não foi possível concluir a importação."),
        stage=stage,
        retryable=retryable,
        attempt=attempt,
        max_attempts=max_attempts,
    )


def classify_import_failure(error: Exception) -> ImportFailure:
    """Map known worker failures to public-safe, stable recovery metadata."""

    if isinstance(error, ImportDumpFailed):
        return error.failure
    chain: list[Exception] = []
    current: BaseException | None = error
    visited: set[int] = set()
    while isinstance(current, Exception) and id(current) not in visited:
        visited.add(id(current))
        chain.append(current)
        current = current.__cause__ or current.__context__

    mysql = next((item for item in chain if isinstance(item, MySqlQueryRetriesExhausted)), None)
    if mysql is not None:
        code = {
            (2006, False): "MYSQL_CONNECTION_LOST",
            (2013, True): "MYSQL_QUERY_TIMEOUT",
        }.get((mysql.mysql_code, mysql.timed_out))
        if code is None:
            return _failure("INTERNAL_ERROR")
        return _failure(
            code,
            stage="INGESTING",
            retryable=True,
            attempt=mysql.attempts,
            max_attempts=mysql.attempts,
        )
    if any(isinstance(item, QueryPlanInvalid) for item in chain):
        return _failure("QUERY_PLAN_INVALID", stage="VALIDATING")
    if any(isinstance(item, SnapshotUploadError) for item in chain):
        return _failure("VALIDATION_ERROR", stage="VALIDATING")
    if any(isinstance(item, DynamoDbThrottled) for item in chain):
        return _failure("DYNAMODB_THROTTLED", stage="PROCESSING", retryable=True)
    if any(isinstance(item, DiskBudgetExceeded) for item in chain):
        return _failure("DISK_PRESSURE", stage="EXTRACTING", retryable=True)
    if any(
        isinstance(
            item,
            ArchiveChecksumMismatch | CanonicalSetChecksumMismatch | SnapshotChecksumMismatch,
        )
        for item in chain
    ):
        return _failure("CHECKSUM_MISMATCH", stage="VALIDATING")
    if any(isinstance(item, SourceSchemaInvalid) for item in chain):
        return _failure("SOURCE_SCHEMA_INVALID", stage="VALIDATING")
    if any(
        isinstance(
            item,
            ArchiveReconciliationError
            | ArchivePublicationError
            | CanonicalSetConflict
            | CanonicalSetEvidenceError
            | DataReconciliationError,
        )
        for item in chain
    ):
        return _failure("DATA_RECONCILIATION_FAILED", stage="ARCHIVING")
    if any(
        isinstance(
            item,
            ArchiveStorageError | GlueCatalogError | AthenaQueryError | CanonicalSetStorageError,
        )
        for item in chain
    ):
        return _failure("ARCHIVE_PUBLICATION_FAILED", stage="ARCHIVING", retryable=True)
    return _failure("INTERNAL_ERROR")


class ImportDumpFailed(RuntimeError):
    """Public-safe failure carrying the same correlation identity as the import error."""

    def __init__(
        self,
        import_id: str,
        failure: str | ImportFailure,
        *,
        cause_type: str | None = None,
    ) -> None:
        self.failure = _failure(failure) if isinstance(failure, str) else failure
        self.error_code = self.failure.code
        self.request_id = import_request_id(import_id)
        self.public_message = self.failure.message
        self.cause_type = (
            cause_type
            if isinstance(cause_type, str)
            and cause_type.isascii()
            and cause_type.isidentifier()
            and len(cause_type) <= 128
            else None
        )
        super().__init__(self.public_message)


class ImportDump:
    def __init__(
        self,
        jobs: ImportJobRepository,
        downloader: StagingDownloader,
        promoter: SnapshotPromoter,
        runner: CandidateBackfillRunner,
        *,
        workdir: Path,
        disk_budget_bytes: int,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._jobs, self._downloader = jobs, downloader
        self._promoter, self._runner = promoter, runner
        self._workdir, self._disk_budget_bytes, self._clock = workdir, disk_budget_bytes, clock

    def _timestamp(self) -> str:
        return (
            self._clock().astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        )

    def execute(self, import_id: str) -> RunResult:
        run_id = import_run_id(import_id)
        job = self._jobs.get(import_id)
        if job is None or job.state != ImportState.UPLOADED:
            raise ImportStateConflict("Import state conflict")
        # A loser of the claim must never terminate or unlock the winning worker's job.
        claim_patch = {"updatedAt": self._timestamp(), "progress": {"kind": "none"}}
        try:
            job = self._jobs.transition(
                import_id,
                ImportState.UPLOADED,
                job.version,
                ImportState.VALIDATING,
                claim_patch,
            )
        except ImportStateConflict:
            current = self._jobs.get(import_id)
            if current is None or current.state != ImportState.UPLOADED:
                raise
            job = self._jobs.transition(
                import_id,
                ImportState.UPLOADED,
                current.version,
                ImportState.VALIDATING,
                claim_patch,
            )
        staging: Path | None = None
        try:
            suffix = ".zip" if job.file_name.lower().endswith(".zip") else ".sql.gz"
            normalized_bound = min(
                DEFAULT_UPLOAD_LIMITS.max_gzip_bytes,
                job.size_bytes
                * (DEFAULT_UPLOAD_LIMITS.max_zip_expansion_ratio if suffix == ".zip" else 1),
            )
            promotion_budget = job.size_bytes + normalized_bound
            if (
                not job.physical_version
                or job.physical_version.lower() == "null"
                or not 0 < job.size_bytes <= DEFAULT_UPLOAD_LIMITS.max_input_bytes
                or promotion_budget > self._disk_budget_bytes
                or job.part_size_bytes is None
                or job.expected_part_count is None
            ):
                raise SnapshotUploadError("Invalid staging upload")
            self._workdir.mkdir(parents=True, exist_ok=True)
            if shutil.disk_usage(self._workdir).free < promotion_budget:
                raise SnapshotUploadError("Insufficient staging capacity")
            fd, name = tempfile.mkstemp(prefix="import-", suffix=suffix, dir=self._workdir)
            staging = Path(name)
            os.close(fd)  # mkstemp creates an exclusive mode-0600 regular file.
            self._downloader.download(
                job.bucket,
                job.key,
                staging,
                version_id=job.physical_version,
                expected_size=job.size_bytes,
                part_size_bytes=job.part_size_bytes,
                expected_part_count=job.expected_part_count,
            )
            if staging.stat().st_size != job.size_bytes:
                raise SnapshotUploadError("Staging size does not match")
            promoted = self._promoter.promote(
                staging,
                snapshot_extracted_on=job.snapshot_extracted_on,
            )
            # Input ZIP/GZIP may be 10 GiB: reclaim it before creating any backfill artifacts.
            staging.unlink()
            current = self._jobs.get(import_id)
            if current is None or current.state != ImportState.VALIDATING:
                raise ImportStateConflict("Import state conflict")
            processing_patch = {"updatedAt": self._timestamp(), "progress": {"kind": "none"}}
            try:
                job = self._jobs.transition(
                    import_id,
                    ImportState.VALIDATING,
                    current.version,
                    ImportState.PROCESSING,
                    processing_patch,
                )
            except ImportStateConflict:
                current = self._jobs.get(import_id)
                if current is None or current.state != ImportState.VALIDATING:
                    raise
                job = self._jobs.transition(
                    import_id,
                    ImportState.VALIDATING,
                    current.version,
                    ImportState.PROCESSING,
                    processing_patch,
                )
            result = self._runner.run(
                promoted,
                import_id=import_id,
                snapshot_extracted_on=job.snapshot_extracted_on,
                activate=False,
                pipeline=job.pipeline_version,
                materialize_hot_records=materialize_hot_records_for(job.pipeline_version),
            )
            if result.stage != RunStage.SUCCEEDED or result.run_id != run_id:
                raise ImportDumpFailed(import_id, _failure("INTERNAL_ERROR"))
            current = self._jobs.get(import_id)
            if current is None or current.state != ImportState.PROCESSING:
                raise ImportStateConflict("Import state conflict")
            ready_patch = {
                "updatedAt": self._timestamp(),
                "candidateVersion": result.dataset_version,
            }
            try:
                self._jobs.finish(
                    import_id,
                    current.version,
                    ImportState.READY,
                    ready_patch,
                )
            except ImportStateConflict:
                current = self._jobs.get(import_id)
                if current is None or current.state != ImportState.PROCESSING:
                    raise
                self._jobs.finish(
                    import_id,
                    current.version,
                    ImportState.READY,
                    ready_patch,
                )
            return result
        except BaseException as error:
            signal_traceback = error.__traceback__
            if isinstance(error, Exception):
                is_process_signal = False
                classified = classify_import_failure(error)
            else:
                is_process_signal = True
                classified = _failure("INTERNAL_ERROR")
            failure = ImportDumpFailed(
                import_id,
                classified,
                cause_type=type(error).__name__,
            )
            try:
                current = self._jobs.get(import_id)
                if current is not None and current.state in (
                    ImportState.VALIDATING,
                    ImportState.PROCESSING,
                ):
                    self._jobs.finish(
                        import_id,
                        current.version,
                        ImportState.FAILED,
                        {
                            "updatedAt": self._timestamp(),
                            "error": {
                                "code": classified.code,
                                "message": classified.message,
                                "requestId": failure.request_id,
                                "stage": classified.stage,
                                "retryable": classified.retryable,
                                "attempt": classified.attempt,
                                "maxAttempts": classified.max_attempts,
                            },
                        },
                    )
            except BaseException:
                if is_process_signal:
                    raise error.with_traceback(signal_traceback) from None
                raise
            if is_process_signal:
                raise
            raise failure from None
        finally:
            if staging is not None:
                staging.unlink(missing_ok=True)
