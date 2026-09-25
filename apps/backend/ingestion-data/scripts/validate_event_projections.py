"""Reconcile canonical ARGUS eligibility with public Event projections.

The validator is intentionally read-only. It accepts exported projection items so it
can be used against a local build or a DynamoDB scan without coupling validation to
AWS credentials.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any


class ProjectionValidationError(ValueError):
    """Raised when projected Events or Evidence cannot be reconciled."""


def _payload(item: Mapping[str, Any]) -> Mapping[str, Any]:
    payload = item.get("payload")
    if not isinstance(payload, Mapping):
        raise ProjectionValidationError("projection item has no object payload")
    return payload


def _require_lineage(event: Mapping[str, Any]) -> None:
    required = ("sourceDataset", "sourceRecordId", "canonicalLocator")
    if any(not isinstance(event.get(field), str) or not event[field].strip() for field in required):
        raise ProjectionValidationError("Event source lineage is incomplete")


def validate_projection_items(
    eligible_by_source: Mapping[str, int],
    projection_items: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    """Validate counts, source lineage, correlations, and projection summary."""

    eligible = {str(source): int(count) for source, count in eligible_by_source.items()}
    if any(count < 0 for count in eligible.values()):
        raise ProjectionValidationError("eligible Event counts cannot be negative")

    events: dict[str, Mapping[str, Any]] = {}
    correlations: set[tuple[str, str, str]] = set()
    evidence: list[Mapping[str, Any]] = []
    summaries: list[Mapping[str, Any]] = []
    by_source: Counter[str] = Counter()

    for item in projection_items:
        entity_type = item.get("entityType")
        payload = _payload(item)
        if entity_type == "EVENT":
            event_id = payload.get("eventId")
            if not isinstance(event_id, str) or not event_id:
                raise ProjectionValidationError("Event has no eventId")
            if event_id in events:
                raise ProjectionValidationError(f"duplicate Event {event_id}")
            _require_lineage(payload)
            events[event_id] = payload
            by_source[str(payload["sourceDataset"])] += 1
        elif entity_type == "INCIDENT_EVENT":
            event_id = payload.get("eventId")
            correlation = payload.get("correlation")
            if not isinstance(event_id, str) or not isinstance(correlation, Mapping):
                raise ProjectionValidationError("incident Event correlation is incomplete")
            correlation_id = correlation.get("correlationId")
            incident_id = correlation.get("incidentId")
            if not isinstance(correlation_id, str) or not isinstance(incident_id, str):
                raise ProjectionValidationError("incident Event correlation is incomplete")
            correlations.add((event_id, incident_id, correlation_id))
        elif entity_type == "EVIDENCE":
            evidence.append(payload)
        elif entity_type == "EVENT_PROJECTION_SUMMARY":
            summaries.append(payload)

    expected_total = sum(eligible.values())
    projected_by_source = dict(sorted(by_source.items()))
    if len(events) != expected_total or projected_by_source != dict(sorted(eligible.items())):
        raise ProjectionValidationError(
            f"eligible Event count mismatch: expected {eligible}, projected {dict(by_source)}"
        )

    linked = 0
    for event_id, event in events.items():
        status = event.get("correlationStatus")
        incident_ids = event.get("incidentIds")
        event_correlations = event.get("correlations")
        has_links = bool(incident_ids) or bool(event_correlations)
        if status == "linked":
            linked += 1
            if not has_links:
                raise ProjectionValidationError(f"linked Event {event_id} has no correlation")
        elif status == "unlinked":
            if has_links:
                raise ProjectionValidationError(f"unlinked Event {event_id} contains correlations")
        else:
            raise ProjectionValidationError(f"Event {event_id} has invalid correlation status")

    for item in evidence:
        key = (item.get("eventId"), item.get("incidentId"), item.get("correlationId"))
        if not all(isinstance(value, str) and value for value in key) or key not in correlations:
            evidence_id = item.get("evidenceId", "<unknown>")
            raise ProjectionValidationError(f"orphan Evidence {evidence_id}")

    if len(summaries) != 1:
        raise ProjectionValidationError("projection must contain exactly one Event summary")
    actual_summary = {
        "events": len(events),
        "linked": linked,
        "unlinked": len(events) - linked,
        "evidence": len(evidence),
    }
    summary = summaries[0]
    if any(summary.get(field) != value for field, value in actual_summary.items()):
        raise ProjectionValidationError(
            f"Event summary mismatch: expected {actual_summary}, projected {dict(summary)}"
        )

    return {
        "status": "reconciled",
        **actual_summary,
        "eligible": expected_total,
        "bySource": dict(sorted(by_source.items())),
        "deterministicIdSamples": sorted(events)[:10],
    }


def _read_json_lines(path: Path) -> list[Mapping[str, Any]]:
    items: list[Mapping[str, Any]] = []
    with path.open(encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, Mapping):
                raise ProjectionValidationError(f"line {line_number} is not a JSON object")
            items.append(value)
    return items


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--eligible-counts", required=True, type=Path)
    parser.add_argument("--projection-items", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    eligible = json.loads(args.eligible_counts.read_text(encoding="utf-8"))
    if not isinstance(eligible, Mapping):
        raise ProjectionValidationError("eligible counts must be a JSON object")
    report = validate_projection_items(eligible, _read_json_lines(args.projection_items))
    rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
