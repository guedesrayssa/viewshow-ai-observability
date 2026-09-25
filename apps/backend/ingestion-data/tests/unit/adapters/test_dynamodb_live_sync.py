"""Verify DynamoDB-backed live-sync configuration reads."""

from __future__ import annotations

from collections.abc import Mapping

import pytest
from boto3.dynamodb.types import TypeSerializer  # type: ignore[import-untyped]

import adapters.dynamodb as dynamodb


class RecordingClient:
    def __init__(self, response: Mapping[str, object]) -> None:
        self._response = response
        self.calls: list[dict[str, object]] = []

    def get_item(self, **kwargs: object) -> Mapping[str, object]:
        self.calls.append(dict(kwargs))
        return self._response


class FailingClient:
    def get_item(self, **kwargs: object) -> Mapping[str, object]:
        raise RuntimeError("super-secret-dynamodb-endpoint")


def _serialized_live_sync_item(**fields: object) -> dict[str, object]:
    serializer = TypeSerializer()
    return {field: serializer.serialize(value) for field, value in fields.items()}


def test_missing_live_sync_item_is_disabled() -> None:
    client = RecordingClient({"ResponseMetadata": {"HTTPStatusCode": 200}})
    configuration = dynamodb.DynamoLiveSyncConfiguration(client, "view-show-operacional")

    assert configuration.is_enabled() is False
    assert client.calls == [
        {
            "TableName": "view-show-operacional",
            "Key": {"pk": {"S": "CONTROL#ARGUS"}, "sk": {"S": "LIVE_SYNC"}},
            "ConsistentRead": True,
        }
    ]


@pytest.mark.parametrize("enabled", [True, False])
def test_reads_a_strict_boolean(enabled: bool) -> None:
    serializer = TypeSerializer()
    client = RecordingClient(
        {
            "Item": {
                "pk": serializer.serialize("CONTROL#ARGUS"),
                "sk": serializer.serialize("LIVE_SYNC"),
                "enabled": serializer.serialize(enabled),
            }
        }
    )

    assert dynamodb.DynamoLiveSyncConfiguration(client, "table").is_enabled() is enabled


def test_rejects_malformed_live_sync_item() -> None:
    serializer = TypeSerializer()
    client = RecordingClient(
        {
            "Item": {
                "pk": serializer.serialize("CONTROL#ARGUS"),
                "sk": serializer.serialize("LIVE_SYNC"),
                "enabled": serializer.serialize("true"),
            }
        }
    )

    with pytest.raises(dynamodb.DynamoControlProtocolError, match="live sync configuration"):
        dynamodb.DynamoLiveSyncConfiguration(client, "table").is_enabled()


@pytest.mark.parametrize(
    "item",
    [
        _serialized_live_sync_item(
            pk="CONTROL#ARGUS", sk="LIVE_SYNC", enabled=True, unexpected="extra"
        ),
        _serialized_live_sync_item(pk="CONTROL#ARGUS", sk="LIVE_SYNC"),
        _serialized_live_sync_item(sk="LIVE_SYNC", enabled=True),
        _serialized_live_sync_item(pk="CONTROL#ARGUS", enabled=True),
        _serialized_live_sync_item(pk="CONTROL#OTHER", sk="LIVE_SYNC", enabled=True),
        _serialized_live_sync_item(pk="CONTROL#ARGUS", sk="OTHER", enabled=True),
    ],
)
def test_rejects_live_sync_items_without_the_exact_singleton_shape(
    item: Mapping[str, object],
) -> None:
    client = RecordingClient({"Item": item})

    with pytest.raises(dynamodb.DynamoControlProtocolError, match="live sync configuration"):
        dynamodb.DynamoLiveSyncConfiguration(client, "table").is_enabled()


def test_sanitizes_dynamodb_get_item_failure() -> None:
    with pytest.raises(dynamodb.DynamoControlProtocolError) as captured:
        dynamodb.DynamoLiveSyncConfiguration(FailingClient(), "table").is_enabled()

    assert str(captured.value) == "DynamoDB live sync configuration is invalid"
    assert "super-secret-dynamodb-endpoint" not in str(captured.value)
