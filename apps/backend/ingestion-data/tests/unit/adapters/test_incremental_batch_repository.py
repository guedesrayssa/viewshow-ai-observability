"""Verify conditional, idempotent persistence of incremental batch state."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from boto3.dynamodb.types import TypeDeserializer
from botocore.exceptions import ClientError

from domain.incremental_batches import (
    BatchState,
    IncrementalBatchManifest,
    IncrementalBatchReference,
    PhysicalColumn,
    incremental_batch_id,
)
from domain.models import TimeWindow
from ports import ConditionalWriteError, IdempotencyConflict

DESERIALIZER = TypeDeserializer()
WINDOW = TimeWindow(
    datetime(2026, 9, 17, 10, tzinfo=UTC),
    datetime(2026, 9, 17, 10, 15, tzinfo=UTC),
    900,
)
BATCH_ID = incremental_batch_id("ARGUS", "signal_bucket", WINDOW, 0, "1.0")
MANIFEST_KEY = (
    "raw/argus/incremental/dataset=signal_bucket/"
    "window_start=20260917T100000000Z/"
    f"batch_id={BATCH_ID}/manifest.json"
)


def decode(item: Mapping[str, object]) -> dict[str, object]:
    return {
        name: DESERIALIZER.deserialize(value)  # type: ignore[arg-type]
        for name, value in item.items()
    }


class MemoryDynamoClient:
    def __init__(self) -> None:
        self.item: dict[str, object] | None = None
        self.puts: list[dict[str, object]] = []
        self.gets: list[dict[str, object]] = []
        self.updates: list[dict[str, object]] = []

    def put_item(self, **kwargs: object) -> dict[str, object]:
        self.puts.append(dict(kwargs))
        if self.item is not None:
            raise ClientError(
                {
                    "Error": {
                        "Code": "ConditionalCheckFailedException",
                        "Message": "exists",
                    }
                },
                "PutItem",
            )
        raw = kwargs["Item"]
        assert isinstance(raw, Mapping)
        self.item = decode(raw)
        return {}

    def get_item(self, **kwargs: object) -> dict[str, object]:
        self.gets.append(dict(kwargs))
        if self.item is None:
            return {}
        from boto3.dynamodb.types import TypeSerializer

        serializer = TypeSerializer()
        return {"Item": {name: serializer.serialize(value) for name, value in self.item.items()}}

    def update_item(self, **kwargs: object) -> dict[str, object]:
        self.updates.append(dict(kwargs))
        assert self.item is not None
        raw_values = kwargs["ExpressionAttributeValues"]
        assert isinstance(raw_values, Mapping)
        values = decode(raw_values)
        if (
            self.item["state"] != values[":expectedState"]
            or self.item["version"] != values[":expectedVersion"]
        ):
            raise ClientError(
                {
                    "Error": {
                        "Code": "ConditionalCheckFailedException",
                        "Message": "conflict",
                    }
                },
                "UpdateItem",
            )
        self.item["state"] = values[":nextState"]
        self.item["version"] = values[":nextVersion"]
        self.item["updatedAt"] = values[":updatedAt"]
        if ":counts" in values:
            self.item["counts"] = values[":counts"]
        if ":errorCode" in values:
            self.item["errorCode"] = values[":errorCode"]
        from boto3.dynamodb.types import TypeSerializer

        serializer = TypeSerializer()
        return {
            "Attributes": {name: serializer.serialize(value) for name, value in self.item.items()}
        }


def manifest(*, data_sha256: str = "a" * 64) -> IncrementalBatchManifest:
    return IncrementalBatchManifest(
        batch_id=BATCH_ID,
        source_system="ARGUS",
        source_dataset="signal_bucket",
        window=WINDOW,
        revision=0,
        data_key=MANIFEST_KEY.removesuffix("manifest.json") + "data.parquet",
        data_version_id="data-version-1",
        data_size_bytes=123,
        data_sha256=data_sha256,
        schema_fingerprint="b" * 64,
        columns=(PhysicalColumn("sinal", "VARCHAR(64)", False, 1),),
        extra_columns=(),
        row_count=1,
        exporter_version="1.0",
    )


def reference(*, version_id: str = "manifest-version-1") -> IncrementalBatchReference:
    return IncrementalBatchReference("bucket-name", MANIFEST_KEY, version_id)


def repository(client: MemoryDynamoClient):
    try:
        from adapters.dynamodb.incremental_batches import DynamoIncrementalBatchRepository
    except ModuleNotFoundError:
        pytest.fail("The incremental batch DynamoDB repository is missing")
    return DynamoIncrementalBatchRepository(
        client,
        "control-table",
        clock=lambda: datetime(2026, 9, 17, 10, 16, tzinfo=UTC),
    )


def test_claim_is_idempotent_and_rejects_conflicting_manifest() -> None:
    client = MemoryDynamoClient()
    adapter = repository(client)

    claimed = adapter.claim(manifest(), reference())
    replay = adapter.claim(manifest(), reference())

    assert claimed.batch_id == replay.batch_id == BATCH_ID
    assert replay.state is BatchState.RECEIVED
    assert client.gets[-1]["ConsistentRead"] is True
    with pytest.raises(IdempotencyConflict):
        adapter.claim(manifest(data_sha256="c" * 64), reference())
    with pytest.raises(IdempotencyConflict):
        adapter.claim(manifest(), reference(version_id="other-version"))


def test_claim_persists_only_safe_batch_control_metadata() -> None:
    client = MemoryDynamoClient()

    repository(client).claim(manifest(), reference())

    assert client.item is not None
    assert client.item["pk"] == f"BATCH#{BATCH_ID}"
    assert client.item["sk"] == "META"
    assert set(client.item) == {
        "pk",
        "sk",
        "batchId",
        "manifestSha256",
        "reference",
        "state",
        "version",
        "createdAt",
        "updatedAt",
    }
    assert "rows" not in client.item
    assert client.puts[0]["ConditionExpression"] == "attribute_not_exists(pk)"


def test_transition_requires_expected_state_and_version() -> None:
    client = MemoryDynamoClient()
    adapter = repository(client)
    current = adapter.claim(manifest(), reference())

    validating = adapter.transition(
        BATCH_ID,
        BatchState.RECEIVED,
        current.version,
        BatchState.VALIDATING,
    )

    assert validating.version == current.version + 1
    assert validating.state is BatchState.VALIDATING
    with pytest.raises(ConditionalWriteError):
        adapter.transition(
            BATCH_ID,
            BatchState.RECEIVED,
            current.version,
            BatchState.VALIDATING,
        )
    command = client.updates[0]
    assert "#state = :expectedState" in command["ConditionExpression"]
    assert "#version = :expectedVersion" in command["ConditionExpression"]


def test_completed_duplicate_and_retryable_claim_remain_distinguishable() -> None:
    client = MemoryDynamoClient()
    adapter = repository(client)
    current = adapter.claim(manifest(), reference())
    validating = adapter.transition(
        BATCH_ID,
        BatchState.RECEIVED,
        current.version,
        BatchState.VALIDATING,
    )
    retryable = adapter.transition(
        BATCH_ID,
        BatchState.VALIDATING,
        validating.version,
        BatchState.RETRYABLE_FAILED,
    )
    assert adapter.claim(manifest(), reference()).state is BatchState.RETRYABLE_FAILED
    validating_again = adapter.transition(
        BATCH_ID,
        BatchState.RETRYABLE_FAILED,
        retryable.version,
        BatchState.VALIDATING,
    )
    ingesting = adapter.transition(
        BATCH_ID,
        BatchState.VALIDATING,
        validating_again.version,
        BatchState.INGESTING,
    )
    committing = adapter.transition(
        BATCH_ID,
        BatchState.INGESTING,
        ingesting.version,
        BatchState.COMMITTING,
    )
    completed = adapter.finish(
        BATCH_ID,
        BatchState.COMMITTING,
        committing.version,
        BatchState.COMPLETED,
        counts={"written": 1, "unchanged": 0},
    )
    assert completed.state is BatchState.COMPLETED
    assert adapter.claim(manifest(), reference()).state is BatchState.COMPLETED


@pytest.mark.parametrize(
    ("expected_state", "next_state"),
    [
        (BatchState.RECEIVED, BatchState.INGESTING),
        (BatchState.VALIDATING, BatchState.RECEIVED),
        (BatchState.VALIDATING, BatchState.VALIDATING),
        (BatchState.INGESTING, BatchState.VALIDATING),
        (BatchState.COMMITTING, BatchState.INGESTING),
        (BatchState.RETRYABLE_FAILED, BatchState.INGESTING),
    ],
)
def test_transition_rejects_skips_regressions_and_self_transitions(
    expected_state: BatchState,
    next_state: BatchState,
) -> None:
    client = MemoryDynamoClient()
    adapter = repository(client)
    current = adapter.claim(manifest(), reference())
    updates_before = len(client.updates)

    with pytest.raises(ValueError, match="transition"):
        adapter.transition(BATCH_ID, expected_state, current.version, next_state)

    assert len(client.updates) == updates_before


def test_completed_requires_committing_and_cannot_be_finished_twice() -> None:
    client = MemoryDynamoClient()
    adapter = repository(client)
    received = adapter.claim(manifest(), reference())
    validating = adapter.transition(
        BATCH_ID, BatchState.RECEIVED, received.version, BatchState.VALIDATING
    )
    ingesting = adapter.transition(
        BATCH_ID, BatchState.VALIDATING, validating.version, BatchState.INGESTING
    )
    with pytest.raises(ValueError, match="COMMITTING"):
        adapter.finish(
            BATCH_ID,
            BatchState.INGESTING,
            ingesting.version,
            BatchState.COMPLETED,
            counts={"written": 1},
        )
    committing = adapter.transition(
        BATCH_ID, BatchState.INGESTING, ingesting.version, BatchState.COMMITTING
    )
    completed = adapter.finish(
        BATCH_ID,
        BatchState.COMMITTING,
        committing.version,
        BatchState.COMPLETED,
        counts={"written": 1},
    )
    updates_before = len(client.updates)

    with pytest.raises(ValueError, match="terminal|transition"):
        adapter.finish(
            BATCH_ID,
            BatchState.COMPLETED,
            completed.version,
            BatchState.COMPLETED,
            counts={"written": 2},
        )

    assert len(client.updates) == updates_before


def test_finish_allows_only_terminal_states_and_validates_safe_metadata() -> None:
    client = MemoryDynamoClient()
    adapter = repository(client)
    current = adapter.claim(manifest(), reference())

    with pytest.raises(ValueError, match="COMPLETED|QUARANTINED"):
        adapter.finish(
            BATCH_ID,
            BatchState.RECEIVED,
            current.version,
            BatchState.INGESTING,
            counts={},
        )
    validating = adapter.transition(
        BATCH_ID,
        BatchState.RECEIVED,
        current.version,
        BatchState.VALIDATING,
    )
    with pytest.raises(ValueError, match="error_code"):
        adapter.finish(
            BATCH_ID,
            BatchState.VALIDATING,
            validating.version,
            BatchState.QUARANTINED,
            counts={},
            error_code="unsafe secret/value",
        )
    ingesting = adapter.transition(
        BATCH_ID,
        BatchState.VALIDATING,
        validating.version,
        BatchState.INGESTING,
    )
    committing = adapter.transition(
        BATCH_ID,
        BatchState.INGESTING,
        ingesting.version,
        BatchState.COMMITTING,
    )
    with pytest.raises(ValueError, match="counts"):
        adapter.finish(
            BATCH_ID,
            BatchState.COMMITTING,
            committing.version,
            BatchState.COMPLETED,
            counts={"written": -1},
        )
    assert client.item is not None and client.item["version"] == Decimal(3)
