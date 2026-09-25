"""Verify SQS publication produces valid ingestion analysis envelopes."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime

import pytest
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from adapters.dynamodb.outbox import DynamoOutboxRepository
from adapters.messaging.sqs import SqsAnalysisRequestPublisher, SqsPublishError, analysis_envelope
from domain.identity import sha256_id
from domain.models import TimeWindow


class RecordingSqs:
    def __init__(self, response: object = None) -> None:
        self.calls: list[dict[str, object]] = []
        self.response = response or {
            "MessageId": "message-1",
            "MD5OfMessageBody": "ignored",
            "ResponseMetadata": {"HTTPStatusCode": 200},
        }

    def send_message(self, **kwargs: object) -> Mapping[str, object]:
        self.calls.append(dict(kwargs))
        if isinstance(self.response, Exception):
            raise self.response
        assert isinstance(self.response, Mapping)
        return self.response


def _event():
    end = datetime(2026, 9, 9, 12, tzinfo=UTC)
    return DynamoOutboxRepository.build_event(
        "dsv_a",
        "ANOMALY_DETECTION",
        TimeWindow.from_epoch_ms(1788954300000, 1788955200000),
        created_at=end.replace(second=1),
    )


def test_envelope_is_closed_versioned_and_canonical() -> None:
    event = _event()

    envelope = analysis_envelope(event)

    assert set(envelope) == {
        "eventId",
        "eventType",
        "schemaVersion",
        "idempotencyKey",
        "traceId",
        "occurredAt",
        "producedAt",
        "source",
        "payload",
    }
    assert envelope["schemaVersion"] == "1.0"
    assert envelope["eventId"] == event.event_id
    assert envelope["idempotencyKey"] == event.idempotency_key
    assert envelope["occurredAt"] == "2026-09-09T12:00:00.000Z"
    assert envelope["producedAt"] == "2026-09-09T12:00:01.000Z"
    assert envelope["payload"]["datasetVersion"] == "dsv_a"


def test_standard_queue_send_uses_only_url_and_canonical_utf8_body() -> None:
    client = RecordingSqs()
    publisher = SqsAnalysisRequestPublisher(client, "https://sqs.us-east-1.amazonaws.com/1/q")
    event = _event()

    receipt = publisher.publish(event, idempotency_key=event.idempotency_key)

    assert receipt.message_id == "message-1"
    assert set(client.calls[0]) == {"QueueUrl", "MessageBody"}
    body = client.calls[0]["MessageBody"]
    assert isinstance(body, str)
    assert body.encode("utf-8") == json.dumps(
        json.loads(body), ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    assert "MessageGroupId" not in client.calls[0]
    assert "MessageDeduplicationId" not in client.calls[0]


def test_queue_url_and_response_are_validated_fail_closed() -> None:
    with pytest.raises(ValueError, match="queue_url"):
        SqsAnalysisRequestPublisher(RecordingSqs(), "https://user:secret@example.test/q")
    with pytest.raises(ValueError, match="queue_url"):
        SqsAnalysisRequestPublisher(RecordingSqs(), "https://sqs.us-east-1.amazonaws.com")

    publisher = SqsAnalysisRequestPublisher(
        RecordingSqs({"ResponseMetadata": {"HTTPStatusCode": 200}}),
        "https://sqs.us-east-1.amazonaws.com/1/q",
    )
    event = _event()
    with pytest.raises(SqsPublishError, match="valid MessageId"):
        publisher.publish(event, idempotency_key=event.idempotency_key)

    whitespace_id = SqsAnalysisRequestPublisher(
        RecordingSqs({"MessageId": " message-1 ", "ResponseMetadata": {"HTTPStatusCode": 200}}),
        "https://sqs.us-east-1.amazonaws.com/1/q",
    )
    with pytest.raises(SqsPublishError, match="valid MessageId"):
        whitespace_id.publish(event, idempotency_key=event.idempotency_key)

    missing_metadata = SqsAnalysisRequestPublisher(
        RecordingSqs({"MessageId": "message-1"}),
        "https://sqs.us-east-1.amazonaws.com/1/q",
    )
    with pytest.raises(SqsPublishError, match="status must be 200"):
        missing_metadata.publish(event, idempotency_key=event.idempotency_key)


def test_unknown_event_type_is_rejected_before_envelope_or_send() -> None:
    event = _event()
    identity = {
        "datasetVersion": event.dataset_version,
        "eventType": "UNSUPPORTED",
        "windowEnd": datetime(2026, 9, 9, 12, tzinfo=UTC),
    }
    unsupported = replace(
        event,
        event_type="UNSUPPORTED",
        event_id=sha256_id("evt_", identity),
        idempotency_key=sha256_id("ana_", identity),
    )
    client = RecordingSqs()
    publisher = SqsAnalysisRequestPublisher(client, "https://sqs.us-east-1.amazonaws.com/1/q")

    with pytest.raises(ValueError, match="event type"):
        analysis_envelope(unsupported)
    with pytest.raises(ValueError, match="event type"):
        publisher.publish(unsupported, idempotency_key=unsupported.idempotency_key)

    assert client.calls == []


def test_explicit_idempotency_key_must_match_event_before_send() -> None:
    client = RecordingSqs()
    publisher = SqsAnalysisRequestPublisher(client, "https://sqs.us-east-1.amazonaws.com/1/q")

    with pytest.raises(ValueError, match="match"):
        publisher.publish(_event(), idempotency_key="ana_different")

    assert client.calls == []


def test_client_error_is_sanitized_without_js_like_payload_or_credentials() -> None:
    secret = "AKIA_SUPER_SECRET"
    error = ClientError(
        {
            "Error": {
                "Code": "AccessDeniedException",
                "Message": f"{{credential: '{secret}', reason: undefined}}",
            }
        },
        "SendMessage",
    )
    publisher = SqsAnalysisRequestPublisher(
        RecordingSqs(error), "https://sqs.us-east-1.amazonaws.com/1/q"
    )
    event = _event()

    with pytest.raises(SqsPublishError) as captured:
        publisher.publish(event, idempotency_key=event.idempotency_key)

    message = str(captured.value)
    assert secret not in message
    assert "undefined" not in message
    assert "{" not in message
    assert "AccessDeniedException" in message


def test_message_larger_than_256_kib_is_rejected_before_send() -> None:
    end = datetime(2026, 9, 9, 12, tzinfo=UTC)
    oversized = DynamoOutboxRepository.build_event(
        "dsv_" + "x" * (256 * 1024),
        "ANOMALY_DETECTION",
        TimeWindow.from_epoch_ms(1788954300000, 1788955200000),
        created_at=end.replace(second=1),
    )
    client = RecordingSqs()
    publisher = SqsAnalysisRequestPublisher(client, "https://sqs.us-east-1.amazonaws.com/1/q")

    with pytest.raises(ValueError, match="256 KiB"):
        publisher.publish(oversized, idempotency_key=oversized.idempotency_key)

    assert client.calls == []
