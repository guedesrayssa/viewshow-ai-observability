from __future__ import annotations

import pytest

from scripts.validate_event_projections import ProjectionValidationError, validate_projection_items


def items() -> list[dict[str, object]]:
    event = {
        "eventId": "evt_1",
        "sourceDataset": "signal_bucket",
        "sourceRecordId": '[["id","1"]]',
        "canonicalLocator": "canonical://dsv_test/signal_bucket/record",
        "correlationStatus": "linked",
        "incidentIds": ["inc_1"],
        "correlations": [{"correlationId": "cor_1", "incidentId": "inc_1"}],
    }
    return [
        {"entityType": "EVENT", "payload": event},
        {
            "entityType": "INCIDENT_EVENT",
            "payload": {**event, "correlation": event["correlations"][0]},
        },
        {
            "entityType": "EVIDENCE",
            "payload": {
                "evidenceId": "evd_1",
                "eventId": "evt_1",
                "incidentId": "inc_1",
                "correlationId": "cor_1",
            },
        },
        {
            "entityType": "EVENT_PROJECTION_SUMMARY",
            "payload": {"events": 1, "linked": 1, "unlinked": 0, "evidence": 1},
        },
    ]


def test_validator_reports_a_reconciled_projection() -> None:
    report = validate_projection_items({"signal_bucket": 1}, items())

    assert report["status"] == "reconciled"
    assert report["events"] == 1
    assert report["evidence"] == 1
    assert report["bySource"] == {"signal_bucket": 1}


@pytest.mark.parametrize(
    ("eligible", "mutate", "message"),
    [
        ({"signal_bucket": 2}, lambda values: values, "eligible Event count"),
        (
            {"signal_bucket": 1},
            lambda values: [
                {**values[0], "payload": {**values[0]["payload"], "sourceRecordId": ""}},
                *values[1:],
            ],
            "source lineage",
        ),
        (
            {"signal_bucket": 1},
            lambda values: [
                *values[:2],
                {
                    **values[2],
                    "payload": {**values[2]["payload"], "correlationId": "cor_orphan"},
                },
                *values[3:],
            ],
            "orphan Evidence",
        ),
        (
            {"signal_bucket": 1},
            lambda values: [
                {**values[0], "payload": {**values[0]["payload"], "correlationStatus": "unlinked"}},
                *values[1:],
            ],
            "unlinked Event",
        ),
    ],
)
def test_validator_rejects_silent_loss_and_orphans(eligible, mutate, message) -> None:  # type: ignore[no-untyped-def]
    with pytest.raises(ProjectionValidationError, match=message):
        validate_projection_items(eligible, mutate(items()))
