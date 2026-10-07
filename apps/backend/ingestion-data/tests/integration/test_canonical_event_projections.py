"""Exercise canonical facts through Event, correlation, and Evidence materialization."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import cast

import pytest

from application.rebuild_projections import ProjectionService
from domain.models import CanonicalRecord, CanonicalValue, RecordType, Scalar
from ports import ConditionalWriteError
from tests.fakes import FakeIngestionBackend, FakeProjectionRepository

DAY = datetime(2026, 9, 21, tzinfo=UTC)
PARTITION = "snapshot_date=2026-09-21"


def record(
    dataset: str,
    record_type: RecordType,
    record_id: str,
    *,
    observed_at: datetime | None,
    dimensions: dict[str, object],
    measures: dict[str, object] | None = None,
) -> CanonicalRecord:
    return CanonicalRecord(
        schema_version="1.0",
        record_type=record_type,
        source_system="argus",
        source_dataset=dataset,
        natural_key=(("id", record_id),),
        observed_at=observed_at,
        window=None,
        dimensions=cast(dict[str, CanonicalValue], dimensions),
        measures=cast(dict[str, CanonicalValue], measures or {}),
        quality=cast(dict[str, Scalar], {"coveragePolicy": "complete"}),
        quality_flags=(),
    )


def canonical_records() -> dict[tuple[str, str], tuple[CanonicalRecord, ...]]:
    return {
        ("signal_bucket", PARTITION): (
            record(
                "signal_bucket",
                RecordType.SIGNAL_OBSERVATION,
                "signal-linked",
                observed_at=DAY.replace(hour=11),
                dimensions={"source": "video"},
                measures={"value": 8},
            ),
        ),
        ("live_event", PARTITION): (
            record(
                "live_event",
                RecordType.LIVE_EVENT_CONTEXT,
                "event-unlinked",
                observed_at=DAY.replace(hour=12),
                dimensions={"channel": "sports"},
            ),
        ),
        ("live_event_sde", PARTITION): (
            record(
                "live_event_sde",
                RecordType.LIVE_EVENT_CONTEXT,
                "context-no-time",
                observed_at=None,
                dimensions={"sdeId": "sde-1"},
                measures={"updatedAt": DAY.replace(hour=12, minute=30)},
            ),
        ),
        ("incidents", PARTITION): (
            record(
                "incidents",
                RecordType.INCIDENT,
                "incident-1",
                observed_at=DAY.replace(hour=12),
                dimensions={
                    "number": "INC001",
                    "state": "open",
                    "priority": "P2",
                    "business_service": "VIDEO",
                },
                measures={"resolved_at": None, "closed_at": None},
            ),
        ),
    }


def test_materialization_keeps_all_events_and_creates_evidence_only_for_accepted_link() -> None:
    backend = FakeIngestionBackend()
    repository = FakeProjectionRepository(backend=backend)

    result = ProjectionService(
        repository, event_correlation_window_seconds=18_000
    ).materialize_records("dsv_candidate", canonical_records())

    assert dict(result.event_counts) == {
        "eligible": 3,
        "events": 3,
        "linked": 1,
        "unlinked": 2,
        "evidence": 1,
    }
    items = tuple(backend.event_projection_items.values())
    global_events = tuple(item for item in items if item.entity_type == "EVENT")
    incident_events = tuple(item for item in items if item.entity_type == "INCIDENT_EVENT")
    evidence = tuple(item for item in items if item.entity_type == "EVIDENCE")
    summary = next(item for item in items if item.entity_type == "EVENT_PROJECTION_SUMMARY")
    assert len(global_events) == 3
    assert len(incident_events) == 1
    assert len(evidence) == 1
    assert sorted(item.payload["correlationStatus"] for item in global_events) == [
        "linked",
        "unlinked",
        "unlinked",
    ]
    linked_event = next(
        item for item in global_events if item.payload["correlationStatus"] == "linked"
    )
    assert (
        linked_event.payload["correlations"][0]["incidentId"] == evidence[0].payload["incidentId"]
    )
    assert linked_event.payload["correlations"][0]["ruleVersion"] == "argus-explicit-v2"
    missing_time = next(
        item for item in global_events if item.payload["sourceDataset"] == "live_event_sde"
    )
    assert missing_time.payload["occurredAt"] is None
    assert "MISSING_EVENT_TIMESTAMP" in missing_time.payload["qualityFlags"]
    assert evidence[0].payload["ruleVersion"] == "argus-explicit-v2"
    assert evidence[0].payload["hypothesisIds"] == ()
    assert summary.payload["ruleVersion"] == "argus-explicit-v2"
    assert summary.payload["coverage"] == "PARTIAL"
    assert summary.payload["qualityFlags"] == ("MISSING_EVENT_TIMESTAMP",)


def test_event_materialization_is_idempotent_but_rejects_divergent_identity() -> None:
    backend = FakeIngestionBackend()
    service = ProjectionService(
        FakeProjectionRepository(backend=backend), event_correlation_window_seconds=18_000
    )
    records = canonical_records()

    first = service.materialize_records("dsv_candidate", records)
    second = service.materialize_records("dsv_candidate", records)

    assert first.event_counts == second.event_counts
    first_event_items = dict(backend.event_projection_items)
    changed = dict(records)
    source = records[("signal_bucket", PARTITION)][0]
    changed[("signal_bucket", PARTITION)] = (
        record(
            "signal_bucket",
            RecordType.SIGNAL_OBSERVATION,
            "signal-linked",
            observed_at=source.observed_at,
            dimensions={"source": "video", "entity": "changed"},
            measures={"value": 8},
        ),
    )

    with pytest.raises(ConditionalWriteError, match="divergent"):
        service.materialize_records("dsv_candidate", changed)
    assert backend.event_projection_items == first_event_items


def test_active_dataset_fence_prevents_event_projection_mutation() -> None:
    backend = FakeIngestionBackend()
    backend.active_projection_fences.add("dsv_active")
    service = ProjectionService(
        FakeProjectionRepository(backend=backend), event_correlation_window_seconds=18_000
    )

    with pytest.raises(ConditionalWriteError, match="active"):
        service.materialize_records("dsv_active", canonical_records())
