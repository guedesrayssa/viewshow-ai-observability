"""Verify outbox persistence and retrieval through a DynamoDB boundary."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import boto3  # type: ignore[import-untyped]
import pytest
from moto import mock_aws

from adapters.dynamodb.outbox import DynamoOutboxRepository, pending_outbox
from domain.models import TimeWindow
from ports import ConditionalWriteError, IdempotencyConflict

NOW = datetime(2026, 9, 9, 12, tzinfo=UTC)


def _table() -> Any:
    client = boto3.client("dynamodb", region_name="us-east-1")
    client.create_table(
        TableName="hot",
        KeySchema=[
            {"AttributeName": "pk", "KeyType": "HASH"},
            {"AttributeName": "sk", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "pk", "AttributeType": "S"},
            {"AttributeName": "sk", "AttributeType": "S"},
            {"AttributeName": "outboxStatePk", "AttributeType": "S"},
            {"AttributeName": "outboxStateSk", "AttributeType": "S"},
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": "outbox-pending-index",
                "KeySchema": [
                    {"AttributeName": "outboxStatePk", "KeyType": "HASH"},
                    {"AttributeName": "outboxStateSk", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    return client


def _event(created_at: datetime):
    end = created_at.replace(second=0, microsecond=0)
    return DynamoOutboxRepository.build_event(
        "dsv_a",
        "ANOMALY_DETECTION",
        TimeWindow(end - timedelta(minutes=15), end, 900),
        created_at=created_at,
    )


@pytest.mark.aws
@mock_aws
def test_commit_query_mark_and_idempotency_survive_repository_restart() -> None:
    client = _table()
    earlier = _event(NOW + timedelta(seconds=1))
    later = _event(NOW + timedelta(minutes=15, seconds=2))
    repository = DynamoOutboxRepository(client, "hot", clock=lambda: NOW)

    repository.commit_watermark_and_outboxes(
        "dsv_a",
        "argus",
        NOW,
        (earlier,),
        expected_watermark=None,
        idempotency_key="window-1",
    )
    repository.commit_watermark_and_outboxes(
        "dsv_a",
        "argus",
        NOW + timedelta(minutes=15),
        (later,),
        expected_watermark=NOW,
        idempotency_key="window-2",
    )

    restarted = DynamoOutboxRepository(client, "hot", clock=lambda: NOW)
    restarted.commit_watermark_and_outboxes(
        "dsv_a",
        "argus",
        NOW + timedelta(minutes=15),
        (later,),
        expected_watermark=NOW,
        idempotency_key="window-2",
    )
    assert restarted.list_pending(1) == (earlier,)
    assert restarted.list_pending(10) == (earlier, later)

    restarted.mark_published(
        earlier.event_id,
        "message-1",
        expected_state="PENDING",
        idempotency_key="mark-1",
    )
    restarted_again = DynamoOutboxRepository(client, "hot", clock=lambda: NOW)
    restarted_again.mark_published(
        earlier.event_id,
        "message-1",
        expected_state="PENDING",
        idempotency_key="mark-1",
    )
    assert restarted_again.list_pending(10) == (later,)

    with pytest.raises(IdempotencyConflict):
        restarted_again.mark_published(
            earlier.event_id,
            "different-message",
            expected_state="PENDING",
            idempotency_key="mark-1",
        )
    with pytest.raises(ConditionalWriteError):
        restarted_again.mark_published(
            earlier.event_id,
            "message-2",
            expected_state="PENDING",
            idempotency_key="mark-2",
        )


@pytest.mark.aws
@mock_aws
def test_zero_event_commit_replays_and_conflicts_durably() -> None:
    client = _table()
    repository = DynamoOutboxRepository(client, "hot", clock=lambda: NOW)

    repository.commit_watermark_and_outboxes(
        "dsv_a",
        "argus",
        NOW,
        (),
        expected_watermark=None,
        idempotency_key="empty-window",
    )
    restarted = DynamoOutboxRepository(client, "hot", clock=lambda: NOW)
    restarted.commit_watermark_and_outboxes(
        "dsv_a",
        "argus",
        NOW,
        (),
        expected_watermark=None,
        idempotency_key="empty-window",
    )

    watermark = client.get_item(
        TableName="hot",
        Key={
            "pk": {"S": "DATASET#dsv_a#INGESTION#SOURCE#argus"},
            "sk": {"S": "WATERMARK"},
        },
        ConsistentRead=True,
    )["Item"]
    assert watermark["publishedWatermark"]["S"] == "2026-09-09T12:00:00.000Z"
    with pytest.raises(IdempotencyConflict):
        restarted.commit_watermark_and_outboxes(
            "dsv_a",
            "argus",
            NOW + timedelta(minutes=15),
            (),
            expected_watermark=NOW,
            idempotency_key="empty-window",
        )


@pytest.mark.aws
@mock_aws
def test_stale_watermark_rolls_back_outbox_and_locator_atomically() -> None:
    client = _table()
    repository = DynamoOutboxRepository(client, "hot", clock=lambda: NOW)
    repository.commit_watermark_and_outboxes(
        "dsv_a",
        "argus",
        NOW,
        (),
        expected_watermark=None,
        idempotency_key="initial-watermark",
    )
    rejected = _event(NOW + timedelta(minutes=15, seconds=1))

    with pytest.raises(ConditionalWriteError):
        repository.commit_watermark_and_outboxes(
            "dsv_a",
            "argus",
            NOW + timedelta(minutes=15),
            (rejected,),
            expected_watermark=NOW - timedelta(minutes=15),
            idempotency_key="stale-window",
        )

    watermark = client.get_item(
        TableName="hot",
        Key={
            "pk": {"S": "DATASET#dsv_a#INGESTION#SOURCE#argus"},
            "sk": {"S": "WATERMARK"},
        },
        ConsistentRead=True,
    )["Item"]
    assert watermark["publishedWatermark"]["S"] == "2026-09-09T12:00:00.000Z"
    event_item = pending_outbox(rejected)
    locator = DynamoOutboxRepository.locator_item(rejected)
    for item in (event_item, locator):
        response = client.get_item(
            TableName="hot",
            Key={"pk": {"S": item["pk"]}, "sk": {"S": item["sk"]}},
            ConsistentRead=True,
        )
        assert "Item" not in response
