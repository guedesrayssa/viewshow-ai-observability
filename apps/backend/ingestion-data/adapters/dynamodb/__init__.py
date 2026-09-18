"""Expõe as implementações DynamoDB usadas pelas portas da aplicação.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from adapters.dynamodb.archive_partitions import (
    DynamoArchivePartitionRepository,
    DynamoHotExpirationRepository,
    encode_projection_partition_catalog,
    encode_projection_target_set_catalog,
)
from adapters.dynamodb.control import DynamoControlProtocolError, DynamoControlRepository
from adapters.dynamodb.hot_records import (
    DynamoHotRecordSink,
    DynamoProtocolError,
    UnprocessedKeysExhausted,
)
from adapters.dynamodb.incremental_batches import DynamoIncrementalBatchRepository
from adapters.dynamodb.live_sync import DynamoLiveSyncConfiguration
from adapters.dynamodb.manifests import DynamoManifestRepository
from adapters.dynamodb.projections import DynamoProjectionRepository

__all__ = [
    "DynamoArchivePartitionRepository",
    "DynamoControlProtocolError",
    "DynamoControlRepository",
    "DynamoHotRecordSink",
    "DynamoHotExpirationRepository",
    "DynamoLiveSyncConfiguration",
    "DynamoIncrementalBatchRepository",
    "DynamoManifestRepository",
    "DynamoProtocolError",
    "DynamoProjectionRepository",
    "UnprocessedKeysExhausted",
    "encode_projection_partition_catalog",
    "encode_projection_target_set_catalog",
]
