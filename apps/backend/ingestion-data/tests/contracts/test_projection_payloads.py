"""Verify projection payloads preserve required archive dependencies and values."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from ports import ArchiveDependency, Projection

DAY = datetime(2026, 9, 8, tzinfo=UTC)
DEPENDENCY = ArchiveDependency("live_qoe_hourly", "year=2026/month=09/day=08")


def payload(*, observed_through: datetime = DAY) -> dict[str, object]:
    return {
        "projectionVersion": "1.0",
        "formulaVersion": "1.0",
        "inputWatermarks": {"live_qoe_hourly": observed_through},
        "observedThrough": observed_through,
        "coverage": "complete",
        "qualityFlags": (),
        "metrics": {
            "sessions": 4,
            "errors": 1,
            "startupErrors": None,
            "botErrors": None,
            "humanErrors": None,
            "errorRate": Decimal("0.25"),
        },
    }


@pytest.mark.parametrize(
    "invalid",
    [
        {"arbitrary": "accepted"},
        {**payload(), "projectionVersion": "2.0"},
        {**payload(), "formulaVersion": ""},
        {**payload(), "unknown": True},
        {**payload(), "inputWatermarks": {}},
        {**payload(), "coverage": "guessed"},
    ],
)
def test_projection_rejects_open_or_inconsistent_payloads(invalid: dict[str, object]) -> None:
    with pytest.raises((TypeError, ValueError), match="payload|projectionVersion|formulaVersion"):
        Projection(
            "dsv_abc",
            "DAY#20260908",
            "OVERVIEW#GLOBAL",
            "1.0",
            (DEPENDENCY,),
            invalid,
        )


def test_projection_contract_version_is_fixed_to_argus_2_projection_v1() -> None:
    invalid = {**payload(), "projectionVersion": "2.0"}

    with pytest.raises(ValueError, match="projection_version"):
        Projection(
            "dsv_abc",
            "DAY#20260908",
            "OVERVIEW#GLOBAL",
            "2.0",
            (DEPENDENCY,),
            invalid,
        )


def test_projection_rejects_naive_datetime_anywhere_in_payload() -> None:
    invalid = payload()
    invalid["inputWatermarks"] = {"live_qoe_hourly": datetime(2026, 9, 8)}

    with pytest.raises((TypeError, ValueError), match="payload|UTC"):
        Projection(
            "dsv_abc",
            "DAY#20260908",
            "OVERVIEW#GLOBAL",
            "1.0",
            (DEPENDENCY,),
            invalid,
        )


def test_materialization_revision_changes_without_renaming_projection_contract() -> None:
    first = Projection(
        "dsv_abc",
        "DAY#20260908",
        "OVERVIEW#GLOBAL",
        "1.0",
        (DEPENDENCY,),
        payload(),
    )
    changed_payload = payload()
    metrics = dict(changed_payload["metrics"])  # type: ignore[arg-type]
    metrics["sessions"] = 5
    metrics["errorRate"] = Decimal("0.2")
    changed_payload["metrics"] = metrics
    second = Projection(
        "dsv_abc",
        "DAY#20260908",
        "OVERVIEW#GLOBAL",
        "1.0",
        (DEPENDENCY,),
        changed_payload,
    )

    assert first.projection_version == second.projection_version == "1.0"
    assert first.materialization_revision.startswith("pmr_")
    assert first.materialization_revision != second.materialization_revision


def test_projection_rejects_a_watermark_from_another_partition_day() -> None:
    next_day = DAY + timedelta(days=1)

    with pytest.raises(ValueError, match="partition day"):
        Projection(
            "dsv_abc",
            "DAY#20260908",
            "OVERVIEW#GLOBAL",
            "1.0",
            (DEPENDENCY,),
            payload(observed_through=next_day),
        )


def test_overview_rejects_an_error_rate_inconsistent_with_its_counts() -> None:
    invalid = payload()
    metrics = dict(invalid["metrics"])  # type: ignore[arg-type]
    metrics["errorRate"] = 1
    invalid["metrics"] = metrics

    with pytest.raises(ValueError, match="errorRate"):
        Projection(
            "dsv_abc",
            "DAY#20260908",
            "OVERVIEW#GLOBAL",
            "1.0",
            (DEPENDENCY,),
            invalid,
        )


def test_incident_day_requires_opened_at_on_the_projection_day() -> None:
    invalid = {
        "projectionVersion": "1.0",
        "formulaVersion": "1.0",
        "inputWatermarks": {"incidents": DAY},
        "observedThrough": DAY,
        "coverage": "complete",
        "qualityFlags": (),
        "incidentId": "inc_pnidg23fnrf2yaddm5ttipxc55",
        "number": "INC001",
        "openedAt": DAY + timedelta(days=1),
        "state": "open",
        "priority": "P2",
        "resolvedAt": None,
        "closedAt": None,
    }

    with pytest.raises(ValueError, match="openedAt.*partition day"):
        Projection(
            "dsv_abc",
            "DAY#20260908",
            "INCIDENTS#DAY",
            "1.0",
            (ArchiveDependency("incidents", "year=2026/month=09/day=08"),),
            invalid,
        )


def test_incident_day_rejects_a_missing_opened_at_during_construction() -> None:
    invalid: dict[str, object] = {
        "projectionVersion": "1.0",
        "formulaVersion": "1.0",
        "inputWatermarks": {"incidents": DAY},
        "observedThrough": DAY,
        "coverage": "complete",
        "qualityFlags": (),
        "incidentId": "inc_pnidg23fnrf2yaddm5ttipxc55",
        "number": "INC001",
        "openedAt": None,
        "state": "open",
        "priority": "P2",
        "resolvedAt": None,
        "closedAt": None,
    }

    with pytest.raises(TypeError, match="openedAt"):
        Projection(
            "dsv_abc",
            "DAY#20260908",
            "INCIDENTS#DAY",
            "1.0",
            (ArchiveDependency("incidents", "year=2026/month=09/day=08"),),
            invalid,
        )


def test_incident_day_rejects_resolution_before_opening() -> None:
    invalid = {
        "projectionVersion": "1.0",
        "formulaVersion": "1.0",
        "inputWatermarks": {"incidents": DAY},
        "observedThrough": DAY,
        "coverage": "complete",
        "qualityFlags": (),
        "incidentId": "inc_pnidg23fnrf2yaddm5ttipxc55",
        "number": "INC001",
        "openedAt": DAY,
        "state": "resolved",
        "priority": "P2",
        "resolvedAt": DAY - timedelta(minutes=1),
        "closedAt": None,
    }

    with pytest.raises(ValueError, match="resolvedAt"):
        Projection(
            "dsv_abc",
            "DAY#20260908",
            "INCIDENTS#DAY",
            "1.0",
            (ArchiveDependency("incidents", "year=2026/month=09/day=08"),),
            invalid,
        )


def test_active_projection_is_one_closed_replaceable_set() -> None:
    dependency = ArchiveDependency("incidents", "year=2026/month=09/day=08")
    active = Projection(
        "dsv_abc",
        "DAY#20260908",
        "INCIDENTS#ACTIVE",
        "1.0",
        (dependency,),
        {
            "projectionVersion": "1.0",
            "formulaVersion": "1.0",
            "inputWatermarks": {"incidents": DAY},
            "observedThrough": DAY,
            "coverage": "complete",
            "qualityFlags": (),
            "incidents": (
                {
                    "incidentId": "inc_pnidg23fnrf2yaddm5ttipxc55",
                    "number": "INC001",
                    "openedAt": DAY,
                    "state": "open",
                    "priority": "P2",
                },
            ),
        },
    )

    assert active.operational_sort_key == "CURRENT"


def test_active_projection_rejects_resolved_or_disordered_incidents() -> None:
    dependency = ArchiveDependency("incidents", "year=2026/month=09/day=08")
    resolved = {
        "incidentId": "inc_pnidg23fnrf2yaddm5ttipxc55",
        "number": "INC001",
        "openedAt": DAY,
        "state": "resolved",
        "priority": "P2",
    }
    payload_common = {
        "projectionVersion": "1.0",
        "formulaVersion": "1.0",
        "inputWatermarks": {"incidents": DAY},
        "observedThrough": DAY,
        "coverage": "complete",
        "qualityFlags": (),
        "incidents": (resolved,),
    }

    with pytest.raises(ValueError, match="active"):
        Projection(
            "dsv_abc",
            "DAY#20260908",
            "INCIDENTS#ACTIVE",
            "1.0",
            (dependency,),
            payload_common,
        )
