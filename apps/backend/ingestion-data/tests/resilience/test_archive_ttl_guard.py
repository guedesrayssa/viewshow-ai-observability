"""Verify archive partition retention never deletes data before its TTL boundary."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from typing import Any, cast

import boto3  # type: ignore[import-untyped]
import pytest
from botocore.exceptions import ClientError  # type: ignore[import-untyped]
from moto import mock_aws

from adapters.dynamodb import archive_partitions
from adapters.dynamodb.archive_partitions import (
    DynamoArchivePartitionRepository,
    DynamoHotExpirationRepository,
    encode_projection_partition_catalog,
    encode_projection_target_set_catalog,
)
from adapters.dynamodb.client import DynamoControlProtocolError, DynamoDbThrottled
from adapters.dynamodb.codec import (
    encode_hot_partition_catalog,
    encode_hot_record,
    serialize_item,
)
from domain.archive import InvalidArchiveTransition, partition_date
from domain.canonical_json import canonical_bytes
from domain.models import CanonicalRecord, RecordType
from ports import ArchiveNotAvailable, ArchivePartition, ArchiveState, ConditionalWriteError

NOW = datetime(2026, 9, 8, 12, 0, tzinfo=UTC)
PARTITION = "year=2026/month=09/day=01"
TTL = 1_800_000_000


def create_table(client: Any) -> None:
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


def metadata(
    *,
    fact_count: int = 1,
    projection_count: int = 1,
    version: str = "dsv_a",
    dataset: str = "signal_bucket",
    partition: str = PARTITION,
) -> dict[str, object]:
    day = partition_date(partition)
    start = datetime(day.year, day.month, day.day, tzinfo=UTC)
    return {
        "interval": {
            "start": start.isoformat().replace("+00:00", "Z"),
            "end": (start + timedelta(days=1)).isoformat().replace("+00:00", "Z"),
        },
        "counts": {"accepted": 1, "rejected": 0, "persisted": 1},
        "s3Uri": (
            "s3://argus-canonical/canonical/schema_version=1.0/"
            f"dataset_version={version}/"
            f"dataset={dataset}/{partition}/part-00000.parquet"
        ),
        "sha256": "a" * 64,
        "reconciliation": {"state": "PENDING"},
        "expirationEligible": False,
        "hotItemCount": fact_count,
        "projectionItemCount": projection_count,
        "catalogGeneration": 1,
        "catalogDigest": None,
    }


def partition(state: ArchiveState, *, facts: int = 1, projections: int = 1) -> ArchivePartition:
    return ArchivePartition(
        "dsv_a",
        "signal_bucket",
        PARTITION,
        state,
        metadata(fact_count=facts, projection_count=projections),
    )


def record(signal: str = "a") -> CanonicalRecord:
    return CanonicalRecord(
        "1.0",
        RecordType.SIGNAL_OBSERVATION,
        "argus",
        "signal_bucket",
        (("signal", signal),),
        datetime(2026, 9, 1, tzinfo=UTC),
        None,
        {},
        {"value": 1},
        {},
        (),
    )


def seed_hot_targets(client: Any) -> tuple[dict[str, object], dict[str, object]]:
    fact = encode_hot_record(record(), "dsv_a", PARTITION)
    fact_catalog = encode_hot_partition_catalog(
        "dsv_a",
        "signal_bucket",
        PARTITION,
        str(fact["pk"]),
        target_count=1,
        target_digest=hashlib.sha256(
            canonical_bytes([(str(fact["pk"]), str(fact["sk"]))])
        ).hexdigest(),
    )
    projection: dict[str, object] = {
        "pk": "DATASET#dsv_a#VIEW#overview#20260901",
        "sk": "PROJECTION#day",
        "entityType": "PROJECTION",
        "datasetVersion": "dsv_a",
        "partition": PARTITION,
        "payload": {"views": 1},
    }
    projection_catalog = encode_projection_partition_catalog(
        "dsv_a",
        "signal_bucket",
        PARTITION,
        str(projection["pk"]),
        str(projection["sk"]),
        required_archives=(("signal_bucket", PARTITION),),
        catalog_generation=1,
    )
    for item in (fact, fact_catalog, projection, projection_catalog):
        client.put_item(TableName="hot", Item=serialize_item(item))
    return fact, projection


def seed_fact_targets(client: Any, count: int) -> tuple[dict[str, object], ...]:
    facts = tuple(
        encode_hot_record(record(str(index)), "dsv_a", PARTITION) for index in range(count)
    )
    catalog = encode_hot_partition_catalog(
        "dsv_a",
        "signal_bucket",
        PARTITION,
        str(facts[0]["pk"]),
        target_count=count,
        target_digest=hashlib.sha256(
            canonical_bytes(sorted((str(item["pk"]), str(item["sk"])) for item in facts))
        ).hexdigest(),
    )
    for item in (*facts, catalog):
        client.put_item(TableName="hot", Item=serialize_item(item))
    return facts


def make_available(
    repository: DynamoArchivePartitionRepository,
    *,
    facts: int = 1,
    projections: int = 1,
    key_prefix: str = "archive",
) -> ArchivePartition:
    current = partition(ArchiveState.STAGING, facts=facts, projections=projections)
    repository.put(current, expected_absent=True, idempotency_key=f"{key_prefix}-put")
    for target in (
        ArchiveState.UPLOADED,
        ArchiveState.CATALOGED,
        ArchiveState.VALIDATED,
    ):
        previous = current.state
        current = repository.update_state(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            target,
            expected_state=previous,
            idempotency_key=f"{key_prefix}-{target.value.lower()}",
        )
    current = repository.record_reconciliation(
        "dsv_a",
        "signal_bucket",
        PARTITION,
        observed_counts={"accepted": 1, "rejected": 0, "persisted": 1},
        reconciled_at=NOW,
        expected_state=ArchiveState.VALIDATED,
        idempotency_key=f"{key_prefix}-reconciled",
    )
    current = repository.update_state(
        "dsv_a",
        "signal_bucket",
        PARTITION,
        ArchiveState.AVAILABLE,
        expected_state=ArchiveState.VALIDATED,
        idempotency_key=f"{key_prefix}-available",
    )
    return current


@mock_aws
def test_archive_catalog_uses_explicit_state_machine_and_query_isolation() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    repository = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    repository.put(partition(ArchiveState.STAGING), expected_absent=True, idempotency_key="put-a")
    other = ArchivePartition(
        "dsv_b", "signal_bucket", PARTITION, ArchiveState.STAGING, metadata(version="dsv_b")
    )
    repository.put(other, expected_absent=True, idempotency_key="put-b")

    with pytest.raises(InvalidArchiveTransition):
        repository.update_state(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            ArchiveState.AVAILABLE,
            expected_state=ArchiveState.STAGING,
            idempotency_key="illegal-jump",
        )
    uploaded = repository.update_state(
        "dsv_a",
        "signal_bucket",
        PARTITION,
        ArchiveState.UPLOADED,
        expected_state=ArchiveState.STAGING,
        idempotency_key="uploaded",
    )
    assert repository.query("dsv_a", "signal_bucket") == (uploaded,)
    assert repository.query("dsv_b", "signal_bucket") == (other,)


def test_archive_exact_get_is_consistent_and_never_queries_the_catalog() -> None:
    expected = partition(ArchiveState.STAGING)
    encoded = serialize_item(
        {
            "pk": "DATASET#dsv_a#INGESTION#ARCHIVE#signal_bucket#2026-09-01",
            "sk": "META",
            "entityType": "ARCHIVE_PARTITION",
            "datasetVersion": "dsv_a",
            "dataset": "signal_bucket",
            "partition": PARTITION,
            "partitionDate": "2026-09-01",
            "state": "STAGING",
            "metadata": expected.metadata,
            "metadataFingerprint": hashlib.sha256(canonical_bytes(expected.metadata)).hexdigest(),
        }
    )

    class Client:
        def __init__(self) -> None:
            self.calls: list[dict[str, object]] = []

        def get_item(self, **kwargs: object) -> dict[str, object]:
            self.calls.append(dict(kwargs))
            return {
                "Item": encoded,
                "ResponseMetadata": {"HTTPStatusCode": 200},
            }

        def query(self, **_kwargs: object) -> dict[str, object]:
            raise AssertionError("exact archive read must not query the catalog")

        def transact_write_items(self, **_kwargs: object) -> dict[str, object]:
            raise AssertionError("exact archive read must not write")

    client = Client()
    actual = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW).get(
        "dsv_a", "signal_bucket", PARTITION
    )

    assert actual == expected
    assert client.calls == [
        {
            "TableName": "hot",
            "Key": {
                "pk": {"S": "DATASET#dsv_a#INGESTION#ARCHIVE#signal_bucket#2026-09-01"},
                "sk": {"S": "META"},
            },
            "ConsistentRead": True,
        }
    ]


@mock_aws
def test_ttl_is_forbidden_until_persisted_archive_is_available() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    archives = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    expirations = DynamoHotExpirationRepository(client, "hot", clock=lambda: NOW)
    current = partition(ArchiveState.STAGING)
    archives.put(current, expected_absent=True, idempotency_key="put")
    for state in (ArchiveState.UPLOADED, ArchiveState.CATALOGED):
        current = archives.update_state(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            state,
            expected_state=current.state,
            idempotency_key=state.value,
        )

    with pytest.raises(ArchiveNotAvailable):
        expirations.authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="ttl-before-available",
        )


@mock_aws
def test_available_gate_sets_exact_ttl_on_cataloged_facts_and_projections() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    fact, projection = seed_hot_targets(client)
    archives = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    make_available(archives)
    expirations = DynamoHotExpirationRepository(client, "hot", clock=lambda: NOW)

    assert (
        expirations.authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="ttl-available",
        )
        == 2
    )

    for item in (fact, projection):
        stored = client.get_item(
            TableName="hot",
            Key={"pk": {"S": str(item["pk"])}, "sk": {"S": str(item["sk"])}},
            ConsistentRead=True,
        )["Item"]
        assert stored["ttl"] == {"N": str(TTL)}

    restarted = DynamoHotExpirationRepository(client, "hot", clock=lambda: NOW)
    assert (
        restarted.authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="ttl-available",
        )
        == 2
    )


@mock_aws
def test_target_set_catalog_applies_ttl_to_operational_and_revision_items() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    projection_pk = "DATASET#dsv_a#VIEW#overview#20260901"
    operational_sk = "PROJECTION#day"
    revision = "pmr_" + "a" * 64
    dependencies = (("signal_bucket", PARTITION),)
    common: dict[str, object] = {
        "pk": projection_pk,
        "datasetVersion": "dsv_a",
        "partition": PARTITION,
        "materializationRevision": revision,
        "requiredArchives": [{"dataset": "signal_bucket", "partition": PARTITION}],
    }
    operational = {**common, "sk": operational_sk, "entityType": "PROJECTION"}
    revision_item = {
        **common,
        "sk": f"REVISION#{revision}",
        "entityType": "PROJECTION_REVISION",
    }
    catalog = encode_projection_target_set_catalog(
        "dsv_a",
        "signal_bucket",
        PARTITION,
        projection_pk,
        operational_sk,
        targets=(
            {
                "kind": "OPERATIONAL",
                "sk": operational_sk,
                "materializationRevision": revision,
                "requiredArchives": dependencies,
            },
            {
                "kind": "REVISION",
                "sk": f"REVISION#{revision}",
                "materializationRevision": revision,
                "requiredArchives": dependencies,
            },
        ),
        catalog_generation=1,
    )
    for item in (operational, revision_item, catalog):
        client.put_item(TableName="hot", Item=serialize_item(item))

    archives = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    make_available(archives, facts=0, projections=2, key_prefix="target-set")
    expirations = DynamoHotExpirationRepository(client, "hot", clock=lambda: NOW)
    assert (
        expirations.authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="target-set-ttl",
        )
        == 2
    )
    for item in (operational, revision_item):
        stored = client.get_item(
            TableName="hot",
            Key={"pk": {"S": projection_pk}, "sk": {"S": str(item["sk"])}},
            ConsistentRead=True,
        )["Item"]
        assert stored["ttl"] == {"N": str(TTL)}


@mock_aws
def test_partial_ttl_work_is_repaired_before_completion_marker() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    fact, projection = seed_hot_targets(client)
    fact["ttl"] = TTL
    client.put_item(TableName="hot", Item=serialize_item(fact))
    archives = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    make_available(archives)

    expirations = DynamoHotExpirationRepository(client, "hot", clock=lambda: NOW)
    assert (
        expirations.authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="resume-partial",
        )
        == 2
    )
    stored_projection = client.get_item(
        TableName="hot",
        Key={"pk": {"S": str(projection["pk"])}, "sk": {"S": str(projection["sk"])}},
        ConsistentRead=True,
    )["Item"]
    assert stored_projection["ttl"] == {"N": str(TTL)}


@mock_aws
def test_catalog_count_mismatch_fails_closed_without_writing_ttl() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    fact, _projection = seed_hot_targets(client)
    archives = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    available = partition(ArchiveState.STAGING, facts=2)
    archives.put(available, expected_absent=True, idempotency_key="put")
    current = available
    for state in (
        ArchiveState.UPLOADED,
        ArchiveState.CATALOGED,
        ArchiveState.VALIDATED,
    ):
        current = archives.update_state(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            state,
            expected_state=current.state,
            idempotency_key=state.value,
        )
    with pytest.raises(ConditionalWriteError, match="catalog"):
        archives.record_reconciliation(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            observed_counts={"accepted": 1, "rejected": 0, "persisted": 1},
            reconciled_at=NOW,
            expected_state=ArchiveState.VALIDATED,
            idempotency_key="reconcile-count-mismatch",
        )
    stored = client.get_item(
        TableName="hot",
        Key={"pk": {"S": str(fact["pk"])}, "sk": {"S": str(fact["sk"])}},
    )["Item"]
    assert "ttl" not in stored


def test_archive_query_paginates_consistently_without_scan() -> None:
    first_partition = partition(ArchiveState.STAGING)
    second_partition = ArchivePartition(
        "dsv_a",
        "signal_bucket",
        "year=2026/month=09/day=02",
        ArchiveState.STAGING,
        metadata(partition="year=2026/month=09/day=02"),
    )

    def item(value: ArchivePartition) -> dict[str, object]:
        day = value.partition[-2:]
        return {
            "pk": "DATASET#dsv_a#INGESTION#ARCHIVE#signal_bucket",
            "sk": f"PARTITION#2026-09-{day}",
            "entityType": "ARCHIVE_PARTITION_CATALOG",
            "datasetVersion": value.dataset_version,
            "dataset": value.dataset,
            "partition": value.partition,
            "partitionDate": f"2026-09-{day}",
            "state": value.state.value,
            "metadata": value.metadata,
            "metadataFingerprint": hashlib.sha256(canonical_bytes(value.metadata)).hexdigest(),
        }

    first = serialize_item(item(first_partition))
    second = serialize_item(item(second_partition))
    last = {"pk": first["pk"], "sk": first["sk"]}

    class Client:
        def __init__(self) -> None:
            self.calls: list[dict[str, object]] = []

        def query(self, **kwargs: object) -> dict[str, object]:
            self.calls.append(dict(kwargs))
            if len(self.calls) == 1:
                return {
                    "Items": [first],
                    "Count": 1,
                    "ScannedCount": 1,
                    "LastEvaluatedKey": last,
                    "ResponseMetadata": {"HTTPStatusCode": 200},
                }
            assert kwargs["ExclusiveStartKey"] == last
            return {
                "Items": [second],
                "Count": 1,
                "ScannedCount": 1,
                "ResponseMetadata": {"HTTPStatusCode": 200},
            }

        def get_item(self, **_kwargs: object) -> dict[str, object]:
            raise AssertionError("query must not use GetItem")

        def transact_write_items(self, **_kwargs: object) -> dict[str, object]:
            raise AssertionError("query must not write")

    client = Client()
    result = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW).query(
        "dsv_a", "signal_bucket"
    )

    assert result == (first_partition, second_partition)
    assert len(client.calls) == 2
    assert all(call["ConsistentRead"] is True for call in client.calls)
    assert all("Scan" not in repr(call) for call in client.calls)


def test_archive_query_rejects_malformed_pagination_shape() -> None:
    class Client:
        def query(self, **_kwargs: object) -> dict[str, object]:
            return {
                "Items": [],
                "Count": 0,
                "ScannedCount": 0,
                "LastEvaluatedKey": {"pk": {"S": "missing-sort-key"}},
                "ResponseMetadata": {"HTTPStatusCode": 200},
            }

        def get_item(self, **_kwargs: object) -> dict[str, object]:
            raise AssertionError

        def transact_write_items(self, **_kwargs: object) -> dict[str, object]:
            raise AssertionError

    with pytest.raises(RuntimeError, match="LastEvaluatedKey"):
        DynamoArchivePartitionRepository(Client(), "hot", clock=lambda: NOW).query(
            "dsv_a", "signal_bucket"
        )


def test_archive_query_translates_exhausted_dynamodb_throttling() -> None:
    class Client:
        def query(self, **_kwargs: object) -> dict[str, object]:
            raise ClientError(
                {"Error": {"Code": "ThrottlingException", "Message": "secret"}},
                "Query",
            )

        def get_item(self, **_kwargs: object) -> dict[str, object]:
            raise AssertionError

        def transact_write_items(self, **_kwargs: object) -> dict[str, object]:
            raise AssertionError

    with pytest.raises(DynamoDbThrottled):
        DynamoArchivePartitionRepository(Client(), "hot", clock=lambda: NOW).query(
            "dsv_a", "signal_bucket"
        )


@mock_aws
def test_expiration_resumes_after_a_transient_failure_between_transaction_chunks() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    records = tuple(record(str(index)) for index in range(100))
    encoded = tuple(encode_hot_record(value, "dsv_a", PARTITION) for value in records)
    catalog = encode_hot_partition_catalog(
        "dsv_a",
        "signal_bucket",
        PARTITION,
        str(encoded[0]["pk"]),
        target_count=100,
        target_digest=hashlib.sha256(
            canonical_bytes(sorted((str(item["pk"]), str(item["sk"])) for item in encoded))
        ).hexdigest(),
    )
    for item_value in (*encoded, catalog):
        client.put_item(TableName="hot", Item=serialize_item(item_value))
    archives = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    current = partition(ArchiveState.STAGING, facts=100, projections=0)
    archives.put(current, expected_absent=True, idempotency_key="put-many")
    for state in (
        ArchiveState.UPLOADED,
        ArchiveState.CATALOGED,
        ArchiveState.VALIDATED,
    ):
        current = archives.update_state(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            state,
            expected_state=current.state,
            idempotency_key=f"many-{state.value}",
        )
    current = archives.record_reconciliation(
        "dsv_a",
        "signal_bucket",
        PARTITION,
        observed_counts={"accepted": 1, "rejected": 0, "persisted": 1},
        reconciled_at=NOW,
        expected_state=ArchiveState.VALIDATED,
        idempotency_key="many-reconciled",
    )
    archives.update_state(
        "dsv_a",
        "signal_bucket",
        PARTITION,
        ArchiveState.AVAILABLE,
        expected_state=current.state,
        idempotency_key="many-available",
    )

    class FailSecondProgressTransaction:
        def __init__(self, delegate: Any) -> None:
            self.delegate = delegate
            self.progress_calls = 0

        def get_item(self, **kwargs: object) -> dict[str, object]:
            return cast(dict[str, object], self.delegate.get_item(**kwargs))

        def query(self, **kwargs: object) -> dict[str, object]:
            return cast(dict[str, object], self.delegate.query(**kwargs))

        def transact_write_items(self, **kwargs: object) -> dict[str, object]:
            actions = cast(list[dict[str, object]], kwargs["TransactItems"])
            if any(
                "Put" in action
                and cast(dict[str, Any], action["Put"])["Item"].get("entityType")
                == {"S": "TTL_PROGRESS"}
                for action in actions
            ):
                self.progress_calls += 1
            if self.progress_calls == 2:
                raise ClientError(
                    {"Error": {"Code": "ProvisionedThroughputExceededException"}},
                    "TransactWriteItems",
                )
            return cast(dict[str, object], self.delegate.transact_write_items(**kwargs))

    failing = FailSecondProgressTransaction(client)
    with pytest.raises(DynamoDbThrottled):
        DynamoHotExpirationRepository(failing, "hot", clock=lambda: NOW).authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="ttl-many",
        )

    ttl_count_after_failure = sum(
        "ttl"
        in client.get_item(
            TableName="hot",
            Key={"pk": {"S": str(item_value["pk"])}, "sk": {"S": str(item_value["sk"])}},
        )["Item"]
        for item_value in encoded
    )
    assert ttl_count_after_failure == 96
    progress_pk = (
        "INGESTION#IDEMPOTENCY#hot-expiration#"
        + hashlib.sha256(b"hot-expiration\0ttl-many").hexdigest()
    )
    progress = client.query(
        TableName="hot",
        KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues={
            ":pk": {"S": progress_pk},
            ":prefix": {"S": "PROGRESS#"},
        },
        ConsistentRead=True,
    )
    assert progress["Count"] == 1

    assert (
        DynamoHotExpirationRepository(client, "hot", clock=lambda: NOW).authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="ttl-many",
        )
        == 100
    )


@mock_aws
def test_hotpart_rejects_pointer_to_wrong_day_before_sealing_catalog() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    wrong_partition = "year=2026/month=09/day=02"
    wrong_fact = encode_hot_record(record(), "dsv_a", wrong_partition)
    correct_pk = "DATASET#dsv_a#FACT#TS#signal_bucket#20260901"
    poisoned_catalog = encode_hot_partition_catalog(
        "dsv_a",
        "signal_bucket",
        PARTITION,
        correct_pk,
        target_count=1,
        target_digest=hashlib.sha256(
            canonical_bytes([(str(wrong_fact["pk"]), str(wrong_fact["sk"]))])
        ).hexdigest(),
    )
    poisoned_catalog["hotPk"] = str(wrong_fact["pk"])
    poisoned_catalog["sk"] = "PK#" + hashlib.sha256(str(wrong_fact["pk"]).encode()).hexdigest()
    for item_value in (wrong_fact, poisoned_catalog):
        client.put_item(TableName="hot", Item=serialize_item(item_value))
    archives = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    current = partition(ArchiveState.STAGING, projections=0)
    archives.put(current, expected_absent=True, idempotency_key="put-wrong-day")
    for state in (ArchiveState.UPLOADED, ArchiveState.CATALOGED, ArchiveState.VALIDATED):
        current = archives.update_state(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            state,
            expected_state=current.state,
            idempotency_key=f"wrong-day-{state.value}",
        )

    with pytest.raises(RuntimeError, match="HOTPART"):
        archives.record_reconciliation(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            observed_counts={"accepted": 1, "rejected": 0, "persisted": 1},
            reconciled_at=NOW,
            expected_state=ArchiveState.VALIDATED,
            idempotency_key="wrong-day-reconcile",
        )


def test_projection_catalog_rejects_unrelated_physical_keys() -> None:
    with pytest.raises(ValueError, match="projection"):
        encode_projection_partition_catalog(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            "DATASET#dsv_a#MISC",
            "NOT_A_PROJECTION",
            required_archives=(("signal_bucket", PARTITION),),
            catalog_generation=1,
        )


def test_projection_catalog_accepts_official_task13_multi_segment_view_key() -> None:
    catalog = encode_projection_partition_catalog(
        "dsv_a",
        "signal_bucket",
        PARTITION,
        "DATASET#dsv_a#VIEW#OVERVIEW#GLOBAL#20260901",
        "PROJECTION#day",
        required_archives=(("signal_bucket", PARTITION),),
        catalog_generation=1,
    )

    assert catalog["entityType"] == "HOT_PROJECTION_PARTITION"
    assert catalog["projectionPk"] == "DATASET#dsv_a#VIEW#OVERVIEW#GLOBAL#20260901"


def test_projection_target_set_catalog_is_closed_canonical_and_covers_revision() -> None:
    encoder = archive_partitions.encode_projection_target_set_catalog
    projection_pk = "DATASET#dsv_a#VIEW#OVERVIEW#GLOBAL#20260901"
    revision = "pmr_" + "a" * 64
    dependencies = (("signal_bucket", PARTITION),)

    catalog = encoder(
        "dsv_a",
        "signal_bucket",
        PARTITION,
        projection_pk,
        "T#1788220800000",
        targets=(
            {
                "kind": "OPERATIONAL",
                "sk": "T#1788220800000",
                "materializationRevision": revision,
                "requiredArchives": dependencies,
            },
            {
                "kind": "REVISION",
                "sk": f"REVISION#{revision}",
                "materializationRevision": revision,
                "requiredArchives": dependencies,
            },
        ),
        catalog_generation=1,
    )

    assert catalog["entityType"] == "HOT_PROJECTION_TARGET_SET"
    assert catalog["targets"] == [
        {
            "kind": "OPERATIONAL",
            "sk": "T#1788220800000",
            "materializationRevision": revision,
            "requiredArchives": [{"dataset": "signal_bucket", "partition": PARTITION}],
        },
        {
            "kind": "REVISION",
            "sk": f"REVISION#{revision}",
            "materializationRevision": revision,
            "requiredArchives": [{"dataset": "signal_bucket", "partition": PARTITION}],
        },
    ]
    assert str(catalog["catalogRevision"]).startswith("pcr_")


def test_projection_catalog_rejects_aliases_of_the_same_physical_archive() -> None:
    with pytest.raises(
        ValueError, match="required_archives must be physically unique and canonically ordered"
    ):
        encode_projection_partition_catalog(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            "DATASET#dsv_a#VIEW#overview#20260901",
            "PROJECTION#day",
            required_archives=(
                ("signal_bucket", "snapshot_date=2026-09-01"),
                ("signal_bucket", PARTITION),
            ),
            catalog_generation=1,
        )


def test_projection_catalog_serializes_mixed_layouts_deterministically() -> None:
    required = (
        ("incidents", "snapshot_date=2026-09-01"),
        ("signal_bucket", PARTITION),
    )

    first = encode_projection_partition_catalog(
        "dsv_a",
        "signal_bucket",
        "snapshot_date=2026-09-01",
        "DATASET#dsv_a#VIEW#overview#20260901",
        "PROJECTION#day",
        required_archives=required,
        catalog_generation=1,
    )
    second = encode_projection_partition_catalog(
        "dsv_a",
        "signal_bucket",
        "snapshot_date=2026-09-01",
        "DATASET#dsv_a#VIEW#overview#20260901",
        "PROJECTION#day",
        required_archives=required,
        catalog_generation=1,
    )

    assert first == second
    assert first["requiredArchives"] == [
        {"dataset": "incidents", "partition": "snapshot_date=2026-09-01"},
        {"dataset": "signal_bucket", "partition": PARTITION},
    ]


@mock_aws
def test_persisted_physical_aliases_are_rejected_before_transact_write() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    projection_pk = "DATASET#dsv_a#VIEW#overview#20260901"
    projection_sk = "PROJECTION#day"
    projection: dict[str, object] = {
        "pk": projection_pk,
        "sk": projection_sk,
        "entityType": "PROJECTION",
        "datasetVersion": "dsv_a",
        "partition": PARTITION,
    }
    catalog = encode_projection_partition_catalog(
        "dsv_a",
        "signal_bucket",
        PARTITION,
        projection_pk,
        projection_sk,
        required_archives=(("signal_bucket", PARTITION),),
        catalog_generation=1,
    )
    aliases = [
        {"dataset": "signal_bucket", "partition": "snapshot_date=2026-09-01"},
        {"dataset": "signal_bucket", "partition": PARTITION},
    ]
    catalog["requiredArchives"] = aliases
    catalog["sk"] = (
        "TARGET#"
        + hashlib.sha256(canonical_bytes([projection_pk, projection_sk, aliases])).hexdigest()
    )
    for item in (projection, catalog):
        client.put_item(TableName="hot", Item=serialize_item(item))

    archives = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    current = partition(ArchiveState.STAGING, facts=0, projections=1)
    archives.put(current, expected_absent=True, idempotency_key="alias-put")
    for state in (ArchiveState.UPLOADED, ArchiveState.CATALOGED, ArchiveState.VALIDATED):
        current = archives.update_state(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            state,
            expected_state=current.state,
            idempotency_key=f"alias-{state.value}",
        )

    transact_calls: list[dict[str, object]] = []
    client.meta.events.register(
        "before-call.dynamodb.TransactWriteItems",
        lambda **kwargs: transact_calls.append(kwargs),
    )
    with pytest.raises(DynamoControlProtocolError, match="projection catalog"):
        archives.record_reconciliation(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            observed_counts={"accepted": 1, "rejected": 0, "persisted": 1},
            reconciled_at=NOW,
            expected_state=ArchiveState.VALIDATED,
            idempotency_key="alias-reconcile",
        )

    assert transact_calls == []


@mock_aws
def test_persisted_projection_catalog_rejects_wrong_entity_target_before_sealing() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    projection_pk = "DATASET#dsv_a#VIEW#overview#20260901"
    projection_sk = "PROJECTION#day"
    catalog = encode_projection_partition_catalog(
        "dsv_a",
        "signal_bucket",
        PARTITION,
        projection_pk,
        projection_sk,
        required_archives=(("signal_bucket", PARTITION),),
        catalog_generation=1,
    )
    poisoned_target: dict[str, object] = {
        "pk": projection_pk,
        "sk": projection_sk,
        "entityType": "UNRELATED",
        "datasetVersion": "dsv_a",
        "partition": PARTITION,
    }
    for item in (catalog, poisoned_target):
        client.put_item(TableName="hot", Item=serialize_item(item))
    archives = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    current = partition(ArchiveState.STAGING, facts=0, projections=1)
    archives.put(current, expected_absent=True, idempotency_key="poisoned-projection-put")
    for state in (ArchiveState.UPLOADED, ArchiveState.CATALOGED, ArchiveState.VALIDATED):
        current = archives.update_state(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            state,
            expected_state=current.state,
            idempotency_key=f"poisoned-projection-{state.value}",
        )

    with pytest.raises(ConditionalWriteError, match="projection"):
        archives.record_reconciliation(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            observed_counts={"accepted": 1, "rejected": 0, "persisted": 1},
            reconciled_at=NOW,
            expected_state=ArchiveState.VALIDATED,
            idempotency_key="poisoned-projection-reconcile",
        )


@mock_aws
def test_multi_dataset_projection_waits_for_every_required_archive() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    projection: dict[str, object] = {
        "pk": "DATASET#dsv_a#VIEW#overview#20260901",
        "sk": "PROJECTION#day",
        "entityType": "PROJECTION",
        "datasetVersion": "dsv_a",
        "partition": PARTITION,
        "payload": {"views": 1},
    }
    required = (("incidents", PARTITION), ("signal_bucket", PARTITION))
    for dependency in ("signal_bucket", "incidents"):
        catalog = encode_projection_partition_catalog(
            "dsv_a",
            dependency,
            PARTITION,
            str(projection["pk"]),
            str(projection["sk"]),
            required_archives=required,
            catalog_generation=1,
        )
        client.put_item(TableName="hot", Item=serialize_item(catalog))
    client.put_item(TableName="hot", Item=serialize_item(projection))

    repositories: dict[str, DynamoArchivePartitionRepository] = {}
    for dataset in ("signal_bucket", "incidents"):
        repo = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
        repositories[dataset] = repo
        staged_metadata = metadata(fact_count=0, projection_count=1, dataset=dataset)
        current = ArchivePartition(
            "dsv_a", dataset, PARTITION, ArchiveState.STAGING, staged_metadata
        )
        repo.put(current, expected_absent=True, idempotency_key=f"put-{dataset}")
        for state in (ArchiveState.UPLOADED, ArchiveState.CATALOGED, ArchiveState.VALIDATED):
            current = repo.update_state(
                "dsv_a",
                dataset,
                PARTITION,
                state,
                expected_state=current.state,
                idempotency_key=f"{dataset}-{state.value}",
            )
        current = repo.record_reconciliation(
            "dsv_a",
            dataset,
            PARTITION,
            observed_counts={"accepted": 1, "rejected": 0, "persisted": 1},
            reconciled_at=NOW,
            expected_state=ArchiveState.VALIDATED,
            idempotency_key=f"reconcile-{dataset}",
        )
        if dataset == "signal_bucket":
            repo.update_state(
                "dsv_a",
                dataset,
                PARTITION,
                ArchiveState.AVAILABLE,
                expected_state=current.state,
                idempotency_key=f"available-{dataset}",
            )

    expiration = DynamoHotExpirationRepository(client, "hot", clock=lambda: NOW)
    with pytest.raises(ArchiveNotAvailable):
        expiration.authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="multi-dataset",
        )
    stored = client.get_item(
        TableName="hot",
        Key={"pk": {"S": str(projection["pk"])}, "sk": {"S": str(projection["sk"])}},
    )["Item"]
    assert "ttl" not in stored

    repositories["incidents"].update_state(
        "dsv_a",
        "incidents",
        PARTITION,
        ArchiveState.AVAILABLE,
        expected_state=ArchiveState.VALIDATED,
        idempotency_key="available-incidents",
    )
    assert (
        expiration.authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="multi-dataset",
        )
        == 1
    )


@mock_aws
def test_completed_expiration_revalidates_and_repairs_drift_on_replay() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    fact, _projection = seed_hot_targets(client)
    archives = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    make_available(archives)
    expiration = DynamoHotExpirationRepository(client, "hot", clock=lambda: NOW)
    assert (
        expiration.authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="repair-replay",
        )
        == 2
    )
    client.update_item(
        TableName="hot",
        Key={"pk": {"S": str(fact["pk"])}, "sk": {"S": str(fact["sk"])}},
        UpdateExpression="SET #ttl = :wrong",
        ExpressionAttributeNames={"#ttl": "ttl"},
        ExpressionAttributeValues={":wrong": {"N": "1"}},
    )

    restarted = DynamoHotExpirationRepository(client, "hot", clock=lambda: NOW)
    assert (
        restarted.authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="repair-replay",
        )
        == 2
    )
    repaired = client.get_item(
        TableName="hot",
        Key={"pk": {"S": str(fact["pk"])}, "sk": {"S": str(fact["sk"])}},
    )["Item"]
    assert repaired["ttl"] == {"N": str(TTL)}


@mock_aws
def test_archive_put_never_overwrites_an_existing_or_terminal_partition() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    repository = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    original = partition(ArchiveState.STAGING, projections=0)
    repository.put(original, expected_absent=True, idempotency_key="immutable-put")

    with pytest.raises(ConditionalWriteError, match="expected_absent"):
        repository.put(
            partition(ArchiveState.STAGING, facts=0, projections=0),
            expected_absent=False,
            idempotency_key="overwrite-put",
        )
    assert repository.query("dsv_a", "signal_bucket") == (original,)


@mock_aws
def test_archive_metadata_binds_interval_and_s3_object_to_partition_identity() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    repository = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    wrong_interval = metadata(fact_count=0, projection_count=0)
    wrong_interval["interval"] = {
        "start": "2030-01-01T00:00:00Z",
        "end": "2030-01-02T00:00:00Z",
    }
    with pytest.raises(ValueError, match="partition day"):
        repository.put(
            ArchivePartition(
                "dsv_a", "signal_bucket", PARTITION, ArchiveState.STAGING, wrong_interval
            ),
            expected_absent=True,
            idempotency_key="wrong-interval",
        )
    wrong_uri = metadata(fact_count=0, projection_count=0)
    wrong_uri["s3Uri"] = (
        "s3://bucket/canonical/schema_version=1.0/dataset_version=other/wrong.parquet"
    )
    with pytest.raises(ValueError, match="canonical"):
        repository.put(
            ArchivePartition("dsv_a", "signal_bucket", PARTITION, ArchiveState.STAGING, wrong_uri),
            expected_absent=True,
            idempotency_key="wrong-uri",
        )
    for invalid_uri in (
        "s3://bucket/canonical/schema_version=2.0/dataset_version=dsv_a/"
        "dataset=signal_bucket/year=2026/month=09/day=01/part-0.parquet",
        "s3://bucket/canonical/schema_version=1.0/dataset_version=dsv_a/"
        "dataset=signal_bucket/year=2026/month=09/day=01/arbitrary.parquet",
    ):
        invalid = metadata(fact_count=0, projection_count=0)
        invalid["s3Uri"] = invalid_uri
        with pytest.raises(ValueError, match="canonical"):
            repository.put(
                ArchivePartition(
                    "dsv_a", "signal_bucket", PARTITION, ArchiveState.STAGING, invalid
                ),
                expected_absent=True,
                idempotency_key="invalid-exact-layout-"
                + hashlib.sha256(invalid_uri.encode()).hexdigest(),
            )


@mock_aws
def test_available_requires_reconciliation_evidence_registered_after_validation() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    repository = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    current = partition(ArchiveState.STAGING, facts=0, projections=0)
    repository.put(current, expected_absent=True, idempotency_key="evidence-put")
    for state in (ArchiveState.UPLOADED, ArchiveState.CATALOGED, ArchiveState.VALIDATED):
        current = repository.update_state(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            state,
            expected_state=current.state,
            idempotency_key=f"evidence-{state.value}",
        )

    with pytest.raises(ValueError, match="AVAILABLE"):
        repository.update_state(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            ArchiveState.AVAILABLE,
            expected_state=ArchiveState.VALIDATED,
            idempotency_key="evidence-too-early",
        )


@mock_aws
def test_completion_transaction_detects_target_ttl_drift_and_retry_repairs() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    fact, projection = seed_hot_targets(client)
    archives = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    make_available(archives)

    class DriftBeforeCompletion:
        def __init__(self, delegate: Any) -> None:
            self.delegate = delegate
            self.calls = 0

        def get_item(self, **kwargs: object) -> dict[str, object]:
            return cast(dict[str, object], self.delegate.get_item(**kwargs))

        def query(self, **kwargs: object) -> dict[str, object]:
            return cast(dict[str, object], self.delegate.query(**kwargs))

        def transact_write_items(self, **kwargs: object) -> dict[str, object]:
            self.calls += 1
            if self.calls == 3:
                self.delegate.update_item(
                    TableName="hot",
                    Key={"pk": {"S": str(fact["pk"])}, "sk": {"S": str(fact["sk"])}},
                    UpdateExpression="SET #ttl = :wrong",
                    ExpressionAttributeNames={"#ttl": "ttl"},
                    ExpressionAttributeValues={":wrong": {"N": "1"}},
                )
            return cast(dict[str, object], self.delegate.transact_write_items(**kwargs))

    with pytest.raises(ConditionalWriteError, match="TTL"):
        DynamoHotExpirationRepository(
            DriftBeforeCompletion(client), "hot", clock=lambda: NOW
        ).authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="completion-drift",
        )
    marker_pk = (
        "INGESTION#IDEMPOTENCY#hot-expiration#"
        + hashlib.sha256(b"hot-expiration\0completion-drift").hexdigest()
    )
    assert "Item" not in client.get_item(
        TableName="hot",
        Key={"pk": {"S": marker_pk}, "sk": {"S": "META"}},
        ConsistentRead=True,
    )

    assert (
        DynamoHotExpirationRepository(client, "hot", clock=lambda: NOW).authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="completion-drift",
        )
        == 2
    )
    for item in (fact, projection):
        stored = client.get_item(
            TableName="hot",
            Key={"pk": {"S": str(item["pk"])}, "sk": {"S": str(item["sk"])}},
        )["Item"]
        assert stored["ttl"] == {"N": str(TTL)}


@mock_aws
def test_catalog_addition_after_reconciliation_seal_is_detected() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    fact, _projection = seed_hot_targets(client)
    archives = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    make_available(archives)
    extra_pk = "DATASET#dsv_a#INCIDENT#TS#signal_bucket#20260901"
    extra: dict[str, object] = {
        "pk": extra_pk,
        "sk": "TS#1#late",
        "entityType": "HOT_RECORD",
        "datasetVersion": "dsv_a",
        "sourceDataset": "signal_bucket",
    }
    late_catalog = encode_hot_partition_catalog(
        "dsv_a",
        "signal_bucket",
        PARTITION,
        extra_pk,
        catalog_generation=1,
        target_count=1,
        target_digest=hashlib.sha256(canonical_bytes([(extra_pk, str(extra["sk"]))])).hexdigest(),
    )
    for item in (extra, late_catalog):
        client.put_item(TableName="hot", Item=serialize_item(item))

    with pytest.raises(ConditionalWriteError, match="seal"):
        DynamoHotExpirationRepository(client, "hot", clock=lambda: NOW).authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="late-catalog",
        )
    stored = client.get_item(
        TableName="hot",
        Key={"pk": {"S": str(fact["pk"])}, "sk": {"S": str(fact["sk"])}},
    )["Item"]
    assert "ttl" not in stored


@mock_aws
def test_large_fact_set_repairs_drift_before_return_and_uses_aggregate_progress() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    facts = seed_fact_targets(client, 98)
    archives = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    make_available(archives, facts=98, projections=0, key_prefix="large-facts")

    class DriftDuringFinalRediscovery:
        def __init__(self, delegate: Any) -> None:
            self.delegate = delegate
            self.fact_queries = 0

        def get_item(self, **kwargs: object) -> dict[str, object]:
            return cast(dict[str, object], self.delegate.get_item(**kwargs))

        def query(self, **kwargs: object) -> dict[str, object]:
            response = cast(dict[str, object], self.delegate.query(**kwargs))
            values = cast(dict[str, dict[str, str]], kwargs["ExpressionAttributeValues"])
            if values[":pk"]["S"] == facts[0]["pk"]:
                self.fact_queries += 1
                if self.fact_queries == 2:
                    self.delegate.update_item(
                        TableName="hot",
                        Key={
                            "pk": {"S": str(facts[0]["pk"])},
                            "sk": {"S": str(facts[0]["sk"])},
                        },
                        UpdateExpression="SET #ttl = :wrong",
                        ExpressionAttributeNames={"#ttl": "ttl"},
                        ExpressionAttributeValues={":wrong": {"N": "1"}},
                    )
            return response

        def transact_write_items(self, **kwargs: object) -> dict[str, object]:
            return cast(dict[str, object], self.delegate.transact_write_items(**kwargs))

    with pytest.raises(ConditionalWriteError, match="TTL"):
        DynamoHotExpirationRepository(
            DriftDuringFinalRediscovery(client), "hot", clock=lambda: NOW
        ).authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="large-fact-drift",
        )
    operation_pk = (
        "INGESTION#IDEMPOTENCY#hot-expiration#"
        + hashlib.sha256(b"hot-expiration\0large-fact-drift").hexdigest()
    )
    assert "Item" not in client.get_item(
        TableName="hot",
        Key={"pk": {"S": operation_pk}, "sk": {"S": "META"}},
        ConsistentRead=True,
    )
    assert (
        DynamoHotExpirationRepository(client, "hot", clock=lambda: NOW).authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="large-fact-drift",
        )
        == 98
    )
    assert all(
        client.get_item(
            TableName="hot",
            Key={"pk": {"S": str(item["pk"])}, "sk": {"S": str(item["sk"])}},
        )["Item"]["ttl"]
        == {"N": str(TTL)}
        for item in facts
    )
    progress = client.query(
        TableName="hot",
        KeyConditionExpression="pk = :pk",
        ExpressionAttributeValues={":pk": {"S": operation_pk}},
        ConsistentRead=True,
    )["Items"]
    assert sum(item["sk"]["S"].startswith("PROGRESS#") for item in progress) == 2
    summary = next(item for item in progress if item["sk"] == {"S": "SUMMARY"})
    assert summary["completedTargetCount"] == {"N": "98"}


@mock_aws
def test_ninety_eight_projections_fit_final_completion_proof() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    for index in range(98):
        projection = {
            "pk": f"DATASET#dsv_a#VIEW#OVERVIEW#P{index:03d}#20260901",
            "sk": "PROJECTION#day",
            "entityType": "PROJECTION",
            "datasetVersion": "dsv_a",
            "partition": PARTITION,
        }
        catalog = encode_projection_partition_catalog(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            str(projection["pk"]),
            str(projection["sk"]),
            required_archives=(("signal_bucket", PARTITION),),
            catalog_generation=1,
        )
        for item in (projection, catalog):
            client.put_item(TableName="hot", Item=serialize_item(item))
    archives = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    make_available(archives, facts=0, projections=98, key_prefix="large-projections")

    assert (
        DynamoHotExpirationRepository(client, "hot", clock=lambda: NOW).authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="large-projections",
        )
        == 98
    )


@mock_aws
def test_late_fact_before_completion_marker_never_returns_false_success() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    facts = seed_fact_targets(client, 1)
    archives = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    make_available(archives, facts=1, projections=0, key_prefix="late-target")
    late = dict(encode_hot_record(record("late"), "dsv_a", PARTITION))

    class AddBeforeMarker:
        def __init__(self, delegate: Any) -> None:
            self.delegate = delegate
            self.added = False

        def get_item(self, **kwargs: object) -> dict[str, object]:
            return cast(dict[str, object], self.delegate.get_item(**kwargs))

        def query(self, **kwargs: object) -> dict[str, object]:
            return cast(dict[str, object], self.delegate.query(**kwargs))

        def transact_write_items(self, **kwargs: object) -> dict[str, object]:
            actions = cast(list[dict[str, object]], kwargs["TransactItems"])
            is_progress = any(
                "Put" in action
                and cast(dict[str, Any], action["Put"])["Item"].get("entityType")
                == {"S": "TTL_PROGRESS"}
                for action in actions
            )
            response = cast(dict[str, object], self.delegate.transact_write_items(**kwargs))
            if is_progress and not self.added:
                self.added = True
                self.delegate.put_item(TableName="hot", Item=serialize_item(late))
            return response

    with pytest.raises(RuntimeError, match="HOTPART target summary"):
        DynamoHotExpirationRepository(
            AddBeforeMarker(client), "hot", clock=lambda: NOW
        ).authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="late-before-marker",
        )
    stored = client.get_item(
        TableName="hot",
        Key={"pk": {"S": str(facts[0]["pk"])}, "sk": {"S": str(facts[0]["sk"])}},
    )["Item"]
    assert stored["ttl"] == {"N": str(TTL)}
    marker_pk = (
        "INGESTION#IDEMPOTENCY#hot-expiration#"
        + hashlib.sha256(b"hot-expiration\0late-before-marker").hexdigest()
    )
    assert "Item" not in client.get_item(
        TableName="hot",
        Key={"pk": {"S": marker_pk}, "sk": {"S": "META"}},
        ConsistentRead=True,
    )


@mock_aws
def test_partition_ttl_claim_rejects_a_different_authorized_value() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    fact = seed_fact_targets(client, 1)[0]
    archives = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    make_available(archives, facts=1, projections=0, key_prefix="ttl-claim")
    expiration = DynamoHotExpirationRepository(client, "hot", clock=lambda: NOW)
    assert (
        expiration.authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="ttl-first",
        )
        == 1
    )

    with pytest.raises(ConditionalWriteError, match="authorized"):
        expiration.authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL + 1,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="ttl-second",
        )
    stored = client.get_item(
        TableName="hot",
        Key={"pk": {"S": str(fact["pk"])}, "sk": {"S": str(fact["sk"])}},
    )["Item"]
    assert stored["ttl"] == {"N": str(TTL)}


@mock_aws
def test_change_during_last_rediscovery_cannot_leave_a_marker_or_return_success() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    fact = seed_fact_targets(client, 1)[0]
    archives = DynamoArchivePartitionRepository(client, "hot", clock=lambda: NOW)
    make_available(archives, facts=1, projections=0, key_prefix="last-rediscovery")

    class DriftDuringLastSnapshot:
        def __init__(self, delegate: Any) -> None:
            self.delegate = delegate
            self.fact_queries = 0

        def get_item(self, **kwargs: object) -> dict[str, object]:
            return cast(dict[str, object], self.delegate.get_item(**kwargs))

        def query(self, **kwargs: object) -> dict[str, object]:
            response = cast(dict[str, object], self.delegate.query(**kwargs))
            values = cast(dict[str, dict[str, str]], kwargs["ExpressionAttributeValues"])
            if values[":pk"]["S"] == fact["pk"]:
                self.fact_queries += 1
                if self.fact_queries == 2:
                    self.delegate.update_item(
                        TableName="hot",
                        Key={"pk": {"S": str(fact["pk"])}, "sk": {"S": str(fact["sk"])}},
                        UpdateExpression="SET #ttl = :wrong",
                        ExpressionAttributeNames={"#ttl": "ttl"},
                        ExpressionAttributeValues={":wrong": {"N": "1"}},
                    )
            return response

        def transact_write_items(self, **kwargs: object) -> dict[str, object]:
            return cast(dict[str, object], self.delegate.transact_write_items(**kwargs))

    with pytest.raises(ConditionalWriteError, match="TTL"):
        DynamoHotExpirationRepository(
            DriftDuringLastSnapshot(client), "hot", clock=lambda: NOW
        ).authorize_expiration(
            "dsv_a",
            "signal_bucket",
            PARTITION,
            TTL,
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key="drift-last-snapshot",
        )
    marker_pk = (
        "INGESTION#IDEMPOTENCY#hot-expiration#"
        + hashlib.sha256(b"hot-expiration\0drift-last-snapshot").hexdigest()
    )
    assert "Item" not in client.get_item(
        TableName="hot",
        Key={"pk": {"S": marker_pk}, "sk": {"S": "META"}},
        ConsistentRead=True,
    )
