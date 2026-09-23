"""Progress mirrors durable run transitions and preserves recovery evidence."""

import importlib
from dataclasses import replace
from datetime import timedelta

import pytest

from domain.import_job import ImportState, ImportStateConflict
from domain.run import RunActivity, RunPipeline, RunStage, RunState, RunTransitionMetadata
from tests.fakes import FakeRunRepository
from tests.unit.application.test_import_dump import IMPORT_ID, NOW, RUN_ID, Jobs


def decorator(runs, jobs):
    try:
        module = importlib.import_module("adapters.telemetry.import_progress")
    except ModuleNotFoundError:
        pytest.fail("import progress decorator is missing")
    return module.ImportProgressRunRepository(runs, jobs, IMPORT_ID)


def test_canonical_progress_order_does_not_treat_archiving_as_a_regression():
    jobs, runs = Jobs(), FakeRunRepository()
    jobs.job = replace(jobs.job, state=ImportState.PROCESSING)
    observed = decorator(runs, jobs)
    state = RunState.start(
        RUN_ID,
        "dsv_" + "a" * 64,
        pipeline=RunPipeline.CANONICAL_V2,
    )
    observed.create(state, idempotency_key="create")
    previous = RunStage.STARTING
    for target in (
        RunStage.VALIDATING,
        RunStage.EXTRACTING,
        RunStage.ARCHIVING,
        RunStage.PROJECTING,
    ):
        observed.transition(
            RUN_ID,
            target,
            expected_stage=previous,
            metadata=RunTransitionMetadata(NOW),
            idempotency_key=target.value,
        )
        previous = target

    assert jobs.job.progress_run_stage == RunStage.PROJECTING
    assert jobs.job.progress["stage"] == "PROJECTING"


def test_durable_run_is_written_before_progress_and_activation_is_only_publishing():
    jobs, runs = Jobs(), FakeRunRepository()
    jobs.job = replace(jobs.job, state=ImportState.PROCESSING)
    observed = decorator(runs, jobs)
    original = jobs.update_progress

    def update(import_id, version, patch):
        assert runs.get_run(RUN_ID) is not None
        assert runs.get_run(RUN_ID).stage.value == patch["progress"]["stage"] or (
            runs.get_run(RUN_ID).stage == RunStage.ACTIVATING
            and patch["progress"]["stage"] == "PUBLISHING"
        )
        return original(import_id, version, patch)

    jobs.update_progress = update
    observed.create(RunState.start(RUN_ID, "dsv_" + "a" * 64), idempotency_key="create")
    previous = RunStage.STARTING
    for target in (
        RunStage.VALIDATING,
        RunStage.INGESTING,
        RunStage.PROJECTING,
        RunStage.ARCHIVING,
        RunStage.ACTIVATING,
        RunStage.PUBLISHING,
    ):
        observed.transition(
            RUN_ID,
            target,
            expected_stage=previous,
            metadata=RunTransitionMetadata(
                NOW, records_read=10, records_written=8, records_rejected=2
            ),
            idempotency_key=target.value,
        )
        previous = target
    assert jobs.job.progress == {
        "kind": "stage",
        "stage": "PUBLISHING",
        "recordsRead": 60,
        "recordsWritten": 48,
        "recordsRejected": 12,
    }
    assert jobs.job.version == 11


def test_failed_mirror_keeps_run_durable_and_can_recover_on_read():
    jobs, runs = Jobs(), FakeRunRepository()
    jobs.job = replace(jobs.job, state=ImportState.PROCESSING)
    observed = decorator(runs, jobs)
    observed.create(RunState.start(RUN_ID, "dsv_" + "a" * 64), idempotency_key="create")
    update = jobs.update_progress

    def conflict(*args):
        raise ImportStateConflict("concurrent write")

    jobs.update_progress = conflict
    with pytest.raises(ImportStateConflict):
        observed.transition(
            RUN_ID,
            RunStage.VALIDATING,
            expected_stage=RunStage.STARTING,
            metadata=RunTransitionMetadata(NOW),
            idempotency_key="validate",
        )
    assert runs.get_run(RUN_ID).stage == RunStage.VALIDATING
    with pytest.raises(ImportStateConflict):
        observed.get_run(RUN_ID)
    jobs.update_progress = update
    assert observed.get_run(RUN_ID).stage == RunStage.VALIDATING
    assert jobs.job.progress["stage"] == "VALIDATING"


def test_progress_mirror_retries_after_concurrent_task_arn_persistence():
    jobs, runs = Jobs(), FakeRunRepository()
    jobs.job = replace(jobs.job, state=ImportState.PROCESSING)
    observed = decorator(runs, jobs)
    observed.create(RunState.start(RUN_ID, "dsv_" + "a" * 64), idempotency_key="create")
    update = jobs.update_progress
    attempts = 0

    def concurrent_task_arn(import_id, version, patch):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            jobs.job = replace(
                jobs.job,
                task_arn="arn:aws:ecs:us-east-1:123456789012:task/recovered",
                version=jobs.job.version + 1,
            )
            raise ImportStateConflict("concurrent task ARN write")
        return update(import_id, version, patch)

    jobs.update_progress = concurrent_task_arn
    observed.transition(
        RUN_ID,
        RunStage.VALIDATING,
        expected_stage=RunStage.STARTING,
        metadata=RunTransitionMetadata(NOW),
        idempotency_key="validate",
    )

    assert attempts == 2
    assert jobs.job.task_arn == "arn:aws:ecs:us-east-1:123456789012:task/recovered"
    assert jobs.job.progress["stage"] == "VALIDATING"


def test_failed_run_persistence_does_not_publish_progress():
    jobs, runs = Jobs(), FakeRunRepository()
    jobs.job = replace(jobs.job, state=ImportState.PROCESSING)
    observed = decorator(runs, jobs)
    with pytest.raises(KeyError):
        observed.transition(
            RUN_ID,
            RunStage.VALIDATING,
            expected_stage=RunStage.STARTING,
            idempotency_key="missing-run",
        )
    assert jobs.progress == []


def test_replayed_transition_does_not_count_its_delta_twice():
    jobs, runs = Jobs(), FakeRunRepository()
    jobs.job = replace(jobs.job, state=ImportState.PROCESSING)
    observed = decorator(runs, jobs)
    observed.create(RunState.start(RUN_ID, "dsv_" + "a" * 64), idempotency_key="create")
    metadata = RunTransitionMetadata(NOW, records_read=5, records_written=4, records_rejected=1)
    for _ in range(2):
        observed.transition(
            RUN_ID,
            RunStage.VALIDATING,
            expected_stage=RunStage.STARTING,
            metadata=metadata,
            idempotency_key="validate",
        )
    observed.transition(
        RUN_ID,
        RunStage.INGESTING,
        expected_stage=RunStage.VALIDATING,
        metadata=RunTransitionMetadata(NOW),
        idempotency_key="ingest",
    )
    assert jobs.job.progress["recordsRead"] == 5
    assert jobs.job.progress["recordsWritten"] == 4
    assert jobs.job.progress["recordsRejected"] == 1


@pytest.mark.parametrize("written", [False, True])
def test_new_decorator_recovers_mirror_with_or_without_lost_ack_without_double_counting(written):
    jobs, runs = Jobs(), FakeRunRepository()
    jobs.job = replace(jobs.job, state=ImportState.PROCESSING)
    first = decorator(runs, jobs)
    first.create(RunState.start(RUN_ID, "dsv_" + "a" * 64), idempotency_key="create")
    update = jobs.update_progress

    def uncertain_write(*args):
        if written:
            update(*args)
        raise RuntimeError("write not confirmed")

    jobs.update_progress = uncertain_write
    metadata = RunTransitionMetadata(NOW, records_read=5, records_written=4, records_rejected=1)
    with pytest.raises(RuntimeError):
        first.transition(
            RUN_ID,
            RunStage.VALIDATING,
            expected_stage=RunStage.STARTING,
            metadata=metadata,
            idempotency_key="validate",
        )
    assert runs.get_run(RUN_ID).stage == RunStage.VALIDATING
    jobs.update_progress = update
    restarted = decorator(runs, jobs)
    restarted.transition(
        RUN_ID,
        RunStage.VALIDATING,
        expected_stage=RunStage.STARTING,
        metadata=metadata,
        idempotency_key="validate",
    )
    restarted.transition(
        RUN_ID,
        RunStage.INGESTING,
        expected_stage=RunStage.VALIDATING,
        metadata=RunTransitionMetadata(NOW),
        idempotency_key="ingest",
    )
    assert jobs.job.progress["recordsRead"] == 5
    assert jobs.job.progress["recordsWritten"] == 4
    assert jobs.job.progress["recordsRejected"] == 1


def test_new_process_recovers_durable_totals_without_recreating_original_metadata():
    jobs, runs = Jobs(), FakeRunRepository()
    jobs.job = replace(jobs.job, state=ImportState.PROCESSING)
    first = decorator(runs, jobs)
    first.create(RunState.start(RUN_ID, "dsv_" + "a" * 64), idempotency_key="create")
    # The process ends after the run commit and before its acknowledgement or import mirror.
    runs.transition(
        RUN_ID,
        RunStage.VALIDATING,
        expected_stage=RunStage.STARTING,
        metadata=RunTransitionMetadata(NOW, records_read=5, records_written=4, records_rejected=1),
        idempotency_key="validate",
    )
    restarted = decorator(runs, jobs)
    for _ in range(2):
        assert restarted.get_run(RUN_ID).stage == RunStage.VALIDATING
    assert jobs.job.progress == {
        "kind": "stage",
        "stage": "VALIDATING",
        "recordsRead": 5,
        "recordsWritten": 4,
        "recordsRejected": 1,
    }


def test_failed_delegate_write_never_invents_stage_or_counts_on_recovery_read():
    jobs, runs = Jobs(), FakeRunRepository()
    jobs.job = replace(jobs.job, state=ImportState.PROCESSING)
    observed = decorator(runs, jobs)
    observed.create(RunState.start(RUN_ID, "dsv_" + "a" * 64), idempotency_key="create")

    def fail(*args, **kwargs):
        raise RuntimeError("write rejected before commit")

    runs.transition = fail
    with pytest.raises(RuntimeError):
        observed.transition(
            RUN_ID,
            RunStage.VALIDATING,
            expected_stage=RunStage.STARTING,
            metadata=RunTransitionMetadata(NOW, records_read=23),
            idempotency_key="validate",
        )
    assert observed.get_run(RUN_ID).stage == RunStage.STARTING
    assert jobs.job.progress["recordsRead"] == 0
    assert jobs.job.progress["stage"] == "STARTING"


def test_live_activity_exposes_truthful_dataset_and_heartbeat_progress():
    jobs, runs = Jobs(), FakeRunRepository()
    jobs.job = replace(jobs.job, state=ImportState.PROCESSING)
    observed = decorator(runs, jobs)
    observed.create(RunState.start(RUN_ID, "dsv_" + "a" * 64), idempotency_key="create")
    observed.transition(
        RUN_ID,
        RunStage.VALIDATING,
        expected_stage=RunStage.STARTING,
        metadata=RunTransitionMetadata(NOW),
        idempotency_key="validate",
    )
    observed.transition(
        RUN_ID,
        RunStage.INGESTING,
        expected_stage=RunStage.VALIDATING,
        metadata=RunTransitionMetadata(NOW),
        idempotency_key="ingest",
    )

    observed.report_activity(
        RunActivity(
            stage=RunStage.INGESTING,
            stage_started_at=NOW,
            observed_at=NOW + timedelta(seconds=30),
            records_read=125,
            records_written=120,
            records_rejected=5,
            records_total=1000,
            current_dataset="signal_bucket",
            datasets_completed=2,
            datasets_total=23,
        )
    )

    assert jobs.job.updated_at == NOW + timedelta(seconds=30)
    assert jobs.job.progress == {
        "kind": "stage",
        "stage": "INGESTING",
        "stageStartedAt": NOW.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "heartbeatAt": (NOW + timedelta(seconds=30))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
        "recordsRead": 125,
        "recordsWritten": 120,
        "recordsRejected": 5,
        "recordsTotal": 1000,
        "currentDataset": "signal_bucket",
        "datasetsCompleted": 2,
        "datasetsTotal": 23,
    }

    observed.get_run(RUN_ID)

    assert jobs.job.progress["heartbeatAt"] == (NOW + timedelta(seconds=30)).isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")
    assert jobs.job.progress["currentDataset"] == "signal_bucket"


def test_policy_skipped_hot_stage_exposes_zero_units_and_substage():
    jobs, runs = Jobs(), FakeRunRepository()
    jobs.job = replace(
        jobs.job,
        state=ImportState.PROCESSING,
        pipeline_version=RunPipeline.CANONICAL_V2,
    )
    observed = decorator(runs, jobs)

    observed.report_activity(
        RunActivity(
            stage=RunStage.MATERIALIZING_HOT,
            stage_started_at=NOW,
            observed_at=NOW,
            substage="SKIPPED_BY_POLICY",
            units_completed=0,
            units_total=0,
            unit_label="datasets",
        )
    )

    assert jobs.job.progress == {
        "kind": "stage",
        "stage": "MATERIALIZING_HOT",
        "substage": "SKIPPED_BY_POLICY",
        "stageStartedAt": NOW.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "heartbeatAt": NOW.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "recordsRead": 0,
        "recordsWritten": 0,
        "recordsRejected": 0,
        "recordsTotal": None,
        "currentDataset": None,
        "datasetsCompleted": 0,
        "datasetsTotal": 0,
        "unitsCompleted": 0,
        "unitsTotal": 0,
        "unitLabel": "datasets",
    }
