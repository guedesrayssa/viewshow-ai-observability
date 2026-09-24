"""Verify DynamoDB persistence and recovery of ingestion outbox events."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import cast

import pytest
from boto3.dynamodb.types import TypeDeserializer, TypeSerializer  # type: ignore[import-untyped]
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from adapters.dynamodb.client import DynamoDbThrottled
from adapters.dynamodb.outbox import DynamoOutboxRepository, pending_outbox
from domain.models import TimeWindow
from ports import ConditionalWriteError, OutboxBacklog

NOW = datetime(2026, 9, 9, 12, 0, tzinfo=UTC)
SERIALIZER = TypeSerializer()
DESERIALIZER = TypeDeserializer()


class RecordingClient:
    def __init__(self) -> None:
        self.items: dict[tuple[str, str], dict[str, object]] = {}
        self.transaction_calls: list[dict[str, object]] = []
        self.query_calls: list[dict[str, object]] = []

    def get_item(self, **kwargs: object) -> Mapping[str, object]:
        key = cast(Mapping[str, Mapping[str, str]], kwargs["Key"])
        item = self.items.get((key["pk"]["S"], key["sk"]["S"]))
        if item is None:
            return {"ResponseMetadata": {"HTTPStatusCode": 200}}
        return {
            "Item": {name: SERIALIZER.serialize(value) for name, value in item.items()},
            "ResponseMetadata": {"HTTPStatusCode": 200},
        }

    def transact_write_items(self, **kwargs: object) -> Mapping[str, object]:
        self.transaction_calls.append(dict(kwargs))
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}

    def query(self, **kwargs: object) -> Mapping[str, object]:
        self.query_calls.append(dict(kwargs))
        return {"Items": [], "ResponseMetadata": {"HTTPStatusCode": 200}}


class ThrottledClient(RecordingClient):
    def __init__(self, operation: str) -> None:
        super().__init__()
        self.operation = operation

    @staticmethod
    def _failure(operation: str) -> ClientError:
        return ClientError(
            {"Error": {"Code": "ThrottlingException", "Message": "private"}}, operation
        )

    def get_item(self, **kwargs: object) -> Mapping[str, object]:
        if self.operation == "GetItem":
            raise self._failure(self.operation)
        return super().get_item(**kwargs)

    def transact_write_items(self, **kwargs: object) -> Mapping[str, object]:
        if self.operation == "TransactWriteItems":
            raise self._failure(self.operation)
        return super().transact_write_items(**kwargs)

    def query(self, **kwargs: object) -> Mapping[str, object]:
        if self.operation == "Query":
            raise self._failure(self.operation)
        return super().query(**kwargs)


def _event(event_type: str = "ANOMALY_DETECTION", *, created_at: datetime = NOW):
    duration = timedelta(hours=1) if event_type == "QOE_FORECAST" else timedelta(minutes=15)
    grain = 3600 if event_type == "QOE_FORECAST" else 900
    return DynamoOutboxRepository.build_event(
        "dsv_a",
        event_type,
        TimeWindow(created_at - duration, created_at, grain),
        created_at=created_at + timedelta(seconds=1),
    )


def _decode_item(value: object) -> dict[str, object]:
    assert isinstance(value, Mapping)
    return {
        cast(str, name): DESERIALIZER.deserialize(cast(dict[str, object], attribute))
        for name, attribute in value.items()
    }


def test_pending_item_has_canonical_sparse_index_and_closed_identity() -> None:
    event = _event()

    item = pending_outbox(event)

    assert item["pk"] == "INGESTION#OUTBOX#20260909"
    assert item["sk"].startswith("CREATED#1788955201000#ANOMALY_DETECTION#evt_")
    assert item["outboxStatePk"] == "OUTBOX#PENDING"
    assert item["outboxStateSk"] == (f"2026-09-09T12:00:01.000Z#ANOMALY_DETECTION#{event.event_id}")
    assert set(item) == {
        "pk",
        "sk",
        "entityType",
        "eventId",
        "datasetVersion",
        "eventType",
        "idempotencyKey",
        "createdAt",
        "payload",
        "state",
        "outboxStatePk",
        "outboxStateSk",
    }


def test_window_commit_is_one_transaction_with_watermark_events_and_idempotency() -> None:
    client = RecordingClient()
    repository = DynamoOutboxRepository(client, "hot", clock=lambda: NOW)
    anomaly = _event()
    forecast = _event("QOE_FORECAST")

    repository.commit_watermark_and_outboxes(
        "dsv_a",
        "argus",
        NOW,
        (anomaly, forecast),
        expected_watermark=None,
        idempotency_key="window-1",
    )

    assert len(client.transaction_calls) == 1
    writes = cast(list[dict[str, object]], client.transaction_calls[0]["TransactItems"])
    decoded_puts = [
        _decode_item(cast(Mapping[str, object], item["Put"])["Item"]) for item in writes
    ]
    watermark = next(item for item in decoded_puts if item.get("entityType") == "WATERMARK")
    assert watermark == {
        "pk": "DATASET#dsv_a#INGESTION#SOURCE#argus",
        "sk": "WATERMARK",
        "entityType": "WATERMARK",
        "datasetVersion": "dsv_a",
        "source": "argus",
        "publishedWatermark": "2026-09-09T12:00:00.000Z",
    }
    assert {item.get("eventType") for item in decoded_puts if item.get("state") == "PENDING"} == {
        "ANOMALY_DETECTION",
        "QOE_FORECAST",
    }
    assert any(item.get("operation") == "window-commit" for item in decoded_puts)


def test_outbox_translates_exhausted_transaction_throttling() -> None:
    repository = DynamoOutboxRepository(
        ThrottledClient("TransactWriteItems"), "hot", clock=lambda: NOW
    )

    with pytest.raises(DynamoDbThrottled):
        repository.commit_watermark_and_outboxes(
            "dsv_a",
            "argus",
            NOW,
            (_event(),),
            expected_watermark=None,
            idempotency_key="throttled-window",
        )


@pytest.mark.parametrize("operation", ["GetItem", "Query"])
def test_outbox_translates_exhausted_read_throttling(operation: str) -> None:
    repository = DynamoOutboxRepository(ThrottledClient(operation), "hot", clock=lambda: NOW)

    with pytest.raises(DynamoDbThrottled):
        if operation == "GetItem":
            repository.get_watermark("dsv_a", "argus")
        else:
            repository.list_pending(1)


def test_window_commit_rejects_more_than_two_events_before_aws() -> None:
    client = RecordingClient()
    repository = DynamoOutboxRepository(client, "hot")

    with pytest.raises(ValueError, match="at most two"):
        repository.commit_watermark_and_outboxes(
            "dsv_a",
            "argus",
            NOW,
            (_event(), _event("QOE_FORECAST"), _event()),
            expected_watermark=None,
            idempotency_key="window-too-many",
        )

    assert client.transaction_calls == []


def test_window_commit_without_events_writes_only_watermark_and_marker() -> None:
    client = RecordingClient()
    repository = DynamoOutboxRepository(client, "hot", clock=lambda: NOW)

    repository.commit_watermark_and_outboxes(
        "dsv_a",
        "argus",
        NOW,
        (),
        expected_watermark=None,
        idempotency_key="window-empty",
    )

    writes = cast(list[dict[str, object]], client.transaction_calls[0]["TransactItems"])
    decoded_puts = [
        _decode_item(cast(Mapping[str, object], item["Put"])["Item"]) for item in writes
    ]
    assert len(writes) == 2
    assert [item.get("entityType") for item in decoded_puts] == ["WATERMARK", None]
    assert decoded_puts[1]["operation"] == "window-commit"


def test_window_commit_rejects_unbounded_bucket_evidence_before_aws() -> None:
    client = RecordingClient()
    repository = DynamoOutboxRepository(client, "hot", clock=lambda: NOW)
    evidence = tuple(("signal_bucket", offset, offset + 1, 900) for offset in range(257))

    with pytest.raises(ValueError, match="bounded tail"):
        repository.commit_watermark_and_outboxes(
            "dsv_a",
            "argus",
            NOW,
            (),
            expected_watermark=None,
            idempotency_key="window-evidence-too-large",
            bucket_evidence=evidence,
        )

    assert client.transaction_calls == []


def test_reader_accepts_a_legacy_raw_evidence_tail_that_fits_the_item_limit() -> None:
    client = RecordingClient()
    repository = DynamoOutboxRepository(client, "hot", clock=lambda: NOW)
    start = int(NOW.timestamp() * 1000)
    raw = [
        {
            "dataset": "signal_bucket",
            "startMs": start + offset * 900_000,
            "endMs": start + (offset + 1) * 900_000,
            "grainSeconds": 900,
        }
        for offset in range(1_500)
    ]
    client.items[("DATASET#dsv_a#INGESTION#SOURCE#source:signal_bucket", "WATERMARK")] = {
        "pk": "DATASET#dsv_a#INGESTION#SOURCE#source:signal_bucket",
        "sk": "WATERMARK",
        "entityType": "WATERMARK",
        "datasetVersion": "dsv_a",
        "source": "source:signal_bucket",
        "publishedWatermark": "2026-09-09T12:00:00.000Z",
        "bucketEvidence": raw,
    }

    evidence = repository.get_bucket_evidence("dsv_a", "source:signal_bucket")

    assert len(evidence) == 1_500
    assert evidence[0] == ("signal_bucket", start, start + 900_000, 900)


def test_reader_finds_a_published_event_without_mutating_its_receipt() -> None:
    event = _event()
    client = RecordingClient()
    repository = DynamoOutboxRepository(client, "hot", clock=lambda: NOW)
    published = dict(pending_outbox(event))
    published.pop("outboxStatePk")
    published.pop("outboxStateSk")
    published.update(
        {
            "state": "PUBLISHED",
            "messageId": "receipt-preserved",
            "publishedAt": "2026-09-09T12:01:00.000Z",
        }
    )
    locator = repository.locator_item(event)
    client.items[(locator["pk"], locator["sk"])] = locator
    client.items[(published["pk"], published["sk"])] = published

    assert repository.get_outbox_event(event.event_id) == event
    assert client.items[(published["pk"], published["sk"])]["messageId"] == "receipt-preserved"


def test_window_commit_rejects_event_for_wrong_watermark_before_aws() -> None:
    client = RecordingClient()
    repository = DynamoOutboxRepository(client, "hot")

    with pytest.raises(ValueError, match="inputWatermark"):
        repository.commit_watermark_and_outboxes(
            "dsv_a",
            "argus",
            NOW + timedelta(minutes=15),
            (_event(),),
            expected_watermark=NOW,
            idempotency_key="window-mismatch",
        )

    assert client.transaction_calls == []


def test_sub_millisecond_event_time_is_rejected_instead_of_being_truncated() -> None:
    with pytest.raises(ValueError, match="millisecond"):
        _event(created_at=NOW.replace(microsecond=1))


def test_list_pending_paginates_query_oldest_first_and_honors_limit() -> None:
    first = _event(created_at=NOW - timedelta(hours=2))
    second = _event(created_at=NOW - timedelta(hours=1))
    client = RecordingClient()
    pages = [
        {
            "Items": [
                {name: SERIALIZER.serialize(value) for name, value in pending_outbox(first).items()}
            ],
            "LastEvaluatedKey": {"pk": {"S": "cursor"}, "sk": {"S": "cursor"}},
            "ResponseMetadata": {"HTTPStatusCode": 200},
        },
        {
            "Items": [
                {
                    name: SERIALIZER.serialize(value)
                    for name, value in pending_outbox(second).items()
                }
            ],
            "ResponseMetadata": {"HTTPStatusCode": 200},
        },
    ]
    client.query = lambda **kwargs: (client.query_calls.append(dict(kwargs)) or pages.pop(0))
    repository = DynamoOutboxRepository(client, "hot")

    assert repository.list_pending(2) == (first, second)
    assert [call["Limit"] for call in client.query_calls] == [2, 1]
    assert all(call["IndexName"] == "outbox-pending-index" for call in client.query_calls)
    assert all(call["ScanIndexForward"] is True for call in client.query_calls)
    assert "ExclusiveStartKey" not in client.query_calls[0]
    assert client.query_calls[1]["ExclusiveStartKey"] == {
        "pk": {"S": "cursor"},
        "sk": {"S": "cursor"},
    }


def test_inspect_pending_counts_paginated_gsi_without_scanning_payloads() -> None:
    oldest = _event(created_at=NOW - timedelta(hours=2))
    middle = _event(event_type="QOE_FORECAST", created_at=NOW - timedelta(hours=1))
    newest = _event(event_type="ANOMALY_DETECTION", created_at=NOW)

    def projected(event):  # type: ignore[no-untyped-def]
        item = pending_outbox(event)
        return {
            name: SERIALIZER.serialize(item[name])
            for name in ("pk", "sk", "outboxStatePk", "outboxStateSk", "createdAt")
        }

    client = RecordingClient()
    pages = [
        {
            "Items": [projected(oldest)],
            "Count": 1,
            "ScannedCount": 1,
            "LastEvaluatedKey": {"pk": {"S": "one"}, "sk": {"S": "one"}},
        },
        {
            "Items": [projected(middle), projected(newest)],
            "Count": 2,
            "ScannedCount": 2,
        },
    ]
    client.query = lambda **kwargs: (client.query_calls.append(dict(kwargs)) or pages.pop(0))

    observed = DynamoOutboxRepository(client, "hot").inspect_pending()

    assert observed == OutboxBacklog(3, oldest.created_at)
    assert [call["Limit"] for call in client.query_calls] == [100, 100]
    assert all("Select" not in call for call in client.query_calls)
    assert all(
        call["ProjectionExpression"] == "pk, sk, #state_pk, outboxStateSk, createdAt"
        for call in client.query_calls
    )
    assert all(call["IndexName"] == "outbox-pending-index" for call in client.query_calls)
    assert all("ConsistentRead" not in call for call in client.query_calls)


def test_mark_published_conditionally_removes_both_sparse_keys_in_one_update() -> None:
    event = _event()
    client = RecordingClient()
    item = pending_outbox(event)
    client.items[(cast(str, item["pk"]), cast(str, item["sk"]))] = item
    locator = DynamoOutboxRepository.locator_item(event)
    client.items[(cast(str, locator["pk"]), cast(str, locator["sk"]))] = locator
    repository = DynamoOutboxRepository(client, "hot", clock=lambda: NOW)

    repository.mark_published(
        event.event_id,
        "message-1",
        expected_state="PENDING",
        idempotency_key="mark-1",
    )

    writes = cast(list[dict[str, object]], client.transaction_calls[0]["TransactItems"])
    update = cast(Mapping[str, object], writes[0]["Update"])
    assert update["ConditionExpression"] == "#state = :pending"
    assert update["UpdateExpression"] == (
        "SET #state = :published, messageId = :message_id, publishedAt = :published_at "
        "REMOVE outboxStatePk, outboxStateSk"
    )
    assert len(writes) == 2


def test_mark_published_normalizes_runtime_clock_to_milliseconds() -> None:
    event = _event()
    client = RecordingClient()
    item = pending_outbox(event)
    client.items[(cast(str, item["pk"]), cast(str, item["sk"]))] = item
    locator = DynamoOutboxRepository.locator_item(event)
    client.items[(cast(str, locator["pk"]), cast(str, locator["sk"]))] = locator
    repository = DynamoOutboxRepository(
        client,
        "hot",
        clock=lambda: datetime(2026, 9, 9, 12, 0, 0, 123456, tzinfo=UTC),
    )

    repository.mark_published(
        event.event_id,
        "message-1",
        expected_state="PENDING",
        idempotency_key="mark-runtime-clock",
    )

    writes = cast(list[dict[str, object]], client.transaction_calls[0]["TransactItems"])
    update = cast(Mapping[str, object], writes[0]["Update"])
    values = cast(Mapping[str, Mapping[str, str]], update["ExpressionAttributeValues"])
    assert values[":published_at"] == {"S": "2026-09-09T12:00:00.123Z"}


def test_mark_published_translates_a_lost_cas_to_conditional_error() -> None:
    event = _event()
    client = RecordingClient()
    locator = DynamoOutboxRepository.locator_item(event)
    client.items[(cast(str, locator["pk"]), cast(str, locator["sk"]))] = locator

    def cancel(**kwargs: object) -> Mapping[str, object]:
        client.transaction_calls.append(dict(kwargs))
        raise ClientError(
            {
                "Error": {"Code": "TransactionCanceledException", "Message": "secret"},
                "CancellationReasons": [
                    {"Code": "ConditionalCheckFailed"},
                    {"Code": "None"},
                ],
            },
            "TransactWriteItems",
        )

    client.transact_write_items = cancel
    repository = DynamoOutboxRepository(client, "hot", clock=lambda: NOW)

    with pytest.raises(ConditionalWriteError):
        repository.mark_published(
            event.event_id,
            "message-1",
            expected_state="PENDING",
            idempotency_key="mark-race",
        )
