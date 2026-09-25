"""Verify eligible canonical ARGUS facts become traceable public Events."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import cast

from application.projections.events import project_event
from domain.models import CanonicalRecord, CanonicalValue, RecordType, Scalar, TimeWindow

OCCURRED_AT = datetime(2026, 9, 21, 12, 0, tzinfo=UTC)
UPDATED_AT = datetime(2026, 9, 21, 12, 5, tzinfo=UTC)


def canonical_event(
    dataset: str,
    record_type: RecordType,
    *,
    natural_key: tuple[tuple[str, Scalar], ...] = (("id", "source-1"),),
    observed_at: datetime | None = OCCURRED_AT,
    dimensions: dict[str, object] | None = None,
    measures: dict[str, object] | None = None,
    quality_flags: tuple[str, ...] = (),
) -> CanonicalRecord:
    return CanonicalRecord(
        schema_version="1.0",
        record_type=record_type,
        source_system="argus",
        source_dataset=dataset,
        natural_key=natural_key,
        observed_at=observed_at,
        window=(
            TimeWindow(observed_at, observed_at + timedelta(minutes=15), 900)
            if observed_at is not None
            else None
        ),
        dimensions=cast(
            dict[str, CanonicalValue], dimensions or {"source": "prometheus", "entity": "app"}
        ),
        measures=cast(dict[str, CanonicalValue], measures or {"value": Decimal("4.25")}),
        quality=cast(dict[str, Scalar], {"coveragePolicy": "complete"}),
        quality_flags=quality_flags,
    )


def test_signal_bucket_projects_stable_event_with_complete_lineage() -> None:
    record = canonical_event(
        "signal_bucket",
        RecordType.SIGNAL_OBSERVATION,
        natural_key=(("source", "prometheus"), ("bucket_id", 42)),
    )

    event = project_event(record, dataset_version="dsv_first")

    assert event is not None
    assert event.event_id == "evt_a56cfhze7zv2cj2fn5hwc35fm7"
    assert event.category == "signal_observation"
    assert event.dataset_version == "dsv_first"
    assert event.source_system == "argus"
    assert event.source_dataset == "signal_bucket"
    assert event.source_record_id == '[["source","prometheus"],["bucket_id",42]]'
    assert event.occurred_at == OCCURRED_AT
    assert event.sort_at == OCCURRED_AT
    assert event.window == record.window
    assert dict(event.dimensions) == {"source": "prometheus", "entity": "app"}
    assert dict(event.measures) == {"value": Decimal("4.25")}
    assert event.quality.status == "measured"
    assert event.quality.flags == ()
    assert event.quality.observed_through == OCCURRED_AT
    assert event.raw.available is False
    assert event.raw.reason == "not_materialized_in_event_projection"
    assert event.canonical_locator.startswith("canonical://dsv_first/signal_bucket/")


def test_event_identity_does_not_depend_on_dataset_version() -> None:
    record = canonical_event("signal_bucket", RecordType.SIGNAL_OBSERVATION)

    first = project_event(record, dataset_version="dsv_first")
    second = project_event(record, dataset_version="dsv_second")
    changed = project_event(
        canonical_event(
            "signal_bucket",
            RecordType.SIGNAL_OBSERVATION,
            natural_key=(("id", "source-2"),),
        ),
        dataset_version="dsv_first",
    )

    assert first is not None and second is not None and changed is not None
    assert first.event_id == second.event_id
    assert first.event_id != changed.event_id


def test_live_event_and_context_use_distinct_public_categories() -> None:
    live_event = project_event(
        canonical_event("live_event", RecordType.LIVE_EVENT_CONTEXT),
        dataset_version="dsv_one",
    )
    context = project_event(
        canonical_event(
            "live_event_sde",
            RecordType.LIVE_EVENT_CONTEXT,
            observed_at=None,
            measures={"updatedAt": UPDATED_AT},
        ),
        dataset_version="dsv_one",
    )

    assert live_event is not None and context is not None
    assert live_event.category == "live_event"
    assert context.category == "live_event_context"


def test_missing_event_timestamp_is_visible_and_uses_update_only_for_storage_order() -> None:
    record = canonical_event(
        "live_event_sde",
        RecordType.LIVE_EVENT_CONTEXT,
        observed_at=None,
        dimensions={"sdeId": "sde-10", "competition": "Brasileirão"},
        measures={"updatedAt": UPDATED_AT},
        quality_flags=("INVALID_SOURCE_JSON",),
    )

    event = project_event(record, dataset_version="dsv_one")

    assert event is not None
    assert event.occurred_at is None
    assert event.window is None
    assert event.sort_at == UPDATED_AT
    assert event.quality.observed_through == UPDATED_AT
    assert event.quality.status == "partial"
    assert event.quality.flags == ("INVALID_SOURCE_JSON", "MISSING_EVENT_TIMESTAMP")
    assert dict(event.dimensions) == {"sdeId": "sde-10", "competition": "Brasileirão"}
    assert dict(event.measures) == {"updatedAt": UPDATED_AT}


def test_non_event_canonical_fact_is_not_projected() -> None:
    incident = canonical_event("incidents", RecordType.INCIDENT)

    assert project_event(incident, dataset_version="dsv_one") is None
