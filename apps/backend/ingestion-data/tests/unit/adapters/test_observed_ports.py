"""Verify telemetry wrappers observe ingestion port operations consistently."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from adapters.telemetry.observed_ports import (
    ObservedAthenaValidator,
    ObservedRunRepository,
    ObservedSnapshotQueryPreparer,
    ObservedSnapshotRestorer,
    ObservedSourceReader,
)
from contracts.registry import DatasetRegistry
from domain.datasets import DatasetDescriptor
from domain.models import TimeWindow
from domain.quality import CoverageStatus
from domain.run import RunProgress, RunStage, RunState, RunTransitionMetadata
from ports import (
    AthenaValidator,
    CoverageObservation,
    MetricsPublisher,
    QueryPlanEvidence,
    RestoreRequest,
    RestoreResult,
    RunRepository,
    SchemaObservation,
    SnapshotPreparer,
    SnapshotRestorer,
    SourcePage,
    SourceReader,
)

NOW = datetime(2026, 9, 10, 12, 0, tzinfo=UTC)


class RecordingMetrics(MetricsPublisher):
    def __init__(self) -> None:
        self.values: list[tuple[str, int | float, dict[str, str]]] = []

    def increment(self, name: str, value: int, dimensions: Mapping[str, str]) -> None:
        self.values.append((name, value, dict(dimensions)))

    def gauge(self, name: str, value: float, dimensions: Mapping[str, str]) -> None:
        self.values.append((name, value, dict(dimensions)))

    def timing(self, name: str, milliseconds: float, dimensions: Mapping[str, str]) -> None:
        self.values.append((name, milliseconds, dict(dimensions)))


class Reader(SourceReader):
    def __init__(
        self,
        schema: SchemaObservation,
        coverage: CoverageObservation,
    ) -> None:
        self.schema = schema
        self.coverage = coverage

    def validate_schema(self, descriptor: DatasetDescriptor) -> SchemaObservation:
        return self.schema

    def measure_coverage(self, descriptor: DatasetDescriptor) -> CoverageObservation:
        return self.coverage

    def read_page(
        self,
        descriptor: DatasetDescriptor,
        window: TimeWindow | None,
        after: tuple[object, ...] | None,
        limit: int,
    ) -> SourcePage:
        return SourcePage((), None)


def test_source_observer_measures_page_duration_and_rows_with_dataset_dimensions() -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")
    page = SourcePage(({"id": 1}, {"id": 2}), (2,))

    class PagedReader(Reader):
        def read_page(
            self,
            descriptor: DatasetDescriptor,
            window: TimeWindow | None,
            after: tuple[object, ...] | None,
            limit: int,
        ) -> SourcePage:
            return page

    metrics = RecordingMetrics()
    readings = iter((10.0, 10.25))
    reader = ObservedSourceReader(
        PagedReader(
            SchemaObservation("a" * 64, True),
            CoverageObservation(CoverageStatus.COMPLETE, 0, None),
        ),
        metrics,
        command="backfill",
        source_mode="snapshot",
        monotonic=lambda: next(readings),
    )

    assert reader.read_page(descriptor, None, ("sensitive-cursor",), 500) is page
    assert metrics.values == [
        (
            "MySqlPageDurationMs",
            250.0,
            {"command": "backfill", "source_mode": "snapshot", "dataset": "signal_bucket"},
        ),
        (
            "MySqlPageRows",
            2,
            {"command": "backfill", "source_mode": "snapshot", "dataset": "signal_bucket"},
        ),
    ]


class Preparer(SnapshotPreparer):
    def __init__(self, result: tuple[QueryPlanEvidence, ...] | Exception) -> None:
        self.result = result

    def prepare(self, descriptors: tuple[DatasetDescriptor, ...]) -> tuple[QueryPlanEvidence, ...]:
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def test_snapshot_preparer_observer_measures_index_and_total_preflight_duration() -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")
    evidence = QueryPlanEvidence("signal_bucket", "ix_ingestion_cursor", ("id",), True, "range", 7)
    metrics = RecordingMetrics()
    readings = iter((20.0, 20.5))
    preparer = ObservedSnapshotQueryPreparer(
        Preparer((evidence,)),
        metrics,
        command="backfill",
        monotonic=lambda: next(readings),
    )

    assert preparer.prepare((descriptor,)) == (evidence,)
    assert metrics.values == [
        (
            "MySqlCursorIndexDurationMs",
            500.0,
            {"command": "backfill", "source_mode": "snapshot"},
        ),
        (
            "MySqlPreflightDurationMs",
            500.0,
            {"command": "backfill", "source_mode": "snapshot"},
        ),
    ]


def test_snapshot_preparer_observer_calls_inner_once_for_batch_and_emits_honest_aggregate() -> None:
    first = DatasetRegistry.load_argus_v2().require("signal_bucket")
    second = DatasetRegistry.load_argus_v2().require("finding_status_log")
    evidence = {
        first.table: QueryPlanEvidence(
            first.table, "ix_ingestion_cursor", first.cursor_key, True, "range", 7
        ),
        second.table: QueryPlanEvidence(
            second.table, "ix_ingestion_cursor", second.cursor_key, False, "range", 9
        ),
    }

    class BatchPreparer(SnapshotPreparer):
        def __init__(self) -> None:
            self.calls: list[tuple[DatasetDescriptor, ...]] = []

        def prepare(
            self, descriptors: tuple[DatasetDescriptor, ...]
        ) -> tuple[QueryPlanEvidence, ...]:
            self.calls.append(descriptors)
            return tuple(evidence[descriptor.table] for descriptor in descriptors)

    metrics = RecordingMetrics()
    inner = BatchPreparer()
    readings = iter((20.0, 20.75))
    preparer = ObservedSnapshotQueryPreparer(
        inner,
        metrics,
        command="backfill",
        monotonic=lambda: next(readings),
    )

    assert preparer.prepare((first, second)) == (evidence[first.table], evidence[second.table])
    assert inner.calls == [(first, second)]
    assert metrics.values == [
        (
            "MySqlCursorIndexDurationMs",
            750.0,
            {"command": "backfill", "source_mode": "snapshot"},
        ),
        (
            "MySqlPreflightDurationMs",
            750.0,
            {"command": "backfill", "source_mode": "snapshot"},
        ),
    ]


def test_snapshot_preparer_observer_preserves_atomic_batch_on_invalid_descriptor() -> None:
    valid = DatasetRegistry.load_argus_v2().require("signal_bucket")
    forged = replace(valid, table="forged_dataset")
    error = ValueError("descriptor is not present in the registry")
    clock = [20.0]

    class AtomicPreparer(SnapshotPreparer):
        def __init__(self) -> None:
            self.calls: list[tuple[DatasetDescriptor, ...]] = []

        def prepare(
            self, descriptors: tuple[DatasetDescriptor, ...]
        ) -> tuple[QueryPlanEvidence, ...]:
            self.calls.append(descriptors)
            if descriptors == (valid, forged):
                clock[0] += 0.5
                raise error
            if descriptors == (valid,):
                clock[0] += 0.25
                return (
                    QueryPlanEvidence(
                        valid.table, "ix_ingestion_cursor", valid.cursor_key, True, "range", 7
                    ),
                )
            if descriptors == (forged,):
                clock[0] += 0.25
                raise error
            raise AssertionError("unexpected batch")

    metrics = RecordingMetrics()
    inner = AtomicPreparer()
    preparer = ObservedSnapshotQueryPreparer(
        inner,
        metrics,
        command="backfill",
        monotonic=lambda: clock[0],
    )

    with pytest.raises(ValueError) as raised:
        preparer.prepare((valid, forged))

    assert raised.value is error
    assert inner.calls == [(valid, forged)]
    assert metrics.values == [
        (
            "MySqlPreflightDurationMs",
            500.0,
            {"command": "backfill", "source_mode": "snapshot"},
        ),
        ("MySqlPreflightFailures", 1, {"command": "backfill", "source_mode": "snapshot"}),
    ]


def test_snapshot_preparer_observer_counts_failures_without_replacing_them() -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")
    error = RuntimeError("preflight failed")
    metrics = RecordingMetrics()
    readings = iter((20.0, 20.5))
    preparer = ObservedSnapshotQueryPreparer(
        Preparer(error),
        metrics,
        command="backfill",
        monotonic=lambda: next(readings),
    )

    with pytest.raises(RuntimeError) as raised:
        preparer.prepare((descriptor,))

    assert raised.value is error
    assert metrics.values == [
        (
            "MySqlPreflightDurationMs",
            500.0,
            {"command": "backfill", "source_mode": "snapshot"},
        ),
        ("MySqlPreflightFailures", 1, {"command": "backfill", "source_mode": "snapshot"}),
    ]


def test_source_observer_uses_typed_schema_and_complete_coverage_evidence() -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")
    latest = NOW - timedelta(minutes=15)
    verified = NOW
    metrics = RecordingMetrics()
    reader = ObservedSourceReader(
        Reader(
            SchemaObservation("a" * 64, False, ("missing column",)),
            CoverageObservation(
                CoverageStatus.PARTIAL,
                3,
                TimeWindow(latest - timedelta(minutes=30), verified, 900),
                coverage_numerator=3,
                coverage_denominator=4,
                latest_observed_at=latest,
                verified_through=verified,
            ),
        ),
        metrics,
        command="backfill",
        source_mode="snapshot",
        clock=lambda: NOW,
    )

    assert reader.validate_schema(descriptor).is_compatible is False
    assert reader.measure_coverage(descriptor).row_count == 3

    assert metrics.values == [
        (
            "SchemaDrift",
            1,
            {"command": "backfill", "source_mode": "snapshot"},
        ),
        (
            "CoverageRatio",
            0.75,
            {
                "coverage_status": "partial",
                "dataset": "signal_bucket",
                "source_mode": "snapshot",
            },
        ),
        (
            "SourceLagSeconds",
            900.0,
            {"dataset": "signal_bucket", "source_mode": "snapshot"},
        ),
        (
            "WatermarkEpochSeconds",
            verified.timestamp(),
            {"dataset": "signal_bucket", "source_mode": "snapshot"},
        ),
    ]


def test_complete_status_without_units_does_not_invent_ratio_or_freshness() -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("live_event_sde")
    metrics = RecordingMetrics()
    reader = ObservedSourceReader(
        Reader(
            SchemaObservation("a" * 64, True),
            CoverageObservation(CoverageStatus.COMPLETE, 12, None),
        ),
        metrics,
        command="backfill",
        source_mode="snapshot",
        clock=lambda: NOW,
    )

    reader.measure_coverage(descriptor)

    assert metrics.values == []


def test_live_source_observer_requires_latest_observation_for_coverage_or_freshness() -> None:
    """A verified-through boundary is not evidence that live data is current."""
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")
    verified = NOW + timedelta(minutes=15)
    metrics = RecordingMetrics()
    reader = ObservedSourceReader(
        Reader(
            SchemaObservation("a" * 64, True),
            CoverageObservation(
                CoverageStatus.PARTIAL,
                3,
                TimeWindow(NOW - timedelta(minutes=30), verified, 900),
                coverage_numerator=3,
                coverage_denominator=4,
                verified_through=verified,
            ),
        ),
        metrics,
        command="sync",
        source_mode="live",
        clock=lambda: NOW,
    )

    reader.measure_coverage(descriptor)

    assert metrics.values == [
        (
            "WatermarkEpochSeconds",
            verified.timestamp(),
            {"dataset": "signal_bucket", "source_mode": "live"},
        )
    ]


def test_live_source_observer_emits_typed_coverage_and_lag_with_latest_observation() -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")
    latest = NOW - timedelta(minutes=15)
    verified = NOW
    metrics = RecordingMetrics()
    reader = ObservedSourceReader(
        Reader(
            SchemaObservation("a" * 64, True),
            CoverageObservation(
                CoverageStatus.PARTIAL,
                3,
                TimeWindow(latest - timedelta(minutes=30), verified, 900),
                coverage_numerator=3,
                coverage_denominator=4,
                latest_observed_at=latest,
                verified_through=verified,
            ),
        ),
        metrics,
        command="sync",
        source_mode="live",
        clock=lambda: NOW,
    )

    reader.measure_coverage(descriptor)

    assert metrics.values == [
        (
            "CoverageRatio",
            0.75,
            {
                "coverage_status": "partial",
                "dataset": "signal_bucket",
                "source_mode": "live",
            },
        ),
        (
            "SourceLagSeconds",
            900.0,
            {"dataset": "signal_bucket", "source_mode": "live"},
        ),
        (
            "WatermarkEpochSeconds",
            verified.timestamp(),
            {"dataset": "signal_bucket", "source_mode": "live"},
        ),
    ]


class Restorer(SnapshotRestorer):
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error

    def restore(self, request: RestoreRequest, *, idempotency_key: str) -> RestoreResult:
        if self.error is not None:
            raise self.error
        return RestoreResult(request.expected_sha256, 10)


@pytest.mark.parametrize("fails", [False, True])
def test_restore_duration_preserves_result_or_original_exception(fails: bool) -> None:
    readings = iter((10.0, 10.25))
    metrics = RecordingMetrics()
    error = RuntimeError("restore failed") if fails else None
    observed = ObservedSnapshotRestorer(
        Restorer(error),
        metrics,
        command="backfill",
        monotonic=lambda: next(readings),
    )
    request = RestoreRequest("bucket", "dump.sql.gz", "version", "a" * 64)

    if error is None:
        assert observed.restore(request, idempotency_key="restore") == RestoreResult("a" * 64, 10)
    else:
        with pytest.raises(RuntimeError) as raised:
            observed.restore(request, idempotency_key="restore")
        assert raised.value is error

    assert metrics.values == [
        (
            "RestoreDurationMs",
            250.0,
            {
                "command": "backfill",
                "source_mode": "snapshot",
                "status": "FAILED" if fails else "SUCCEEDED",
            },
        )
    ]


def test_restore_does_not_invent_duration_when_clock_has_no_evidence() -> None:
    metrics = RecordingMetrics()
    observed = ObservedSnapshotRestorer(
        Restorer(),
        metrics,
        command="backfill",
        monotonic=lambda: (_ for _ in ()).throw(RuntimeError("clock unavailable")),
    )
    request = RestoreRequest("bucket", "dump.sql.gz", "version", "a" * 64)

    assert observed.restore(request, idempotency_key="restore") == RestoreResult("a" * 64, 10)
    assert metrics.values == []


class Runs(RunRepository):
    def get_run_progress(self, run_id: str) -> RunProgress | None:
        return None

    def get_run(self, run_id: str) -> RunState | None:
        return None

    def create(self, state: RunState, *, idempotency_key: str) -> RunState:
        return state

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
        return RunState.at(target, run_id=run_id, dataset_version="dsv")

    def append_error(
        self,
        run_id: str,
        sequence: int,
        message: str,
        *,
        expected_stage: RunStage,
        idempotency_key: str,
    ) -> None:
        return None


def test_run_transition_emits_persisted_stage_duration_and_failure() -> None:
    metrics = RecordingMetrics()
    observed = ObservedRunRepository(Runs(), metrics, command="backfill")
    metadata = RunTransitionMetadata(NOW, duration_ms=125)

    state = observed.transition(
        "run",
        RunStage.FAILED,
        expected_stage=RunStage.PROJECTING,
        metadata=metadata,
        idempotency_key="transition",
    )

    assert state.stage is RunStage.FAILED
    assert metrics.values == [
        ("StageDurationMs", 125.0, {"command": "backfill", "stage": "PROJECTING"}),
        ("StageFailures", 1, {"command": "backfill", "stage": "PROJECTING"}),
    ]


class FailingAthena(AthenaValidator):
    def __init__(self, error: Exception) -> None:
        self.error = error

    def validate_partition(
        self,
        table: str,
        dataset_version: str,
        partition: str,
        expected_row_count: int,
        *,
        aggregate_digest: str,
    ) -> int:
        raise self.error

    def validate_legacy_partition(
        self, table: str, dataset_version: str, partition: str, expected_row_count: int
    ) -> int:
        raise self.error


def test_athena_failure_is_counted_without_custom_processed_bytes() -> None:
    metrics = RecordingMetrics()
    error = RuntimeError("query failed")
    observed = ObservedAthenaValidator(FailingAthena(error), metrics, command="backfill")

    with pytest.raises(RuntimeError) as raised:
        observed.validate_legacy_partition("signal_bucket", "dsv", "year=2026/month=09/day=10", 2)

    assert raised.value is error
    assert metrics.values == [("AthenaFailures", 1, {"command": "backfill"})]
