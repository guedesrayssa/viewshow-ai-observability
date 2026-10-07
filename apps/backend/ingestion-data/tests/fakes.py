"""In-memory implementations that execute the same port invariants as adapters."""

from __future__ import annotations

import hashlib
import re
import threading
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import MappingProxyType
from typing import cast

from domain.analysis import (
    pending_analysis_outbox_item,
    validate_publish_request,
    validate_window_commit_contract,
)
from domain.archive import (
    manifest_is_ready_for_activation,
    partition_date,
    validate_archive_partition,
    validate_archive_transition,
    validate_candidate_manifest,
    validate_new_archive_partition,
)
from domain.archive_records import ArchiveRecordValidationError, validate_archive_record
from domain.canonical_json import canonical_bytes
from domain.canonical_set import CanonicalSet
from domain.datasets import DatasetDescriptor
from domain.disk_budget import DiskBudget
from domain.identity import payload_hash, record_id
from domain.incremental_batches import (
    BatchDelivery,
    BatchState,
    EncodedRawBatch,
    IncrementalBatchDefinition,
    IncrementalBatchManifest,
    IncrementalBatchRecord,
    IncrementalBatchReference,
    PhysicalColumn,
    RawBatchPage,
)
from domain.models import CanonicalRecord, TimeWindow
from domain.persisted_error import PersistedError
from domain.quality import CoverageStatus
from domain.run import RunPipeline, RunProgress, RunStage, RunState, RunTransitionMetadata
from ports import (
    AnalysisRequestPublisher,
    ArchiveDependency,
    ArchiveObject,
    ArchiveObjectStore,
    ArchivePartition,
    ArchivePartitionRepository,
    ArchiveReconciliationError,
    ArchiveState,
    AthenaValidator,
    CandidateManifest,
    CanonicalSetStore,
    CheckpointRepository,
    ConditionalWriteError,
    CoverageObservation,
    CurrentProjection,
    Cursor,
    EncodedPartition,
    EventProjectionItem,
    GlueCatalog,
    HotExpirationRepository,
    HotRecordSink,
    IdempotencyConflict,
    IncrementalBatchObjectStore,
    IncrementalBatchQueue,
    IncrementalBatchRepository,
    IncrementalExportSource,
    Lease,
    LeaseBusy,
    LeaseOwnershipError,
    LeaseRepository,
    LiveSyncConfiguration,
    Logger,
    ManifestRepository,
    MetricsPublisher,
    OutboxEvent,
    OutboxRepository,
    ParquetEncoder,
    Projection,
    ProjectionRepository,
    PublishReceipt,
    RawBatchCodec,
    ReconciliationCounts,
    RestoreRequest,
    RestoreResult,
    RunRepository,
    SchemaObservation,
    SnapshotChecksumMismatch,
    SnapshotRestorer,
    SourcePage,
    SourceReader,
    StaleCheckpoint,
    WindowCommitRepository,
    WriteResult,
)
from ports.errors import ConcurrentActivationError

type FactKey = tuple[str, str, tuple[tuple[str, object], ...]]
type ProjectionLogicalKey = tuple[str, str, str]
type ProjectionRevisionKey = tuple[str, str, str, str]
type ProjectionTargetKey = tuple[str, str, str, str]
type ArchivePartitionKey = tuple[str, str, str]


class FakeCanonicalSetStore(CanonicalSetStore):
    def __init__(self) -> None:
        self.values: dict[str, CanonicalSet] = {}
        self.commits: list[str] = []

    def get(self, dataset_version: str) -> CanonicalSet | None:
        return self.values.get(dataset_version)

    def commit(self, value: CanonicalSet, *, idempotency_key: str) -> CanonicalSet:
        if not isinstance(idempotency_key, str) or not idempotency_key:
            raise ValueError("idempotency_key must be non-empty")
        current = self.values.get(value.dataset_version)
        if current is not None and current != value:
            raise ConditionalWriteError("canonical set marker differs from existing evidence")
        self.values[value.dataset_version] = value
        self.commits.append(value.dataset_version)
        return value


class FakeLiveSyncConfiguration(LiveSyncConfiguration):
    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled
        self.reads = 0

    def is_enabled(self) -> bool:
        self.reads += 1
        return self.enabled


class FakeIngestionBackend:
    def __init__(self) -> None:
        self.fact_records: dict[FactKey, CanonicalRecord] = {}
        self.fact_catalog: dict[ArchivePartitionKey, set[FactKey]] = {}
        self.fact_expirations: dict[FactKey, int] = {}
        self.projections: dict[ProjectionRevisionKey, Projection] = {}
        self.projection_operational: dict[ProjectionTargetKey, Projection] = {}
        self.projection_heads: dict[ProjectionTargetKey, str] = {}
        self.projection_catalog: dict[ArchivePartitionKey, set[ProjectionTargetKey]] = {}
        self.projection_dependencies: dict[
            ProjectionTargetKey, tuple[ArchivePartitionKey, ...]
        ] = {}
        self.projection_expirations: dict[ProjectionTargetKey, int] = {}
        self.projection_idempotency: dict[str, tuple[object, object]] = {}
        self.active_projection_fences: set[str] = set()
        self.projection_inputs: dict[tuple[str, str], tuple[CanonicalRecord, ...]] = {}
        self.event_projection_items: dict[tuple[str, str], EventProjectionItem] = {}
        self.archive_partitions: dict[ArchivePartitionKey, ArchivePartition] = {}
        self.catalog_summaries: dict[ArchivePartitionKey, tuple[int, int, int, str]] = {}
        self.retention_seals: dict[ArchivePartitionKey, tuple[int, str]] = {}
        self.ttl_authorizations: dict[ArchivePartitionKey, tuple[int, str, str]] = {}
        self.watermarks: dict[tuple[str, str], datetime] = {}
        self.bucket_evidence: dict[tuple[str, str], tuple[tuple[str, int, int, int], ...]] = {}
        self.outboxes: dict[str, OutboxEvent] = {}
        self.outbox_states: dict[str, str] = {}
        self.outbox_message_ids: dict[str, str] = {}


def _fake_catalog_digest(
    backend: FakeIngestionBackend, key: ArchivePartitionKey, generation: int
) -> str:
    projection_evidence = [
        (projection_key, backend.projection_dependencies.get(projection_key, ()))
        for projection_key in sorted(backend.projection_catalog.get(key, set()))
    ]
    return hashlib.sha256(
        canonical_bytes(
            {
                "generation": generation,
                "facts": [repr(item) for item in sorted(backend.fact_catalog.get(key, set()))],
                "projections": [repr(item) for item in projection_evidence],
            }
        )
    ).hexdigest()


def _refresh_fake_catalog_summary(
    backend: FakeIngestionBackend, key: ArchivePartitionKey, generation: int = 1
) -> None:
    backend.catalog_summaries[key] = (
        generation,
        len(backend.fact_catalog.get(key, set())),
        len(backend.projection_catalog.get(key, set())),
        _fake_catalog_digest(backend, key, generation),
    )


class _IdempotencyLedger:
    def __init__(self) -> None:
        self._entries: dict[tuple[str, str], object] = {}
        self._results: dict[tuple[str, str], object] = {}

    def claim(self, scope: str, key: str, payload: object) -> bool:
        if not key:
            raise ValueError("idempotency_key must not be empty")
        ledger_key = (scope, key)
        if ledger_key not in self._entries:
            return True
        if self._entries[ledger_key] != payload:
            raise IdempotencyConflict(f"idempotency key {key!r} was reused with different input")
        return False

    def commit(self, scope: str, key: str, payload: object, result: object = None) -> None:
        self._entries[(scope, key)] = payload
        self._results[(scope, key)] = result

    def result(self, scope: str, key: str) -> object:
        return self._results[(scope, key)]


def _lease_expiration(now: datetime, ttl_seconds: int) -> datetime:
    if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int):
        raise TypeError("ttl_seconds must be an integer")
    if ttl_seconds <= 0:
        raise ValueError("ttl_seconds must be positive")
    if not isinstance(now, datetime):
        raise TypeError("now must be a datetime")
    if now.tzinfo is None or now.utcoffset() != timedelta(0):
        raise ValueError("now must be an aware UTC datetime")
    return now + timedelta(seconds=ttl_seconds)


class FakeSourceReader(SourceReader):
    def __init__(self, rows_by_dataset: Mapping[str, tuple[Mapping[str, object], ...]]) -> None:
        self.rows_by_dataset = {
            dataset: SourcePage(rows, None).rows for dataset, rows in rows_by_dataset.items()
        }

    def validate_schema(self, descriptor: DatasetDescriptor) -> SchemaObservation:
        compatible = descriptor.table in self.rows_by_dataset
        differences = () if compatible else (f"dataset {descriptor.table} is unavailable",)
        fingerprint = hashlib.sha256(repr(descriptor.columns).encode()).hexdigest()
        return SchemaObservation(fingerprint, compatible, differences)

    def measure_coverage(self, descriptor: DatasetDescriptor) -> CoverageObservation:
        rows = self.rows_by_dataset.get(descriptor.table, ())
        status = CoverageStatus.COMPLETE if rows else CoverageStatus.UNAVAILABLE
        return CoverageObservation(status, len(rows), None)

    def read_page(
        self,
        descriptor: DatasetDescriptor,
        window: TimeWindow | None,
        after: Cursor | None,
        limit: int,
    ) -> SourcePage:
        if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
            raise ValueError("limit must be a positive integer")
        rows = self.rows_by_dataset.get(descriptor.table, ())
        ordered = sorted(rows, key=lambda row: tuple(row[field] for field in descriptor.cursor_key))
        if window is not None and descriptor.timestamp_field is not None:
            start_ms = int(window.start.timestamp() * 1000)
            end_ms = int(window.end.timestamp() * 1000)

            def inside(candidate: Mapping[str, object]) -> bool:
                observed = candidate[descriptor.timestamp_field]  # type: ignore[index]
                if isinstance(observed, datetime):
                    return window.start <= observed < window.end
                return isinstance(observed, int) and start_ms <= observed < end_ms

            ordered = [row for row in ordered if inside(row)]
        if after is not None:
            if len(after) != len(descriptor.cursor_key):
                raise ValueError("cursor shape differs from descriptor cursor_key")
            ordered = [
                row
                for row in ordered
                if tuple(row[field] for field in descriptor.cursor_key) > after
            ]
        page_rows = tuple(ordered[:limit])
        next_cursor = (
            tuple(page_rows[-1][field] for field in descriptor.cursor_key) if page_rows else None
        )
        return SourcePage(page_rows, next_cursor)


class FakeIncrementalExportSource(IncrementalExportSource):
    """Pages a fixed raw sequence while retaining the observed physical schema."""

    def __init__(
        self,
        columns: tuple[PhysicalColumn, ...],
        rows: tuple[Mapping[str, object], ...],
    ) -> None:
        self.columns = columns
        self.rows = SourcePage(rows, None).rows
        self.observed: list[DatasetDescriptor] = []

    def observe_schema(self, descriptor: DatasetDescriptor) -> tuple[PhysicalColumn, ...]:
        self.observed.append(descriptor)
        return self.columns

    def read_page(
        self,
        descriptor: DatasetDescriptor,
        window: TimeWindow,
        after: Cursor | None,
        limit: int,
    ) -> SourcePage:
        if limit <= 0:
            raise ValueError("limit must be positive")
        offset = 0 if after is None else int(after[0])
        page_rows = self.rows[offset : offset + limit]
        next_offset = offset + len(page_rows)
        next_cursor = (next_offset,) if next_offset < len(self.rows) else None
        return SourcePage(page_rows, next_cursor)


class FakeRawBatchCodec(RawBatchCodec):
    """Records deterministic raw payload bytes without depending on a Parquet runtime."""

    def encode(
        self,
        columns: tuple[PhysicalColumn, ...],
        rows: Iterable[Mapping[str, object]],
        destination: Path,
    ) -> EncodedRawBatch:
        values = tuple(dict(row) for row in rows)
        body = canonical_bytes(
            {
                "columns": [column.name for column in columns],
                "rows": values,
            }
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(body)
        return EncodedRawBatch(
            destination,
            len(values),
            len(body),
            hashlib.sha256(body).hexdigest(),
            hashlib.sha256(
                canonical_bytes(
                    [
                        {
                            "name": column.name,
                            "physicalType": column.physical_type,
                            "nullable": column.nullable,
                            "ordinal": column.ordinal,
                        }
                        for column in columns
                    ]
                )
            ).hexdigest(),
        )


class FakeIncrementalBatchStore(IncrementalBatchObjectStore):
    """Keeps immutable manifests by deterministic batch identity for export tests."""

    def __init__(self, *, effects: list[str] | None = None) -> None:
        self.published: list[IncrementalBatchDefinition] = []
        self.manifests: list[IncrementalBatchManifest] = []
        self.effects = effects
        self._references: dict[str, IncrementalBatchReference] = {}
        self._manifests: dict[str, IncrementalBatchManifest] = {}
        self.raw_rows: dict[str, tuple[Mapping[str, object], ...]] = {}
        self.read_calls: list[tuple[str, int | None, int]] = []

    def seed(
        self,
        manifest: IncrementalBatchManifest,
        reference: IncrementalBatchReference,
        rows: tuple[Mapping[str, object], ...],
    ) -> None:
        """Make one immutable raw batch available to ingestion tests."""
        if manifest.row_count != len(rows):
            raise ValueError("seed rows must match manifest row_count")
        self._references[manifest.batch_id] = reference
        self._manifests[reference.key] = manifest
        self.raw_rows[manifest.batch_id] = SourcePage(rows, None).rows

    def publish(
        self,
        definition: IncrementalBatchDefinition,
        columns: tuple[PhysicalColumn, ...],
        encoded: EncodedRawBatch,
    ) -> IncrementalBatchReference:
        if self.effects is not None:
            self.effects.append("store.publish")
        self.published.append(definition)
        existing = self._references.get(definition.batch_id)
        if existing is not None:
            return existing
        base_key = f"raw/argus/incremental/dataset={definition.source_dataset}"
        manifest = IncrementalBatchManifest(
            batch_id=definition.batch_id,
            source_system=definition.source_system,
            source_dataset=definition.source_dataset,
            window=definition.window,
            revision=definition.revision,
            data_key=f"{base_key}/batch_id={definition.batch_id}/data.parquet",
            data_version_id="data-v1",
            data_size_bytes=encoded.size_bytes,
            data_sha256=encoded.sha256,
            schema_fingerprint=encoded.schema_fingerprint,
            columns=columns,
            extra_columns=(),
            row_count=encoded.row_count,
            exporter_version=definition.exporter_version,
        )
        reference = IncrementalBatchReference(
            "incremental-bucket",
            f"{base_key}/batch_id={definition.batch_id}/manifest.json",
            "manifest-v1",
        )
        self._references[definition.batch_id] = reference
        self._manifests[reference.key] = manifest
        self.manifests.append(manifest)
        return reference

    def load_manifest(self, reference: IncrementalBatchReference) -> IncrementalBatchManifest:
        return self._manifests[reference.key]

    def read_page(
        self, manifest: IncrementalBatchManifest, after: int | None, limit: int
    ) -> RawBatchPage:
        if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
            raise ValueError("limit must be a positive integer")
        if after is not None and (
            isinstance(after, bool) or not isinstance(after, int) or after < 0
        ):
            raise ValueError("after must be a non-negative integer or None")
        rows = self.raw_rows.get(manifest.batch_id, ())
        offset = after or 0
        if offset > len(rows):
            raise ValueError("after exceeds the raw batch")
        self.read_calls.append((manifest.batch_id, after, limit))
        page_rows = rows[offset : offset + limit]
        next_offset = offset + len(page_rows)
        return RawBatchPage(page_rows, next_offset if next_offset < len(rows) else None)


@dataclass(frozen=True, slots=True)
class FakeIncrementalQueueSend:
    reference: IncrementalBatchReference
    batch_id: str
    dataset: str


class FakeIncrementalBatchQueue(IncrementalBatchQueue):
    """Fails planned sends before recording the messages accepted by the queue."""

    def __init__(self, *, effects: list[str] | None = None) -> None:
        self.sent: list[FakeIncrementalQueueSend] = []
        self.failure: Exception | None = None
        self.failures_remaining = 0
        self.successful_sends = 0
        self.effects = effects
        self.deliveries: list[BatchDelivery] = []
        self.acked: tuple[str, ...] = ()
        self.ack_failures_remaining = 0
        self.extensions: list[tuple[str, int]] = []
        self.extension_failure: Exception | None = None

    def enqueue(self, delivery: BatchDelivery) -> None:
        self.deliveries.append(delivery)

    def send(
        self,
        reference: IncrementalBatchReference,
        *,
        batch_id: str,
        dataset: str,
    ) -> None:
        if self.effects is not None:
            self.effects.append("queue.send")
        if self.failure is not None:
            raise self.failure
        if self.failures_remaining:
            self.failures_remaining -= 1
            raise RuntimeError("planned queue failure")
        self.sent.append(FakeIncrementalQueueSend(reference, batch_id, dataset))
        self.successful_sends += 1

    def receive(self, limit: int) -> tuple[BatchDelivery, ...]:
        if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
            raise ValueError("limit must be a positive integer")
        return tuple(
            delivery for delivery in self.deliveries if delivery.message_id not in self.acked
        )[:limit]

    def ack(self, delivery: BatchDelivery) -> None:
        if self.ack_failures_remaining:
            self.ack_failures_remaining -= 1
            raise RuntimeError("planned queue ack failure")
        if delivery.message_id not in self.acked:
            self.acked += (delivery.message_id,)

    def extend_visibility(self, delivery: BatchDelivery, seconds: int) -> None:
        if self.extension_failure is not None:
            raise self.extension_failure
        self.extensions.append((delivery.message_id, seconds))


class FakeIncrementalBatchRepository(IncrementalBatchRepository):
    """Enforces the production lifecycle while exposing durable test state."""

    _TRANSITIONS = frozenset(
        {
            (BatchState.RECEIVED, BatchState.VALIDATING),
            (BatchState.RETRYABLE_FAILED, BatchState.VALIDATING),
            (BatchState.VALIDATING, BatchState.INGESTING),
            (BatchState.VALIDATING, BatchState.RETRYABLE_FAILED),
            (BatchState.INGESTING, BatchState.COMMITTING),
            (BatchState.INGESTING, BatchState.RETRYABLE_FAILED),
        }
    )

    def __init__(self) -> None:
        self.records: dict[str, IncrementalBatchRecord] = {}
        self.counts: dict[str, Mapping[str, int]] = {}
        self.error_codes: dict[str, str | None] = {}
        self.fail_finishes_remaining = 0

    @staticmethod
    def _manifest_digest(manifest: IncrementalBatchManifest) -> str:
        return hashlib.sha256(canonical_bytes(manifest.to_mapping())).hexdigest()

    def claim(
        self,
        manifest: IncrementalBatchManifest,
        reference: IncrementalBatchReference,
    ) -> IncrementalBatchRecord:
        digest = self._manifest_digest(manifest)
        existing = self.records.get(manifest.batch_id)
        if existing is not None:
            if existing.manifest_sha256 != digest or existing.reference != reference:
                raise IdempotencyConflict("batch identity has conflicting immutable content")
            return existing
        record = IncrementalBatchRecord(
            manifest.batch_id,
            BatchState.RECEIVED,
            0,
            digest,
            reference,
        )
        self.records[manifest.batch_id] = record
        return record

    def transition(
        self,
        batch_id: str,
        expected_state: BatchState,
        expected_version: int,
        next_state: BatchState,
    ) -> IncrementalBatchRecord:
        if (expected_state, next_state) not in self._TRANSITIONS:
            raise ValueError("batch transition is not allowed")
        current = self.records[batch_id]
        if current.state is not expected_state or current.version != expected_version:
            raise ConditionalWriteError("batch state or version differs from expected")
        changed = replace(current, state=next_state, version=current.version + 1)
        self.records[batch_id] = changed
        return changed

    def finish(
        self,
        batch_id: str,
        expected_state: BatchState,
        expected_version: int,
        next_state: BatchState,
        *,
        counts: Mapping[str, int],
        error_code: str | None = None,
    ) -> IncrementalBatchRecord:
        if self.fail_finishes_remaining:
            self.fail_finishes_remaining -= 1
            raise RuntimeError("planned batch finish failure")
        if next_state is BatchState.COMPLETED and expected_state is not BatchState.COMMITTING:
            raise ValueError("COMPLETED requires COMMITTING")
        if next_state is BatchState.QUARANTINED and expected_state not in {
            BatchState.VALIDATING,
            BatchState.INGESTING,
        }:
            raise ValueError("QUARANTINED requires VALIDATING or INGESTING")
        current = self.records[batch_id]
        if current.state is not expected_state or current.version != expected_version:
            raise ConditionalWriteError("batch state or version differs from expected")
        changed = replace(current, state=next_state, version=current.version + 1)
        self.records[batch_id] = changed
        self.counts[batch_id] = MappingProxyType(dict(counts))
        self.error_codes[batch_id] = error_code
        return changed


class FakeSnapshotRestorer(SnapshotRestorer):
    def __init__(self, result: RestoreResult) -> None:
        self.result = result
        self.restores: tuple[RestoreRequest, ...] = ()
        self._idempotency = _IdempotencyLedger()

    def restore(self, request: RestoreRequest, *, idempotency_key: str) -> RestoreResult:
        if self.result.compressed_sha256 != request.expected_sha256:
            raise SnapshotChecksumMismatch("restored snapshot checksum differs from request")
        if not self._idempotency.claim("restore", idempotency_key, request):
            return cast(RestoreResult, self._idempotency.result("restore", idempotency_key))
        self.restores += (request,)
        self._idempotency.commit("restore", idempotency_key, request, self.result)
        return self.result


class FakeHotRecordSink(HotRecordSink):
    def __init__(self, backend: FakeIngestionBackend | None = None) -> None:
        self.backend = backend or FakeIngestionBackend()
        self.records = self.backend.fact_records
        self.hot_partition_catalog = self.backend.fact_catalog
        self._idempotency = _IdempotencyLedger()
        self.write_calls = 0

    def write(
        self,
        records: tuple[CanonicalRecord, ...],
        dataset_version: str,
        partition: str,
        *,
        idempotency_key: str,
    ) -> WriteResult:
        self.write_calls += 1
        ArchiveDependency("partition", partition)
        payload = (records, dataset_version, partition)
        if not self._idempotency.claim("hot-write", idempotency_key, payload):
            return cast(WriteResult, self._idempotency.result("hot-write", idempotency_key))
        desired: dict[FactKey, CanonicalRecord] = {}
        for current in records:
            key: FactKey = (dataset_version, current.source_dataset, current.natural_key)
            previous = desired.get(key)
            if previous is not None and previous != current:
                raise ValueError(
                    f"duplicate recordId has conflicting payload: {record_id(current)}"
                )
            desired[key] = current
        written = 0
        unchanged = 0
        changed: list[tuple[FactKey, CanonicalRecord]] = []
        for key, current in desired.items():
            persisted = self.records.get(key)
            if persisted == current:
                unchanged += 1
            elif persisted is not None:
                raise ConditionalWriteError("versioned hot records are immutable")
            else:
                changed.append((key, current))
                written += 1
        affected = {
            (dataset_version, current.source_dataset, partition) for _key, current in changed
        }
        if any(key in self.backend.retention_seals for key in affected):
            raise ConditionalWriteError("hot partition catalog generation is already sealed")
        for fact_key, current in changed:
            self.records[fact_key] = current
            for catalog_keys in self.hot_partition_catalog.values():
                catalog_keys.discard(fact_key)
            catalog_key = (dataset_version, current.source_dataset, partition)
            self.hot_partition_catalog.setdefault(catalog_key, set()).add(fact_key)
        for catalog_key in affected:
            _refresh_fake_catalog_summary(self.backend, catalog_key)
        result = WriteResult(written, unchanged)
        self._idempotency.commit("hot-write", idempotency_key, payload, result)
        return result


class FakeHotExpirationRepository(HotExpirationRepository):
    def __init__(self, backend: FakeIngestionBackend) -> None:
        self.backend = backend
        self._idempotency = _IdempotencyLedger()

    def authorize_expiration(
        self,
        dataset_version: str,
        dataset: str,
        partition: str,
        ttl_epoch_s: int,
        *,
        expected_archive_state: ArchiveState,
        idempotency_key: str,
    ) -> int:
        if expected_archive_state is not ArchiveState.AVAILABLE:
            raise ConditionalWriteError("archive partition must be AVAILABLE before TTL")
        if isinstance(ttl_epoch_s, bool) or not isinstance(ttl_epoch_s, int):
            raise TypeError("ttl_epoch_s must be an integer")
        if ttl_epoch_s <= 0:
            raise ValueError("ttl_epoch_s must be positive")
        payload = (
            dataset_version,
            dataset,
            partition,
            ttl_epoch_s,
            expected_archive_state,
        )
        replay = not self._idempotency.claim("hot-expiration", idempotency_key, payload)
        archive_key = (dataset_version, dataset, partition)
        archive = self.backend.archive_partitions.get(archive_key)
        if archive is None:
            raise ConditionalWriteError("archive partition is missing")
        if archive.state is not expected_archive_state:
            raise ConditionalWriteError(
                f"archive partition is {archive.state}, expected {expected_archive_state}"
            )
        reconciliation = archive.metadata.get("reconciliation")
        if (
            not isinstance(reconciliation, Mapping)
            or reconciliation.get("state") != "PASSED"
            or archive.metadata.get("expirationEligible") is not True
            or not isinstance(archive.metadata.get("catalogDigest"), str)
        ):
            raise ConditionalWriteError("archive partition is not reconciled and eligible")
        record_keys = self.backend.fact_catalog.get(archive_key, set())
        projection_keys = self.backend.projection_catalog.get(archive_key, set())
        generation = archive.metadata.get("catalogGeneration")
        digest = archive.metadata.get("catalogDigest")
        if (
            isinstance(generation, bool)
            or not isinstance(generation, int)
            or self.backend.catalog_summaries.get(archive_key)
            != (generation, len(record_keys), len(projection_keys), digest)
            or self.backend.retention_seals.get(archive_key) != (generation, digest)
            or _fake_catalog_digest(self.backend, archive_key, generation) != digest
        ):
            raise ConditionalWriteError("hot catalog generation or seal differs from archive")
        if len(record_keys) != archive.metadata.get("hotItemCount") or len(
            projection_keys
        ) != archive.metadata.get("projectionItemCount"):
            raise ConditionalWriteError("hot catalog target count differs from archive catalog")
        for projection_key in projection_keys:
            dependencies = self.backend.projection_dependencies.get(projection_key)
            if not dependencies:
                raise ConditionalWriteError("projection dependencies are missing")
            for dependency in dependencies:
                required = self.backend.archive_partitions.get(dependency)
                required_reconciliation = (
                    required.metadata.get("reconciliation") if required is not None else None
                )
                if (
                    required is None
                    or required.state is not ArchiveState.AVAILABLE
                    or not isinstance(required_reconciliation, Mapping)
                    or required_reconciliation.get("state") != "PASSED"
                    or required.metadata.get("expirationEligible") is not True
                    or self.backend.retention_seals.get(dependency)
                    != (
                        required.metadata.get("catalogGeneration"),
                        required.metadata.get("catalogDigest"),
                    )
                    or self.backend.catalog_summaries.get(dependency)
                    != (
                        required.metadata.get("catalogGeneration"),
                        len(self.backend.fact_catalog.get(dependency, set())),
                        len(self.backend.projection_catalog.get(dependency, set())),
                        required.metadata.get("catalogDigest"),
                    )
                    or _fake_catalog_digest(
                        self.backend,
                        dependency,
                        cast(int, required.metadata.get("catalogGeneration")),
                    )
                    != required.metadata.get("catalogDigest")
                ):
                    raise ConditionalWriteError("projection archive dependency is not AVAILABLE")
        authorization_dependencies = {
            archive_key,
            *(
                dependency
                for projection_key in projection_keys
                for dependency in self.backend.projection_dependencies.get(projection_key, ())
            ),
        }
        authorization_fingerprint = hashlib.sha256(
            canonical_bytes(
                {
                    "datasetVersion": dataset_version,
                    "partition": partition,
                    "ttl": ttl_epoch_s,
                }
            )
        ).hexdigest()
        for dependency in authorization_dependencies:
            existing_authorization = self.backend.ttl_authorizations.get(dependency)
            if existing_authorization is not None and existing_authorization[:2] != (
                ttl_epoch_s,
                authorization_fingerprint,
            ):
                raise ConditionalWriteError(
                    "archive partition is already authorized with a different TTL"
                )
        for dependency in authorization_dependencies:
            self.backend.ttl_authorizations.setdefault(
                dependency, (ttl_epoch_s, authorization_fingerprint, idempotency_key)
            )
        for record_key in record_keys:
            self.backend.fact_expirations[record_key] = ttl_epoch_s
        for projection_key in projection_keys:
            self.backend.projection_expirations[projection_key] = ttl_epoch_s
        result = len(record_keys) + len(projection_keys)
        if replay:
            persisted_result = cast(
                int, self._idempotency.result("hot-expiration", idempotency_key)
            )
            if persisted_result != result:
                raise ConditionalWriteError("hot catalog changed after TTL completion")
        else:
            self._idempotency.commit("hot-expiration", idempotency_key, payload, result)
        return result


class FakeCheckpointRepository(CheckpointRepository):
    def __init__(self) -> None:
        self.checkpoints: dict[tuple[str, str], Cursor] = {}
        self._idempotency = _IdempotencyLedger()

    def get(self, dataset_version: str, dataset: str) -> Cursor | None:
        return self.checkpoints.get((dataset_version, dataset))

    def advance(
        self,
        dataset_version: str,
        dataset: str,
        cursor: Cursor,
        *,
        expected_cursor: Cursor | None,
        idempotency_key: str,
    ) -> Cursor:
        payload = (dataset_version, dataset, cursor, expected_cursor)
        if not self._idempotency.claim("checkpoint-advance", idempotency_key, payload):
            return cast(Cursor, self._idempotency.result("checkpoint-advance", idempotency_key))
        key = (dataset_version, dataset)
        current = self.checkpoints.get(key)
        if current != expected_cursor or (current is not None and cursor <= current):
            raise StaleCheckpoint("checkpoint changed or cursor is not monotonic")
        self.checkpoints[key] = tuple(cursor)
        result = tuple(cursor)
        self._idempotency.commit("checkpoint-advance", idempotency_key, payload, result)
        return result


class FakeLeaseRepository(LeaseRepository):
    def __init__(self, *, effects: list[str] | None = None) -> None:
        self.leases: dict[str, Lease] = {}
        self.acquisitions: list[Lease] = []
        self.releases: list[tuple[str, str]] = []
        self.effects = effects
        self._idempotency = _IdempotencyLedger()

    def acquire(
        self,
        source: str,
        owner: str,
        now: datetime,
        ttl_seconds: int,
        *,
        idempotency_key: str,
    ) -> Lease:
        expires_at = _lease_expiration(now, ttl_seconds)
        payload = (source, owner, now, ttl_seconds)
        if not self._idempotency.claim("lease-acquire", idempotency_key, payload):
            return cast(Lease, self._idempotency.result("lease-acquire", idempotency_key))
        current = self.leases.get(source)
        if current is not None and current.expires_at > now:
            raise LeaseBusy(f"source {source!r} already has a live lease")
        lease = Lease(source, owner, expires_at)
        self.leases[source] = lease
        self.acquisitions.append(lease)
        if self.effects is not None:
            self.effects.append("lease.acquire")
        self._idempotency.commit("lease-acquire", idempotency_key, payload, lease)
        return lease

    def renew(
        self,
        source: str,
        owner: str,
        now: datetime,
        ttl_seconds: int,
        *,
        expected_expires_at: datetime,
        idempotency_key: str,
    ) -> Lease:
        new_expires_at = _lease_expiration(now, ttl_seconds)
        payload = (source, owner, now, ttl_seconds, expected_expires_at)
        if not self._idempotency.claim("lease-renew", idempotency_key, payload):
            return cast(Lease, self._idempotency.result("lease-renew", idempotency_key))
        current = self.leases.get(source)
        if current is None or current.owner != owner:
            raise LeaseOwnershipError(f"owner {owner!r} does not hold source {source!r}")
        if current.expires_at != expected_expires_at or current.expires_at <= now:
            raise LeaseOwnershipError("lease expiration changed or lease expired")
        if new_expires_at <= current.expires_at:
            raise ConditionalWriteError("renewal must strictly extend lease expiration")
        lease = Lease(source, owner, new_expires_at)
        self.leases[source] = lease
        self._idempotency.commit("lease-renew", idempotency_key, payload, lease)
        return lease

    def release(self, source: str, owner: str, *, idempotency_key: str) -> None:
        payload = (source, owner)
        if not self._idempotency.claim("lease-release", idempotency_key, payload):
            return
        current = self.leases.get(source)
        if current is None or current.owner != owner:
            raise LeaseOwnershipError(f"owner {owner!r} does not hold source {source!r}")
        del self.leases[source]
        self.releases.append((source, owner))
        if self.effects is not None:
            self.effects.append("lease.release")
        self._idempotency.commit("lease-release", idempotency_key, payload)


class FakeRunRepository(RunRepository):
    def __init__(self) -> None:
        self.runs: dict[str, RunState] = {}
        self.errors: dict[str, tuple[tuple[int, str], ...]] = {}
        self.transitions: dict[str, tuple[tuple[RunState, RunTransitionMetadata], ...]] = {}
        self._idempotency = _IdempotencyLedger()

    def get_run_progress(self, run_id: str) -> RunProgress | None:
        state = self.runs.get(run_id)
        if state is None:
            return None
        transitions = self.transitions.get(run_id, ())
        return RunProgress(
            state,
            transitions[-1][1].transitioned_at if transitions else datetime.now(UTC),
            sum(metadata.records_read for _, metadata in transitions),
            sum(metadata.records_written for _, metadata in transitions),
            sum(metadata.records_rejected for _, metadata in transitions),
        )

    def get_run(self, run_id: str) -> RunState | None:
        return self.runs.get(run_id)

    def create(self, state: RunState, *, idempotency_key: str) -> RunState:
        if state.stage is not RunStage.STARTING:
            raise ValueError("a new run must start at STARTING")
        if not self._idempotency.claim("run-create", idempotency_key, state):
            return cast(RunState, self._idempotency.result("run-create", idempotency_key))
        if state.run_id in self.runs:
            raise ConditionalWriteError(f"run {state.run_id!r} already exists")
        self.runs[state.run_id] = state
        self.errors[state.run_id] = ()
        self.transitions[state.run_id] = ()
        self._idempotency.commit("run-create", idempotency_key, state, state)
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
        audit = metadata
        if metadata is not None and metadata.error is not None:
            audit = replace(
                metadata,
                error=PersistedError.from_untrusted(metadata.error).message,
            )
        payload = (run_id, target, expected_stage, audit, mark_candidate_active)
        if not self._idempotency.claim("run-transition", idempotency_key, payload):
            return cast(RunState, self._idempotency.result("run-transition", idempotency_key))
        current = self.runs[run_id]
        if current.stage is not expected_stage:
            raise ConditionalWriteError("run stage differs from expected_stage")
        changed = current.transition(target, mark_candidate_active=mark_candidate_active)
        self.runs[run_id] = changed
        persisted_audit = audit or RunTransitionMetadata(datetime.now(UTC))
        self.transitions[run_id] += ((changed, persisted_audit),)
        self._idempotency.commit("run-transition", idempotency_key, payload, changed)
        return changed

    def append_error(
        self,
        run_id: str,
        sequence: int,
        message: str,
        *,
        expected_stage: RunStage,
        idempotency_key: str,
    ) -> None:
        persisted_message = PersistedError.from_untrusted(message).message
        payload = (run_id, sequence, persisted_message, expected_stage)
        if not self._idempotency.claim("run-append-error", idempotency_key, payload):
            return
        current = self.runs[run_id]
        if current.stage is not expected_stage:
            raise ConditionalWriteError("run stage differs from expected_stage")
        errors = self.errors[run_id]
        if sequence <= 0 or any(existing == sequence for existing, _ in errors):
            raise ConditionalWriteError("error sequence must be new and positive")
        self.errors[run_id] = errors + ((sequence, persisted_message),)
        self._idempotency.commit("run-append-error", idempotency_key, payload)


class FakeManifestRepository(ManifestRepository):
    def __init__(
        self,
        active: CandidateManifest | None = None,
        *,
        backend: FakeIngestionBackend | None = None,
    ) -> None:
        self.active = active
        self.backend = backend or FakeIngestionBackend()
        if active is not None:
            self.backend.active_projection_fences.add(active.dataset_version)
        self.candidates: dict[str, CandidateManifest] = {}
        self._idempotency = _IdempotencyLedger()

    def get_active(self) -> CandidateManifest | None:
        return self.active

    def get_candidate(self, dataset_version: str) -> CandidateManifest | None:
        return self.candidates.get(dataset_version)

    def put_candidate(
        self,
        manifest: CandidateManifest,
        *,
        expected_absent: bool,
        idempotency_key: str,
    ) -> None:
        validate_candidate_manifest(manifest)
        payload = (manifest, expected_absent)
        if not self._idempotency.claim("manifest-put", idempotency_key, payload):
            return
        exists = manifest.dataset_version in self.candidates
        if expected_absent and exists:
            raise ConditionalWriteError("candidate manifest already exists")
        self.candidates[manifest.dataset_version] = manifest
        self._idempotency.commit("manifest-put", idempotency_key, payload)

    def activate(
        self,
        expected_active: str | None,
        candidate: CandidateManifest,
        *,
        idempotency_key: str,
    ) -> CandidateManifest:
        payload = (expected_active, candidate)
        if not self._idempotency.claim("manifest-activate", idempotency_key, payload):
            return cast(
                CandidateManifest,
                self._idempotency.result("manifest-activate", idempotency_key),
            )
        actual = self.active.dataset_version if self.active is not None else None
        if actual != expected_active:
            raise ConcurrentActivationError(
                f"active manifest is {actual!r}, expected {expected_active!r}"
            )
        stored = self.candidates.get(candidate.dataset_version)
        if stored is None:
            raise ConditionalWriteError("candidate manifest is missing")
        if stored != candidate:
            raise ConditionalWriteError("candidate differs from the stored manifest")
        if not manifest_is_ready_for_activation(candidate):
            raise ConditionalWriteError("candidate manifest validation is incomplete")
        self.active = candidate
        self.backend.active_projection_fences.add(candidate.dataset_version)
        self._idempotency.commit("manifest-activate", idempotency_key, payload, candidate)
        return candidate


def valid_active_manifest(
    dataset_names: Iterable[str],
    dataset_version: str,
    *,
    source_watermark: datetime,
    physical_contract_version: str = "2.0",
    canonical_schema_version: str = "1.0",
    dump_checksum_sha256: str = "a" * 64,
    snapshot_extracted_on: str = "2026-09-01",
    empty_interval_datasets: Iterable[str] = (),
    pipeline: RunPipeline = RunPipeline.LEGACY_V1,
) -> CandidateManifest:
    """Build a complete ACTIVE fixture that passes the real manifest contract."""
    names = tuple(dataset_names)
    empty_intervals = frozenset(empty_interval_datasets)
    if not empty_intervals <= set(names):
        raise ValueError("empty_interval_datasets must be manifest datasets")
    timestamp = "2026-09-01T00:00:00Z"
    interval = ({"start": timestamp, "end": "2026-10-01T00:00:00Z"},)
    watermark = source_watermark.isoformat(timespec="seconds").replace("+00:00", "Z")
    metadata: dict[str, object] = {
        "physicalContractVersion": physical_contract_version,
        "canonicalSchemaVersion": canonical_schema_version,
        "dumpChecksumSha256": dump_checksum_sha256,
        "snapshotExtractedOn": snapshot_extracted_on,
        "availableIntervals": {name: () if name in empty_intervals else interval for name in names},
        "hotFrom": {name: None if name in empty_intervals else timestamp for name in names},
        "watermarks": {name: None if name in empty_intervals else watermark for name in names},
        "s3Prefix": f"s3://argus-canonical/{dataset_version}/",
        "glueTables": {name: name for name in names},
        "descriptorVersions": {name: "2.0" for name in names},
        "formulaVersions": {
            "geography": "1.0",
            "incidents": "1.0",
            "monitoring": "1.0",
            "overview": "1.0",
        },
        "projectionVersions": {
            "geography": "1.0",
            "incidents": "1.0",
            "monitoring": "1.0",
            "overview": "1.0",
        },
        "coverage": {
            name: "UNAVAILABLE" if name in empty_intervals else "COMPLETE" for name in names
        },
        "qualityFlags": {name: () for name in names},
        "validations": {
            "physicalSchemas": {
                "state": "PASSED",
                "validatedAt": timestamp,
                "datasets": {name: {"fingerprint": "b" * 64, "compatible": True} for name in names},
            },
            "reconciliation": {
                "state": "PASSED",
                "validatedAt": timestamp,
                "datasets": {
                    name: {"accepted": 0, "rejected": 0, "persisted": 0} for name in names
                },
            },
            "parquetCatalog": {
                "state": "PASSED",
                "validatedAt": timestamp,
                "datasets": {
                    name: {"partitionCount": 0, "catalogValidated": True} for name in names
                },
            },
            "requiredProjections": {
                "state": "PASSED",
                "validatedAt": timestamp,
                "projections": ("geography", "incidents", "monitoring", "overview"),
            },
            "coverageQuality": {
                "state": "PASSED",
                "validatedAt": timestamp,
                "datasets": {
                    name: {
                        "coverage": "UNAVAILABLE" if name in empty_intervals else "COMPLETE",
                        "qualityFlags": (),
                    }
                    for name in names
                },
            },
        },
    }
    if pipeline is RunPipeline.CANONICAL_V2:
        metadata["hotMaterialization"] = "SKIPPED"
        metadata["hotItemCount"] = 0
        parquet = cast(dict[str, object], metadata["validations"])["parquetCatalog"]
        parquet_datasets = cast(dict[str, object], cast(dict[str, object], parquet)["datasets"])
        for name in names:
            parquet_datasets[name] = {
                "partitionCount": 0,
                "catalogValidated": True,
                "projectionItemCount": 0,
                "projectionDigest": "c" * 64,
            }
        metadata["canonicalMarker"] = {
            "schemaVersion": canonical_schema_version,
            "objectKey": (
                f"canonical/schema_version=1.0/dataset_version={dataset_version}/manifest.json"
            ),
            "aggregateDigest": "d" * 64,
            "documentSha256": "e" * 64,
            "datasetCount": len(names),
            "partitionCount": 0,
            "objectCount": 0,
            "totalSourceRows": 0,
            "totalAcceptedRows": 0,
            "totalRejectedRows": 0,
        }
    return CandidateManifest(dataset_version, metadata)


class FakeProjectionRepository(ProjectionRepository):
    def __init__(
        self,
        inputs: Mapping[tuple[str, str], tuple[CanonicalRecord, ...]] | None = None,
        backend: FakeIngestionBackend | None = None,
    ) -> None:
        self.backend = backend or FakeIngestionBackend()
        self.backend.projection_inputs.update(
            {key: tuple(records) for key, records in (inputs or {}).items()}
        )
        self.inputs = self.backend.projection_inputs
        self.projections = self.backend.projections

    def get_current(
        self, dataset_version: str, key: str, operational_sort_key: str
    ) -> CurrentProjection | None:
        identity_partition = "CURRENT" if key == "INCIDENTS#ACTIVE" else "CURRENT"
        projection = self.backend.projection_operational.get(
            (dataset_version, identity_partition, key, operational_sort_key)
        )
        if projection is None:
            return None
        return CurrentProjection(
            projection.payload,
            projection.materialization_revision,
            projection.required_archives,
        )

    def put_event_items(self, items: tuple[EventProjectionItem, ...]) -> None:
        if not items:
            raise ValueError("event projection batch must not be empty")
        versions = {item.dataset_version for item in items}
        if len(versions) != 1:
            raise ValueError("event projection batch must contain one dataset version")
        version = next(iter(versions))
        if version in self.backend.active_projection_fences:
            raise ConditionalWriteError("event projection dataset version is active")
        for item in items:
            key = (item.pk, item.sk)
            current = self.backend.event_projection_items.get(key)
            if (
                current is not None
                and current.materialization_revision != item.materialization_revision
            ):
                raise ConditionalWriteError("event projection identity has divergent content")
        for item in items:
            self.backend.event_projection_items[(item.pk, item.sk)] = item

    def put(
        self,
        projection: Projection,
        *,
        expected_projection_version: str | None,
        idempotency_key: str,
        expected_materialization_revision: str | None = None,
    ) -> None:
        if projection.dataset_version in self.backend.active_projection_fences:
            raise ConditionalWriteError("projection dataset version is active")
        if expected_projection_version is not None and expected_projection_version.startswith(
            "pmr_"
        ):
            raise ValueError("expected_projection_version must be a projection contract version")
        if expected_materialization_revision is not None and (
            len(expected_materialization_revision) != 68
            or not expected_materialization_revision.startswith("pmr_")
            or any(
                character not in "0123456789abcdef"
                for character in expected_materialization_revision.removeprefix("pmr_")
            )
        ):
            raise ValueError("expected_materialization_revision must be a materialization revision")
        payload = (projection, expected_projection_version, expected_materialization_revision)
        existing_marker = self.backend.projection_idempotency.get(idempotency_key)
        if existing_marker is not None:
            if existing_marker[0] != payload:
                raise IdempotencyConflict("idempotency key was reused with different input")
            return
        identity_partition = (
            "CURRENT" if projection.key == "INCIDENTS#ACTIVE" else projection.partition_key
        )
        logical_key = (projection.dataset_version, identity_partition, projection.key)
        revision = projection.materialization_revision
        target_key = (*logical_key, projection.operational_sort_key)
        current_revision = self.backend.projection_heads.get(target_key)
        if current_revision == revision:
            self.backend.projection_idempotency[idempotency_key] = (payload, revision)
            return
        if current_revision is None:
            if (
                expected_projection_version is not None
                or expected_materialization_revision is not None
            ):
                raise ConditionalWriteError("projection target is absent")
        elif expected_projection_version != projection.projection_version:
            raise ConditionalWriteError("projection contract differs from expected version")
        elif (
            expected_materialization_revision is not None
            and current_revision != expected_materialization_revision
        ):
            raise ConditionalWriteError("projection materialization differs from expected revision")
        dependencies = tuple(
            (projection.dataset_version, dependency.dataset, dependency.partition)
            for dependency in projection.required_archives
        )
        revision_key = (*logical_key, revision)
        catalog_revision_key = (*logical_key, f"REVISION#{revision}")
        previous_dependencies = self.backend.projection_dependencies.get(target_key, ())
        dependency_union = (
            set(dependencies)
            if projection.key == "INCIDENTS#ACTIVE"
            else set(previous_dependencies) | set(dependencies)
        )
        if len(dependency_union) > 47:
            raise ValueError("previous and new required archives exceed 47 physical dependencies")
        if any(dependency in self.backend.retention_seals for dependency in dependency_union):
            raise ConditionalWriteError("projection catalog generation is already sealed")
        self.projections[revision_key] = projection
        self.backend.projection_operational[target_key] = projection
        self.backend.projection_heads[target_key] = revision
        self.backend.projection_dependencies[target_key] = dependencies
        self.backend.projection_dependencies[catalog_revision_key] = dependencies
        if projection.key != "INCIDENTS#ACTIVE":
            for catalog_key in previous_dependencies:
                self.backend.projection_catalog.setdefault(catalog_key, set()).discard(target_key)
            for catalog_key in dependencies:
                self.backend.projection_catalog.setdefault(catalog_key, set()).update(
                    {target_key, catalog_revision_key}
                )
        for catalog_key in dependency_union:
            _refresh_fake_catalog_summary(self.backend, catalog_key)
        self.backend.projection_idempotency[idempotency_key] = (payload, revision)

    def query_inputs(
        self, dataset_version: str, partition_keys: tuple[str, ...]
    ) -> tuple[CanonicalRecord, ...]:
        return tuple(
            record
            for batch in self.iter_input_batches(dataset_version, partition_keys)
            for record in batch
        )

    def iter_input_batches(self, dataset_version: str, partition_keys: tuple[str, ...]):  # type: ignore[no-untyped-def]
        for partition_key in partition_keys:
            configured = self.inputs.get((dataset_version, partition_key), ())
            if configured:
                yield configured
                continue
            matched = re.fullmatch(
                rf"DATASET#{re.escape(dataset_version)}#(?:FACT#TS|INCIDENT#TS|CONTEXT#TS|"
                rf"INGESTION#SOURCE)#(?P<dataset>[^#\s]+)#(?P<day>[0-9]{{8}})",
                partition_key,
            )
            if matched is None:
                continue
            day = datetime.strptime(matched.group("day"), "%Y%m%d").date()
            records = tuple(
                self.backend.fact_records[fact_key]
                for (version, dataset, partition), fact_keys in self.backend.fact_catalog.items()
                if version == dataset_version
                and dataset == matched.group("dataset")
                and partition_date(partition) == day
                for fact_key in sorted(fact_keys)
            )
            if records:
                yield records


class FakeParquetEncoder(ParquetEncoder):
    def __init__(self) -> None:
        self.partitions: dict[Path, EncodedPartition] = {}
        self._idempotency_condition = threading.Condition()
        self._idempotency: dict[str, tuple[str, EncodedPartition | None]] = {}

    def _claim_or_replay(self, key: str, fingerprint: str) -> EncodedPartition | None:
        with self._idempotency_condition:
            while True:
                prior = self._idempotency.get(key)
                if prior is None:
                    self._idempotency[key] = (fingerprint, None)
                    return None
                if prior[0] != fingerprint:
                    raise IdempotencyConflict("idempotency key was reused with different input")
                if prior[1] is not None:
                    if self.partitions.get(prior[1].path) != prior[1]:
                        raise ArchiveRecordValidationError(
                            "idempotent result does not match its encoded result"
                        )
                    return prior[1]
                self._idempotency_condition.wait()

    def _complete(self, key: str, fingerprint: str, result: EncodedPartition) -> None:
        with self._idempotency_condition:
            self._idempotency[key] = (fingerprint, result)
            self._idempotency_condition.notify_all()

    def _abandon(self, key: str, fingerprint: str) -> None:
        with self._idempotency_condition:
            if self._idempotency.get(key) == (fingerprint, None):
                del self._idempotency[key]
                self._idempotency_condition.notify_all()

    def write_partition(
        self,
        records: Iterable[CanonicalRecord],
        descriptor: DatasetDescriptor,
        path: Path,
        *,
        dataset_version: str,
        expected_absent: bool,
        idempotency_key: str,
        disk_budget: DiskBudget | None = None,
    ) -> EncodedPartition:
        if not isinstance(dataset_version, str) or not dataset_version:
            raise ValueError("dataset_version must be a non-empty string")
        if not isinstance(path, Path):
            raise TypeError("path must be a Path")
        if type(expected_absent) is not bool:
            raise TypeError("expected_absent must be a bool")
        if not isinstance(idempotency_key, str) or not idempotency_key:
            raise ValueError("idempotency_key must be a non-empty string")
        if disk_budget is not None:
            disk_budget.preflight("fake Parquet partition encoding")
        indexed: dict[str, CanonicalRecord] = {}
        for record in records:
            validate_archive_record(record, descriptor)
            identifier = record_id(record)
            if identifier in indexed:
                raise ValueError(f"duplicate recordId {identifier}")
            indexed[identifier] = record
        materialized = tuple(
            sorted(
                indexed.values(),
                key=lambda record: (canonical_bytes(record.natural_key), record_id(record)),
            )
        )
        record_evidence = [
            {"recordId": record_id(record), "payloadHash": payload_hash(record)}
            for record in materialized
        ]
        payload = hashlib.sha256(
            canonical_bytes(
                {
                    "path": str(path),
                    "dataset": descriptor.table,
                    "datasetVersion": dataset_version,
                    "expectedAbsent": expected_absent,
                    "records": record_evidence,
                }
            )
        ).hexdigest()
        replay = self._claim_or_replay(idempotency_key, payload)
        if replay is not None:
            return replay
        try:
            with self._idempotency_condition:
                if expected_absent and path in self.partitions:
                    raise ConditionalWriteError(f"partition path {path} already exists")
                digest = hashlib.sha256(
                    canonical_bytes(
                        {
                            "dataset": descriptor.table,
                            "datasetVersion": dataset_version,
                            "records": record_evidence,
                        }
                    )
                ).hexdigest()
                from adapters.archive.parquet import schema_fingerprint_for_descriptor

                result = EncodedPartition(
                    path,
                    len(materialized),
                    len(repr(materialized).encode()),
                    digest,
                    dataset=descriptor.table,
                    dataset_version=dataset_version,
                    schema_version="1.0",
                    schema_fingerprint=schema_fingerprint_for_descriptor(descriptor),
                )
                self.partitions[path] = result
            self._complete(idempotency_key, payload, result)
            return result
        except BaseException:
            self._abandon(idempotency_key, payload)
            raise


class FakeArchiveObjectStore(ArchiveObjectStore):
    def __init__(self) -> None:
        self.objects: dict[str, ArchiveObject] = {}
        self._idempotency = _IdempotencyLedger()

    def stage(
        self,
        partition: EncodedPartition,
        key: str,
        *,
        expected_absent: bool,
        idempotency_key: str,
    ) -> ArchiveObject:
        payload = (
            partition.row_count,
            partition.byte_size,
            partition.sha256,
            partition.dataset,
            partition.dataset_version,
            partition.schema_version,
            partition.schema_fingerprint,
            key,
            expected_absent,
        )
        if not self._idempotency.claim("archive-stage", idempotency_key, payload):
            return cast(ArchiveObject, self._idempotency.result("archive-stage", idempotency_key))
        result = ArchiveObject(key, partition.sha256, partition.byte_size)
        existing = self.objects.get(key)
        if expected_absent and existing is not None:
            if existing != result:
                raise ConditionalWriteError(f"archive object {key!r} is immutable")
            self._idempotency.commit("archive-stage", idempotency_key, payload, existing)
            return existing
        self.objects[key] = result
        self._idempotency.commit("archive-stage", idempotency_key, payload, result)
        return result

    def promote(
        self,
        staged: ArchiveObject,
        canonical_key: str,
        *,
        expected_absent: bool,
        idempotency_key: str,
    ) -> ArchiveObject:
        payload = (staged, canonical_key, expected_absent)
        if not self._idempotency.claim("archive-promote", idempotency_key, payload):
            return cast(
                ArchiveObject,
                self._idempotency.result("archive-promote", idempotency_key),
            )
        if expected_absent is not True:
            raise ConditionalWriteError("promote requires expected_absent=True")
        if self.objects.get(staged.key) != staged:
            raise ConditionalWriteError("staged archive object is missing or changed")
        result = ArchiveObject(canonical_key, staged.sha256, staged.size)
        existing = self.objects.get(canonical_key)
        if existing is not None:
            if existing != result:
                raise ConditionalWriteError(
                    f"canonical archive object {canonical_key!r} is immutable"
                )
            self._idempotency.commit("archive-promote", idempotency_key, payload, existing)
            return existing
        self.objects[canonical_key] = result
        self._idempotency.commit("archive-promote", idempotency_key, payload, result)
        return result

    def head(self, key: str) -> ArchiveObject | None:
        return self.objects.get(key)


class FakeGlueCatalog(GlueCatalog):
    def __init__(self) -> None:
        self.tables: dict[str, str] = {}
        self.partitions: dict[tuple[str, str, str], str] = {}
        self._idempotency = _IdempotencyLedger()

    def ensure_table(
        self, descriptor: DatasetDescriptor, location: str, *, idempotency_key: str
    ) -> None:
        payload = (descriptor, location)
        if not self._idempotency.claim("glue-table", idempotency_key, payload):
            return
        current = self.tables.get(descriptor.table)
        if current is not None and current != location:
            raise ConditionalWriteError("Glue table location differs from requested location")
        self.tables[descriptor.table] = location
        self._idempotency.commit("glue-table", idempotency_key, payload)

    def register_partition(
        self,
        descriptor: DatasetDescriptor,
        dataset_version: str,
        partition: str,
        location: str,
        *,
        aggregate_digest: str,
        expected_absent: bool,
        idempotency_key: str,
    ) -> None:
        if re.fullmatch(r"[0-9a-f]{64}", aggregate_digest) is None:
            raise ValueError("aggregate_digest must be a lowercase SHA-256 digest")
        if not location.endswith(f"/generation={aggregate_digest}/"):
            raise ValueError("Glue partition location must use the committed generation")
        payload = (
            descriptor,
            dataset_version,
            partition,
            location,
            aggregate_digest,
            expected_absent,
        )
        self._register_partition(
            descriptor,
            dataset_version,
            partition,
            location,
            expected_absent=expected_absent,
            idempotency_key=idempotency_key,
            payload=payload,
        )

    def register_legacy_partition(
        self,
        descriptor: DatasetDescriptor,
        dataset_version: str,
        partition: str,
        location: str,
        *,
        expected_absent: bool,
        idempotency_key: str,
    ) -> None:
        if "/generation=" in location:
            raise ValueError("legacy Glue partition location cannot include a generation")
        payload = (descriptor, dataset_version, partition, location, expected_absent)
        self._register_partition(
            descriptor,
            dataset_version,
            partition,
            location,
            expected_absent=expected_absent,
            idempotency_key=idempotency_key,
            payload=payload,
        )

    def _register_partition(
        self,
        descriptor: DatasetDescriptor,
        dataset_version: str,
        partition: str,
        location: str,
        *,
        expected_absent: bool,
        idempotency_key: str,
        payload: tuple[object, ...],
    ) -> None:
        if not self._idempotency.claim("glue-partition", idempotency_key, payload):
            return
        key = (descriptor.table, dataset_version, partition)
        existing = self.partitions.get(key)
        if expected_absent and existing is not None:
            if existing != location:
                raise ConditionalWriteError("Glue partition location differs")
            self._idempotency.commit("glue-partition", idempotency_key, payload)
            return
        self.partitions[key] = location
        self._idempotency.commit("glue-partition", idempotency_key, payload)


class FakeAthenaValidator(AthenaValidator):
    def __init__(self, counts: Mapping[tuple[str, str, str], int]) -> None:
        self.counts = dict(counts)

    def validate_partition(
        self,
        table: str,
        dataset_version: str,
        partition: str,
        expected_row_count: int,
        *,
        aggregate_digest: str,
    ) -> int:
        if re.fullmatch(r"[0-9a-f]{64}", aggregate_digest) is None:
            raise ValueError("aggregate_digest must be a lowercase SHA-256 digest")
        return self._validate_count(table, dataset_version, partition, expected_row_count)

    def validate_legacy_partition(
        self, table: str, dataset_version: str, partition: str, expected_row_count: int
    ) -> int:
        return self._validate_count(table, dataset_version, partition, expected_row_count)

    def _validate_count(
        self, table: str, dataset_version: str, partition: str, expected_row_count: int
    ) -> int:
        actual = self.counts[(table, dataset_version, partition)]
        if actual != expected_row_count:
            raise ArchiveReconciliationError(
                f"Athena returned {actual} rows; expected {expected_row_count}"
            )
        return actual


class FakeArchivePartitionRepository(ArchivePartitionRepository):
    def __init__(self, backend: FakeIngestionBackend | None = None) -> None:
        self.backend = backend or FakeIngestionBackend()
        self.partitions = self.backend.archive_partitions
        self._idempotency = _IdempotencyLedger()

    def put(
        self,
        partition: ArchivePartition,
        *,
        expected_absent: bool,
        idempotency_key: str,
    ) -> None:
        validate_new_archive_partition(partition)
        payload = (partition, expected_absent)
        if not self._idempotency.claim("archive-partition-put", idempotency_key, payload):
            return
        if expected_absent is not True:
            raise ConditionalWriteError("archive partition creation requires expected_absent=True")
        key = (partition.dataset_version, partition.dataset, partition.partition)
        if key in self.partitions:
            raise ConditionalWriteError("archive partition already exists")
        self.partitions[key] = partition
        self._idempotency.commit("archive-partition-put", idempotency_key, payload)

    def get(
        self,
        dataset_version: str,
        dataset: str,
        partition: str,
    ) -> ArchivePartition | None:
        return self.partitions.get((dataset_version, dataset, partition))

    def query(self, dataset_version: str, dataset: str) -> tuple[ArchivePartition, ...]:
        return tuple(
            partition
            for key, partition in sorted(self.partitions.items())
            if key[:2] == (dataset_version, dataset)
        )

    def update_state(
        self,
        dataset_version: str,
        dataset: str,
        partition: str,
        state: ArchiveState,
        *,
        expected_state: ArchiveState,
        idempotency_key: str,
    ) -> ArchivePartition:
        payload = (dataset_version, dataset, partition, state, expected_state)
        validate_archive_transition(expected_state, state)
        if not self._idempotency.claim("archive-partition-state", idempotency_key, payload):
            return cast(
                ArchivePartition,
                self._idempotency.result("archive-partition-state", idempotency_key),
            )
        key = (dataset_version, dataset, partition)
        current = self.partitions[key]
        if current.state != expected_state:
            raise ConditionalWriteError("archive partition state differs from expected_state")
        changed = replace(current, state=state)
        validate_archive_partition(changed)
        self.partitions[key] = changed
        self._idempotency.commit("archive-partition-state", idempotency_key, payload, changed)
        return changed

    def record_reconciliation(
        self,
        dataset_version: str,
        dataset: str,
        partition: str,
        *,
        observed_counts: ReconciliationCounts,
        reconciled_at: datetime,
        expected_state: ArchiveState,
        idempotency_key: str,
    ) -> ArchivePartition:
        if set(observed_counts) != {"accepted", "rejected", "persisted"} or any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0
            for value in observed_counts.values()
        ):
            raise ValueError("observed_counts must contain non-negative integer counts")
        if (
            type(reconciled_at) is not datetime
            or reconciled_at.tzinfo is None
            or reconciled_at.utcoffset() != timedelta(0)
        ):
            raise ValueError("reconciled_at must be an aware UTC datetime")
        payload = (
            dataset_version,
            dataset,
            partition,
            dict(observed_counts),
            reconciled_at,
            expected_state,
        )
        if not self._idempotency.claim("archive-partition-reconcile", idempotency_key, payload):
            return cast(
                ArchivePartition,
                self._idempotency.result("archive-partition-reconcile", idempotency_key),
            )
        key = (dataset_version, dataset, partition)
        current = self.partitions[key]
        if expected_state is not ArchiveState.VALIDATED or current.state is not expected_state:
            raise ConditionalWriteError("reconciliation requires expected_state VALIDATED")
        expected = current.metadata.get("counts")
        if not isinstance(expected, Mapping) or dict(expected) != dict(observed_counts):
            raise ConditionalWriteError("observed reconciliation counts differ from archive counts")
        generation = current.metadata.get("catalogGeneration")
        if isinstance(generation, bool) or not isinstance(generation, int) or generation <= 0:
            raise ConditionalWriteError("archive catalog generation is invalid")
        canonical_v2 = "aggregateDigest" in current.metadata
        if canonical_v2:
            digest = current.metadata.get("aggregateDigest")
            if not isinstance(digest, str):
                raise ConditionalWriteError("canonical aggregate digest is invalid")
        else:
            fact_count = len(self.backend.fact_catalog.get(key, set()))
            projection_count = len(self.backend.projection_catalog.get(key, set()))
            if fact_count != current.metadata.get(
                "hotItemCount"
            ) or projection_count != current.metadata.get("projectionItemCount"):
                raise ConditionalWriteError("hot catalog target count differs from archive catalog")
            digest = _fake_catalog_digest(self.backend, key, generation)
            summary = self.backend.catalog_summaries.get(key)
            expected_summary = (generation, fact_count, projection_count, digest)
            if summary is None and fact_count == projection_count == 0:
                self.backend.catalog_summaries[key] = expected_summary
            elif summary != expected_summary:
                raise ConditionalWriteError("hot catalog summary differs from persisted targets")
            if key in self.backend.retention_seals:
                raise ConditionalWriteError("archive catalog generation is already sealed")
        metadata = dict(current.metadata)
        metadata["reconciliation"] = {
            "state": "PASSED",
            "expected": dict(expected),
            "observed": dict(observed_counts),
            "reconciledAt": reconciled_at.astimezone(UTC).isoformat().replace("+00:00", "Z"),
        }
        metadata["expirationEligible"] = True
        metadata["catalogDigest"] = digest
        changed = replace(current, metadata=metadata)
        validate_archive_partition(changed)
        self.partitions[key] = changed
        if not canonical_v2:
            self.backend.retention_seals[key] = (generation, digest)
        self._idempotency.commit("archive-partition-reconcile", idempotency_key, payload, changed)
        return changed


class FakeWindowCommitRepository(WindowCommitRepository):
    def __init__(
        self,
        backend: FakeIngestionBackend | None = None,
        *,
        effects: list[str] | None = None,
    ) -> None:
        self.backend = backend or FakeIngestionBackend()
        self.watermarks = self.backend.watermarks
        self.outboxes = self.backend.outboxes
        self.effects = effects
        self._idempotency = _IdempotencyLedger()

    def get_watermark(self, dataset_version: str, source: str) -> datetime | None:
        return self.watermarks.get((dataset_version, source))

    def get_bucket_evidence(
        self, dataset_version: str, source: str
    ) -> tuple[tuple[str, int, int, int], ...]:
        return self.backend.bucket_evidence.get((dataset_version, source), ())

    def get_outbox_event(self, event_id: str) -> OutboxEvent | None:
        return self.outboxes.get(event_id)

    def commit_watermark_and_outboxes(
        self,
        dataset_version: str,
        source: str,
        watermark: datetime,
        events: tuple[OutboxEvent, ...],
        *,
        expected_watermark: datetime | None,
        idempotency_key: str,
        bucket_evidence: tuple[tuple[str, int, int, int], ...] = (),
    ) -> None:
        if isinstance(events, tuple) and any(
            not isinstance(event, OutboxEvent) for event in events
        ):
            raise TypeError("events must contain only OutboxEvent values")
        validate_window_commit_contract(
            dataset_version,
            source,
            watermark,
            events,
            expected_watermark,
        )
        assert isinstance(events, tuple)
        for event in events:
            pending_analysis_outbox_item(event)
        payload = (dataset_version, source, watermark, events, expected_watermark, bucket_evidence)
        if not self._idempotency.claim("window-commit", idempotency_key, payload):
            return
        key = (dataset_version, source)
        current = self.watermarks.get(key)
        if current != expected_watermark:
            raise ConditionalWriteError("watermark differs from expected_watermark")
        if current is not None and watermark <= current:
            raise ConditionalWriteError("watermark must move forward")
        if any(item.dataset_version != dataset_version for item in events):
            raise ConditionalWriteError("outbox event belongs to another dataset version")
        if len({item.event_id for item in events}) != len(events):
            raise ConditionalWriteError("window contains duplicate outbox event ids")
        if len({item.event_type for item in events}) != len(events):
            raise ConditionalWriteError("window contains duplicate outbox event types")
        if any(item.event_id in self.outboxes for item in events):
            raise ConditionalWriteError("outbox event already exists")
        self.watermarks[key] = watermark
        if self.effects is not None:
            self.effects.append("watermark.commit")
        self.backend.bucket_evidence[key] = tuple(bucket_evidence)
        self.outboxes.update({item.event_id: item for item in events})
        self.backend.outbox_states.update({item.event_id: "PENDING" for item in events})
        self._idempotency.commit("window-commit", idempotency_key, payload)


class FakeOutboxRepository(OutboxRepository):
    def __init__(
        self,
        events: Mapping[str, OutboxEvent] | None = None,
        backend: FakeIngestionBackend | None = None,
    ) -> None:
        self.backend = backend or FakeIngestionBackend()
        if events:
            self.backend.outboxes.update(events)
            self.backend.outbox_states.update({event_id: "PENDING" for event_id in events})
        self.events = self.backend.outboxes
        self.states = self.backend.outbox_states
        self.message_ids = self.backend.outbox_message_ids
        self._idempotency = _IdempotencyLedger()

    def list_pending(self, limit: int) -> tuple[OutboxEvent, ...]:
        if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
            raise ValueError("limit must be a positive integer")
        pending = [
            item for event_id, item in self.events.items() if self.states[event_id] == "PENDING"
        ]
        ordered = sorted(
            pending,
            key=lambda item: (item.created_at, item.event_type, item.event_id),
        )
        return tuple(ordered[:limit])

    def mark_published(
        self,
        event_id: str,
        message_id: str,
        *,
        expected_state: str,
        idempotency_key: str,
    ) -> None:
        if expected_state != "PENDING":
            raise ValueError("expected_state must be PENDING")
        payload = (event_id, message_id, expected_state)
        if not self._idempotency.claim("outbox-published", idempotency_key, payload):
            return
        if self.states.get(event_id) != expected_state:
            raise ConditionalWriteError("outbox state differs from expected_state")
        self.states[event_id] = "PUBLISHED"
        self.message_ids[event_id] = message_id
        self._idempotency.commit("outbox-published", idempotency_key, payload)


class FakeAnalysisRequestPublisher(AnalysisRequestPublisher):
    def __init__(self, failures: tuple[Exception, ...] = ()) -> None:
        self.published: tuple[OutboxEvent, ...] = ()
        self._failures = list(failures)

    def publish(self, event: OutboxEvent, *, idempotency_key: str) -> PublishReceipt:
        if not isinstance(event, OutboxEvent):
            raise TypeError("event must be an OutboxEvent")
        validate_publish_request(event, idempotency_key)
        if self._failures:
            raise self._failures.pop(0)
        receipt = PublishReceipt(f"message-{len(self.published) + 1}")
        self.published += (event,)
        return receipt


class FakeLogger(Logger):
    def __init__(
        self,
        context: Mapping[str, object] | None = None,
        root: FakeLogger | None = None,
    ) -> None:
        self.context: Mapping[str, object] = MappingProxyType(dict(context or {}))
        self.records: tuple[tuple[str, str, Mapping[str, object]], ...] = ()
        self._root = root or self

    def bind(self, **context: object) -> Logger:
        merged = dict(self.context)
        merged.update(context)
        return FakeLogger(merged, self._root)

    def info(self, event: str, **fields: object) -> None:
        combined = dict(self.context)
        combined.update(fields)
        self._root.records += (("INFO", event, MappingProxyType(combined)),)

    def error(self, event: str, **fields: object) -> None:
        combined = dict(self.context)
        combined.update(fields)
        self._root.records += (("ERROR", event, MappingProxyType(combined)),)


class FakeMetricsPublisher(MetricsPublisher):
    def __init__(self) -> None:
        self.measurements: tuple[tuple[str, str, int | float, Mapping[str, str]], ...] = ()
        self.values: dict[str, int | float] = {}

    def increment(self, name: str, value: int, dimensions: Mapping[str, str]) -> None:
        self.measurements += (("increment", name, value, MappingProxyType(dict(dimensions))),)
        self.values[name] = self.values.get(name, 0) + value

    def gauge(self, name: str, value: float, dimensions: Mapping[str, str]) -> None:
        self.measurements += (("gauge", name, value, MappingProxyType(dict(dimensions))),)

    def timing(self, name: str, milliseconds: float, dimensions: Mapping[str, str]) -> None:
        self.measurements += (("timing", name, milliseconds, MappingProxyType(dict(dimensions))),)


__all__ = [
    "FakeAnalysisRequestPublisher",
    "FakeArchiveObjectStore",
    "FakeArchivePartitionRepository",
    "FakeAthenaValidator",
    "FakeCanonicalSetStore",
    "FakeCheckpointRepository",
    "FakeGlueCatalog",
    "FakeHotExpirationRepository",
    "FakeHotRecordSink",
    "FakeIngestionBackend",
    "FakeIncrementalBatchQueue",
    "FakeIncrementalBatchRepository",
    "FakeIncrementalBatchStore",
    "FakeIncrementalExportSource",
    "FakeLeaseRepository",
    "FakeLogger",
    "FakeManifestRepository",
    "FakeMetricsPublisher",
    "FakeOutboxRepository",
    "FakeParquetEncoder",
    "FakeProjectionRepository",
    "FakeRunRepository",
    "FakeSnapshotRestorer",
    "FakeSourceReader",
    "FakeWindowCommitRepository",
    "valid_active_manifest",
]
