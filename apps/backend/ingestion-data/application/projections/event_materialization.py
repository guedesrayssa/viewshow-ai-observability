"""Spool, correlate, and emit bounded Event/Evidence projection batches."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import cast

from application.projections.event_correlation import (
    CORRELATION_RULE_VERSION,
    IncidentCorrelationInput,
    correlate_event_fields,
)
from application.projections.events import ProjectedEvent, project_event
from application.projections.incidents import incident_id
from domain.canonical_json import canonical_bytes
from domain.models import CanonicalRecord, RecordType
from ports import EventProjectionItem

EVENT_PROJECTION_VERSION = "1.0"
EVENT_FORMULA_VERSION = "1.0"


@dataclass(frozen=True, slots=True)
class EventProjectionCounts:
    eligible: int
    events: int
    linked: int
    unlinked: int
    evidence: int

    def as_dict(self) -> dict[str, int]:
        return {
            "eligible": self.eligible,
            "events": self.events,
            "linked": self.linked,
            "unlinked": self.unlinked,
            "evidence": self.evidence,
        }


def _utc_text(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _epoch_milliseconds(value: datetime) -> int:
    delta = value - datetime(1970, 1, 1, tzinfo=UTC)
    return delta.days * 86_400_000 + delta.seconds * 1_000 + delta.microseconds // 1_000


def _public_value(value: object) -> object:
    if isinstance(value, datetime):
        return _utc_text(value)
    if isinstance(value, Mapping):
        return {str(key): _public_value(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return tuple(_public_value(item) for item in value)
    return value


def _restore(value: object) -> object:
    if isinstance(value, list):
        return tuple(_restore(item) for item in value)
    if not isinstance(value, Mapping):
        return value
    if set(value) == {"$decimal"} and isinstance(value["$decimal"], str):
        return Decimal(value["$decimal"])
    return {str(key): _restore(item) for key, item in value.items()}


def _decode(payload: bytes) -> dict[str, object]:
    value = _restore(json.loads(payload))
    if not isinstance(value, dict):
        raise ValueError("event projection spool payload must be an object")
    return cast(dict[str, object], value)


def _dependency(dataset: str, partition: str) -> dict[str, str]:
    return {"dataset": dataset, "partition": partition}


def _base_payload(event: ProjectedEvent, partition: str) -> dict[str, object]:
    observed_through = event.quality.observed_through or event.sort_at
    window = None
    if event.window is not None:
        window = {
            "start": _utc_text(event.window.start),
            "end": _utc_text(event.window.end),
            "grainSeconds": event.window.grain_seconds,
        }
    return {
        "eventId": event.event_id,
        "datasetVersion": event.dataset_version,
        "category": event.category,
        "sourceSystem": event.source_system,
        "sourceDataset": event.source_dataset,
        "sourceRecordId": event.source_record_id,
        "canonicalLocator": event.canonical_locator,
        "occurredAt": _utc_text(event.occurred_at),
        "sortAt": _utc_text(event.sort_at),
        "window": window,
        "dimensions": _public_value(event.dimensions),
        "measures": _public_value(event.measures),
        "quality": {
            "status": event.quality.status,
            "flags": event.quality.flags,
            "observedThrough": _utc_text(observed_through),
        },
        "raw": {"available": event.raw.available, "reason": event.raw.reason},
        "projectionVersion": EVENT_PROJECTION_VERSION,
        "formulaVersion": EVENT_FORMULA_VERSION,
        "requiredArchives": (_dependency(event.source_dataset, partition),),
        "inputWatermarks": {event.source_dataset: _utc_text(observed_through)},
        "observedThrough": _utc_text(observed_through),
        "coverage": "PARTIAL" if event.quality.flags else "COMPLETE",
        "qualityFlags": event.quality.flags,
    }


class EventProjectionMaterializer:
    """Use an on-disk spool so a large canonical dump does not need to fit in memory."""

    def __init__(
        self,
        database: Path,
        *,
        dataset_version: str,
        correlation_window_seconds: int,
    ) -> None:
        self.dataset_version = dataset_version
        self.correlation_window_seconds = correlation_window_seconds
        self._eligible = 0
        self._finished = False
        self._connection = sqlite3.connect(database)
        self._connection.executescript(
            """
            CREATE TABLE events (
                event_id TEXT PRIMARY KEY,
                sort_at TEXT NOT NULL,
                occurred_at TEXT,
                source_dataset TEXT NOT NULL,
                source_partition TEXT NOT NULL,
                dimensions BLOB NOT NULL,
                payload BLOB NOT NULL
            );
            CREATE INDEX events_occurred_at ON events(occurred_at);
            CREATE TABLE incidents (
                incident_id TEXT PRIMARY KEY,
                opened_at TEXT NOT NULL,
                source_dataset TEXT NOT NULL,
                source_partition TEXT NOT NULL,
                dimensions BLOB NOT NULL
            );
            CREATE INDEX incidents_opened_at ON incidents(opened_at);
            CREATE TABLE correlations (
                event_id TEXT NOT NULL,
                incident_id TEXT NOT NULL,
                link BLOB NOT NULL,
                evidence BLOB NOT NULL,
                PRIMARY KEY (event_id, incident_id)
            );
            """
        )

    def close(self) -> None:
        self._connection.close()

    def add(self, dataset: str, partition: str, record: CanonicalRecord) -> None:
        if dataset != record.source_dataset:
            raise ValueError("event projection record differs from archive dataset")
        projected = project_event(record, dataset_version=self.dataset_version)
        if projected is not None:
            self._eligible += 1
            payload = canonical_bytes(_base_payload(projected, partition))
            dimensions = canonical_bytes(_public_value(projected.dimensions))
            current = self._connection.execute(
                "SELECT payload FROM events WHERE event_id = ?", (projected.event_id,)
            ).fetchone()
            if current is not None:
                if current[0] != payload:
                    raise ValueError("one Event identity has divergent canonical content")
                return
            self._connection.execute(
                """
                INSERT INTO events (
                    event_id, sort_at, occurred_at, source_dataset, source_partition,
                    dimensions, payload
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    projected.event_id,
                    _utc_text(projected.sort_at),
                    _utc_text(projected.occurred_at),
                    dataset,
                    partition,
                    dimensions,
                    payload,
                ),
            )
        if record.record_type is RecordType.INCIDENT:
            if record.observed_at is None:
                raise ValueError("incident correlation requires opened_at")
            identifier = incident_id(record)
            dimensions = canonical_bytes(_public_value(record.dimensions))
            current = self._connection.execute(
                "SELECT opened_at, dimensions FROM incidents WHERE incident_id = ?", (identifier,)
            ).fetchone()
            values = (_utc_text(record.observed_at), dimensions)
            if current is not None:
                if current != values:
                    raise ValueError("one Incident identity has divergent canonical content")
                return
            self._connection.execute(
                """
                INSERT INTO incidents (
                    incident_id, opened_at, source_dataset, source_partition, dimensions
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (identifier, values[0], dataset, partition, dimensions),
            )

    def finish(self) -> EventProjectionCounts:
        if self._finished:
            return self.counts()
        window = timedelta(seconds=self.correlation_window_seconds)
        incidents = self._connection.execute(
            """
            SELECT incident_id, opened_at, source_dataset, source_partition, dimensions
            FROM incidents ORDER BY opened_at, incident_id
            """
        )
        for identifier, opened_text, _dataset, _partition, dimensions_blob in incidents:
            opened_at = datetime.fromisoformat(opened_text.replace("Z", "+00:00"))
            incident = IncidentCorrelationInput(
                incident_id=identifier,
                opened_at=opened_at,
                dimensions=_decode(dimensions_blob),
            )
            lower = _utc_text(opened_at - window)
            upper = _utc_text(opened_at + window)
            candidates = self._connection.execute(
                """
                SELECT event_id, occurred_at, dimensions
                FROM events
                WHERE occurred_at IS NOT NULL AND occurred_at BETWEEN ? AND ?
                ORDER BY occurred_at, event_id
                """,
                (lower, upper),
            )
            for event_identifier, occurred_text, event_dimensions_blob in candidates:
                occurred_at = datetime.fromisoformat(occurred_text.replace("Z", "+00:00"))
                outcome = correlate_event_fields(
                    event_id=event_identifier,
                    event_occurred_at=occurred_at,
                    event_dimensions=_decode(event_dimensions_blob),
                    incident=incident,
                    window_seconds=self.correlation_window_seconds,
                )
                if outcome is None:
                    continue
                link = {
                    "correlationId": outcome.link.correlation_id,
                    "eventId": outcome.link.event_id,
                    "incidentId": outcome.link.incident_id,
                    "ruleVersion": outcome.link.rule_version,
                    "timeDistanceSeconds": outcome.link.time_distance_seconds,
                    "matchedFields": outcome.link.matched_fields,
                }
                evidence = {
                    "evidenceId": outcome.evidence.evidence_id,
                    "eventId": outcome.evidence.event_id,
                    "incidentId": outcome.evidence.incident_id,
                    "correlationId": outcome.evidence.correlation_id,
                    "ruleVersion": outcome.evidence.rule_version,
                    "type": outcome.evidence.evidence_type,
                    "relation": outcome.evidence.relation,
                    "strength": outcome.evidence.strength,
                    "timeDistanceSeconds": outcome.evidence.time_distance_seconds,
                    "matchedFields": outcome.evidence.matched_fields,
                    "hypothesisIds": outcome.evidence.hypothesis_ids,
                }
                self._connection.execute(
                    """
                    INSERT OR REPLACE INTO correlations (
                        event_id, incident_id, link, evidence
                    ) VALUES (?, ?, ?, ?)
                    """,
                    (
                        event_identifier,
                        identifier,
                        canonical_bytes(link),
                        canonical_bytes(evidence),
                    ),
                )
        self._connection.commit()
        self._finished = True
        counts = self.counts()
        if counts.eligible != counts.events:
            raise ValueError("eligible canonical Event count differs from projected Event count")
        return counts

    def counts(self) -> EventProjectionCounts:
        events = cast(int, self._connection.execute("SELECT COUNT(*) FROM events").fetchone()[0])
        linked = cast(
            int,
            self._connection.execute(
                "SELECT COUNT(DISTINCT event_id) FROM correlations"
            ).fetchone()[0],
        )
        evidence = cast(
            int, self._connection.execute("SELECT COUNT(*) FROM correlations").fetchone()[0]
        )
        return EventProjectionCounts(
            eligible=self._eligible,
            events=events,
            linked=linked,
            unlinked=events - linked,
            evidence=evidence,
        )

    def iter_items(self) -> Iterator[EventProjectionItem]:
        counts = self.finish()
        observed: list[str] = []
        summary_flags: set[str] = set()
        rows = self._connection.execute(
            """
            SELECT event_id, sort_at, source_dataset, source_partition, payload
            FROM events ORDER BY sort_at, event_id
            """
        )
        for event_identifier, sort_text, source_dataset, source_partition, payload_blob in rows:
            payload = _decode(payload_blob)
            correlations = self._connection.execute(
                """
                SELECT c.incident_id, c.link, c.evidence,
                       i.source_dataset, i.source_partition
                FROM correlations c
                JOIN incidents i ON i.incident_id = c.incident_id
                WHERE c.event_id = ? ORDER BY c.incident_id
                """,
                (event_identifier,),
            ).fetchall()
            incident_ids = tuple(row[0] for row in correlations)
            correlation_links = tuple(_decode(row[1]) for row in correlations)
            global_payload = {
                **payload,
                "correlationStatus": "linked" if incident_ids else "unlinked",
                "incidentIds": incident_ids,
                "correlations": correlation_links,
            }
            quality_flags = cast(list[object], payload["qualityFlags"])
            summary_flags.update(str(flag) for flag in quality_flags)
            sort_at = datetime.fromisoformat(sort_text.replace("Z", "+00:00"))
            observed.append(sort_text)
            timestamp = _epoch_milliseconds(sort_at)
            day = sort_at.strftime("%Y%m%d")
            yield EventProjectionItem(
                self.dataset_version,
                f"DATASET#{self.dataset_version}#VIEW#EVENTS#DAY#{day}",
                f"OCCURRED#{timestamp:013d}#EVENT#{event_identifier}",
                "EVENT",
                global_payload,
            )
            yield EventProjectionItem(
                self.dataset_version,
                f"DATASET#{self.dataset_version}#EVENT#{event_identifier}",
                "CURRENT",
                "EVENT_LOOKUP",
                global_payload,
            )
            for (
                incident_identifier,
                link_blob,
                evidence_blob,
                incident_dataset,
                incident_partition,
            ) in correlations:
                dependencies = tuple(
                    sorted(
                        (
                            _dependency(source_dataset, source_partition),
                            _dependency(incident_dataset, incident_partition),
                        ),
                        key=lambda item: (item["dataset"], item["partition"]),
                    )
                )
                link = _decode(link_blob)
                incident_payload = {
                    **global_payload,
                    "correlation": link,
                    "requiredArchives": dependencies,
                }
                incident_pk = f"DATASET#{self.dataset_version}#INCIDENT#{incident_identifier}"
                yield EventProjectionItem(
                    self.dataset_version,
                    incident_pk,
                    f"EVENT#{timestamp:013d}#{event_identifier}",
                    "INCIDENT_EVENT",
                    incident_payload,
                )
                evidence = {
                    **_decode(evidence_blob),
                    "eventOccurredAt": payload["occurredAt"],
                    "sourceDataset": source_dataset,
                    "sourceRecordId": payload["sourceRecordId"],
                    "requiredArchives": dependencies,
                    "projectionVersion": EVENT_PROJECTION_VERSION,
                    "formulaVersion": EVENT_FORMULA_VERSION,
                    "observedThrough": payload["observedThrough"],
                    "coverage": payload["coverage"],
                    "qualityFlags": payload["qualityFlags"],
                }
                yield EventProjectionItem(
                    self.dataset_version,
                    incident_pk,
                    f"EVIDENCE#{timestamp:013d}#{evidence['evidenceId']}",
                    "EVIDENCE",
                    evidence,
                )

        summary_observed = max(observed) if observed else None
        yield EventProjectionItem(
            self.dataset_version,
            f"DATASET#{self.dataset_version}#VIEW#EVENTS",
            "SUMMARY",
            "EVENT_PROJECTION_SUMMARY",
            {
                **counts.as_dict(),
                "projectionVersion": EVENT_PROJECTION_VERSION,
                "formulaVersion": EVENT_FORMULA_VERSION,
                "ruleVersion": CORRELATION_RULE_VERSION,
                "windowSeconds": self.correlation_window_seconds,
                "observedThrough": summary_observed,
                "coverage": "PARTIAL" if summary_flags else "COMPLETE",
                "qualityFlags": tuple(sorted(summary_flags)),
            },
        )

    def iter_batches(self, size: int = 25) -> Iterator[tuple[EventProjectionItem, ...]]:
        pending: list[EventProjectionItem] = []
        for item in self.iter_items():
            pending.append(item)
            if len(pending) == size:
                yield tuple(pending)
                pending.clear()
        if pending:
            yield tuple(pending)


__all__ = [
    "EVENT_FORMULA_VERSION",
    "EVENT_PROJECTION_VERSION",
    "EventProjectionCounts",
    "EventProjectionMaterializer",
]
