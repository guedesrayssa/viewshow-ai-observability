"""Focused regressions for durable cross-batch Sync readiness."""

from __future__ import annotations

from datetime import UTC, datetime

from application.publish_outbox import OutboxPublisher
from application.sync import Sync, SyncRequest
from contracts.registry import DatasetRegistry
from domain.identity import dataset_version
from domain.models import TimeWindow
from domain.run import RunStage
from tests.fakes import (
    FakeAnalysisRequestPublisher,
    FakeCheckpointRepository,
    FakeHotRecordSink,
    FakeIngestionBackend,
    FakeLeaseRepository,
    FakeManifestRepository,
    FakeOutboxRepository,
    FakeSourceReader,
    FakeWindowCommitRepository,
    valid_active_manifest,
)

DUMP_SHA256 = "c1d86081679d66c392b63710bda4517b047f029c5403ad1502d731ab5ac126ea"
WINDOW = TimeWindow(
    datetime(2026, 9, 1, tzinfo=UTC),
    datetime(2026, 9, 1, 0, 15, tzinfo=UTC),
    900,
)


def _version(registry: DatasetRegistry) -> str:
    snapshot = registry.snapshot
    return dataset_version(
        str(snapshot["sourceSystem"]),
        DUMP_SHA256,
        str(snapshot["physicalContractVersion"]),
        str(snapshot["canonicalSchemaVersion"]),
    )


def test_last_dependency_uses_durable_evidence_from_prior_dataset_batch() -> None:
    registry = DatasetRegistry.load_argus_v2()
    version = _version(registry)
    backend = FakeIngestionBackend()
    commits = FakeWindowCommitRepository(backend)
    start_ms = int(WINDOW.start.timestamp() * 1000)
    end_ms = int(WINDOW.end.timestamp() * 1000)
    backend.watermarks[(version, "source:live_active_15min")] = WINDOW.end
    backend.bucket_evidence[(version, "source:live_active_15min")] = (
        ("live_active_15min", start_ms, end_ms, 900),
    )
    service = Sync(
        registry=registry,
        reader_factory=lambda: FakeSourceReader(
            {
                "signal_bucket": (
                    {
                        "bts": start_ms,
                        "source": "probe",
                        "entity": "edge-1",
                        "metric": "latency",
                        "value": 12.5,
                    },
                )
            }
        ),
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=FakeCheckpointRepository(),
        window_commits=commits,
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=FakeManifestRepository(
            valid_active_manifest(
                registry.names(),
                version,
                source_watermark=WINDOW.start,
                physical_contract_version=str(registry.snapshot["physicalContractVersion"]),
                canonical_schema_version=str(registry.snapshot["canonicalSchemaVersion"]),
                dump_checksum_sha256=DUMP_SHA256,
            )
        ),
    )

    result = service.execute(
        SyncRequest(
            "sync-last-dependency",
            version,
            WINDOW,
            ("signal_bucket",),
        )
    )

    assert result.stage is RunStage.SUCCEEDED
    assert result.new_analysis_events == 1


def test_durable_watermark_without_bucket_evidence_does_not_emit_analysis() -> None:
    registry = DatasetRegistry.load_argus_v2()
    version = _version(registry)
    backend = FakeIngestionBackend()
    backend.watermarks[(version, "source:live_active_15min")] = WINDOW.end
    service = Sync(
        registry=registry,
        reader_factory=lambda: FakeSourceReader(
            {
                "signal_bucket": (
                    {
                        "bts": int(WINDOW.start.timestamp() * 1000),
                        "source": "probe",
                        "entity": "edge-1",
                        "metric": "latency",
                        "value": 12.5,
                    },
                )
            }
        ),
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=FakeCheckpointRepository(),
        window_commits=FakeWindowCommitRepository(backend),
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=FakeManifestRepository(
            valid_active_manifest(
                registry.names(),
                version,
                source_watermark=WINDOW.start,
                physical_contract_version=str(registry.snapshot["physicalContractVersion"]),
                canonical_schema_version=str(registry.snapshot["canonicalSchemaVersion"]),
                dump_checksum_sha256=DUMP_SHA256,
            )
        ),
    )

    result = service.execute(
        SyncRequest("sync-missing-evidence", version, WINDOW, ("signal_bucket",))
    )

    assert result.stage is RunStage.SUCCEEDED
    assert result.new_analysis_events == 0
