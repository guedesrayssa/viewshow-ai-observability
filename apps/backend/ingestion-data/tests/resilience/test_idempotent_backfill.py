"""Verify backfill retries are idempotent across archive and projection writes."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from domain.analysis import canonical_utc_text
from domain.identity import sha256_id
from domain.models import CanonicalRecord
from domain.run import RunPipeline, RunStage
from ports import ArchiveState, CandidateManifest, LeaseBusy, OutboxEvent, WriteResult
from tests.unit.application.test_backfill import build_backfill


def analysis_event(dataset_version: str, created_at: datetime) -> OutboxEvent:
    end = created_at
    identity = {
        "datasetVersion": dataset_version,
        "eventType": "ANOMALY_DETECTION",
        "windowEnd": end,
    }
    return OutboxEvent(
        sha256_id("evt_", identity),
        dataset_version,
        "ANOMALY_DETECTION",
        sha256_id("ana_", identity),
        created_at,
        {
            "window": {
                "start": canonical_utc_text(end - timedelta(minutes=15), "start"),
                "end": canonical_utc_text(end, "end"),
                "grainSeconds": 900,
            },
            "scope": {"kind": "global", "dimensions": {}},
            "inputWatermark": canonical_utc_text(end, "watermark"),
        },
    )


def test_restart_resumes_after_durable_checkpoint_without_duplicate_effect(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    original_write = harness.service._hot_sink.write
    attempts = 0

    def crash_on_second_page(
        records: tuple[CanonicalRecord, ...],
        dataset_version: str,
        partition: str,
        *,
        idempotency_key: str,
    ) -> WriteResult:
        nonlocal attempts
        attempts += 1
        if attempts == 2:
            raise KeyboardInterrupt
        return original_write(
            records,
            dataset_version,
            partition,
            idempotency_key=idempotency_key,
        )

    harness.service._hot_sink.write = crash_on_second_page  # type: ignore[method-assign]
    with pytest.raises(KeyboardInterrupt):
        harness.service.execute(harness.request)

    checkpoint = harness.checkpoints.get(harness.version, harness.registry.names()[0])
    assert checkpoint is not None
    assert len(harness.backend.fact_records) == 1

    harness.service._hot_sink.write = original_write  # type: ignore[method-assign]
    result = harness.service.execute(replace(harness.request, run_id="run-restart"))

    assert result.active_dataset_version == harness.version
    assert len(harness.backend.fact_records) == len(harness.registry.names())
    assert len(set(harness.backend.fact_records)) == len(harness.backend.fact_records)


def test_canonical_retry_republishes_no_hot_items_and_keeps_skip_evidence(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    request = replace(
        harness.request,
        pipeline=RunPipeline.CANONICAL_V2,
        materialize_hot_records=False,
        activate=False,
    )

    first = harness.service.execute(request)
    first_candidate = harness.manifests.get_candidate(first.dataset_version)
    retried = harness.service.execute(replace(request, run_id="run-canonical-retry"))

    assert retried.stage is RunStage.SUCCEEDED
    assert retried.dataset_version == first.dataset_version
    assert harness.manifests.get_candidate(retried.dataset_version) == first_candidate
    assert harness.backend.fact_records == {}
    assert harness.service._hot_sink.write_calls == 0  # type: ignore[attr-defined]
    assert harness.hot_expiration.authorize_calls == 0
    assert harness.checkpoints.checkpoints == {}
    assert harness.manifests.get_active() == CandidateManifest("dsv_old", {"legacy": True})
    for run_id in (request.run_id, "run-canonical-retry"):
        skipped = next(
            metadata
            for state, metadata in harness.runs.transitions[run_id]
            if state.stage is RunStage.MATERIALIZING_HOT
        )
        assert (skipped.units_completed, skipped.units_total, skipped.unit_label) == (
            0,
            0,
            "datasets",
        )
        assert skipped.substage == "SKIPPED_BY_POLICY"


def test_live_lease_blocks_competing_run_before_restore_or_reader(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    now = datetime(2026, 9, 9, tzinfo=UTC)
    harness.leases.acquire(
        "argus",
        "other-run",
        now,
        600,
        idempotency_key="external-acquire",
    )

    with pytest.raises(LeaseBusy):
        harness.service.execute(harness.request)

    assert harness.lifecycle == []
    assert harness.runs.runs == {}
    assert harness.leases.leases["argus"].owner == "other-run"


def test_old_pending_outbox_is_published_before_new_window_events(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    old = analysis_event("dsv_previous", datetime(2026, 8, 1, tzinfo=UTC))
    harness.backend.outboxes[old.event_id] = old
    harness.backend.outbox_states[old.event_id] = "PENDING"

    result = harness.service.execute(harness.request)

    assert result.new_analysis_events == 2
    assert harness.publisher.published[0] == old
    assert len(harness.publisher.published) == 3
    assert harness.outboxes.list_pending(10) == ()


def test_exact_snapshot_replay_has_no_new_logical_effect(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    first = harness.service.execute(harness.request)
    objects = dict(harness.service._archive_publisher.object_store.objects)  # type: ignore[attr-defined]
    events = dict(harness.backend.outboxes)
    fact_expirations = dict(harness.backend.fact_expirations)
    projection_expirations = dict(harness.backend.projection_expirations)
    ttl_authorizations = dict(harness.backend.ttl_authorizations)

    second = harness.service.execute(replace(harness.request, run_id="run-replay"))

    assert second.dataset_version == first.dataset_version
    assert second.records_written == 0
    assert second.records_unchanged == 0
    assert second.new_archive_objects == 0
    assert second.new_analysis_events == 0
    assert harness.service._archive_publisher.object_store.objects == objects  # type: ignore[attr-defined]
    assert harness.backend.outboxes == events
    assert harness.backend.fact_expirations == fact_expirations
    assert harness.backend.projection_expirations == projection_expirations
    assert harness.backend.ttl_authorizations == ttl_authorizations


def test_partial_publication_restart_drains_pending_without_recreating_event(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    harness.publisher._failures.append(RuntimeError("temporary SQS failure"))
    partial = harness.service.execute(harness.request)
    assert partial.stage.value == "PARTIAL"
    event_ids = set(harness.backend.outboxes)

    resumed = harness.service.execute(replace(harness.request, run_id="run-publish-resume"))

    assert resumed.stage.value == "SUCCEEDED"
    assert resumed.new_analysis_events == 0
    assert set(harness.backend.outboxes) == event_ids
    assert harness.outboxes.list_pending(10) == ()


def test_deferred_activation_never_authorizes_hot_ttl(tmp_path: Path) -> None:
    """Changing publication to authorize TTL before activation must fail this test."""
    harness = build_backfill(tmp_path)

    result = harness.service.execute(replace(harness.request, activate=False))

    assert result.active_dataset_version == "dsv_old"
    assert harness.manifests.get_candidate(harness.version) is not None
    assert harness.backend.archive_partitions
    assert all(
        archive.state is ArchiveState.AVAILABLE
        for archive in harness.backend.archive_partitions.values()
    )
    assert harness.backend.fact_expirations == {}
    assert harness.backend.projection_expirations == {}
    assert harness.backend.ttl_authorizations == {}


def test_deferred_candidate_authorizes_hot_ttl_after_later_activation(tmp_path: Path) -> None:
    """Removing post-activation TTL reconciliation must fail this test."""
    harness = build_backfill(tmp_path)
    harness.service.execute(replace(harness.request, activate=False))

    result = harness.service.execute(
        replace(harness.request, run_id="run-activate-deferred", activate=True)
    )

    assert result.active_dataset_version == harness.version
    assert harness.backend.fact_expirations
    assert harness.backend.projection_expirations
    assert harness.backend.ttl_authorizations


def test_ttl_retry_after_activation_crash_converges_without_reactivating(
    tmp_path: Path,
) -> None:
    """Moving TTL before durable activation must fail this crash/retry regression."""
    harness = build_backfill(tmp_path)
    expiration = harness.service._archive_publisher.expiration
    original_authorize = expiration.authorize_expiration
    attempts = 0

    def crash_once(
        dataset_version: str,
        dataset: str,
        partition: str,
        ttl_epoch_s: int,
        *,
        expected_archive_state: ArchiveState,
        idempotency_key: str,
    ) -> int:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise KeyboardInterrupt
        return original_authorize(
            dataset_version,
            dataset,
            partition,
            ttl_epoch_s,
            expected_archive_state=expected_archive_state,
            idempotency_key=idempotency_key,
        )

    expiration.authorize_expiration = crash_once  # type: ignore[method-assign]
    with pytest.raises(KeyboardInterrupt):
        harness.service.execute(harness.request)

    assert harness.manifests.active is not None
    assert harness.manifests.active.dataset_version == harness.version
    assert harness.backend.fact_expirations == {}

    expiration.authorize_expiration = original_authorize  # type: ignore[method-assign]
    retried = harness.service.execute(replace(harness.request, run_id="run-ttl-retry"))

    assert retried.active_dataset_version == harness.version
    assert harness.backend.fact_expirations
    assert harness.backend.projection_expirations


def test_active_retry_resumes_only_publishing_without_reprojecting_or_rearchiving(
    tmp_path: Path,
) -> None:
    expected = build_backfill(tmp_path / "expected")
    expected.service.execute(expected.request)
    expected_event_ids = set(expected.backend.outboxes)
    expected_watermarks = {
        source: watermark
        for (dataset_version, source), watermark in expected.backend.watermarks.items()
        if dataset_version == expected.version and source.startswith("analysis:")
    }
    harness = build_backfill(tmp_path)
    expiration = harness.service._archive_publisher.expiration
    original_authorize = expiration.authorize_expiration
    crashed = False

    def crash_after_activation(*args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal crashed
        if not crashed:
            crashed = True
            raise KeyboardInterrupt
        return original_authorize(*args, **kwargs)

    expiration.authorize_expiration = crash_after_activation  # type: ignore[method-assign]
    with pytest.raises(KeyboardInterrupt):
        harness.service.execute(harness.request)

    assert harness.backend.outboxes == {}

    projections_before = dict(harness.backend.projection_operational)
    archives_before = dict(harness.backend.archive_partitions)

    def unexpected_pre_activation_effect(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("an already-active retry must resume only post-activation effects")

    harness.service._restorer.restore = unexpected_pre_activation_effect  # type: ignore[method-assign]
    harness.service._reader_factory = unexpected_pre_activation_effect
    harness.service._hot_sink.write = unexpected_pre_activation_effect  # type: ignore[method-assign]

    class NoProjectionWrites:
        materialize_record_batches = staticmethod(unexpected_pre_activation_effect)

    harness.service._projections = NoProjectionWrites()  # type: ignore[assignment]
    expiration.authorize_expiration = original_authorize  # type: ignore[method-assign]

    retried = harness.service.execute(replace(harness.request, run_id="run-active-retry"))

    assert retried.stage.value == "SUCCEEDED"
    assert retried.active_dataset_version == harness.version
    assert retried.new_archive_objects == 0
    assert retried.new_analysis_events == len(expected_event_ids)
    assert harness.backend.projection_operational == projections_before
    assert harness.backend.archive_partitions == archives_before
    assert set(harness.backend.outboxes) == expected_event_ids
    assert {
        source: watermark
        for (dataset_version, source), watermark in harness.backend.watermarks.items()
        if dataset_version == harness.version and source.startswith("analysis:")
    } == expected_watermarks

    replayed = harness.service.execute(replace(harness.request, run_id="run-active-replay"))

    assert replayed.new_analysis_events == 0
    assert set(harness.backend.outboxes) == expected_event_ids


def test_active_retry_with_missing_complete_interval_evidence_returns_partial(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    harness.service.execute(harness.request)
    active = harness.manifests.active
    assert active is not None
    metadata = dict(active.metadata)
    available = dict(metadata["availableIntervals"])
    available.pop("live_qoe_hourly")
    metadata["availableIntervals"] = available
    harness.manifests.active = CandidateManifest(harness.version, metadata)
    projections_before = dict(harness.backend.projection_operational)

    def unexpected_restore(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("ACTIVE retry must fail before reading a new snapshot")

    harness.service._restorer.restore = unexpected_restore  # type: ignore[method-assign]

    result = harness.service.execute(replace(harness.request, run_id="run-invalid-active"))

    assert result.stage.value == "PARTIAL"
    assert harness.backend.projection_operational == projections_before


def test_no_activate_after_ttl_crash_never_authorizes_hot_ttl(tmp_path: Path) -> None:
    """Conflating an already-active candidate with --activate must fail this test."""
    harness = build_backfill(tmp_path)
    expiration = harness.service._archive_publisher.expiration
    original_authorize = expiration.authorize_expiration

    def crash_before_ttl(
        dataset_version: str,
        dataset: str,
        partition: str,
        ttl_epoch_s: int,
        *,
        expected_archive_state: ArchiveState,
        idempotency_key: str,
    ) -> int:
        del (
            dataset_version,
            dataset,
            partition,
            ttl_epoch_s,
            expected_archive_state,
            idempotency_key,
        )
        raise KeyboardInterrupt

    expiration.authorize_expiration = crash_before_ttl  # type: ignore[method-assign]
    with pytest.raises(KeyboardInterrupt):
        harness.service.execute(harness.request)

    assert harness.manifests.active is not None
    assert harness.manifests.active.dataset_version == harness.version
    assert harness.backend.fact_expirations == {}

    expiration.authorize_expiration = original_authorize  # type: ignore[method-assign]
    result = harness.service.execute(
        replace(harness.request, run_id="run-no-activate-after-crash", activate=False)
    )

    assert result.active_dataset_version == harness.version
    assert harness.backend.fact_expirations == {}
    assert harness.backend.projection_expirations == {}
    assert harness.backend.ttl_authorizations == {}


def test_ttl_failure_after_activation_returns_partial_without_undoing_active_candidate(
    tmp_path: Path,
) -> None:
    """Placing TTL outside post-activation publishing must fail this regression."""
    harness = build_backfill(tmp_path)

    def fail_ttl(*_args: object, **_kwargs: object) -> int:
        raise RuntimeError("TTL service unavailable")

    harness.service._archive_publisher.expiration.authorize_expiration = fail_ttl  # type: ignore[method-assign]
    partial = harness.service.execute(harness.request)

    assert partial.stage.value == "PARTIAL"
    assert partial.active_dataset_version == harness.version
    assert harness.manifests.active is not None
    assert harness.manifests.active.dataset_version == harness.version
