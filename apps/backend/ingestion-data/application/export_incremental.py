"""Export one closed ARGUS source window as an immutable raw batch."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from application.sync import ActiveManifestError, active_manifest_source_watermarks
from contracts.registry import DatasetRegistry
from domain.incremental_batches import IncrementalBatchDefinition, IncrementalBatchReference
from ports import (
    IncrementalBatchObjectStore,
    IncrementalBatchQueue,
    IncrementalExportSource,
    LeaseRepository,
    ManifestRepository,
    RawBatchCodec,
    WindowCommitRepository,
)
from ports.contracts import Cursor

_LEASE_SOURCE = "EXPORT_INCREMENTAL"


@dataclass(frozen=True, slots=True)
class ExportIncrementalRequest:
    """Defines the single immutable batch to export from the active source baseline."""

    dataset_version: str
    definition: IncrementalBatchDefinition
    page_size: int = 500
    lease_ttl_seconds: int = 300

    def __post_init__(self) -> None:
        if not isinstance(self.dataset_version, str) or not self.dataset_version:
            raise ValueError("dataset_version must be a non-empty string")
        if not isinstance(self.definition, IncrementalBatchDefinition):
            raise TypeError("definition must be an IncrementalBatchDefinition")
        if self.definition.revision != 0:
            raise ValueError("incremental MVP requires revision=0")
        if isinstance(self.page_size, bool) or not isinstance(self.page_size, int):
            raise TypeError("page_size must be an integer")
        if self.page_size <= 0:
            raise ValueError("page_size must be positive")
        if isinstance(self.lease_ttl_seconds, bool) or not isinstance(self.lease_ttl_seconds, int):
            raise TypeError("lease_ttl_seconds must be an integer")
        if self.lease_ttl_seconds <= 0:
            raise ValueError("lease_ttl_seconds must be positive")


@dataclass(frozen=True, slots=True)
class ExportIncrementalResult:
    """Reports immutable batch identity, its manifest reference, and exported counts."""

    batch_id: str
    reference: IncrementalBatchReference
    row_count: int
    page_count: int


class ExportIncremental:
    """Publishes raw data before its queue reference and advances a watermark last."""

    def __init__(
        self,
        registry: DatasetRegistry,
        manifests: ManifestRepository,
        source: IncrementalExportSource,
        codec: RawBatchCodec,
        store: IncrementalBatchObjectStore,
        queue: IncrementalBatchQueue,
        commits: WindowCommitRepository,
        leases: LeaseRepository,
        *,
        workdir: Path,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        if not isinstance(registry, DatasetRegistry):
            raise TypeError("registry must be a DatasetRegistry")
        if not isinstance(workdir, Path):
            raise TypeError("workdir must be a Path")
        self._registry = registry
        self._manifests = manifests
        self._source = source
        self._codec = codec
        self._store = store
        self._queue = queue
        self._commits = commits
        self._leases = leases
        self._workdir = workdir
        self._clock = clock

    def _now(self) -> datetime:
        now = self._clock()
        if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() != timedelta(0):
            raise ValueError("clock must return an aware UTC datetime")
        return now.astimezone(UTC)

    def _baseline(self, request: ExportIncrementalRequest) -> datetime:
        active = self._manifests.get_active()
        if active is None or active.dataset_version != request.dataset_version:
            raise ActiveManifestError(
                "ACTIVE manifest does not match the requested dataset version"
            )
        watermarks = active_manifest_source_watermarks(
            active,
            registry=self._registry,
            source_dataset_names=(request.definition.source_dataset,),
        )
        return watermarks[request.definition.source_dataset]

    def _read_all_rows(
        self, request: ExportIncrementalRequest
    ) -> tuple[tuple[Mapping[str, object], ...], int, tuple[object, ...] | None]:
        descriptor = self._registry.require(request.definition.source_dataset)
        after: Cursor | None = None
        rows: list[Mapping[str, object]] = []
        page_count = 0
        while True:
            page = self._source.read_page(
                descriptor,
                request.definition.window,
                after,
                request.page_size,
            )
            rows.extend(page.rows)
            page_count += 1
            if page.next_cursor is None:
                return tuple(rows), page_count, after
            if page.next_cursor == after:
                raise ValueError("incremental source page cursor did not advance")
            after = page.next_cursor

    def execute(self, request: ExportIncrementalRequest) -> ExportIncrementalResult:
        """Export, publish, queue, then atomically advance the source watermark by CAS."""
        if not isinstance(request, ExportIncrementalRequest):
            raise TypeError("request must be an ExportIncrementalRequest")
        if request.definition.source_system != self._registry.snapshot["sourceSystem"]:
            raise ValueError("definition source_system must match registry sourceSystem")
        baseline = self._baseline(request)
        lease_owner = request.definition.source_dataset
        lease_attempt = uuid4().hex
        self._leases.acquire(
            _LEASE_SOURCE,
            lease_owner,
            self._now(),
            request.lease_ttl_seconds,
            idempotency_key=f"lease-acquire:export:{lease_attempt}",
        )
        try:
            watermark_source = f"export:{request.definition.source_dataset}"
            committed = self._commits.get_watermark(request.dataset_version, watermark_source)
            previous = committed if committed is not None else baseline
            if request.definition.window.start != previous:
                raise ValueError("incremental export window must start at the durable watermark")

            descriptor = self._registry.require(request.definition.source_dataset)
            columns = self._source.observe_schema(descriptor)
            rows, page_count, _ = self._read_all_rows(request)
            if not rows:
                raise ValueError("incremental export cannot publish an empty batch")
            encoded = self._codec.encode(
                columns,
                rows,
                self._workdir / request.definition.batch_id / "data.parquet",
            )

            reference = self._store.publish(request.definition, columns, encoded)
            self._queue.send(
                reference,
                batch_id=request.definition.batch_id,
                dataset=request.definition.source_dataset,
            )
            self._commits.commit_watermark_and_outboxes(
                request.dataset_version,
                watermark_source,
                request.definition.window.end,
                (),
                expected_watermark=committed,
                idempotency_key=f"export-window:{request.definition.batch_id}",
            )
            return ExportIncrementalResult(
                request.definition.batch_id,
                reference,
                encoded.row_count,
                page_count,
            )
        finally:
            self._leases.release(
                _LEASE_SOURCE,
                lease_owner,
                idempotency_key=f"lease-release:export:{lease_attempt}",
            )


__all__ = ["ExportIncremental", "ExportIncrementalRequest", "ExportIncrementalResult"]
