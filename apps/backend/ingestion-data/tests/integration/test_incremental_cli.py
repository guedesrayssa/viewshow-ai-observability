"""Verify the explicit incremental CLI commands compose one closed batch window."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from bootstrap.cli import main
from bootstrap.config import Settings
from bootstrap.container import RuntimeContainer, _capabilities
from contracts.registry import DatasetRegistry
from domain.identity import dataset_version
from domain.incremental_batches import BatchDelivery, BatchState, PhysicalColumn
from ports import SourcePage
from tests.fakes import (
    FakeAnalysisRequestPublisher,
    FakeCheckpointRepository,
    FakeHotRecordSink,
    FakeIncrementalBatchQueue,
    FakeIncrementalBatchRepository,
    FakeIncrementalBatchStore,
    FakeIncrementalExportSource,
    FakeIngestionBackend,
    FakeLeaseRepository,
    FakeLogger,
    FakeManifestRepository,
    FakeMetricsPublisher,
    FakeOutboxRepository,
    FakeRawBatchCodec,
    FakeWindowCommitRepository,
    valid_active_manifest,
)

WINDOW_START = datetime(2026, 9, 1, tzinfo=UTC)
WINDOW_END = datetime(2026, 9, 1, 0, 15, tzinfo=UTC)
_DUMP_SHA256 = "c1d86081679d66c392b63710bda4517b047f029c5403ad1502d731ab5ac126ea"


class _SharedControl(FakeCheckpointRepository, FakeLeaseRepository):
    def __init__(self) -> None:
        FakeCheckpointRepository.__init__(self)
        FakeLeaseRepository.__init__(self)


class _SharedOutbox(FakeWindowCommitRepository, FakeOutboxRepository):
    def __init__(self, backend: FakeIngestionBackend) -> None:
        FakeWindowCommitRepository.__init__(self, backend)
        FakeOutboxRepository.__init__(self, backend=backend)


class _LoopbackBatchQueue(FakeIncrementalBatchQueue):
    def send(self, reference, *, batch_id: str, dataset: str) -> None:  # type: ignore[no-untyped-def]
        super().send(reference, batch_id=batch_id, dataset=dataset)
        self.enqueue(
            BatchDelivery(
                f"delivery-{batch_id}",
                batch_id,
                dataset,
                reference,
                f"receipt-{batch_id}",
            )
        )


class _WindowedExportSource(FakeIncrementalExportSource):
    """Uses the selected window boundary as the source timestamp for each exported batch."""

    def read_page(self, descriptor, window, after, limit):  # type: ignore[no-untyped-def]
        if after is not None:
            return SourcePage((), None)
        return SourcePage(
            (
                {
                    "bts": int(window.start.timestamp() * 1000),
                    "source": "probe",
                    "entity": "edge-1",
                    "metric": "latency",
                    "value": 12.5,
                },
            ),
            None,
        )


@dataclass(slots=True)
class _IncrementalRuntime:
    container: RuntimeContainer
    batches: FakeIncrementalBatchRepository
    commits: _SharedOutbox
    dataset_version: str
    logger: FakeLogger
    source: _WindowedExportSource
    store: FakeIncrementalBatchStore
    batch_queue: _LoopbackBatchQueue

    def factory(self, command: str):  # type: ignore[no-untyped-def]
        return self.container.resolve(command).handler

    def batch_states(self) -> tuple[BatchState, ...]:
        return tuple(record.state for record in self.batches.records.values())

    def source_watermark(self, dataset: str) -> datetime | None:
        return self.commits.get_watermark(self.dataset_version, f"export:{dataset}")


def _incremental_runtime(tmp_path: Path, *, now: datetime = WINDOW_END) -> _IncrementalRuntime:
    registry = DatasetRegistry.load_argus_v2()
    descriptor = registry.require("signal_bucket")
    version = dataset_version(
        str(registry.snapshot["sourceSystem"]),
        _DUMP_SHA256,
        str(registry.snapshot["physicalContractVersion"]),
        str(registry.snapshot["canonicalSchemaVersion"]),
    )
    backend = FakeIngestionBackend()
    manifests = FakeManifestRepository(
        valid_active_manifest(
            registry.names(),
            version,
            source_watermark=WINDOW_START,
            physical_contract_version=str(registry.snapshot["physicalContractVersion"]),
            canonical_schema_version=str(registry.snapshot["canonicalSchemaVersion"]),
            dump_checksum_sha256=_DUMP_SHA256,
        ),
        backend=backend,
    )
    batch_queue = _LoopbackBatchQueue()
    batches = FakeIncrementalBatchRepository()
    commits = _SharedOutbox(backend)
    logger = FakeLogger()
    columns = tuple(
        PhysicalColumn(column.name, column.sql_type, column.nullable, ordinal)
        for ordinal, column in enumerate(descriptor.columns, start=1)
    )
    source = _WindowedExportSource(
        columns,
        (),
    )
    settings = Settings.from_env(
        {
            "ARGUS_SOURCE_MODE": "live",
            "LIVE_SYNC_ENABLED": "true",
            "LIVE_MYSQL_HOST": "db.internal",
            "LIVE_MYSQL_PORT": "3306",
            "LIVE_MYSQL_USER": "argus",
            "LIVE_MYSQL_PASSWORD": "test-only",
            "LIVE_MYSQL_DATABASE": "argus",
            "OPERATIONAL_TABLE_NAME": "ingestion-state",
            "INCREMENTAL_BATCH_BUCKET": "incremental-batches",
            "INCREMENTAL_BATCH_EXPECTED_BUCKET_OWNER": "123456789012",
            "INCREMENTAL_BATCH_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/123/incremental.fifo",
            "ANALYSIS_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/123/analysis",
            "ARCHIVE_WORKDIR": str(tmp_path),
        },
        command="export-incremental",
    )
    control = _SharedControl()
    factories = {
        "registry": lambda: registry,
        "manifests": lambda: manifests,
        "incremental_export_source": lambda: source,
        "raw_batch_codec": FakeRawBatchCodec,
        "incremental_batch_store": FakeIncrementalBatchStore,
        "incremental_batch_queue": lambda: batch_queue,
        "incremental_batch_repository": lambda: batches,
        "hot_sink": lambda: FakeHotRecordSink(backend),
        "outbox": lambda: commits,
        "queue": FakeAnalysisRequestPublisher,
        "control": lambda: control,
        "telemetry": lambda: {
            "logger": logger,
            "metrics": FakeMetricsPublisher(),
            "clock": lambda: now,
        },
    }
    needed = set(_capabilities("export-incremental", no_write=False)) | set(
        _capabilities("ingest-incremental", no_write=False)
    )
    assert needed == set(factories)
    store = factories["incremental_batch_store"]()
    factories["incremental_batch_store"] = lambda: store
    return _IncrementalRuntime(
        RuntimeContainer(settings, factories),
        batches,
        commits,
        version,
        logger,
        source,
        store,
        batch_queue,
    )


def test_export_then_ingest_commands_advance_two_fixture_windows(tmp_path: Path) -> None:
    """Two invocations must use the durable export watermark and complete both closed batches."""
    runtime = _incremental_runtime(tmp_path, now=WINDOW_END + timedelta(minutes=15))

    assert main(["export-incremental"], handler_factory=runtime.factory) == 0
    assert main(["export-incremental"], handler_factory=runtime.factory) == 0
    assert main(["ingest-incremental", "--limit", "20"], handler_factory=runtime.factory) == 0

    assert runtime.batch_states() == (BatchState.COMPLETED, BatchState.COMPLETED)
    assert runtime.source_watermark("signal_bucket") == WINDOW_END + timedelta(minutes=15)
    export_finished = next(
        fields
        for _level, event, fields in runtime.logger.records
        if event == "ingestion.run.finished" and fields["command"] == "export-incremental"
    )
    assert export_finished["batchId"].startswith("bat_")
    assert export_finished["recordsRead"] == 1
    assert export_finished["datasetVersion"] == runtime.dataset_version
    assert export_finished["dataset"] == "signal_bucket"
    assert export_finished["windowStart"] == "2026-09-01T00:00:00Z"
    assert export_finished["windowEnd"] == "2026-09-01T00:15:00Z"
    ingest_finished = next(
        fields
        for _level, event, fields in runtime.logger.records
        if event == "ingestion.run.finished" and fields["command"] == "ingest-incremental"
    )
    assert ingest_finished["datasetVersion"] == runtime.dataset_version
    assert ingest_finished["batchesCompleted"] == 2
    assert ingest_finished["batchesRetryable"] == 0
    assert ingest_finished["batchesQuarantined"] == 0


def test_export_rejects_an_open_window_before_touching_batch_dependencies(tmp_path: Path) -> None:
    """A current incomplete window must not reach source reads, storage, SQS, or watermarks."""
    runtime = _incremental_runtime(tmp_path, now=WINDOW_START + timedelta(minutes=5))

    assert main(["export-incremental"], handler_factory=runtime.factory) == 1

    assert runtime.source.observed == []
    assert runtime.store.published == []
    assert runtime.batch_queue.sent == []
    assert runtime.source_watermark("signal_bucket") is None
