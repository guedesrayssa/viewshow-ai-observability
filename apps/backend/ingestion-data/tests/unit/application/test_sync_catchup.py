"""Verify catch-up sync safely coordinates missed ingestion source windows."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from adapters.telemetry.observed_ports import ObservedSourceReader
from application.publish_outbox import OutboxPublisher
from application.sync import Sync, SyncRequest, SyncResult, SyncSourceResult
from application.sync_catchup import SyncCatchup, SyncCatchupRequest
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
    FakeLiveSyncConfiguration,
    FakeManifestRepository,
    FakeMetricsPublisher,
    FakeOutboxRepository,
    FakeSourceReader,
    FakeWindowCommitRepository,
    valid_active_manifest,
)

# O sha do dump é evidência OPERACIONAL, não contrato: cada execução declara
# qual dump restaurou. Os testes declaram do mesmo jeito que o operador declara.
DUMP_SHA256 = "c1d86081679d66c392b63710bda4517b047f029c5403ad1502d731ab5ac126ea"


def _at(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 9, 1, hour, minute, tzinfo=UTC)


def _active_manifest_repository(registry: DatasetRegistry) -> tuple[str, FakeManifestRepository]:
    snapshot = registry.snapshot
    version = dataset_version(
        str(snapshot["sourceSystem"]),
        DUMP_SHA256,
        str(snapshot["physicalContractVersion"]),
        str(snapshot["canonicalSchemaVersion"]),
    )
    return (
        version,
        FakeManifestRepository(
            valid_active_manifest(
                registry.names(),
                version,
                source_watermark=_at(0),
                physical_contract_version=str(snapshot["physicalContractVersion"]),
                canonical_schema_version=str(snapshot["canonicalSchemaVersion"]),
                dump_checksum_sha256=DUMP_SHA256,
            )
        ),
    )


def _request(
    *,
    source_watermarks: dict[str, datetime] | None = None,
    analysis_watermarks: dict[str, datetime] | None = None,
    max_windows: int = 96,
) -> SyncCatchupRequest:
    return SyncCatchupRequest(
        run_id="sync-parent",
        dataset_version="dsv_sync",
        latest_window=TimeWindow(_at(9, 45), _at(10), 900),
        dataset_names=("signal_bucket", "live_qoe_hourly"),
        source_watermarks=source_watermarks or {"signal_bucket": _at(9)},
        analysis_watermarks={"ANOMALY_DETECTION": _at(9), "QOE_FORECAST": _at(9)}
        if analysis_watermarks is None
        else analysis_watermarks,
        max_windows=max_windows,
    )


class RecordingSync:
    def __init__(self, result_for):  # type: ignore[no-untyped-def]
        self.requests: list[SyncRequest] = []
        self._result_for = result_for

    def execute(self, request: SyncRequest) -> SyncResult:
        self.requests.append(request)
        return self._result_for(request, len(self.requests))


def test_disabled_catchup_never_starts_a_window_and_preserves_watermarks() -> None:
    def forbidden(_request: SyncRequest, _call: int) -> SyncResult:
        raise AssertionError("disabled catchup must not execute sync")

    runner = RecordingSync(forbidden)
    configuration = FakeLiveSyncConfiguration(False)
    request = _request()

    result = SyncCatchup(runner, configuration).execute(request)

    assert result.stage is RunStage.SKIPPED_DISABLED
    assert result.sources == {}
    assert result.analysis_watermarks == request.analysis_watermarks
    assert result.new_analysis_events == 0
    assert runner.requests == []
    assert configuration.reads == 1


def test_catchup_checks_configuration_once_and_finishes_started_windows() -> None:
    configuration = FakeLiveSyncConfiguration(True)

    def disable_after_start(request: SyncRequest, call: int) -> SyncResult:
        configuration.enabled = False
        return _successful_result(request, call)

    runner = RecordingSync(disable_after_start)
    result = SyncCatchup(runner, configuration).execute(_request())

    assert result.stage is RunStage.SUCCEEDED
    assert len(runner.requests) == 4
    assert configuration.reads == 1


def test_unavailable_configuration_never_starts_a_sync_window() -> None:
    class UnavailableConfiguration(FakeLiveSyncConfiguration):
        def is_enabled(self) -> bool:
            raise RuntimeError("configuration unavailable")

    runner = RecordingSync(_successful_result)
    with pytest.raises(RuntimeError, match="configuration unavailable"):
        SyncCatchup(runner, UnavailableConfiguration(True)).execute(_request())
    assert runner.requests == []


def _successful_result(request: SyncRequest, _call: int) -> SyncResult:
    analysis_watermarks = {"ANOMALY_DETECTION": request.window.end}
    if int(request.window.end.timestamp()) % 3600 == 0:
        analysis_watermarks["QOE_FORECAST"] = request.window.end
    return SyncResult(
        {
            dataset: SyncSourceResult(dataset, True, 1, 0, request.window.end)
            for dataset in request.dataset_names
        },
        analysis_watermarks,
        1,
    )


def test_catchup_processes_each_closed_window_from_the_oldest_durable_watermark() -> None:
    sync = RecordingSync(_successful_result)

    result = SyncCatchup(sync, FakeLiveSyncConfiguration(True)).execute(_request())

    assert [request.window for request in sync.requests] == [
        TimeWindow(_at(9), _at(9, 15), 900),
        TimeWindow(_at(9, 15), _at(9, 30), 900),
        TimeWindow(_at(9, 30), _at(9, 45), 900),
        TimeWindow(_at(9, 45), _at(10), 900),
    ]
    assert len({request.run_id for request in sync.requests}) == 4
    assert result.sources["signal_bucket"].records_written == 4
    assert result.sources["signal_bucket"].watermark == _at(10)
    assert result.analysis_watermarks == {
        "ANOMALY_DETECTION": _at(10),
        "QOE_FORECAST": _at(10),
    }
    assert result.new_analysis_events == 4


def test_catchup_starts_the_next_full_window_after_a_non_aligned_observation() -> None:
    first_window = TimeWindow(_at(9), _at(9, 15), 900)
    first_result = SyncResult(
        {
            "signal_bucket": SyncSourceResult(
                "signal_bucket",
                True,
                1,
                0,
                first_window.end,
                latest_observed_at=_at(9, 7),
            )
        },
        {},
        0,
    )
    sync = RecordingSync(_successful_result)

    SyncCatchup(sync, FakeLiveSyncConfiguration(True)).execute(
        SyncCatchupRequest(
            run_id="sync-next",
            dataset_version="dsv_sync",
            latest_window=TimeWindow(_at(9, 15), _at(9, 30), 900),
            dataset_names=("signal_bucket", "live_qoe_hourly"),
            source_watermarks={"signal_bucket": first_result.sources["signal_bucket"].watermark},
            analysis_watermarks={
                "ANOMALY_DETECTION": first_window.end,
                "QOE_FORECAST": first_window.end,
            },
        )
    )

    assert sync.requests[0].window == TimeWindow(_at(9, 15), _at(9, 30), 900)


def test_catchup_recovers_one_closed_window_for_an_absent_analysis_authority() -> None:
    sync = RecordingSync(_successful_result)

    result = SyncCatchup(sync, FakeLiveSyncConfiguration(True)).execute(
        SyncCatchupRequest(
            run_id="sync-missing-analysis",
            dataset_version="dsv_sync",
            latest_window=TimeWindow(_at(9, 45), _at(10), 900),
            dataset_names=("signal_bucket", "live_qoe_hourly"),
            source_watermarks={"signal_bucket": _at(10), "live_qoe_hourly": _at(10)},
            analysis_watermarks={"ANOMALY_DETECTION": _at(10)},
        )
    )

    assert [request.window for request in sync.requests] == [TimeWindow(_at(9, 45), _at(10), 900)]
    assert result.analysis_watermarks == {
        "ANOMALY_DETECTION": _at(10),
        "QOE_FORECAST": _at(10),
    }


def test_catchup_starts_from_the_oldest_lagging_analysis_authority() -> None:
    sync = RecordingSync(_successful_result)

    result = SyncCatchup(sync, FakeLiveSyncConfiguration(True)).execute(
        SyncCatchupRequest(
            run_id="sync-analysis-lag",
            dataset_version="dsv_sync",
            latest_window=TimeWindow(_at(9, 45), _at(10), 900),
            dataset_names=("signal_bucket", "live_qoe_hourly"),
            source_watermarks={"signal_bucket": _at(10), "live_qoe_hourly": _at(10)},
            analysis_watermarks={
                "ANOMALY_DETECTION": _at(9, 15),
                "QOE_FORECAST": _at(9, 30),
            },
        )
    )

    assert [request.window for request in sync.requests] == [
        TimeWindow(_at(9, 15), _at(9, 30), 900),
        TimeWindow(_at(9, 30), _at(9, 45), 900),
        TimeWindow(_at(9, 45), _at(10), 900),
    ]
    assert result.analysis_watermarks == {
        "ANOMALY_DETECTION": _at(10),
        "QOE_FORECAST": _at(10),
    }


def test_catchup_treats_hourly_qoe_as_current_before_its_next_boundary() -> None:
    sync = RecordingSync(_successful_result)

    result = SyncCatchup(sync, FakeLiveSyncConfiguration(True)).execute(
        SyncCatchupRequest(
            run_id="sync-qoe-current",
            dataset_version="dsv_sync",
            latest_window=TimeWindow(_at(9, 30), _at(9, 45), 900),
            dataset_names=("signal_bucket", "live_qoe_hourly"),
            source_watermarks={"signal_bucket": _at(9, 45), "live_qoe_hourly": _at(9, 45)},
            analysis_watermarks={"ANOMALY_DETECTION": _at(9, 45), "QOE_FORECAST": _at(9)},
        )
    )

    assert sync.requests == []
    assert result.sources == {}


def test_catchup_does_not_reopen_an_hourly_source_before_its_next_boundary() -> None:
    sync = RecordingSync(_successful_result)

    result = SyncCatchup(sync, FakeLiveSyncConfiguration(True)).execute(
        SyncCatchupRequest(
            run_id="sync-hourly-source-current",
            dataset_version="dsv_sync",
            latest_window=TimeWindow(_at(9, 30), _at(9, 45), 900),
            dataset_names=("live_qoe_hourly",),
            source_watermarks={"live_qoe_hourly": _at(9)},
            analysis_watermarks={"ANOMALY_DETECTION": _at(9, 45), "QOE_FORECAST": _at(9)},
            source_grain_seconds={"live_qoe_hourly": 3600},
        )
    )

    assert sync.requests == []
    assert result.sources == {}
    assert result.analysis_watermarks == {
        "ANOMALY_DETECTION": _at(9, 45),
        "QOE_FORECAST": _at(9),
    }


def test_catchup_advances_through_an_empty_window_without_skipping_later_windows() -> None:
    def result_for(request: SyncRequest, call: int) -> SyncResult:
        written = 0 if call == 1 else 1
        return SyncResult(
            {
                dataset: SyncSourceResult(dataset, True, written, 0, request.window.end)
                for dataset in request.dataset_names
            },
            (
                {
                    "ANOMALY_DETECTION": request.window.end,
                    "QOE_FORECAST": request.window.end,
                }
                if int(request.window.end.timestamp()) % 3600 == 0
                else {"ANOMALY_DETECTION": request.window.end}
            ),
            0,
        )

    sync = RecordingSync(result_for)

    result = SyncCatchup(sync, FakeLiveSyncConfiguration(True)).execute(_request())

    assert [request.window.end for request in sync.requests] == [
        _at(9, 15),
        _at(9, 30),
        _at(9, 45),
        _at(10),
    ]
    assert result.sources["signal_bucket"].watermark == _at(10)
    assert result.analysis_watermarks == {
        "ANOMALY_DETECTION": _at(10),
        "QOE_FORECAST": _at(10),
    }

    follow_up = SyncCatchup(sync, FakeLiveSyncConfiguration(True)).execute(
        SyncCatchupRequest(
            run_id="sync-empty-follow-up",
            dataset_version="dsv_sync",
            latest_window=TimeWindow(_at(10), _at(10, 15), 900),
            dataset_names=("signal_bucket", "live_qoe_hourly"),
            source_watermarks={
                dataset: source.watermark
                for dataset, source in result.sources.items()
                if source.watermark is not None
            },
            analysis_watermarks=result.analysis_watermarks,
        )
    )

    assert [request.window for request in sync.requests[-1:]] == [
        TimeWindow(_at(10), _at(10, 15), 900)
    ]
    assert follow_up.analysis_watermarks == {
        "ANOMALY_DETECTION": _at(10, 15),
        "QOE_FORECAST": _at(10),
    }


def test_catchup_stops_before_the_window_after_a_partial_result() -> None:
    def result_for(request: SyncRequest, call: int) -> SyncResult:
        failed = call == 2
        return SyncResult(
            {
                dataset: SyncSourceResult(
                    dataset,
                    not failed,
                    1,
                    0,
                    request.window.end,
                    "source failed" if failed else None,
                )
                for dataset in request.dataset_names
            },
            (
                {
                    "ANOMALY_DETECTION": request.window.end,
                    "QOE_FORECAST": request.window.end,
                }
                if int(request.window.end.timestamp()) % 3600 == 0
                else {"ANOMALY_DETECTION": request.window.end}
            ),
            1 if not failed else 0,
            stage=RunStage.PARTIAL if failed else RunStage.SUCCEEDED,
        )

    sync = RecordingSync(result_for)

    result = SyncCatchup(sync, FakeLiveSyncConfiguration(True)).execute(_request())

    assert [request.window.end for request in sync.requests] == [_at(9, 15), _at(9, 30)]
    assert result.stage is RunStage.PARTIAL
    assert result.sources["signal_bucket"].succeeded is False
    assert result.analysis_watermarks == {
        "ANOMALY_DETECTION": _at(9, 30),
        "QOE_FORECAST": _at(9),
    }


def test_catchup_preserves_per_dataset_and_per_analysis_watermarks() -> None:
    def result_for(request: SyncRequest, call: int) -> SyncResult:
        return SyncResult(
            {
                dataset: SyncSourceResult(
                    dataset,
                    True,
                    1,
                    0,
                    request.window.end,
                    latest_observed_at=request.window.start
                    + timedelta(minutes=5 if dataset == "signal_bucket" else 10),
                )
                for dataset in request.dataset_names
            },
            {
                "ANOMALY_DETECTION": request.window.end,
                "QOE_FORECAST": _at(10) if call == 1 else request.window.end,
            },
            2,
        )

    sync = RecordingSync(result_for)

    result = SyncCatchup(sync, FakeLiveSyncConfiguration(True)).execute(
        _request(source_watermarks={"signal_bucket": _at(9), "live_qoe_hourly": _at(9, 30)})
    )

    assert all(
        request.dataset_names == ("signal_bucket", "live_qoe_hourly") for request in sync.requests
    )
    assert result.sources["signal_bucket"].watermark == _at(10)
    assert result.sources["live_qoe_hourly"].watermark == _at(10)
    assert result.sources["signal_bucket"].latest_observed_at == _at(9, 50)
    assert result.sources["live_qoe_hourly"].latest_observed_at == _at(9, 55)
    assert result.analysis_watermarks == {
        "ANOMALY_DETECTION": _at(10),
        "QOE_FORECAST": _at(10),
    }
    assert result.new_analysis_events == 8


def test_catchup_returns_partial_after_the_configured_window_cap() -> None:
    sync = RecordingSync(_successful_result)

    result = SyncCatchup(sync, FakeLiveSyncConfiguration(True)).execute(_request(max_windows=2))

    assert [request.window.end for request in sync.requests] == [_at(9, 15), _at(9, 30)]
    assert result.stage is RunStage.PARTIAL
    assert result.publication_error == "sync catch-up limit reached with 2 windows remaining"


def test_catchup_replays_the_same_window_sub_runs_deterministically() -> None:
    sync = RecordingSync(_successful_result)
    command = SyncCatchup(sync, FakeLiveSyncConfiguration(True))
    request = _request()

    first = command.execute(request)
    second = command.execute(request)

    assert [item.run_id for item in sync.requests[:4]] == [
        item.run_id for item in sync.requests[4:]
    ]
    assert first == second


def test_empty_catchup_does_not_emit_coverage_or_freshness_from_window_completion() -> None:
    metrics = FakeMetricsPublisher()
    backend = FakeIngestionBackend()
    reader = ObservedSourceReader(
        FakeSourceReader({"signal_bucket": ()}),
        metrics,
        command="sync",
        source_mode="live",
        clock=lambda: _at(10, 7),
    )
    registry = DatasetRegistry.load_argus_v2()
    version, manifests = _active_manifest_repository(registry)
    service = Sync(
        registry=registry,
        reader_factory=lambda: reader,
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=FakeCheckpointRepository(),
        window_commits=FakeWindowCommitRepository(backend=backend),
        outbox_publisher=OutboxPublisher(
            FakeOutboxRepository(backend=backend), FakeAnalysisRequestPublisher()
        ),
        leases=FakeLeaseRepository(),
        manifests=manifests,
        analysis_dependencies={
            "ANOMALY_DETECTION": ("signal_bucket",),
            "QOE_FORECAST": ("live_qoe_hourly",),
        },
    )

    result = SyncCatchup(service, FakeLiveSyncConfiguration(True)).execute(
        SyncCatchupRequest(
            run_id="sync-empty",
            dataset_version=version,
            latest_window=TimeWindow(_at(9, 45), _at(10), 900),
            dataset_names=("signal_bucket",),
        )
    )

    assert result.sources["signal_bucket"].watermark == _at(10)
    assert result.sources["signal_bucket"].latest_observed_at is None
    assert result.analysis_watermarks == {"ANOMALY_DETECTION": _at(10)}
    assert [name for _kind, name, _value, _dimensions in metrics.measurements] == [
        "MySqlPageDurationMs",
        "MySqlPageRows",
    ]
