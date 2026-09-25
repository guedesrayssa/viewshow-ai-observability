"""Project eligible canonical ARGUS facts into public, incident-neutral Events."""

from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import quote

from domain.canonical_json import canonical_bytes
from domain.models import CanonicalRecord, CanonicalValue, RecordType, TimeWindow

EVENT_ID_VERSION = "event:v1"
MISSING_EVENT_TIMESTAMP = "MISSING_EVENT_TIMESTAMP"

_EVENT_CATEGORIES = {
    ("signal_bucket", RecordType.SIGNAL_OBSERVATION): "signal_observation",
    ("live_event", RecordType.LIVE_EVENT_CONTEXT): "live_event",
    ("live_event_sde", RecordType.LIVE_EVENT_CONTEXT): "live_event_context",
}


@dataclass(frozen=True, slots=True)
class RawAvailability:
    """Describe whether the source row payload is directly materialized for public reads."""

    available: bool
    reason: str


@dataclass(frozen=True, slots=True)
class EventQuality:
    """Carry source quality and the watermark used to report Event freshness."""

    status: str
    flags: tuple[str, ...]
    observed_through: datetime | None


@dataclass(frozen=True, slots=True)
class ProjectedEvent:
    """Public Event projection with deterministic identity and complete canonical lineage."""

    event_id: str
    dataset_version: str
    category: str
    source_system: str
    source_dataset: str
    source_record_id: str
    canonical_locator: str
    occurred_at: datetime | None
    sort_at: datetime
    window: TimeWindow | None
    dimensions: dict[str, CanonicalValue]
    measures: dict[str, CanonicalValue]
    quality: EventQuality
    raw: RawAvailability


def _source_record_id(record: CanonicalRecord) -> str:
    return canonical_bytes(record.natural_key).decode("utf-8")


def _event_id(record: CanonicalRecord) -> str:
    identity = (EVENT_ID_VERSION, record.source_system, record.source_dataset, record.natural_key)
    digest = hashlib.sha256(canonical_bytes(identity)).digest()
    return "evt_" + base64.b32encode(digest).decode("ascii").lower()[:26]


def _updated_at(record: CanonicalRecord) -> datetime | None:
    value = record.measures.get("updatedAt")
    return value if isinstance(value, datetime) else None


def project_event(record: CanonicalRecord, *, dataset_version: str) -> ProjectedEvent | None:
    """Project one eligible canonical record without inferring an Incident relationship."""

    category = _EVENT_CATEGORIES.get((record.source_dataset, record.record_type))
    if category is None:
        return None
    if not dataset_version:
        raise ValueError("dataset_version must be non-empty")

    updated_at = _updated_at(record)
    sort_at = record.observed_at or updated_at
    if sort_at is None:
        raise ValueError(
            "an eligible Event requires observed_at or measures.updatedAt for ordering"
        )

    flags = set(record.quality_flags)
    if record.observed_at is None:
        flags.add(MISSING_EVENT_TIMESTAMP)
    ordered_flags = tuple(sorted(flags))
    observed_through = max(
        (value for value in (record.observed_at, updated_at) if value is not None),
        default=None,
    )
    source_record_id = _source_record_id(record)

    return ProjectedEvent(
        event_id=_event_id(record),
        dataset_version=dataset_version,
        category=category,
        source_system=record.source_system,
        source_dataset=record.source_dataset,
        source_record_id=source_record_id,
        canonical_locator=(
            f"canonical://{quote(dataset_version, safe='')}/"
            f"{quote(record.source_dataset, safe='')}/{quote(source_record_id, safe='')}"
        ),
        occurred_at=record.observed_at,
        sort_at=sort_at,
        window=record.window,
        dimensions=dict(record.dimensions),
        measures=dict(record.measures),
        quality=EventQuality(
            status="partial" if ordered_flags else "measured",
            flags=ordered_flags,
            observed_through=observed_through,
        ),
        raw=RawAvailability(
            available=False,
            reason="not_materialized_in_event_projection",
        ),
    )


__all__ = [
    "EVENT_ID_VERSION",
    "EventQuality",
    "ProjectedEvent",
    "RawAvailability",
    "project_event",
]
