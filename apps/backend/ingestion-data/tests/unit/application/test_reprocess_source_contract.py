"""Verify source reprocessing preserves the declared ingestion data contract."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from application.reprocess import Reprocess, ReprocessRequest
from contracts.registry import DatasetRegistry
from domain.models import TimeWindow
from domain.run import RunStage
from tests.fakes import (
    FakeHotRecordSink,
    FakeLeaseRepository,
    FakeLiveSyncConfiguration,
    FakeSourceReader,
)


def _window() -> TimeWindow:
    start = datetime(2026, 9, 1, tzinfo=UTC)
    return TimeWindow(start, start + timedelta(minutes=15), 900)


def test_disabled_reprocess_skips_before_dataset_lookup_lease_or_reader() -> None:
    def forbidden_reader() -> FakeSourceReader:
        raise AssertionError("disabled reprocess must not construct a reader")

    class ForbiddenLeases(FakeLeaseRepository):
        def acquire(self, *args, **kwargs):
            raise AssertionError("disabled reprocess must not acquire a lease")

    configuration = FakeLiveSyncConfiguration(False)
    service = Reprocess(
        registry=DatasetRegistry.load_argus_v2(),
        reader_factory=forbidden_reader,
        hot_sink=FakeHotRecordSink(),
        leases=ForbiddenLeases(),
        live_sync_configuration=configuration,
    )

    result = service.execute(ReprocessRequest("disabled", "dsv-a", "unknown", _window()))

    assert result.stage is RunStage.SKIPPED_DISABLED
    assert (result.records_read, result.records_written, result.records_unchanged) == (0, 0, 0)
    assert configuration.reads == 1


@pytest.mark.parametrize("enabled", [False, None])
def test_reprocess_gate_precedes_dependency_factories(enabled: bool | None) -> None:
    class Configuration(FakeLiveSyncConfiguration):
        def is_enabled(self) -> bool:
            self.reads += 1
            if enabled is None:
                raise RuntimeError("configuration unavailable")
            return enabled

    def forbidden():
        raise AssertionError("disabled reprocess must not resolve dependencies")

    configuration = Configuration(False)
    service = Reprocess(
        registry=DatasetRegistry.load_argus_v2(),
        reader_factory=forbidden,
        hot_sink=forbidden,
        leases=forbidden,
        live_sync_configuration=configuration,
    )
    request = ReprocessRequest("disabled", "dsv-a", "unknown", _window())
    if enabled is None:
        with pytest.raises(RuntimeError, match="configuration unavailable"):
            service.execute(request)
    else:
        assert service.execute(request).stage is RunStage.SKIPPED_DISABLED
    assert configuration.reads == 1


@pytest.mark.parametrize("dataset", ("signal_meta", "live_event_sde"))
def test_reprocess_rejects_snapshot_date_datasets_before_constructing_reader(
    dataset: str,
) -> None:
    reader_constructed = False

    def reader_factory() -> FakeSourceReader:
        nonlocal reader_constructed
        reader_constructed = True
        raise AssertionError("reader must remain lazy for an ineligible dataset")

    service = Reprocess(
        registry=DatasetRegistry.load_argus_v2(),
        reader_factory=reader_factory,
        hot_sink=FakeHotRecordSink(),
        leases=FakeLeaseRepository(),
        live_sync_configuration=FakeLiveSyncConfiguration(True),
    )

    with pytest.raises(ValueError, match="bounded live-window reprocess"):
        service.execute(ReprocessRequest("run-r", "dsv-a", dataset, _window()))

    assert reader_constructed is False


def test_reprocess_accepts_an_allowlisted_event_time_dataset_from_live_reader() -> None:
    constructed = 0
    configuration = FakeLiveSyncConfiguration(True)

    def reader_factory() -> FakeSourceReader:
        nonlocal constructed
        constructed += 1
        configuration.enabled = False
        return FakeSourceReader({"signal_bucket": ()})

    service = Reprocess(
        registry=DatasetRegistry.load_argus_v2(),
        reader_factory=reader_factory,
        hot_sink=FakeHotRecordSink(),
        leases=FakeLeaseRepository(),
        live_sync_configuration=configuration,
    )

    result = service.execute(ReprocessRequest("run-r", "dsv-a", "signal_bucket", _window()))

    assert result.stage is RunStage.SUCCEEDED
    assert result.records_read == 0
    assert constructed == 1
    assert configuration.reads == 1

    second = service.execute(ReprocessRequest("next", "dsv-a", "signal_bucket", _window()))
    assert second.stage is RunStage.SKIPPED_DISABLED
    assert constructed == 1
    assert configuration.reads == 2
