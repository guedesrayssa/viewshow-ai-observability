"""Verify conditional DynamoDB control-state persistence for runs and leases."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from adapters.dynamodb.client import DynamoDbThrottled
from adapters.dynamodb.control import DynamoControlProtocolError, DynamoControlRepository
from ports import StaleCheckpoint


class RecordingClient:
    def __init__(self) -> None:
        self.get_calls: list[dict[str, object]] = []
        self.transaction_calls: list[dict[str, object]] = []

    def get_item(self, **kwargs: object) -> Mapping[str, object]:
        self.get_calls.append(dict(kwargs))
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}

    def transact_write_items(self, **kwargs: object) -> Mapping[str, object]:
        self.transaction_calls.append(dict(kwargs))
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}


class CancelingClient(RecordingClient):
    def __init__(self, reasons: object = None, *, include_reasons: bool = True) -> None:
        super().__init__()
        response: dict[str, object] = {
            "Error": {"Code": "TransactionCanceledException", "Message": "cancelled"}
        }
        if include_reasons:
            response["CancellationReasons"] = reasons
        self.failure = ClientError(response, "TransactWriteItems")

    def transact_write_items(self, **kwargs: object) -> Mapping[str, object]:
        self.transaction_calls.append(dict(kwargs))
        raise self.failure


NOW = datetime(2026, 9, 8, 12, 0, tzinfo=UTC)


def test_run_progress_reads_state_and_cumulative_counts_from_one_consistent_item():
    from boto3.dynamodb.types import TypeSerializer

    item = {
        "pk": "INGESTION#RUN#run-import",
        "sk": "META",
        "runId": "run-import",
        "datasetVersion": "dsv-test",
        "stage": "PROJECTING",
        "transitionCount": 4,
        "errorCount": 0,
        "totalDurationMs": 20,
        "recordsRead": 23,
        "recordsWritten": 21,
        "recordsRejected": 2,
        "createdAt": "2026-09-08T11:00:00Z",
        "updatedAt": "2026-09-08T12:00:00Z",
    }
    client = RecordingClient()

    def get_item(**kwargs):
        client.get_calls.append(kwargs)
        return {"Item": {key: TypeSerializer().serialize(value) for key, value in item.items()}}

    client.get_item = get_item
    progress = DynamoControlRepository(client, "hot").get_run_progress("run-import")
    assert progress.state.stage.value == "PROJECTING"
    assert (progress.records_read, progress.records_written, progress.records_rejected) == (
        23,
        21,
        2,
    )
    assert progress.updated_at == NOW
    assert len(client.get_calls) == 1 and client.get_calls[0]["ConsistentRead"] is True
    assert client.transaction_calls == []


def test_checkpoint_uses_consistent_reads_and_a_conditional_transaction() -> None:
    client = RecordingClient()
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)

    result = repository.advance(
        "dsv_a",
        "signal_bucket",
        (2000, "a"),
        expected_cursor=None,
        idempotency_key="checkpoint-1",
    )

    assert result == (2000, "a")
    assert client.get_calls
    assert all(call["ConsistentRead"] is True for call in client.get_calls)
    transaction = client.transaction_calls[0]["TransactItems"]
    assert isinstance(transaction, list)
    assert len(transaction) == 2
    checkpoint_put = transaction[0]["Put"]
    assert checkpoint_put["ConditionExpression"] == "attribute_not_exists(pk)"
    assert all("Scan" not in repr(call) for call in client.transaction_calls)


@pytest.mark.parametrize(
    "cursor",
    [(), (None,), (True,), (float("nan"),), (float("inf"),), ([1],), ({"a": 1},)],
)
def test_invalid_cursor_is_rejected_before_dynamodb(cursor: tuple[object, ...]) -> None:
    client = RecordingClient()
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)

    with pytest.raises((TypeError, ValueError)):
        repository.advance(
            "dsv_a",
            "signal_bucket",
            cursor,
            expected_cursor=None,
            idempotency_key="checkpoint-invalid",
        )

    assert client.get_calls == []
    assert client.transaction_calls == []


def test_supported_cursor_types_round_trip_without_losing_type() -> None:
    from boto3.dynamodb.types import TypeSerializer  # type: ignore[import-untyped]

    serializer = TypeSerializer()
    cursor = (
        -10,
        1.25,
        Decimal("10.500"),
        "ação",
        datetime(2026, 9, 8, 12, 0, 0, 123456, tzinfo=UTC),
    )
    canonical = DynamoControlRepository.serialize_cursor(cursor)
    client = RecordingClient()
    client.get_item = lambda **_kwargs: {
        "Item": {
            "pk": serializer.serialize("DATASET#dsv_a#INGESTION#SOURCE#signal_bucket"),
            "sk": serializer.serialize("CHECKPOINT"),
            "cursorCanonical": serializer.serialize(canonical),
        }
    }
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)

    assert repository.get("dsv_a", "signal_bucket") == cursor
    assert DynamoControlRepository.serialize_cursor(cursor) == canonical


def test_malformed_dynamodb_item_fails_closed_without_echoing_payload() -> None:
    secret_payload = "super-secret-source-row"
    client = RecordingClient()
    client.get_item = lambda **_kwargs: {"Item": {"pk": {"S": secret_payload}, "sk": {"X": 1}}}
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)

    with pytest.raises(DynamoControlProtocolError) as captured:
        repository.get("dsv_a", "signal_bucket")

    assert secret_payload not in str(captured.value)


def test_checkpoint_rejects_mixed_type_ordering_before_writing() -> None:
    from boto3.dynamodb.types import TypeSerializer  # type: ignore[import-untyped]

    serializer = TypeSerializer()
    current = DynamoControlRepository.serialize_cursor((1, "a"))
    client = RecordingClient()

    def get_item(**kwargs: object) -> Mapping[str, object]:
        key = kwargs["Key"]
        assert isinstance(key, Mapping)
        if key["sk"] == {"S": "CHECKPOINT"}:
            return {
                "Item": {
                    "pk": serializer.serialize("DATASET#dsv_a#INGESTION#SOURCE#signal_bucket"),
                    "sk": serializer.serialize("CHECKPOINT"),
                    "cursorCanonical": serializer.serialize(current),
                }
            }
        return {}

    client.get_item = get_item
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)

    with pytest.raises(TypeError, match="cursor type"):
        repository.advance(
            "dsv_a",
            "signal_bucket",
            ("2", "a"),
            expected_cursor=(1, "a"),
            idempotency_key="checkpoint-type-mismatch",
        )

    assert client.transaction_calls == []


def test_checkpoint_rejects_non_monotonic_value_before_writing() -> None:
    from boto3.dynamodb.types import TypeSerializer  # type: ignore[import-untyped]

    serializer = TypeSerializer()
    current = DynamoControlRepository.serialize_cursor((2000, "a"))
    client = RecordingClient()

    def get_item(**kwargs: object) -> Mapping[str, object]:
        key = kwargs["Key"]
        assert isinstance(key, Mapping)
        if key["sk"] == {"S": "CHECKPOINT"}:
            return {
                "Item": {
                    "pk": serializer.serialize("DATASET#dsv_a#INGESTION#SOURCE#signal_bucket"),
                    "sk": serializer.serialize("CHECKPOINT"),
                    "cursorCanonical": serializer.serialize(current),
                }
            }
        return {}

    client.get_item = get_item
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)

    with pytest.raises(StaleCheckpoint, match="monotonic"):
        repository.advance(
            "dsv_a",
            "signal_bucket",
            (1000, "a"),
            expected_cursor=(2000, "a"),
            idempotency_key="checkpoint-backward",
        )

    assert client.transaction_calls == []


def _client_with_checkpoint(cursor: tuple[object, ...]) -> RecordingClient:
    from boto3.dynamodb.types import TypeSerializer  # type: ignore[import-untyped]

    serializer = TypeSerializer()
    canonical = DynamoControlRepository.serialize_cursor(cursor)
    client = RecordingClient()

    def get_item(**kwargs: object) -> Mapping[str, object]:
        key = kwargs["Key"]
        assert isinstance(key, Mapping)
        if key["sk"] == {"S": "CHECKPOINT"}:
            return {
                "Item": {
                    "pk": serializer.serialize("DATASET#dsv_a#INGESTION#SOURCE#signal_bucket"),
                    "sk": serializer.serialize("CHECKPOINT"),
                    "cursorCanonical": serializer.serialize(canonical),
                }
            }
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}

    client.get_item = get_item
    return client


def test_float_decimal_comparison_uses_the_exact_binary_float_value() -> None:
    current = (Decimal("0.1000000000000000001"),)
    client = _client_with_checkpoint(current)
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)

    assert repository.advance(
        "dsv_a",
        "signal_bucket",
        (0.1,),
        expected_cursor=current,
        idempotency_key="float-forward",
    ) == (0.1,)


def test_decimal_below_exact_float_is_rejected_as_backward() -> None:
    current = (0.1,)
    client = _client_with_checkpoint(current)
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)

    with pytest.raises(StaleCheckpoint, match="monotonic"):
        repository.advance(
            "dsv_a",
            "signal_bucket",
            (Decimal("0.1000000000000000001"),),
            expected_cursor=current,
            idempotency_key="decimal-backward",
        )

    assert client.transaction_calls == []


def test_cursor_comparison_rejects_prefix_shapes_and_orders_large_integers_exactly() -> None:
    prefix_client = _client_with_checkpoint((1,))
    prefix_repository = DynamoControlRepository(prefix_client, "hot", clock=lambda: NOW)
    with pytest.raises(TypeError, match="shape"):
        prefix_repository.advance(
            "dsv_a",
            "signal_bucket",
            (1, 0),
            expected_cursor=(1,),
            idempotency_key="prefix",
        )

    large_client = _client_with_checkpoint((float(2**53),))
    large_repository = DynamoControlRepository(large_client, "hot", clock=lambda: NOW)
    assert large_repository.advance(
        "dsv_a",
        "signal_bucket",
        (2**53 + 1,),
        expected_cursor=(float(2**53),),
        idempotency_key="large-integer",
    ) == (2**53 + 1,)


@pytest.mark.parametrize(
    "reasons",
    [
        [{"Code": "ConditionalCheckFailed"}],
        [{"Code": "None"}, {"Code": "ConditionalCheckFailed"}],
        "malformed",
    ],
)
def test_non_domain_transaction_cancellations_propagate_client_error(reasons: object) -> None:
    client = CancelingClient(reasons)
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)

    with pytest.raises(ClientError) as captured:
        repository.advance(
            "dsv_a",
            "signal_bucket",
            (1, "a"),
            expected_cursor=None,
            idempotency_key="cancelled-checkpoint",
        )

    assert captured.value is client.failure


@pytest.mark.parametrize(
    "reason",
    ["TransactionConflict", "ProvisionedThroughputExceeded", "ThrottlingError"],
)
def test_control_translates_exhausted_transaction_throttling(reason: str) -> None:
    repository = DynamoControlRepository(
        CancelingClient([{"Code": reason}, {"Code": "None"}]),
        "hot",
        clock=lambda: NOW,
    )

    with pytest.raises(DynamoDbThrottled):
        repository.advance(
            "dsv_a",
            "signal_bucket",
            (1, "a"),
            expected_cursor=None,
            idempotency_key="throttled-checkpoint",
        )


def test_transaction_cancellation_without_reasons_fails_closed() -> None:
    client = CancelingClient(include_reasons=False)
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)

    with pytest.raises(ClientError) as captured:
        repository.advance(
            "dsv_a",
            "signal_bucket",
            (1, "a"),
            expected_cursor=None,
            idempotency_key="cancelled-checkpoint",
        )

    assert captured.value is client.failure


def test_expected_effect_condition_is_translated_to_domain_error() -> None:
    client = CancelingClient(
        [{"Code": "ConditionalCheckFailed", "Message": "condition"}, {"Code": "None"}]
    )
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)

    with pytest.raises(StaleCheckpoint, match="concurrently"):
        repository.advance(
            "dsv_a",
            "signal_bucket",
            (1, "a"),
            expected_cursor=None,
            idempotency_key="cancelled-checkpoint",
        )


@pytest.mark.parametrize(
    "response",
    [
        {},
        {"unrelated": True},
        {"ResponseMetadata": {}},
        {"ResponseMetadata": {"HTTPStatusCode": 500}},
        {"ResponseMetadata": {"HTTPStatusCode": True}},
    ],
)
def test_malformed_successful_transaction_response_fails_closed(
    response: Mapping[str, object],
) -> None:
    client = RecordingClient()
    client.transact_write_items = lambda **_kwargs: response
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)

    with pytest.raises(DynamoControlProtocolError, match="transaction response"):
        repository.advance(
            "dsv_a",
            "signal_bucket",
            (1, "a"),
            expected_cursor=None,
            idempotency_key="malformed-success",
        )
