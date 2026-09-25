"""Verify ingestion commands coordinate supported operational workflows."""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from application.publish_outbox import OutboxPublisher
from application.rebuild_projections import (
    ProjectionBuildResult,
    ProjectionService,
    RebuildProjections,
    RebuildProjectionsRequest,
)
from application.reprocess import Reprocess, ReprocessRequest
from application.sync import (
    ActiveManifestError,
    Sync,
    SyncRequest,
    SyncResult,
    SyncSourceResult,
    active_manifest_source_watermarks,
)
from application.sync_catchup import SyncCatchup, SyncCatchupRequest
from application.validate import Validate, ValidateRequest
from contracts.argus.v2.normalizers import NormalizationContext, normalize_row
from contracts.registry import DatasetRegistry, UnknownDatasetError
from domain.identity import dataset_version
from domain.models import TimeWindow
from domain.quality import CoverageStatus
from domain.run import RunStage
from ports import (
    CandidateManifest,
    ConditionalWriteError,
    CoverageObservation,
    RestoreRequest,
    RestoreResult,
    SchemaObservation,
    SourcePage,
)
from tests.fakes import (
    FakeAnalysisRequestPublisher,
    FakeCheckpointRepository,
    FakeHotRecordSink,
    FakeIngestionBackend,
    FakeLeaseRepository,
    FakeLiveSyncConfiguration,
    FakeManifestRepository,
    FakeOutboxRepository,
    FakeProjectionRepository,
    FakeSourceReader,
    FakeWindowCommitRepository,
    valid_active_manifest,
)

FIXTURES = Path(__file__).parents[2] / "fixtures"


# O sha do dump é evidência OPERACIONAL, não contrato: cada execução declara
# qual dump restaurou. Os testes declaram do mesmo jeito que o operador declara.
DUMP_SHA256 = "c1d86081679d66c392b63710bda4517b047f029c5403ad1502d731ab5ac126ea"


def fixture(name: str, dataset: str) -> dict[str, object]:
    value = json.loads((FIXTURES / name).read_text(encoding="utf-8"))[dataset]
    assert isinstance(value, dict)
    return value


def active_manifest(
    registry: DatasetRegistry,
    dataset_version: str,
    *,
    source_watermark: datetime,
    snapshot_extracted_on: str = "2026-09-01",
    empty_interval_datasets: tuple[str, ...] = (),
) -> CandidateManifest:
    snapshot = registry.snapshot
    return valid_active_manifest(
        registry.names(),
        dataset_version,
        source_watermark=source_watermark,
        physical_contract_version=str(snapshot["physicalContractVersion"]),
        canonical_schema_version=str(snapshot["canonicalSchemaVersion"]),
        dump_checksum_sha256=DUMP_SHA256,
        snapshot_extracted_on=snapshot_extracted_on,
        empty_interval_datasets=empty_interval_datasets,
    )


def active_dataset_version(registry: DatasetRegistry) -> str:
    snapshot = registry.snapshot
    return dataset_version(
        str(snapshot["sourceSystem"]),
        DUMP_SHA256,
        str(snapshot["physicalContractVersion"]),
        str(snapshot["canonicalSchemaVersion"]),
    )


def active_manifest_repository(registry: DatasetRegistry) -> FakeManifestRepository:
    return FakeManifestRepository(
        active_manifest(
            registry,
            active_dataset_version(registry),
            source_watermark=datetime(2026, 9, 1, tzinfo=UTC),
        )
    )


SYNC_DATASET_VERSION = active_dataset_version(DatasetRegistry.load_argus_v2())


def test_sync_disabled_skips_before_constructing_live_reader() -> None:
    called = False

    def reader_factory():  # type: ignore[no-untyped-def]
        nonlocal called
        called = True
        raise AssertionError("reader must not be constructed")

    service = Sync(
        registry=DatasetRegistry.load_argus_v2(),
        reader_factory=reader_factory,
        hot_sink=FakeHotRecordSink(),
        checkpoints=FakeCheckpointRepository(),
        window_commits=FakeWindowCommitRepository(),
        outbox_publisher=OutboxPublisher(FakeOutboxRepository(), FakeAnalysisRequestPublisher()),
        leases=FakeLeaseRepository(),
        manifests=FakeManifestRepository(),
    )
    request = SyncCatchupRequest(
        run_id="sync-1",
        dataset_version=SYNC_DATASET_VERSION,
        latest_window=TimeWindow(
            datetime(2026, 9, 1, tzinfo=UTC),
            datetime(2026, 9, 1, 0, 15, tzinfo=UTC),
            900,
        ),
        dataset_names=("signal_bucket",),
    )

    result = SyncCatchup(service, FakeLiveSyncConfiguration(False)).execute(request)
    assert result.stage is RunStage.SKIPPED_DISABLED

    assert called is False


def test_sync_requires_a_manifest_repository() -> None:
    with pytest.raises(TypeError, match="manifests must implement ManifestRepository"):
        Sync(
            registry=DatasetRegistry.load_argus_v2(),
            reader_factory=lambda: FakeSourceReader({}),
            hot_sink=FakeHotRecordSink(),
            checkpoints=FakeCheckpointRepository(),
            window_commits=FakeWindowCommitRepository(),
            outbox_publisher=OutboxPublisher(
                FakeOutboxRepository(), FakeAnalysisRequestPublisher()
            ),
            leases=FakeLeaseRepository(),
            manifests=None,
        )


def test_sync_commits_after_the_active_manifest_source_baseline() -> None:
    registry = DatasetRegistry.load_argus_v2()
    start = datetime(2026, 9, 1, 9, tzinfo=UTC)
    snapshot = registry.snapshot
    version = dataset_version(
        str(snapshot["sourceSystem"]),
        DUMP_SHA256,
        str(snapshot["physicalContractVersion"]),
        str(snapshot["canonicalSchemaVersion"]),
    )
    commits = FakeWindowCommitRepository()
    service = Sync(
        registry=registry,
        reader_factory=lambda: FakeSourceReader(
            {
                "signal_bucket": (
                    {
                        **fixture("argus_v2_legacy_rows.json", "signal_bucket"),
                        "bts": int(start.timestamp() * 1000),
                    },
                )
            }
        ),
        hot_sink=FakeHotRecordSink(),
        checkpoints=FakeCheckpointRepository(),
        window_commits=commits,
        outbox_publisher=OutboxPublisher(FakeOutboxRepository(), FakeAnalysisRequestPublisher()),
        leases=FakeLeaseRepository(),
        manifests=FakeManifestRepository(
            active_manifest(registry, version, source_watermark=start)
        ),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket",),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )

    result = service.execute(
        SyncRequest(
            run_id="sync-active-baseline",
            dataset_version=version,
            window=TimeWindow(start, start + timedelta(minutes=15), 900),
            dataset_names=("signal_bucket",),
        )
    )

    assert result.succeeded is True
    assert commits.watermarks[(version, "source:signal_bucket")] == start + timedelta(minutes=15)


def test_active_manifest_without_intervals_uses_snapshot_day_as_source_baseline() -> None:
    registry = DatasetRegistry.load_argus_v2()
    start = datetime(2026, 9, 1, 9, tzinfo=UTC)
    watermarks = active_manifest_source_watermarks(
        active_manifest(
            registry,
            dataset_version(
                str(registry.snapshot["sourceSystem"]),
                DUMP_SHA256,
                str(registry.snapshot["physicalContractVersion"]),
                str(registry.snapshot["canonicalSchemaVersion"]),
            ),
            source_watermark=start,
            snapshot_extracted_on="2026-08-31",
            empty_interval_datasets=("signal_bucket",),
        ),
        registry=registry,
        source_dataset_names=("signal_bucket",),
    )

    assert watermarks == {"signal_bucket": datetime(2026, 8, 31, tzinfo=UTC)}


def test_sync_rejects_active_manifest_with_registry_identity_mismatch_before_reader() -> None:
    registry = DatasetRegistry.load_argus_v2()
    start = datetime(2026, 9, 1, 9, tzinfo=UTC)
    constructed = False

    def reader_factory() -> FakeSourceReader:
        nonlocal constructed
        constructed = True
        return FakeSourceReader({})

    commits = FakeWindowCommitRepository()
    service = Sync(
        registry=registry,
        reader_factory=reader_factory,
        hot_sink=FakeHotRecordSink(),
        checkpoints=FakeCheckpointRepository(),
        window_commits=commits,
        outbox_publisher=OutboxPublisher(FakeOutboxRepository(), FakeAnalysisRequestPublisher()),
        leases=FakeLeaseRepository(),
        manifests=FakeManifestRepository(
            active_manifest(registry, "dsv_stale_active", source_watermark=start)
        ),
    )

    with pytest.raises(ActiveManifestError, match="contract identity"):
        service.execute(
            SyncRequest(
                run_id="sync-stale-active",
                dataset_version="dsv_stale_active",
                window=TimeWindow(start, start + timedelta(minutes=15), 900),
                dataset_names=("signal_bucket",),
            )
        )

    assert constructed is False
    assert commits.watermarks == {}


def test_sync_rejects_corrupt_active_manifest_before_reader() -> None:
    registry = DatasetRegistry.load_argus_v2()
    start = datetime(2026, 9, 1, 9, tzinfo=UTC)
    constructed = False

    def reader_factory() -> FakeSourceReader:
        nonlocal constructed
        constructed = True
        return FakeSourceReader({})

    service = Sync(
        registry=registry,
        reader_factory=reader_factory,
        hot_sink=FakeHotRecordSink(),
        checkpoints=FakeCheckpointRepository(),
        window_commits=FakeWindowCommitRepository(),
        outbox_publisher=OutboxPublisher(FakeOutboxRepository(), FakeAnalysisRequestPublisher()),
        leases=FakeLeaseRepository(),
        manifests=FakeManifestRepository(CandidateManifest("dsv_corrupt", {})),
    )

    with pytest.raises(ActiveManifestError, match="ACTIVE manifest is invalid"):
        service.execute(
            SyncRequest(
                run_id="sync-corrupt-active",
                dataset_version="dsv_corrupt",
                window=TimeWindow(start, start + timedelta(minutes=15), 900),
                dataset_names=("signal_bucket",),
            )
        )

    assert constructed is False


def test_sync_isolates_source_failure_and_does_not_emit_incomplete_window() -> None:
    registry = DatasetRegistry.load_argus_v2()
    rows = {
        "signal_bucket": (fixture("argus_v2_legacy_rows.json", "signal_bucket"),),
        "live_active_15min": (fixture("argus_v2_legacy_rows.json", "live_active_15min"),),
    }

    class PartiallyFailingReader(FakeSourceReader):
        def validate_schema(self, descriptor):  # type: ignore[no-untyped-def]
            if descriptor.table == "live_active_15min":
                return SchemaObservation("0" * 64, False, ("drift",))
            return super().validate_schema(descriptor)

    backend = FakeIngestionBackend()
    commits = FakeWindowCommitRepository(backend=backend)
    service = Sync(
        registry=registry,
        reader_factory=lambda: PartiallyFailingReader(rows),
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=FakeCheckpointRepository(),
        window_commits=commits,
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=active_manifest_repository(registry),
        normalization_context=lambda _reader: NormalizationContext(),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket", "live_active_15min"),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )
    request = SyncRequest(
        run_id="sync-2",
        dataset_version=SYNC_DATASET_VERSION,
        window=TimeWindow(
            datetime(2026, 9, 1, tzinfo=UTC),
            datetime(2026, 9, 2, tzinfo=UTC),
            900,
        ),
        dataset_names=("signal_bucket", "live_active_15min"),
    )

    result = service.execute(request)

    assert result.sources["signal_bucket"].succeeded is True
    assert result.sources["live_active_15min"].succeeded is False
    assert len(backend.fact_records) == 1
    assert commits.outboxes == {}
    assert result.analysis_watermarks == {}


def test_sync_commits_minimum_complete_dependency_watermark() -> None:
    registry = DatasetRegistry.load_argus_v2()
    rows = {
        "signal_bucket": (fixture("argus_v2_legacy_rows.json", "signal_bucket"),),
        "live_active_15min": (fixture("argus_v2_legacy_rows.json", "live_active_15min"),),
    }
    backend = FakeIngestionBackend()
    commits = FakeWindowCommitRepository(backend=backend)
    publisher = FakeAnalysisRequestPublisher()
    service = Sync(
        registry=registry,
        reader_factory=lambda: FakeSourceReader(rows),
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=FakeCheckpointRepository(),
        window_commits=commits,
        outbox_publisher=OutboxPublisher(FakeOutboxRepository(backend=backend), publisher),
        leases=FakeLeaseRepository(),
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket", "live_active_15min"),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )
    request = SyncRequest(
        run_id="sync-complete",
        dataset_version=SYNC_DATASET_VERSION,
        window=TimeWindow(
            datetime(2026, 9, 1, tzinfo=UTC),
            datetime(2026, 9, 1, 0, 15, tzinfo=UTC),
            900,
        ),
        dataset_names=("signal_bucket", "live_active_15min"),
    )

    result = service.execute(request)

    expected = datetime(2026, 9, 1, 0, 15, tzinfo=UTC)
    assert result.succeeded is True
    assert result.analysis_watermarks == {"ANOMALY_DETECTION": expected}
    assert result.new_analysis_events == 1
    assert publisher.published[0].payload["inputWatermark"] == "2026-09-01T00:15:00.000Z"
    assert commits.watermarks[(SYNC_DATASET_VERSION, "analysis:ANOMALY_DETECTION")] == expected


def test_sync_catchup_reconciles_an_outbox_after_source_commit_crashes_first() -> None:
    registry = DatasetRegistry.load_argus_v2()
    start = datetime(2026, 9, 1, tzinfo=UTC)
    window = TimeWindow(start, start + timedelta(minutes=15), 900)
    signal = fixture("argus_v2_legacy_rows.json", "signal_bucket")
    active = fixture("argus_v2_legacy_rows.json", "live_active_15min")
    rows = {
        "signal_bucket": ({**signal, "bts": int(start.timestamp() * 1000)},),
        "live_active_15min": ({**active, "bucket_ts": int(start.timestamp() * 1000)},),
        "live_qoe_hourly": (),
    }
    backend = FakeIngestionBackend()

    class FailAfterFirstSourceCommit(FakeWindowCommitRepository):
        should_fail = True

        def commit_watermark_and_outboxes(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            super().commit_watermark_and_outboxes(*args, **kwargs)
            source = args[1]
            if self.should_fail and source == "source:signal_bucket":
                self.should_fail = False
                raise RuntimeError("injected after source commit")

    commits = FailAfterFirstSourceCommit(backend=backend)
    readers: list[FakeSourceReader] = []

    def reader_factory() -> FakeSourceReader:
        reader = FakeSourceReader(rows)
        readers.append(reader)
        return reader

    service = Sync(
        registry=registry,
        reader_factory=reader_factory,
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=FakeCheckpointRepository(),
        window_commits=commits,
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket", "live_active_15min"),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )

    failed = service.execute(
        SyncRequest(
            run_id="sync-source-crash",
            dataset_version=SYNC_DATASET_VERSION,
            window=window,
            dataset_names=("signal_bucket", "live_active_15min", "live_qoe_hourly"),
        )
    )

    assert failed.stage is RunStage.PARTIAL
    assert commits.watermarks[(SYNC_DATASET_VERSION, "source:signal_bucket")] == window.end
    assert (SYNC_DATASET_VERSION, "source:live_qoe_hourly") not in commits.watermarks
    assert (SYNC_DATASET_VERSION, "analysis:ANOMALY_DETECTION") not in commits.watermarks
    assert backend.outboxes == {}

    recovered = SyncCatchup(service, FakeLiveSyncConfiguration(True)).execute(
        SyncCatchupRequest(
            run_id="sync-source-crash-retry",
            dataset_version=SYNC_DATASET_VERSION,
            latest_window=window,
            dataset_names=("signal_bucket", "live_active_15min", "live_qoe_hourly"),
            source_watermarks={
                "signal_bucket": commits.watermarks[(SYNC_DATASET_VERSION, "source:signal_bucket")],
                "live_active_15min": commits.watermarks[
                    (SYNC_DATASET_VERSION, "source:live_active_15min")
                ],
            },
            source_grain_seconds={"live_qoe_hourly": 3600},
        )
    )

    assert len(readers) == 2
    assert recovered.succeeded is True
    assert recovered.analysis_watermarks == {"ANOMALY_DETECTION": window.end}
    assert [event.event_type for event in backend.outboxes.values()] == ["ANOMALY_DETECTION"]

    settled = SyncCatchup(service, FakeLiveSyncConfiguration(True)).execute(
        SyncCatchupRequest(
            run_id="sync-source-crash-settled",
            dataset_version=SYNC_DATASET_VERSION,
            latest_window=window,
            dataset_names=("signal_bucket", "live_active_15min", "live_qoe_hourly"),
            source_watermarks={
                "signal_bucket": window.end,
                "live_active_15min": window.end,
            },
            analysis_watermarks=recovered.analysis_watermarks,
            source_grain_seconds={"live_qoe_hourly": 3600},
        )
    )

    assert settled.sources == {}
    assert len(readers) == 2

    replayed = service.execute(
        SyncRequest(
            run_id="sync-source-crash-replay",
            dataset_version=SYNC_DATASET_VERSION,
            window=window,
            dataset_names=("signal_bucket", "live_active_15min", "live_qoe_hourly"),
        )
    )

    assert replayed.succeeded is True
    assert [event.event_type for event in backend.outboxes.values()] == ["ANOMALY_DETECTION"]


def test_sync_catchup_emits_hourly_qoe_only_from_its_final_subwindow() -> None:
    registry = DatasetRegistry.load_argus_v2()
    start = datetime(2026, 9, 1, 9, tzinfo=UTC)
    end = start + timedelta(hours=1)
    signal = fixture("argus_v2_legacy_rows.json", "signal_bucket")
    qoe = fixture("argus_v2_legacy_rows.json", "live_qoe_hourly")
    backend = FakeIngestionBackend()

    class TrackingCommits(FakeWindowCommitRepository):
        analysis_commits: list[tuple[str, datetime, tuple[object, ...]]] = []

        def commit_watermark_and_outboxes(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            super().commit_watermark_and_outboxes(*args, **kwargs)
            source = args[1]
            if source.startswith("analysis:"):
                self.analysis_commits.append((source, args[2], args[3]))

    commits = TrackingCommits(backend=backend)
    commits.watermarks[(SYNC_DATASET_VERSION, "source:signal_bucket")] = start
    commits.watermarks[(SYNC_DATASET_VERSION, "source:live_qoe_hourly")] = start
    commits.watermarks[(SYNC_DATASET_VERSION, "analysis:ANOMALY_DETECTION")] = start
    commits.watermarks[(SYNC_DATASET_VERSION, "analysis:QOE_FORECAST")] = start
    service = Sync(
        registry=registry,
        reader_factory=lambda: FakeSourceReader(
            {
                "signal_bucket": tuple(
                    {**signal, "bts": int((start + timedelta(minutes=offset)).timestamp() * 1000)}
                    for offset in (0, 15, 30, 45)
                ),
                "live_qoe_hourly": ({**qoe, "hour_ts": int(start.timestamp() * 1000)},),
            }
        ),
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=FakeCheckpointRepository(),
        window_commits=commits,
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket",),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )

    result = SyncCatchup(service, FakeLiveSyncConfiguration(True)).execute(
        SyncCatchupRequest(
            run_id="sync-hourly-qoe",
            dataset_version=SYNC_DATASET_VERSION,
            latest_window=TimeWindow(end - timedelta(minutes=15), end, 900),
            dataset_names=("signal_bucket", "live_qoe_hourly"),
            source_watermarks={"signal_bucket": start, "live_qoe_hourly": start},
            analysis_watermarks={"ANOMALY_DETECTION": start, "QOE_FORECAST": start},
            source_grain_seconds={"live_qoe_hourly": 3600},
        )
    )

    assert result.succeeded is True
    assert result.new_analysis_events == 5
    assert [event.event_type for event in backend.outboxes.values()].count("ANOMALY_DETECTION") == 4
    assert [event.event_type for event in backend.outboxes.values()].count("QOE_FORECAST") == 1
    assert result.analysis_watermarks == {
        "ANOMALY_DETECTION": end,
        "QOE_FORECAST": end,
    }
    assert [
        item[:2] for item in commits.analysis_commits if item[0] == "analysis:QOE_FORECAST"
    ] == [("analysis:QOE_FORECAST", end)]


def test_sync_catchup_reads_a_hourly_source_only_when_its_hour_closes() -> None:
    """A late hourly row must not be sealed out by earlier fifteen-minute reads."""
    registry = DatasetRegistry.load_argus_v2()
    start = datetime(2026, 9, 1, 9, tzinfo=UTC)
    end = start + timedelta(hours=1)
    signal = fixture("argus_v2_legacy_rows.json", "signal_bucket")
    qoe = fixture("argus_v2_legacy_rows.json", "live_qoe_hourly")
    backend = FakeIngestionBackend()
    commits = FakeWindowCommitRepository(backend=backend)
    commits.watermarks[(SYNC_DATASET_VERSION, "source:signal_bucket")] = start
    commits.watermarks[(SYNC_DATASET_VERSION, "source:live_qoe_hourly")] = start
    commits.watermarks[(SYNC_DATASET_VERSION, "analysis:ANOMALY_DETECTION")] = start
    commits.watermarks[(SYNC_DATASET_VERSION, "analysis:QOE_FORECAST")] = start

    class LateHourlyReader(FakeSourceReader):
        def __init__(self) -> None:
            super().__init__(
                {
                    "signal_bucket": tuple(
                        {
                            **signal,
                            "bts": int((start + timedelta(minutes=offset)).timestamp() * 1000),
                        }
                        for offset in (0, 15, 30, 45)
                    ),
                    "live_qoe_hourly": ({**qoe, "hour_ts": int(start.timestamp() * 1000)},),
                }
            )
            self.hourly_windows: list[TimeWindow] = []

        def read_page(self, descriptor, window, after, limit):  # type: ignore[no-untyped-def]
            if descriptor.table == "live_qoe_hourly":
                assert window is not None
                self.hourly_windows.append(window)
                if window.end < end:
                    return SourcePage((), None)
            return super().read_page(descriptor, window, after, limit)

    reader = LateHourlyReader()
    service = Sync(
        registry=registry,
        reader_factory=lambda: reader,
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=FakeCheckpointRepository(),
        window_commits=commits,
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket",),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )

    result = SyncCatchup(service, FakeLiveSyncConfiguration(True)).execute(
        SyncCatchupRequest(
            run_id="sync-late-hourly-source",
            dataset_version=SYNC_DATASET_VERSION,
            latest_window=TimeWindow(end - timedelta(minutes=15), end, 900),
            dataset_names=("signal_bucket", "live_qoe_hourly"),
            source_watermarks={"signal_bucket": start, "live_qoe_hourly": start},
            analysis_watermarks={"ANOMALY_DETECTION": start, "QOE_FORECAST": start},
            source_grain_seconds={"live_qoe_hourly": 3600},
        )
    )

    assert result.succeeded is True
    assert result.sources["live_qoe_hourly"].watermark == end
    assert [
        record
        for record in backend.fact_records.values()
        if record.source_dataset == "live_qoe_hourly"
    ]
    assert set(reader.hourly_windows) == {TimeWindow(start, end, 3600)}


def test_sync_closes_zero_evidence_qoe_only_at_an_hour_boundary() -> None:
    registry = DatasetRegistry.load_argus_v2()
    backend = FakeIngestionBackend()
    commits = FakeWindowCommitRepository(backend=backend)
    start = datetime(2026, 9, 1, 9, tzinfo=UTC)
    service = Sync(
        registry=registry,
        reader_factory=lambda: FakeSourceReader({"live_qoe_hourly": ()}),
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=FakeCheckpointRepository(),
        window_commits=commits,
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket",),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )

    for offset in (0, 15, 30):
        window = TimeWindow(
            start + timedelta(minutes=offset),
            start + timedelta(minutes=offset + 15),
            900,
        )
        result = service.execute(
            SyncRequest(
                run_id=f"sync-empty-qoe-{offset}",
                dataset_version=SYNC_DATASET_VERSION,
                window=window,
                dataset_names=("live_qoe_hourly",),
            )
        )

        assert result.succeeded is True
        assert result.sources["live_qoe_hourly"].watermark is None
        assert "QOE_FORECAST" not in result.analysis_watermarks
        assert (SYNC_DATASET_VERSION, "source:live_qoe_hourly") not in commits.watermarks

    end = start + timedelta(hours=1)
    result = service.execute(
        SyncRequest(
            run_id="sync-empty-qoe-hour",
            dataset_version=SYNC_DATASET_VERSION,
            window=TimeWindow(end - timedelta(minutes=15), end, 900),
            dataset_names=("live_qoe_hourly",),
        )
    )

    assert result.succeeded is True
    assert result.sources["live_qoe_hourly"].watermark == end
    assert result.analysis_watermarks == {"QOE_FORECAST": end}
    assert result.new_analysis_events == 0
    assert backend.outboxes == {}


def test_sync_catchup_recovers_hourly_qoe_after_final_source_commit_crashes() -> None:
    registry = DatasetRegistry.load_argus_v2()
    start = datetime(2026, 9, 1, 9, tzinfo=UTC)
    end = start + timedelta(hours=1)
    signal = fixture("argus_v2_legacy_rows.json", "signal_bucket")
    qoe = fixture("argus_v2_legacy_rows.json", "live_qoe_hourly")
    rows = {
        "signal_bucket": tuple(
            {**signal, "bts": int((start + timedelta(minutes=offset)).timestamp() * 1000)}
            for offset in (0, 15, 30, 45)
        ),
        "live_qoe_hourly": ({**qoe, "hour_ts": int(start.timestamp() * 1000)},),
    }
    backend = FakeIngestionBackend()
    initial_commits = FakeWindowCommitRepository(backend=backend)
    initial_commits.watermarks[(SYNC_DATASET_VERSION, "analysis:QOE_FORECAST")] = start
    initial = Sync(
        registry=registry,
        reader_factory=lambda: FakeSourceReader(rows),
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=FakeCheckpointRepository(),
        window_commits=initial_commits,
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket",),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )

    for offset in (0, 15, 30):
        window = TimeWindow(
            start + timedelta(minutes=offset),
            start + timedelta(minutes=offset + 15),
            900,
        )
        assert initial.execute(
            SyncRequest(
                run_id=f"sync-hourly-{offset}",
                dataset_version=SYNC_DATASET_VERSION,
                window=window,
                dataset_names=tuple(rows),
            )
        ).succeeded

    class FailAfterFinalQoeSourceCommit(FakeWindowCommitRepository):
        should_fail = True

        def commit_watermark_and_outboxes(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            super().commit_watermark_and_outboxes(*args, **kwargs)
            if self.should_fail and args[1] == "source:live_qoe_hourly" and args[2] == end:
                self.should_fail = False
                raise RuntimeError("injected after final hourly source commit")

    commits = FailAfterFinalQoeSourceCommit(backend=backend)
    service = Sync(
        registry=registry,
        reader_factory=lambda: FakeSourceReader(rows),
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=initial._checkpoints,
        window_commits=commits,
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket",),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )
    final_window = TimeWindow(end - timedelta(minutes=15), end, 900)

    failed = service.execute(
        SyncRequest(
            run_id="sync-hourly-final-crash",
            dataset_version=SYNC_DATASET_VERSION,
            window=final_window,
            dataset_names=tuple(rows),
        )
    )

    assert failed.stage is RunStage.PARTIAL
    assert commits.watermarks[(SYNC_DATASET_VERSION, "source:live_qoe_hourly")] == end
    assert commits.watermarks[(SYNC_DATASET_VERSION, "analysis:ANOMALY_DETECTION")] == end
    assert commits.watermarks[(SYNC_DATASET_VERSION, "analysis:QOE_FORECAST")] == start

    recovered = SyncCatchup(service, FakeLiveSyncConfiguration(True)).execute(
        SyncCatchupRequest(
            run_id="sync-hourly-final-retry",
            dataset_version=SYNC_DATASET_VERSION,
            latest_window=final_window,
            dataset_names=tuple(rows),
            source_watermarks={
                "signal_bucket": end,
                "live_qoe_hourly": end,
            },
            analysis_watermarks={
                "ANOMALY_DETECTION": end,
                "QOE_FORECAST": start,
            },
            source_grain_seconds={"live_qoe_hourly": 3600},
        )
    )

    assert recovered.succeeded is True
    assert recovered.new_analysis_events == 1
    assert recovered.analysis_watermarks["QOE_FORECAST"] == end
    assert [event.event_type for event in backend.outboxes.values()].count("QOE_FORECAST") == 1


@pytest.mark.parametrize("signal_offsets", ((0, 30), (0, 15)), ids=("middle-gap", "final-gap"))
def test_sync_validates_normalized_requested_buckets_before_emitting_analysis(
    signal_offsets: tuple[int, ...],
) -> None:
    """A source-wide COMPLETE status cannot bridge a bucket missing inside this window."""
    registry = DatasetRegistry.load_argus_v2()
    start = datetime(2026, 9, 1, tzinfo=UTC)
    signal = fixture("argus_v2_legacy_rows.json", "signal_bucket")
    active = fixture("argus_v2_legacy_rows.json", "live_active_15min")
    rows = {
        "signal_bucket": tuple(
            {**signal, "bts": int((start + timedelta(minutes=offset)).timestamp() * 1000)}
            for offset in signal_offsets
        ),
        "live_active_15min": tuple(
            {**active, "bucket_ts": int((start + timedelta(minutes=offset)).timestamp() * 1000)}
            for offset in (0, 15, 30)
        ),
    }
    backend = FakeIngestionBackend()
    commits = FakeWindowCommitRepository(backend=backend)
    service = Sync(
        registry=registry,
        reader_factory=lambda: FakeSourceReader(rows),
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=FakeCheckpointRepository(),
        window_commits=commits,
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket", "live_active_15min"),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )

    result = service.execute(
        SyncRequest(
            run_id="sync-gap",
            dataset_version=SYNC_DATASET_VERSION,
            window=TimeWindow(start, start + timedelta(minutes=45), 900),
            dataset_names=("signal_bucket", "live_active_15min"),
        )
    )

    assert result.sources["signal_bucket"].succeeded is True
    assert result.sources["live_active_15min"].succeeded is True
    assert result.analysis_watermarks == {"ANOMALY_DETECTION": start + timedelta(minutes=45)}
    assert result.new_analysis_events == 0
    assert commits.outboxes == {}


def test_sync_does_not_consult_table_wide_coverage_for_a_complete_requested_bucket() -> None:
    registry = DatasetRegistry.load_argus_v2()
    start = datetime(2026, 9, 1, tzinfo=UTC)
    signal = fixture("argus_v2_legacy_rows.json", "signal_bucket")
    active = fixture("argus_v2_legacy_rows.json", "live_active_15min")

    class RequestedWindowReader(FakeSourceReader):
        def measure_coverage(self, descriptor):  # type: ignore[no-untyped-def]
            raise AssertionError(f"unexpected table-wide coverage for {descriptor.table}")

    backend = FakeIngestionBackend()
    service = Sync(
        registry=registry,
        reader_factory=lambda: RequestedWindowReader(
            {
                "signal_bucket": ({**signal, "bts": int(start.timestamp() * 1000)},),
                "live_active_15min": ({**active, "bucket_ts": int(start.timestamp() * 1000)},),
            }
        ),
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=FakeCheckpointRepository(),
        window_commits=FakeWindowCommitRepository(backend=backend),
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket", "live_active_15min"),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )

    result = service.execute(
        SyncRequest(
            run_id="sync-requested-window",
            dataset_version=SYNC_DATASET_VERSION,
            window=TimeWindow(start, start + timedelta(minutes=15), 900),
            dataset_names=("signal_bucket", "live_active_15min"),
        )
    )

    assert result.analysis_watermarks == {"ANOMALY_DETECTION": start + timedelta(minutes=15)}
    assert result.new_analysis_events == 1


def test_sync_fails_closed_before_hot_writes_when_bucket_evidence_disk_is_unavailable() -> None:
    registry = DatasetRegistry.load_argus_v2()
    row = fixture("argus_v2_legacy_rows.json", "signal_bucket")
    backend = FakeIngestionBackend()
    service = Sync(
        registry=registry,
        reader_factory=lambda: FakeSourceReader({"signal_bucket": (row,)}),
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=FakeCheckpointRepository(),
        window_commits=FakeWindowCommitRepository(backend=backend),
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket",),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
        disk_budget_bytes=1024,
        disk_free_bytes=lambda _path: 0,
    )

    result = service.execute(
        SyncRequest(
            run_id="sync-low-disk",
            dataset_version=SYNC_DATASET_VERSION,
            window=TimeWindow(
                datetime(2026, 9, 1, tzinfo=UTC),
                datetime(2026, 9, 1, 0, 15, tzinfo=UTC),
                900,
            ),
            dataset_names=("signal_bucket",),
        )
    )

    assert result.stage is RunStage.PARTIAL
    assert result.sources == {}
    assert backend.fact_records == {}
    assert backend.outboxes == {}


def test_sync_does_not_advance_a_source_watermark_past_the_requested_window() -> None:
    registry = DatasetRegistry.load_argus_v2()
    start = datetime(2026, 9, 1, tzinfo=UTC)
    signal = fixture("argus_v2_legacy_rows.json", "signal_bucket")
    backend = FakeIngestionBackend()
    commits = FakeWindowCommitRepository(backend=backend)

    class OutOfWindowReader(FakeSourceReader):
        def read_page(self, descriptor, window, after, limit):  # type: ignore[no-untyped-def]
            return super().read_page(descriptor, None, after, limit)

    service = Sync(
        registry=registry,
        reader_factory=lambda: OutOfWindowReader(
            {
                "signal_bucket": (
                    {**signal, "bts": int((start + timedelta(minutes=15)).timestamp() * 1000)},
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
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket",),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )

    result = service.execute(
        SyncRequest(
            run_id="sync-window-bound",
            dataset_version=SYNC_DATASET_VERSION,
            window=TimeWindow(start, start + timedelta(minutes=15), 900),
            dataset_names=("signal_bucket",),
        )
    )

    assert result.sources["signal_bucket"].succeeded is False
    assert (SYNC_DATASET_VERSION, "source:signal_bucket") not in commits.watermarks
    assert backend.fact_records == {}


def test_sync_commits_the_closed_window_end_separately_from_latest_observation() -> None:
    registry = DatasetRegistry.load_argus_v2()
    start = datetime(2026, 9, 1, 9, tzinfo=UTC)
    observed_at = start + timedelta(minutes=7)
    incident = fixture("argus_v2_legacy_rows.json", "incidents")
    backend = FakeIngestionBackend()
    commits = FakeWindowCommitRepository(backend=backend)
    service = Sync(
        registry=registry,
        reader_factory=lambda: FakeSourceReader(
            {
                "incidents": (
                    {
                        **incident,
                        "opened_at": int(observed_at.timestamp() * 1000),
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
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("incidents",),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )

    result = service.execute(
        SyncRequest(
            run_id="sync-observation-watermark",
            dataset_version=SYNC_DATASET_VERSION,
            window=TimeWindow(start, start + timedelta(minutes=15), 900),
            dataset_names=("incidents",),
        )
    )

    assert result.sources["incidents"].watermark == start + timedelta(minutes=15)
    assert result.sources["incidents"].latest_observed_at == observed_at
    assert commits.watermarks[(SYNC_DATASET_VERSION, "source:incidents")] == start + timedelta(
        minutes=15
    )


def test_sync_does_not_emit_analysis_for_partial_dependency_coverage() -> None:
    registry = DatasetRegistry.load_argus_v2()
    rows = {
        "signal_bucket": (fixture("argus_v2_legacy_rows.json", "signal_bucket"),),
        "live_active_15min": (fixture("argus_v2_legacy_rows.json", "live_active_15min"),),
    }

    class PartialCoverageReader(FakeSourceReader):
        def measure_coverage(self, descriptor):  # type: ignore[no-untyped-def]
            observed = super().measure_coverage(descriptor)
            if descriptor.table == "signal_bucket":
                return replace(observed, status=CoverageStatus.PARTIAL)
            return observed

    backend = FakeIngestionBackend()
    service = Sync(
        registry=registry,
        reader_factory=lambda: PartialCoverageReader(rows),
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=FakeCheckpointRepository(),
        window_commits=FakeWindowCommitRepository(backend=backend),
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket", "live_active_15min"),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )

    result = service.execute(
        SyncRequest(
            run_id="sync-partial",
            dataset_version=SYNC_DATASET_VERSION,
            window=TimeWindow(
                datetime(2026, 9, 1, tzinfo=UTC),
                datetime(2026, 9, 2, tzinfo=UTC),
                900,
            ),
            dataset_names=("signal_bucket", "live_active_15min"),
        )
    )

    # Table-wide coverage is no longer used to reject a normalized source.
    assert result.sources["signal_bucket"].succeeded is True
    assert result.new_analysis_events == 0
    assert backend.outboxes == {}


def test_sync_failure_reports_facts_persisted_before_a_later_page_failed() -> None:
    registry = DatasetRegistry.load_argus_v2()
    first = fixture("argus_v2_legacy_rows.json", "signal_bucket")
    second = {**first, "bts": first["bts"] + 900_000}  # type: ignore[operator]
    backend = FakeIngestionBackend()
    sink = FakeHotRecordSink(backend)
    checkpoints = FakeCheckpointRepository()
    original_write = sink.write
    attempts = 0

    def fail_second(*args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal attempts
        attempts += 1
        if attempts == 2:
            raise RuntimeError("late page failed")
        return original_write(*args, **kwargs)

    sink.write = fail_second  # type: ignore[method-assign]
    service = Sync(
        registry=registry,
        reader_factory=lambda: FakeSourceReader({"signal_bucket": (first, second)}),
        hot_sink=sink,
        checkpoints=checkpoints,
        window_commits=FakeWindowCommitRepository(backend=backend),
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket",),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )

    result = service.execute(
        SyncRequest(
            run_id="sync-late-failure",
            dataset_version=SYNC_DATASET_VERSION,
            window=TimeWindow(
                datetime(2026, 9, 1, tzinfo=UTC),
                datetime(2026, 9, 1, 0, 30, tzinfo=UTC),
                900,
            ),
            dataset_names=("signal_bucket",),
            page_size=1,
        )
    )

    source = result.sources["signal_bucket"]
    assert source.succeeded is False
    assert source.records_written == 1
    assert source.watermark is None
    assert checkpoints.checkpoints == {}
    assert len(backend.fact_records) == 1

    resumed = service.execute(
        SyncRequest(
            run_id="sync-late-resume",
            dataset_version=SYNC_DATASET_VERSION,
            window=TimeWindow(
                datetime(2026, 9, 1, tzinfo=UTC),
                datetime(2026, 9, 1, 0, 30, tzinfo=UTC),
                900,
            ),
            dataset_names=("signal_bucket",),
            page_size=1,
        )
    )

    assert resumed.succeeded is True
    assert resumed.new_analysis_events == 1
    assert len(backend.fact_records) == 2
    assert len(backend.outboxes) == 1
    assert checkpoints.checkpoints == {}


def test_sync_does_not_reuse_a_run_cursor_across_closed_windows() -> None:
    registry = DatasetRegistry.load_argus_v2()
    start = datetime(2026, 9, 1, 9, tzinfo=UTC)
    row = fixture("argus_v2_legacy_rows.json", "collector_run")
    backend = FakeIngestionBackend()
    checkpoints = FakeCheckpointRepository()
    service = Sync(
        registry=registry,
        reader_factory=lambda: FakeSourceReader(
            {
                "collector_run": (
                    {
                        **row,
                        "run_id": 99,
                        "started_at": int(start.timestamp() * 1000),
                        "finished_at": int((start + timedelta(minutes=1)).timestamp() * 1000),
                    },
                    {
                        **row,
                        "run_id": 1,
                        "started_at": int((start + timedelta(minutes=15)).timestamp() * 1000),
                        "finished_at": int((start + timedelta(minutes=16)).timestamp() * 1000),
                    },
                )
            }
        ),
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=checkpoints,
        window_commits=FakeWindowCommitRepository(backend=backend),
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("collector_run",),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )

    first = service.execute(
        SyncRequest(
            run_id="sync-run-id-first",
            dataset_version=SYNC_DATASET_VERSION,
            window=TimeWindow(start, start + timedelta(minutes=15), 900),
            dataset_names=("collector_run",),
        )
    )
    second = service.execute(
        SyncRequest(
            run_id="sync-run-id-second",
            dataset_version=SYNC_DATASET_VERSION,
            window=TimeWindow(start + timedelta(minutes=15), start + timedelta(minutes=30), 900),
            dataset_names=("collector_run",),
        )
    )

    assert first.sources["collector_run"].records_written == 1
    assert second.sources["collector_run"].records_written == 1
    assert {record.natural_key for record in backend.fact_records.values()} == {
        (("run_id", 99),),
        (("run_id", 1),),
    }
    assert checkpoints.checkpoints == {}


def test_sync_paginates_a_run_cursor_only_within_its_window() -> None:
    registry = DatasetRegistry.load_argus_v2()
    start = datetime(2026, 9, 1, 9, tzinfo=UTC)
    row = fixture("argus_v2_legacy_rows.json", "collector_run")
    rows = {
        "collector_run": (
            {
                **row,
                "run_id": 1,
                "started_at": int(start.timestamp() * 1000),
                "finished_at": int((start + timedelta(minutes=1)).timestamp() * 1000),
            },
            {
                **row,
                "run_id": 2,
                "started_at": int((start + timedelta(minutes=2)).timestamp() * 1000),
                "finished_at": int((start + timedelta(minutes=3)).timestamp() * 1000),
            },
        )
    }

    class TrackingReader(FakeSourceReader):
        def __init__(self) -> None:
            super().__init__(rows)
            self.afters: list[tuple[object, ...] | None] = []

        def read_page(self, descriptor, window, after, limit):  # type: ignore[no-untyped-def]
            self.afters.append(after)
            return super().read_page(descriptor, window, after, limit)

    backend = FakeIngestionBackend()
    checkpoints = FakeCheckpointRepository()
    reader = TrackingReader()
    service = Sync(
        registry=registry,
        reader_factory=lambda: reader,
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=checkpoints,
        window_commits=FakeWindowCommitRepository(backend=backend),
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("collector_run",),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )

    result = service.execute(
        SyncRequest(
            run_id="sync-run-pagination",
            dataset_version=SYNC_DATASET_VERSION,
            window=TimeWindow(start, start + timedelta(minutes=15), 900),
            dataset_names=("collector_run",),
            page_size=1,
        )
    )

    assert result.sources["collector_run"].records_written == 2
    assert reader.afters == [None, (1,), (2,)]
    assert checkpoints.checkpoints == {}


def test_sync_keeps_temporal_cursor_datasets_across_closed_windows() -> None:
    registry = DatasetRegistry.load_argus_v2()
    start = datetime(2026, 9, 1, 9, tzinfo=UTC)
    row = fixture("argus_v2_legacy_rows.json", "signal_bucket")
    backend = FakeIngestionBackend()
    checkpoints = FakeCheckpointRepository()
    service = Sync(
        registry=registry,
        reader_factory=lambda: FakeSourceReader(
            {
                "signal_bucket": (
                    {**row, "bts": int(start.timestamp() * 1000)},
                    {
                        **row,
                        "bts": int((start + timedelta(minutes=15)).timestamp() * 1000),
                    },
                )
            }
        ),
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=checkpoints,
        window_commits=FakeWindowCommitRepository(backend=backend),
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket",),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )

    first = service.execute(
        SyncRequest(
            run_id="sync-temporal-first",
            dataset_version=SYNC_DATASET_VERSION,
            window=TimeWindow(start, start + timedelta(minutes=15), 900),
            dataset_names=("signal_bucket",),
        )
    )
    second = service.execute(
        SyncRequest(
            run_id="sync-temporal-second",
            dataset_version=SYNC_DATASET_VERSION,
            window=TimeWindow(start + timedelta(minutes=15), start + timedelta(minutes=30), 900),
            dataset_names=("signal_bucket",),
        )
    )

    assert first.sources["signal_bucket"].records_written == 1
    assert second.sources["signal_bucket"].records_written == 1
    assert len(backend.fact_records) == 2
    assert checkpoints.checkpoints == {}


def test_complete_empty_sync_advances_sources_and_preserves_analysis_prior() -> None:
    registry = DatasetRegistry.load_argus_v2()
    backend = FakeIngestionBackend()
    commits = FakeWindowCommitRepository(backend=backend)

    class CompleteEmptyReader(FakeSourceReader):
        def measure_coverage(self, descriptor):  # type: ignore[no-untyped-def]
            return CoverageObservation(
                CoverageStatus.COMPLETE,
                0,
                TimeWindow(
                    datetime(2026, 8, 1, tzinfo=UTC),
                    datetime(2026, 10, 1, tzinfo=UTC),
                    900,
                ),
            )

    service = Sync(
        registry=registry,
        reader_factory=lambda: CompleteEmptyReader({"signal_bucket": (), "live_active_15min": ()}),
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=FakeCheckpointRepository(),
        window_commits=commits,
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket", "live_active_15min"),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )
    window = TimeWindow(
        datetime(2026, 9, 1, tzinfo=UTC),
        datetime(2026, 9, 2, tzinfo=UTC),
        900,
    )
    prior = datetime(2026, 8, 31, 23, 45, tzinfo=UTC)
    commits.watermarks[(SYNC_DATASET_VERSION, "analysis:ANOMALY_DETECTION")] = prior

    result = service.execute(
        SyncRequest(
            run_id="sync-empty",
            dataset_version=SYNC_DATASET_VERSION,
            window=window,
            dataset_names=("signal_bucket", "live_active_15min"),
            analysis_watermarks={"ANOMALY_DETECTION": prior},
        )
    )

    assert result.stage is RunStage.SUCCEEDED
    assert result.analysis_watermarks == {"ANOMALY_DETECTION": window.end}
    assert result.new_analysis_events == 0
    assert backend.outboxes == {}
    assert commits.watermarks[(SYNC_DATASET_VERSION, "source:signal_bucket")] == window.end
    assert commits.watermarks[(SYNC_DATASET_VERSION, "source:live_active_15min")] == window.end
    assert commits.watermarks[(SYNC_DATASET_VERSION, "analysis:ANOMALY_DETECTION")] == window.end


@pytest.mark.parametrize("held_source", ("SYNC_GLOBAL", "argus"))
def test_sync_lease_conflict_returns_skipped_without_constructing_reader(
    held_source: str,
) -> None:
    registry = DatasetRegistry.load_argus_v2()
    leases = FakeLeaseRepository()
    now = datetime(2026, 9, 1, tzinfo=UTC)
    leases.acquire(held_source, "other", now, 300, idempotency_key=f"held:{held_source}")
    called = False

    def reader_factory():  # type: ignore[no-untyped-def]
        nonlocal called
        called = True
        raise AssertionError("reader must not be constructed")

    service = Sync(
        registry=registry,
        reader_factory=reader_factory,
        hot_sink=FakeHotRecordSink(),
        checkpoints=FakeCheckpointRepository(),
        window_commits=FakeWindowCommitRepository(),
        outbox_publisher=OutboxPublisher(FakeOutboxRepository(), FakeAnalysisRequestPublisher()),
        leases=leases,
        manifests=active_manifest_repository(registry),
        clock=lambda: now,
    )

    result = service.execute(
        SyncRequest(
            run_id="sync-locked",
            dataset_version=SYNC_DATASET_VERSION,
            window=TimeWindow(now, now + timedelta(hours=1), 900),
            dataset_names=("signal_bucket",),
        )
    )

    assert result.stage is RunStage.SKIPPED_LOCKED
    assert called is False
    assert set(leases.leases) == {held_source}


def test_sync_commits_same_window_analysis_events_atomically() -> None:
    registry = DatasetRegistry.load_argus_v2()
    row = fixture("argus_v2_legacy_rows.json", "signal_bucket")
    qoe = fixture("argus_v2_legacy_rows.json", "live_qoe_hourly")
    start = datetime(2026, 9, 1, tzinfo=UTC)
    signals = tuple(
        {**row, "bts": int((start + timedelta(minutes=offset)).timestamp() * 1000)}
        for offset in (0, 15, 30, 45)
    )
    hourly = {**qoe, "hour_ts": int(start.timestamp() * 1000)}
    backend = FakeIngestionBackend()
    commits = FakeWindowCommitRepository(backend=backend)
    service = Sync(
        registry=registry,
        reader_factory=lambda: FakeSourceReader(
            {"signal_bucket": signals, "live_qoe_hourly": (hourly,)}
        ),
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=FakeCheckpointRepository(),
        window_commits=commits,
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket",),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )

    result = service.execute(
        SyncRequest(
            run_id="sync-atomic",
            dataset_version=SYNC_DATASET_VERSION,
            window=TimeWindow(
                start,
                start + timedelta(hours=1),
                900,
            ),
            dataset_names=("signal_bucket", "live_qoe_hourly"),
        )
    )

    assert result.new_analysis_events == 2
    assert len(commits.outboxes) == 2
    assert (SYNC_DATASET_VERSION, "analysis:ANOMALY_DETECTION") in commits.watermarks
    assert (SYNC_DATASET_VERSION, "analysis:QOE_FORECAST") in commits.watermarks


def test_sync_keeps_analysis_watermarks_per_event_type_across_two_runs() -> None:
    """A completed anomaly must not suppress a forecast at the same watermark."""
    registry = DatasetRegistry.load_argus_v2()
    start = datetime(2026, 9, 1, tzinfo=UTC)
    signal = fixture("argus_v2_legacy_rows.json", "signal_bucket")
    qoe = fixture("argus_v2_legacy_rows.json", "live_qoe_hourly")
    rows = {
        "signal_bucket": tuple(
            {**signal, "bts": int((start + timedelta(minutes=offset)).timestamp() * 1000)}
            for offset in (0, 15, 30, 45)
        ),
        "live_qoe_hourly": ({**qoe, "hour_ts": int(start.timestamp() * 1000)},),
    }
    backend = FakeIngestionBackend()
    commits = FakeWindowCommitRepository(backend=backend)
    service = Sync(
        registry=registry,
        reader_factory=lambda: FakeSourceReader(rows),
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=FakeCheckpointRepository(),
        window_commits=commits,
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket",),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )
    window = TimeWindow(start, start + timedelta(hours=1), 900)

    first = service.execute(
        SyncRequest(
            run_id="sync-anomaly",
            dataset_version=SYNC_DATASET_VERSION,
            window=window,
            dataset_names=("signal_bucket",),
        )
    )
    second = service.execute(
        SyncRequest(
            run_id="sync-qoe",
            dataset_version=SYNC_DATASET_VERSION,
            window=window,
            dataset_names=("live_qoe_hourly",),
        )
    )

    assert first.analysis_watermarks == {"ANOMALY_DETECTION": window.end}
    assert second.analysis_watermarks == {
        "ANOMALY_DETECTION": window.end,
        "QOE_FORECAST": window.end,
    }
    assert [event.event_type for event in backend.outboxes.values()] == [
        "ANOMALY_DETECTION",
        "QOE_FORECAST",
    ]
    assert commits.watermarks[(SYNC_DATASET_VERSION, "analysis:ANOMALY_DETECTION")] == window.end
    assert commits.watermarks[(SYNC_DATASET_VERSION, "analysis:QOE_FORECAST")] == window.end


def test_sync_adopts_only_the_matching_event_from_a_legacy_combined_watermark() -> None:
    registry = DatasetRegistry.load_argus_v2()
    start = datetime(2026, 9, 1, tzinfo=UTC)
    window = TimeWindow(start, start + timedelta(hours=1), 900)
    signal = fixture("argus_v2_legacy_rows.json", "signal_bucket")
    qoe = fixture("argus_v2_legacy_rows.json", "live_qoe_hourly")
    backend = FakeIngestionBackend()
    commits = FakeWindowCommitRepository(backend=backend)
    anomaly = Sync._event(SYNC_DATASET_VERSION, "ANOMALY_DETECTION", window.end)
    backend.outboxes[anomaly.event_id] = anomaly
    backend.outbox_states[anomaly.event_id] = "PUBLISHED"
    backend.outbox_message_ids[anomaly.event_id] = "receipt-preserved"
    commits.watermarks[(SYNC_DATASET_VERSION, "analysis:ANOMALY_DETECTION+QOE_FORECAST")] = (
        window.end
    )
    service = Sync(
        registry=registry,
        reader_factory=lambda: FakeSourceReader(
            {
                "signal_bucket": tuple(
                    {
                        **signal,
                        "bts": int((start + timedelta(minutes=offset)).timestamp() * 1000),
                    }
                    for offset in (0, 15, 30, 45)
                ),
                "live_qoe_hourly": ({**qoe, "hour_ts": int(start.timestamp() * 1000)},),
            }
        ),
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=FakeCheckpointRepository(),
        window_commits=commits,
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket",),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )

    result = service.execute(
        SyncRequest(
            run_id="sync-legacy-watermark",
            dataset_version=SYNC_DATASET_VERSION,
            window=window,
            dataset_names=("signal_bucket", "live_qoe_hourly"),
        )
    )

    assert result.new_analysis_events == 1
    assert result.analysis_watermarks == {
        "ANOMALY_DETECTION": window.end,
        "QOE_FORECAST": window.end,
    }
    assert commits.watermarks[(SYNC_DATASET_VERSION, "analysis:ANOMALY_DETECTION")] == window.end
    assert commits.watermarks[(SYNC_DATASET_VERSION, "analysis:QOE_FORECAST")] == window.end
    assert set(event.event_type for event in backend.outboxes.values()) == {
        "ANOMALY_DETECTION",
        "QOE_FORECAST",
    }
    assert backend.outbox_states[anomaly.event_id] == "PUBLISHED"
    assert backend.outbox_message_ids[anomaly.event_id] == "receipt-preserved"

    replay = service.execute(
        SyncRequest(
            run_id="sync-legacy-watermark-replay",
            dataset_version=SYNC_DATASET_VERSION,
            window=window,
            dataset_names=("signal_bucket", "live_qoe_hourly"),
        )
    )

    assert replay.new_analysis_events == 0
    assert len(backend.outboxes) == 2


def test_sync_emits_after_two_thousand_contiguous_buckets_with_a_compact_payload() -> None:
    registry = DatasetRegistry.load_argus_v2()
    start = datetime(2026, 9, 1, tzinfo=UTC)
    signal = fixture("argus_v2_legacy_rows.json", "signal_bucket")
    window = TimeWindow(start, start + timedelta(minutes=15 * 2_001), 900)
    backend = FakeIngestionBackend()
    commits = FakeWindowCommitRepository(backend=backend)
    service = Sync(
        registry=registry,
        reader_factory=lambda: FakeSourceReader(
            {
                "signal_bucket": tuple(
                    {
                        **signal,
                        "bts": int((start + timedelta(minutes=15 * offset)).timestamp() * 1000),
                    }
                    for offset in range(2_001)
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
        manifests=active_manifest_repository(registry),
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket",),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )

    result = service.execute(
        SyncRequest(
            run_id="sync-long-contiguous",
            dataset_version=SYNC_DATASET_VERSION,
            window=window,
            dataset_names=("signal_bucket",),
            page_size=3_000,
        )
    )

    assert result.new_analysis_events == 1
    assert len(backend.bucket_evidence[(SYNC_DATASET_VERSION, "source:signal_bucket")]) == 1


def test_validate_checks_environment_contract_and_checksum_without_fact_writes() -> None:
    registry = DatasetRegistry.load_argus_v2()
    checksum = DUMP_SHA256
    calls: list[RestoreRequest] = []

    def verify(request: RestoreRequest) -> RestoreResult:
        calls.append(request)
        return RestoreResult(checksum, 100)

    service = Validate(registry=registry, checksum_verifier=verify)
    request = ValidateRequest(
        RestoreRequest("bucket", "dump.sql.gz", "v1", checksum),
        environment={"AWS_REGION": "us-east-1"},
        required_environment=("AWS_REGION",),
    )

    result = service.execute(request)

    assert result.dataset_count == 23
    assert result.dataset_version == dataset_version("argus", checksum, "2.0", "1.0")
    assert calls == [request.restore_request]
    assert not hasattr(service, "hot_sink")


def test_validate_rejects_a_stream_that_differs_from_the_declared_checksum() -> None:
    """A guarda que sobrevive é o stream contra o sha DECLARADO, não contra o contrato.

    Antes, validate recusava qualquer sha diferente do cravado em registry.py, o
    que impedia validar qualquer outro dump. Agora o operador declara qual dump
    está enviando, e o que é verificado é se o objeto realmente restaurado
    corresponde a essa declaração — que é a propriedade que protege de verdade
    contra dump trocado ou corrompido.
    """
    registry = DatasetRegistry.load_argus_v2()
    declared = "0" * 64

    def verify(_request: RestoreRequest) -> RestoreResult:
        # O objeto restaurado não é o declarado.
        return RestoreResult(compressed_sha256="1" * 64, compressed_bytes=1)

    service = Validate(registry=registry, checksum_verifier=verify)
    request = ValidateRequest(
        RestoreRequest("bucket", "dump.sql.gz", "v1", declared),
        environment={},
    )

    with pytest.raises(ValueError, match="checksum"):
        service.execute(request)


def test_reprocess_requires_allowlisted_dataset_and_bounded_explicit_utc_window() -> None:
    registry = DatasetRegistry.load_argus_v2()
    called = False

    def reader_factory():  # type: ignore[no-untyped-def]
        nonlocal called
        called = True
        return FakeSourceReader({})

    service = Reprocess(
        registry=registry,
        reader_factory=reader_factory,
        hot_sink=FakeHotRecordSink(),
        leases=FakeLeaseRepository(),
        live_sync_configuration=FakeLiveSyncConfiguration(True),
    )
    window = TimeWindow(
        datetime(2026, 9, 1, tzinfo=UTC),
        datetime(2026, 9, 2, tzinfo=UTC),
        3600,
    )

    with pytest.raises(UnknownDatasetError):
        service.execute(ReprocessRequest("run-r", "dsv_a", "signal_point", window))
    with pytest.raises(ValueError, match="bounded"):
        ReprocessRequest(
            "run-r",
            "dsv_a",
            "signal_bucket",
            TimeWindow(window.start, window.start + timedelta(days=32), 3600),
        )

    assert called is False


def test_reprocess_source_lease_conflict_returns_skipped_without_reader() -> None:
    registry = DatasetRegistry.load_argus_v2()
    leases = FakeLeaseRepository()
    now = datetime(2026, 9, 1, tzinfo=UTC)
    leases.acquire("argus", "backfill", now, 300, idempotency_key="backfill-held")
    called = False

    def reader_factory():  # type: ignore[no-untyped-def]
        nonlocal called
        called = True
        raise AssertionError("reader must not be constructed")

    service = Reprocess(
        registry=registry,
        reader_factory=reader_factory,
        hot_sink=FakeHotRecordSink(),
        leases=leases,
        clock=lambda: now,
        live_sync_configuration=FakeLiveSyncConfiguration(True),
    )

    result = service.execute(
        ReprocessRequest(
            "reprocess-locked",
            "dsv_a",
            "signal_bucket",
            TimeWindow(now, now + timedelta(hours=1), 900),
        )
    )

    assert result.stage is RunStage.SKIPPED_LOCKED
    assert called is False
    assert leases.leases["argus"].owner == "backfill"


def test_rebuild_projections_reads_only_persisted_fact_port() -> None:
    registry = DatasetRegistry.load_argus_v2()
    descriptor = registry.require("geo_hourly")
    record = normalize_row(
        descriptor,
        fixture("argus_v2_legacy_rows.json", "geo_hourly"),
    )
    hot_partition = "DATASET#dsv_rebuild#FACT#TS#geo_hourly#20260901"
    repository = FakeProjectionRepository(inputs={("dsv_rebuild", hot_partition): (record,)})
    command = RebuildProjections(ProjectionService(repository), FakeManifestRepository())

    result = command.execute(
        RebuildProjectionsRequest(
            "dsv_rebuild",
            (hot_partition,),
            {"geo_hourly": "year=2026/month=09/day=01"},
        )
    )

    assert result.projections == ()
    assert result.persisted_families == ("geography", "overview")
    assert dict(result.event_counts) == {}
    assert repository.projections


def test_canonical_rebuild_correlates_across_midnight_and_replays_summary() -> None:
    registry = DatasetRegistry.load_argus_v2()
    signal = normalize_row(
        registry.require("signal_bucket"),
        fixture("argus_v2_legacy_rows.json", "signal_bucket"),
    )
    incident = normalize_row(
        registry.require("incidents"),
        fixture("argus_v2_legacy_rows.json", "incidents"),
    )
    signal = replace(
        signal,
        observed_at=datetime(2026, 9, 1, 23, 59, tzinfo=UTC),
        dimensions={**signal.dimensions, "source": "video"},
    )
    incident = replace(
        incident,
        observed_at=datetime(2026, 9, 2, 0, 1, tzinfo=UTC),
        dimensions={**incident.dimensions, "business_service": "video"},
    )

    class CanonicalSets:
        def get(self, dataset_version):  # type: ignore[no-untyped-def]
            return object() if dataset_version == "dsv_rebuild" else None

    class CanonicalSource:
        def iter_batches(self, _canonical_set):  # type: ignore[no-untyped-def]
            yield {("signal_bucket", "year=2026/month=09/day=01"): (signal,)}
            yield {("incidents", "year=2026/month=09/day=02"): (incident,)}

    repository = FakeProjectionRepository()
    command = RebuildProjections(
        ProjectionService(repository),
        FakeManifestRepository(),
        canonical_sets=CanonicalSets(),  # type: ignore[arg-type]
        canonical_source=CanonicalSource(),  # type: ignore[arg-type]
    )
    request = RebuildProjectionsRequest(
        "dsv_rebuild",
        ("DATASET#dsv_rebuild#FACT#TS#signal_bucket#20260901",),
        {"signal_bucket": "year=2026/month=09/day=01"},
    )

    first = command.execute(request)
    second = command.execute(request)

    assert first.event_counts == second.event_counts
    assert first.event_counts["evidence"] == 1
    assert any(
        item.entity_type == "EVIDENCE"
        for item in repository.backend.event_projection_items.values()
    )


def test_rebuild_aggregates_one_partition_across_bounded_repository_pages() -> None:
    registry = DatasetRegistry.load_argus_v2()
    descriptor = registry.require("app_error_model")
    first = normalize_row(
        descriptor,
        fixture("argus_v2_new_rows.json", "app_error_model"),
        NormalizationContext(bot_reliable_from_ms=0),
    )
    second = replace(
        first,
        natural_key=(("date", "2026-08-30"), ("model", "Second Model")),
        measures={**first.measures, "errors": 11, "sessions": 8},
    )
    hot_partition = "DATASET#dsv_rebuild#FACT#TS#app_error_model#20260830"

    class PagedRepository(FakeProjectionRepository):
        def iter_input_batches(self, dataset_version, partition_keys):  # type: ignore[no-untyped-def]
            del dataset_version, partition_keys
            yield (first,)
            yield (second,)

    repository = PagedRepository()
    result = RebuildProjections(ProjectionService(repository), FakeManifestRepository()).execute(
        RebuildProjectionsRequest(
            "dsv_rebuild",
            (hot_partition,),
            {"app_error_model": "year=2026/month=08/day=30"},
        )
    )

    assert result.projections == ()
    projections = tuple(
        item
        for item in repository.backend.projection_operational.values()
        if item.key == "OVERVIEW#app_error_model"
    )
    assert len(projections) == 1
    assert projections[0].payload["metrics"]["errors"] == 20  # type: ignore[index]


def test_projection_service_advances_current_incidents_with_strict_cas() -> None:
    registry = DatasetRegistry.load_argus_v2()
    descriptor = registry.require("incidents")
    first = normalize_row(
        descriptor,
        fixture("argus_v2_legacy_rows.json", "incidents"),
    )
    first = replace(
        first,
        dimensions={**first.dimensions, "state": "open"},
        measures={**first.measures, "resolved_at": None, "closed_at": None},
    )
    second = replace(
        first,
        natural_key=(("sys_id", "synthetic-sys-id-next"),),
        observed_at=first.observed_at + timedelta(days=1),  # type: ignore[operator]
        dimensions={**first.dimensions, "state": "open"},
        measures={**first.measures, "resolved_at": None, "closed_at": None},
    )
    repository = FakeProjectionRepository()
    service = ProjectionService(repository)

    result = service.materialize_records(
        "dsv_multi_day",
        {
            ("incidents", "year=2026/month=09/day=01"): (first,),
            ("incidents", "year=2026/month=09/day=02"): (second,),
        },
    )

    active = tuple(item for item in result.projections if item.key == "INCIDENTS#ACTIVE")
    assert len(active) == 2
    assert (
        repository.backend.projection_operational[
            ("dsv_multi_day", "CURRENT", "INCIDENTS#ACTIVE", "CURRENT")
        ]
        == active[-1]
    )
    assert len(active[-1].payload["incidents"]) == 2  # type: ignore[arg-type]


def test_separate_rebuilds_preserve_and_close_global_active_incidents() -> None:
    registry = DatasetRegistry.load_argus_v2()
    descriptor = registry.require("incidents")
    first = normalize_row(
        descriptor,
        fixture("argus_v2_legacy_rows.json", "incidents"),
    )
    first = replace(
        first,
        dimensions={**first.dimensions, "state": "open"},
        measures={**first.measures, "resolved_at": None, "closed_at": None},
    )
    second = replace(
        first,
        natural_key=(("sys_id", "synthetic-sys-id-next"),),
        observed_at=first.observed_at + timedelta(days=1),  # type: ignore[operator]
    )
    closed_first = replace(
        first,
        observed_at=first.observed_at + timedelta(days=2),  # type: ignore[operator]
        dimensions={**first.dimensions, "state": "closed"},
        measures={
            **first.measures,
            "resolved_at": first.observed_at + timedelta(days=2),  # type: ignore[operator]
            "closed_at": first.observed_at + timedelta(days=2),  # type: ignore[operator]
        },
    )
    keys = tuple(f"DATASET#dsv_rebuild#INCIDENT#TS#incidents#2026090{day}" for day in (1, 2, 3))
    repository = FakeProjectionRepository(
        inputs={
            ("dsv_rebuild", keys[0]): (first,),
            ("dsv_rebuild", keys[1]): (second,),
            ("dsv_rebuild", keys[2]): (closed_first,),
        }
    )
    command = RebuildProjections(ProjectionService(repository), FakeManifestRepository())

    for day, key in enumerate(keys[:2], start=1):
        command.execute(
            RebuildProjectionsRequest(
                "dsv_rebuild",
                (key,),
                {"incidents": f"year=2026/month=09/day=0{day}"},
            )
        )
    current = repository.backend.projection_operational[
        ("dsv_rebuild", "CURRENT", "INCIDENTS#ACTIVE", "CURRENT")
    ]
    assert len(current.payload["incidents"]) == 2  # type: ignore[arg-type]
    before_close = tuple(
        item["incidentId"]
        for item in current.payload["incidents"]  # type: ignore[union-attr]
    )

    command.execute(
        RebuildProjectionsRequest(
            "dsv_rebuild",
            (keys[2],),
            {"incidents": "year=2026/month=09/day=03"},
        )
    )

    current = repository.backend.projection_operational[
        ("dsv_rebuild", "CURRENT", "INCIDENTS#ACTIVE", "CURRENT")
    ]
    remaining = current.payload["incidents"]
    assert isinstance(remaining, tuple)
    assert len(remaining) == 1
    assert remaining[0]["incidentId"] in before_close


def test_explicit_stale_active_incident_revision_is_not_replaced_by_current() -> None:
    registry = DatasetRegistry.load_argus_v2()
    descriptor = registry.require("incidents")
    first = normalize_row(descriptor, fixture("argus_v2_legacy_rows.json", "incidents"))
    first = replace(
        first,
        dimensions={**first.dimensions, "state": "open"},
        measures={**first.measures, "resolved_at": None, "closed_at": None},
    )
    second = replace(
        first,
        natural_key=(("sys_id", "second-incident"),),
        observed_at=first.observed_at + timedelta(days=1),  # type: ignore[operator]
    )
    third = replace(
        first,
        natural_key=(("sys_id", "third-incident"),),
        observed_at=first.observed_at + timedelta(days=2),  # type: ignore[operator]
    )
    repository = FakeProjectionRepository()
    service = ProjectionService(repository)
    service.materialize_records("dsv_stale", {("incidents", "year=2026/month=09/day=01"): (first,)})
    stale = repository.get_current("dsv_stale", "INCIDENTS#ACTIVE", "CURRENT")
    assert stale is not None
    service.materialize_records(
        "dsv_stale", {("incidents", "year=2026/month=09/day=02"): (second,)}
    )
    current = repository.get_current("dsv_stale", "INCIDENTS#ACTIVE", "CURRENT")
    assert current is not None

    with pytest.raises(ConditionalWriteError, match="materialization"):
        service.materialize_records(
            "dsv_stale",
            {("incidents", "year=2026/month=09/day=03"): (third,)},
            expected_revisions={
                (
                    "year=2026/month=09/day=03",
                    "INCIDENTS#ACTIVE",
                    "CURRENT",
                ): stale.materialization_revision
            },
        )

    assert repository.get_current("dsv_stale", "INCIDENTS#ACTIVE", "CURRENT") == current


def test_active_incident_projection_rejects_cardinality_before_building_unbounded_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = DatasetRegistry.load_argus_v2()
    descriptor = registry.require("incidents")
    first = normalize_row(descriptor, fixture("argus_v2_legacy_rows.json", "incidents"))
    first = replace(
        first,
        dimensions={**first.dimensions, "state": "open"},
        measures={**first.measures, "resolved_at": None, "closed_at": None},
    )
    second = replace(first, natural_key=(("sys_id", "second-incident"),))
    repository = FakeProjectionRepository()
    monkeypatch.setattr("application.rebuild_projections._MAX_ACTIVE_INCIDENTS", 1, raising=False)

    with pytest.raises(ValueError, match="active incident cardinality"):
        ProjectionService(repository).materialize_records(
            "dsv_limited",
            {("incidents", "year=2026/month=09/day=01"): (first, second)},
        )

    assert repository.get_current("dsv_limited", "INCIDENTS#ACTIVE", "CURRENT") is None
    assert repository.projections == {}


def test_active_incident_projection_rejects_payload_size_before_any_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = DatasetRegistry.load_argus_v2()
    descriptor = registry.require("incidents")
    incident = normalize_row(descriptor, fixture("argus_v2_legacy_rows.json", "incidents"))
    incident = replace(
        incident,
        dimensions={**incident.dimensions, "state": "open"},
        measures={**incident.measures, "resolved_at": None, "closed_at": None},
    )
    repository = FakeProjectionRepository()
    monkeypatch.setattr(
        "application.rebuild_projections._MAX_ACTIVE_PAYLOAD_BYTES", 1, raising=False
    )

    with pytest.raises(ValueError, match="active incident payload"):
        ProjectionService(repository).materialize_records(
            "dsv_payload_limited",
            {("incidents", "year=2026/month=09/day=01"): (incident,)},
        )

    assert repository.projections == {}


def test_rebuild_rejects_a_valid_partition_without_persisted_facts() -> None:
    command = RebuildProjections(
        ProjectionService(FakeProjectionRepository()), FakeManifestRepository()
    )

    with pytest.raises(ValueError, match="no facts"):
        command.execute(
            RebuildProjectionsRequest(
                "dsv_empty",
                ("DATASET#dsv_empty#FACT#TS#geo_hourly#20260901",),
                {"geo_hourly": "year=2026/month=09/day=01"},
            )
        )


def test_rebuild_preflights_every_requested_partition_before_any_projection_write() -> None:
    registry = DatasetRegistry.load_argus_v2()
    descriptor = registry.require("geo_hourly")
    record = normalize_row(
        descriptor,
        fixture("argus_v2_legacy_rows.json", "geo_hourly"),
    )
    present = "DATASET#dsv_preflight#FACT#TS#geo_hourly#20260901"
    missing = "DATASET#dsv_preflight#FACT#TS#live_qoe_hourly#20260901"
    repository = FakeProjectionRepository(inputs={("dsv_preflight", present): (record,)})

    with pytest.raises(ValueError, match="missing facts"):
        RebuildProjections(ProjectionService(repository), FakeManifestRepository()).execute(
            RebuildProjectionsRequest(
                "dsv_preflight",
                (present, missing),
                {
                    "geo_hourly": "year=2026/month=09/day=01",
                    "live_qoe_hourly": "year=2026/month=09/day=01",
                },
            )
        )

    assert repository.projections == {}


def test_rebuild_materializes_from_the_single_preflight_snapshot() -> None:
    registry = DatasetRegistry.load_argus_v2()
    descriptor = registry.require("geo_hourly")
    record = normalize_row(
        descriptor,
        fixture("argus_v2_legacy_rows.json", "geo_hourly"),
    )
    partition_key = "DATASET#dsv_snapshot#FACT#TS#geo_hourly#20260901"

    class ExpiringInputRepository(FakeProjectionRepository):
        reads = 0

        def iter_input_batches(self, dataset_version, partition_keys):  # type: ignore[no-untyped-def]
            del dataset_version, partition_keys
            self.reads += 1
            if self.reads == 1:
                yield (record,)

    repository = ExpiringInputRepository()

    result = RebuildProjections(ProjectionService(repository), FakeManifestRepository()).execute(
        RebuildProjectionsRequest(
            "dsv_snapshot",
            (partition_key,),
            {"geo_hourly": "year=2026/month=09/day=01"},
        )
    )

    assert repository.reads == 1
    assert result.catalog_item_counts == {("geo_hourly", "year=2026/month=09/day=01"): 4}
    assert any(item.key == "GEOGRAPHY#errorRate" for item in repository.projections.values())


def test_rebuild_rejects_an_event_fact_outside_the_requested_day() -> None:
    registry = DatasetRegistry.load_argus_v2()
    descriptor = registry.require("geo_hourly")
    record = normalize_row(
        descriptor,
        fixture("argus_v2_legacy_rows.json", "geo_hourly"),
    )
    record = replace(record, observed_at=datetime(2026, 9, 2, tzinfo=UTC))
    key = "DATASET#dsv_rebuild#FACT#TS#geo_hourly#20260901"
    command = RebuildProjections(
        ProjectionService(FakeProjectionRepository(inputs={("dsv_rebuild", key): (record,)})),
        FakeManifestRepository(),
    )

    with pytest.raises(ValueError, match="event-time fact differs"):
        command.execute(
            RebuildProjectionsRequest(
                "dsv_rebuild",
                (key,),
                {"geo_hourly": "year=2026/month=09/day=01"},
            )
        )


def test_rebuild_rejects_an_active_dataset_before_reading_or_writing_projections() -> None:
    registry = DatasetRegistry.load_argus_v2()
    version = "dsv_active"
    partition_key = "DATASET#dsv_active#FACT#TS#geo_hourly#20260901"

    class NoActiveReads(FakeProjectionRepository):
        def iter_input_batches(self, dataset_version, partition_keys):  # type: ignore[no-untyped-def]
            del dataset_version, partition_keys
            raise AssertionError("active rebuild must not query persisted facts")

    repository = NoActiveReads()
    manifests = FakeManifestRepository(
        active_manifest(
            registry,
            version,
            source_watermark=datetime(2026, 9, 1, tzinfo=UTC),
        )
    )
    command = RebuildProjections(ProjectionService(repository), manifests)

    with pytest.raises(ConditionalWriteError, match="active"):
        command.execute(
            RebuildProjectionsRequest(
                version,
                (partition_key,),
                {"geo_hourly": "year=2026/month=09/day=01"},
            )
        )

    assert repository.projections == {}


def test_snapshot_partition_uses_persistence_day_for_projection_watermark() -> None:
    registry = DatasetRegistry.load_argus_v2()
    descriptor = registry.require("collector_run")
    record = normalize_row(
        descriptor,
        fixture("argus_v2_legacy_rows.json", "collector_run"),
    )
    source_observed = datetime(2026, 8, 29, 11, 0, tzinfo=UTC)
    record = replace(record, observed_at=source_observed, window=None)
    repository = FakeProjectionRepository()

    result = ProjectionService(repository).materialize_records(
        "dsv_snapshot",
        {("collector_run", "snapshot_date=2026-09-01"): (record,)},
    )

    projection = next(item for item in result.projections if item.key.startswith("MONITORING#"))
    assert projection.payload["observedAt"] == source_observed
    assert projection.payload["observedThrough"] == datetime(2026, 9, 1, tzinfo=UTC)


@pytest.mark.parametrize(
    "families",
    (("overview", "overview"), ("overview", "unsupported")),
)
def test_projection_build_result_rejects_non_closed_family_evidence(
    families: tuple[str, ...],
) -> None:
    with pytest.raises(ValueError, match="persisted_families"):
        ProjectionBuildResult((), {}, families)


def test_command_dtos_reject_malformed_nested_values() -> None:
    window = TimeWindow(
        datetime(2026, 9, 1, tzinfo=UTC),
        datetime(2026, 9, 2, tzinfo=UTC),
        900,
    )

    with pytest.raises(ValueError, match="event types"):
        SyncRequest(
            run_id="sync-invalid",
            dataset_version="dsv_invalid",
            window=window,
            dataset_names=("signal_bucket",),
            analysis_watermarks={"UNKNOWN": window.end},
        )
    with pytest.raises(ValueError, match="error"):
        SyncSourceResult("signal_bucket", False, 0, 0, None, "")
    with pytest.raises(TypeError, match="SyncSourceResult"):
        SyncResult({"signal_bucket": object()}, {}, 0)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="expected_revisions"):
        RebuildProjectionsRequest(
            "dsv_invalid",
            ("DATASET#dsv_invalid#INCIDENT#TS#incidents#20260901",),
            {"incidents": "year=2026/month=09/day=01"},
            {("year=2026/month=09/day=01", "INCIDENTS#ACTIVE", "CURRENT"): "bad"},
        )
