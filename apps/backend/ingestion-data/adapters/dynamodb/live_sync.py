"""Lê a configuração dinâmica de sincronização ao vivo no DynamoDB."""

from __future__ import annotations

from adapters.dynamodb.client import (
    DynamoControlClient,
    DynamoControlProtocolError,
    decode_get_item,
)
from ports import LiveSyncConfiguration

_PARTITION_KEY = "CONTROL#ARGUS"
_SORT_KEY = "LIVE_SYNC"
_INVALID_CONFIGURATION = "DynamoDB live sync configuration is invalid"


class DynamoLiveSyncConfiguration(LiveSyncConfiguration):
    """Obtém o interruptor de sincronização ao vivo do item singleton de controle."""

    def __init__(self, client: DynamoControlClient, table_name: str) -> None:
        if not isinstance(table_name, str):
            raise TypeError("table_name must be a string")
        if not table_name:
            raise ValueError("table_name must not be empty")
        self._client = client
        self._table_name = table_name

    def is_enabled(self) -> bool:
        try:
            response = self._client.get_item(
                TableName=self._table_name,
                Key={"pk": {"S": _PARTITION_KEY}, "sk": {"S": _SORT_KEY}},
                ConsistentRead=True,
            )
            item = decode_get_item(response)
        except Exception as error:
            raise DynamoControlProtocolError(_INVALID_CONFIGURATION) from error
        if item is None:
            return False
        enabled = item.get("enabled")
        if (
            set(item) != {"pk", "sk", "enabled"}
            or item.get("pk") != _PARTITION_KEY
            or item.get("sk") != _SORT_KEY
            or type(enabled) is not bool
        ):
            raise DynamoControlProtocolError(_INVALID_CONFIGURATION)
        return enabled


__all__ = ["DynamoLiveSyncConfiguration"]
