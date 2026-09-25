"""Executable contracts shared by in-memory and external port adapters."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from inspect import Parameter, signature
from pathlib import Path

import pytest

import adapters.dynamodb as dynamodb
import ports
import ports.contracts as port_contracts
from adapters.dynamodb.outbox import DynamoOutboxRepository, build_analysis_event
from contracts.registry import DatasetRegistry
from domain.archive import partition_date
from domain.identity import record_id
from domain.models import CanonicalRecord, RecordType, TimeWindow
from domain.quality import CoverageStatus
from domain.run import RunPipeline, RunStage, RunState
from ports import (
    ArchiveDependency,
    ArchiveObject,
    ArchivePartition,
    ArchivePartitionRepository,
    ArchiveState,
    CandidateManifest,
    CanonicalSetStore,
    ConcurrentActivationError,
    ConditionalWriteError,
    EncodedPartition,
    IdempotencyConflict,
    LeaseBusy,
    LeaseOwnershipError,
    LiveSyncConfiguration,
    OutboxEvent,
    OutboxRepository,
    Projection,
    RestoreRequest,
    RestoreResult,
    SnapshotChecksumMismatch,
    StaleCheckpoint,
    WindowCommitRepository,
)
from tests.fakes import (
    FakeAnalysisRequestPublisher,
    FakeArchiveObjectStore,
    FakeArchivePartitionRepository,
    FakeAthenaValidator,
    FakeCheckpointRepository,
    FakeGlueCatalog,
    FakeHotExpirationRepository,
    FakeHotRecordSink,
    FakeIngestionBackend,
    FakeLeaseRepository,
    FakeLogger,
    FakeManifestRepository,
    FakeMetricsPublisher,
    FakeOutboxRepository,
    FakeParquetEncoder,
    FakeProjectionRepository,
    FakeRunRepository,
    FakeSnapshotRestorer,
    FakeSourceReader,
    FakeWindowCommitRepository,
)

NOW = datetime(2026, 9, 1, tzinfo=UTC)
TEMPORAL_PARTITION = "year=2026/month=09/day=01"
REGISTRY = DatasetRegistry.load_argus_v2()


class NoAwsCalls:
    """Fail if validation reaches an external DynamoDB operation."""

    def get_item(self, **kwargs: object) -> Mapping[str, object]:
        raise AssertionError(f"unexpected DynamoDB GetItem: {kwargs}")

    def query(self, **kwargs: object) -> Mapping[str, object]:
        raise AssertionError(f"unexpected DynamoDB Query: {kwargs}")

    def transact_write_items(self, **kwargs: object) -> Mapping[str, object]:
        raise AssertionError(f"unexpected DynamoDB transaction: {kwargs}")


def test_archive_partition_port_exposes_typed_reconciliation_boundary() -> None:
    assert hasattr(ArchivePartitionRepository, "record_reconciliation")
    assert hasattr(ArchivePartitionRepository, "get")


def test_canonical_set_store_is_exported_as_an_abstract_port() -> None:
    assert port_contracts.CanonicalSetStore is CanonicalSetStore
    assert ports.CanonicalSetStore is CanonicalSetStore
    assert "CanonicalSetStore" in port_contracts.__all__
    assert "CanonicalSetStore" in ports.__all__
    with pytest.raises(TypeError, match="abstract"):
        CanonicalSetStore()


def test_v2_archive_ports_require_generation_and_expose_named_legacy_paths() -> None:
    glue_parameters = signature(port_contracts.GlueCatalog.register_partition).parameters
    athena_parameters = signature(port_contracts.AthenaValidator.validate_partition).parameters

    assert glue_parameters["aggregate_digest"].default is Parameter.empty
    assert athena_parameters["aggregate_digest"].default is Parameter.empty
    assert hasattr(port_contracts.GlueCatalog, "register_legacy_partition")
    assert hasattr(port_contracts.AthenaValidator, "validate_legacy_partition")


def test_live_sync_configuration_requires_is_enabled() -> None:
    assert port_contracts.LiveSyncConfiguration is LiveSyncConfiguration
    assert ports.LiveSyncConfiguration is LiveSyncConfiguration
    assert "LiveSyncConfiguration" in port_contracts.__all__
    assert "LiveSyncConfiguration" in ports.__all__
    assert "DynamoLiveSyncConfiguration" in dynamodb.__all__
    with pytest.raises(TypeError, match="abstract"):
        LiveSyncConfiguration()


def window() -> TimeWindow:
    return TimeWindow(NOW, NOW + timedelta(hours=1), 3600)


def record(source_id: str = "source-a") -> CanonicalRecord:
    return CanonicalRecord(
        schema_version="1.0",
        record_type=RecordType.SIGNAL_OBSERVATION,
        source_system="argus",
        source_dataset="signal_bucket",
        natural_key=(
            ("source", source_id),
            ("entity", "edge-a"),
            ("metric", "rpm"),
            ("bts", 1788220800000),
        ),
        observed_at=NOW,
        window=window(),
        dimensions={"source": source_id, "entity": "edge-a", "metric": "rpm"},
        measures={"value": Decimal("10")},
        quality={"coveragePolicy": "snapshot_window"},
        quality_flags=(),
    )


def overview_projection(
    dependencies: tuple[ArchiveDependency, ...],
    *,
    sessions: int = 10,
    partition_key: str = "DAY#20260901",
) -> Projection:
    return Projection(
        "dsv_new",
        partition_key,
        "OVERVIEW#GLOBAL",
        "1.0",
        dependencies,
        {
            "projectionVersion": "1.0",
            "formulaVersion": "1.0",
            "inputWatermarks": {dependency.dataset: NOW for dependency in dependencies},
            "observedThrough": NOW,
            "coverage": "complete",
            "qualityFlags": (),
            "metrics": {
                "sessions": sessions,
                "errors": 0,
                "startupErrors": None,
                "botErrors": None,
                "humanErrors": None,
                "errorRate": 0,
            },
        },
    )


def active_incident_projection(dependency: ArchiveDependency) -> Projection:
    return Projection(
        "dsv_new",
        "DAY#20260901",
        "INCIDENTS#ACTIVE",
        "1.0",
        (dependency,),
        {
            "projectionVersion": "1.0",
            "formulaVersion": "1.0",
            "inputWatermarks": {dependency.dataset: NOW},
            "observedThrough": NOW,
            "coverage": "complete",
            "qualityFlags": (),
            "incidents": (
                {
                    "incidentId": "inc_pnidg23fnrf2yaddm5ttipxc55",
                    "number": "INC001",
                    "openedAt": NOW,
                    "state": "open",
                    "priority": "P2",
                },
            ),
        },
    )


def candidate(version: str) -> CandidateManifest:
    return CandidateManifest(
        version,
        {
            "physicalContractVersion": "2.0",
            "canonicalSchemaVersion": "1.0",
            "dumpChecksumSha256": "a" * 64,
            "snapshotExtractedOn": "2026-09-01",
            "availableIntervals": {
                "signal_bucket": ({"start": "2026-09-01T00:00:00Z", "end": "2026-09-02T00:00:00Z"},)
            },
            "hotFrom": {"signal_bucket": "2026-09-01T00:00:00Z"},
            "watermarks": {"signal_bucket": "2026-09-02T00:00:00Z"},
            "s3Prefix": f"s3://argus-canonical/{version}/",
            "glueTables": {"signal_bucket": "argus_signal_bucket"},
            "descriptorVersions": {"signal_bucket": "2.0"},
            "formulaVersions": {"overview": "1.0"},
            "projectionVersions": {"overview/day": "1.0"},
            "coverage": {"signal_bucket": "COMPLETE"},
            "qualityFlags": {"signal_bucket": ()},
            "validations": {
                "physicalSchemas": {
                    "state": "PASSED",
                    "validatedAt": "2026-09-01T00:00:00Z",
                    "datasets": {"signal_bucket": {"fingerprint": "b" * 64, "compatible": True}},
                },
                "reconciliation": {
                    "state": "PASSED",
                    "validatedAt": "2026-09-01T00:00:00Z",
                    "datasets": {"signal_bucket": {"accepted": 1, "rejected": 0, "persisted": 1}},
                },
                "parquetCatalog": {
                    "state": "PASSED",
                    "validatedAt": "2026-09-01T00:00:00Z",
                    "datasets": {"signal_bucket": {"partitionCount": 1, "catalogValidated": True}},
                },
                "requiredProjections": {
                    "state": "PASSED",
                    "validatedAt": "2026-09-01T00:00:00Z",
                    "projections": ("overview/day",),
                },
                "coverageQuality": {
                    "state": "PASSED",
                    "validatedAt": "2026-09-01T00:00:00Z",
                    "datasets": {"signal_bucket": {"coverage": "COMPLETE", "qualityFlags": ()}},
                },
            },
        },
    )


def archive_metadata(
    version: str,
    dataset: str,
    partition: str,
    *,
    facts: int = 0,
    projections: int = 0,
) -> dict[str, object]:
    day = partition_date(partition).isoformat()
    return {
        "interval": {
            "start": f"{day}T00:00:00Z",
            "end": (datetime.fromisoformat(day) + timedelta(days=1)).isoformat() + "Z",
        },
        "counts": {"accepted": 1, "rejected": 0, "persisted": 1},
        "s3Uri": (
            "s3://argus-canonical/canonical/schema_version=1.0/"
            f"dataset_version={version}/"
            f"dataset={dataset}/{partition}/part-00000.parquet"
        ),
        "sha256": "c" * 64,
        "reconciliation": {"state": "PENDING"},
        "expirationEligible": False,
        "hotItemCount": facts,
        "projectionItemCount": projections,
        "catalogGeneration": 1,
        "catalogDigest": None,
    }


def event(sequence: int = 1, dataset_version: str = "dsv_new") -> OutboxEvent:
    window_end = NOW + timedelta(hours=sequence)
    return build_analysis_event(
        dataset_version,
        "ANOMALY_DETECTION",
        TimeWindow(window_end - timedelta(minutes=15), window_end, 900),
        created_at=NOW + timedelta(seconds=sequence),
    )


def test_source_reader_returns_monotonic_pages_for_descriptor() -> None:
    """Returning a duplicate or non-monotonic page would break resumable keyset reads."""
    descriptor = REGISTRY.require("signal_bucket")
    reader = FakeSourceReader(
        {
            "signal_bucket": (
                {"bts": 1788220800000, "source": "a", "entity": "e", "metric": "m"},
                {"bts": 1788220800001, "source": "a", "entity": "e", "metric": "m"},
                {"bts": 1788220800002, "source": "a", "entity": "e", "metric": "m"},
            )
        }
    )

    first = reader.read_page(descriptor, window(), None, 2)
    second = reader.read_page(descriptor, window(), first.next_cursor, 2)

    assert len(first.rows) == 2
    assert len(second.rows) == 1
    assert first.rows[0] not in second.rows
    assert first.next_cursor is not None
    assert second.next_cursor is not None
    assert first.next_cursor < second.next_cursor


def test_source_reader_reports_schema_and_coverage_without_mutable_payloads() -> None:
    """Schema drift and mutable source rows must not cross the source boundary unnoticed."""
    descriptor = REGISTRY.require("signal_bucket")
    labels = ["stable"]
    source_row = {
        "bts": 1788220800000,
        "source": "a",
        "entity": "e",
        "metric": "m",
        "metadata": {"labels": labels},
    }
    reader = FakeSourceReader({"signal_bucket": (source_row,)})

    schema = reader.validate_schema(descriptor)
    coverage = reader.measure_coverage(descriptor)
    page = reader.read_page(descriptor, window(), None, 10)
    labels.append("mutated")

    assert schema.is_compatible is True
    assert schema.differences == ()
    assert coverage.status is CoverageStatus.COMPLETE
    assert coverage.row_count == 1
    assert page.rows[0]["metadata"] == {"labels": ("stable",)}


def test_snapshot_restore_is_idempotent_and_rejects_key_reuse() -> None:
    """Reusing a restore key for another dump must fail instead of restoring twice."""
    result = RestoreResult("a" * 64, 123)
    restorer = FakeSnapshotRestorer(result)
    request = RestoreRequest("bucket", "dump.sql.gz", "version-1", "a" * 64)

    assert restorer.restore(request, idempotency_key="restore-1") == result
    assert restorer.restore(request, idempotency_key="restore-1") == result
    assert len(restorer.restores) == 1

    other = RestoreRequest("bucket", "other.sql.gz", "version-2", "a" * 64)
    with pytest.raises(IdempotencyConflict):
        restorer.restore(other, idempotency_key="restore-1")


def test_snapshot_restore_rejects_checksum_mismatch_on_every_retry() -> None:
    """A failed checksum condition must never be confirmed as an idempotent restore."""
    restorer = FakeSnapshotRestorer(RestoreResult("b" * 64, 123))
    request = RestoreRequest("bucket", "dump.sql.gz", "version-1", "a" * 64)

    for _ in range(2):
        with pytest.raises(SnapshotChecksumMismatch):
            restorer.restore(request, idempotency_key="restore-mismatch")
    assert restorer.restores == ()


def test_hot_sink_deduplicates_records_and_idempotency_keys() -> None:
    """Retrying a hot write must not create another logical effect."""
    sink = FakeHotRecordSink()

    first = sink.write((record(),), "dsv_new", TEMPORAL_PARTITION, idempotency_key="write-1")
    replay = sink.write((record(),), "dsv_new", TEMPORAL_PARTITION, idempotency_key="write-1")
    next_batch = sink.write((record(),), "dsv_new", TEMPORAL_PARTITION, idempotency_key="write-2")

    assert first.written == 1
    assert replay == first
    assert next_batch.unchanged == 1
    with pytest.raises(IdempotencyConflict):
        sink.write(
            (record("source-b"),),
            "dsv_new",
            TEMPORAL_PARTITION,
            idempotency_key="write-1",
        )


def test_hot_sink_fake_rejects_a_noncanonical_calendar_partition() -> None:
    sink = FakeHotRecordSink()

    with pytest.raises(ValueError, match="partition"):
        sink.write((), "dsv_new", "2026-09-01", idempotency_key="calendar-partition")


def test_hot_sink_fake_keeps_versioned_facts_immutable() -> None:
    sink = FakeHotRecordSink()
    original = record()
    sink.write((original,), "dsv_new", TEMPORAL_PARTITION, idempotency_key="immutable-original")

    with pytest.raises(ConditionalWriteError, match="immutable"):
        sink.write(
            (replace(original, measures={"value": 99}),),
            "dsv_new",
            TEMPORAL_PARTITION,
            idempotency_key="immutable-conflict",
        )

    assert next(iter(sink.records.values())).measures == {"value": 10}


def test_hot_sink_fake_matches_production_for_conflicting_batch_duplicates() -> None:
    sink = FakeHotRecordSink()
    conflicting = replace(record(), measures={"value": 99})

    with pytest.raises(ValueError) as captured:
        sink.write(
            (record(), conflicting),
            "dsv_new",
            TEMPORAL_PARTITION,
            idempotency_key="conflicting-batch",
        )

    assert str(captured.value) == (
        f"duplicate recordId has conflicting payload: {record_id(conflicting)}"
    )
    assert sink.records == {}


def test_hot_expiration_requires_available_archive_and_is_idempotent() -> None:
    """TTL must inspect persisted AVAILABLE state and cover facts plus projections."""
    backend = FakeIngestionBackend()
    sink = FakeHotRecordSink(backend)
    projections = FakeProjectionRepository(backend=backend)
    archives = FakeArchivePartitionRepository(backend)
    expirations = FakeHotExpirationRepository(backend)
    sink.write((record(),), "dsv_new", TEMPORAL_PARTITION, idempotency_key="write-hot")
    projections.put(
        overview_projection(
            (ArchiveDependency("signal_bucket", TEMPORAL_PARTITION),),
            partition_key=TEMPORAL_PARTITION,
        ),
        expected_projection_version=None,
        idempotency_key="projection-hot",
    )

    with pytest.raises(ConditionalWriteError, match="missing"):
        expirations.authorize_expiration(
            "dsv_new",
            "signal_bucket",
            TEMPORAL_PARTITION,
            1_800_000_000,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="ttl-too-early",
        )
    archives.put(
        ArchivePartition(
            "dsv_new",
            "signal_bucket",
            TEMPORAL_PARTITION,
            ArchiveState.STAGING,
            archive_metadata(
                "dsv_new", "signal_bucket", TEMPORAL_PARTITION, facts=1, projections=2
            ),
        ),
        expected_absent=True,
        idempotency_key="archive-staging",
    )
    uploaded = archives.update_state(
        "dsv_new",
        "signal_bucket",
        TEMPORAL_PARTITION,
        ArchiveState.UPLOADED,
        expected_state=ArchiveState.STAGING,
        idempotency_key="archive-uploaded",
    )
    cataloged = archives.update_state(
        "dsv_new",
        "signal_bucket",
        TEMPORAL_PARTITION,
        ArchiveState.CATALOGED,
        expected_state=uploaded.state,
        idempotency_key="archive-cataloged",
    )
    with pytest.raises(ConditionalWriteError, match="CATALOGED"):
        expirations.authorize_expiration(
            "dsv_new",
            "signal_bucket",
            TEMPORAL_PARTITION,
            1_800_000_000,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="ttl-cataloged",
        )
    validated = archives.update_state(
        "dsv_new",
        "signal_bucket",
        TEMPORAL_PARTITION,
        ArchiveState.VALIDATED,
        expected_state=cataloged.state,
        idempotency_key="archive-validated",
    )
    validated = archives.record_reconciliation(
        "dsv_new",
        "signal_bucket",
        TEMPORAL_PARTITION,
        observed_counts={"accepted": 1, "rejected": 0, "persisted": 1},
        reconciled_at=NOW,
        expected_state=ArchiveState.VALIDATED,
        idempotency_key="archive-reconciled",
    )
    archives.update_state(
        "dsv_new",
        "signal_bucket",
        TEMPORAL_PARTITION,
        ArchiveState.AVAILABLE,
        expected_state=validated.state,
        idempotency_key="archive-available",
    )

    applied = expirations.authorize_expiration(
        "dsv_new",
        "signal_bucket",
        TEMPORAL_PARTITION,
        1_800_000_000,
        expected_archive_state=ArchiveState.AVAILABLE,
        idempotency_key="ttl-available",
    )
    replay = expirations.authorize_expiration(
        "dsv_new",
        "signal_bucket",
        TEMPORAL_PARTITION,
        1_800_000_000,
        expected_archive_state=ArchiveState.AVAILABLE,
        idempotency_key="ttl-available",
    )

    assert applied == replay == 3
    assert tuple(backend.fact_expirations.values()) == (1_800_000_000,)
    assert len(backend.projection_expirations) == 2
    assert set(backend.projection_expirations.values()) == {1_800_000_000}
    with pytest.raises(ConditionalWriteError, match="sealed"):
        sink.write(
            (record("source-after-seal"),),
            "dsv_new",
            TEMPORAL_PARTITION,
            idempotency_key="write-after-seal",
        )
    assert len(backend.fact_catalog[("dsv_new", "signal_bucket", TEMPORAL_PARTITION)]) == 1


def test_hot_expiration_uses_explicit_temporal_and_snapshot_date_partitions() -> None:
    """Explicit partitioning must work equally for event time and static snapshots."""
    backend = FakeIngestionBackend()
    sink = FakeHotRecordSink(backend)
    archives = FakeArchivePartitionRepository(backend)
    expirations = FakeHotExpirationRepository(backend)
    sink.write(
        (record("temporal"),),
        "dsv_new",
        TEMPORAL_PARTITION,
        idempotency_key="temporal-write",
    )
    sink.write(
        (record("snapshot"),),
        "dsv_new",
        "snapshot_date=2026-09-02",
        idempotency_key="snapshot-write",
    )
    for partition in (TEMPORAL_PARTITION, "snapshot_date=2026-09-02"):
        current = ArchivePartition(
            "dsv_new",
            "signal_bucket",
            partition,
            ArchiveState.STAGING,
            archive_metadata("dsv_new", "signal_bucket", partition, facts=1),
        )
        archives.put(
            current,
            expected_absent=True,
            idempotency_key=f"archive-{partition}",
        )
        for state in (ArchiveState.UPLOADED, ArchiveState.CATALOGED, ArchiveState.VALIDATED):
            current = archives.update_state(
                "dsv_new",
                "signal_bucket",
                partition,
                state,
                expected_state=current.state,
                idempotency_key=f"archive-{partition}-{state.value}",
            )
        current = archives.record_reconciliation(
            "dsv_new",
            "signal_bucket",
            partition,
            observed_counts={"accepted": 1, "rejected": 0, "persisted": 1},
            reconciled_at=NOW,
            expected_state=ArchiveState.VALIDATED,
            idempotency_key=f"archive-{partition}-reconciled",
        )
        current = archives.update_state(
            "dsv_new",
            "signal_bucket",
            partition,
            ArchiveState.AVAILABLE,
            expected_state=current.state,
            idempotency_key=f"archive-{partition}-AVAILABLE",
        )

    temporal = expirations.authorize_expiration(
        "dsv_new",
        "signal_bucket",
        TEMPORAL_PARTITION,
        1_800_000_000,
        expected_archive_state=ArchiveState.AVAILABLE,
        idempotency_key="ttl-temporal",
    )
    snapshot = expirations.authorize_expiration(
        "dsv_new",
        "signal_bucket",
        "snapshot_date=2026-09-02",
        1_800_000_100,
        expected_archive_state=ArchiveState.AVAILABLE,
        idempotency_key="ttl-snapshot",
    )

    assert temporal == 1
    assert snapshot == 1
    assert sorted(backend.fact_expirations.values()) == [1_800_000_000, 1_800_000_100]


def test_hot_expiration_fake_proves_every_projection_dependency_seal() -> None:
    backend = FakeIngestionBackend()
    sink = FakeHotRecordSink(backend)
    projections = FakeProjectionRepository(backend=backend)
    archives = FakeArchivePartitionRepository(backend)
    expiration = FakeHotExpirationRepository(backend)
    sink.write((record(),), "dsv_new", TEMPORAL_PARTITION, idempotency_key="dep-fact")
    projections.put(
        overview_projection(
            (
                ArchiveDependency("incidents", TEMPORAL_PARTITION),
                ArchiveDependency("signal_bucket", TEMPORAL_PARTITION),
            ),
        ),
        expected_projection_version=None,
        idempotency_key="dep-projection",
    )
    for dataset, facts in (("incidents", 0), ("signal_bucket", 1)):
        current = ArchivePartition(
            "dsv_new",
            dataset,
            TEMPORAL_PARTITION,
            ArchiveState.STAGING,
            archive_metadata("dsv_new", dataset, TEMPORAL_PARTITION, facts=facts, projections=2),
        )
        archives.put(current, expected_absent=True, idempotency_key=f"dep-put-{dataset}")
        for state in (ArchiveState.UPLOADED, ArchiveState.CATALOGED, ArchiveState.VALIDATED):
            current = archives.update_state(
                "dsv_new",
                dataset,
                TEMPORAL_PARTITION,
                state,
                expected_state=current.state,
                idempotency_key=f"dep-{dataset}-{state.value}",
            )
        current = archives.record_reconciliation(
            "dsv_new",
            dataset,
            TEMPORAL_PARTITION,
            observed_counts={"accepted": 1, "rejected": 0, "persisted": 1},
            reconciled_at=NOW,
            expected_state=ArchiveState.VALIDATED,
            idempotency_key=f"dep-reconcile-{dataset}",
        )
        archives.update_state(
            "dsv_new",
            dataset,
            TEMPORAL_PARTITION,
            ArchiveState.AVAILABLE,
            expected_state=current.state,
            idempotency_key=f"dep-available-{dataset}",
        )

    dependency_key = ("dsv_new", "incidents", TEMPORAL_PARTITION)
    generation, digest = backend.retention_seals[dependency_key]
    backend.retention_seals[dependency_key] = (generation, digest + "tampered")
    with pytest.raises(ConditionalWriteError, match="dependency"):
        expiration.authorize_expiration(
            "dsv_new",
            "signal_bucket",
            TEMPORAL_PARTITION,
            1_800_000_000,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="dep-expiration",
        )
    assert not backend.fact_expirations
    assert not backend.projection_expirations


def test_checkpoint_advance_is_compare_and_swap_and_monotonic() -> None:
    """A stale worker or backward cursor must not overwrite a newer checkpoint."""
    repository = FakeCheckpointRepository()

    assert repository.get("dsv_new", "signal_bucket") is None
    repository.advance(
        "dsv_new",
        "signal_bucket",
        (2000, "a"),
        expected_cursor=None,
        idempotency_key="checkpoint-1",
    )
    assert repository.get("dsv_new", "signal_bucket") == (2000, "a")

    with pytest.raises(StaleCheckpoint):
        repository.advance(
            "dsv_new",
            "signal_bucket",
            (3000, "a"),
            expected_cursor=None,
            idempotency_key="checkpoint-stale",
        )
    with pytest.raises(StaleCheckpoint):
        repository.advance(
            "dsv_new",
            "signal_bucket",
            (1000, "a"),
            expected_cursor=(2000, "a"),
            idempotency_key="checkpoint-backward",
        )


def test_failed_conditional_write_remains_failed_when_its_key_is_retried() -> None:
    """A rejected mutation must not reserve a key that turns its retry into success."""
    repository = FakeCheckpointRepository()
    repository.advance(
        "dsv_new",
        "signal_bucket",
        (2000, "a"),
        expected_cursor=None,
        idempotency_key="checkpoint-initial",
    )

    for _ in range(2):
        with pytest.raises(StaleCheckpoint):
            repository.advance(
                "dsv_new",
                "signal_bucket",
                (3000, "a"),
                expected_cursor=None,
                idempotency_key="checkpoint-rejected",
            )


def test_lease_requires_expiry_or_ownership_for_every_mutation() -> None:
    """A second owner must not acquire, renew, or release another live lease."""
    repository = FakeLeaseRepository()
    lease = repository.acquire("argus", "run-a", NOW, 300, idempotency_key="lease-acquire-a")

    with pytest.raises(LeaseBusy):
        repository.acquire(
            "argus", "run-b", NOW + timedelta(seconds=1), 300, idempotency_key="lease-b"
        )
    with pytest.raises(LeaseOwnershipError):
        repository.renew(
            "argus",
            "run-b",
            NOW + timedelta(seconds=2),
            300,
            expected_expires_at=lease.expires_at,
            idempotency_key="renew-b",
        )
    with pytest.raises(LeaseOwnershipError):
        repository.release("argus", "run-b", idempotency_key="release-b")

    renewed = repository.renew(
        "argus",
        "run-a",
        NOW + timedelta(seconds=3),
        300,
        expected_expires_at=lease.expires_at,
        idempotency_key="renew-a",
    )
    assert renewed.expires_at > lease.expires_at
    repository.release("argus", "run-a", idempotency_key="release-a")
    assert repository.leases == {}


def test_expired_lease_can_be_acquired_by_a_new_owner() -> None:
    """Failing to recognize expiration would leave synchronization permanently locked."""
    repository = FakeLeaseRepository()
    repository.acquire("argus", "run-a", NOW, 1, idempotency_key="lease-a")

    lease = repository.acquire(
        "argus", "run-b", NOW + timedelta(seconds=2), 300, idempotency_key="lease-b"
    )

    assert lease.owner == "run-b"


def test_live_lease_rejects_a_new_key_even_for_the_same_owner() -> None:
    """Only renew may extend a live lease; another acquire must not enter concurrently."""
    repository = FakeLeaseRepository()
    original = repository.acquire("argus", "run-a", NOW, 300, idempotency_key="lease-original")

    with pytest.raises(LeaseBusy):
        repository.acquire(
            "argus",
            "run-a",
            NOW + timedelta(seconds=1),
            300,
            idempotency_key="lease-second",
        )

    repository.release("argus", "run-a", idempotency_key="lease-release")
    replay = repository.acquire("argus", "run-a", NOW, 300, idempotency_key="lease-original")
    assert replay == original
    assert repository.leases == {}


@pytest.mark.parametrize("ttl_seconds", (True, 0, -1))
def test_lease_acquire_requires_positive_nominal_integer_ttl(
    ttl_seconds: object,
) -> None:
    """Boolean, zero, and negative TTLs must not create a live lease."""
    repository = FakeLeaseRepository()
    expected = TypeError if ttl_seconds is True else ValueError

    with pytest.raises(expected):
        repository.acquire(
            "argus",
            "run-a",
            NOW,
            ttl_seconds,  # type: ignore[arg-type]
            idempotency_key=f"lease-{ttl_seconds}",
        )
    assert repository.leases == {}


def test_lease_validation_precedes_idempotent_replay() -> None:
    """Boolean True must not alias a previously accepted integer TTL of one second."""
    repository = FakeLeaseRepository()
    repository.acquire("argus", "run-a", NOW, 1, idempotency_key="lease-one")

    with pytest.raises(TypeError):
        repository.acquire("argus", "run-a", NOW, True, idempotency_key="lease-one")


def test_lease_requires_utc_now_and_renewal_strictly_extends_expiration() -> None:
    """Clock values must be UTC and renew cannot preserve or shorten expiration."""
    repository = FakeLeaseRepository()
    with pytest.raises(ValueError, match="aware UTC"):
        repository.acquire(
            "argus",
            "run-a",
            datetime(2026, 9, 1),
            300,
            idempotency_key="lease-naive",
        )

    lease = repository.acquire("argus", "run-a", NOW, 300, idempotency_key="lease-valid")
    for now, ttl, key in (
        (NOW + timedelta(seconds=240), 60, "renew-equal"),
        (NOW + timedelta(seconds=240), 30, "renew-shorter"),
    ):
        with pytest.raises(ConditionalWriteError, match="extend"):
            repository.renew(
                "argus",
                "run-a",
                now,
                ttl,
                expected_expires_at=lease.expires_at,
                idempotency_key=key,
            )
    with pytest.raises(TypeError):
        repository.renew(
            "argus",
            "run-a",
            NOW + timedelta(seconds=1),
            True,
            expected_expires_at=lease.expires_at,
            idempotency_key="renew-bool",
        )
    assert repository.leases["argus"] == lease


def test_lease_renew_replay_returns_original_extension() -> None:
    """A renewal retry must return its own expiration after a later renewal."""
    repository = FakeLeaseRepository()
    acquired = repository.acquire("argus", "run-a", NOW, 300, idempotency_key="lease-acquire")
    first = repository.renew(
        "argus",
        "run-a",
        NOW + timedelta(seconds=1),
        400,
        expected_expires_at=acquired.expires_at,
        idempotency_key="renew-first",
    )
    repository.renew(
        "argus",
        "run-a",
        NOW + timedelta(seconds=2),
        500,
        expected_expires_at=first.expires_at,
        idempotency_key="renew-second",
    )

    replay = repository.renew(
        "argus",
        "run-a",
        NOW + timedelta(seconds=1),
        400,
        expected_expires_at=acquired.expires_at,
        idempotency_key="renew-first",
    )
    assert replay == first


def test_run_repository_enforces_expected_stage_and_error_sequence() -> None:
    """Concurrent run transitions and duplicate errors must be rejected deterministically."""
    repository = FakeRunRepository()
    starting = RunState.start("run-1", "dsv_new")
    repository.create(starting, idempotency_key="run-create")

    validating = repository.transition(
        "run-1",
        RunStage.VALIDATING,
        expected_stage=RunStage.STARTING,
        idempotency_key="run-validating",
    )
    repository.append_error(
        "run-1",
        sequence=1,
        message="coverage partial",
        expected_stage=RunStage.VALIDATING,
        idempotency_key="run-error-1",
    )

    assert validating.stage is RunStage.VALIDATING
    assert repository.errors["run-1"] == ((1, "coverage partial"),)
    with pytest.raises(ConditionalWriteError):
        repository.transition(
            "run-1",
            RunStage.INGESTING,
            expected_stage=RunStage.STARTING,
            idempotency_key="run-stale",
        )


def test_run_repository_preserves_pipeline_identity() -> None:
    repository = FakeRunRepository()
    state = RunState.start("run-v2", "dsv_new", pipeline=RunPipeline.CANONICAL_V2)

    persisted = repository.create(state, idempotency_key="create-v2")

    assert persisted.pipeline is RunPipeline.CANONICAL_V2
    assert repository.get_run("run-v2").pipeline is RunPipeline.CANONICAL_V2


def test_run_transition_replay_returns_its_original_state() -> None:
    """A retry of an old transition must not report a later run stage as its result."""
    repository = FakeRunRepository()
    repository.create(RunState.start("run-1", "dsv_new"), idempotency_key="create")
    restoring = repository.transition(
        "run-1",
        RunStage.RESTORING,
        expected_stage=RunStage.STARTING,
        idempotency_key="to-restoring",
    )
    repository.transition(
        "run-1",
        RunStage.VALIDATING,
        expected_stage=RunStage.RESTORING,
        idempotency_key="to-validating",
    )

    replay = repository.transition(
        "run-1",
        RunStage.RESTORING,
        expected_stage=RunStage.STARTING,
        idempotency_key="to-restoring",
    )
    assert replay == restoring
    assert replay.stage is RunStage.RESTORING


def test_manifest_candidate_is_invisible_until_compare_and_swap_activation() -> None:
    """A candidate must never become active before its explicit CAS boundary."""
    old = candidate("dsv_old")
    new = candidate("dsv_new")
    repository = FakeManifestRepository(active=old)

    repository.put_candidate(new, expected_absent=True, idempotency_key="candidate-new")
    assert repository.get_active() == old
    assert repository.get_candidate("dsv_new") == new
    assert repository.get_candidate("dsv_missing") is None
    assert repository.activate("dsv_old", new, idempotency_key="activate-new") == new

    other = candidate("dsv_other")
    repository.put_candidate(other, expected_absent=True, idempotency_key="candidate-other")
    with pytest.raises(ConcurrentActivationError):
        repository.activate("dsv_old", other, idempotency_key="activate-other")


def test_fake_projection_repository_rejects_writes_after_shared_manifest_activation() -> None:
    backend = FakeIngestionBackend()
    manifests = FakeManifestRepository(active=candidate("dsv_old"), backend=backend)
    projections = FakeProjectionRepository(backend=backend)
    active = candidate("dsv_new")
    manifests.put_candidate(active, expected_absent=True, idempotency_key="candidate-active")
    manifests.activate("dsv_old", active, idempotency_key="activate-active")

    with pytest.raises(ConditionalWriteError, match="active"):
        projections.put(
            overview_projection((ArchiveDependency("signal_bucket", TEMPORAL_PARTITION),)),
            expected_projection_version=None,
            idempotency_key="projection-after-active",
        )

    assert backend.projection_operational == {}


def test_manifest_activation_replay_returns_the_original_candidate() -> None:
    """A prior activation retry must not return the manifest activated afterward."""
    repository = FakeManifestRepository(active=candidate("dsv_old"))
    first = candidate("dsv_new")
    later = candidate("dsv_later")
    repository.put_candidate(first, expected_absent=True, idempotency_key="put-first")
    activated = repository.activate("dsv_old", first, idempotency_key="activate-first")
    repository.put_candidate(later, expected_absent=True, idempotency_key="put-later")
    repository.activate("dsv_new", later, idempotency_key="activate-later")

    replay = repository.activate("dsv_old", first, idempotency_key="activate-first")
    assert replay == activated
    assert repository.get_active() == later


def test_manifest_activation_requires_the_exact_stored_candidate() -> None:
    """Activation must not create an absent candidate or accept changed metadata."""
    repository = FakeManifestRepository(active=candidate("dsv_old"))
    missing = candidate("dsv_new")
    with pytest.raises(ConditionalWriteError, match="missing"):
        repository.activate("dsv_old", missing, idempotency_key="activate-missing")

    repository.put_candidate(missing, expected_absent=True, idempotency_key="put-new")
    divergent = CandidateManifest("dsv_new", {"schemaVersion": "2.0", "datasets": []})
    with pytest.raises(ConditionalWriteError, match="differs"):
        repository.activate("dsv_old", divergent, idempotency_key="activate-divergent")


def test_projection_put_requires_the_observed_version() -> None:
    """A stale rebuild must not overwrite a newer materialization of one formula."""
    backend = FakeIngestionBackend()
    repository = FakeProjectionRepository(
        {("dsv_new", "FACT#20260901"): (record(),)}, backend=backend
    )
    dependencies = (ArchiveDependency("signal_bucket", "year=2026/month=09/day=01"),)
    first = overview_projection(dependencies, sessions=10)
    second = overview_projection(dependencies, sessions=11)

    repository.put(first, expected_projection_version=None, idempotency_key="projection-v1")
    restarted = FakeProjectionRepository(backend=backend)
    restarted.put(
        second,
        expected_projection_version="1.0",
        expected_materialization_revision=first.materialization_revision,
        idempotency_key="projection-v2",
    )

    assert repository.query_inputs("dsv_new", ("FACT#20260901",)) == (record(),)
    second_key = (
        "dsv_new",
        "DAY#20260901",
        "OVERVIEW#GLOBAL",
        second.materialization_revision,
    )
    assert repository.projections[second_key] == second
    assert len(repository.projections) == 2
    assert (
        backend.projection_heads[
            ("dsv_new", "DAY#20260901", "OVERVIEW#GLOBAL", first.operational_sort_key)
        ]
        == second.materialization_revision
    )
    with pytest.raises(IdempotencyConflict):
        FakeProjectionRepository(backend=backend).put(
            second,
            expected_projection_version="1.0",
            expected_materialization_revision=first.materialization_revision,
            idempotency_key="projection-v1",
        )
    with pytest.raises(ConditionalWriteError):
        restarted.put(
            overview_projection(dependencies, sessions=12),
            expected_projection_version="1.0",
            expected_materialization_revision=first.materialization_revision,
            idempotency_key="projection-stale",
        )


def test_projection_inputs_are_isolated_by_dataset_version_and_partition() -> None:
    """A projection must not consume facts from another candidate or partition."""
    version_a = record("version-a")
    version_b = record("version-b")
    repository = FakeProjectionRepository(
        {
            ("dsv_a", "FACT#20260901"): (version_a,),
            ("dsv_b", "FACT#20260901"): (version_b,),
        }
    )

    assert repository.query_inputs("dsv_a", ("FACT#20260901",)) == (version_a,)
    assert repository.query_inputs("dsv_b", ("FACT#20260901",)) == (version_b,)
    assert repository.query_inputs("dsv_a", ("FACT#20990101",)) == ()
    assert repository.query_inputs("dsv_missing", ("FACT#20260901",)) == ()


def test_projection_fake_catalogs_under_every_explicit_dependency_without_default_dataset() -> None:
    backend = FakeIngestionBackend()
    projection = overview_projection(
        (
            ArchiveDependency("incidents", "year=2026/month=09/day=01"),
            ArchiveDependency("signal_bucket", "year=2026/month=09/day=01"),
        ),
        partition_key="2026-09-01",
    )
    projection_key = (
        "dsv_new",
        "2026-09-01",
        "OVERVIEW#GLOBAL",
        projection.operational_sort_key,
    )
    required = (
        ("dsv_new", "incidents", "year=2026/month=09/day=01"),
        ("dsv_new", "signal_bucket", "year=2026/month=09/day=01"),
    )
    repository = FakeProjectionRepository(backend=backend)

    repository.put(
        projection,
        expected_projection_version=None,
        idempotency_key="multi-dependency-projection",
    )

    assert backend.projection_dependencies[projection_key] == required
    assert all(projection_key in backend.projection_catalog[key] for key in required)


def test_projection_fake_does_not_catalog_active_incident_pointer_for_ttl() -> None:
    backend = FakeIngestionBackend()
    dependency = ArchiveDependency("incidents", "year=2026/month=09/day=01")
    active = active_incident_projection(dependency)

    FakeProjectionRepository(backend=backend).put(
        active,
        expected_projection_version=None,
        idempotency_key="active-incident-pointer",
    )

    projection_key = (
        "dsv_new",
        "CURRENT",
        "INCIDENTS#ACTIVE",
        active.operational_sort_key,
    )
    dependency_key = ("dsv_new", "incidents", "year=2026/month=09/day=01")
    assert backend.projection_operational[projection_key] == active
    assert backend.projection_dependencies[projection_key] == (dependency_key,)
    assert projection_key not in backend.projection_catalog.get(dependency_key, set())


def test_projection_fake_reserves_a_noop_token_and_rejects_reuse() -> None:
    backend = FakeIngestionBackend()
    repository = FakeProjectionRepository(backend=backend)
    dependency = ArchiveDependency("signal_bucket", TEMPORAL_PARTITION)
    current = overview_projection((dependency,), sessions=4)
    repository.put(current, expected_projection_version=None, idempotency_key="fake-first")
    repository.put(
        current,
        expected_projection_version="1.0",
        expected_materialization_revision=current.materialization_revision,
        idempotency_key="fake-noop",
    )

    assert "fake-noop" in backend.projection_idempotency
    with pytest.raises(IdempotencyConflict):
        repository.put(
            overview_projection((dependency,), sessions=5),
            expected_projection_version="1.0",
            expected_materialization_revision=current.materialization_revision,
            idempotency_key="fake-noop",
        )


def test_projection_fake_retargets_catalogs_and_keeps_both_physical_revisions() -> None:
    backend = FakeIngestionBackend()
    repository = FakeProjectionRepository(backend=backend)
    old_dependency = ArchiveDependency("incidents", TEMPORAL_PARTITION)
    new_dependency = ArchiveDependency("signal_bucket", TEMPORAL_PARTITION)
    original = overview_projection((old_dependency,), sessions=4)
    changed = overview_projection((new_dependency,), sessions=5)
    repository.put(original, expected_projection_version=None, idempotency_key="fake-old")
    repository.put(
        changed,
        expected_projection_version="1.0",
        expected_materialization_revision=original.materialization_revision,
        idempotency_key="fake-new",
    )

    operational_key = (
        "dsv_new",
        "DAY#20260901",
        "OVERVIEW#GLOBAL",
        original.operational_sort_key,
    )
    old_revision_key = (*operational_key[:3], f"REVISION#{original.materialization_revision}")
    new_revision_key = (*operational_key[:3], f"REVISION#{changed.materialization_revision}")
    old_catalog = ("dsv_new", "incidents", TEMPORAL_PARTITION)
    new_catalog = ("dsv_new", "signal_bucket", TEMPORAL_PARTITION)
    assert backend.projection_catalog[old_catalog] == {old_revision_key}
    assert backend.projection_catalog[new_catalog] == {operational_key, new_revision_key}


def test_projection_fake_heads_are_scoped_to_each_operational_target() -> None:
    backend = FakeIngestionBackend()
    repository = FakeProjectionRepository(backend=backend)
    dependency = ArchiveDependency("signal_bucket", TEMPORAL_PARTITION)

    def at(observed: datetime, sessions: int) -> Projection:
        return Projection(
            "dsv_new",
            "DAY#20260901",
            "OVERVIEW#GLOBAL",
            "1.0",
            (dependency,),
            {
                "projectionVersion": "1.0",
                "formulaVersion": "1.0",
                "inputWatermarks": {"signal_bucket": observed},
                "observedThrough": observed,
                "coverage": "complete",
                "qualityFlags": (),
                "metrics": {
                    "sessions": sessions,
                    "errors": 0,
                    "startupErrors": None,
                    "botErrors": None,
                    "humanErrors": None,
                    "errorRate": 0,
                },
            },
        )

    target_a = at(NOW, 4)
    target_b = at(NOW + timedelta(hours=1), 4)
    refreshed_a = at(NOW, 5)
    repository.put(target_a, expected_projection_version=None, idempotency_key="fake-a")
    repository.put(target_b, expected_projection_version=None, idempotency_key="fake-b")
    repository.put(
        refreshed_a,
        expected_projection_version="1.0",
        expected_materialization_revision=target_a.materialization_revision,
        idempotency_key="fake-a-refresh",
    )

    assert len(backend.projection_heads) == 2
    assert (
        backend.projection_heads[
            ("dsv_new", "DAY#20260901", "OVERVIEW#GLOBAL", target_a.operational_sort_key)
        ]
        == refreshed_a.materialization_revision
    )
    assert (
        backend.projection_heads[
            ("dsv_new", "DAY#20260901", "OVERVIEW#GLOBAL", target_b.operational_sort_key)
        ]
        == target_b.materialization_revision
    )


def test_projection_fake_replaces_the_complete_active_snapshot_with_empty() -> None:
    backend = FakeIngestionBackend()
    repository = FakeProjectionRepository(backend=backend)
    dependency = ArchiveDependency("incidents", TEMPORAL_PARTITION)
    current = active_incident_projection(dependency)
    empty = Projection(
        current.dataset_version,
        current.partition_key,
        current.key,
        current.projection_version,
        current.required_archives,
        {**dict(current.payload), "incidents": ()},
    )
    repository.put(current, expected_projection_version=None, idempotency_key="fake-active")
    repository.put(
        empty,
        expected_projection_version="1.0",
        expected_materialization_revision=current.materialization_revision,
        idempotency_key="fake-active-empty",
    )

    target = ("dsv_new", "CURRENT", "INCIDENTS#ACTIVE", "CURRENT")
    assert backend.projection_operational == {target: empty}
    assert backend.projection_catalog == {}


def test_projection_fake_rolls_the_global_active_snapshot_across_days_and_old_seals() -> None:
    backend = FakeIngestionBackend()
    repository = FakeProjectionRepository(backend=backend)
    first = active_incident_projection(ArchiveDependency("incidents", TEMPORAL_PARTITION))
    next_day = NOW + timedelta(days=1)
    next_partition = "year=2026/month=09/day=02"
    moved = Projection(
        "dsv_new",
        "DAY#20260902",
        "INCIDENTS#ACTIVE",
        "1.0",
        (ArchiveDependency("incidents", next_partition),),
        {
            **dict(first.payload),
            "inputWatermarks": {"incidents": next_day},
            "observedThrough": next_day,
            "incidents": (
                {
                    **dict(first.payload["incidents"][0]),
                    "priority": "P1",
                },
            ),
        },
    )
    repository.put(first, expected_projection_version=None, idempotency_key="fake-rollover-1")
    backend.retention_seals[("dsv_new", "incidents", TEMPORAL_PARTITION)] = (1, "sealed")

    repository.put(
        moved,
        expected_projection_version="1.0",
        expected_materialization_revision=first.materialization_revision,
        idempotency_key="fake-rollover-2",
    )

    assert len(backend.projection_operational) == 1
    assert next(iter(backend.projection_operational.values())) == moved
    assert len(backend.projection_heads) == 1
    assert len(backend.projections) == 2
    assert backend.projection_catalog == {}


@pytest.mark.parametrize(
    "seal_previous_dependency",
    [False, True],
    ids=["new-sealed", "old-and-new-sealed"],
)
def test_projection_fake_rejects_a_sealed_new_active_dependency_atomically(
    seal_previous_dependency: bool,
) -> None:
    backend = FakeIngestionBackend()
    repository = FakeProjectionRepository(backend=backend)
    first = active_incident_projection(ArchiveDependency("incidents", TEMPORAL_PARTITION))
    next_day = NOW + timedelta(days=1)
    next_partition = "year=2026/month=09/day=02"
    moved = Projection(
        "dsv_new",
        "DAY#20260902",
        "INCIDENTS#ACTIVE",
        "1.0",
        (ArchiveDependency("incidents", next_partition),),
        {
            **dict(first.payload),
            "inputWatermarks": {"incidents": next_day},
            "observedThrough": next_day,
            "incidents": (
                {
                    **dict(first.payload["incidents"][0]),
                    "priority": "P1",
                },
            ),
        },
    )
    repository.put(first, expected_projection_version=None, idempotency_key="fake-sealed-first")
    if seal_previous_dependency:
        backend.retention_seals[("dsv_new", "incidents", TEMPORAL_PARTITION)] = (1, "sealed")
    backend.retention_seals[("dsv_new", "incidents", next_partition)] = (1, "sealed")
    projections_before = dict(backend.projections)
    operational_before = dict(backend.projection_operational)
    heads_before = dict(backend.projection_heads)
    dependencies_before = dict(backend.projection_dependencies)

    with pytest.raises(ConditionalWriteError, match="sealed"):
        repository.put(
            moved,
            expected_projection_version="1.0",
            expected_materialization_revision=first.materialization_revision,
            idempotency_key="fake-sealed-rollover",
        )

    assert backend.projections == projections_before
    assert backend.projection_operational == operational_before
    assert backend.projection_heads == heads_before
    assert backend.projection_dependencies == dependencies_before
    assert "fake-sealed-rollover" not in backend.projection_idempotency


def test_projection_requires_at_least_one_explicit_archive_dependency() -> None:
    with pytest.raises(ValueError, match="required_archives"):
        Projection(
            "dsv_new",
            "DAY#20260901",
            "overview/day",
            "1.0",
            (),
            {"views": 1},
        )


def test_archive_dependency_rejects_a_dataset_that_cannot_be_encoded_in_a_dynamo_key() -> None:
    with pytest.raises(ValueError, match="dataset"):
        ArchiveDependency("bad#dataset", TEMPORAL_PARTITION)


def test_projection_rejects_more_than_47_archive_dependencies() -> None:
    dependencies = tuple(
        ArchiveDependency(f"dataset-{index:02d}", TEMPORAL_PARTITION) for index in range(48)
    )

    with pytest.raises(ValueError, match="47"):
        Projection(
            "dsv_new",
            "DAY#20260901",
            "overview/day",
            "1.0",
            dependencies,
            {"views": 1},
        )


@pytest.mark.parametrize(
    "dependencies",
    [
        (
            ArchiveDependency("signal_bucket", TEMPORAL_PARTITION),
            ArchiveDependency("signal_bucket", TEMPORAL_PARTITION),
        ),
        (
            ArchiveDependency("signal_bucket", TEMPORAL_PARTITION),
            ArchiveDependency("incidents", TEMPORAL_PARTITION),
        ),
    ],
    ids=["duplicate", "out-of-order"],
)
def test_projection_rejects_duplicate_or_disordered_dependencies(
    dependencies: tuple[ArchiveDependency, ...],
) -> None:
    with pytest.raises(ValueError, match="unique and canonically ordered"):
        Projection(
            "dsv_new",
            "DAY#20260901",
            "overview/day",
            "1.0",
            dependencies,
            {"views": 1},
        )


def test_projection_rejects_partition_aliases_for_the_same_physical_archive() -> None:
    with pytest.raises(
        ValueError, match="required_archives must be physically unique and canonically ordered"
    ):
        Projection(
            "dsv_new",
            "DAY#20260901",
            "overview/day",
            "1.0",
            (
                ArchiveDependency("signal_bucket", "snapshot_date=2026-09-01"),
                ArchiveDependency("signal_bucket", TEMPORAL_PARTITION),
            ),
            {"views": 1},
        )


def test_projection_accepts_distinct_physical_archives_with_mixed_partition_layouts() -> None:
    dependencies = (
        ArchiveDependency("incidents", "snapshot_date=2026-09-01"),
        ArchiveDependency("signal_bucket", TEMPORAL_PARTITION),
    )

    projection = overview_projection(dependencies, sessions=1)

    assert projection.required_archives == dependencies


def test_projection_rejects_an_archive_dependency_from_another_day() -> None:
    with pytest.raises(ValueError, match="projection day"):
        Projection(
            "dsv_new",
            "DAY#20260901",
            "overview/day",
            "1.0",
            (ArchiveDependency("signal_bucket", "year=2026/month=09/day=02"),),
            {"views": 1},
        )


def test_projection_fake_cannot_move_an_existing_projection_out_of_a_sealed_catalog() -> None:
    backend = FakeIngestionBackend()
    repository = FakeProjectionRepository(backend=backend)
    original_dependency = ArchiveDependency("signal_bucket", TEMPORAL_PARTITION)
    changed_dependency = ArchiveDependency("incidents", TEMPORAL_PARTITION)
    original = overview_projection((original_dependency,), sessions=1)
    repository.put(original, expected_projection_version=None, idempotency_key="projection-first")
    original_catalog = ("dsv_new", "signal_bucket", TEMPORAL_PARTITION)
    backend.retention_seals[original_catalog] = (1, "sealed")

    with pytest.raises(ConditionalWriteError, match="sealed"):
        repository.put(
            overview_projection((changed_dependency,), sessions=2),
            expected_projection_version="1.0",
            expected_materialization_revision=original.materialization_revision,
            idempotency_key="projection-move",
        )

    revision_key = (
        "dsv_new",
        "DAY#20260901",
        "OVERVIEW#GLOBAL",
        original.materialization_revision,
    )
    target_key = (
        "dsv_new",
        "DAY#20260901",
        "OVERVIEW#GLOBAL",
        original.operational_sort_key,
    )
    assert repository.projections[revision_key] == original
    assert backend.projection_dependencies[target_key] == (original_catalog,)


def test_parquet_encoder_requires_an_explicit_absence_condition() -> None:
    """A retry may replay, but a different partition must not overwrite the path."""
    encoder = FakeParquetEncoder()
    path = Path("partition.parquet")
    descriptor = REGISTRY.require("signal_bucket")

    first = encoder.write_partition(
        (record(),),
        descriptor,
        path,
        dataset_version="dsv_new",
        expected_absent=True,
        idempotency_key="parquet-1",
    )
    replay = encoder.write_partition(
        (record(),),
        descriptor,
        path,
        dataset_version="dsv_new",
        expected_absent=True,
        idempotency_key="parquet-1",
    )

    assert replay == first
    assert first.row_count == 1
    with pytest.raises(ConditionalWriteError):
        encoder.write_partition(
            (record("source-b"),),
            descriptor,
            path,
            dataset_version="dsv_new",
            expected_absent=True,
            idempotency_key="parquet-2",
        )


def test_parquet_replay_rejects_a_fake_partition_replaced_at_the_same_path() -> None:
    """A fake retry must not return an original handle once its path was replaced."""
    encoder = FakeParquetEncoder()
    path = Path("partition.parquet")
    descriptor = REGISTRY.require("signal_bucket")
    encoder.write_partition(
        (record(),),
        descriptor,
        path,
        dataset_version="dsv_new",
        expected_absent=True,
        idempotency_key="parquet-original",
    )
    encoder.write_partition(
        (record("changed"),),
        descriptor,
        path,
        dataset_version="dsv_new",
        expected_absent=False,
        idempotency_key="parquet-changed",
    )

    with pytest.raises(ValueError, match="does not match its encoded result"):
        encoder.write_partition(
            (record(),),
            descriptor,
            path,
            dataset_version="dsv_new",
            expected_absent=True,
            idempotency_key="parquet-original",
        )


def test_archive_store_stages_promotes_and_heads_immutable_objects() -> None:
    """A canonical object key must remain immutable after promotion."""
    store = FakeArchiveObjectStore()
    encoded = EncodedPartition(Path("part.parquet"), 2, 4096, "a" * 64)
    staged = store.stage(
        encoded,
        "staging/part.parquet",
        expected_absent=True,
        idempotency_key="stage-1",
    )
    promoted = store.promote(
        staged,
        "canonical/part.parquet",
        expected_absent=True,
        idempotency_key="promote-1",
    )

    assert store.head("canonical/part.parquet") == promoted
    assert staged.size == 4096
    with pytest.raises(ConditionalWriteError):
        store.promote(
            ArchiveObject("staging/other.parquet", "b" * 64, 9),
            "canonical/part.parquet",
            expected_absent=True,
            idempotency_key="promote-2",
        )


def test_archive_promotion_requires_the_exact_staged_object() -> None:
    """Missing or tampered staging metadata must not produce a canonical object."""
    store = FakeArchiveObjectStore()
    missing = ArchiveObject("staging/missing.parquet", "a" * 64, 128)
    with pytest.raises(ConditionalWriteError, match="missing or changed"):
        store.promote(
            missing,
            "canonical/missing.parquet",
            expected_absent=True,
            idempotency_key="promote-missing",
        )

    staged = store.stage(
        EncodedPartition(Path("part.parquet"), 1, 128, "a" * 64),
        "staging/part.parquet",
        expected_absent=True,
        idempotency_key="stage-real",
    )
    tampered = ArchiveObject(staged.key, "b" * 64, staged.size)
    with pytest.raises(ConditionalWriteError, match="missing or changed"):
        store.promote(
            tampered,
            "canonical/tampered.parquet",
            expected_absent=True,
            idempotency_key="promote-tampered",
        )


def test_archive_promotion_replay_returns_original_after_target_changes() -> None:
    """A promotion retry must retain its result while unrelated objects evolve."""
    store = FakeArchiveObjectStore()
    first_stage = store.stage(
        EncodedPartition(Path("first.parquet"), 1, 128, "a" * 64),
        "staging/first.parquet",
        expected_absent=True,
        idempotency_key="stage-first",
    )
    original = store.promote(
        first_stage,
        "canonical/part.parquet",
        expected_absent=True,
        idempotency_key="promote-first",
    )
    unrelated_stage = store.stage(
        EncodedPartition(Path("second.parquet"), 2, 256, "b" * 64),
        "staging/second.parquet",
        expected_absent=True,
        idempotency_key="stage-second",
    )
    store.promote(
        unrelated_stage,
        "canonical/unrelated.parquet",
        expected_absent=True,
        idempotency_key="promote-second",
    )

    replay = store.promote(
        first_stage,
        "canonical/part.parquet",
        expected_absent=True,
        idempotency_key="promote-first",
    )
    assert replay == original


def test_canonical_promotion_never_overwrites_and_accepts_identical_object() -> None:
    """A canonical key may converge on identical bytes but never change checksum or size."""
    store = FakeArchiveObjectStore()
    first_stage = store.stage(
        EncodedPartition(Path("first.parquet"), 1, 128, "a" * 64),
        "staging/first.parquet",
        expected_absent=True,
        idempotency_key="stage-first",
    )
    first = store.promote(
        first_stage,
        "canonical/part.parquet",
        expected_absent=True,
        idempotency_key="promote-first",
    )
    second_stage = store.stage(
        EncodedPartition(Path("second.parquet"), 1, 128, "b" * 64),
        "staging/second.parquet",
        expected_absent=True,
        idempotency_key="stage-second",
    )

    identical = store.promote(
        first_stage,
        "canonical/part.parquet",
        expected_absent=True,
        idempotency_key="promote-identical",
    )
    assert identical == first
    with pytest.raises(ConditionalWriteError, match="immutable"):
        store.promote(
            second_stage,
            "canonical/part.parquet",
            expected_absent=True,
            idempotency_key="promote-different",
        )
    with pytest.raises(ConditionalWriteError, match="expected_absent"):
        store.promote(
            first_stage,
            "canonical/other.parquet",
            expected_absent=False,
            idempotency_key="promote-overwrite-switch",
        )


def test_glue_and_athena_fakes_preserve_catalog_conditions_and_counts() -> None:
    """Catalog drift or a wrong Athena count must remain observable at the ports."""
    descriptor = REGISTRY.require("signal_bucket")
    catalog = FakeGlueCatalog()
    validator = FakeAthenaValidator({("signal_bucket", "dsv_new", "2026-09-01"): 2})

    catalog.ensure_table(descriptor, "s3://bucket/canonical", idempotency_key="table-signal")
    catalog.register_legacy_partition(
        descriptor,
        "dsv_new",
        "2026-09-01",
        "s3://bucket/canonical/day=01",
        expected_absent=True,
        idempotency_key="partition-signal-1",
    )

    assert validator.validate_legacy_partition(
        "signal_bucket", "dsv_new", "2026-09-01", 2
    ) == 2
    with pytest.raises(ConditionalWriteError):
        catalog.register_legacy_partition(
            descriptor,
            "dsv_new",
            "2026-09-01",
            "s3://bucket/other",
            expected_absent=True,
            idempotency_key="partition-signal-2",
        )


def test_archive_partition_state_transition_is_conditional() -> None:
    """A stale archive worker must not skip validation states."""
    repository = FakeArchivePartitionRepository()
    staging = ArchivePartition(
        "dsv_new",
        "signal_bucket",
        "2026-09-01",
        ArchiveState.STAGING,
        archive_metadata("dsv_new", "signal_bucket", "2026-09-01"),
    )
    repository.put(staging, expected_absent=True, idempotency_key="archive-put")
    repository.update_state(
        "dsv_new",
        "signal_bucket",
        "2026-09-01",
        ArchiveState.UPLOADED,
        expected_state=ArchiveState.STAGING,
        idempotency_key="archive-uploaded",
    )
    repository.update_state(
        "dsv_new",
        "signal_bucket",
        "2026-09-01",
        ArchiveState.CATALOGED,
        expected_state=ArchiveState.UPLOADED,
        idempotency_key="archive-cataloged",
    )

    validated = repository.update_state(
        "dsv_new",
        "signal_bucket",
        "2026-09-01",
        ArchiveState.VALIDATED,
        expected_state=ArchiveState.CATALOGED,
        idempotency_key="archive-validated",
    )

    assert validated.state is ArchiveState.VALIDATED
    assert repository.query("dsv_new", "signal_bucket") == (validated,)
    with pytest.raises(ConditionalWriteError):
        repository.update_state(
            "dsv_new",
            "signal_bucket",
            "2026-09-01",
            ArchiveState.CATALOGED,
            expected_state=ArchiveState.UPLOADED,
            idempotency_key="archive-stale",
        )


def test_archive_partition_replay_returns_original_transition() -> None:
    """A replayed transition must not report a state written by a later transition."""
    repository = FakeArchivePartitionRepository()
    staging = ArchivePartition(
        "dsv_new",
        "signal_bucket",
        "2026-09-01",
        ArchiveState.STAGING,
        archive_metadata("dsv_new", "signal_bucket", "2026-09-01"),
    )
    repository.put(staging, expected_absent=True, idempotency_key="partition-put")
    repository.update_state(
        "dsv_new",
        "signal_bucket",
        "2026-09-01",
        ArchiveState.UPLOADED,
        expected_state=ArchiveState.STAGING,
        idempotency_key="partition-uploaded",
    )
    repository.update_state(
        "dsv_new",
        "signal_bucket",
        "2026-09-01",
        ArchiveState.CATALOGED,
        expected_state=ArchiveState.UPLOADED,
        idempotency_key="partition-cataloged",
    )
    validated = repository.update_state(
        "dsv_new",
        "signal_bucket",
        "2026-09-01",
        ArchiveState.VALIDATED,
        expected_state=ArchiveState.CATALOGED,
        idempotency_key="partition-validated",
    )
    reconciled = repository.record_reconciliation(
        "dsv_new",
        "signal_bucket",
        "2026-09-01",
        observed_counts={"accepted": 1, "rejected": 0, "persisted": 1},
        reconciled_at=NOW,
        expected_state=ArchiveState.VALIDATED,
        idempotency_key="partition-reconciled",
    )
    repository.update_state(
        "dsv_new",
        "signal_bucket",
        "2026-09-01",
        ArchiveState.AVAILABLE,
        expected_state=reconciled.state,
        idempotency_key="partition-available",
    )

    replay = repository.update_state(
        "dsv_new",
        "signal_bucket",
        "2026-09-01",
        ArchiveState.VALIDATED,
        expected_state=ArchiveState.CATALOGED,
        idempotency_key="partition-validated",
    )
    assert replay == validated


def test_archive_reconciliation_fake_rejects_a_naive_timestamp() -> None:
    repository = FakeArchivePartitionRepository()

    with pytest.raises(ValueError, match="aware UTC"):
        repository.record_reconciliation(
            "dsv_new",
            "signal_bucket",
            TEMPORAL_PARTITION,
            observed_counts={"accepted": 1, "rejected": 0, "persisted": 1},
            reconciled_at=datetime(2026, 9, 1),
            expected_state=ArchiveState.VALIDATED,
            idempotency_key="naive-reconciliation",
        )


def test_manifest_and_archive_fakes_reject_values_the_dynamo_adapters_reject() -> None:
    """Orchestration tests must not become green with incomplete persisted contracts."""
    with pytest.raises(ValueError, match="manifest metadata"):
        FakeManifestRepository().put_candidate(
            CandidateManifest("dsv_invalid", {}),
            expected_absent=True,
            idempotency_key="invalid-manifest",
        )
    with pytest.raises(ValueError, match="archive metadata"):
        FakeArchivePartitionRepository().put(
            ArchivePartition(
                "dsv_new",
                "signal_bucket",
                "2026-09-01",
                ArchiveState.STAGING,
                {},
            ),
            expected_absent=True,
            idempotency_key="invalid-archive",
        )


def test_window_commit_is_atomic_and_compares_the_watermark() -> None:
    """A stale source window must write neither its watermark nor its outboxes."""
    repository = FakeWindowCommitRepository()
    watermark = NOW + timedelta(hours=1)
    repository.commit_watermark_and_outboxes(
        "dsv_new",
        "argus",
        watermark,
        (event(),),
        expected_watermark=None,
        idempotency_key="window-1",
    )

    assert repository.watermarks[("dsv_new", "argus")] == watermark
    assert repository.outboxes == {event().event_id: event()}
    with pytest.raises(ConditionalWriteError):
        repository.commit_watermark_and_outboxes(
            "dsv_new",
            "argus",
            watermark + timedelta(hours=1),
            (event(2),),
            expected_watermark=None,
            idempotency_key="window-stale",
        )
    assert event(2).event_id not in repository.outboxes


def test_window_commit_accepts_zero_events_and_keeps_replay_contract() -> None:
    """An eventless complete window still advances atomically and remains idempotent."""
    repository = FakeWindowCommitRepository()
    watermark = NOW + timedelta(hours=1)

    repository.commit_watermark_and_outboxes(
        "dsv_new",
        "argus",
        watermark,
        (),
        expected_watermark=None,
        idempotency_key="empty-window",
    )
    repository.commit_watermark_and_outboxes(
        "dsv_new",
        "argus",
        watermark,
        (),
        expected_watermark=None,
        idempotency_key="empty-window",
    )

    assert repository.watermarks == {("dsv_new", "argus"): watermark}
    assert repository.outboxes == {}
    with pytest.raises(IdempotencyConflict):
        repository.commit_watermark_and_outboxes(
            "dsv_new",
            "argus",
            watermark + timedelta(hours=1),
            (),
            expected_watermark=watermark,
            idempotency_key="empty-window",
        )


def test_window_commit_isolates_versions_and_rejects_cross_version_events() -> None:
    """Watermarks and events from two candidates must never share a version scope."""
    repository = FakeWindowCommitRepository()
    watermark_a = NOW + timedelta(hours=1)
    watermark_b = NOW + timedelta(hours=2)
    repository.commit_watermark_and_outboxes(
        "dsv_a",
        "argus",
        watermark_a,
        (event(1, "dsv_a"),),
        expected_watermark=None,
        idempotency_key="window-a",
    )
    repository.commit_watermark_and_outboxes(
        "dsv_b",
        "argus",
        watermark_b,
        (event(2, "dsv_b"),),
        expected_watermark=None,
        idempotency_key="window-b",
    )

    assert repository.watermarks == {
        ("dsv_a", "argus"): watermark_a,
        ("dsv_b", "argus"): watermark_b,
    }
    with pytest.raises(ConditionalWriteError, match="dataset version"):
        repository.commit_watermark_and_outboxes(
            "dsv_a",
            "other-source",
            watermark_a,
            (event(1, "dsv_b"),),
            expected_watermark=None,
            idempotency_key="window-wrong",
        )
    assert ("dsv_a", "other-source") not in repository.watermarks


def test_outbox_repository_lists_pending_and_conditionally_marks_published() -> None:
    """Publishing must remove only the event observed in PENDING state."""
    forecast_end = NOW + timedelta(hours=2)
    later = build_analysis_event(
        "dsv_new",
        "QOE_FORECAST",
        TimeWindow(forecast_end - timedelta(hours=1), forecast_end, 3600),
        created_at=NOW + timedelta(seconds=2),
    )
    first = event()
    repository = FakeOutboxRepository({later.event_id: later, first.event_id: first})

    assert repository.list_pending(1) == (first,)
    repository.mark_published(
        first.event_id,
        "message-1",
        expected_state="PENDING",
        idempotency_key="outbox-published-1",
    )
    assert repository.list_pending(10) == (later,)
    with pytest.raises(ConditionalWriteError):
        repository.mark_published(
            first.event_id,
            "message-2",
            expected_state="PENDING",
            idempotency_key="outbox-published-2",
        )


def test_analysis_publisher_models_standard_queue_duplicate_delivery() -> None:
    """A retry after an uncertain acknowledgement may produce a visible duplicate."""
    publisher = FakeAnalysisRequestPublisher()

    request = event()
    first = publisher.publish(request, idempotency_key=request.idempotency_key)
    replay = publisher.publish(request, idempotency_key=request.idempotency_key)

    assert first.message_id == "message-1"
    assert replay.message_id == "message-2"
    assert publisher.published == (event(), event())


def test_outbox_fakes_reject_the_same_invalid_contract_and_idempotency_as_production() -> None:
    """Orchestration cannot pass with an event rejected by DynamoDB or SQS adapters."""
    invalid = OutboxEvent(
        "evt_invalid",
        "dsv_new",
        "ANOMALY_DETECTION",
        "ana_invalid",
        NOW,
        {},
    )
    repository = FakeWindowCommitRepository()
    with pytest.raises(ValueError, match="payload"):
        repository.commit_watermark_and_outboxes(
            "dsv_new",
            "argus",
            NOW + timedelta(hours=1),
            (invalid,),
            expected_watermark=None,
            idempotency_key="invalid-window",
        )
    assert repository.watermarks == {}
    assert repository.outboxes == {}

    publisher = FakeAnalysisRequestPublisher()
    with pytest.raises(ValueError, match="payload"):
        publisher.publish(invalid, idempotency_key=invalid.idempotency_key)
    valid = event()
    with pytest.raises(ValueError, match="match"):
        publisher.publish(valid, idempotency_key="ana_different")
    assert publisher.published == ()


def test_fake_analysis_publisher_enforces_the_sqs_message_size_limit() -> None:
    """The fake must not accept a message the real SQS publisher rejects before send."""
    window_end = NOW + timedelta(minutes=15)
    oversized = build_analysis_event(
        "dsv_" + "x" * (256 * 1024),
        "ANOMALY_DETECTION",
        TimeWindow(NOW, window_end, 900),
        created_at=NOW,
    )

    with pytest.raises(ValueError, match="256 KiB"):
        FakeAnalysisRequestPublisher().publish(
            oversized,
            idempotency_key=oversized.idempotency_key,
        )


@pytest.mark.parametrize(
    "repository_factory",
    (
        lambda: DynamoOutboxRepository(NoAwsCalls(), "hot"),
        FakeWindowCommitRepository,
    ),
    ids=("dynamodb", "fake"),
)
def test_window_commit_rejects_the_same_outbox_item_over_200_kib(
    repository_factory: Callable[[], WindowCommitRepository],
) -> None:
    """A fake commit must not persist an event the Dynamo item limit rejects."""
    window_end = NOW + timedelta(minutes=15)
    oversized = build_analysis_event(
        "dsv_" + "x" * (210 * 1024),
        "ANOMALY_DETECTION",
        TimeWindow(NOW, window_end, 900),
        created_at=NOW,
    )
    repository = repository_factory()

    with pytest.raises(ValueError, match="200 KiB"):
        repository.commit_watermark_and_outboxes(
            oversized.dataset_version,
            "argus",
            window_end,
            (oversized,),
            expected_watermark=None,
            idempotency_key="oversized-window",
        )


def _published_fake_outbox() -> FakeOutboxRepository:
    request = event()
    repository = FakeOutboxRepository({request.event_id: request})
    repository.states[request.event_id] = "PUBLISHED"
    return repository


@pytest.mark.parametrize(
    "repository_factory",
    (
        lambda: DynamoOutboxRepository(NoAwsCalls(), "hot"),
        _published_fake_outbox,
    ),
    ids=("dynamodb", "fake"),
)
def test_mark_published_rejects_non_pending_expected_state_before_lookup(
    repository_factory: Callable[[], OutboxRepository],
) -> None:
    """The literal expected state is invalid even when it matches stored state."""
    repository = repository_factory()

    with pytest.raises(ValueError, match="expected_state must be PENDING"):
        repository.mark_published(
            event().event_id,
            "message-2",
            expected_state="PUBLISHED",
            idempotency_key="invalid-expected-state",
        )


def test_logger_binding_is_immutable_and_preserves_structured_context() -> None:
    """Binding request context must not leak fields back into the parent logger."""
    logger = FakeLogger()
    bound = logger.bind(run_id="run-1")
    bound.info("started", stage="STARTING")
    logger.error("failed", reason="boom")

    assert logger.records == (
        ("INFO", "started", {"run_id": "run-1", "stage": "STARTING"}),
        ("ERROR", "failed", {"reason": "boom"}),
    )
    assert logger.context == {}


def test_metrics_fake_records_each_metric_kind_and_dimensions() -> None:
    """Dropping a metric type or dimensions would hide pipeline health."""
    metrics = FakeMetricsPublisher()
    metrics.increment("rows", 2, {"dataset": "signal_bucket"})
    metrics.gauge("lag", 5.0, {"source": "argus"})
    metrics.timing("duration", 12.5, {"stage": "INGESTING"})

    assert metrics.measurements == (
        ("increment", "rows", 2, {"dataset": "signal_bucket"}),
        ("gauge", "lag", 5.0, {"source": "argus"}),
        ("timing", "duration", 12.5, {"stage": "INGESTING"}),
    )
