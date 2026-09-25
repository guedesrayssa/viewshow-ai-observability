"""Verify Evidence exists only after the explicit ARGUS correlation rule accepts it."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta

from application.projections.event_correlation import (
    CORRELATION_RULE_VERSION,
    IncidentCorrelationInput,
    correlate_event,
)
from application.projections.events import EventQuality, ProjectedEvent, RawAvailability

OPENED_AT = datetime(2026, 9, 21, 12, 0, tzinfo=UTC)


def event(
    *,
    occurred_at: datetime | None = OPENED_AT,
    dimensions: dict[str, object] | None = None,
) -> ProjectedEvent:
    return ProjectedEvent(
        event_id="evt_known",
        dataset_version="dsv_one",
        category="signal_observation",
        source_system="argus",
        source_dataset="signal_bucket",
        source_record_id='[["id","signal-1"]]',
        canonical_locator="canonical://dsv_one/signal_bucket/record",
        occurred_at=occurred_at,
        sort_at=occurred_at or OPENED_AT,
        window=None,
        dimensions=dimensions or {"source": "  Vídeo AO VIVO  "},
        measures={"value": 12},
        quality=EventQuality("measured", (), occurred_at),
        raw=RawAvailability(False, "not_materialized_in_event_projection"),
    )


def incident(*, dimensions: dict[str, object] | None = None) -> IncidentCorrelationInput:
    return IncidentCorrelationInput(
        incident_id="inc_known",
        opened_at=OPENED_AT,
        dimensions=dimensions or {"business_service": "vídeo ao vivo"},
    )


def test_exact_casefolded_match_inside_window_creates_link_and_evidence() -> None:
    outcome = correlate_event(event(), incident(), window_seconds=18_000)

    assert outcome is not None
    assert outcome.link.event_id == "evt_known"
    assert outcome.link.incident_id == "inc_known"
    assert outcome.link.rule_version == CORRELATION_RULE_VERSION == "argus-explicit-v2"
    assert outcome.link.time_distance_seconds == 0
    assert outcome.link.matched_fields == (("source", "business_service", "vídeo ao vivo"),)
    assert outcome.evidence.event_id == "evt_known"
    assert outcome.evidence.incident_id == "inc_known"
    assert outcome.evidence.evidence_type == "argus_event_correlation"
    assert outcome.evidence.relation == "context"
    assert outcome.evidence.strength == "moderate"
    assert outcome.evidence.hypothesis_ids == ()


def test_two_distinct_field_matches_make_evidence_strong() -> None:
    outcome = correlate_event(
        event(dimensions={"channel": "Sport TV", "competition": "Copa"}),
        incident(dimensions={"business_service": "sport tv", "category": "copa"}),
        window_seconds=18_000,
    )

    assert outcome is not None
    assert outcome.evidence.strength == "strong"
    assert outcome.link.matched_fields == (
        ("channel", "business_service", "sport tv"),
        ("competition", "category", "copa"),
    )


def test_incident_component_token_inside_technical_entity_creates_evidence() -> None:
    outcome = correlate_event(
        event(dimensions={"entity": "br1|tv.globoplay.com.br"}),
        incident(dimensions={"cmdb_ci": "Globoplay"}),
        window_seconds=18_000,
    )

    assert outcome is not None
    assert outcome.link.rule_version == CORRELATION_RULE_VERSION == "argus-explicit-v2"
    assert outcome.link.matched_fields == (("entity", "cmdb_ci", "globoplay"),)


def test_component_token_match_rejects_partial_words_and_short_noise() -> None:
    assert (
        correlate_event(
            event(dimensions={"entity": "mygloboplayx.example"}),
            incident(dimensions={"cmdb_ci": "globoplay"}),
            window_seconds=18_000,
        )
        is None
    )
    assert (
        correlate_event(
            event(dimensions={"entity": "br1|tv.example"}),
            incident(dimensions={"cmdb_ci": "tv"}),
            window_seconds=18_000,
        )
        is None
    )


def test_five_hour_boundaries_are_inclusive_and_distance_is_signed() -> None:
    before = correlate_event(
        event(occurred_at=OPENED_AT - timedelta(hours=5)), incident(), window_seconds=18_000
    )
    after = correlate_event(
        event(occurred_at=OPENED_AT + timedelta(hours=5)), incident(), window_seconds=18_000
    )

    assert before is not None and after is not None
    assert before.link.time_distance_seconds == -18_000
    assert after.link.time_distance_seconds == 18_000


def test_one_second_outside_either_boundary_does_not_correlate() -> None:
    assert (
        correlate_event(
            event(occurred_at=OPENED_AT - timedelta(hours=5, seconds=1)),
            incident(),
            window_seconds=18_000,
        )
        is None
    )


def test_fractional_second_outside_boundary_does_not_correlate() -> None:
    assert (
        correlate_event(
            event(occurred_at=OPENED_AT + timedelta(hours=5, microseconds=1)),
            incident(),
            window_seconds=18_000,
        )
        is None
    )
    assert (
        correlate_event(
            event(occurred_at=OPENED_AT + timedelta(hours=5, seconds=1)),
            incident(),
            window_seconds=18_000,
        )
        is None
    )


def test_time_without_semantic_match_and_semantics_without_time_do_not_correlate() -> None:
    assert (
        correlate_event(
            event(dimensions={"source": "playback"}),
            incident(dimensions={"business_service": "billing"}),
            window_seconds=18_000,
        )
        is None
    )
    assert correlate_event(event(occurred_at=None), incident(), window_seconds=18_000) is None


def test_empty_values_do_not_match() -> None:
    assert (
        correlate_event(
            event(dimensions={"source": "   "}),
            incident(dimensions={"business_service": ""}),
            window_seconds=18_000,
        )
        is None
    )


def test_evidence_identity_is_stable_and_bound_to_rule_event_and_incident() -> None:
    original = correlate_event(event(), incident(), window_seconds=18_000)
    repeated = correlate_event(event(), incident(), window_seconds=18_000)
    another_incident = correlate_event(
        event(), replace(incident(), incident_id="inc_other"), window_seconds=18_000
    )

    assert original is not None and repeated is not None and another_incident is not None
    assert original.evidence.evidence_id == repeated.evidence.evidence_id
    assert original.evidence.evidence_id != another_incident.evidence.evidence_id


def test_rule_refuses_invalid_windows_instead_of_silently_clamping() -> None:
    for invalid in (0, -1, 18_001):
        try:
            correlate_event(event(), incident(), window_seconds=invalid)
        except ValueError as error:
            assert str(error) == "window_seconds must be between 1 and 18000"
        else:
            raise AssertionError(f"window {invalid} should have failed")
