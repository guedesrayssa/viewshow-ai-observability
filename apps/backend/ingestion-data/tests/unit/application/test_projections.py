"""Verify canonical records build deterministic ingestion projections."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import cast

import pytest

from application.projections.geography import build_geography
from application.projections.incidents import build_incident_views
from application.projections.monitoring import build_monitoring
from application.projections.overview import build_overview
from application.read_canonical_set import CanonicalRecordSource
from application.rebuild_projections import (
    ProjectionService,
    RebuildProjections,
    RebuildProjectionsRequest,
    _PartitionAccumulator,
)
from domain.models import CanonicalRecord, CanonicalValue, RecordType, Scalar, TimeWindow
from domain.quality import CoverageStatus
from ports import ArchiveDependency
from ports.analysis_facts import AnalysisFactSink
from tests.fakes import FakeCanonicalSetStore, FakeManifestRepository, FakeProjectionRepository
from tests.unit.application.test_read_canonical_set import PARTITION, _canonical_set, _record

DAY = datetime(2026, 9, 8, tzinfo=UTC)


def record(
    dataset: str,
    record_type: RecordType,
    *,
    observed_at: datetime = DAY,
    dimensions: dict[str, object] | None = None,
    measures: dict[str, object] | None = None,
    quality: dict[str, object] | None = None,
    quality_flags: tuple[str, ...] = (),
    grain_seconds: int | None = 3600,
) -> CanonicalRecord:
    return CanonicalRecord(
        "1.0",
        record_type,
        "argus",
        dataset,
        (("id", f"{dataset}-{observed_at.isoformat()}"),),
        observed_at,
        (
            TimeWindow(observed_at, observed_at + timedelta(seconds=grain_seconds), grain_seconds)
            if grain_seconds is not None
            else None
        ),
        cast(dict[str, CanonicalValue], dimensions or {}),
        cast(dict[str, CanonicalValue], measures or {}),
        cast(dict[str, Scalar], quality or {"coveragePolicy": "known_upstream_lag"}),
        quality_flags,
    )


def test_overview_keeps_human_errors_null_when_bot_coverage_is_ambiguous() -> None:
    source = record(
        "error_cat_hourly",
        RecordType.DIMENSIONAL_METRIC_AGGREGATE,
        measures={"errors": 8, "errorsBot": 0, "humanErrors": None},
        quality={
            "coveragePolicy": "known_upstream_lag",
            "botCoverageStatus": "ambiguous_default_zero",
        },
    )

    view = build_overview((source,))

    assert view.metrics["errors"] == 8
    assert view.metrics["botErrors"] == 0
    assert view.metrics["humanErrors"] is None
    assert view.coverage.status is CoverageStatus.PARTIAL


def test_overview_discards_inconsistent_human_errors_under_ambiguous_bot_coverage() -> None:
    source = record(
        "error_cat_hourly",
        RecordType.DIMENSIONAL_METRIC_AGGREGATE,
        measures={"errors": 8, "errorsBot": 0, "humanErrors": 8},
        quality={
            "coveragePolicy": "known_upstream_lag",
            "botCoverageStatus": "ambiguous_default_zero",
        },
    )

    assert build_overview((source,)).metrics["humanErrors"] is None


def test_overview_never_divides_by_absent_or_zero_sessions() -> None:
    absent = record(
        "error_cat_hourly",
        RecordType.DIMENSIONAL_METRIC_AGGREGATE,
        measures={"errors": 2, "errorsBot": 1, "humanErrors": 1},
        quality={"coveragePolicy": "known_upstream_lag", "botCoverageStatus": "reliable"},
    )
    zero = record(
        "live_qoe_hourly",
        RecordType.DIMENSIONAL_METRIC_AGGREGATE,
        measures={"sessions": 0, "errors": 2, "startup_errors": 1},
    )

    assert build_overview((absent,)).metrics["errorRate"] is None
    assert build_overview((zero,)).metrics["errorRate"] is None


def test_overview_uses_decimal_arithmetic_and_is_deterministic() -> None:
    first = record(
        "live_qoe_hourly",
        RecordType.DIMENSIONAL_METRIC_AGGREGATE,
        observed_at=DAY,
        measures={"sessions": Decimal("3"), "errors": Decimal("1")},
    )
    second = replace(
        first,
        natural_key=(("id", "second"),),
        observed_at=DAY + timedelta(hours=1),
        window=TimeWindow(DAY + timedelta(hours=1), DAY + timedelta(hours=2), 3600),
        measures={"sessions": Decimal("1"), "errors": Decimal("1")},
    )

    forward = build_overview((first, second))
    reverse = build_overview((second, first))

    assert forward == reverse
    assert forward.metrics["errorRate"] == Decimal("0.5")
    assert forward.projection_version == "1.0"
    assert forward.formula_version == "1.0"
    assert forward.input_watermarks[0].observed_at == DAY + timedelta(hours=1)


def test_incident_views_keep_explained_incident_active_until_source_resolves_it() -> None:
    explained = record(
        "incidents",
        RecordType.INCIDENT,
        dimensions={"number": "INC001", "state": "explained", "priority": "P2"},
        measures={"resolved_at": None, "closed_at": None},
        grain_seconds=None,
    )
    resolved = replace(
        explained,
        natural_key=(("id", "resolved"),),
        dimensions={"number": "INC002", "state": "resolved", "priority": "P1"},
        measures={"resolved_at": DAY + timedelta(hours=2), "closed_at": None},
    )

    views = build_incident_views((resolved, explained))

    assert tuple(item.number for item in views.active.incidents) == ("INC001",)
    assert tuple(item.number for item in views.day.incidents) == ("INC001", "INC002")
    assert views.day.incidents[0].incident_id == "inc_g435jiaziiyuitcyv5debfeysl"
    assert "incidents-2026-09-08T00:00:00+00:00" not in repr(views)
    assert views.active.is_current_pointer is True
    assert views.day.is_current_pointer is False


def test_incident_builder_rejects_empty_optional_source_text() -> None:
    incident = record(
        "incidents",
        RecordType.INCIDENT,
        dimensions={"number": "", "state": "open", "priority": "P2"},
        measures={"resolved_at": None, "closed_at": None},
        grain_seconds=None,
    )

    with pytest.raises(ValueError, match="number"):
        build_incident_views((incident,))


def test_monitoring_records_versions_watermarks_and_partial_quality() -> None:
    older = record(
        "collector_run",
        RecordType.UPSTREAM_COLLECTOR_RUN,
        dimensions={"source": "prometheus"},
        measures={"rows_upserted": 3, "duration_s": Decimal("1.2"), "finished_at": None},
        quality_flags=("INVALID_SOURCE_JSON",),
        grain_seconds=None,
    )
    latest = replace(
        older,
        natural_key=(("id", "latest"),),
        observed_at=DAY + timedelta(hours=1),
        measures={
            "rows_upserted": 5,
            "duration_s": Decimal("0.8"),
            "finished_at": DAY + timedelta(hours=1, minutes=1),
        },
        quality_flags=(),
    )

    view = build_monitoring((latest, older))

    assert view.projection_version == "1.0"
    assert view.formula_version == "1.0"
    assert view.input_watermarks
    assert view.coverage.status is CoverageStatus.PARTIAL
    assert view.sources[0].source == "prometheus"
    assert view.sources[0].rows_processed == 5


def test_monitoring_fails_closed_when_one_source_has_conflicting_latest_ties() -> None:
    first = record(
        "prom_run",
        RecordType.UPSTREAM_COLLECTOR_RUN,
        measures={"points_inserted": 1},
        grain_seconds=None,
    )
    second = replace(
        first,
        natural_key=(("id", "z-run"),),
        measures={"points_inserted": 2},
    )

    with pytest.raises(ValueError, match="latest timestamp"):
        build_monitoring((first, second))
    with pytest.raises(ValueError, match="latest timestamp"):
        build_monitoring((second, first))


def test_monitoring_rejects_conflicting_duplicate_canonical_identity() -> None:
    first = record(
        "prom_run",
        RecordType.UPSTREAM_COLLECTOR_RUN,
        measures={"points_inserted": 1},
        grain_seconds=None,
    )
    conflicting = replace(first, measures={"points_inserted": 2})

    with pytest.raises(ValueError, match="conflicting duplicate"):
        build_monitoring((first, conflicting))


def test_streaming_monitoring_allows_a_historical_tie_superseded_by_a_newer_run(
    tmp_path: Path,
) -> None:
    first = replace(
        record(
            "nr_run",
            RecordType.UPSTREAM_COLLECTOR_RUN,
            measures={"rows_inserted": 0},
            grain_seconds=None,
        ),
        natural_key=(("run_id", 358),),
    )
    retry = replace(
        first,
        natural_key=(("run_id", 359),),
        measures={"rows_inserted": 648},
    )
    latest = replace(
        first,
        natural_key=(("run_id", 360),),
        observed_at=DAY + timedelta(minutes=1),
        measures={"rows_inserted": 12},
    )
    accumulator = _PartitionAccumulator(("nr_run", "20260908"), tmp_path / "projection.db")
    try:
        accumulator.add(first)
        accumulator.add(retry)
        accumulator.add(latest)

        payloads = tuple(accumulator.monitoring_payloads())
    finally:
        accumulator.close()

    assert payloads[0][1]["observedAt"] == DAY + timedelta(minutes=1)
    assert payloads[0][1]["rowsProcessed"] == 12


def test_streaming_monitoring_still_rejects_a_conflict_at_the_latest_timestamp(
    tmp_path: Path,
) -> None:
    first = replace(
        record(
            "nr_run",
            RecordType.UPSTREAM_COLLECTOR_RUN,
            measures={"rows_inserted": 0},
            grain_seconds=None,
        ),
        natural_key=(("run_id", 358),),
    )
    retry = replace(
        first,
        natural_key=(("run_id", 359),),
        measures={"rows_inserted": 648},
    )
    accumulator = _PartitionAccumulator(("nr_run", "20260908"), tmp_path / "projection.db")
    try:
        accumulator.add(first)
        accumulator.add(retry)

        with pytest.raises(ValueError, match="latest timestamp"):
            tuple(accumulator.monitoring_payloads())
    finally:
        accumulator.close()


@pytest.mark.parametrize("builder", (build_incident_views, build_monitoring))
def test_projection_builders_reject_naive_nested_datetimes(builder: object) -> None:
    nested_field = "resolved_at" if builder is build_incident_views else "finished_at"
    source = record(
        "incidents" if builder is build_incident_views else "collector_run",
        RecordType.INCIDENT
        if builder is build_incident_views
        else RecordType.UPSTREAM_COLLECTOR_RUN,
        dimensions={"state": "resolved"} if builder is build_incident_views else {"source": "x"},
        measures={nested_field: datetime(2026, 9, 8), "closed_at": None}
        if builder is build_incident_views
        else {nested_field: datetime(2026, 9, 8)},
        grain_seconds=None,
    )

    with pytest.raises(ValueError, match="UTC"):
        if builder is build_incident_views:
            build_incident_views((source,))
        else:
            build_monitoring((source,))


def test_geography_aggregates_only_geo_dimensions_and_handles_zero_denominator() -> None:
    sp = record(
        "geo_hourly",
        RecordType.DIMENSIONAL_METRIC_AGGREGATE,
        dimensions={"state_province": "SP", "isp": "ISP A"},
        measures={"sessions": 0, "errors": 2},
    )
    rj = replace(
        sp,
        natural_key=(("id", "rj"),),
        dimensions={"state_province": "RJ", "isp": "ISP B"},
        measures={"sessions": 4, "errors": 1},
    )

    view = build_geography((sp, rj))

    assert tuple(item.state for item in view.locations) == ("RJ", "SP")
    assert view.locations[0].error_rate == Decimal("0.25")
    assert view.locations[1].error_rate is None
    assert view.projection_version == "1.0"
    assert view.formula_version == "1.0"


def test_canonical_rebuild_never_reads_hot_facts_and_is_idempotent() -> None:
    marker = _canonical_set()

    class Source(CanonicalRecordSource):
        calls = 0

        def iter_batches(self, canonical_set, *, batch_size=2_048):  # type: ignore[no-untyped-def]
            assert canonical_set == marker
            assert batch_size == 2_048
            self.calls += 1
            yield {("app_error", PARTITION): (_record(),)}

    class NoHotFacts(FakeProjectionRepository):
        def iter_input_batches(self, *_args, **_kwargs):  # type: ignore[no-untyped-def]
            raise AssertionError("canonical-v2 rebuild must not read hot facts")

        def query_inputs(self, *_args, **_kwargs):  # type: ignore[no-untyped-def]
            raise AssertionError("canonical-v2 rebuild must not read hot facts")

    store = FakeCanonicalSetStore()
    store.values[marker.dataset_version] = marker
    source = Source()
    repository = NoHotFacts()
    command = RebuildProjections(
        ProjectionService(repository),
        FakeManifestRepository(),
        canonical_sets=store,
        canonical_source=source,
    )
    request = RebuildProjectionsRequest(
        marker.dataset_version,
        (f"DATASET#{marker.dataset_version}#FACT#TS#app_error#20260901",),
        {"app_error": PARTITION},
    )

    first = command.execute(request)
    revisions = tuple(sorted(repository.backend.projection_heads.values()))
    second = command.execute(request)

    assert first.catalog_item_counts == {("app_error", PARTITION): 2}
    assert second.catalog_item_counts == first.catalog_item_counts
    assert tuple(sorted(repository.backend.projection_heads.values())) == revisions
    # Each rebuild streams canonical data once for legacy projections and once
    # for cross-partition Event/Evidence correlation.
    assert source.calls == 4
    assert repository.backend.projections
    assert all(
        projection.required_archives == (ArchiveDependency("app_error", PARTITION),)
        for projection in repository.backend.projections.values()
    )


def test_rebuild_falls_back_to_legacy_facts_when_canonical_marker_is_missing() -> None:
    marker = _canonical_set()
    hot_partition = f"DATASET#{marker.dataset_version}#FACT#TS#app_error#20260901"
    repository = FakeProjectionRepository(
        inputs={(marker.dataset_version, hot_partition): (_record(),)}
    )
    canonical_sets = FakeCanonicalSetStore()

    class UnusedCanonicalSource(CanonicalRecordSource):
        def iter_batches(self, *_args, **_kwargs):  # type: ignore[no-untyped-def]
            raise AssertionError("a missing marker must use the legacy fact source")

    result = RebuildProjections(
        ProjectionService(repository),
        FakeManifestRepository(),
        canonical_sets=canonical_sets,
        canonical_source=UnusedCanonicalSource(),
    ).execute(
        RebuildProjectionsRequest(
            marker.dataset_version,
            (hot_partition,),
            {"app_error": PARTITION},
        )
    )

    assert result.catalog_item_counts == {("app_error", PARTITION): 2}
    assert repository.backend.projections


def _rebuild_with_fact_sink(sink: AnalysisFactSink) -> RebuildProjections:
    marker = _canonical_set()

    class Source(CanonicalRecordSource):
        def iter_batches(self, canonical_set, *, batch_size=2_048):  # type: ignore[no-untyped-def]
            yield {("app_error", PARTITION): (_record(),)}

    store = FakeCanonicalSetStore()
    store.values[marker.dataset_version] = marker
    return RebuildProjections(
        ProjectionService(FakeProjectionRepository(), fact_sink=sink),
        FakeManifestRepository(),
        canonical_sets=store,
        canonical_source=Source(),
    )


def _rebuild_request() -> RebuildProjectionsRequest:
    version = _canonical_set().dataset_version
    return RebuildProjectionsRequest(
        version,
        (f"DATASET#{version}#FACT#TS#app_error#20260901",),
        {"app_error": PARTITION},
    )


def test_rebuild_feeds_the_analysis_fact_sink_once_per_committed_batch() -> None:
    class Sink(AnalysisFactSink):
        def __init__(self) -> None:
            self.calls: list[tuple[str, int]] = []

        def write(self, records, dataset_version):  # type: ignore[no-untyped-def]
            batch = tuple(records)
            self.calls.append((dataset_version, len(batch)))
            return len(batch)

    sink = Sink()
    _rebuild_with_fact_sink(sink).execute(_rebuild_request())

    assert sink.calls == [(_canonical_set().dataset_version, 1)]


def test_rebuild_fails_when_the_analysis_fact_sink_fails() -> None:
    class BrokenSink(AnalysisFactSink):
        def write(self, records, dataset_version):  # type: ignore[no-untyped-def]
            raise RuntimeError("facts unavailable")

    with pytest.raises(RuntimeError, match="facts unavailable"):
        _rebuild_with_fact_sink(BrokenSink()).execute(_rebuild_request())
