"""Fault-inject every canonical-first durability boundary and replay it safely."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from application.backfill import BackfillFailed
from application.rebuild_projections import ProjectionService
from domain.run import RunPipeline, RunStage
from ports import ArchiveObject, ArchiveState
from tests.fakes import FakeArchiveObjectStore, FakeProjectionRepository
from tests.unit.application.test_backfill import build_backfill


class ObservedObjectStore(FakeArchiveObjectStore):
    """Count physical object creation separately from idempotent replay calls."""

    def __init__(self) -> None:
        super().__init__()
        self.stage_writes: dict[str, int] = {}
        self.promote_writes: dict[str, int] = {}

    def stage(self, partition, key, **kwargs):  # type: ignore[no-untyped-def]
        existed = key in self.objects
        result = super().stage(partition, key, **kwargs)
        if not existed:
            self.stage_writes[key] = self.stage_writes.get(key, 0) + 1
        return result

    def promote(self, staged, canonical_key, **kwargs):  # type: ignore[no-untyped-def]
        existed = canonical_key in self.objects
        result = super().promote(staged, canonical_key, **kwargs)
        if not existed:
            self.promote_writes[canonical_key] = self.promote_writes.get(canonical_key, 0) + 1
        return result


class NoHotFactProjectionRepository(FakeProjectionRepository):
    """Make an accidental canonical-v2 hot-fact read observable and fatal."""

    def iter_input_batches(self, *_args, **_kwargs):  # type: ignore[no-untyped-def]
        raise AssertionError("canonical-v2 must not read hot facts")

    def query_inputs(self, *_args, **_kwargs):  # type: ignore[no-untyped-def]
        raise AssertionError("canonical-v2 must not read hot facts")


class FailDuringProjectionRepository(NoHotFactProjectionRepository):
    def __init__(self, *, backend) -> None:  # type: ignore[no-untyped-def]
        super().__init__(backend=backend)
        self._failures = 1
        self.successful_puts_before_failure = 0

    def put(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        if self._failures and self.successful_puts_before_failure >= 1:
            self._failures -= 1
            raise RuntimeError("projection fault")
        result = super().put(*args, **kwargs)
        if self._failures:
            self.successful_puts_before_failure += 1
        return result


class FailAfterSomePartitionsPublisher:
    """Delegate to the real publisher, then fail after a configured durable partition."""

    def __init__(self, inner, *, fail_after: int) -> None:  # type: ignore[no-untyped-def]
        self._inner = inner
        self._fail_after = fail_after
        self._published = 0

    def __getattr__(self, name: str):  # type: ignore[no-untyped-def]
        return getattr(self._inner, name)

    def publish_canonical(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        result = self._inner.publish_canonical(*args, **kwargs)
        self._published += 1
        if self._published == self._fail_after:
            raise RuntimeError("partition fault")
        return result


def _canonical_harness(tmp_path: Path):  # type: ignore[no-untyped-def]
    harness = build_backfill(tmp_path)
    request = replace(
        harness.request,
        pipeline=RunPipeline.CANONICAL_V2,
        materialize_hot_records=False,
        activate=False,
    )
    store = ObservedObjectStore()
    object.__setattr__(harness.service._archive_publisher, "object_store", store)
    repository = NoHotFactProjectionRepository(backend=harness.backend)
    harness.service._projections = ProjectionService(repository)  # type: ignore[assignment]
    return harness, request, store


def _assert_failed_without_visibility(harness, request, stage: RunStage) -> None:  # type: ignore[no-untyped-def]
    assert harness.runs.runs[request.run_id].stage is RunStage.FAILED
    assert harness.runs.transitions[request.run_id][-1][0].stage is RunStage.FAILED
    assert harness.manifests.get_candidate(harness.canonical_version) is None
    active = harness.manifests.get_active()
    assert active is not None and active.dataset_version == "dsv_old"
    assert harness.service._hot_sink.write_calls == 0
    assert harness.backend.fact_records == {}
    assert harness.runs.transitions[request.run_id][-2][0].stage is stage


def _retry_and_assert_reconciled(harness, request, store, suffix: str):  # type: ignore[no-untyped-def]
    result = harness.service.execute(replace(request, run_id=f"run-retry-{suffix}"))
    marker = harness.canonical_sets.get(harness.canonical_version)

    assert result.stage is RunStage.SUCCEEDED
    assert result.records_read == result.records_accepted == len(harness.registry.names())
    assert result.records_rejected == 0
    assert result.records_written + result.records_unchanged == result.records_accepted
    assert marker is not None
    assert marker.total_source_rows == result.records_read
    assert marker.total_accepted_rows == result.records_accepted
    assert marker.total_rejected_rows == result.records_rejected
    assert (
        sum(partition.row_count for dataset in marker.datasets for partition in dataset.partitions)
        == marker.total_accepted_rows
    )
    assert all(
        partition.state is ArchiveState.AVAILABLE
        for partition in harness.backend.archive_partitions.values()
    )
    object_keys = {
        item.object_key
        for dataset in marker.datasets
        for partition in dataset.partitions
        for item in partition.objects
    }
    assert len(object_keys) == sum(
        len(partition.objects) for dataset in marker.datasets for partition in dataset.partitions
    )
    assert store.stage_writes and max(store.stage_writes.values()) == 1
    assert store.promote_writes and max(store.promote_writes.values()) == 1
    assert harness.service._hot_sink.write_calls == 0
    assert harness.backend.fact_records == {}
    active = harness.manifests.get_active()
    assert active is not None and active.dataset_version == "dsv_old"
    candidate = harness.manifests.get_candidate(harness.canonical_version)
    assert candidate is not None and candidate.dataset_version != active.dataset_version
    return result


def test_retry_after_extraction_before_first_upload_is_lossless(tmp_path: Path) -> None:
    harness, request, store = _canonical_harness(tmp_path)
    original_stage = store.stage
    failures = 1

    def fail_before_first_upload(*args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal failures
        if failures:
            failures -= 1
            raise RuntimeError("upload fault")
        return original_stage(*args, **kwargs)

    store.stage = fail_before_first_upload  # type: ignore[method-assign]
    with pytest.raises(BackfillFailed) as captured:
        harness.service.execute(request)
    assert captured.value.stage is RunStage.ARCHIVING
    assert store.stage_writes == {}
    assert store.promote_writes == {}
    _assert_failed_without_visibility(harness, request, RunStage.ARCHIVING)

    store.stage = original_stage  # type: ignore[method-assign]
    _retry_and_assert_reconciled(harness, request, store, "before-upload")


def test_retry_after_promotion_before_state_update_does_not_resend_object(
    tmp_path: Path,
) -> None:
    harness, request, store = _canonical_harness(tmp_path)
    partitions = harness.service._archive_publisher.partitions
    original_update = partitions.update_state
    failures = 1

    def fail_before_uploaded_state(*args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal failures
        target = args[3] if len(args) > 3 else kwargs.get("state")
        if target is ArchiveState.UPLOADED and failures:
            failures -= 1
            raise RuntimeError("state fault")
        return original_update(*args, **kwargs)

    partitions.update_state = fail_before_uploaded_state  # type: ignore[method-assign]
    with pytest.raises(BackfillFailed) as captured:
        harness.service.execute(request)
    assert captured.value.stage is RunStage.ARCHIVING
    assert len(store.promote_writes) == 1
    _assert_failed_without_visibility(harness, request, RunStage.ARCHIVING)

    partitions.update_state = original_update  # type: ignore[method-assign]
    _retry_and_assert_reconciled(harness, request, store, "after-promotion")


def test_retry_after_some_available_partitions_reuses_their_objects(tmp_path: Path) -> None:
    harness, request, store = _canonical_harness(tmp_path)
    publisher = harness.service._archive_publisher
    harness.service._archive_publisher = FailAfterSomePartitionsPublisher(  # type: ignore[assignment]
        publisher,
        fail_after=3,
    )
    with pytest.raises(BackfillFailed) as captured:
        harness.service.execute(request)
    assert captured.value.stage is RunStage.ARCHIVING
    assert (
        sum(
            partition.state is ArchiveState.AVAILABLE
            for partition in harness.backend.archive_partitions.values()
        )
        == 3
    )
    _assert_failed_without_visibility(harness, request, RunStage.ARCHIVING)

    harness.service._archive_publisher = publisher
    _retry_and_assert_reconciled(harness, request, store, "partial-archive")


def test_retry_after_marker_before_projection_skips_restore_and_upload(tmp_path: Path) -> None:
    harness, request, store = _canonical_harness(tmp_path)
    original_project = harness.service._project_canonical
    failures = 1

    def fail_before_projection(*args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal failures
        if failures:
            failures -= 1
            raise RuntimeError("projection unavailable")
        return original_project(*args, **kwargs)

    harness.service._project_canonical = fail_before_projection  # type: ignore[method-assign]
    with pytest.raises(BackfillFailed) as captured:
        harness.service.execute(request)
    assert captured.value.stage is RunStage.PROJECTING
    assert harness.canonical_sets.get(harness.canonical_version) is not None
    _assert_failed_without_visibility(harness, request, RunStage.PROJECTING)
    lifecycle = tuple(harness.lifecycle)
    writes = (dict(store.stage_writes), dict(store.promote_writes))

    _retry_and_assert_reconciled(harness, request, store, "after-marker")
    assert tuple(harness.lifecycle) == lifecycle
    assert (store.stage_writes, store.promote_writes) == writes


def test_retry_during_projection_is_idempotent_before_candidate(tmp_path: Path) -> None:
    harness, request, store = _canonical_harness(tmp_path)
    repository = FailDuringProjectionRepository(backend=harness.backend)
    harness.service._projections = ProjectionService(repository)  # type: ignore[assignment]

    with pytest.raises(BackfillFailed) as captured:
        harness.service.execute(request)
    assert captured.value.stage is RunStage.PROJECTING
    assert repository.successful_puts_before_failure == 1
    assert harness.backend.projections
    _assert_failed_without_visibility(harness, request, RunStage.PROJECTING)

    _retry_and_assert_reconciled(harness, request, store, "during-projection")


def test_checksum_divergence_in_available_partition_fails_closed_then_recovers(
    tmp_path: Path,
) -> None:
    harness, request, store = _canonical_harness(tmp_path)
    original_commit = harness.canonical_sets.commit
    failures = 1

    def fail_before_marker(*args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal failures
        if failures:
            failures -= 1
            raise RuntimeError("marker fault")
        return original_commit(*args, **kwargs)

    harness.canonical_sets.commit = fail_before_marker  # type: ignore[method-assign]
    with pytest.raises(BackfillFailed):
        harness.service.execute(request)
    _assert_failed_without_visibility(harness, request, RunStage.ARCHIVING)

    canonical_key = next(key for key in sorted(store.objects) if key.startswith("canonical/"))
    correct = store.objects[canonical_key]
    store.objects[canonical_key] = ArchiveObject(canonical_key, "0" * 64, correct.size)
    divergent = replace(request, run_id="run-checksum-divergent")
    with pytest.raises(BackfillFailed) as captured:
        harness.service.execute(divergent)
    assert captured.value.stage is RunStage.ARCHIVING
    _assert_failed_without_visibility(harness, divergent, RunStage.ARCHIVING)
    assert harness.canonical_sets.get(harness.canonical_version) is None

    store.objects[canonical_key] = correct
    _retry_and_assert_reconciled(harness, request, store, "checksum-repaired")
