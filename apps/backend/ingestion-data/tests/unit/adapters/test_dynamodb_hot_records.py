"""Verify DynamoDB persistence for canonical ingestion hot records."""

from __future__ import annotations

import hashlib
import json
import threading
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, cast

import pytest
from boto3.dynamodb.types import TypeDeserializer, TypeSerializer  # type: ignore[import-untyped]
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from adapters.dynamodb.client import DynamoDbThrottled
from adapters.dynamodb.codec import (
    EncodedItemTooLarge,
    EncodedKeyTooLarge,
    encode_hot_partition_catalog,
    encode_hot_record,
    serialize_item,
    serialized_item_bytes,
)
from adapters.dynamodb.hot_records import DynamoHotRecordSink
from domain.canonical_json import canonical_bytes
from domain.identity import record_id
from domain.models import CanonicalRecord, CanonicalValue, RecordType, TimeWindow
from ports import ConditionalWriteError, IdempotencyConflict, WriteResult

SERIALIZER = TypeSerializer()
DESERIALIZER = TypeDeserializer()


def record(
    suffix: str = "a",
    *,
    record_type: RecordType = RecordType.SIGNAL_OBSERVATION,
    observed_at: datetime | None = datetime(2026, 9, 1, tzinfo=UTC),
    measure: CanonicalValue = Decimal("12.50"),
    dimension_blob: str | None = None,
) -> CanonicalRecord:
    window = (
        TimeWindow(observed_at, observed_at + timedelta(minutes=5), 300)
        if observed_at is not None
        else None
    )
    return CanonicalRecord(
        schema_version="1.0",
        record_type=record_type,
        source_system="argus",
        source_dataset="signal_bucket",
        natural_key=(("signal", suffix),),
        observed_at=observed_at,
        window=window,
        dimensions=(
            {"blob": dimension_blob}
            if dimension_blob is not None
            else {"nested": {"nullable": None, "list": [1, 2.5, Decimal("3.25")]}}
        ),
        measures={"value": measure},
        quality={"sampleCount": 3},
        quality_flags=("PARTIAL",),
    )


def _serialize(item: Mapping[str, object]) -> dict[str, dict[str, Any]]:
    return {key: SERIALIZER.serialize(value) for key, value in item.items()}


def _deserialize(item: Mapping[str, Mapping[str, Any]]) -> dict[str, object]:
    return {key: DESERIALIZER.deserialize(value) for key, value in item.items()}


class FakeDynamoClient:
    """Low-level DynamoDB fake that uses real AttributeValue request/response shapes."""

    def __init__(self) -> None:
        self.items: dict[tuple[str, str], dict[str, dict[str, Any]]] = {}
        self.batch_get_calls: list[dict[str, object]] = []
        self.batch_write_calls: list[dict[str, object]] = []
        self.transact_write_calls: list[dict[str, object]] = []
        self.query_calls: list[dict[str, object]] = []
        self.query_page_size: int | None = None

    @staticmethod
    def _key(item: Mapping[str, Mapping[str, Any]]) -> tuple[str, str]:
        return str(item["pk"]["S"]), str(item["sk"]["S"])

    def seed(self, item: Mapping[str, object]) -> None:
        encoded = _serialize(item)
        self.items[self._key(encoded)] = encoded

    def batch_get_item(self, **kwargs: object) -> dict[str, object]:
        self.batch_get_calls.append(dict(kwargs))
        request_items = kwargs["RequestItems"]
        assert isinstance(request_items, Mapping)
        table_name, request = next(iter(request_items.items()))
        assert isinstance(table_name, str)
        assert isinstance(request, Mapping)
        keys = request["Keys"]
        assert isinstance(keys, list)
        found = [self.items[self._key(key)] for key in keys if self._key(key) in self.items]
        return {
            "Responses": {table_name: found},
            "UnprocessedKeys": {},
            "ResponseMetadata": {"HTTPStatusCode": 200},
        }

    def batch_write_item(self, **kwargs: object) -> dict[str, object]:
        self.batch_write_calls.append(dict(kwargs))
        request_items = kwargs["RequestItems"]
        assert isinstance(request_items, Mapping)
        table_name, writes = next(iter(request_items.items()))
        assert isinstance(table_name, str)
        assert isinstance(writes, list)
        for write in writes:
            item = write["PutRequest"]["Item"]
            self.items[self._key(item)] = item
        return {
            "UnprocessedItems": {},
            "ResponseMetadata": {"HTTPStatusCode": 200},
        }

    def query(self, **kwargs: object) -> dict[str, object]:
        self.query_calls.append(dict(kwargs))
        values = cast(Mapping[str, Mapping[str, str]], kwargs["ExpressionAttributeValues"])
        pk = values[":pk"]["S"]
        matching = [
            {"pk": item["pk"], "sk": item["sk"]}
            for (item_pk, _item_sk), item in sorted(self.items.items())
            if item_pk == pk
        ]
        start = kwargs.get("ExclusiveStartKey")
        if start is not None:
            assert isinstance(start, Mapping)
            start_key = self._key(cast(Mapping[str, Mapping[str, Any]], start))
            matching = [item for item in matching if self._key(item) > start_key]
        items = matching if self.query_page_size is None else matching[: self.query_page_size]
        response: dict[str, object] = {
            "Items": items,
            "Count": len(items),
            "ResponseMetadata": {"HTTPStatusCode": 200},
        }
        if len(items) < len(matching):
            response["LastEvaluatedKey"] = items[-1]
        return response

    def transact_write_items(self, **kwargs: object) -> dict[str, object]:
        self.transact_write_calls.append(dict(kwargs))
        actions = cast(list[dict[str, object]], kwargs["TransactItems"])
        staged = dict(self.items)
        reasons: list[dict[str, str]] = [{"Code": "None"} for _action in actions]
        for index, action in enumerate(actions):
            if "ConditionCheck" in action:
                check = cast(dict[str, object], action["ConditionCheck"])
                check_key = cast(Mapping[str, Mapping[str, str]], check["Key"])
                if (check_key["pk"]["S"], check_key["sk"]["S"]) in staged:
                    reasons[index] = {"Code": "ConditionalCheckFailed"}
                continue
            put = cast(dict[str, object], action["Put"])
            item = cast(dict[str, dict[str, Any]], put["Item"])
            key = self._key(item)
            existing = staged.get(key)
            condition = put.get("ConditionExpression")
            if condition == "attribute_not_exists(pk)" and existing is not None:
                reasons[index] = {"Code": "ConditionalCheckFailed"}
                continue
            if condition == "attribute_exists(pk)" and existing is None:
                reasons[index] = {"Code": "ConditionalCheckFailed"}
                continue
            if condition == "attribute_exists(pk) AND attribute_not_exists(catalogFormat)" and (
                existing is None or "catalogFormat" in existing
            ):
                reasons[index] = {"Code": "ConditionalCheckFailed"}
                continue
            if condition == "payloadHash = :observedHash":
                values = cast(Mapping[str, Mapping[str, str]], put["ExpressionAttributeValues"])
                if existing is None or existing.get("payloadHash") != values[":observedHash"]:
                    reasons[index] = {"Code": "ConditionalCheckFailed"}
                    continue
            if condition == "targetCount = :previousCount AND targetDigest = :previousDigest":
                values = cast(Mapping[str, Mapping[str, str]], put["ExpressionAttributeValues"])
                if (
                    existing is None
                    or existing.get("targetCount") != values[":previousCount"]
                    or existing.get("targetDigest") != values[":previousDigest"]
                ):
                    reasons[index] = {"Code": "ConditionalCheckFailed"}
                    continue
            if (
                condition == "fingerprint = :fingerprint AND markerState = :claimed "
                "AND claimToken = :claimToken"
            ):
                values = cast(Mapping[str, Mapping[str, str]], put["ExpressionAttributeValues"])
                if (
                    existing is None
                    or existing.get("fingerprint") != values[":fingerprint"]
                    or existing.get("markerState") != values[":claimed"]
                    or existing.get("claimToken") != values[":claimToken"]
                ):
                    reasons[index] = {"Code": "ConditionalCheckFailed"}
                    continue
            if (
                condition == "fingerprint = :fingerprint AND markerState = :claimed "
                "AND leaseExpiresAt <= :now"
            ):
                values = cast(Mapping[str, Mapping[str, str]], put["ExpressionAttributeValues"])
                if (
                    existing is None
                    or existing.get("fingerprint") != values[":fingerprint"]
                    or existing.get("markerState") != values[":claimed"]
                    or int(cast(str, existing.get("leaseExpiresAt", {}).get("N", "-1")))
                    > int(values[":now"]["N"])
                ):
                    reasons[index] = {"Code": "ConditionalCheckFailed"}
                    continue
            staged[key] = item
        if any(reason["Code"] != "None" for reason in reasons):
            raise ClientError(
                {
                    "Error": {"Code": "TransactionCanceledException"},
                    "CancellationReasons": reasons,
                },
                "TransactWriteItems",
            )
        self.items = staged
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}


class FirstReadBarrierClient(FakeDynamoClient):
    """Force two independent sinks past their first idempotency lookup together."""

    def __init__(self) -> None:
        super().__init__()
        self._barrier = threading.Barrier(2)
        self._seen_threads: set[int] = set()
        self._seen_lock = threading.Lock()

    def batch_get_item(self, **kwargs: object) -> dict[str, object]:
        thread_id = threading.get_ident()
        with self._seen_lock:
            first_read = thread_id not in self._seen_threads
            self._seen_threads.add(thread_id)
        if first_read:
            self._barrier.wait(timeout=5)
        return super().batch_get_item(**kwargs)


@pytest.mark.parametrize(
    ("record_type", "family"),
    [
        (RecordType.SIGNAL_OBSERVATION, "FACT#TS"),
        (RecordType.DIMENSIONAL_METRIC_AGGREGATE, "FACT#TS"),
        (RecordType.APPLICATION_ERROR_AGGREGATE, "FACT#TS"),
        (RecordType.SHADOW_OBSERVATION, "FACT#TS"),
        (RecordType.INCIDENT, "INCIDENT#TS"),
        (RecordType.LIVE_EVENT_CONTEXT, "CONTEXT#TS"),
        (RecordType.FINDING_STATUS_TRANSITION, "CONTEXT#TS"),
        (RecordType.UPSTREAM_SOURCE_HEALTH, "INGESTION#SOURCE"),
        (RecordType.UPSTREAM_COLLECTOR_RUN, "INGESTION#SOURCE"),
    ],
)
def test_codec_routes_every_record_type_to_its_closed_family(
    record_type: RecordType, family: str
) -> None:
    item = encode_hot_record(
        record(record_type=record_type),
        "dsv_abc",
        "year=2026/month=09/day=01",
    )

    assert item["pk"] == f"DATASET#dsv_abc#{family}#signal_bucket#20260901"
    assert str(item["sk"]).startswith("TS#1788220800000#rid_")
    assert len(str(item["sk"]).split("#")[-1]) == 68


def test_codec_preserves_complete_payload_and_uses_decimal_for_every_number() -> None:
    item = encode_hot_record(record(), "dsv_abc", "year=2026/month=09/day=01")

    assert item["recordId"] == str(item["sk"]).split("#")[-1]
    assert str(item["payloadHash"]).startswith("ph_")
    assert item["datasetVersion"] == "dsv_abc"
    assert item["schemaVersion"] == "1.0"
    assert item["recordType"] == "SignalObservation"
    assert item["sourceSystem"] == "argus"
    assert item["sourceDataset"] == "signal_bucket"
    assert item["naturalKey"] == [{"name": "signal", "value": "a"}]
    assert item["observedAt"] == "2026-09-01T00:00:00.000Z"
    assert item["window"] == {
        "start": "2026-09-01T00:00:00.000Z",
        "end": "2026-09-01T00:05:00.000Z",
        "grainSeconds": Decimal(300),
    }
    assert item["dimensions"] == {
        "nested": {"nullable": None, "list": [Decimal(1), Decimal("2.5"), Decimal("3.25")]}
    }
    assert item["measures"] == {"value": Decimal("12.50")}
    assert item["quality"] == {"sampleCount": Decimal(3)}
    assert item["qualityFlags"] == ["PARTIAL"]


def test_codec_keeps_reserved_attributes_outside_untrusted_nested_payload() -> None:
    source = record()
    source = CanonicalRecord(
        source.schema_version,
        source.record_type,
        source.source_system,
        source.source_dataset,
        source.natural_key,
        source.observed_at,
        source.window,
        {"pk": "untrusted", "payloadHash": "untrusted"},
        source.measures,
        source.quality,
        source.quality_flags,
    )

    item = encode_hot_record(source, "dsv_abc", "year=2026/month=09/day=01")

    assert str(item["pk"]).startswith("DATASET#dsv_abc#FACT#")
    assert str(item["payloadHash"]).startswith("ph_")
    assert item["dimensions"] == {"pk": "untrusted", "payloadHash": "untrusted"}


def test_codec_rejects_a_partition_key_over_the_dynamodb_limit() -> None:
    with pytest.raises(EncodedKeyTooLarge, match="2048"):
        encode_hot_record(
            record(),
            "dsv_" + ("a" * 2050),
            "year=2026/month=09/day=01",
        )


@pytest.mark.parametrize(
    "bad_partition",
    ["2026-09-01", "SNAPSHOT", "snapshot_date=", "year=2026/month=9/day=01", ""],
)
def test_codec_rejects_noncanonical_partition(bad_partition: str) -> None:
    with pytest.raises(ValueError, match="partition"):
        encode_hot_record(record(), "dsv_abc", bad_partition)


def test_snapshot_partition_is_explicit_and_drives_key_without_snapshot_sentinel() -> None:
    item = encode_hot_record(
        record(observed_at=None, record_type=RecordType.UPSTREAM_SOURCE_HEALTH),
        "dsv_abc",
        "snapshot_date=2026-09-02",
    )

    assert str(item["pk"]).endswith("#20260902")
    assert str(item["sk"]).startswith("TS#1788307200000#rid_")
    assert "SNAPSHOT" not in str(item["pk"])
    assert "SNAPSHOT" not in str(item["sk"])


@pytest.mark.parametrize("invalid", [float("nan"), float("inf"), float("-inf")])
def test_codec_rejects_non_finite_float(invalid: float) -> None:
    with pytest.raises(ValueError, match="finite"):
        encode_hot_record(record(measure=invalid), "dsv_abc", "year=2026/month=09/day=01")


def test_codec_rejects_internal_item_over_200_kib() -> None:
    with pytest.raises(EncodedItemTooLarge, match="200 KiB"):
        encode_hot_record(
            record(measure="x" * (201 * 1024)),
            "dsv_abc",
            "year=2026/month=09/day=01",
        )


def test_sink_skips_unchanged_writes_and_rejects_a_different_immutable_payload() -> None:
    client = FakeDynamoClient()
    original = record()
    encoded = encode_hot_record(original, "dsv_abc", "year=2026/month=09/day=01")
    client.seed(encoded)
    client.seed(
        encode_hot_partition_catalog(
            "dsv_abc",
            "signal_bucket",
            "year=2026/month=09/day=01",
            str(encoded["pk"]),
        )
    )
    sink = DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0)

    unchanged = sink.write(
        (original,),
        "dsv_abc",
        "year=2026/month=09/day=01",
        idempotency_key="same",
    )
    assert client.batch_write_calls == []
    with pytest.raises(ConditionalWriteError, match="immutable"):
        sink.write(
            (record(measure=Decimal("99")),),
            "dsv_abc",
            "year=2026/month=09/day=01",
            idempotency_key="changed",
        )

    assert unchanged == WriteResult(written=0, unchanged=1)
    assert client.batch_write_calls == []
    stored = _deserialize(next(item for item in client.items.values() if "payloadHash" in item))
    assert stored["measures"] == {"value": Decimal("12.50")}


@pytest.mark.parametrize(
    ("concurrent_measure", "expected_result"),
    [
        (Decimal("12.50"), WriteResult(written=0, unchanged=1)),
        (Decimal("99"), None),
    ],
    ids=["same-hash-converges", "different-hash-conflicts"],
)
def test_sink_reclassifies_a_fact_inserted_between_read_and_transaction(
    concurrent_measure: Decimal,
    expected_result: WriteResult | None,
) -> None:
    desired = record()
    concurrent_item = encode_hot_record(
        record(measure=concurrent_measure),
        "dsv_abc",
        "year=2026/month=09/day=01",
    )

    class InterleavingClient(FakeDynamoClient):
        def __init__(self) -> None:
            super().__init__()
            self.interleaved = False

        def transact_write_items(self, **kwargs: object) -> dict[str, object]:
            actions = cast(list[dict[str, object]], kwargs["TransactItems"])
            writes_fact = any(
                "Put" in action
                and cast(dict[str, Any], action["Put"])["Item"].get("entityType")
                == {"S": "HOT_RECORD"}
                for action in actions
            )
            if writes_fact and not self.interleaved:
                self.interleaved = True
                self.seed(concurrent_item)
            return super().transact_write_items(**kwargs)

    client = InterleavingClient()
    sink = DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0)

    if expected_result is None:
        with pytest.raises(ConditionalWriteError, match="immutable"):
            sink.write(
                (desired,),
                "dsv_abc",
                "year=2026/month=09/day=01",
                idempotency_key="different-hash-race",
            )
    else:
        assert sink.write(
            (desired,),
            "dsv_abc",
            "year=2026/month=09/day=01",
            idempotency_key="same-hash-race",
        ) == WriteResult(written=0, unchanged=1)

    stored = _deserialize(client.items[FakeDynamoClient._key(_serialize(concurrent_item))])
    assert stored["measures"] == {"value": concurrent_measure}


@pytest.mark.parametrize(
    "partition",
    ["year=2026/month=09/day=01", "snapshot_date=2026-09-02"],
)
@pytest.mark.parametrize(
    "broken_attribute",
    [None, "entityType", "datasetVersion", "dataset", "partition", "partitionDate", "hotPk"],
)
def test_new_sink_repairs_catalog_after_fact_only_crash_without_rewriting_fact(
    partition: str, broken_attribute: str | None
) -> None:
    client = FakeDynamoClient()
    source = record(
        observed_at=(
            None if partition.startswith("snapshot_date=") else datetime(2026, 9, 1, tzinfo=UTC)
        )
    )
    fact = encode_hot_record(source, "dsv_abc", partition)
    desired_catalog = encode_hot_partition_catalog(
        "dsv_abc",
        "signal_bucket",
        partition,
        str(fact["pk"]),
        target_count=1,
        target_digest=hashlib.sha256(
            canonical_bytes([(str(fact["pk"]), str(fact["sk"]))])
        ).hexdigest(),
    )
    client.seed(fact)
    if broken_attribute is not None:
        client.seed({**desired_catalog, broken_attribute: "incorrect"})

    # A new adapter instance simulates process restart after a partial BatchWrite effect.
    sink = DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0)
    result = sink.write((source,), "dsv_abc", partition, idempotency_key="repair")

    assert result == WriteResult(written=0, unchanged=1)
    assert client.batch_write_calls == []
    assert len(client.transact_write_calls) == 3
    repaired = _deserialize(client.items[FakeDynamoClient._key(_serialize(desired_catalog))])
    assert repaired["entityType"] == "HOT_PARTITION"
    assert repaired["catalogFormat"] == "CHAIN_V1"
    assert repaired["targetCount"] == 1
    assert client.items[FakeDynamoClient._key(_serialize(fact))] == _serialize(fact)


@pytest.mark.parametrize(
    "partition",
    ["year=2026/month=09/day=01", "snapshot_date=2026-09-02"],
)
@pytest.mark.parametrize("extra_attribute", ["ttl", "unexpectedAttribute"])
def test_new_sink_removes_extra_catalog_attributes_without_rewriting_fact(
    partition: str, extra_attribute: str
) -> None:
    client = FakeDynamoClient()
    source = record(
        observed_at=(
            None if partition.startswith("snapshot_date=") else datetime(2026, 9, 1, tzinfo=UTC)
        )
    )
    fact = encode_hot_record(source, "dsv_abc", partition)
    desired_catalog = encode_hot_partition_catalog(
        "dsv_abc",
        "signal_bucket",
        partition,
        str(fact["pk"]),
        target_count=1,
        target_digest=hashlib.sha256(
            canonical_bytes([(str(fact["pk"]), str(fact["sk"]))])
        ).hexdigest(),
    )
    client.seed(fact)
    client.seed({**desired_catalog, extra_attribute: 1_800_000_000})

    sink = DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0)
    result = sink.write((source,), "dsv_abc", partition, idempotency_key="remove-extra")

    assert result == WriteResult(written=0, unchanged=1)
    assert client.batch_write_calls == []
    assert len(client.transact_write_calls) == 3
    repaired = _deserialize(client.items[FakeDynamoClient._key(_serialize(desired_catalog))])
    assert repaired["entityType"] == "HOT_PARTITION"
    assert repaired["catalogFormat"] == "CHAIN_V1"
    assert repaired["targetCount"] == 1
    assert client.items[FakeDynamoClient._key(_serialize(fact))] == _serialize(fact)


def test_sink_catalogs_each_distinct_hot_pk_with_the_exact_partition() -> None:
    client = FakeDynamoClient()
    sink = DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0)

    result = sink.write(
        (record("a"), record("b")),
        "dsv_abc",
        "year=2026/month=09/day=01",
        idempotency_key="catalog",
    )

    assert result == WriteResult(written=2, unchanged=0)
    decoded = [_deserialize(item) for item in client.items.values()]
    catalogs = [item for item in decoded if item.get("entityType") == "HOT_PARTITION"]
    assert len(catalogs) == 1
    assert catalogs[0]["pk"] == ("DATASET#dsv_abc#INGESTION#HOTPART#signal_bucket#20260901")
    assert str(catalogs[0]["sk"]).startswith("PK#")
    assert catalogs[0]["hotPk"] == ("DATASET#dsv_abc#FACT#TS#signal_bucket#20260901")
    assert catalogs[0]["partition"] == "year=2026/month=09/day=01"


def test_sink_appends_paginated_hotpart_catalog_without_querying_prior_facts() -> None:
    client = FakeDynamoClient()
    sink = DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0)

    for page in range(10):
        result = sink.write(
            tuple(record(f"{page:02d}-{index:03d}") for index in range(100)),
            "dsv_abc",
            "year=2026/month=09/day=01",
            idempotency_key=f"page-{page}",
        )
        assert result == WriteResult(written=100, unchanged=0)

    assert len(client.query_calls) == 1


def test_sink_repairs_a_legacy_catalog_without_prior_facts_before_appending() -> None:
    client = FakeDynamoClient()
    source = record("catalog-only")
    fact = encode_hot_record(source, "dsv_abc", "year=2026/month=09/day=01")
    legacy_catalog = encode_hot_partition_catalog(
        "dsv_abc",
        "signal_bucket",
        "year=2026/month=09/day=01",
        str(fact["pk"]),
        target_count=0,
        target_digest=hashlib.sha256(canonical_bytes([])).hexdigest(),
    )
    client.seed(legacy_catalog)

    result = DynamoHotRecordSink(
        client, "table", sleep=lambda _seconds: None, jitter=lambda: 0
    ).write(
        (source,),
        "dsv_abc",
        "year=2026/month=09/day=01",
        idempotency_key="catalog-only",
    )

    assert result == WriteResult(1, 0)
    catalog_key = FakeDynamoClient._key(_serialize(legacy_catalog))
    assert _deserialize(client.items[catalog_key])["catalogFormat"] == "CHAIN_V1"


def test_sink_rejects_an_oversized_legacy_catalog_repair_before_any_transaction() -> None:
    client = FakeDynamoClient()
    partition = "year=2026/month=09/day=01"
    sources = tuple(record(f"legacy-{index:04d}") for index in range(2_000))
    for source in sources:
        client.seed(encode_hot_record(source, "dsv_abc", partition))
    client.query_page_size = 100
    sink = DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0)

    with pytest.raises(ValueError, match="legacy hot partition catalog exceeds"):
        sink.write((sources[0],), "dsv_abc", partition, idempotency_key="legacy-repair")

    assert client.transact_write_calls == []
    assert len(client.query_calls) < 20


def test_sink_never_mutates_a_catalog_after_retention_generation_is_sealed() -> None:
    client = FakeDynamoClient()
    seal = {
        "pk": "DATASET#dsv_abc#INGESTION#RETENTION#signal_bucket#20260901",
        "sk": "META",
        "entityType": "RETENTION_SET",
    }
    client.seed(seal)
    sink = DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0)

    with pytest.raises(ConditionalWriteError, match="sealed"):
        sink.write(
            (record(),),
            "dsv_abc",
            "year=2026/month=09/day=01",
            idempotency_key="write-after-seal",
        )

    decoded = [_deserialize(item) for item in client.items.values()]
    assert not any(item.get("entityType") == "HOT_RECORD" for item in decoded)
    assert not any(item.get("entityType") == "HOT_PARTITION" for item in decoded)


def test_sink_deduplicates_identical_ids_and_rejects_conflicting_duplicates() -> None:
    client = FakeDynamoClient()
    sink = DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0)

    assert sink.write(
        (record(), record()),
        "dsv_abc",
        "year=2026/month=09/day=01",
        idempotency_key="duplicate-same",
    ) == WriteResult(1, 0)
    conflicting = record(measure=2)
    with pytest.raises(ValueError) as captured:
        sink.write(
            (record(measure=1), conflicting),
            "dsv_abc",
            "year=2026/month=09/day=01",
            idempotency_key="duplicate-different",
        )
    assert str(captured.value) == (
        f"duplicate recordId has conflicting payload: {record_id(conflicting)}"
    )


def test_sink_replays_stable_result_and_rejects_idempotency_key_reuse() -> None:
    client = FakeDynamoClient()
    sink = DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0)

    first = sink.write(
        (record(),),
        "dsv_abc",
        "year=2026/month=09/day=01",
        idempotency_key="stable",
    )
    calls = len(client.batch_get_calls) + len(client.transact_write_calls)
    replay = sink.write(
        (record(),),
        "dsv_abc",
        "year=2026/month=09/day=01",
        idempotency_key="stable",
    )

    assert replay == first == WriteResult(1, 0)
    assert len(client.batch_get_calls) + len(client.transact_write_calls) == calls
    with pytest.raises(IdempotencyConflict):
        sink.write(
            (record("other"),),
            "dsv_abc",
            "year=2026/month=09/day=01",
            idempotency_key="stable",
        )


def test_sink_bounds_completed_idempotency_cache_with_fixed_fingerprints() -> None:
    client = FakeDynamoClient()
    sink = DynamoHotRecordSink(
        client,
        "table",
        completed_cache_size=1,
        sleep=lambda _seconds: None,
        jitter=lambda: 0,
    )
    first = record("first")
    second = record("second")

    assert sink.write(
        (first,), "dsv_abc", "year=2026/month=09/day=01", idempotency_key="one"
    ) == WriteResult(1, 0)
    with pytest.raises(IdempotencyConflict):
        sink.write(
            (record("changed"),), "dsv_abc", "year=2026/month=09/day=01", idempotency_key="one"
        )
    one = hashlib.sha256(b"one").digest()
    two = hashlib.sha256(b"two").digest()
    assert len(sink._completed) == 1
    assert len(sink._completed[one].fingerprint) == 32

    assert sink.write(
        (second,), "dsv_abc", "year=2026/month=09/day=01", idempotency_key="two"
    ) == WriteResult(1, 0)

    assert list(sink._completed) == [two]
    assert sink.write(
        (first,), "dsv_abc", "year=2026/month=09/day=01", idempotency_key="one"
    ) == WriteResult(1, 0)

    lru_client = FakeDynamoClient()
    lru = DynamoHotRecordSink(
        lru_client,
        "table",
        completed_cache_size=2,
        sleep=lambda _seconds: None,
        jitter=lambda: 0,
    )
    third = record("third")
    lru.write((first,), "dsv_abc", "year=2026/month=09/day=01", idempotency_key="one")
    lru.write((second,), "dsv_abc", "year=2026/month=09/day=01", idempotency_key="two")
    lru.write((first,), "dsv_abc", "year=2026/month=09/day=01", idempotency_key="one")
    lru.write((third,), "dsv_abc", "year=2026/month=09/day=01", idempotency_key="three")

    assert list(lru._completed) == [
        hashlib.sha256(b"one").digest(),
        hashlib.sha256(b"three").digest(),
    ]


def test_sink_rejects_reused_key_after_lru_eviction_and_process_restart() -> None:
    client = FakeDynamoClient()
    first = record("first")
    DynamoHotRecordSink(
        client,
        "table",
        completed_cache_size=1,
        sleep=lambda _seconds: None,
        jitter=lambda: 0,
    ).write((first,), "dsv_abc", "year=2026/month=09/day=01", idempotency_key="one")
    DynamoHotRecordSink(
        client,
        "table",
        completed_cache_size=1,
        sleep=lambda _seconds: None,
        jitter=lambda: 0,
    ).write((record("second"),), "dsv_abc", "year=2026/month=09/day=01", idempotency_key="two")

    restarted = DynamoHotRecordSink(
        client,
        "table",
        completed_cache_size=1,
        sleep=lambda _seconds: None,
        jitter=lambda: 0,
    )
    changed = record("changed")
    with pytest.raises(IdempotencyConflict):
        restarted.write((changed,), "dsv_abc", "year=2026/month=09/day=01", idempotency_key="one")

    changed_item = encode_hot_record(changed, "dsv_abc", "year=2026/month=09/day=01")
    assert FakeDynamoClient._key(_serialize(changed_item)) not in client.items


def _hot_write_fingerprint(source: CanonicalRecord, dataset_version: str, partition: str) -> bytes:
    item = encode_hot_record(source, dataset_version, partition)
    return hashlib.sha256(
        canonical_bytes(
            {
                "datasetVersion": dataset_version,
                "partition": partition,
                "records": [
                    {
                        "pk": item["pk"],
                        "sk": item["sk"],
                        "payloadHash": item["payloadHash"],
                    }
                ],
            }
        )
    ).digest()


def test_sink_recovers_an_expired_claimed_marker_after_crash_before_fact_write() -> None:
    client = FakeDynamoClient()
    source = record("resume")
    origin = DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0)
    marker = origin._marker_item(
        "resume",
        _hot_write_fingerprint(source, "dsv_abc", "year=2026/month=09/day=01"),
        claim_token="0" * 32,
    )
    marker["leaseExpiresAt"] = 0
    client.seed(marker)

    result = DynamoHotRecordSink(
        client, "table", sleep=lambda _seconds: None, jitter=lambda: 0
    ).write((source,), "dsv_abc", "year=2026/month=09/day=01", idempotency_key="resume")

    assert result == WriteResult(1, 0)
    marker_key = origin._idempotency_marker_key("resume")
    stored = _deserialize(client.items[marker_key])
    assert stored["markerState"] == "COMPLETED"
    assert stored["result"] == {"written": Decimal(1), "unchanged": Decimal(0)}


def test_sink_recovers_an_expired_claimed_marker_after_crash_before_completion() -> None:
    client = FakeDynamoClient()
    source = record("fact-only")
    fact = encode_hot_record(source, "dsv_abc", "year=2026/month=09/day=01")
    client.seed(fact)
    origin = DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0)
    marker = origin._marker_item(
        "fact-only",
        _hot_write_fingerprint(source, "dsv_abc", "year=2026/month=09/day=01"),
        claim_token="0" * 32,
    )
    marker["leaseExpiresAt"] = 0
    client.seed(marker)

    result = DynamoHotRecordSink(
        client, "table", sleep=lambda _seconds: None, jitter=lambda: 0
    ).write((source,), "dsv_abc", "year=2026/month=09/day=01", idempotency_key="fact-only")

    assert result == WriteResult(0, 1)
    marker_key = origin._idempotency_marker_key("fact-only")
    assert _deserialize(client.items[marker_key])["markerState"] == "COMPLETED"


def test_sink_does_not_take_over_a_claimed_marker_with_an_active_lease() -> None:
    client = FakeDynamoClient()
    source = record("active-lease")
    fingerprint = _hot_write_fingerprint(source, "dsv_abc", "year=2026/month=09/day=01")
    origin = DynamoHotRecordSink(
        client,
        "table",
        clock=lambda: 1_000,
        sleep=lambda _seconds: None,
        jitter=lambda: 0,
    )
    marker = origin._marker_item("active-lease", fingerprint, claim_token="0" * 32)
    marker["leaseExpiresAt"] = 1_001
    client.seed(marker)

    with pytest.raises(ConditionalWriteError, match="already claimed"):
        DynamoHotRecordSink(
            client,
            "table",
            clock=lambda: 1_000,
            sleep=lambda _seconds: None,
            jitter=lambda: 0,
        ).write(
            (source,),
            "dsv_abc",
            "year=2026/month=09/day=01",
            idempotency_key="active-lease",
        )

    marker_key = origin._idempotency_marker_key("active-lease")
    assert _deserialize(client.items[marker_key])["claimToken"] == "0" * 32


def test_sink_takes_over_a_claimed_marker_when_its_lease_expires_at_now() -> None:
    client = FakeDynamoClient()
    source = record("lease-boundary")
    fingerprint = _hot_write_fingerprint(source, "dsv_abc", "year=2026/month=09/day=01")
    origin = DynamoHotRecordSink(
        client,
        "table",
        clock=lambda: 1_000,
        sleep=lambda _seconds: None,
        jitter=lambda: 0,
    )
    marker = origin._marker_item("lease-boundary", fingerprint, claim_token="0" * 32)
    marker["leaseExpiresAt"] = 1_000
    client.seed(marker)

    result = DynamoHotRecordSink(
        client,
        "table",
        clock=lambda: 1_000,
        sleep=lambda _seconds: None,
        jitter=lambda: 0,
    ).write(
        (source,),
        "dsv_abc",
        "year=2026/month=09/day=01",
        idempotency_key="lease-boundary",
    )

    assert result == WriteResult(1, 0)
    marker_key = origin._idempotency_marker_key("lease-boundary")
    assert _deserialize(client.items[marker_key])["markerState"] == "COMPLETED"


def test_sink_does_not_complete_a_marker_claimed_with_a_foreign_token() -> None:
    client = FakeDynamoClient()
    source = record("foreign-token")
    fingerprint = _hot_write_fingerprint(source, "dsv_abc", "year=2026/month=09/day=01")
    origin = DynamoHotRecordSink(
        client,
        "table",
        clock=lambda: 1_000,
        sleep=lambda _seconds: None,
        jitter=lambda: 0,
    )
    marker = origin._marker_item("foreign-token", fingerprint, claim_token="0" * 32)
    client.seed(marker)

    with pytest.raises(ConditionalWriteError, match="changed concurrently"):
        DynamoHotRecordSink(
            client,
            "table",
            clock=lambda: 1_000,
            sleep=lambda _seconds: None,
            jitter=lambda: 0,
        )._complete_or_replay_hot_write("foreign-token", fingerprint, "f" * 32, WriteResult(1, 0))

    marker_key = origin._idempotency_marker_key("foreign-token")
    stored = _deserialize(client.items[marker_key])
    assert stored["markerState"] == "CLAIMED"
    assert stored["claimToken"] == "0" * 32


def test_sink_rejects_different_input_against_an_expired_claimed_marker() -> None:
    client = FakeDynamoClient()
    origin = DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0)
    first = record("first")
    marker = origin._marker_item(
        "claimed-conflict",
        _hot_write_fingerprint(first, "dsv_abc", "year=2026/month=09/day=01"),
        claim_token="0" * 32,
    )
    marker["leaseExpiresAt"] = 0
    client.seed(marker)

    with pytest.raises(IdempotencyConflict):
        DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0).write(
            (record("changed"),),
            "dsv_abc",
            "year=2026/month=09/day=01",
            idempotency_key="claimed-conflict",
        )

    assert len(client.transact_write_calls) == 0


def test_sink_rejects_concurrent_cross_instance_reuse_of_an_idempotency_key() -> None:
    client = FirstReadBarrierClient()
    sinks = tuple(
        DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0)
        for _ in range(2)
    )
    outcomes: list[WriteResult | Exception] = []

    def write(sink: DynamoHotRecordSink, suffix: str, partition: str) -> None:
        try:
            outcomes.append(
                sink.write((record(suffix),), "dsv_abc", partition, idempotency_key="same")
            )
        except Exception as error:  # The assertion below verifies the public failure type.
            outcomes.append(error)

    threads = (
        threading.Thread(target=write, args=(sinks[0], "left", "year=2026/month=09/day=01")),
        threading.Thread(target=write, args=(sinks[1], "right", "year=2026/month=09/day=02")),
    )
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)

    assert not any(thread.is_alive() for thread in threads)
    assert sum(isinstance(outcome, WriteResult) for outcome in outcomes) == 1
    assert sum(isinstance(outcome, IdempotencyConflict) for outcome in outcomes) == 1


def test_sink_rejects_an_idempotency_key_larger_than_1024_utf8_bytes_without_effects() -> None:
    client = FakeDynamoClient()
    sink = DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0)

    with pytest.raises(ValueError, match="1024"):
        sink.write(
            (record(),),
            "dsv_abc",
            "year=2026/month=09/day=01",
            idempotency_key="x" * 1_025,
        )

    assert client.batch_get_calls == []
    assert client.transact_write_calls == []


def test_sink_validates_explicit_partition_even_for_an_empty_batch() -> None:
    client = FakeDynamoClient()
    sink = DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0)

    with pytest.raises(ValueError, match="partition"):
        sink.write((), "dsv_abc", "SNAPSHOT", idempotency_key="empty-invalid")

    assert client.batch_get_calls == []
    assert client.batch_write_calls == []


def test_sink_chunks_batch_get_at_100_and_fact_transactions_at_97_with_catalog_actions() -> None:
    client = FakeDynamoClient()
    sink = DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0)

    result = sink.write(
        tuple(record(str(index)) for index in range(126)),
        "dsv_abc",
        "year=2026/month=09/day=01",
        idempotency_key="chunks",
    )

    assert result == WriteResult(126, 0)
    get_sizes = [
        len(call["RequestItems"]["table"]["Keys"])  # type: ignore[index]
        for call in client.batch_get_calls
    ]
    fact_transaction_sizes = [
        sum(
            "Put" in action
            and cast(dict[str, Any], action["Put"])["Item"].get("entityType") == {"S": "HOT_RECORD"}
            for action in cast(list[dict[str, object]], call["TransactItems"])
        )
        for call in client.transact_write_calls
    ]
    fact_transaction_sizes = [size for size in fact_transaction_sizes if size]
    assert max(get_sizes) <= 100
    assert sum(get_sizes) >= 126
    assert max(fact_transaction_sizes) <= 97
    assert sum(fact_transaction_sizes) == 126
    assert len(client.transact_write_calls) == 4


def _fact_transaction_calls(client: FakeDynamoClient) -> list[dict[str, object]]:
    return [
        call
        for call in client.transact_write_calls
        if any(
            "Put" in action
            and cast(dict[str, Any], action["Put"])["Item"].get("entityType") == {"S": "HOT_RECORD"}
            for action in cast(list[dict[str, object]], call["TransactItems"])
        )
    ]


def test_sink_keeps_large_fact_transactions_below_four_mib_and_completes_all_chunks() -> None:
    client = FakeDynamoClient()
    sink = DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0)
    records = tuple(record(str(index), dimension_blob="x" * 190_000) for index in range(22))

    item_size = serialized_item_bytes(
        serialize_item(encode_hot_record(records[0], "dsv_abc", "year=2026/month=09/day=01"))
    )
    result = sink.write(
        records,
        "dsv_abc",
        "year=2026/month=09/day=01",
        idempotency_key="large-byte-chunks",
    )

    transactions = _fact_transaction_calls(client)
    assert 190_000 < item_size < 200 * 1024
    assert item_size * 22 > 4 * 1024 * 1024
    assert len(transactions) >= 2
    assert result == WriteResult(written=22, unchanged=0)
    assert (
        sum(
            sum(
                "Put" in action
                and cast(dict[str, Any], action["Put"])["Item"].get("entityType")
                == {"S": "HOT_RECORD"}
                for action in cast(list[dict[str, object]], call["TransactItems"])
            )
            for call in transactions
        )
        == 22
    )
    assert all(
        len(json.dumps(call, sort_keys=True, separators=(",", ":")).encode("utf-8"))
        < 4 * 1024 * 1024
        for call in transactions
    )


def test_sink_writes_one_fact_close_to_the_internal_item_limit() -> None:
    client = FakeDynamoClient()
    sink = DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0)
    source = record(dimension_blob="x" * 198_000)
    item_size = serialized_item_bytes(
        serialize_item(encode_hot_record(source, "dsv_abc", "year=2026/month=09/day=01"))
    )

    result = sink.write(
        (source,),
        "dsv_abc",
        "year=2026/month=09/day=01",
        idempotency_key="near-item-limit",
    )

    assert 190 * 1024 < item_size < 200 * 1024
    assert result == WriteResult(written=1, unchanged=0)
    assert len(_fact_transaction_calls(client)) == 1


@pytest.mark.parametrize(
    "operation",
    ["batch_get_item", "query", "transact_write_items"],
    ids=["batch-get", "query", "transact-write"],
)
def test_sink_translates_exhausted_throttling_at_every_dynamodb_boundary(
    operation: str,
) -> None:
    class ThrottledClient(FakeDynamoClient):
        def _fail_if_selected(self, current: str) -> None:
            if operation == current:
                raise ClientError(
                    {"Error": {"Code": "ThrottlingException", "Message": "private"}},
                    current,
                )

        def batch_get_item(self, **kwargs: object) -> dict[str, object]:
            self._fail_if_selected("batch_get_item")
            return super().batch_get_item(**kwargs)

        def query(self, **kwargs: object) -> dict[str, object]:
            self._fail_if_selected("query")
            return super().query(**kwargs)

        def transact_write_items(self, **kwargs: object) -> dict[str, object]:
            self._fail_if_selected("transact_write_items")
            return super().transact_write_items(**kwargs)

    adapter = DynamoHotRecordSink(
        ThrottledClient(), "table", sleep=lambda _seconds: None, jitter=lambda: 0
    )

    with pytest.raises(DynamoDbThrottled) as failure:
        adapter.write(
            (record(),),
            "dsv_abc",
            "year=2026/month=09/day=01",
            idempotency_key=f"throttled-{operation}",
        )

    assert "private" not in str(failure.value)


@pytest.mark.parametrize(
    "operation",
    ["batch_get_item", "query", "transact_write_items"],
    ids=["batch-get", "query", "transact-write"],
)
def test_sink_does_not_translate_non_throttling_client_errors(operation: str) -> None:
    class FailedClient(FakeDynamoClient):
        def _fail_if_selected(self, current: str) -> None:
            if operation == current:
                raise ClientError(
                    {"Error": {"Code": "ValidationException", "Message": "specific"}},
                    current,
                )

        def batch_get_item(self, **kwargs: object) -> dict[str, object]:
            self._fail_if_selected("batch_get_item")
            return super().batch_get_item(**kwargs)

        def query(self, **kwargs: object) -> dict[str, object]:
            self._fail_if_selected("query")
            return super().query(**kwargs)

        def transact_write_items(self, **kwargs: object) -> dict[str, object]:
            self._fail_if_selected("transact_write_items")
            return super().transact_write_items(**kwargs)

    adapter = DynamoHotRecordSink(
        FailedClient(), "table", sleep=lambda _seconds: None, jitter=lambda: 0
    )

    with pytest.raises(ClientError) as failure:
        adapter.write(
            (record(),),
            "dsv_abc",
            "year=2026/month=09/day=01",
            idempotency_key=f"failed-{operation}",
        )

    assert failure.value.response["Error"]["Code"] == "ValidationException"


@pytest.mark.parametrize(
    ("error_response", "expected_error"),
    [
        (
            {
                "Error": {"Code": "TransactionCanceledException"},
                "CancellationReasons": [
                    {"Code": "None"},
                    {"Code": "ProvisionedThroughputExceeded"},
                ],
            },
            DynamoDbThrottled,
        ),
        ({"Error": {"Code": "TransactionCanceledException"}}, ClientError),
        (
            {
                "Error": {"Code": "TransactionCanceledException"},
                "CancellationReasons": [{"Code": "ConditionalCheckFailed"}],
            },
            ClientError,
        ),
        (
            {
                "Error": {"Code": "TransactionCanceledException"},
                "CancellationReasons": [
                    {"Code": "None"},
                    {"Code": "ConditionalCheckFailed"},
                ],
            },
            ClientError,
        ),
        ({"Error": {"Code": "TransactionConflictException"}}, ClientError),
        ({"Error": {"Code": "ProvisionedThroughputExceededException"}}, DynamoDbThrottled),
    ],
    ids=[
        "throttled-cancellation",
        "missing-reasons",
        "incomplete-reasons",
        "condition-at-wrong-position",
        "transaction-conflict",
        "direct-throttling",
    ],
)
def test_hotpart_summary_propagates_unproven_transaction_failures(
    error_response: dict[str, object],
    expected_error: type[Exception],
) -> None:
    class SummaryFailureClient(FakeDynamoClient):
        def transact_write_items(self, **kwargs: object) -> dict[str, object]:
            actions = cast(list[dict[str, object]], kwargs["TransactItems"])
            is_summary = any(
                "Put" in action
                and cast(dict[str, Any], action["Put"])["Item"].get("entityType")
                == {"S": "HOT_PARTITION"}
                for action in actions
            )
            if is_summary:
                raise ClientError(error_response, "TransactWriteItems")
            return super().transact_write_items(**kwargs)

    client = SummaryFailureClient()
    sink = DynamoHotRecordSink(client, "table", sleep=lambda _seconds: None, jitter=lambda: 0)

    with pytest.raises(expected_error) as captured:
        sink.write(
            (record(),),
            "dsv_abc",
            "year=2026/month=09/day=01",
            idempotency_key="summary-transient",
        )

    if isinstance(captured.value, ClientError):
        assert captured.value.response["Error"]["Code"] == error_response["Error"]["Code"]  # type: ignore[index]
    else:
        assert isinstance(captured.value, DynamoDbThrottled)
