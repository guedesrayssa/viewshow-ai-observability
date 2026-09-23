"""Mirror the run's durable cumulative progress with CAS, including lost acknowledgements."""

import threading
from datetime import UTC, datetime

from domain.import_job import (
    ImportJobRepository,
    ImportState,
    ImportStateConflict,
    validate_import_id,
)
from domain.run import (
    RunActivity,
    RunPipeline,
    RunProgress,
    RunStage,
    RunState,
    RunTransitionMetadata,
)
from ports import RunRepository

_PIPELINE_STAGE_ORDER = {
    RunPipeline.LEGACY_V1: {
        stage: index
        for index, stage in enumerate(
            (
                RunStage.STARTING,
                RunStage.RESTORING,
                RunStage.VALIDATING,
                RunStage.INGESTING,
                RunStage.PROJECTING,
                RunStage.ARCHIVING,
                RunStage.ACTIVATING,
                RunStage.PUBLISHING,
                RunStage.SUCCEEDED,
                RunStage.PARTIAL,
                RunStage.FAILED,
                RunStage.SKIPPED_LOCKED,
                RunStage.SKIPPED_DISABLED,
            )
        )
    },
    RunPipeline.CANONICAL_V2: {
        stage: index
        for index, stage in enumerate(
            (
                RunStage.STARTING,
                RunStage.RESTORING,
                RunStage.VALIDATING,
                RunStage.EXTRACTING,
                RunStage.ARCHIVING,
                RunStage.PROJECTING,
                RunStage.MATERIALIZING_HOT,
                RunStage.FINALIZING_CANDIDATE,
                RunStage.PUBLISHING,
                RunStage.SUCCEEDED,
                RunStage.PARTIAL,
                RunStage.FAILED,
                RunStage.SKIPPED_LOCKED,
                RunStage.SKIPPED_DISABLED,
            )
        )
    },
}


def _is_after(pipeline: RunPipeline, checkpoint: RunStage, current: RunStage) -> bool:
    order = _PIPELINE_STAGE_ORDER[pipeline]
    return order.get(checkpoint, -1) > order.get(current, -1)


class ImportProgressRunRepository(RunRepository):
    def __init__(
        self,
        delegate: RunRepository,
        jobs: ImportJobRepository,
        import_id: str,
    ) -> None:
        self._delegate, self._jobs = delegate, jobs
        self._import_id = validate_import_id(import_id)
        self._lock = threading.Lock()

    @staticmethod
    def _timestamp(value: datetime) -> str:
        return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def report_activity(self, activity: RunActivity) -> None:
        public_progress = {
            "kind": "stage",
            "stage": "PUBLISHING"
            if activity.stage == RunStage.ACTIVATING
            else activity.stage.value,
            "stageStartedAt": self._timestamp(activity.stage_started_at),
            "heartbeatAt": self._timestamp(activity.observed_at),
            "recordsRead": activity.records_read,
            "recordsWritten": activity.records_written,
            "recordsRejected": activity.records_rejected,
            "recordsTotal": activity.records_total,
            "currentDataset": activity.current_dataset,
            "datasetsCompleted": activity.datasets_completed,
            "datasetsTotal": activity.datasets_total,
        }
        if activity.substage is not None:
            public_progress["substage"] = activity.substage
        if activity.units_completed is not None:
            public_progress.update(
                unitsCompleted=activity.units_completed,
                unitsTotal=activity.units_total,
                unitLabel=activity.unit_label,
            )
        with self._lock:
            for attempt in range(2):
                job = self._jobs.get(self._import_id)
                if job is None or job.state != ImportState.PROCESSING:
                    raise ImportStateConflict("Import state conflict")
                if job.progress_run_stage is not None and (
                    _is_after(
                        job.pipeline_version,
                        RunStage(job.progress_run_stage),
                        activity.stage,
                    )
                ):
                    return
                current_heartbeat = job.progress.get("heartbeatAt")
                if (
                    job.progress_run_stage == activity.stage
                    and isinstance(current_heartbeat, str)
                    and datetime.fromisoformat(current_heartbeat) > activity.observed_at
                ):
                    return
                if job.progress_run_stage == activity.stage and job.progress == public_progress:
                    return
                try:
                    self._jobs.update_progress(
                        self._import_id,
                        job.version,
                        {
                            "progressRunStage": activity.stage.value,
                            "updatedAt": self._timestamp(activity.observed_at),
                            "progress": public_progress,
                        },
                    )
                    return
                except ImportStateConflict:
                    if attempt == 1:
                        raise

    def _mirror(self, progress: RunProgress) -> None:
        state = progress.state
        public_progress = {
            "kind": "stage",
            "stage": "PUBLISHING" if state.stage == RunStage.ACTIVATING else state.stage.value,
            "recordsRead": progress.records_read,
            "recordsWritten": progress.records_written,
            "recordsRejected": progress.records_rejected,
        }
        for attempt in range(2):
            job = self._jobs.get(self._import_id)
            if job is None or job.state != ImportState.PROCESSING:
                raise ImportStateConflict("Import state conflict")
            # One deterministic run per import; its acyclic stage is the durable replay
            # checkpoint. Keep the raw stage because ACTIVATING and PUBLISHING share the
            # public PUBLISHING label.
            if job.progress_run_stage is not None and (
                _is_after(
                    state.pipeline,
                    RunStage(job.progress_run_stage),
                    state.stage,
                )
            ):
                return
            if (
                job.progress_run_stage == state.stage
                and job.progress.get("kind") == "stage"
                and job.progress.get("stage") == public_progress["stage"]
                and all(
                    isinstance(value := job.progress.get(field), int) and value >= expected
                    for field, expected in (
                        ("recordsRead", progress.records_read),
                        ("recordsWritten", progress.records_written),
                        ("recordsRejected", progress.records_rejected),
                    )
                )
            ):
                return
            if job.progress_run_stage == state.stage and job.progress == public_progress:
                return
            try:
                self._jobs.update_progress(
                    self._import_id,
                    job.version,
                    {
                        "progressRunStage": state.stage.value,
                        "updatedAt": progress.updated_at.astimezone(UTC)
                        .isoformat(timespec="milliseconds")
                        .replace("+00:00", "Z"),
                        "progress": public_progress,
                    },
                )
                return
            except ImportStateConflict:
                if attempt == 1:
                    raise

    def get_run_progress(self, run_id: str) -> RunProgress | None:
        progress = self._delegate.get_run_progress(run_id)
        if progress is not None:
            self._mirror(progress)
        return progress

    def get_run(self, run_id: str) -> RunState | None:
        progress = self.get_run_progress(run_id)
        return None if progress is None else progress.state

    def create(self, state: RunState, *, idempotency_key: str) -> RunState:
        persisted = self._delegate.create(state, idempotency_key=idempotency_key)
        if self.get_run_progress(state.run_id) is None:
            raise ImportStateConflict("Run write was not confirmed")
        return persisted

    def transition(
        self,
        run_id: str,
        target: RunStage,
        *,
        expected_stage: RunStage,
        metadata: RunTransitionMetadata | None = None,
        mark_candidate_active: bool = False,
        idempotency_key: str,
    ) -> RunState:
        persisted = self._delegate.transition(
            run_id,
            target,
            expected_stage=expected_stage,
            metadata=metadata,
            mark_candidate_active=mark_candidate_active,
            idempotency_key=idempotency_key,
        )
        if self.get_run_progress(run_id) is None:
            raise ImportStateConflict("Run write was not confirmed")
        return persisted

    def append_error(
        self,
        run_id: str,
        sequence: int,
        message: str,
        *,
        expected_stage: RunStage,
        idempotency_key: str,
    ) -> None:
        self._delegate.append_error(
            run_id,
            sequence,
            message,
            expected_stage=expected_stage,
            idempotency_key=idempotency_key,
        )
