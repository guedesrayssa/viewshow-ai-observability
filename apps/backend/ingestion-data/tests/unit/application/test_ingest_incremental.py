"""Verify incremental raw batches merge into the active dataset safely."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime

import pytest

from application.ingest_incremental import IngestIncremental, S3IncrementalSourceReader
from application.publish_outbox import OutboxPublisher
from application.sync import Sync
from contracts.registry import DatasetRegistry
from domain.identity import canonical_dataset_version, dataset_version
from domain.incremental_batches import (
    BatchDelivery,
    BatchState,
    IncrementalBatchManifest,
    IncrementalBatchReference,
    PhysicalColumn,
    incremental_batch_id,
)
from domain.models import TimeWindow
from domain.run import RunPipeline
from ports import MetricsPublisher, SourceReader
from tests.fakes import (
    FakeAnalysisRequestPublisher,
    FakeCheckpointRepository,
    FakeHotRecordSink,
    FakeIncrementalBatchQueue,
    FakeIncrementalBatchRepository,
    FakeIncrementalBatchStore,
    FakeIngestionBackend,
    FakeLeaseRepository,
    FakeManifestRepository,
    FakeMetricsPublisher,
    FakeOutboxRepository,
    FakeWindowCommitRepository,
    valid_active_manifest,
)

DUMP_SHA256 = "c1d86081679d66c392b63710bda4517b047f029c5403ad1502d731ab5ac126ea"
WINDOW = TimeWindow(
    datetime(2026, 9, 1, tzinfo=UTC),
    datetime(2026, 9, 1, 0, 15, tzinfo=UTC),
    900,
)
HOURLY_WINDOW = TimeWindow(
    datetime(2026, 9, 1, tzinfo=UTC),
    datetime(2026, 9, 1, 1, tzinfo=UTC),
    3600,
)
MISALIGNED_HOURLY_WINDOW = TimeWindow(
    datetime(2026, 9, 1, 0, 15, tzinfo=UTC),
    datetime(2026, 9, 1, 1, 15, tzinfo=UTC),
    3600,
)
DELIVERY_ID = "delivery-1"


def _dataset_version(registry: DatasetRegistry) -> str:
    snapshot = registry.snapshot
    return dataset_version(
        str(snapshot["sourceSystem"]),
        DUMP_SHA256,
        str(snapshot["physicalContractVersion"]),
        str(snapshot["canonicalSchemaVersion"]),
    )


def _active_version(registry: DatasetRegistry, pipeline: RunPipeline) -> str:
    if pipeline is RunPipeline.LEGACY_V1:
        return _dataset_version(registry)
    snapshot = registry.snapshot
    return canonical_dataset_version(
        str(snapshot["sourceSystem"]),
        DUMP_SHA256,
        str(snapshot["physicalContractVersion"]),
        str(snapshot["canonicalSchemaVersion"]),
    )


def _raw_row(
    dataset: str,
    window: TimeWindow,
    *,
    extra_columns: tuple[str, ...] = (),
) -> dict[str, object]:
    if dataset == "signal_bucket":
        row: dict[str, object] = {
            "bts": int(window.start.timestamp() * 1000),
            "source": "probe",
            "entity": "edge-1",
            "metric": "latency",
            "value": 12.5,
        }
    elif dataset == "live_qoe_hourly":
        row = {
            "hour_ts": int(window.start.timestamp() * 1000),
            "sinal": "synthetic-channel",
            "sessions": 480,
            "errors": 12,
            "startup_errors": 3,
            "latency_ms_avg": 112.5,
            "latency_ms_p50": 90.25,
            "latency_ms_p95": 310.75,
            "bufferratio_avg": 0.018,
            "jointime_s_avg": 1.5,
            "dropped_frames_avg": 0.75,
            "stalls_avg": 0.125,
            "bitrate_mbps_avg": 6.5,
            "bitrate_mbps_p50": 5.25,
        }
    else:
        raise ValueError(f"test row is unavailable for {dataset}")
    row.update({name: "preservada" for name in extra_columns})
    return row


def manifest(
    registry: DatasetRegistry,
    *,
    dataset: str = "signal_bucket",
    window: TimeWindow = WINDOW,
    extra_columns: tuple[str, ...] = (),
    missing_column: str | None = None,
) -> IncrementalBatchManifest:
    descriptor = registry.require(dataset)
    columns = tuple(
        PhysicalColumn(column.name, column.sql_type, column.nullable, ordinal)
        for ordinal, column in enumerate(descriptor.columns, start=1)
        if column.name != missing_column
    )
    columns += tuple(
        PhysicalColumn(name, "VARCHAR(64)", True, len(columns) + offset)
        for offset, name in enumerate(extra_columns, start=1)
    )
    batch_id = incremental_batch_id("argus", descriptor.table, window, 0, "1.0")
    prefix = f"raw/argus/incremental/dataset={descriptor.table}/batch_id={batch_id}"
    return IncrementalBatchManifest(
        batch_id=batch_id,
        source_system="argus",
        source_dataset=descriptor.table,
        window=window,
        revision=0,
        data_key=f"{prefix}/data.parquet",
        data_version_id="data-v1",
        data_size_bytes=100,
        data_sha256="a" * 64,
        schema_fingerprint="b" * 64,
        columns=columns,
        extra_columns=extra_columns,
        row_count=1,
        exporter_version="1.0",
    )


def _reference(batch: IncrementalBatchManifest) -> IncrementalBatchReference:
    return IncrementalBatchReference(
        "incremental-bucket",
        batch.data_key.removesuffix("data.parquet") + "manifest.json",
        "manifest-v1",
    )


def _delivery(
    batch: IncrementalBatchManifest, *, message_id: str = DELIVERY_ID
) -> BatchDelivery:
    return BatchDelivery(
        message_id,
        batch.batch_id,
        batch.source_dataset,
        _reference(batch),
        f"receipt-{message_id}",
    )


@dataclass(slots=True)
class IngestDependencies:
    registry: DatasetRegistry
    manifests: FakeManifestRepository
    store: FakeIncrementalBatchStore
    queue: FakeIncrementalBatchQueue
    batches: FakeIncrementalBatchRepository
    metrics: FakeMetricsPublisher
    hot_sink: FakeHotRecordSink
    checkpoints: FakeCheckpointRepository
    commits: FakeWindowCommitRepository
    outbox: FakeOutboxRepository
    publisher: FakeAnalysisRequestPublisher
    leases: FakeLeaseRepository


def rebuild_service(dependencies: IngestDependencies) -> IngestIncremental:
    def sync_factory(reader: SourceReader) -> Sync:
        return Sync(
            registry=dependencies.registry,
            reader_factory=lambda: reader,
            hot_sink=dependencies.hot_sink,
            checkpoints=dependencies.checkpoints,
            window_commits=dependencies.commits,
            outbox_publisher=OutboxPublisher(dependencies.outbox, dependencies.publisher),
            leases=dependencies.leases,
            manifests=dependencies.manifests,
            analysis_dependencies={
                "ANOMALY_DETECTION": ("signal_bucket",),
                "QOE_FORECAST": ("live_qoe_hourly",),
            },
        )

    return IngestIncremental(
        registry=dependencies.registry,
        manifests=dependencies.manifests,
        store=dependencies.store,
        queue=dependencies.queue,
        batches=dependencies.batches,
        sync_factory=sync_factory,
        metrics=dependencies.metrics,
        page_size=1,
    )


def ingest_service(
    *,
    batch: IncrementalBatchManifest | None = None,
    fail_before_batch_finish: bool = False,
    active_manifest: bool = True,
    pipeline: RunPipeline = RunPipeline.LEGACY_V1,
) -> tuple[IngestIncremental, IngestDependencies]:
    registry = DatasetRegistry.load_argus_v2()
    version = _active_version(registry, pipeline)
    selected = batch or manifest(registry)
    backend = FakeIngestionBackend()
    store = FakeIncrementalBatchStore()
    store.seed(
        selected,
        _reference(selected),
        (
            _raw_row(
                selected.source_dataset,
                selected.window,
                extra_columns=selected.extra_columns,
            ),
        ),
    )
    queue = FakeIncrementalBatchQueue()
    queue.enqueue(_delivery(selected))
    batches = FakeIncrementalBatchRepository()
    if fail_before_batch_finish:
        batches.fail_finishes_remaining = 1
    dependencies = IngestDependencies(
        registry=registry,
        manifests=FakeManifestRepository(
            valid_active_manifest(
                registry.names(),
                version,
                source_watermark=selected.window.start,
                physical_contract_version=str(registry.snapshot["physicalContractVersion"]),
                canonical_schema_version=str(registry.snapshot["canonicalSchemaVersion"]),
                dump_checksum_sha256=DUMP_SHA256,
                pipeline=pipeline,
            )
            if active_manifest
            else None
        ),
        store=store,
        queue=queue,
        batches=batches,
        metrics=FakeMetricsPublisher(),
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=FakeCheckpointRepository(),
        commits=FakeWindowCommitRepository(backend),
        outbox=FakeOutboxRepository(backend=backend),
        publisher=FakeAnalysisRequestPublisher(),
        leases=FakeLeaseRepository(),
    )
    return rebuild_service(dependencies), dependencies


def test_extra_column_is_preserved_raw_but_not_sent_to_normalizer() -> None:
    registry = DatasetRegistry.load_argus_v2()
    batch = manifest(registry, extra_columns=("nova_coluna",))
    service, dependencies = ingest_service(batch=batch)

    result = service.drain(limit=1)

    assert result.completed == 1
    assert dependencies.hot_sink.records
    assert all(
        "nova_coluna" not in record.dimensions
        for record in dependencies.hot_sink.records.values()
    )
    assert dependencies.store.raw_rows[batch.batch_id][0]["nova_coluna"] == "preservada"
    assert dependencies.metrics.values["IncrementalBatches"] == 1
    assert dependencies.metrics.values["IncrementalSchemaExtraColumns"] == 1
    assert dependencies.metrics.measurements[-1] == (
        "increment",
        "IncrementalSchemaExtraColumns",
        1,
        {
            "command": "ingest-incremental",
            "status": "COMPLETED",
            "dataset": "signal_bucket",
        },
    )


def test_missing_required_column_quarantines_without_hot_writes() -> None:
    registry = DatasetRegistry.load_argus_v2()
    batch = manifest(registry, missing_column="metric")
    service, dependencies = ingest_service(batch=batch)

    result = service.drain(limit=1)

    assert result.quarantined == 1
    assert dependencies.hot_sink.records == {}
    assert dependencies.queue.acked == (DELIVERY_ID,)
    assert dependencies.batches.records[batch.batch_id].state is BatchState.QUARANTINED
    assert dependencies.metrics.measurements == (
        (
            "increment",
            "IncrementalBatches",
            1,
            {
                "command": "ingest-incremental",
                "status": "QUARANTINED",
                "dataset": "signal_bucket",
            },
        ),
        (
            "increment",
            "IncrementalBatchQuarantined",
            1,
            {
                "command": "ingest-incremental",
                "status": "QUARANTINED",
                "dataset": "signal_bucket",
            },
        ),
    )


def test_ack_failure_after_quarantine_keeps_terminal_until_redelivery() -> None:
    registry = DatasetRegistry.load_argus_v2()
    batch = manifest(registry, missing_column="metric")
    service, dependencies = ingest_service(batch=batch)
    dependencies.queue.ack_failures_remaining = 1

    first = service.drain(limit=1)

    assert first.retryable == 1
    assert dependencies.batches.records[batch.batch_id].state is BatchState.QUARANTINED
    assert dependencies.queue.acked == ()
    assert dependencies.hot_sink.records == {}

    redelivery = service.drain(limit=1)

    assert redelivery.quarantined == 1
    assert dependencies.batches.records[batch.batch_id].state is BatchState.QUARANTINED
    assert dependencies.queue.acked == (DELIVERY_ID,)


def test_short_hourly_manifest_is_quarantined_before_raw_or_hot_reads() -> None:
    registry = DatasetRegistry.load_argus_v2()
    batch = manifest(
        registry,
        dataset="live_qoe_hourly",
        window=WINDOW,
    )
    service, dependencies = ingest_service(batch=batch)

    result = service.drain(limit=1)

    assert result.quarantined == 1
    assert dependencies.store.read_calls == []
    assert dependencies.hot_sink.records == {}
    assert dependencies.batches.records[batch.batch_id].state is BatchState.QUARANTINED
    assert dependencies.queue.acked == (DELIVERY_ID,)


def test_hourly_manifest_executes_exact_manifest_window() -> None:
    registry = DatasetRegistry.load_argus_v2()
    batch = manifest(
        registry,
        dataset="live_qoe_hourly",
        window=HOURLY_WINDOW,
    )
    service, dependencies = ingest_service(batch=batch)

    result = service.drain(limit=1)

    assert result.completed == 1
    assert len(dependencies.hot_sink.records) == 1
    record = next(iter(dependencies.hot_sink.records.values()))
    assert record.window == HOURLY_WINDOW
    assert dependencies.commits.get_watermark(
        _dataset_version(registry), "source:live_qoe_hourly"
    ) == HOURLY_WINDOW.end
    assert dependencies.store.read_calls == [
        (batch.batch_id, None, 1),
        (batch.batch_id, 1, 1),
    ]


def test_misaligned_hourly_manifest_is_quarantined_before_raw_read() -> None:
    registry = DatasetRegistry.load_argus_v2()
    batch = manifest(
        registry,
        dataset="live_qoe_hourly",
        window=MISALIGNED_HOURLY_WINDOW,
    )
    service, dependencies = ingest_service(batch=batch)

    result = service.drain(limit=1)

    assert result.quarantined == 1
    assert dependencies.store.read_calls == []
    assert dependencies.hot_sink.records == {}


def test_missing_active_manifest_is_retryable_before_raw_or_hot_reads() -> None:
    service, dependencies = ingest_service(active_manifest=False)
    batch_id = manifest(dependencies.registry).batch_id

    result = service.drain(limit=1)

    assert result.retryable == 1
    assert dependencies.store.read_calls == []
    assert dependencies.hot_sink.records == {}
    assert dependencies.queue.acked == ()
    assert dependencies.batches.records[batch_id].state is BatchState.RETRYABLE_FAILED
    assert dependencies.metrics.measurements == (
        (
            "increment",
            "IncrementalBatches",
            1,
            {
                "command": "ingest-incremental",
                "status": "RETRYABLE_FAILED",
                "dataset": "signal_bucket",
            },
        ),
    )


def test_retryable_failure_logs_cause_and_batch_identity(
    caplog: pytest.LogCaptureFixture,
) -> None:
    service, dependencies = ingest_service(active_manifest=False)
    batch_id = manifest(dependencies.registry).batch_id

    with caplog.at_level("WARNING", logger="application.ingest_incremental"):
        result = service.drain(limit=1)

    assert result.retryable == 1
    assert dependencies.queue.acked == ()
    [record] = caplog.records
    message = record.getMessage()
    assert "batch processing failed" in message
    assert f"batch_id={batch_id}" in message
    assert f"message_id={DELIVERY_ID}" in message
    assert "error_type=RuntimeError" in message
    assert "ACTIVE manifest is required" in message


def test_quarantine_ack_failure_logs_cause_and_batch_identity(
    caplog: pytest.LogCaptureFixture,
) -> None:
    registry = DatasetRegistry.load_argus_v2()
    batch = manifest(registry, missing_column="metric")
    service, dependencies = ingest_service(batch=batch)
    dependencies.queue.ack_failures_remaining = 1

    with caplog.at_level("WARNING", logger="application.ingest_incremental"):
        result = service.drain(limit=1)

    assert result.retryable == 1
    assert dependencies.batches.records[batch.batch_id].state is BatchState.QUARANTINED
    [record] = caplog.records
    message = record.getMessage()
    assert "quarantine ack failed" in message
    assert f"batch_id={batch.batch_id}" in message
    assert "error_type=" in message


def test_metric_publisher_failure_does_not_change_batch_lifecycle_or_ack() -> None:
    class BrokenMetrics(MetricsPublisher):
        def increment(
            self,
            name: str,
            value: int,
            dimensions: Mapping[str, str],
        ) -> None:
            del name, value, dimensions
            raise RuntimeError("collector unavailable")

        def gauge(
            self,
            name: str,
            value: float,
            dimensions: Mapping[str, str],
        ) -> None:
            del name, value, dimensions

        def timing(
            self,
            name: str,
            milliseconds: float,
            dimensions: Mapping[str, str],
        ) -> None:
            del name, milliseconds, dimensions

    service, dependencies = ingest_service()
    dependencies.metrics = BrokenMetrics()  # type: ignore[assignment]
    service = rebuild_service(dependencies)

    result = service.drain(limit=1)

    batch_id = manifest(dependencies.registry).batch_id
    assert result.completed == 1
    assert dependencies.batches.records[batch_id].state is BatchState.COMPLETED
    assert dependencies.queue.acked == (DELIVERY_ID,)


@pytest.mark.parametrize("cursor", [(0, 1), ("0",), (-1,)])
def test_s3_reader_rejects_non_offset_cursor_without_raw_read(
    cursor: tuple[object, ...],
) -> None:
    registry = DatasetRegistry.load_argus_v2()
    batch = manifest(registry)
    _, dependencies = ingest_service(batch=batch)
    reader = S3IncrementalSourceReader(dependencies.store, batch)

    with pytest.raises(ValueError, match="cursor"):
        reader.read_page(
            registry.require(batch.source_dataset),
            batch.window,
            cursor,
            1,
        )

    assert dependencies.store.read_calls == []


def test_nullability_drift_quarantines_before_raw_or_hot_reads() -> None:
    registry = DatasetRegistry.load_argus_v2()
    compatible = manifest(registry)
    columns = tuple(
        replace(column, nullable=True) if column.name == "metric" else column
        for column in compatible.columns
    )
    batch = replace(compatible, columns=columns)
    service, dependencies = ingest_service(batch=batch)

    result = service.drain(limit=1)

    assert result.quarantined == 1
    assert dependencies.store.read_calls == []
    assert dependencies.hot_sink.records == {}


def test_completed_duplicate_is_acked_without_rewriting_hot_facts() -> None:
    service, dependencies = ingest_service()
    first = service.drain(limit=1)
    writes = dependencies.hot_sink.write_calls
    batch = dependencies.store.manifests[0] if dependencies.store.manifests else None
    if batch is None:
        batch = manifest(dependencies.registry)
    dependencies.queue.enqueue(_delivery(batch, message_id="delivery-2"))

    duplicate = service.drain(limit=1)

    assert first.completed == duplicate.completed == 1
    assert dependencies.hot_sink.write_calls == writes
    assert dependencies.queue.acked == (DELIVERY_ID, "delivery-2")


def test_failed_sync_is_retryable_and_does_not_ack() -> None:
    service, dependencies = ingest_service()
    original_write = dependencies.hot_sink.write

    def fail_write(*args: object, **kwargs: object):
        del args, kwargs
        raise RuntimeError("temporary hot store outage")

    dependencies.hot_sink.write = fail_write  # type: ignore[method-assign]

    result = service.drain(limit=1)

    dependencies.hot_sink.write = original_write  # type: ignore[method-assign]
    batch_id = manifest(dependencies.registry).batch_id
    assert result.retryable == 1
    assert dependencies.queue.acked == ()
    assert dependencies.batches.records[batch_id].state is BatchState.RETRYABLE_FAILED

    replay = service.drain(limit=1)

    assert replay.completed == 1
    assert dependencies.batches.records[batch_id].state is BatchState.COMPLETED
    assert dependencies.queue.acked == (DELIVERY_ID,)


@pytest.mark.parametrize("pipeline", tuple(RunPipeline))
def test_incremental_fact_is_written_only_to_the_active_dataset_representation(
    pipeline: RunPipeline,
) -> None:
    service, dependencies = ingest_service(pipeline=pipeline)

    result = service.drain(limit=1)

    assert result.completed == 1
    assert {key[0] for key in dependencies.hot_sink.records} == {
        _active_version(dependencies.registry, pipeline)
    }
    assert dependencies.manifests.candidates == {}


def test_delivery_identity_mismatch_is_quarantined_before_hot_writes() -> None:
    service, dependencies = ingest_service()
    queued = dependencies.queue.deliveries[0]
    dependencies.queue.deliveries[0] = replace(queued, source_dataset="other")

    result = service.drain(limit=1)

    assert result.quarantined == 1
    assert dependencies.hot_sink.records == {}
    assert dependencies.queue.acked == (DELIVERY_ID,)
    batch_id = manifest(dependencies.registry).batch_id
    assert dependencies.batches.records[batch_id].state is BatchState.QUARANTINED
