"""Verify hot-record persistence against a DynamoDB integration boundary."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime
from typing import Any, cast

import boto3  # type: ignore[import-untyped]
import pytest
from moto import mock_aws

from adapters.dynamodb.archive_partitions import _catalog_snapshot
from adapters.dynamodb.codec import (
    encode_hot_partition_catalog,
    encode_hot_record,
    serialize_item,
)
from adapters.dynamodb.hot_records import DynamoHotRecordSink
from domain.models import CanonicalRecord, RecordType
from ports import ConditionalWriteError, WriteResult


def record(*, observed_at: datetime | None) -> CanonicalRecord:
    return CanonicalRecord(
        "1.0",
        RecordType.SIGNAL_OBSERVATION,
        "argus",
        "signal_bucket",
        (("signal", "a"),),
        observed_at,
        None,
        {},
        {"value": 1},
        {},
        (),
    )


@pytest.mark.aws
@pytest.mark.parametrize(
    ("partition", "observed_at"),
    [
        ("year=2026/month=09/day=01", datetime(2026, 9, 1, tzinfo=UTC)),
        ("snapshot_date=2026-09-02", None),
    ],
)
@pytest.mark.parametrize(
    "catalog_state",
    ["missing", "incorrect", "extra-ttl", "extra-arbitrary"],
)
@mock_aws
def test_new_process_repairs_missing_or_incorrect_hotpart_without_rewriting_fact(
    partition: str, observed_at: datetime | None, catalog_state: str
) -> None:
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
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    source = record(observed_at=observed_at)
    fact = encode_hot_record(source, "dsv_abc", partition)
    client.put_item(TableName="hot", Item=serialize_item(fact))
    if catalog_state != "missing":
        catalog = encode_hot_partition_catalog(
            "dsv_abc", "signal_bucket", partition, str(fact["pk"])
        )
        mutations: dict[str, dict[str, object]] = {
            "incorrect": {"partition": "snapshot_date=2000-01-01"},
            "extra-ttl": {"ttl": 1_800_000_000},
            "extra-arbitrary": {"unexpectedAttribute": "must-be-removed"},
        }
        mutation = mutations[catalog_state]
        client.put_item(
            TableName="hot",
            Item=serialize_item({**catalog, **mutation}),
        )

    sink = DynamoHotRecordSink(client, "hot", sleep=lambda _seconds: None, jitter=lambda: 0)
    result = sink.write((source,), "dsv_abc", partition, idempotency_key="repair-after-crash")

    assert result == WriteResult(written=0, unchanged=1)
    queried = client.query(
        TableName="hot",
        KeyConditionExpression="pk = :pk",
        ExpressionAttributeValues={
            ":pk": {
                "S": "DATASET#dsv_abc#INGESTION#HOTPART#signal_bucket#"
                + ("20260902" if observed_at is None else "20260901")
            }
        },
    )
    assert queried["Count"] == 2
    summary = next(item for item in queried["Items"] if item["entityType"]["S"] == "HOT_PARTITION")
    assert summary["hotPk"]["S"] == fact["pk"]
    assert summary["partition"]["S"] == partition
    assert summary["catalogFormat"]["S"] == "CHAIN_V1"
    assert "ttl" not in summary
    assert "unexpectedAttribute" not in summary


@pytest.mark.aws
@mock_aws
def test_writer_leaves_fact_unlisted_when_retention_catalog_is_already_sealed() -> None:
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
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    client.put_item(
        TableName="hot",
        Item=serialize_item(
            {
                "pk": "DATASET#dsv_abc#INGESTION#RETENTION#signal_bucket#20260901",
                "sk": "META",
                "entityType": "RETENTION_SET",
            }
        ),
    )
    source = record(observed_at=datetime(2026, 9, 1, tzinfo=UTC))
    fact = encode_hot_record(source, "dsv_abc", "year=2026/month=09/day=01")

    with pytest.raises(ConditionalWriteError, match="sealed"):
        DynamoHotRecordSink(client, "hot", sleep=lambda _seconds: None, jitter=lambda: 0).write(
            (source,),
            "dsv_abc",
            "year=2026/month=09/day=01",
            idempotency_key="after-seal",
        )

    assert "Item" not in client.get_item(
        TableName="hot",
        Key={"pk": {"S": str(fact["pk"])}, "sk": {"S": str(fact["sk"])}},
    )
    catalog = client.query(
        TableName="hot",
        KeyConditionExpression="pk = :pk",
        ExpressionAttributeValues={
            ":pk": {"S": "DATASET#dsv_abc#INGESTION#HOTPART#signal_bucket#20260901"}
        },
    )
    assert catalog["Count"] == 0


@pytest.mark.aws
@mock_aws
def test_incremental_hotpart_segments_are_reconciled_as_one_exact_target_set() -> None:
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
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    sink = DynamoHotRecordSink(client, "hot", sleep=lambda _seconds: None, jitter=lambda: 0)
    first = record(observed_at=datetime(2026, 9, 1, tzinfo=UTC))
    second = replace(first, natural_key=(("signal", "b"),))
    partition = "year=2026/month=09/day=01"

    sink.write((first,), "dsv_abc", partition, idempotency_key="first-page")
    sink.write((second,), "dsv_abc", partition, idempotency_key="second-page")

    facts, projections, digest = _catalog_snapshot(
        client, "hot", "dsv_abc", "signal_bucket", partition, 1
    )

    assert len(facts) == 2
    assert projections == ()
    assert len(digest) == 64


@pytest.mark.aws
@mock_aws
def test_interleaved_seal_and_concurrent_fact_preserve_the_observed_payload_hash() -> None:
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
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    desired = record(observed_at=datetime(2026, 9, 1, tzinfo=UTC))
    concurrent = replace(desired, measures={"value": 999})
    concurrent_item = encode_hot_record(concurrent, "dsv_abc", "year=2026/month=09/day=01")
    seal = {
        "pk": "DATASET#dsv_abc#INGESTION#RETENTION#signal_bucket#20260901",
        "sk": "META",
        "entityType": "RETENTION_SET",
    }

    class InterleavingClient:
        def __init__(self, delegate: Any) -> None:
            self.delegate = delegate
            self.interleaved = False

        def batch_get_item(self, **kwargs: object) -> dict[str, object]:
            return cast(dict[str, object], self.delegate.batch_get_item(**kwargs))

        def query(self, **kwargs: object) -> dict[str, object]:
            return cast(dict[str, object], self.delegate.query(**kwargs))

        def transact_write_items(self, **kwargs: object) -> dict[str, object]:
            actions = cast(list[dict[str, object]], kwargs["TransactItems"])
            if any(
                "Put" in action
                and cast(dict[str, Any], cast(dict[str, object], action["Put"])["Item"]).get(
                    "entityType"
                )
                == {"S": "HOT_RECORD"}
                for action in actions
            ):
                self._interleave()
            return cast(dict[str, object], self.delegate.transact_write_items(**kwargs))

        def _interleave(self) -> None:
            if self.interleaved:
                return
            self.interleaved = True
            self.delegate.put_item(TableName="hot", Item=serialize_item(concurrent_item))
            self.delegate.put_item(TableName="hot", Item=serialize_item(seal))

    with pytest.raises(ConditionalWriteError):
        DynamoHotRecordSink(
            InterleavingClient(client), "hot", sleep=lambda _seconds: None, jitter=lambda: 0
        ).write(
            (desired,),
            "dsv_abc",
            "year=2026/month=09/day=01",
            idempotency_key="interleaved",
        )

    stored = client.get_item(
        TableName="hot",
        Key={
            "pk": {"S": str(concurrent_item["pk"])},
            "sk": {"S": str(concurrent_item["sk"])},
        },
        ConsistentRead=True,
    )["Item"]
    assert stored["payloadHash"] == {"S": str(concurrent_item["payloadHash"])}
