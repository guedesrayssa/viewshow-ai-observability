"""Verify unprocessed DynamoDB items remain visible and recoverable."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any

import pytest

from adapters.dynamodb.client import DynamoControlProtocolError, DynamoDbThrottled
from adapters.dynamodb.hot_records import (
    DynamoHotRecordSink,
    DynamoProtocolError,
    UnprocessedKeysExhausted,
)
from domain.models import CanonicalRecord, RecordType
from ports import WriteResult


def record(index: int) -> CanonicalRecord:
    return CanonicalRecord(
        schema_version="1.0",
        record_type=RecordType.SIGNAL_OBSERVATION,
        source_system="argus",
        source_dataset="signal_bucket",
        natural_key=(("signal", str(index)),),
        observed_at=datetime(2026, 9, 1, tzinfo=UTC),
        window=None,
        dimensions={},
        measures={"value": index},
        quality={},
        quality_flags=(),
    )


class UnprocessedClient:
    """Shape-accurate low-level fake with configurable partial responses."""

    def __init__(self, *, get_failures: int = 0) -> None:
        self.get_failures = get_failures
        self.batch_get_calls: list[dict[str, object]] = []
        self.fact_get_calls: list[dict[str, object]] = []

    def batch_get_item(self, **kwargs: object) -> dict[str, object]:
        self.batch_get_calls.append(dict(kwargs))
        request_items = kwargs["RequestItems"]
        assert isinstance(request_items, Mapping)
        table_name, request = next(iter(request_items.items()))
        assert isinstance(request, Mapping)
        keys = request["Keys"]
        assert isinstance(keys, list)
        is_fact_read = any(
            isinstance(key, Mapping)
            and isinstance(key.get("pk"), Mapping)
            and str(key["pk"].get("S", "")).startswith("DATASET#dsv_abc#FACT#TS#")
            for key in keys
        )
        if is_fact_read:
            self.fact_get_calls.append(dict(kwargs))
        if is_fact_read and len(self.fact_get_calls) <= self.get_failures:
            unprocessed = {table_name: {"Keys": list(request["Keys"]), "ConsistentRead": True}}
        else:
            unprocessed = {}
        return {
            "Responses": {table_name: []},
            "UnprocessedKeys": unprocessed,
            "ResponseMetadata": {"HTTPStatusCode": 200},
        }

    def query(self, **_kwargs: object) -> dict[str, object]:
        return {"Items": [], "Count": 0, "ResponseMetadata": {"HTTPStatusCode": 200}}

    def transact_write_items(self, **_kwargs: object) -> dict[str, object]:
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}


def sink(client: UnprocessedClient | ProtocolClient, sleeps: list[float]) -> DynamoHotRecordSink:
    return DynamoHotRecordSink(
        client,
        "table",
        max_attempts=8,
        sleep=sleeps.append,
        jitter=lambda: 0.25,
        base_backoff_seconds=1.0,
    )


def test_unprocessed_keys_are_retried_with_injected_backoff_then_succeed() -> None:
    client = UnprocessedClient(get_failures=2)
    sleeps: list[float] = []

    result = sink(client, sleeps).write(
        (record(1),),
        "dsv_abc",
        "year=2026/month=09/day=01",
        idempotency_key="get-retry",
    )

    assert result.written == 1
    assert len(client.fact_get_calls) == 3
    assert sleeps[:2] == [1.25, 2.25]


def test_unprocessed_keys_exhaust_after_exactly_eight_attempts() -> None:
    client = UnprocessedClient(get_failures=99)
    sleeps: list[float] = []

    with pytest.raises(UnprocessedKeysExhausted) as failure:
        sink(client, sleeps).write(
            (record(1),),
            "dsv_abc",
            "year=2026/month=09/day=01",
            idempotency_key="get-exhausted",
        )

    assert isinstance(failure.value, DynamoDbThrottled)
    assert len(client.fact_get_calls) == 8
    assert len(sleeps) == 7


type ResponseFactory = Callable[[dict[str, object]], dict[str, object]]


class ProtocolClient:
    """Low-level fake that can inject one malformed read or write response."""

    def __init__(
        self,
        *,
        get_factory: ResponseFactory | None = None,
        transaction_factory: ResponseFactory | None = None,
    ) -> None:
        self.get_factory = get_factory
        self.transaction_factory = transaction_factory

    def batch_get_item(self, **kwargs: object) -> dict[str, object]:
        request = dict(kwargs)
        if self.get_factory is not None:
            factory, self.get_factory = self.get_factory, None
            return factory(request)
        return {
            "Responses": {"table": []},
            "UnprocessedKeys": {},
            "ResponseMetadata": {"HTTPStatusCode": 200},
        }

    def query(self, **_kwargs: object) -> dict[str, object]:
        return {"Items": [], "Count": 0, "ResponseMetadata": {"HTTPStatusCode": 200}}

    def transact_write_items(self, **kwargs: object) -> dict[str, object]:
        if self.transaction_factory is not None:
            factory, self.transaction_factory = self.transaction_factory, None
            return factory(dict(kwargs))
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}


def _requested_get_keys(request: dict[str, object]) -> list[dict[str, dict[str, Any]]]:
    return request["RequestItems"]["table"]["Keys"]  # type: ignore[index,no-any-return]


@pytest.mark.parametrize(
    "factory",
    [
        lambda _request: {"Responses": {"unexpected": []}, "UnprocessedKeys": {}},
        lambda request: {
            "Responses": {"table": []},
            "UnprocessedKeys": {
                "unexpected": {"Keys": _requested_get_keys(request), "ConsistentRead": True}
            },
        },
        lambda _request: {
            "Responses": {
                "table": [
                    {
                        "pk": {"S": "not-requested"},
                        "sk": {"S": "not-requested"},
                        "payloadHash": {"S": "ph_invalid"},
                    }
                ]
            },
            "UnprocessedKeys": {},
        },
        lambda request: {
            "Responses": {
                "table": [
                    {
                        **_requested_get_keys(request)[0],
                        "payloadHash": {"N": "not-a-number"},
                    }
                ]
            },
            "UnprocessedKeys": {},
        },
        lambda _request: {
            "Responses": {"table": []},
            "UnprocessedKeys": {
                "table": {
                    "Keys": [{"pk": {"S": "other"}, "sk": {"S": "other"}}],
                    "ConsistentRead": True,
                }
            },
        },
        lambda _request: {
            "Responses": {"table": []},
            "UnprocessedKeys": {"table": []},
        },
    ],
    ids=[
        "responses-unexpected-table",
        "unprocessed-keys-unexpected-table",
        "response-item-not-requested",
        "response-invalid-attribute-value",
        "unprocessed-key-not-requested",
        "unprocessed-keys-invalid-shape",
    ],
)
def test_malformed_batch_get_response_fails_without_reserving_idempotency(
    factory: ResponseFactory,
) -> None:
    client = ProtocolClient(get_factory=factory)
    adapter = sink(client, [])

    with pytest.raises(DynamoProtocolError):
        adapter.write(
            (record(1),),
            "dsv_abc",
            "year=2026/month=09/day=01",
            idempotency_key="protocol-read",
        )

    assert adapter.write(
        (record(1),),
        "dsv_abc",
        "year=2026/month=09/day=01",
        idempotency_key="protocol-read",
    ) == WriteResult(written=1, unchanged=0)


@pytest.mark.parametrize(
    "factory",
    [
        lambda _request: {},
        lambda _request: {"ResponseMetadata": {"HTTPStatusCode": 500}},
        lambda _request: {
            "ResponseMetadata": {"HTTPStatusCode": 200},
            "unexpected": "field",
        },
    ],
    ids=["missing-metadata", "bad-status", "unexpected-field"],
)
def test_malformed_transaction_response_fails_without_reserving_idempotency(
    factory: ResponseFactory,
) -> None:
    client = ProtocolClient(transaction_factory=factory)
    adapter = sink(client, [])

    with pytest.raises(DynamoControlProtocolError):
        adapter.write(
            (record(1),),
            "dsv_abc",
            "year=2026/month=09/day=01",
            idempotency_key="protocol-write",
        )

    assert adapter.write(
        (record(1),),
        "dsv_abc",
        "year=2026/month=09/day=01",
        idempotency_key="protocol-write",
    ) == WriteResult(written=1, unchanged=0)
