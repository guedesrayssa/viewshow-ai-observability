"""Ingest immutable incremental S3 batches into the active ARGUS dataset."""

from __future__ import annotations

import logging
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from uuid import uuid4

from application.sync import Sync, SyncRequest
from contracts.registry import DatasetRegistry, UnknownDatasetError
from domain.datasets import DatasetDescriptor
from domain.incremental_batches import (
    BatchDelivery,
    BatchState,
    IncrementalBatchManifest,
    IncrementalBatchRecord,
)
from domain.models import TimeWindow
from domain.quality import CoverageStatus
from domain.run import RunStage
from ports import (
    CoverageObservation,
    Cursor,
    IdempotencyConflict,
    IncrementalBatchObjectStore,
    IncrementalBatchQueue,
    IncrementalBatchRepository,
    ManifestRepository,
    MetricsPublisher,
    SchemaObservation,
    SourcePage,
    SourceReader,
)

_SUPPORTED_PHYSICAL_TYPE = re.compile(
    r"^(?:BIGINT|INT|TINYINT|DOUBLE|VARCHAR\([1-9][0-9]*\)|TEXT|ENUM\(.*\))$"
)
_LOGGER = logging.getLogger(__name__)


def _log_failure(step: str, delivery: BatchDelivery, error: BaseException) -> None:
    """Registra a causa de uma falha engolida no processamento, sem alterar o fluxo."""
    _LOGGER.warning(
        "ingest-incremental %s failed batch_id=%s message_id=%s dataset=%s key=%s "
        "error_type=%s error=%s",
        step,
        delivery.batch_id,
        delivery.message_id,
        delivery.source_dataset,
        delivery.reference.key,
        type(error).__name__,
        error,
    )


class _PermanentBatchError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class IngestIncrementalResult:
    """Counts terminal and retryable outcomes from one bounded queue drain."""

    completed: int = 0
    retryable: int = 0
    quarantined: int = 0
    extra_columns: int = 0

    def __post_init__(self) -> None:
        for field in ("completed", "retryable", "quarantined", "extra_columns"):
            value = getattr(self, field)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{field} must be a non-negative integer")

    def __add__(self, other: IngestIncrementalResult) -> IngestIncrementalResult:
        if not isinstance(other, IngestIncrementalResult):
            return NotImplemented
        return IngestIncrementalResult(
            self.completed + other.completed,
            self.retryable + other.retryable,
            self.quarantined + other.quarantined,
            self.extra_columns + other.extra_columns,
        )


class S3IncrementalSourceReader(SourceReader):
    """Adapt one immutable Parquet manifest to the existing SourceReader port."""

    def __init__(
        self,
        store: IncrementalBatchObjectStore,
        manifest: IncrementalBatchManifest,
    ) -> None:
        if not isinstance(store, IncrementalBatchObjectStore):
            raise TypeError("store must implement IncrementalBatchObjectStore")
        if not isinstance(manifest, IncrementalBatchManifest):
            raise TypeError("manifest must be an IncrementalBatchManifest")
        self._store = store
        self._manifest = manifest

    def _differences(self, descriptor: DatasetDescriptor) -> tuple[str, ...]:
        if descriptor.table != self._manifest.source_dataset:
            return ("manifest dataset differs from descriptor",)
        observed: dict[str, tuple[str, bool]] = {}
        differences: list[str] = []
        for column in self._manifest.columns:
            if column.name in observed:
                differences.append(f"duplicate column {column.name}")
                continue
            observed[column.name] = (column.physical_type, column.nullable)
            if _SUPPORTED_PHYSICAL_TYPE.fullmatch(column.physical_type) is None:
                differences.append(f"unsupported physical type for {column.name}")
        expected = {
            column.name: (column.sql_type, column.nullable)
            for column in descriptor.columns
        }
        for name, contract in expected.items():
            actual = observed.get(name)
            if actual is None:
                differences.append(f"missing required column {name}")
            elif actual != contract:
                differences.append(f"type or nullability differs for {name}")
        extras = tuple(name for name in observed if name not in expected)
        if len(set(self._manifest.extra_columns)) != len(self._manifest.extra_columns):
            differences.append("manifest extra columns contain duplicates")
        if set(extras) != set(self._manifest.extra_columns):
            differences.append("manifest extra columns differ from observed schema")
        return tuple(differences)

    def validate_schema(self, descriptor: DatasetDescriptor) -> SchemaObservation:
        if not isinstance(descriptor, DatasetDescriptor):
            raise TypeError("descriptor must be a DatasetDescriptor")
        differences = self._differences(descriptor)
        return SchemaObservation(
            self._manifest.schema_fingerprint,
            not differences,
            differences,
        )

    def measure_coverage(self, descriptor: DatasetDescriptor) -> CoverageObservation:
        schema = self.validate_schema(descriptor)
        status = CoverageStatus.COMPLETE if schema.is_compatible else CoverageStatus.UNAVAILABLE
        return CoverageObservation(status, self._manifest.row_count, self._manifest.window)

    @staticmethod
    def _offset(after: Cursor | None) -> int | None:
        if after is None:
            return None
        if (
            len(after) != 1
            or isinstance(after[0], bool)
            or not isinstance(after[0], int)
            or after[0] < 0
        ):
            raise ValueError("incremental Parquet cursor must be one non-negative offset")
        return after[0]

    def read_page(
        self,
        descriptor: DatasetDescriptor,
        window: TimeWindow | None,
        after: Cursor | None,
        limit: int,
    ) -> SourcePage:
        schema = self.validate_schema(descriptor)
        if not schema.is_compatible:
            raise ValueError("incremental batch schema is incompatible")
        if window != self._manifest.window:
            raise ValueError("incremental reader window must equal the manifest window")
        offset = self._offset(after)
        raw = self._store.read_page(self._manifest, offset, limit)
        raw_names = {column.name for column in self._manifest.columns}
        canonical_names = tuple(column.name for column in descriptor.columns)
        rows: list[Mapping[str, object]] = []
        for row in raw.rows:
            if set(row) != raw_names:
                raise ValueError("raw row shape differs from the manifest schema")
            rows.append({name: row[name] for name in canonical_names})
        next_offset = raw.next_offset
        if raw.rows and next_offset is None:
            next_offset = (offset or 0) + len(raw.rows)
        next_cursor = (next_offset,) if next_offset is not None else None
        return SourcePage(tuple(rows), next_cursor)


type SyncFactory = Callable[[SourceReader], Sync]


class IngestIncremental:
    """Claim, validate, merge, finalize, and acknowledge bounded queue deliveries."""

    def __init__(
        self,
        *,
        registry: DatasetRegistry,
        manifests: ManifestRepository,
        store: IncrementalBatchObjectStore,
        queue: IncrementalBatchQueue,
        batches: IncrementalBatchRepository,
        sync_factory: SyncFactory,
        metrics: MetricsPublisher,
        page_size: int = 500,
    ) -> None:
        if not isinstance(registry, DatasetRegistry):
            raise TypeError("registry must be a DatasetRegistry")
        if not isinstance(manifests, ManifestRepository):
            raise TypeError("manifests must implement ManifestRepository")
        if not isinstance(store, IncrementalBatchObjectStore):
            raise TypeError("store must implement IncrementalBatchObjectStore")
        if not isinstance(queue, IncrementalBatchQueue):
            raise TypeError("queue must implement IncrementalBatchQueue")
        if not isinstance(batches, IncrementalBatchRepository):
            raise TypeError("batches must implement IncrementalBatchRepository")
        if not callable(sync_factory):
            raise TypeError("sync_factory must be callable")
        if not isinstance(metrics, MetricsPublisher):
            raise TypeError("metrics must implement MetricsPublisher")
        if isinstance(page_size, bool) or not isinstance(page_size, int) or page_size <= 0:
            raise ValueError("page_size must be a positive integer")
        self._registry = registry
        self._manifests = manifests
        self._store = store
        self._queue = queue
        self._batches = batches
        self._sync_factory = sync_factory
        self._metrics = metrics
        self._page_size = page_size

    def _validate_identity(
        self,
        delivery: BatchDelivery,
        manifest: IncrementalBatchManifest,
    ) -> DatasetDescriptor:
        if delivery.batch_id != manifest.batch_id:
            raise _PermanentBatchError("DELIVERY_BATCH_ID_MISMATCH")
        if delivery.source_dataset != manifest.source_dataset:
            raise _PermanentBatchError("DELIVERY_DATASET_MISMATCH")
        if manifest.source_system != self._registry.snapshot["sourceSystem"]:
            raise _PermanentBatchError("SOURCE_SYSTEM_MISMATCH")
        if manifest.revision != 0:
            raise _PermanentBatchError("REVISION_UNSUPPORTED")
        try:
            return self._registry.require(manifest.source_dataset)
        except UnknownDatasetError as error:
            raise _PermanentBatchError("DATASET_NOT_ALLOWLISTED") from error

    def _sync_request(self, manifest: IncrementalBatchManifest) -> SyncRequest:
        active = self._manifests.get_active()
        if active is None:
            raise RuntimeError("ACTIVE manifest is required for incremental ingestion")
        return SyncRequest(
            run_id=f"ingest-{manifest.batch_id}-{uuid4().hex}",
            dataset_version=active.dataset_version,
            window=manifest.window,
            dataset_names=(manifest.source_dataset,),
            page_size=self._page_size,
        )

    @staticmethod
    def _validate_window(
        descriptor: DatasetDescriptor,
        window: TimeWindow,
    ) -> None:
        grain_seconds = descriptor.grain_seconds
        if grain_seconds is None:
            return
        duration_seconds = (window.end - window.start).total_seconds()
        grain_microseconds = grain_seconds * 1_000_000
        start_microseconds = int(window.start.timestamp() * 1_000_000)
        end_microseconds = int(window.end.timestamp() * 1_000_000)
        if (
            duration_seconds != grain_seconds
            or window.grain_seconds != grain_seconds
            or start_microseconds % grain_microseconds != 0
            or end_microseconds % grain_microseconds != 0
        ):
            raise _PermanentBatchError("WINDOW_GRAIN_INCOMPATIBLE")

    def _quarantine(
        self,
        delivery: BatchDelivery,
        batch: IncrementalBatchRecord,
        code: str,
    ) -> IngestIncrementalResult:
        if batch.state in {BatchState.VALIDATING, BatchState.INGESTING}:
            batch = self._batches.finish(
                batch.batch_id,
                batch.state,
                batch.version,
                BatchState.QUARANTINED,
                counts={"written": 0, "unchanged": 0},
                error_code=code,
            )
        try:
            self._queue.ack(delivery)
        except Exception as error:
            _log_failure("quarantine ack", delivery, error)
            return IngestIncrementalResult(retryable=1)
        return IngestIncrementalResult(quarantined=1)

    def _retryable(self, batch: IncrementalBatchRecord | None) -> IngestIncrementalResult:
        if batch is not None and batch.state in {BatchState.VALIDATING, BatchState.INGESTING}:
            self._batches.transition(
                batch.batch_id,
                batch.state,
                batch.version,
                BatchState.RETRYABLE_FAILED,
            )
        return IngestIncrementalResult(retryable=1)

    def _process(self, delivery: BatchDelivery) -> IngestIncrementalResult:
        batch: IncrementalBatchRecord | None = None
        try:
            manifest = self._store.load_manifest(delivery.reference)
        except (TypeError, ValueError, IdempotencyConflict):
            self._queue.ack(delivery)
            return IngestIncrementalResult(quarantined=1)
        except Exception as error:
            _log_failure("manifest load", delivery, error)
            return IngestIncrementalResult(retryable=1)

        try:
            batch = self._batches.claim(manifest, delivery.reference)
            if batch.state is BatchState.COMPLETED:
                self._queue.ack(delivery)
                return IngestIncrementalResult(completed=1)
            if batch.state is BatchState.QUARANTINED:
                self._queue.ack(delivery)
                return IngestIncrementalResult(quarantined=1)

            if batch.state in {BatchState.RECEIVED, BatchState.RETRYABLE_FAILED}:
                batch = self._batches.transition(
                    batch.batch_id,
                    batch.state,
                    batch.version,
                    BatchState.VALIDATING,
                )
            descriptor = self._validate_identity(delivery, manifest)
            self._validate_window(descriptor, manifest.window)
            reader = S3IncrementalSourceReader(self._store, manifest)
            schema = reader.validate_schema(descriptor)
            if not schema.is_compatible:
                return self._quarantine(delivery, batch, "SCHEMA_INCOMPATIBLE")
            if batch.state is BatchState.VALIDATING:
                batch = self._batches.transition(
                    batch.batch_id,
                    BatchState.VALIDATING,
                    batch.version,
                    BatchState.INGESTING,
                )
            result = self._sync_factory(reader).execute(self._sync_request(manifest))
            if result.stage is not RunStage.SUCCEEDED:
                return self._retryable(batch)
            counts = {
                "written": sum(source.records_written for source in result.sources.values()),
                "unchanged": sum(
                    source.records_unchanged for source in result.sources.values()
                ),
            }
            if batch.state is BatchState.INGESTING:
                batch = self._batches.transition(
                    batch.batch_id,
                    BatchState.INGESTING,
                    batch.version,
                    BatchState.COMMITTING,
                )
            self._batches.finish(
                batch.batch_id,
                BatchState.COMMITTING,
                batch.version,
                BatchState.COMPLETED,
                counts=counts,
            )
            self._queue.ack(delivery)
            return IngestIncrementalResult(
                completed=1,
                extra_columns=len(manifest.extra_columns),
            )
        except _PermanentBatchError as error:
            if batch is None:
                self._queue.ack(delivery)
                return IngestIncrementalResult(quarantined=1)
            return self._quarantine(delivery, batch, error.code)
        except IdempotencyConflict:
            self._queue.ack(delivery)
            return IngestIncrementalResult(quarantined=1)
        except Exception as error:
            _log_failure("batch processing", delivery, error)
            return self._retryable(batch)

    def drain(self, limit: int) -> IngestIncrementalResult:
        if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
            raise ValueError("limit must be a positive integer")
        total = IngestIncrementalResult()
        for delivery in self._queue.receive(limit):
            result = self._process(delivery)
            self._observe_result(delivery.source_dataset, result)
            total += result
        return total

    def _observe_result(self, dataset: str, result: IngestIncrementalResult) -> None:
        """Publica outcomes de baixa cardinalidade sem afetar ack, retry ou estado durável."""
        observations = (
            ("COMPLETED", result.completed),
            ("RETRYABLE_FAILED", result.retryable),
            ("QUARANTINED", result.quarantined),
        )
        for status, count in observations:
            if count <= 0:
                continue
            dimensions = {
                "command": "ingest-incremental",
                "status": status,
                "dataset": dataset,
            }
            self._safe_increment("IncrementalBatches", count, dimensions)
            if status == "QUARANTINED":
                self._safe_increment("IncrementalBatchQuarantined", count, dimensions)
        if result.extra_columns > 0:
            self._safe_increment(
                "IncrementalSchemaExtraColumns",
                result.extra_columns,
                {
                    "command": "ingest-incremental",
                    "status": "COMPLETED",
                    "dataset": dataset,
                },
            )

    def _safe_increment(
        self,
        name: str,
        value: int,
        dimensions: Mapping[str, str],
    ) -> None:
        try:
            self._metrics.increment(name, value, dimensions)
        except BaseException:
            return


__all__ = [
    "IngestIncremental",
    "IngestIncrementalResult",
    "S3IncrementalSourceReader",
    "SyncFactory",
]
