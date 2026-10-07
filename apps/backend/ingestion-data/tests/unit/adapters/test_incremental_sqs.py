"""Verify the closed FIFO envelope for incremental batch references."""

from __future__ import annotations

import json
from dataclasses import FrozenInstanceError

import pytest

from domain.incremental_batches import IncrementalBatchReference

BATCH_ID = "bat_" + "a" * 64
MANIFEST_KEY = (
    "raw/argus/incremental/dataset=signal_bucket/"
    "window_start=20260917T100000000Z/"
    f"batch_id={BATCH_ID}/manifest.json"
)


class RecordingSqsClient:
    def __init__(self, messages: list[dict[str, object]] | None = None) -> None:
        self.sent: list[dict[str, object]] = []
        self.received: list[dict[str, object]] = []
        self.deleted: list[dict[str, object]] = []
        self.visibility_changes: list[dict[str, object]] = []
        self.messages = messages or []

    def send_message(self, **kwargs: object) -> dict[str, object]:
        self.sent.append(dict(kwargs))
        return {"MessageId": "message-1"}

    def receive_message(self, **kwargs: object) -> dict[str, object]:
        self.received.append(dict(kwargs))
        return {"Messages": self.messages}

    def delete_message(self, **kwargs: object) -> dict[str, object]:
        self.deleted.append(dict(kwargs))
        return {}

    def change_message_visibility(self, **kwargs: object) -> dict[str, object]:
        self.visibility_changes.append(dict(kwargs))
        return {}


def reference() -> IncrementalBatchReference:
    return IncrementalBatchReference("bucket-name", MANIFEST_KEY, "version-1")


def queue(client: RecordingSqsClient):
    try:
        from adapters.messaging.incremental_sqs import SqsIncrementalBatchQueue
    except ModuleNotFoundError:
        pytest.fail("The incremental FIFO queue adapter is missing")
    return SqsIncrementalBatchQueue(
        client,
        "https://sqs.us-east-1.amazonaws.com/123456789012/incremental.fifo",
    )


def body(**changes: object) -> str:
    payload: dict[str, object] = {
        "contractVersion": "1.0",
        "batchId": BATCH_ID,
        "sourceDataset": "signal_bucket",
        "manifest": {
            "bucket": "bucket-name",
            "key": MANIFEST_KEY,
            "versionId": "version-1",
        },
    }
    payload.update(changes)
    return json.dumps(payload, separators=(",", ":"), sort_keys=True)


def test_send_uses_dataset_group_and_batch_deduplication() -> None:
    client = RecordingSqsClient()
    queue(client).send(reference(), batch_id=BATCH_ID, dataset="signal_bucket")

    request = client.sent[0]
    assert request["MessageGroupId"] == "signal_bucket"
    assert request["MessageDeduplicationId"] == BATCH_ID
    assert set(json.loads(request["MessageBody"])) == {
        "contractVersion",
        "batchId",
        "sourceDataset",
        "manifest",
    }
    assert json.loads(request["MessageBody"])["manifest"] == {
        "bucket": "bucket-name",
        "key": MANIFEST_KEY,
        "versionId": "version-1",
    }


def test_receive_long_polls_and_returns_immutable_delivery() -> None:
    client = RecordingSqsClient(
        [{"MessageId": "message-1", "ReceiptHandle": "receipt-1", "Body": body()}]
    )

    delivery = queue(client).receive(3)[0]

    assert client.received == [
        {
            "QueueUrl": "https://sqs.us-east-1.amazonaws.com/123456789012/incremental.fifo",
            "MaxNumberOfMessages": 3,
            "WaitTimeSeconds": 20,
        }
    ]
    assert delivery.batch_id == BATCH_ID
    assert delivery.reference == reference()
    with pytest.raises(FrozenInstanceError):
        delivery.batch_id = "changed"  # type: ignore[misc]


def test_receive_rejects_open_or_oversized_envelope() -> None:
    extra = RecordingSqsClient(
        [
            {
                "MessageId": "message-1",
                "ReceiptHandle": "receipt-1",
                "Body": body(unexpected=True),
            }
        ]
    )
    with pytest.raises(ValueError, match="fields"):
        queue(extra).receive(1)

    oversized = RecordingSqsClient(
        [
            {
                "MessageId": "message-1",
                "ReceiptHandle": "receipt-1",
                "Body": "x" * (256 * 1024 + 1),
            }
        ]
    )
    with pytest.raises(ValueError, match="size"):
        queue(oversized).receive(1)


def test_ack_deletes_only_the_matching_receipt() -> None:
    client = RecordingSqsClient(
        [{"MessageId": "message-1", "ReceiptHandle": "receipt-1", "Body": body()}]
    )
    adapter = queue(client)
    delivery = adapter.receive(1)[0]

    adapter.ack(delivery)

    assert client.deleted == [
        {
            "QueueUrl": "https://sqs.us-east-1.amazonaws.com/123456789012/incremental.fifo",
            "ReceiptHandle": "receipt-1",
        }
    ]


def test_extend_visibility_changes_only_the_matching_receipt() -> None:
    client = RecordingSqsClient(
        [{"MessageId": "message-1", "ReceiptHandle": "receipt-1", "Body": body()}]
    )
    adapter = queue(client)
    delivery = adapter.receive(1)[0]

    adapter.extend_visibility(delivery, 300)

    assert client.visibility_changes == [
        {
            "QueueUrl": "https://sqs.us-east-1.amazonaws.com/123456789012/incremental.fifo",
            "ReceiptHandle": "receipt-1",
            "VisibilityTimeout": 300,
        }
    ]


@pytest.mark.parametrize("seconds", [-1, 43_201, True])
def test_extend_visibility_rejects_seconds_outside_sqs_bounds(seconds: object) -> None:
    client = RecordingSqsClient(
        [{"MessageId": "message-1", "ReceiptHandle": "receipt-1", "Body": body()}]
    )
    adapter = queue(client)
    delivery = adapter.receive(1)[0]

    with pytest.raises((TypeError, ValueError), match="seconds"):
        adapter.extend_visibility(delivery, seconds)  # type: ignore[arg-type]
    assert client.visibility_changes == []


@pytest.mark.parametrize("limit", [0, 11, True])
def test_receive_rejects_limits_outside_sqs_bounds(limit: object) -> None:
    with pytest.raises((TypeError, ValueError), match="limit"):
        queue(RecordingSqsClient()).receive(limit)  # type: ignore[arg-type]
