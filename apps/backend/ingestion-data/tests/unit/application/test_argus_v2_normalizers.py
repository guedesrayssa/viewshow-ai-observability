"""Verify ARGUS v2 rows normalize into canonical ingestion records."""

from __future__ import annotations

import json
from dataclasses import FrozenInstanceError
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import cast

import pytest

from contracts.argus.v2 import normalizers
from contracts.registry import DatasetRegistry
from domain import quality
from domain.models import RecordType

FIXTURE_PATH = Path(__file__).parents[2] / "fixtures" / "argus_v2_new_rows.json"
LEGACY_FIXTURE_PATH = Path(__file__).parents[2] / "fixtures" / "argus_v2_legacy_rows.json"


def fixture_row(dataset: str) -> dict[str, object]:
    document = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    return cast(dict[str, object], document[dataset])


def legacy_fixture_row(dataset: str) -> dict[str, object]:
    document = json.loads(LEGACY_FIXTURE_PATH.read_text(encoding="utf-8"))
    return cast(dict[str, object], document[dataset])


def context(bot_reliable_from_ms: int | None = None) -> normalizers.NormalizationContext:
    return normalizers.NormalizationContext(bot_reliable_from_ms=bot_reliable_from_ms)


@pytest.mark.parametrize(
    ("dataset", "grain_seconds"),
    (("app_error", 3600), ("app_error_model", 86400), ("app_error_version", 86400)),
)
def test_application_errors_keep_their_real_grain_and_limited_coverage(
    dataset: str, grain_seconds: int
) -> None:
    record = normalizers.normalize_row(
        DatasetRegistry.load_argus_v2().require(dataset), fixture_row(dataset), context()
    )

    assert record.record_type is RecordType.APPLICATION_ERROR_AGGREGATE
    assert record.window is not None
    assert record.window.grain_seconds == grain_seconds
    assert "LIMITED_SOURCE_COVERAGE" in record.quality_flags
    assert record.measures["errors"] >= record.measures["devices"]  # type: ignore[operator]


def test_nullable_application_error_device_count_is_preserved() -> None:
    registry = DatasetRegistry.load_argus_v2()

    record = normalizers.normalize_row(
        registry.require("app_error"), fixture_row("app_error") | {"devices": None}
    )

    assert record.measures == {"errors": 11, "devices": None}


@pytest.mark.parametrize("dataset", ("app_error", "app_error_model", "app_error_version"))
@pytest.mark.parametrize(
    ("overrides", "message"),
    (
        ({"errors": -1, "devices": 0}, "errors cannot be negative"),
        ({"errors": 1, "devices": -1}, "devices cannot be negative"),
    ),
)
def test_application_errors_reject_impossible_counts(
    dataset: str, overrides: dict[str, object], message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        normalizers.normalize_row(
            DatasetRegistry.load_argus_v2().require(dataset),
            fixture_row(dataset) | overrides,
        )


@pytest.mark.parametrize("dataset", ("app_error", "app_error_model", "app_error_version"))
def test_application_errors_preserve_source_count_inconsistency_as_quality(
    dataset: str,
) -> None:
    record = normalizers.normalize_row(
        DatasetRegistry.load_argus_v2().require(dataset),
        fixture_row(dataset) | {"errors": 5, "devices": 6},
    )

    assert record.measures == {"errors": 5, "devices": 6}
    assert record.quality_flags == (
        "LIMITED_SOURCE_COVERAGE",
        "SOURCE_COUNT_INCONSISTENCY",
    )


@pytest.mark.parametrize("dataset", ("app_error", "app_error_model", "app_error_version"))
@pytest.mark.parametrize("devices", (0, None))
def test_application_errors_accept_zero_and_unknown_device_counts(
    dataset: str, devices: int | None
) -> None:
    record = normalizers.normalize_row(
        DatasetRegistry.load_argus_v2().require(dataset),
        fixture_row(dataset) | {"errors": 0, "devices": devices},
    )

    assert record.measures == {"errors": 0, "devices": devices}


def test_errors_bot_is_not_relabelled_as_human_before_observed_boundary() -> None:
    row = legacy_fixture_row("error_cat_hourly") | {
        "hour_ts": 1787961600000,
        "errors": 100,
        "errors_bot": 0,
    }

    record = normalizers.normalize_row(
        DatasetRegistry.load_argus_v2().require("error_cat_hourly"),
        row,
        context(bot_reliable_from_ms=1788048000000),
    )

    assert record.measures["errors"] == 100
    assert record.measures["errorsBot"] == 0
    assert record.measures["humanErrors"] is None
    assert record.quality["botCoverageStatus"] == "ambiguous_default_zero"


def test_errors_bot_derives_human_errors_at_and_after_observed_boundary() -> None:
    row = legacy_fixture_row("error_cat_hourly") | {
        "hour_ts": 1788048000000,
        "errors": 100,
        "errors_bot": 17,
    }

    record = normalizers.normalize_row(
        DatasetRegistry.load_argus_v2().require("error_cat_hourly"),
        row,
        context(bot_reliable_from_ms=1788048000000),
    )

    assert record.measures["humanErrors"] == 83
    assert record.quality["botCoverageStatus"] == "reliable"


def test_missing_bot_boundary_keeps_the_whole_snapshot_ambiguous() -> None:
    row = legacy_fixture_row("error_cat_hourly") | {"errors": 100, "errors_bot": 17}

    record = normalizers.normalize_row(
        DatasetRegistry.load_argus_v2().require("error_cat_hourly"), row, context()
    )

    assert record.measures["humanErrors"] is None
    assert record.quality["botCoverageStatus"] == "ambiguous_default_zero"


def test_bot_boundary_discovery_reports_the_scalar_query_result() -> None:
    statements: list[str] = []

    def execute_scalar(statement: str) -> object:
        statements.append(statement)
        return 1788048000000

    report = quality.discover_bot_coverage(execute_scalar)

    assert statements == [
        "SELECT MIN(hour_ts) AS first_bot_bucket\nFROM error_cat_hourly\nWHERE errors_bot > 0"
    ]
    assert report.bot_reliable_from_ms == 1788048000000
    assert report.status is quality.BotCoverage.RELIABLE


def test_null_bot_boundary_reports_ambiguous_coverage() -> None:
    report = quality.discover_bot_coverage(lambda _statement: None)

    assert report.bot_reliable_from_ms is None
    assert report.status is quality.BotCoverage.AMBIGUOUS_DEFAULT_ZERO


@pytest.mark.parametrize("value", (True, 1.5, "1788048000000"))
def test_bot_boundary_discovery_rejects_non_integer_results(value: object) -> None:
    with pytest.raises(ValueError, match="epoch-millisecond integer"):
        quality.discover_bot_coverage(lambda _statement: value)


def test_normalization_context_and_bot_report_are_immutable() -> None:
    normalization_context = context(1788048000000)
    report = quality.discover_bot_coverage(lambda _statement: 1788048000000)

    with pytest.raises(FrozenInstanceError):
        normalization_context.bot_reliable_from_ms = None  # type: ignore[misc]
    with pytest.raises(FrozenInstanceError):
        report.bot_reliable_from_ms = None  # type: ignore[misc]


def test_normalization_context_defensively_freezes_valid_sde_ids() -> None:
    source_ids = {"sde-synthetic-001"}
    normalization_context = normalizers.NormalizationContext(
        valid_sde_ids=source_ids  # type: ignore[arg-type]
    )

    source_ids.add("sde-added-after-construction")

    assert normalization_context.valid_sde_ids == frozenset({"sde-synthetic-001"})


@pytest.mark.parametrize("invalid_id", ("", "   "))
def test_normalization_context_rejects_empty_valid_sde_ids(invalid_id: str) -> None:
    with pytest.raises(ValueError, match="valid_sde_ids"):
        normalizers.NormalizationContext(valid_sde_ids=frozenset({invalid_id}))


def test_shadow_end_is_retired_experiment_not_source_lag() -> None:
    record = normalizers.normalize_row(
        DatasetRegistry.load_argus_v2().require("cdn_vod_shadow"),
        fixture_row("cdn_vod_shadow"),
        context(),
    )

    assert record.record_type is RecordType.SHADOW_OBSERVATION
    assert record.measures == {
        "req2xx": Decimal("1250.5"),
        "errors4xx": Decimal("7.25"),
        "errors5xx": Decimal("2.5"),
    }
    assert record.quality["sourceLifecycle"] == "retired_experiment"
    assert record.quality["expectedEnd"] == "2026-08-31T23:59:59.999Z"
    assert record.quality["sourceCoverageStatus"] == "limited_known"
    assert record.quality["observedStart"] == "2026-08-27T18:35:00.000Z"
    assert record.quality["observedEnd"] == "2026-08-31T23:48:00.000Z"
    assert "LIMITED_SOURCE_COVERAGE" in record.quality_flags


def test_finding_status_is_derived_label_with_provenance() -> None:
    record = normalizers.normalize_row(
        DatasetRegistry.load_argus_v2().require("finding_status_log"),
        fixture_row("finding_status_log"),
        context(),
    )

    assert record.record_type is RecordType.FINDING_STATUS_TRANSITION
    assert record.quality["labelAuthority"] == "derived"
    assert record.quality["goldenSetEligible"] is False
    assert record.dimensions["toStatus"] == "explained"
    assert record.dimensions["resolved"] is False


def test_only_resolved_finding_status_sets_resolved_true() -> None:
    record = normalizers.normalize_row(
        DatasetRegistry.load_argus_v2().require("finding_status_log"),
        fixture_row("finding_status_log") | {"to_status": "resolved"},
    )

    assert record.dimensions["resolved"] is True


def test_null_sde_id_means_unmatched_not_non_sport() -> None:
    record = normalizers.normalize_row(
        DatasetRegistry.load_argus_v2().require("live_event"),
        fixture_row("live_event") | {"sde_id": None},
        context(),
    )

    assert record.record_type is RecordType.LIVE_EVENT_CONTEXT
    assert record.dimensions["sdeId"] is None
    assert record.quality["sportsMatchStatus"] == "unmatched"
    assert record.window is not None
    assert record.window.start == datetime.fromtimestamp(1788044400, UTC)
    assert record.window.end == datetime.fromtimestamp(1788053400, UTC)


def test_live_event_match_uses_only_the_explicit_sde_id() -> None:
    record = normalizers.normalize_row(
        DatasetRegistry.load_argus_v2().require("live_event"),
        fixture_row("live_event")
        | {"team_home": "same", "team_away": "same", "sde_id": "sde-explicit"},
        normalizers.NormalizationContext(valid_sde_ids=frozenset({"sde-explicit"})),
    )

    assert record.dimensions["sdeId"] == "sde-explicit"
    assert record.quality["sportsMatchStatus"] == "matched_by_sde_id"


def test_live_event_with_sde_id_and_no_catalog_is_unverified() -> None:
    record = normalizers.normalize_row(
        DatasetRegistry.load_argus_v2().require("live_event"),
        fixture_row("live_event"),
    )

    assert record.quality["sportsMatchStatus"] == "sde_id_present_unverified"


def test_live_event_with_sde_id_missing_from_catalog_is_orphaned() -> None:
    record = normalizers.normalize_row(
        DatasetRegistry.load_argus_v2().require("live_event"),
        fixture_row("live_event"),
        normalizers.NormalizationContext(valid_sde_ids=frozenset({"another-sde-id"})),
    )

    assert record.quality["sportsMatchStatus"] == "orphaned_sde_id"


@pytest.mark.parametrize("dataset", ("live_event", "live_event_sde"))
@pytest.mark.parametrize("invalid_id", ("", "   "))
def test_live_event_datasets_reject_empty_sde_id(dataset: str, invalid_id: str) -> None:
    with pytest.raises(ValueError, match="sde_id"):
        normalizers.normalize_row(
            DatasetRegistry.load_argus_v2().require(dataset),
            fixture_row(dataset) | {"sde_id": invalid_id},
        )


def test_live_event_sde_preserves_structured_reconciliation_evidence() -> None:
    record = normalizers.normalize_row(
        DatasetRegistry.load_argus_v2().require("live_event_sde"),
        fixture_row("live_event_sde"),
    )

    assert record.dimensions["isFinished"] is False
    assert record.dimensions["nameMismatch"] is True
    assert record.dimensions["tidsJarvis"] == (101, 102)
    assert record.dimensions["tidsEpg"] == (101, 103)
    assert record.dimensions["epgTeams"] == ("Synthetic EPG Home", "Synthetic EPG Away")


@pytest.mark.parametrize("field", ("is_finished", "name_mismatch"))
def test_live_event_sde_rejects_non_boolean_tinyints(field: str) -> None:
    with pytest.raises(ValueError, match=field):
        normalizers.normalize_row(
            DatasetRegistry.load_argus_v2().require("live_event_sde"),
            fixture_row("live_event_sde") | {field: 2},
        )
