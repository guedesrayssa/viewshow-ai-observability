"""Apply the explicit, versioned rule that can turn an Event into Evidence."""

from __future__ import annotations

import base64
import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta

from application.projections.events import ProjectedEvent
from domain.canonical_json import canonical_bytes

CORRELATION_RULE_VERSION = "argus-explicit-v2"
MAX_CORRELATION_WINDOW_SECONDS = 18_000

_EVENT_FIELDS = (
    "source",
    "entity",
    "metric",
    "channel",
    "program",
    "competition",
    "sport",
    "sdeId",
    "eventKey",
)
_INCIDENT_FIELDS = (
    "business_service",
    "cmdb_ci",
    "category",
    "subcategory",
    "impact_component",
    "impact_component_value",
)
_TECHNICAL_EVENT_FIELDS = frozenset({"source", "entity"})
_COMPONENT_INCIDENT_FIELDS = frozenset(
    {"business_service", "cmdb_ci", "impact_component_value"}
)
_MIN_COMPONENT_TOKEN_LENGTH = 4

type MatchedField = tuple[str, str, str]


@dataclass(frozen=True, slots=True)
class IncidentCorrelationInput:
    """Incident fields explicitly permitted to participate in correlation."""

    incident_id: str
    opened_at: datetime
    dimensions: Mapping[str, object]

    def __post_init__(self) -> None:
        if not self.incident_id:
            raise ValueError("incident_id must be non-empty")
        if self.opened_at.tzinfo is None or self.opened_at.utcoffset() != timedelta(0):
            raise ValueError("opened_at must be an aware UTC datetime")


@dataclass(frozen=True, slots=True)
class EventIncidentLink:
    """Persistable proof that the configured correlation rule accepted a pair."""

    correlation_id: str
    event_id: str
    incident_id: str
    rule_version: str
    time_distance_seconds: int
    matched_fields: tuple[MatchedField, ...]


@dataclass(frozen=True, slots=True)
class ProjectedEvidence:
    """Evidence derived exclusively from one accepted Event-Incident link."""

    evidence_id: str
    event_id: str
    incident_id: str
    correlation_id: str
    rule_version: str
    evidence_type: str
    relation: str
    strength: str
    time_distance_seconds: int
    matched_fields: tuple[MatchedField, ...]
    hypothesis_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class CorrelationOutcome:
    """The inseparable persisted link and Evidence produced by an accepted rule."""

    link: EventIncidentLink
    evidence: ProjectedEvidence


def _normalized(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().casefold()
    return normalized or None


def _matches(
    event_dimensions: Mapping[str, object], incident_dimensions: Mapping[str, object]
) -> tuple[MatchedField, ...]:
    event_values = {
        field: normalized
        for field in _EVENT_FIELDS
        if (normalized := _normalized(event_dimensions.get(field))) is not None
    }
    incident_values = {
        field: normalized
        for field in _INCIDENT_FIELDS
        if (normalized := _normalized(incident_dimensions.get(field))) is not None
    }
    matches: list[MatchedField] = []
    for event_field, event_value in event_values.items():
        for incident_field, incident_value in incident_values.items():
            if event_value == incident_value:
                matches.append((event_field, incident_field, event_value))
            elif (
                event_field in _TECHNICAL_EVENT_FIELDS
                and incident_field in _COMPONENT_INCIDENT_FIELDS
                and len(incident_value) >= _MIN_COMPONENT_TOKEN_LENGTH
                and re.search(
                    rf"(?<!\w){re.escape(incident_value)}(?!\w)", event_value
                )
                is not None
            ):
                matches.append((event_field, incident_field, incident_value))
    return tuple(sorted(matches))


def _stable_id(prefix: str, identity: object) -> str:
    digest = hashlib.sha256(canonical_bytes(identity)).digest()
    return prefix + base64.b32encode(digest).decode("ascii").lower()[:26]


def correlate_event(
    event: ProjectedEvent,
    incident: IncidentCorrelationInput,
    *,
    window_seconds: int,
) -> CorrelationOutcome | None:
    """Return Evidence only when time and exact semantic requirements both hold."""

    return correlate_event_fields(
        event_id=event.event_id,
        event_occurred_at=event.occurred_at,
        event_dimensions=event.dimensions,
        incident=incident,
        window_seconds=window_seconds,
    )


def correlate_event_fields(
    *,
    event_id: str,
    event_occurred_at: datetime | None,
    event_dimensions: Mapping[str, object],
    incident: IncidentCorrelationInput,
    window_seconds: int,
) -> CorrelationOutcome | None:
    """Apply the same rule to persisted projector fields without rebuilding an Event object."""

    if not 1 <= window_seconds <= MAX_CORRELATION_WINDOW_SECONDS:
        raise ValueError("window_seconds must be between 1 and 18000")
    if event_occurred_at is None:
        return None

    exact_distance = (event_occurred_at - incident.opened_at).total_seconds()
    if abs(exact_distance) > window_seconds:
        return None
    distance = int(exact_distance)
    matched_fields = _matches(event_dimensions, incident.dimensions)
    if not matched_fields:
        return None

    correlation_id = _stable_id(
        "cor_",
        (CORRELATION_RULE_VERSION, event_id, incident.incident_id),
    )
    evidence_id = _stable_id(
        "evd_",
        ("evidence:v1", event_id, incident.incident_id, CORRELATION_RULE_VERSION),
    )
    link = EventIncidentLink(
        correlation_id=correlation_id,
        event_id=event_id,
        incident_id=incident.incident_id,
        rule_version=CORRELATION_RULE_VERSION,
        time_distance_seconds=distance,
        matched_fields=matched_fields,
    )
    evidence = ProjectedEvidence(
        evidence_id=evidence_id,
        event_id=event_id,
        incident_id=incident.incident_id,
        correlation_id=correlation_id,
        rule_version=CORRELATION_RULE_VERSION,
        evidence_type="argus_event_correlation",
        relation="context",
        strength="strong" if len(matched_fields) >= 2 else "moderate",
        time_distance_seconds=distance,
        matched_fields=matched_fields,
        hypothesis_ids=(),
    )
    return CorrelationOutcome(link=link, evidence=evidence)


__all__ = [
    "CORRELATION_RULE_VERSION",
    "MAX_CORRELATION_WINDOW_SECONDS",
    "CorrelationOutcome",
    "EventIncidentLink",
    "IncidentCorrelationInput",
    "ProjectedEvidence",
    "correlate_event",
    "correlate_event_fields",
]
