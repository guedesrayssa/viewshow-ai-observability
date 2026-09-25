"""Candidate imports pin the upload, clean staging, and terminate safely."""

import importlib
from dataclasses import replace
from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from adapters.archive.athena import AthenaQueryError
from adapters.archive.glue import GlueCatalogError
from adapters.archive.s3 import ArchiveChecksumMismatch, ArchiveStorageError
from adapters.archive.s3_canonical_sets import (
    CanonicalSetChecksumMismatch,
    CanonicalSetEvidenceError,
    CanonicalSetStorageError,
)
from adapters.dynamodb.client import DynamoDbThrottled
from adapters.dynamodb.hot_records import UnprocessedKeysExhausted
from adapters.sources.mysql_retry import MySqlQueryRetriesExhausted
from adapters.sources.mysql_snapshot_preparer import QueryPlanInvalid
from application.backfill import (
    BackfillFailed,
    DataReconciliationError,
    RunResult,
    SourceSchemaInvalid,
)
from domain.disk_budget import DiskBudgetExceeded, DiskUsage
from domain.import_job import ImportJob, ImportState, ImportStateConflict
from domain.run import RunPipeline, RunStage
from ports import ArchiveReconciliationError, SnapshotChecksumMismatch
from scripts.upload_snapshot import SnapshotUploadError, SnapshotUploadResult
from tests.unit.domain.test_import_job import fixture

IMPORT_ID = "imp_01K59Z5XE00000000000000000"
RUN_ID = "run_import_01K59Z5XE00000000000000000"
NOW = datetime(2026, 9, 17, 12, tzinfo=UTC)
SNAPSHOT = SnapshotUploadResult(
    "1",
    "archive-test",
    "dumps/" + "a" * 64 + "/argus_dump.sql.gz",
    "promoted-version",
    "a" * 64,
    1024,
    date(2026, 9, 17),
)


def worker_module():
    try:
        return importlib.import_module("application.import_dump")
    except ModuleNotFoundError:
        pytest.fail("import-dump service is missing")


class Jobs:
    def __init__(self):
        self.job = ImportJob.from_item(fixture())
        self.transitions = []
        self.released = False
        self.progress = []

    def get(self, import_id):
        assert import_id == IMPORT_ID
        return self.job

    def transition(self, import_id, expected_state, expected_version, next_state, patch):
        if self.job.state != expected_state or self.job.version != expected_version:
            raise ImportStateConflict("conflict")
        self.transitions.append((expected_state, next_state))
        self.job = ImportJob.from_item(
            {
                **self.job.to_item(),
                **patch,
                "state": next_state,
                "version": expected_version + 1,
            }
        )
        return self.job

    def update_progress(self, import_id, expected_version, patch):
        assert self.job.state == ImportState.PROCESSING
        assert self.job.version == expected_version
        self.progress.append(patch)
        self.job = ImportJob.from_item(
            {
                **self.job.to_item(),
                **patch,
                "version": expected_version + 1,
            }
        )
        return self.job

    def finish(self, import_id, expected_version, state, patch):
        job = self.transition(import_id, self.job.state, expected_version, state, patch)
        self.released = True
        return job


def result(stage=RunStage.SUCCEEDED):
    return RunResult(
        RUN_ID,
        "dsv_" + "b" * 64,
        stage,
        None,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        {},
        DiskUsage(100, 0, 0, 100, {}),
    )


class Downloader:
    def __init__(self, jobs, events):
        self.jobs, self.events = jobs, events
        self.path = None

    def download(
        self,
        bucket,
        key,
        destination,
        *,
        version_id,
        expected_size,
        part_size_bytes,
        expected_part_count,
    ):
        assert self.jobs.job.state == ImportState.VALIDATING
        assert (bucket, key, version_id, expected_size) == (
            "imports-test",
            f"staging/imports/{IMPORT_ID}/source",
            "s3-version-1",
            1024,
        )
        self.path = destination
        assert part_size_bytes == 16 * 1024**2 and expected_part_count == 1
        assert destination.stat().st_mode & 0o777 == 0o600
        destination.write_bytes(b"x" * expected_size)
        self.events.append("download")


class Promoter:
    def __init__(self, events, error=None):
        self.events, self.error = events, error

    def promote(self, path, *, snapshot_extracted_on):
        assert path.exists()
        assert snapshot_extracted_on == date(2026, 9, 17)
        self.events.append("promote")
        if self.error:
            raise self.error
        return SNAPSHOT


class Runner:
    def __init__(self, jobs, downloader, events, error=None, stage=RunStage.SUCCEEDED):
        self.jobs, self.downloader, self.events = jobs, downloader, events
        self.error, self.stage = error, stage

    def run(
        self,
        snapshot,
        *,
        import_id,
        snapshot_extracted_on,
        activate,
        pipeline,
        materialize_hot_records,
    ):
        assert activate is False
        assert pipeline is RunPipeline.CANONICAL_V2
        assert materialize_hot_records is False
        assert import_id == IMPORT_ID
        assert snapshot is SNAPSHOT
        assert snapshot_extracted_on == date(2026, 9, 17)
        assert self.jobs.job.state == ImportState.PROCESSING
        assert not self.downloader.path.exists()
        self.events.append("backfill")
        if self.error:
            raise self.error
        return result(self.stage)


class ProcessSignal(BaseException):
    pass


def setup_worker(tmp_path, *, promoter_error=None, runner_error=None, stage=RunStage.SUCCEEDED):
    jobs, events = Jobs(), []
    downloader = Downloader(jobs, events)
    runner = Runner(jobs, downloader, events, runner_error, stage)
    service = worker_module().ImportDump(
        jobs,
        downloader,
        Promoter(events, promoter_error),
        runner,
        workdir=tmp_path,
        disk_budget_bytes=1024 * 1024,
        clock=lambda: NOW,
    )
    return service, jobs, downloader, events


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (
            MySqlQueryRetriesExhausted(mysql_code=2006, attempts=4, timed_out=False),
            {
                "code": "MYSQL_CONNECTION_LOST",
                "stage": "INGESTING",
                "retryable": True,
                "attempt": 4,
                "maxAttempts": 4,
            },
        ),
        (
            MySqlQueryRetriesExhausted(mysql_code=2013, attempts=4, timed_out=True),
            {
                "code": "MYSQL_QUERY_TIMEOUT",
                "stage": "INGESTING",
                "retryable": True,
                "attempt": 4,
                "maxAttempts": 4,
            },
        ),
        (
            QueryPlanInvalid("private_table"),
            {
                "code": "QUERY_PLAN_INVALID",
                "stage": "VALIDATING",
                "retryable": False,
                "attempt": 1,
                "maxAttempts": None,
            },
        ),
    ],
)
def test_classifies_known_failures_without_exposing_internal_text(error, expected):
    failure = worker_module().classify_import_failure(error)

    assert {
        "code": failure.code,
        "stage": failure.stage,
        "retryable": failure.retryable,
        "attempt": failure.attempt,
        "maxAttempts": failure.max_attempts,
    } == expected
    assert "private_table" not in failure.message


@pytest.mark.parametrize(
    ("error", "code", "retryable"),
    [
        (ArchiveStorageError("s3://secret/key"), "ARCHIVE_PUBLICATION_FAILED", True),
        (GlueCatalogError("private catalog"), "ARCHIVE_PUBLICATION_FAILED", True),
        (AthenaQueryError("SELECT private"), "ARCHIVE_PUBLICATION_FAILED", True),
        (CanonicalSetStorageError("private marker"), "ARCHIVE_PUBLICATION_FAILED", True),
        (DynamoDbThrottled("private table"), "DYNAMODB_THROTTLED", True),
        (UnprocessedKeysExhausted("private keys"), "DYNAMODB_THROTTLED", True),
        (DiskBudgetExceeded("/private/workdir"), "DISK_PRESSURE", True),
        (ArchiveChecksumMismatch("private checksum"), "CHECKSUM_MISMATCH", False),
        (CanonicalSetChecksumMismatch("private marker"), "CHECKSUM_MISMATCH", False),
        (CanonicalSetEvidenceError("private marker"), "DATA_RECONCILIATION_FAILED", False),
        (SnapshotChecksumMismatch("private checksum"), "CHECKSUM_MISMATCH", False),
        (SourceSchemaInvalid("private schema"), "SOURCE_SCHEMA_INVALID", False),
        (ArchiveReconciliationError("private count"), "DATA_RECONCILIATION_FAILED", False),
        (DataReconciliationError("private evidence"), "DATA_RECONCILIATION_FAILED", False),
    ],
)
def test_classifies_canonical_failures_through_backfill_wrapper(error, code, retryable):
    try:
        raise error
    except Exception as cause:
        try:
            raise BackfillFailed(RunStage.ARCHIVING, "private wrapper") from cause
        except BackfillFailed as wrapped:
            failure = worker_module().classify_import_failure(wrapped)

    assert failure.code == code
    assert failure.retryable is retryable
    assert "private" not in failure.message


@pytest.mark.parametrize(
    ("mysql_code", "timed_out"),
    [
        (2006, True),
        (2013, False),
        (1045, False),
        (9999, True),
    ],
)
def test_inconsistent_or_unknown_mysql_failures_fall_back_to_generic_safe_error(
    mysql_code, timed_out
):
    failure = worker_module().classify_import_failure(
        MySqlQueryRetriesExhausted(
            mysql_code=mysql_code,
            attempts=8,
            timed_out=timed_out,
        )
    )

    assert failure == worker_module().ImportFailure(
        code="INTERNAL_ERROR",
        message="Não foi possível concluir a importação.",
        stage=None,
        retryable=False,
        attempt=1,
        max_attempts=None,
    )


@pytest.mark.parametrize(
    ("error", "code", "retryable"),
    [
        (
            MySqlQueryRetriesExhausted(mysql_code=2006, attempts=4, timed_out=False),
            "MYSQL_CONNECTION_LOST",
            True,
        ),
        (
            MySqlQueryRetriesExhausted(mysql_code=2013, attempts=4, timed_out=True),
            "MYSQL_QUERY_TIMEOUT",
            True,
        ),
        (QueryPlanInvalid("cursor_secret"), "QUERY_PLAN_INVALID", False),
    ],
)
def test_known_runner_failure_persists_actionable_safe_cause(tmp_path, error, code, retryable):
    service, jobs, _, _ = setup_worker(tmp_path, runner_error=error)

    with pytest.raises(worker_module().ImportDumpFailed) as raised:
        service.execute(IMPORT_ID)

    assert jobs.job.error == {
        "code": code,
        "message": raised.value.public_message,
        "requestId": "req_import_01K59Z5XE00000000000000000",
        "stage": "VALIDATING" if code == "QUERY_PLAN_INVALID" else "INGESTING",
        "retryable": retryable,
        "attempt": 1 if code == "QUERY_PLAN_INVALID" else 4,
        "maxAttempts": None if code == "QUERY_PLAN_INVALID" else 4,
    }
    assert raised.value.cause_type == type(error).__name__
    assert "cursor_secret" not in str(jobs.job.error) + str(raised.value)


@pytest.mark.parametrize("signal", [GeneratorExit("generator closed"), ProcessSignal("stop")])
def test_process_signals_are_persisted_then_rethrown_unchanged(tmp_path, signal):
    service, jobs, _, _ = setup_worker(tmp_path, runner_error=signal)

    with pytest.raises(type(signal)) as raised:
        service.execute(IMPORT_ID)

    assert raised.value is signal
    assert jobs.job.state == ImportState.FAILED and jobs.released
    assert jobs.job.error["code"] == "INTERNAL_ERROR"


@pytest.mark.parametrize("operation", ["get", "finish"])
def test_persistence_failure_never_masks_the_original_process_signal(tmp_path, operation):
    signal = GeneratorExit("generator closed")
    service, jobs, _, _ = setup_worker(tmp_path, runner_error=signal)
    persistence_attempted = False

    def fail_persistence(*args, **kwargs):
        nonlocal persistence_attempted
        persistence_attempted = True
        raise RuntimeError("store unavailable")

    if operation == "finish":
        jobs.finish = fail_persistence
    else:
        get = jobs.get

        def fail_processing_get(import_id):
            if jobs.job.state == ImportState.PROCESSING:
                return fail_persistence(import_id)
            return get(import_id)

        jobs.get = fail_processing_get

    with pytest.raises(GeneratorExit) as raised:
        service.execute(IMPORT_ID)

    assert persistence_attempted
    assert raised.value is signal


def test_promotes_before_candidate_backfill_and_releases_terminal_lock(tmp_path: Path):
    service, jobs, downloader, events = setup_worker(tmp_path)
    actual = service.execute(IMPORT_ID)
    assert actual.dataset_version == "dsv_" + "b" * 64
    assert events == ["download", "promote", "backfill"]
    assert jobs.transitions == [
        (ImportState.UPLOADED, ImportState.VALIDATING),
        (ImportState.VALIDATING, ImportState.PROCESSING),
        (ImportState.PROCESSING, ImportState.READY),
    ]
    assert jobs.job.candidate_version == actual.dataset_version
    assert jobs.released and not downloader.path.exists()
    assert list(tmp_path.iterdir()) == []


def test_validation_preserves_concurrently_recovered_task_arn(tmp_path: Path):
    service, jobs, _, _ = setup_worker(tmp_path)
    promote = service._promoter.promote

    def recover_task_arn(path, **kwargs):
        jobs.job = replace(
            jobs.job,
            task_arn="arn:aws:ecs:us-east-1:123456789012:task/recovered",
            version=jobs.job.version + 1,
        )
        return promote(path, **kwargs)

    service._promoter.promote = recover_task_arn
    actual = service.execute(IMPORT_ID)

    assert actual.stage == RunStage.SUCCEEDED
    assert jobs.job.state == ImportState.READY
    assert jobs.job.task_arn == "arn:aws:ecs:us-east-1:123456789012:task/recovered"


def test_processing_transition_retries_task_arn_race_after_validation(tmp_path: Path):
    service, jobs, _, _ = setup_worker(tmp_path)
    transition = jobs.transition
    raced = False

    def recover_task_arn(import_id, expected_state, expected_version, next_state, patch):
        nonlocal raced
        if not raced and expected_state == ImportState.VALIDATING:
            raced = True
            jobs.job = replace(
                jobs.job,
                task_arn="arn:aws:ecs:us-east-1:123456789012:task/recovered",
                version=jobs.job.version + 1,
            )
            raise ImportStateConflict("concurrent task ARN write")
        return transition(import_id, expected_state, expected_version, next_state, patch)

    jobs.transition = recover_task_arn
    actual = service.execute(IMPORT_ID)

    assert raced and actual.stage == RunStage.SUCCEEDED
    assert jobs.job.state == ImportState.READY
    assert jobs.job.task_arn == "arn:aws:ecs:us-east-1:123456789012:task/recovered"


def test_ready_finish_retries_task_arn_race_after_backfill(tmp_path: Path):
    service, jobs, _, _ = setup_worker(tmp_path)
    finish = jobs.finish
    raced = False

    def recover_task_arn(import_id, expected_version, state, patch):
        nonlocal raced
        if not raced and state == ImportState.READY:
            raced = True
            jobs.job = replace(
                jobs.job,
                task_arn="arn:aws:ecs:us-east-1:123456789012:task/recovered",
                version=jobs.job.version + 1,
            )
            raise ImportStateConflict("concurrent task ARN write")
        return finish(import_id, expected_version, state, patch)

    jobs.finish = recover_task_arn
    actual = service.execute(IMPORT_ID)

    assert raced and actual.stage == RunStage.SUCCEEDED
    assert jobs.job.state == ImportState.READY
    assert jobs.job.candidate_version == actual.dataset_version
    assert jobs.job.task_arn == "arn:aws:ecs:us-east-1:123456789012:task/recovered"


@pytest.mark.parametrize("state", [ImportState.PROCESSING, ImportState.READY])
def test_wrong_state_never_steals_another_worker_or_returns_success(tmp_path, state):
    service, jobs, _, events = setup_worker(tmp_path)
    jobs.job = replace(jobs.job, state=state)
    with pytest.raises(ImportStateConflict):
        service.execute(IMPORT_ID)
    assert not events and not jobs.transitions and not jobs.released


@pytest.mark.parametrize("failure", ["promotion", "backfill", "partial", "size", "oversize"])
def test_failures_release_lock_and_do_not_expose_infrastructure(tmp_path, failure):
    secret = "private-bucket/staging/private-key"
    service, jobs, downloader, events = setup_worker(
        tmp_path,
        promoter_error=SnapshotUploadError(secret) if failure == "promotion" else None,
        runner_error=RuntimeError(secret) if failure == "backfill" else None,
        stage=RunStage.PARTIAL if failure == "partial" else RunStage.SUCCEEDED,
    )
    if failure == "oversize":
        jobs.job = replace(jobs.job, size_bytes=10 * 1024**3 + 1, expected_part_count=641)
    if failure == "size":

        def short_download(bucket, key, path, **kwargs):
            downloader.path = path
            path.write_bytes(b"short")

        downloader.download = short_download
    with pytest.raises(worker_module().ImportDumpFailed) as raised:
        service.execute(IMPORT_ID)
    assert jobs.job.state == ImportState.FAILED and jobs.released
    assert jobs.job.error["requestId"] == "req_import_01K59Z5XE00000000000000000"
    assert jobs.job.error["code"] in {"VALIDATION_ERROR", "INTERNAL_ERROR"}
    assert raised.value.request_id == jobs.job.error["requestId"]
    assert secret not in str(raised.value) + str(jobs.job.error)
    assert list(tmp_path.iterdir()) == []
    if failure in {"promotion", "size", "oversize"}:
        assert "backfill" not in events


def test_run_identity_is_validated_and_deterministic():
    module = worker_module()
    assert module.import_run_id(IMPORT_ID) == RUN_ID
    for invalid in ("", "imp_../secret", "a" * 200):
        with pytest.raises(ValueError):
            module.import_run_id(invalid)


def test_budget_accounts_for_input_and_promoted_gzip_together(tmp_path):
    jobs, events = Jobs(), []
    downloader = Downloader(jobs, events)
    service = worker_module().ImportDump(
        jobs,
        downloader,
        Promoter(events),
        Runner(jobs, downloader, events),
        workdir=tmp_path,
        disk_budget_bytes=1536,
        clock=lambda: NOW,
    )
    with pytest.raises(worker_module().ImportDumpFailed):
        service.execute(IMPORT_ID)
    assert events == []
    assert jobs.job.state == ImportState.FAILED and jobs.released


def test_zip_extension_accepted_by_api_is_normalized_for_promotion(tmp_path):
    service, jobs, _, _ = setup_worker(tmp_path)
    jobs.job = replace(jobs.job, file_name="ARGUS.ZIP")
    promote = service._promoter.promote

    def check_zip(path, **kwargs):
        assert path.suffix == ".zip"
        return promote(path, **kwargs)

    service._promoter.promote = check_zip
    assert service.execute(IMPORT_ID).stage == RunStage.SUCCEEDED


def test_lost_claim_does_not_finish_or_unlock_another_worker(tmp_path):
    service, jobs, _, events = setup_worker(tmp_path)

    def conflict(*args):
        raise ImportStateConflict("concurrent claim")

    jobs.transition = conflict
    with pytest.raises(ImportStateConflict):
        service.execute(IMPORT_ID)
    assert not jobs.released and not events


def test_claim_retries_after_concurrently_recovered_task_arn(tmp_path):
    service, jobs, _, _ = setup_worker(tmp_path)
    transition = jobs.transition
    raced = False

    def recover_task_arn(import_id, expected_state, expected_version, next_state, patch):
        nonlocal raced
        if not raced and expected_state == ImportState.UPLOADED:
            raced = True
            jobs.job = replace(
                jobs.job,
                task_arn="arn:aws:ecs:us-east-1:123456789012:task/recovered",
                version=jobs.job.version + 1,
            )
            raise ImportStateConflict("concurrent task ARN write")
        return transition(import_id, expected_state, expected_version, next_state, patch)

    jobs.transition = recover_task_arn
    actual = service.execute(IMPORT_ID)

    assert raced and actual.stage == RunStage.SUCCEEDED
    assert jobs.job.state == ImportState.READY
    assert jobs.job.task_arn == "arn:aws:ecs:us-east-1:123456789012:task/recovered"


def test_terminal_store_failure_never_reports_ready_and_still_cleans_input(tmp_path):
    service, jobs, _, _ = setup_worker(tmp_path)

    def unavailable(*args):
        raise ImportStateConflict("unconfirmed terminal write")

    jobs.finish = unavailable
    with pytest.raises(ImportStateConflict):
        service.execute(IMPORT_ID)
    assert not jobs.released
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("lost_delegate_ack", [False, True])
def test_real_backfill_persists_candidate_and_progress_without_changing_active(
    tmp_path, lost_delegate_ack
):
    from adapters.telemetry.import_progress import ImportProgressRunRepository
    from tests.unit.application.test_backfill import build_backfill

    service, jobs, _, _ = setup_worker(tmp_path)
    harness = build_backfill(tmp_path)
    transition = harness.runs.transition

    def commit_then_lose_ack(run_id, target, **kwargs):
        nonlocal lost_delegate_ack
        persisted = transition(run_id, target, **kwargs)
        if lost_delegate_ack and target == RunStage.PROJECTING:
            lost_delegate_ack = False
            assert kwargs["metadata"].records_read == kwargs["metadata"].records_written == 23
            raise RuntimeError("run write acknowledgement lost")
        return persisted

    harness.runs.transition = commit_then_lose_ack
    old_active = harness.manifests.get_active()
    harness.service._runs = ImportProgressRunRepository(harness.runs, jobs, IMPORT_ID)

    class RealRunner:
        def run(
            self,
            snapshot,
            *,
            import_id,
            snapshot_extracted_on,
            activate,
            pipeline,
            materialize_hot_records,
        ):
            assert activate is False
            assert pipeline is RunPipeline.CANONICAL_V2
            assert materialize_hot_records is False
            return harness.service.execute(
                replace(
                    harness.request,
                    run_id=RUN_ID,
                    activate=activate,
                    pipeline=pipeline,
                    materialize_hot_records=materialize_hot_records,
                )
            )

    service._runner = RealRunner()
    actual = service.execute(IMPORT_ID)
    assert actual.stage == RunStage.SUCCEEDED
    assert actual.records_read == actual.records_written == 23
    assert harness.manifests.candidates[actual.dataset_version]
    assert harness.manifests.get_active() == old_active
    assert jobs.job.candidate_version == actual.dataset_version
    assert jobs.job.progress == {
        "kind": "stage",
        "stage": "SUCCEEDED",
        "recordsRead": actual.records_read,
        "recordsWritten": actual.records_written,
        "recordsRejected": actual.records_rejected,
    }
    assert actual.new_analysis_events == 0
    assert "ACTIVATING" not in [patch["progress"]["stage"] for patch in jobs.progress]


def test_composite_checksum_failure_terminalizes_safely_before_promotion(tmp_path):
    import gzip

    from adapters.sources.staging_download import S3StagingDownloader
    from tests.unit.adapters.test_staging_download import S3

    service, jobs, _, events = setup_worker(tmp_path)
    jobs.job = replace(jobs.job, size_bytes=29)
    s3 = S3(
        gzip.compress(b"SELECT 2;", mtime=0),
        head_size=29,
        head_version="s3-version-1",
        get_version="s3-version-1",
    )
    s3.checksum = "cgROcfh78LYGeX16+ZseQ6cXKMUMkHLN+NtzU87OFT4=-1"
    service._downloader = S3StagingDownloader(s3, expected_bucket_owner="123456789012")
    with pytest.raises(worker_module().ImportDumpFailed):
        service.execute(IMPORT_ID)
    assert jobs.job.state == ImportState.FAILED and jobs.released
    assert jobs.job.error["code"] == "VALIDATION_ERROR"
    assert events == [] and list(tmp_path.iterdir()) == []
