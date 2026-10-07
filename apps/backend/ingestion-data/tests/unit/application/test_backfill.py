"""Verify backfill orchestration, failure boundaries and idempotent recovery."""

from __future__ import annotations

import json
import time
from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from types import MappingProxyType

import pytest

import application.backfill as backfill_module
from adapters.archive.parquet import schema_fingerprint_for_descriptor
from application.archive_partition import (
    ArchivePartitionEncoder,
    ArchivePartitionPublisher,
    ArchivePublicationError,
)
from application.backfill import Backfill, BackfillFailed, BackfillRequest, BackfillValidationError
from application.publish_outbox import OutboxPublisher
from application.read_canonical_set import CanonicalRecordSource
from application.rebuild_projections import ProjectionBuildResult, ProjectionService
from contracts.argus.v2.normalizers import NormalizationContext
from contracts.registry import DatasetRegistry
from domain.canonical_set import MAX_CANONICAL_OBJECT_BYTES
from domain.identity import canonical_dataset_version, dataset_version
from domain.models import TimeWindow
from domain.quality import CoverageStatus
from domain.run import RunActivity, RunPipeline, RunStage
from ports import (
    ArchivePartition,
    ArchiveState,
    AthenaValidator,
    CandidateManifest,
    CoverageObservation,
    RestoreRequest,
    RestoreResult,
    SnapshotChecksumMismatch,
    SnapshotPreparer,
    WriteResult,
)
from tests.fakes import (
    FakeAnalysisRequestPublisher,
    FakeArchiveObjectStore,
    FakeArchivePartitionRepository,
    FakeCanonicalSetStore,
    FakeCheckpointRepository,
    FakeGlueCatalog,
    FakeHotExpirationRepository,
    FakeHotRecordSink,
    FakeIngestionBackend,
    FakeLeaseRepository,
    FakeManifestRepository,
    FakeOutboxRepository,
    FakeParquetEncoder,
    FakeProjectionRepository,
    FakeRunRepository,
    FakeSnapshotRestorer,
    FakeSourceReader,
    FakeWindowCommitRepository,
)

FIXTURES = Path(__file__).parents[2] / "fixtures"


# O sha do dump é evidência OPERACIONAL, não contrato: cada execução declara
# qual dump restaurou. Os testes declaram do mesmo jeito que o operador declara.
DUMP_SHA256 = "c1d86081679d66c392b63710bda4517b047f029c5403ad1502d731ab5ac126ea"


class TickingClock:
    def __init__(self) -> None:
        self.current = datetime(2026, 9, 9, tzinfo=UTC)

    def __call__(self) -> datetime:
        result = self.current
        self.current += timedelta(seconds=1)
        return result


class EchoAthena(AthenaValidator):
    def validate_partition(
        self,
        table: str,
        dataset_version: str,
        partition: str,
        expected_row_count: int,
        *,
        aggregate_digest: str,
    ) -> int:
        del table, dataset_version, partition, aggregate_digest
        return expected_row_count

    def validate_legacy_partition(
        self,
        table: str,
        dataset_version: str,
        partition: str,
        expected_row_count: int,
    ) -> int:
        del table, dataset_version, partition
        return expected_row_count


class OrderedReader(FakeSourceReader):
    def __init__(self, rows: Mapping[str, tuple[Mapping[str, object], ...]]) -> None:
        super().__init__(rows)
        self.schema_order: list[str] = []
        self.read_order: list[str] = []

    def validate_schema(self, descriptor):  # type: ignore[no-untyped-def]
        self.schema_order.append(descriptor.table)
        return super().validate_schema(descriptor)

    def measure_coverage(self, descriptor):  # type: ignore[no-untyped-def]
        observed = super().measure_coverage(descriptor)
        if descriptor.archive_partition["strategy"] == "snapshot_date":
            return observed
        return replace(
            observed,
            observed_window=TimeWindow(
                datetime(2026, 8, 1, tzinfo=UTC),
                datetime(2026, 9, 2, tzinfo=UTC),
                descriptor.grain_seconds or 1,
            ),
        )

    def read_page(self, descriptor, window, after, limit):  # type: ignore[no-untyped-def]
        self.read_order.append(descriptor.table)
        return super().read_page(descriptor, window, after, limit)


class ActivityRecorder:
    def __init__(self) -> None:
        self.activities: list[RunActivity] = []

    def report_activity(self, activity: RunActivity) -> None:
        self.activities.append(activity)


class DiskUsageRecorder:
    def __init__(self) -> None:
        self.reasons: list[str] = []

    def report_disk_usage(
        self,
        current_bytes: int,
        peak_bytes: int,
        budget_bytes: int,
        *,
        reason: str,
    ) -> None:
        del current_bytes, peak_bytes, budget_bytes
        self.reasons.append(reason)


class CountingArchiveObjectStore(FakeArchiveObjectStore):
    def __init__(self) -> None:
        super().__init__()
        self.stage_calls = 0
        self.promote_calls = 0

    def stage(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        self.stage_calls += 1
        return super().stage(*args, **kwargs)

    def promote(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        self.promote_calls += 1
        return super().promote(*args, **kwargs)


class CountingHotExpirationRepository(FakeHotExpirationRepository):
    def __init__(self, backend: FakeIngestionBackend) -> None:
        super().__init__(backend)
        self.authorize_calls = 0

    def authorize_expiration(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        self.authorize_calls += 1
        return super().authorize_expiration(*args, **kwargs)


def fixture_rows() -> dict[str, tuple[Mapping[str, object], ...]]:
    rows: dict[str, Mapping[str, object]] = {}
    for name in ("argus_v2_legacy_rows.json", "argus_v2_new_rows.json"):
        loaded = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
        assert isinstance(loaded, dict)
        rows.update(loaded)
    return {name: (row,) for name, row in rows.items()}


@dataclass
class Harness:
    service: Backfill
    request: BackfillRequest
    registry: DatasetRegistry
    reader: OrderedReader
    lifecycle: list[str]
    runs: FakeRunRepository
    leases: FakeLeaseRepository
    manifests: FakeManifestRepository
    version: str
    canonical_version: str
    backend: FakeIngestionBackend
    checkpoints: FakeCheckpointRepository
    outboxes: FakeOutboxRepository
    publisher: FakeAnalysisRequestPublisher
    canonical_sets: FakeCanonicalSetStore
    canonical_sources: list[CanonicalRecordSource]
    hot_expiration: CountingHotExpirationRepository


def build_backfill(
    tmp_path: Path,
    checksum: str = DUMP_SHA256,
    activity_reporter: ActivityRecorder | None = None,
    disk_usage_reporter: DiskUsageRecorder | None = None,
    snapshot_preparer: SnapshotPreparer | None = None,
) -> Harness:
    registry = DatasetRegistry.load_argus_v2()
    version = dataset_version("argus", checksum, "2.0", "1.0")
    canonical_version = canonical_dataset_version("argus", checksum, "2.0", "1.0")
    rows = fixture_rows()
    reader = OrderedReader(rows)
    lifecycle: list[str] = []

    def reader_factory() -> OrderedReader:
        lifecycle.append("reader-created")
        return reader

    restorer = FakeSnapshotRestorer(RestoreResult(checksum, 100))
    original_restore = restorer.restore

    def restore(request, *, idempotency_key):  # type: ignore[no-untyped-def]
        lifecycle.append("restored")
        return original_restore(request, idempotency_key=idempotency_key)

    restorer.restore = restore  # type: ignore[method-assign]
    backend = FakeIngestionBackend()
    hot = FakeHotRecordSink(backend)
    projections = FakeProjectionRepository(backend=backend)
    partitions = FakeArchivePartitionRepository(backend)
    clock = TickingClock()
    manifests = FakeManifestRepository(CandidateManifest("dsv_old", {"legacy": True}))
    outboxes = FakeOutboxRepository(backend=backend)
    publisher = FakeAnalysisRequestPublisher()
    runs = FakeRunRepository()
    leases = FakeLeaseRepository()
    checkpoints = FakeCheckpointRepository()
    canonical_sets = FakeCanonicalSetStore()
    canonical_sources: list[CanonicalRecordSource] = []
    hot_expiration = CountingHotExpirationRepository(backend)

    class FixtureCanonicalSource(CanonicalRecordSource):
        def __init__(self, workspace: Path) -> None:
            self.workspace = workspace
            self.calls = 0

        def iter_batches(self, canonical_set, *, batch_size=2_048):  # type: ignore[no-untyped-def]
            assert batch_size == 2_048
            assert not tuple(self.workspace.rglob("*.jsonl"))
            self.calls += 1
            for dataset in canonical_set.datasets:
                if not dataset.partitions:
                    continue
                descriptor = registry.require(dataset.dataset)
                records = tuple(
                    Backfill._normalize_record(
                        descriptor,
                        row,
                        NormalizationContext(
                            bot_reliable_from_ms=1788048000000,
                            valid_sde_ids=frozenset({"sde-synthetic-001"}),
                        ),
                        canonical_set.snapshot_extracted_on,
                    )
                    for row in reader.rows_by_dataset[dataset.dataset]
                )
                yield {(dataset.dataset, dataset.partitions[0].partition): records}

    def canonical_source_factory(workspace: Path) -> CanonicalRecordSource:
        source = FixtureCanonicalSource(workspace)
        canonical_sources.append(source)
        return source

    service = Backfill(
        registry=registry,
        restorer=restorer,
        reader_factory=reader_factory,
        hot_sink=hot,
        checkpoints=checkpoints,
        leases=leases,
        runs=runs,
        manifests=manifests,
        projections=ProjectionService(projections),
        archive_encoder=ArchivePartitionEncoder(FakeParquetEncoder()),
        archive_publisher=ArchivePartitionPublisher(
            FakeArchiveObjectStore(),
            FakeGlueCatalog(),
            EchoAthena(),
            partitions,
            hot_expiration,
            "archive-bucket",
            clock,
            schema_fingerprint_for_descriptor,
        ),
        window_commits=FakeWindowCommitRepository(backend=backend),
        outbox_publisher=OutboxPublisher(outboxes, publisher),
        normalization_context=lambda _reader: NormalizationContext(
            bot_reliable_from_ms=1788048000000,
            valid_sde_ids=frozenset({"sde-synthetic-001"}),
        ),
        clock=clock,
        snapshot_preparer=snapshot_preparer,
        canonical_sets=canonical_sets,
        canonical_source_factory=canonical_source_factory,
        **({"activity_reporter": activity_reporter} if activity_reporter is not None else {}),
        **({"disk_usage_reporter": disk_usage_reporter} if disk_usage_reporter is not None else {}),
    )
    request = BackfillRequest(
        run_id="run-1",
        restore_request=RestoreRequest("bucket", "dump.sql.gz", "v1", checksum),
        snapshot_extracted_on=date(2026, 9, 1),
        archive_workdir=tmp_path,
        disk_free_bytes=lambda _path: 50 * 1024**3,
        page_size=1,
        lease_ttl_seconds=300,
        outbox_limit=100,
    )
    return Harness(
        service,
        request,
        registry,
        reader,
        lifecycle,
        runs,
        leases,
        manifests,
        version,
        canonical_version,
        backend,
        checkpoints,
        outboxes,
        publisher,
        canonical_sets,
        canonical_sources,
        hot_expiration,
    )


def test_administrative_backfill_defaults_to_legacy_with_hot_materialization(
    tmp_path: Path,
) -> None:
    request = build_backfill(tmp_path).request

    assert request.pipeline is RunPipeline.LEGACY_V1
    assert request.materialize_hot_records is True


def test_backfill_request_models_canonical_pipeline(
    tmp_path: Path,
) -> None:
    request = replace(
        build_backfill(tmp_path).request,
        pipeline=RunPipeline.CANONICAL_V2,
        materialize_hot_records=False,
    )

    assert request.pipeline is RunPipeline.CANONICAL_V2
    assert request.materialize_hot_records is False


def test_backfill_request_rejects_hot_materialization_in_canonical_pipeline(
    tmp_path: Path,
) -> None:
    with pytest.raises(ValueError, match="canonical-v2 cannot materialize hot records"):
        replace(
            build_backfill(tmp_path).request,
            pipeline=RunPipeline.CANONICAL_V2,
            materialize_hot_records=True,
        )


@pytest.mark.parametrize("legacy_partial", (False, True))
def test_legacy_and_canonical_same_dump_use_disjoint_versions_and_replay_safely(
    tmp_path: Path,
    legacy_partial: bool,
) -> None:
    harness = build_backfill(tmp_path)
    legacy_version = "dsv_44e67d1f7d2dc81d2ad026b002fc6300a546cd7c6ce805e1f8a7b55a1fabcce8"
    canonical_version = "dsv_2bd934852f110427a5fc8052ac2cc435e18fb0e58d296a7ff3a7c5b3b10999f5"
    if legacy_partial:
        harness.publisher._failures.append(RuntimeError("legacy publish interrupted"))

    legacy = harness.service.execute(replace(harness.request, run_id="run-legacy-first"))

    assert legacy.dataset_version == legacy_version
    assert legacy.stage is (RunStage.PARTIAL if legacy_partial else RunStage.SUCCEEDED)
    assert harness.canonical_sets.get(legacy_version) is None
    legacy_candidate = harness.manifests.get_candidate(legacy_version)
    assert legacy_candidate is not None
    legacy_object_keys = {
        key
        for key in harness.service._archive_publisher.object_store.objects  # type: ignore[attr-defined]
        if f"dataset_version={legacy_version}/" in key
    }
    assert legacy_object_keys

    canonical_request = replace(
        harness.request,
        run_id="run-canonical-first",
        pipeline=RunPipeline.CANONICAL_V2,
        materialize_hot_records=False,
        activate=False,
    )
    canonical = harness.service.execute(canonical_request)

    assert canonical.dataset_version == canonical_version
    marker = harness.canonical_sets.get(canonical_version)
    assert marker is not None
    assert marker.source_sha256 == DUMP_SHA256
    canonical_candidate = harness.manifests.get_candidate(canonical_version)
    assert canonical_candidate is not None
    assert canonical_candidate != legacy_candidate
    canonical_object_keys = {
        key
        for key in harness.service._archive_publisher.object_store.objects  # type: ignore[attr-defined]
        if f"dataset_version={canonical_version}/" in key
    }
    assert canonical_object_keys
    assert canonical_object_keys.isdisjoint(legacy_object_keys)
    object_keys_before_retries = set(
        harness.service._archive_publisher.object_store.objects  # type: ignore[attr-defined]
    )

    canonical_retry = harness.service.execute(
        replace(canonical_request, run_id="run-canonical-retry")
    )
    legacy_retry = harness.service.execute(replace(harness.request, run_id="run-legacy-retry"))

    assert canonical_retry.dataset_version == canonical_version
    assert legacy_retry.dataset_version == legacy_version
    replayed_object_keys = set(
        harness.service._archive_publisher.object_store.objects  # type: ignore[attr-defined]
    )
    assert replayed_object_keys == object_keys_before_retries
    assert set(harness.manifests.candidates) >= {legacy_version, canonical_version}
    assert {
        dataset_version
        for dataset_version, _dataset, _partition in harness.backend.archive_partitions
    } >= {legacy_version, canonical_version}
    assert harness.canonical_sets.get(legacy_version) is None
    assert harness.canonical_sets.get(canonical_version) == marker


def test_canonical_pipeline_archives_before_projection_without_hot_or_checkpoints(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    request = replace(
        harness.request,
        pipeline=RunPipeline.CANONICAL_V2,
        materialize_hot_records=False,
        activate=False,
    )
    original_materialize = harness.service._projections.materialize_record_batches

    def materialize_after_archive(*args, **kwargs):  # type: ignore[no-untyped-def]
        marker = harness.canonical_sets.get(harness.canonical_version)
        assert marker is not None
        assert len(harness.backend.archive_partitions) == len(harness.registry.names())
        assert all(
            partition.state is ArchiveState.AVAILABLE
            for partition in harness.backend.archive_partitions.values()
        )
        return original_materialize(*args, **kwargs)

    class ProjectionsAfterArchive:
        materialize_record_batches = staticmethod(materialize_after_archive)

    harness.service._projections = ProjectionsAfterArchive()  # type: ignore[assignment]

    result = harness.service.execute(request)

    transitions = [RunStage.STARTING]
    transitions.extend(state.stage for state, _metadata in harness.runs.transitions[request.run_id])
    assert transitions == [
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
    ]
    assert harness.service._hot_sink.write_calls == 0  # type: ignore[attr-defined]
    assert harness.hot_expiration.authorize_calls == 0
    assert harness.checkpoints.checkpoints == {}
    assert result.records_read == result.records_written == len(harness.registry.names())
    assert result.records_unchanged == 0
    assert all(
        item.metadata["hotItemCount"] == 0 for item in harness.backend.archive_partitions.values()
    )
    assert all(
        "projectionItemCount" not in item.metadata
        for item in harness.backend.archive_partitions.values()
    )
    assert len(harness.canonical_sources) == 1
    assert harness.canonical_sources[0].calls == 1
    materializing = next(
        metadata
        for state, metadata in harness.runs.transitions[request.run_id]
        if state.stage is RunStage.MATERIALIZING_HOT
    )
    assert materializing.records_read == 0
    assert materializing.records_written == 0
    assert materializing.records_rejected == 0
    assert materializing.substage == "SKIPPED_BY_POLICY"
    assert materializing.units_completed == materializing.units_total == 0
    assert materializing.unit_label == "datasets"
    candidate = harness.manifests.get_candidate(harness.canonical_version)
    assert candidate is not None
    assert candidate.metadata["hotMaterialization"] == "SKIPPED"
    assert candidate.metadata["hotItemCount"] == 0
    assert candidate.metadata["validations"]
    assert harness.backend.projections
    assert harness.manifests.get_active() == CandidateManifest("dsv_old", {"legacy": True})


def test_canonical_pipeline_splits_an_observed_oversized_object_before_publication(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    first = dict(harness.reader.rows_by_dataset["app_error"][0])
    harness.reader.rows_by_dataset["app_error"] = (
        first,
        {**first, "error_code": "A0001"},
    )

    class OversizeMultiRecordEncoder(FakeParquetEncoder):
        def write_partition(self, records, *args, **kwargs):  # type: ignore[no-untyped-def]
            materialized = tuple(records)
            encoded = super().write_partition(materialized, *args, **kwargs)
            return (
                replace(encoded, byte_size=MAX_CANONICAL_OBJECT_BYTES + 1)
                if len(materialized) > 1
                else encoded
            )

    harness.service._archive_encoder = ArchivePartitionEncoder(  # type: ignore[assignment]
        OversizeMultiRecordEncoder()
    )
    request = replace(
        harness.request,
        pipeline=RunPipeline.CANONICAL_V2,
        materialize_hot_records=False,
        activate=False,
    )

    result = harness.service.execute(request)

    marker = harness.canonical_sets.get(harness.canonical_version)
    assert result.stage is RunStage.SUCCEEDED
    assert marker is not None
    app_error = next(item for item in marker.datasets if item.dataset == "app_error")
    assert len(app_error.partitions) == 1
    assert [item.row_count for item in app_error.partitions[0].objects] == [1, 1]
    assert all(
        item.byte_count <= MAX_CANONICAL_OBJECT_BYTES for item in app_error.partitions[0].objects
    )


def test_canonical_workspace_is_scoped_to_the_run_identity(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    encoded_paths: list[Path] = []

    class RecordingEncoder(FakeParquetEncoder):
        def write_partition(self, records, descriptor, path, **kwargs):  # type: ignore[no-untyped-def]
            encoded_paths.append(path)
            return super().write_partition(records, descriptor, path, **kwargs)

    harness.service._archive_encoder = ArchivePartitionEncoder(  # type: ignore[assignment]
        RecordingEncoder()
    )
    request = replace(
        harness.request,
        pipeline=RunPipeline.CANONICAL_V2,
        materialize_hot_records=False,
        activate=False,
    )

    harness.service.execute(request)

    expected_workspace = (
        tmp_path
        / ".spool"
        / backfill_module.sha256_id(
            "workspace_", {"version": harness.canonical_version, "runId": request.run_id}
        )
    )
    assert encoded_paths
    assert all(path.is_relative_to(expected_workspace) for path in encoded_paths)


def test_canonical_pipeline_encodes_each_object_only_once(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    encode_calls = 0

    class CountingEncoder(FakeParquetEncoder):
        def write_partition(self, records, descriptor, path, **kwargs):  # type: ignore[no-untyped-def]
            nonlocal encode_calls
            encode_calls += 1
            return super().write_partition(records, descriptor, path, **kwargs)

    harness.service._archive_encoder = ArchivePartitionEncoder(  # type: ignore[assignment]
        CountingEncoder()
    )
    request = replace(
        harness.request,
        pipeline=RunPipeline.CANONICAL_V2,
        materialize_hot_records=False,
        activate=False,
    )

    result = harness.service.execute(request)

    marker = harness.canonical_sets.get(harness.canonical_version)
    assert result.stage is RunStage.SUCCEEDED
    assert marker is not None
    expected_objects = sum(
        len(partition.objects) for dataset in marker.datasets for partition in dataset.partitions
    )
    assert encode_calls == expected_objects


def test_restore_checksum_divergence_keeps_its_typed_cause(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    harness.service._restorer = FakeSnapshotRestorer(  # type: ignore[assignment]
        RestoreResult("f" * 64, 100)
    )
    request = replace(
        harness.request,
        pipeline=RunPipeline.CANONICAL_V2,
        materialize_hot_records=False,
        activate=False,
    )

    with pytest.raises(BackfillFailed) as captured:
        harness.service.execute(request)

    assert captured.value.stage is RunStage.RESTORING
    assert isinstance(captured.value.__cause__, SnapshotChecksumMismatch)


def test_backfill_defensively_types_an_unchecked_restore_checksum_divergence(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)

    class UncheckedRestorer:
        @staticmethod
        def restore(_request: RestoreRequest, *, idempotency_key: str) -> RestoreResult:
            assert idempotency_key
            return RestoreResult("f" * 64, 100)

    harness.service._restorer = UncheckedRestorer()  # type: ignore[assignment]

    with pytest.raises(BackfillFailed) as captured:
        harness.service.execute(harness.request)

    assert captured.value.stage is RunStage.RESTORING
    assert isinstance(captured.value.__cause__, SnapshotChecksumMismatch)


def test_canonical_failure_before_marker_reextracts_from_the_start(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    request = replace(
        harness.request,
        pipeline=RunPipeline.CANONICAL_V2,
        materialize_hot_records=False,
        activate=False,
    )
    original_commit = harness.canonical_sets.commit
    failures = 1

    def fail_before_marker(*args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal failures
        if failures:
            failures -= 1
            raise RuntimeError("marker unavailable")
        return original_commit(*args, **kwargs)

    harness.canonical_sets.commit = fail_before_marker  # type: ignore[method-assign]
    with pytest.raises(BackfillFailed) as captured:
        harness.service.execute(request)
    assert captured.value.stage is RunStage.ARCHIVING
    reads_before_retry = len(harness.reader.read_order)
    original_store = harness.service._archive_publisher.object_store
    replay_store = CountingArchiveObjectStore()
    replay_store.objects.update(
        {
            key: value
            for key, value in original_store.objects.items()  # type: ignore[attr-defined]
            if key.startswith("canonical/")
        }
    )
    object.__setattr__(harness.service._archive_publisher, "object_store", replay_store)

    result = harness.service.execute(replace(request, run_id="run-canonical-retry"))

    assert result.stage is RunStage.SUCCEEDED
    assert len(harness.reader.read_order) == reads_before_retry * 2
    assert replay_store.stage_calls == 0
    assert replay_store.promote_calls == 0
    assert not any(key.startswith("staging/") for key in replay_store.objects)


@pytest.mark.parametrize(
    ("conflicting_field", "conflicting_value"),
    [("catalogGeneration", 2), ("catalogDigest", "0" * 64)],
)
def test_canonical_preflight_rejects_a_later_partition_before_any_object_write(
    tmp_path: Path, conflicting_field: str, conflicting_value: object
) -> None:
    harness = build_backfill(tmp_path)
    request = replace(
        harness.request,
        pipeline=RunPipeline.CANONICAL_V2,
        materialize_hot_records=False,
        activate=False,
    )
    original_commit = harness.canonical_sets.commit
    failures = 1

    def fail_before_marker(*args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal failures
        if failures:
            failures -= 1
            raise RuntimeError("marker unavailable")
        return original_commit(*args, **kwargs)

    harness.canonical_sets.commit = fail_before_marker  # type: ignore[method-assign]
    with pytest.raises(BackfillFailed):
        harness.service.execute(request)

    identities = sorted(harness.backend.archive_partitions)
    harness.backend.archive_partitions.pop(identities[0])
    identity = identities[-1]
    current = harness.backend.archive_partitions[identity]
    metadata = dict(current.metadata)
    metadata[conflicting_field] = conflicting_value
    harness.backend.archive_partitions[identity] = ArchivePartition(
        current.dataset_version,
        current.dataset,
        current.partition,
        current.state,
        metadata,
    )
    original_store = harness.service._archive_publisher.object_store
    replay_store = CountingArchiveObjectStore()
    replay_store.objects.update(
        {
            key: value
            for key, value in original_store.objects.items()  # type: ignore[attr-defined]
            if key.startswith("canonical/")
        }
    )
    object.__setattr__(harness.service._archive_publisher, "object_store", replay_store)

    with pytest.raises(BackfillFailed) as captured:
        harness.service.execute(replace(request, run_id="run-conflicting-partition"))

    assert captured.value.stage is RunStage.ARCHIVING
    assert isinstance(captured.value.__cause__, ArchivePublicationError)
    assert replay_store.stage_calls == 0
    assert replay_store.promote_calls == 0
    assert harness.canonical_sets.get(harness.canonical_version) is None
    assert harness.manifests.get_candidate(harness.canonical_version) is None


def test_canonical_marker_skips_restore_extract_and_archive_on_retry(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    request = replace(
        harness.request,
        pipeline=RunPipeline.CANONICAL_V2,
        materialize_hot_records=False,
        activate=False,
    )

    class FailAfterMarker:
        @staticmethod
        def materialize_record_batches(*_args, **_kwargs):  # type: ignore[no-untyped-def]
            raise RuntimeError("projection unavailable")

    projections = harness.service._projections
    harness.service._projections = FailAfterMarker()  # type: ignore[assignment]
    with pytest.raises(BackfillFailed) as captured:
        harness.service.execute(request)
    assert captured.value.stage is RunStage.PROJECTING
    assert harness.canonical_sets.get(harness.canonical_version) is not None
    lifecycle_before_retry = tuple(harness.lifecycle)
    reads_before_retry = tuple(harness.reader.read_order)
    objects_before_retry = dict(harness.service._archive_publisher.object_store.objects)  # type: ignore[attr-defined]

    harness.service._projections = projections
    retried = harness.service.execute(replace(request, run_id="run-after-marker"))

    assert retried.stage is RunStage.SUCCEEDED
    assert tuple(harness.lifecycle) == lifecycle_before_retry
    assert tuple(harness.reader.read_order) == reads_before_retry
    assert harness.service._archive_publisher.object_store.objects == objects_before_retry  # type: ignore[attr-defined]
    assert harness.manifests.get_candidate(harness.canonical_version) is not None


def test_canonical_candidate_persists_projection_counts_and_replays_them(
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
    candidate = harness.manifests.get_candidate(harness.canonical_version)
    assert candidate is not None
    validations = candidate.metadata["validations"]
    assert isinstance(validations, Mapping)
    parquet_catalog = validations["parquetCatalog"]
    assert isinstance(parquet_catalog, Mapping)
    datasets = parquet_catalog["datasets"]
    assert isinstance(datasets, Mapping)
    app_error = datasets["app_error"]
    assert isinstance(app_error, Mapping)
    assert app_error == {
        "partitionCount": 1,
        "catalogValidated": True,
        "projectionItemCount": 2,
        "projectionDigest": "2b395c3ae26b68357dc2ff0e710a09edfb43ab7c3e7b06a89999e7ce74ea0c84",
    }
    marker = candidate.metadata["canonicalMarker"]
    assert isinstance(marker, Mapping)
    assert marker["objectKey"] == (
        f"canonical/schema_version=1.0/dataset_version={harness.canonical_version}/manifest.json"
    )
    assert marker["datasetCount"] == len(harness.registry.names())
    assert marker["partitionCount"] == len(harness.registry.names())
    assert marker["objectCount"] == len(harness.registry.names())
    assert marker["totalSourceRows"] == len(harness.registry.names())
    assert marker["totalAcceptedRows"] == len(harness.registry.names())
    assert marker["totalRejectedRows"] == 0
    assert isinstance(marker["aggregateDigest"], str) and len(marker["aggregateDigest"]) == 64
    assert isinstance(marker["documentSha256"], str) and len(marker["documentSha256"]) == 64
    assert "year=2026/month=08/day=30" not in repr(candidate.metadata)

    second = harness.service.execute(replace(request, run_id="run-projection-count-replay"))

    assert first.stage is second.stage is RunStage.SUCCEEDED
    assert harness.manifests.get_candidate(harness.canonical_version) == candidate


def test_canonical_candidate_rejects_projection_count_drift_on_replay(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    request = replace(
        harness.request,
        pipeline=RunPipeline.CANONICAL_V2,
        materialize_hot_records=False,
        activate=False,
    )
    harness.service.execute(request)
    candidate = harness.manifests.get_candidate(harness.canonical_version)
    assert candidate is not None
    metadata = dict(candidate.metadata)
    validations = dict(candidate.metadata["validations"])  # type: ignore[arg-type]
    parquet_catalog = dict(validations["parquetCatalog"])  # type: ignore[arg-type]
    datasets = dict(parquet_catalog["datasets"])  # type: ignore[arg-type]
    app_error = dict(datasets["app_error"])  # type: ignore[arg-type]
    app_error["projectionItemCount"] = 4
    datasets["app_error"] = app_error
    parquet_catalog["datasets"] = datasets
    validations["parquetCatalog"] = parquet_catalog
    metadata["validations"] = validations
    harness.manifests.candidates[harness.canonical_version] = CandidateManifest(
        harness.canonical_version, metadata
    )

    with pytest.raises(BackfillFailed) as captured:
        harness.service.execute(replace(request, run_id="run-projection-count-drift"))

    assert captured.value.stage is RunStage.FINALIZING_CANDIDATE
    assert isinstance(captured.value.__cause__, BackfillValidationError)
    assert harness.manifests.get_active() is not None
    assert harness.manifests.get_active().dataset_version == "dsv_old"


def test_canonical_marker_rejects_a_conflicting_partition_catalog_digest(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    request = replace(
        harness.request,
        pipeline=RunPipeline.CANONICAL_V2,
        materialize_hot_records=False,
        activate=False,
    )
    harness.service.execute(request)
    identity, current = next(iter(harness.backend.archive_partitions.items()))
    metadata = dict(current.metadata)
    metadata["catalogDigest"] = "0" * 64
    harness.backend.archive_partitions[identity] = ArchivePartition(
        current.dataset_version,
        current.dataset,
        current.partition,
        current.state,
        metadata,
    )

    with pytest.raises(BackfillFailed) as captured:
        harness.service.execute(replace(request, run_id="run-conflicting-catalog"))

    assert captured.value.stage is RunStage.STARTING
    assert isinstance(captured.value.__cause__, backfill_module.DataReconciliationError)


def test_backfill_runs_all_stages_before_success(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)

    result = harness.service.execute(harness.request)

    transitions = [RunStage.STARTING]
    transitions.extend(
        state.stage for state, _metadata in harness.runs.transitions[harness.request.run_id]
    )
    assert transitions == [
        RunStage.STARTING,
        RunStage.RESTORING,
        RunStage.VALIDATING,
        RunStage.INGESTING,
        RunStage.PROJECTING,
        RunStage.ARCHIVING,
        RunStage.ACTIVATING,
        RunStage.PUBLISHING,
        RunStage.SUCCEEDED,
    ]
    assert harness.lifecycle == ["restored", "reader-created"]
    assert harness.reader.schema_order == list(harness.registry.names())
    assert tuple(dict.fromkeys(harness.reader.read_order)) == harness.registry.names()
    assert all(harness.reader.read_order.count(name) == 2 for name in harness.registry.names())
    assert result.stage is RunStage.SUCCEEDED
    assert result.dataset_version == harness.version
    assert result.active_dataset_version == harness.version
    assert harness.manifests.active is not None
    assert harness.manifests.active.dataset_version == harness.version
    assert harness.leases.leases == {}
    assert not (tmp_path / ".spool").exists()


def test_backfill_prepares_snapshot_after_restore_and_before_source_validation(
    tmp_path: Path,
) -> None:
    lifecycle: list[str] = []

    class RecordingPreparer(SnapshotPreparer):
        def prepare(self, descriptors):  # type: ignore[no-untyped-def]
            lifecycle.append("prepared:" + ",".join(item.table for item in descriptors))
            return ()

    harness = build_backfill(tmp_path, snapshot_preparer=RecordingPreparer())
    original_validate = harness.reader.validate_schema

    def validate(descriptor):  # type: ignore[no-untyped-def]
        if not harness.reader.schema_order:
            lifecycle.append("validated")
        return original_validate(descriptor)

    harness.reader.validate_schema = validate  # type: ignore[method-assign]

    harness.service.execute(harness.request)

    assert harness.lifecycle[0] == "restored"
    assert lifecycle == [
        "prepared:" + ",".join(harness.registry.names()),
        "validated",
    ]


def test_backfill_reports_stage_heartbeat_and_dataset_level_progress(tmp_path: Path) -> None:
    reporter = ActivityRecorder()
    harness = build_backfill(tmp_path, activity_reporter=reporter)

    harness.service.execute(harness.request)

    stages = {activity.stage for activity in reporter.activities}
    assert {
        RunStage.RESTORING,
        RunStage.VALIDATING,
        RunStage.INGESTING,
        RunStage.PROJECTING,
        RunStage.ARCHIVING,
        RunStage.PUBLISHING,
    } <= stages
    ingesting = [
        activity for activity in reporter.activities if activity.stage is RunStage.INGESTING
    ]
    assert any(
        activity.current_dataset == "signal_bucket"
        and activity.datasets_completed == 0
        and activity.datasets_total == 23
        and activity.records_total == 23
        for activity in ingesting
    )
    assert any(
        activity.datasets_completed == 23
        and activity.records_read == 23
        and activity.records_written == 23
        and activity.records_rejected == 0
        for activity in ingesting
    )
    assert all(
        activity.observed_at >= activity.stage_started_at for activity in reporter.activities
    )


def test_backfill_observes_disk_on_reserve_observe_and_lease_heartbeat(tmp_path: Path) -> None:
    reporter = DiskUsageRecorder()
    harness = build_backfill(tmp_path, disk_usage_reporter=reporter)

    harness.service.execute(harness.request)

    assert {"reserve", "observe", "heartbeat"} <= set(reporter.reasons)


def test_backfill_keeps_all_datasets_completed_after_ingestion(tmp_path: Path) -> None:
    reporter = ActivityRecorder()
    harness = build_backfill(tmp_path, activity_reporter=reporter)

    harness.service.execute(harness.request)

    for stage in (RunStage.PROJECTING, RunStage.ARCHIVING, RunStage.PUBLISHING):
        activities = [activity for activity in reporter.activities if activity.stage is stage]
        assert activities
        assert all(activity.datasets_completed == 23 for activity in activities)


def test_failed_backfill_removes_spool_written_before_the_error(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    original_write = harness.service._hot_sink.write
    attempts = 0

    def fail_second(*args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal attempts
        attempts += 1
        if attempts == 2:
            raise RuntimeError("late partition failure")
        return original_write(*args, **kwargs)

    harness.service._hot_sink.write = fail_second  # type: ignore[method-assign]

    with pytest.raises(BackfillFailed):
        harness.service.execute(harness.request)

    assert not (tmp_path / ".spool").exists()


def test_heartbeat_start_failure_still_releases_the_acquired_lease(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    harness = build_backfill(tmp_path)

    def fail_start(_heartbeat: object) -> None:
        raise RuntimeError("heartbeat thread unavailable")

    monkeypatch.setattr(backfill_module._LeaseHeartbeat, "start", fail_start)

    with pytest.raises(BackfillFailed, match="heartbeat thread unavailable"):
        harness.service.execute(harness.request)

    assert harness.leases.leases == {}


def test_heartbeat_renewal_failure_is_reported_at_the_next_stage_checkpoint(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    harness.service._clock = lambda: datetime.now(UTC)
    original_restore = harness.service._restorer.restore

    def fail_renew(*_args: object, **_kwargs: object):  # type: ignore[no-untyped-def]
        raise RuntimeError("lease renewal rejected")

    def slow_restore(*args, **kwargs):  # type: ignore[no-untyped-def]
        time.sleep(0.5)
        return original_restore(*args, **kwargs)

    harness.leases.renew = fail_renew  # type: ignore[method-assign]
    harness.service._restorer.restore = slow_restore  # type: ignore[method-assign]

    with pytest.raises(BackfillFailed, match="lease renewal rejected") as captured:
        harness.service.execute(replace(harness.request, lease_ttl_seconds=1))

    assert captured.value.stage is RunStage.RESTORING
    assert harness.leases.leases == {}
    assert all(
        thread.name != f"lease-heartbeat-{harness.request.run_id}"
        for thread in backfill_module.threading.enumerate()
    )


def test_failure_creating_starting_run_releases_lease_before_source_access(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)

    def fail_create(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("MYSQL_PASSWORD=private")

    harness.runs.create = fail_create  # type: ignore[method-assign]

    with pytest.raises(BackfillFailed) as captured:
        harness.service.execute(harness.request)

    assert captured.value.stage is RunStage.STARTING
    assert "private" not in captured.value.persisted_message
    assert harness.leases.leases == {}
    assert harness.lifecycle == []


@pytest.mark.parametrize(
    "stage",
    (
        RunStage.RESTORING,
        RunStage.VALIDATING,
        RunStage.INGESTING,
        RunStage.PROJECTING,
        RunStage.ARCHIVING,
        RunStage.ACTIVATING,
    ),
)
def test_failure_before_activation_preserves_old_manifest_and_releases_lease(
    tmp_path: Path,
    stage: RunStage,
) -> None:
    harness = build_backfill(tmp_path / stage.value.lower())

    def fail(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("MYSQL_PWD=top-secret")

    if stage is RunStage.RESTORING:
        harness.service._restorer.restore = fail  # type: ignore[method-assign]
    elif stage is RunStage.VALIDATING:
        harness.reader.validate_schema = fail  # type: ignore[method-assign]
    elif stage is RunStage.INGESTING:
        harness.service._hot_sink.write = fail  # type: ignore[method-assign]
    elif stage is RunStage.PROJECTING:

        class FailingProjections:
            materialize_record_batches = staticmethod(fail)

        harness.service._projections = FailingProjections()  # type: ignore[assignment]
    elif stage is RunStage.ARCHIVING:
        publisher = harness.service._archive_publisher

        class FailingArchive:
            object_store = publisher.object_store
            bucket = publisher.bucket
            publish = staticmethod(fail)

        harness.service._archive_publisher = FailingArchive()  # type: ignore[assignment]
    else:
        harness.manifests.activate = fail  # type: ignore[method-assign]

    with pytest.raises(BackfillFailed) as captured:
        harness.service.execute(harness.request)

    assert captured.value.stage is stage
    assert harness.manifests.active is not None
    assert harness.manifests.active.dataset_version == "dsv_old"
    assert harness.leases.leases == {}
    assert harness.runs.runs[harness.request.run_id].stage is RunStage.FAILED
    assert "top-secret" not in harness.runs.errors[harness.request.run_id][0][1]


def test_sqs_failure_after_activation_returns_partial_with_pending_events(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    harness.publisher._failures.append(RuntimeError("SQS unavailable"))

    result = harness.service.execute(harness.request)

    assert result.stage is RunStage.PARTIAL
    assert result.active_dataset_version == harness.version
    assert harness.manifests.active is not None
    assert harness.manifests.active.dataset_version == harness.version
    assert len(harness.outboxes.list_pending(10)) == 2
    assert harness.runs.runs[harness.request.run_id].stage is RunStage.PARTIAL


def test_backfill_does_not_catch_process_control_base_exceptions(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)

    def interrupt(*_args: object, **_kwargs: object) -> None:
        raise KeyboardInterrupt

    harness.service._restorer.restore = interrupt  # type: ignore[method-assign]

    with pytest.raises(KeyboardInterrupt):
        harness.service.execute(harness.request)

    assert harness.leases.leases == {}
    assert harness.runs.runs[harness.request.run_id].stage is RunStage.RESTORING
    assert not (tmp_path / ".spool").exists()


def test_same_snapshot_active_retry_skips_pre_activation_fact_replay(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    first = harness.service.execute(harness.request)

    second = harness.service.execute(replace(harness.request, run_id="run-2"))

    assert second.dataset_version == first.dataset_version
    assert second.records_written == 0
    assert second.records_unchanged == 0
    assert second.new_archive_objects == 0
    assert second.new_analysis_events == 0


def test_activation_race_after_validation_skips_the_first_projection_write(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    old = harness.manifests.get_active()
    assert old is not None
    reference = build_backfill(tmp_path / "active-reference")
    reference.service.execute(reference.request)
    active = reference.manifests.active
    assert active is not None
    checks = 0

    def get_active() -> CandidateManifest:
        nonlocal checks
        checks += 1
        return old if checks == 1 else active

    def unexpected_projection_write(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("an ACTIVE fence must prevent the first projection write")

    class NoProjectionWrites:
        materialize_record_batches = staticmethod(unexpected_projection_write)

    harness.manifests.get_active = get_active  # type: ignore[method-assign]
    harness.service._projections = NoProjectionWrites()  # type: ignore[assignment]

    result = harness.service.execute(harness.request)

    assert result.stage is RunStage.SUCCEEDED
    assert result.active_dataset_version == harness.version


def test_active_manifest_analysis_recovery_merges_adjacent_intervals(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    harness.service.execute(harness.request)
    active = harness.manifests.active
    assert active is not None
    metadata = dict(active.metadata)
    available = dict(metadata["availableIntervals"])
    available["live_qoe_hourly"] = (
        {"start": "2026-09-01T00:00:00.000Z", "end": "2026-09-01T01:00:00.000Z"},
        {"start": "2026-09-01T01:00:00.000Z", "end": "2026-09-01T02:00:00.000Z"},
    )
    metadata["availableIntervals"] = available
    adjacent = CandidateManifest(harness.version, metadata)

    events = harness.service._analysis_events_from_active_manifest(harness.version, adjacent)

    assert any(event.event_type == "QOE_FORECAST" for event in events)


def test_active_manifest_analysis_recovery_rejects_incompatible_dependency_grain(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    harness.service.execute(harness.request)
    active = harness.manifests.active
    assert active is not None
    harness.service._analysis_dependencies = MappingProxyType(
        {
            "ANOMALY_DETECTION": ("signal_bucket",),
            "QOE_FORECAST": ("signal_bucket",),
        }
    )

    with pytest.raises(BackfillValidationError, match="incompatible grain"):
        harness.service._analysis_events_from_active_manifest(harness.version, active)


def test_projection_aggregates_a_complete_partition_split_across_source_pages(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    first = dict(harness.reader.rows_by_dataset["app_error_model"][0])
    second = {**first, "model": "Second Model", "errors": 11, "devices": 8}
    harness.reader.rows_by_dataset["app_error_model"] = (first, second)

    harness.service.execute(harness.request)

    projections = tuple(
        projection
        for projection in harness.backend.projection_operational.values()
        if projection.key == "OVERVIEW#app_error_model"
    )
    assert len(projections) == 1
    assert projections[0].payload["metrics"]["errors"] == 20  # type: ignore[index]
    archive = harness.backend.archive_partitions[
        (
            harness.version,
            "app_error_model",
            "year=2026/month=08/day=30",
        )
    ]
    assert archive.metadata["projectionItemCount"] == 2
    active = harness.manifests.get_active()
    assert active is not None
    flags = active.metadata["qualityFlags"]
    assert isinstance(flags, Mapping)
    assert flags["app_error_model"] == ("LIMITED_SOURCE_COVERAGE",)


def test_backfill_without_activation_keeps_old_active_and_emits_no_new_events(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)

    result = harness.service.execute(replace(harness.request, activate=False))

    assert result.stage is RunStage.SUCCEEDED
    assert result.active_dataset_version == "dsv_old"
    assert result.new_analysis_events == 0
    assert harness.backend.outboxes == {}
    assert harness.runs.runs[harness.request.run_id].active_dataset_version is None


def test_partial_dependency_suppresses_only_its_analysis_event(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    original = harness.reader.measure_coverage

    def measure(descriptor):  # type: ignore[no-untyped-def]
        observed = original(descriptor)
        if descriptor.table == "signal_bucket":
            return CoverageObservation(CoverageStatus.PARTIAL, observed.row_count, None)
        return observed

    harness.reader.measure_coverage = measure  # type: ignore[method-assign]

    result = harness.service.execute(harness.request)

    assert result.new_analysis_events == 1
    assert tuple(event.event_type for event in harness.publisher.published) == ("QOE_FORECAST",)


def test_backfill_does_not_claim_or_publish_across_a_middle_dependency_bucket_gap(
    tmp_path: Path,
) -> None:
    """Analysis needs one real common canonical interval, not min(max(timestamp))."""
    harness = build_backfill(tmp_path)
    start = datetime(2026, 9, 1, tzinfo=UTC)
    signal = dict(harness.reader.rows_by_dataset["signal_bucket"][0])
    active = dict(harness.reader.rows_by_dataset["live_active_15min"][0])
    harness.reader.rows_by_dataset["signal_bucket"] = tuple(
        {**signal, "bts": int((start + timedelta(minutes=offset)).timestamp() * 1000)}
        for offset in (0, 15, 30)
    )
    harness.reader.rows_by_dataset["live_active_15min"] = tuple(
        {**active, "bucket_ts": int((start + timedelta(minutes=offset)).timestamp() * 1000)}
        for offset in (0, 30)
    )
    qoe = dict(harness.reader.rows_by_dataset["live_qoe_hourly"][0])
    # Its final hourly bucket is also invalid; this leaves no eligible analysis
    # event that could mask the missing 15-minute dependency evidence.
    harness.reader.rows_by_dataset["live_qoe_hourly"] = (
        {**qoe, "hour_ts": int((start + timedelta(minutes=15)).timestamp() * 1000)},
    )

    result = harness.service.execute(harness.request)

    assert result.new_analysis_events == 0
    assert harness.publisher.published == ()
    assert harness.backend.outboxes == {}
    assert harness.manifests.active is not None
    intervals = harness.manifests.active.metadata["availableIntervals"]
    assert isinstance(intervals, Mapping)
    active_intervals = intervals["live_active_15min"]
    assert active_intervals == (
        {"start": "2026-09-01T00:00:00.000Z", "end": "2026-09-01T00:15:00.000Z"},
        {"start": "2026-09-01T00:30:00.000Z", "end": "2026-09-01T00:45:00.000Z"},
    )


def test_backfill_uses_the_real_shortest_complete_common_bucket_window(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    harness.service._analysis_dependencies = MappingProxyType(
        {
            "ANOMALY_DETECTION": ("signal_bucket", "live_active_15min"),
            "QOE_FORECAST": ("signal_bucket",),
        }
    )
    start = datetime(2026, 9, 1, tzinfo=UTC)
    signal = dict(harness.reader.rows_by_dataset["signal_bucket"][0])
    active = dict(harness.reader.rows_by_dataset["live_active_15min"][0])
    harness.reader.rows_by_dataset["signal_bucket"] = tuple(
        {**signal, "bts": int((start + timedelta(minutes=offset)).timestamp() * 1000)}
        for offset in (0, 15, 30)
    )
    harness.reader.rows_by_dataset["live_active_15min"] = tuple(
        {**active, "bucket_ts": int((start + timedelta(minutes=offset)).timestamp() * 1000)}
        for offset in (0, 15)
    )

    result = harness.service.execute(harness.request)

    assert result.new_analysis_events == 1
    anomaly = next(
        event for event in harness.publisher.published if event.event_type == "ANOMALY_DETECTION"
    )
    assert anomaly.payload["inputWatermark"] == "2026-09-01T00:30:00.000Z"


def test_backfill_rejects_low_free_disk_before_restoring_or_writing_hot_records(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    request = replace(
        harness.request,
        disk_budget_bytes=1024,
        disk_free_bytes=lambda _path: 0,
    )

    with pytest.raises(BackfillValidationError, match="free disk"):
        harness.service.execute(request)

    assert harness.lifecycle == []
    assert harness.backend.fact_records == {}
    assert not (tmp_path / ".spool").exists()


def test_backfill_reports_disk_snapshot_on_fatal_preflight(tmp_path: Path) -> None:
    reporter = DiskUsageRecorder()
    harness = build_backfill(tmp_path, disk_usage_reporter=reporter)
    request = replace(
        harness.request,
        disk_budget_bytes=1024,
        disk_free_bytes=lambda _path: 0,
    )

    with pytest.raises(BackfillValidationError, match="free disk"):
        harness.service.execute(request)

    assert reporter.reasons[-1] == "fatal"


def test_backfill_commits_same_watermark_analysis_events_per_event_type(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    harness.service._analysis_dependencies = MappingProxyType(
        {
            "ANOMALY_DETECTION": ("signal_bucket",),
            "QOE_FORECAST": ("live_qoe_hourly",),
        }
    )

    result = harness.service.execute(harness.request)

    assert result.new_analysis_events == 2
    assert (harness.version, "analysis:ANOMALY_DETECTION") in harness.backend.watermarks
    assert (harness.version, "analysis:QOE_FORECAST") in harness.backend.watermarks


def test_backfill_adopts_only_existing_legacy_analysis_event_then_emits_the_missing_type(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    first = harness.service.execute(harness.request)
    assert first.new_analysis_events == 2
    anomaly = next(
        event
        for event in harness.backend.outboxes.values()
        if event.event_type == "ANOMALY_DETECTION"
    )
    qoe = next(
        event for event in harness.backend.outboxes.values() if event.event_type == "QOE_FORECAST"
    )
    watermark = harness.backend.watermarks[(harness.version, "analysis:ANOMALY_DETECTION")]
    harness.backend.watermarks.pop((harness.version, "analysis:ANOMALY_DETECTION"))
    harness.backend.watermarks.pop((harness.version, "analysis:QOE_FORECAST"))
    harness.backend.watermarks[(harness.version, "analysis:ANOMALY_DETECTION+QOE_FORECAST")] = (
        watermark
    )
    harness.backend.outbox_states[anomaly.event_id] = "PUBLISHED"
    harness.backend.outbox_message_ids[anomaly.event_id] = "receipt-preserved"
    harness.backend.outboxes.pop(qoe.event_id)
    harness.backend.outbox_states.pop(qoe.event_id)
    # The legacy deployment had no per-type idempotency marker. Reopen the
    # repository over its durable state to model that pre-migration layout.
    harness.service._window_commits = FakeWindowCommitRepository(backend=harness.backend)

    harness.service.execute(replace(harness.request, run_id="run-legacy-migration"))

    assert harness.backend.outbox_states[anomaly.event_id] == "PUBLISHED"
    assert harness.backend.outbox_message_ids[anomaly.event_id] == "receipt-preserved"
    assert {event.event_type for event in harness.backend.outboxes.values()} == {
        "ANOMALY_DETECTION",
        "QOE_FORECAST",
    }


def test_checkpoint_does_not_advance_when_hot_write_does_not_reconcile(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    harness.service._hot_sink.write = (  # type: ignore[method-assign]
        lambda *_args, **_kwargs: WriteResult(0, 0)
    )

    with pytest.raises(BackfillFailed) as captured:
        harness.service.execute(harness.request)

    assert captured.value.stage is RunStage.INGESTING
    assert harness.checkpoints.get(harness.version, "signal_bucket") is None


def test_failed_run_keeps_counts_from_pages_persisted_before_ingestion_error(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    original_write = harness.service._hot_sink.write
    attempts = 0

    def fail_second(*args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal attempts
        attempts += 1
        if attempts == 2:
            raise RuntimeError("second dataset failed")
        return original_write(*args, **kwargs)

    harness.service._hot_sink.write = fail_second  # type: ignore[method-assign]

    with pytest.raises(BackfillFailed):
        harness.service.execute(harness.request)

    failed = harness.runs.transitions[harness.request.run_id][-1]
    assert failed[0].stage is RunStage.FAILED
    assert failed[1].records_read == 2
    assert failed[1].records_written == 1


def test_failure_persisting_success_after_activation_returns_partial(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    original_transition = harness.runs.transition

    def transition(run_id, target, **kwargs):  # type: ignore[no-untyped-def]
        if target is RunStage.SUCCEEDED:
            raise RuntimeError("DYNAMODB_TOKEN=private")
        return original_transition(run_id, target, **kwargs)

    harness.runs.transition = transition  # type: ignore[method-assign]

    result = harness.service.execute(harness.request)

    assert result.stage is RunStage.PARTIAL
    assert result.active_dataset_version == harness.version
    assert harness.runs.runs[harness.request.run_id].stage is RunStage.PARTIAL
    assert "private" not in harness.runs.errors[harness.request.run_id][0][1]


def test_lease_heartbeat_covers_a_restore_longer_than_the_ttl(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    harness.service._clock = lambda: datetime.now(UTC)
    original_restore = harness.service._restorer.restore

    def slow_restore(*args, **kwargs):  # type: ignore[no-untyped-def]
        time.sleep(1.2)
        return original_restore(*args, **kwargs)

    harness.service._restorer.restore = slow_restore  # type: ignore[method-assign]

    result = harness.service.execute(replace(harness.request, lease_ttl_seconds=1))

    assert result.stage is RunStage.SUCCEEDED
    assert harness.leases.leases == {}
    validating = next(
        metadata
        for state, metadata in harness.runs.transitions[harness.request.run_id]
        if state.stage is RunStage.VALIDATING
    )
    assert validating.duration_ms >= 1_000


def test_activation_acknowledged_before_publishing_transition_recovers_as_partial(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    original_transition = harness.runs.transition

    def transition(run_id, target, **kwargs):  # type: ignore[no-untyped-def]
        if target is RunStage.PUBLISHING:
            harness.runs.transition = original_transition  # type: ignore[method-assign]
            raise RuntimeError("DYNAMODB_TOKEN=private")
        return original_transition(run_id, target, **kwargs)

    harness.runs.transition = transition  # type: ignore[method-assign]

    result = harness.service.execute(harness.request)

    assert result.stage is RunStage.PARTIAL
    assert result.active_dataset_version == harness.version
    assert harness.runs.runs[harness.request.run_id].stage is RunStage.PARTIAL


def test_retry_reuses_identical_candidate_left_before_activation(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    activate = harness.manifests.activate
    failed = False

    def fail_before_activation(*args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal failed
        if not failed:
            failed = True
            raise RuntimeError("activation unavailable")
        return activate(*args, **kwargs)

    harness.manifests.activate = fail_before_activation  # type: ignore[method-assign]

    with pytest.raises(BackfillFailed, match="activation unavailable"):
        harness.service.execute(harness.request)
    assert harness.version in harness.manifests.candidates

    result = harness.service.execute(replace(harness.request, run_id="run-candidate-retry"))

    assert result.stage is RunStage.SUCCEEDED
    assert result.active_dataset_version == harness.version


def test_publishing_transition_ack_loss_reconciles_and_continues(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    original_transition = harness.runs.transition
    lost = False

    def transition(run_id, target, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal lost
        persisted = original_transition(run_id, target, **kwargs)
        if target is RunStage.PUBLISHING and not lost:
            lost = True
            raise RuntimeError("transition acknowledgement lost")
        return persisted

    harness.runs.transition = transition  # type: ignore[method-assign]

    result = harness.service.execute(harness.request)

    assert result.stage is RunStage.SUCCEEDED
    assert harness.runs.runs[harness.request.run_id].stage is RunStage.SUCCEEDED
    publishing = [
        metadata
        for state, metadata in harness.runs.transitions[harness.request.run_id]
        if state.stage is RunStage.PUBLISHING
    ]
    assert len(publishing) == 1


def test_intermediate_transition_ack_loss_reconciles_and_continues(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    original_transition = harness.runs.transition
    lost = False

    def transition(run_id, target, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal lost
        persisted = original_transition(run_id, target, **kwargs)
        if target is RunStage.VALIDATING and not lost:
            lost = True
            raise RuntimeError("validating acknowledgement lost")
        return persisted

    harness.runs.transition = transition  # type: ignore[method-assign]

    result = harness.service.execute(harness.request)

    assert result.stage is RunStage.SUCCEEDED
    validating = tuple(
        state
        for state, _metadata in harness.runs.transitions[harness.request.run_id]
        if state.stage is RunStage.VALIDATING
    )
    assert len(validating) == 1


def test_success_transition_ack_loss_returns_the_durable_terminal_result(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    original_transition = harness.runs.transition
    lost = False

    def transition(run_id, target, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal lost
        persisted = original_transition(run_id, target, **kwargs)
        if target is RunStage.SUCCEEDED and not lost:
            lost = True
            raise RuntimeError("success acknowledgement lost")
        return persisted

    harness.runs.transition = transition  # type: ignore[method-assign]

    result = harness.service.execute(harness.request)

    assert result.stage is RunStage.SUCCEEDED
    assert result.active_dataset_version == harness.version
    assert harness.runs.runs[harness.request.run_id].stage is RunStage.SUCCEEDED


def test_background_renewal_failure_after_activation_prevents_success(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    harness.service._clock = lambda: datetime.now(UTC)
    original_activate = harness.manifests.activate

    def fail_renew(*_args: object, **_kwargs: object):  # type: ignore[no-untyped-def]
        raise RuntimeError("late lease renewal rejected")

    def activate(*args, **kwargs):  # type: ignore[no-untyped-def]
        activated = original_activate(*args, **kwargs)
        harness.leases.renew = fail_renew  # type: ignore[method-assign]
        time.sleep(0.5)
        return activated

    harness.manifests.activate = activate  # type: ignore[method-assign]

    result = harness.service.execute(replace(harness.request, lease_ttl_seconds=1))

    assert result.stage is RunStage.PARTIAL
    assert result.active_dataset_version == harness.version
    assert harness.runs.runs[harness.request.run_id].stage is RunStage.PARTIAL
    assert all(
        state.stage is not RunStage.SUCCEEDED
        for state, _metadata in harness.runs.transitions[harness.request.run_id]
    )


def test_clock_failure_after_acquisition_releases_lease(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    calls = 0

    def clock() -> datetime:
        nonlocal calls
        calls += 1
        if calls > 1:
            raise RuntimeError("clock unavailable")
        return datetime(2026, 9, 9, tzinfo=UTC)

    harness.service._clock = clock

    with pytest.raises(BackfillFailed, match="clock unavailable"):
        harness.service.execute(harness.request)

    assert harness.leases.leases == {}


def test_resume_rehydrates_checkpointed_facts_without_rereading_source_history(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    original_write = harness.service._hot_sink.write
    attempts = 0

    def fail_once(*args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal attempts
        attempts += 1
        if attempts == 2:
            raise RuntimeError("resume after first dataset")
        return original_write(*args, **kwargs)

    harness.service._hot_sink.write = fail_once  # type: ignore[method-assign]
    with pytest.raises(BackfillFailed):
        harness.service.execute(harness.request)
    prior_reads = harness.reader.read_order.count("signal_bucket")

    result = harness.service.execute(replace(harness.request, run_id="run-resume"))

    assert result.stage is RunStage.SUCCEEDED
    assert harness.reader.read_order.count("signal_bucket") == prior_reads + 1
    assert len(harness.backend.fact_records) == len(harness.registry.names())


def test_resume_without_event_time_coverage_or_candidate_fails_closed(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    original_measure = harness.reader.measure_coverage
    original_write = harness.service._hot_sink.write
    attempts = 0

    def measure_without_window(descriptor):  # type: ignore[no-untyped-def]
        return replace(original_measure(descriptor), observed_window=None)

    def fail_after_checkpoint(*args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal attempts
        attempts += 1
        if attempts == 2:
            raise RuntimeError("interrupt after durable cursor")
        return original_write(*args, **kwargs)

    harness.reader.measure_coverage = measure_without_window  # type: ignore[method-assign]
    harness.service._hot_sink.write = fail_after_checkpoint  # type: ignore[method-assign]
    with pytest.raises(BackfillFailed, match="interrupt after durable cursor"):
        harness.service.execute(harness.request)

    with pytest.raises(BackfillFailed, match="durable coverage boundary"):
        harness.service.execute(replace(harness.request, run_id="run-resume-no-window"))


def test_activation_requires_every_projection_family(tmp_path: Path) -> None:
    harness = build_backfill(tmp_path)
    original_materialize = harness.service._projections.materialize_record_batches

    class IncompleteProjections:
        @staticmethod
        def materialize_record_batches(*args, **kwargs):  # type: ignore[no-untyped-def]
            complete = original_materialize(*args, **kwargs)
            return ProjectionBuildResult(
                tuple(item for item in complete.projections if item.key.startswith("OVERVIEW#")),
                complete.catalog_item_counts,
            )

    harness.service._projections = IncompleteProjections()  # type: ignore[assignment]

    with pytest.raises(BackfillFailed) as captured:
        harness.service.execute(harness.request)

    assert captured.value.stage is RunStage.ACTIVATING
    assert harness.manifests.active is not None
    assert harness.manifests.active.dataset_version == "dsv_old"


def test_manifest_hot_boundary_does_not_route_expired_history_to_dynamodb(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    old = dict(harness.reader.rows_by_dataset["signal_bucket"][0])
    old["bts"] = int(datetime(2026, 7, 1, tzinfo=UTC).timestamp() * 1000)
    harness.reader.rows_by_dataset["signal_bucket"] = (old,)

    harness.service.execute(harness.request)

    assert harness.manifests.active is not None
    metadata = harness.manifests.active.metadata
    intervals = metadata["availableIntervals"]
    hot_from = metadata["hotFrom"]
    assert isinstance(intervals, Mapping)
    assert isinstance(hot_from, Mapping)
    signal_interval = intervals["signal_bucket"]
    assert isinstance(signal_interval, tuple)
    assert hot_from["signal_bucket"] == signal_interval[0]["end"]  # type: ignore[index]


def test_manifest_preserves_partition_gaps_and_contains_last_point_record(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    original = dict(harness.reader.rows_by_dataset["incidents"][0])
    original.update({"state": "open", "resolved_at": None, "closed_at": None})
    opened = original["opened_at"]
    assert isinstance(opened, int)
    same_day = {**original, "sys_id": "incident-same-day", "opened_at": opened + 3_600_000}
    later = {**original, "sys_id": "incident-after-gap", "opened_at": opened + 2 * 86_400_000}
    harness.reader.rows_by_dataset["incidents"] = (original, same_day, later)

    harness.service.execute(harness.request)

    assert harness.manifests.active is not None
    available = harness.manifests.active.metadata["availableIntervals"]
    assert isinstance(available, Mapping)
    incidents = available["incidents"]
    assert isinstance(incidents, tuple)
    # Incidents are sparse points.  They must remain three point intervals,
    # rather than being expanded into two apparently continuous days.
    assert len(incidents) == 3
    assert incidents == (
        {"start": "2026-09-01T00:00:00.000Z", "end": "2026-09-01T00:00:00.001Z"},
        {"start": "2026-09-01T01:00:00.000Z", "end": "2026-09-01T01:00:00.001Z"},
        {"start": "2026-09-03T00:00:00.000Z", "end": "2026-09-03T00:00:00.001Z"},
    )


def test_snapshot_health_without_source_timestamp_uses_snapshot_observation_time(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    original = dict(harness.reader.rows_by_dataset["signal_meta"][0])
    missing = {
        **original,
        "source": "app_error_model",
        "last_ingested_ts": None,
        "last_run_at": None,
    }
    harness.reader.rows_by_dataset["signal_meta"] = (original, missing)

    result = harness.service.execute(harness.request)

    assert result.stage is RunStage.SUCCEEDED
    stored = tuple(
        record
        for record in harness.backend.fact_records.values()
        if record.source_dataset == "signal_meta"
        and record.dimensions.get("source") == "app_error_model"
    )
    assert len(stored) == 1
    assert stored[0].observed_at == datetime(2026, 9, 1, tzinfo=UTC)


def test_backfill_accepts_a_dump_the_contract_never_pinned(tmp_path: Path) -> None:
    """Este é o teste que justifica a mudança: qualquer dump, não só o aprovado.

    Antes, o sha do dump estava cravado em contracts/registry.py e o backfill
    recusava qualquer outro com "restore checksum differs from the versioned
    contract". Consequência prática: era impossível ingerir um dump reduzido ou
    mockado para testar o pipeline, e uma nova extração do MESMO schema exigia
    editar código Python.

    A linhagem continua garantida, e é isso que a asserção final prova: o
    dataset_version deriva do sha REAL do dump, então dump diferente produz
    versão diferente, e o manifesto registra qual dump a produziu.
    """
    outro_dump = "f" * 64
    assert outro_dump != DUMP_SHA256

    harness = build_backfill(tmp_path, checksum=outro_dump)
    result = harness.service.execute(harness.request)

    assert result.stage is RunStage.SUCCEEDED
    assert result.dataset_version == dataset_version("argus", outro_dump, "2.0", "1.0")
    assert result.dataset_version != dataset_version("argus", DUMP_SHA256, "2.0", "1.0")

    manifest = harness.manifests.candidates[result.dataset_version]
    assert manifest.metadata["dumpChecksumSha256"] == outro_dump


def test_backfill_uses_operational_extraction_date_in_snapshot_records_and_manifest(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    operational_date = date(2026, 8, 31)
    request = replace(harness.request, snapshot_extracted_on=operational_date)

    result = harness.service.execute(request)

    manifest = harness.manifests.candidates[result.dataset_version]
    assert manifest.metadata["snapshotExtractedOn"] == "2026-08-31"
    assert (
        result.dataset_version,
        "signal_meta",
        "snapshot_date=2026-08-31",
    ) in harness.backend.archive_partitions
