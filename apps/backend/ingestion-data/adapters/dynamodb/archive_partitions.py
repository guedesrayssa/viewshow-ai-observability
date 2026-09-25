"""Persiste o catálogo e o ciclo de vida das partições históricas no DynamoDB.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any, Protocol, cast

from boto3.dynamodb.types import TypeDeserializer  # type: ignore[import-untyped]
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from adapters.dynamodb.client import (
    DynamoControlProtocolError,
    decode_get_item,
    raise_if_dynamodb_throttled,
    validate_transaction_response,
)
from adapters.dynamodb.codec import serialize_item, serialized_item_bytes
from domain.archive import (
    partition_date,
    require_key_component,
    validate_archive_partition,
    validate_archive_transition,
    validate_new_archive_partition,
)
from domain.canonical_json import canonical_bytes
from ports import (
    ArchiveNotAvailable,
    ArchivePartition,
    ArchivePartitionRepository,
    ArchiveState,
    ConditionalWriteError,
    HotExpirationRepository,
    IdempotencyConflict,
    ReconciliationCounts,
)

type AttributeValue = dict[str, Any]
type SerializedKey = dict[str, AttributeValue]

_DESERIALIZER = TypeDeserializer()
_MARKER_TTL_SECONDS = 90 * 24 * 60 * 60
_MAX_INTERNAL_ITEM_BYTES = 200 * 1024
_MAX_TRANSACTION_TARGETS = 96
_PROJECTION_PK = re.compile(r"^DATASET#(?P<version>[^#\s]+)#VIEW#(?:[^#\s]+#)+(?P<day>[0-9]{8})$")
_PROJECTION_SK = re.compile(
    r"^(?:PROJECTION#[^#\s]+|REVISION#pmr_[0-9a-f]{64}|CURRENT|"
    r"T#[0-9]+(?:#[^#\s]+)?|"
    r"OPENED#[0-9]+#inc_[a-z2-7]{26}|"
    r"PRIORITY#[^#\s]+#STARTED#[0-9]+#inc_[a-z2-7]{26})$"
)
_HOT_FAMILIES = ("FACT#TS", "INCIDENT#TS", "CONTEXT#TS", "INGESTION#SOURCE")


class DynamoArchiveClient(Protocol):
    """Define o contrato mínimo de dynamo arquivo histórico cliente usado para injeção de
    dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def get_item(self, **kwargs: object) -> Mapping[str, object]:
        """Obtém item a partir da fonte configurada.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def query(self, **kwargs: object) -> Mapping[str, object]:
        """Consulta os itens que atendem às chaves e aos limites informados.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def transact_write_items(self, **kwargs: object) -> Mapping[str, object]:
        """Executa a etapa interna ``transact_write_items`` e devolve o resultado validado
        indicado pela assinatura.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...


def _idempotency_key(value: object) -> str:
    """Monta a chave de idempotência a partir de componentes validados.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, str):
        raise TypeError("idempotency_key must be a string")
    if not value:
        raise ValueError("idempotency_key must not be empty")
    if len(value.encode("utf-8")) > 1024:
        raise ValueError("idempotency_key exceeds the internal 1024-byte limit")
    return value


def _ttl(value: object) -> int:
    """Executa a etapa interna ``ttl`` e devolve o resultado validado indicado pela assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``int`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError("ttl_epoch_s must be an integer")
    if value <= 0:
        raise ValueError("ttl_epoch_s must be positive")
    if value > 9_223_372_036_854_775_807:
        raise ValueError("ttl_epoch_s exceeds the supported integer range")
    return value


def _reconciliation_counts(value: object) -> dict[str, int]:
    """Executa a etapa interna ``reconciliation_counts`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``dict[str, int]`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    if not isinstance(value, Mapping) or set(value) != {"accepted", "rejected", "persisted"}:
        raise ValueError("observed_counts must contain accepted, rejected, and persisted")
    result: dict[str, int] = {}
    for field in ("accepted", "rejected", "persisted"):
        count = value[field]
        if isinstance(count, bool) or not isinstance(count, int):
            raise TypeError(f"observed_counts.{field} must be an integer")
        if count < 0:
            raise ValueError(f"observed_counts.{field} must be non-negative")
        result[field] = count
    return result


def _clock_value(clock: Callable[[], datetime]) -> datetime:
    """Produz o valor de clock usado pela etapa seguinte.

    Args:
        clock: Função injetável que fornece o instante atual para validação e testes.

    Returns:
        Valor ``datetime`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    value = clock()
    if type(value) is not datetime:
        raise TypeError("clock result must be a datetime")
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError("clock result must be an aware UTC datetime")
    return value.astimezone(UTC)


def _archive_pk(version: str, dataset: str, partition: str) -> str:
    """Executa a etapa interna ``archive_pk`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        version: Entrada ``version``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        dataset: Nome do dataset permitido pelo registro de contratos.
        partition: Identificador canônico da partição física ou lógica.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    day = partition_date(partition).isoformat()
    return f"DATASET#{version}#INGESTION#ARCHIVE#{dataset}#{day}"


def _archive_catalog_pk(version: str, dataset: str) -> str:
    """Executa a etapa interna ``archive_catalog_pk`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        version: Entrada ``version``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        dataset: Nome do dataset permitido pelo registro de contratos.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return f"DATASET#{version}#INGESTION#ARCHIVE#{dataset}"


def _archive_catalog_sk(partition: str) -> str:
    """Executa a etapa interna ``archive_catalog_sk`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        partition: Identificador canônico da partição física ou lógica.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return f"PARTITION#{partition_date(partition).isoformat()}"


def _retention_pk(version: str, dataset: str, partition: str) -> str:
    """Executa a etapa interna ``retention_pk`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        version: Entrada ``version``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        dataset: Nome do dataset permitido pelo registro de contratos.
        partition: Identificador canônico da partição física ou lógica.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return f"DATASET#{version}#INGESTION#RETENTION#{dataset}#{partition_date(partition):%Y%m%d}"


def _marker_pk(scope: str, key: str) -> str:
    """Executa a etapa interna ``marker_pk`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        scope: Entrada ``scope``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    digest = hashlib.sha256(f"{scope}\0{key}".encode()).hexdigest()
    return f"INGESTION#IDEMPOTENCY#{scope}#{digest}"


def _fingerprint(value: object) -> str:
    """Executa a etapa interna ``fingerprint`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def _ensure_size(item: Mapping[str, object]) -> None:
    """Garante a existência compatível de tamanho sem sobrescrever divergências.

    Args:
        item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if serialized_item_bytes(serialize_item(item)) > _MAX_INTERNAL_ITEM_BYTES:
        raise ValueError("archive item exceeds the internal 200 KiB limit")


def _required_text(item: Mapping[str, object], field: str) -> str:
    """Obtém texto e rejeita a ausência ou um formato inválido.

    Args:
        item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    value = item.get(field)
    if not isinstance(value, str) or not value:
        raise DynamoControlProtocolError(f"DynamoDB archive {field} must be a non-empty string")
    return value


def _normalize_numbers(value: object) -> object:
    """Normaliza numbers para o modelo canônico da ingestão.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``object`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    if type(value) is Decimal:
        decimal = value
        if not decimal.is_finite():
            raise DynamoControlProtocolError("DynamoDB archive contains a non-finite number")
        if decimal == decimal.to_integral_value():
            return int(decimal)
        return decimal
    if isinstance(value, Mapping):
        return {key: _normalize_numbers(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_normalize_numbers(item) for item in value]
    return value


def _decode_serialized_item(raw: object, context: str) -> dict[str, object]:
    """Decodifica serialized item e valida sua forma antes de devolvê-lo.

    Args:
        raw: Entrada ``raw``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        context: Contexto validado compartilhado durante o processamento.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    if not isinstance(raw, Mapping) or not raw:
        raise DynamoControlProtocolError(f"DynamoDB {context} item must be a non-empty mapping")
    decoded: dict[str, object] = {}
    try:
        for name, attribute in raw.items():
            if not isinstance(name, str) or not isinstance(attribute, Mapping):
                raise TypeError
            decoded[name] = _normalize_numbers(
                _DESERIALIZER.deserialize(cast(dict[str, Any], attribute))
            )
    except (KeyError, TypeError, ValueError) as error:
        raise DynamoControlProtocolError(
            f"DynamoDB {context} item contains an invalid AttributeValue"
        ) from error
    return decoded


def _decode_archive_item(item: Mapping[str, object], *, catalog: bool) -> ArchivePartition:
    """Decodifica arquivo histórico item e valida sua forma antes de devolvê-lo.

    Args:
        item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        catalog: Entrada ``catalog``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``ArchivePartition`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    expected = {
        "pk",
        "sk",
        "entityType",
        "datasetVersion",
        "dataset",
        "partition",
        "partitionDate",
        "state",
        "metadata",
        "metadataFingerprint",
    }
    if set(item) != expected:
        raise DynamoControlProtocolError("DynamoDB archive item has an invalid shape")
    expected_type = "ARCHIVE_PARTITION_CATALOG" if catalog else "ARCHIVE_PARTITION"
    if item.get("entityType") != expected_type:
        raise DynamoControlProtocolError("DynamoDB archive item has an invalid entity type")
    try:
        metadata = item.get("metadata")
        if not isinstance(metadata, Mapping):
            raise TypeError
        result = ArchivePartition(
            _required_text(item, "datasetVersion"),
            _required_text(item, "dataset"),
            _required_text(item, "partition"),
            ArchiveState(_required_text(item, "state")),
            cast(Mapping[str, object], metadata),
        )
        validate_archive_partition(result)
        expected_pk = (
            _archive_catalog_pk(result.dataset_version, result.dataset)
            if catalog
            else _archive_pk(result.dataset_version, result.dataset, result.partition)
        )
        expected_sk = _archive_catalog_sk(result.partition) if catalog else "META"
        if item.get("pk") != expected_pk or item.get("sk") != expected_sk:
            raise ValueError
        if item.get("partitionDate") != partition_date(result.partition).isoformat():
            raise ValueError
        if item.get("metadataFingerprint") != _fingerprint(result.metadata):
            raise ValueError
        return result
    except (TypeError, ValueError) as error:
        raise DynamoControlProtocolError("DynamoDB archive item is invalid") from error


def _archive_item(partition: ArchivePartition, *, catalog: bool) -> dict[str, object]:
    """Monta o item de arquivo histórico no formato esperado pela camada de destino.

    Args:
        partition: Identificador canônico da partição física ou lógica.
        catalog: Entrada ``catalog``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.
    """
    item: dict[str, object] = {
        "pk": (
            _archive_catalog_pk(partition.dataset_version, partition.dataset)
            if catalog
            else _archive_pk(partition.dataset_version, partition.dataset, partition.partition)
        ),
        "sk": _archive_catalog_sk(partition.partition) if catalog else "META",
        "entityType": "ARCHIVE_PARTITION_CATALOG" if catalog else "ARCHIVE_PARTITION",
        "datasetVersion": partition.dataset_version,
        "dataset": partition.dataset,
        "partition": partition.partition,
        "partitionDate": partition_date(partition.partition).isoformat(),
        "state": partition.state.value,
        "metadata": partition.metadata,
        "metadataFingerprint": _fingerprint(partition.metadata),
    }
    _ensure_size(item)
    return item


def _marker(
    scope: str,
    key: str,
    fingerprint: str,
    result: Mapping[str, object],
    clock: Callable[[], datetime],
) -> dict[str, object]:
    """Executa a etapa interna ``marker`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        scope: Entrada ``scope``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        clock: Função injetável que fornece o instante atual para validação e testes.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.
    """
    item: dict[str, object] = {
        "pk": _marker_pk(scope, key),
        "sk": "META",
        "operation": scope,
        "fingerprint": fingerprint,
        "result": result,
        "ttl": int(_clock_value(clock).timestamp()) + _MARKER_TTL_SECONDS,
    }
    _ensure_size(item)
    return item


def _marker_put(item: Mapping[str, object], table_name: str) -> dict[str, object]:
    """Executa a etapa interna ``marker_put`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        table_name: Nome validado do recurso, campo ou operação correspondente.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.
    """
    return {
        "Put": {
            "TableName": table_name,
            "Item": serialize_item(item),
            "ConditionExpression": "attribute_not_exists(pk)",
        }
    }


def _get(
    client: DynamoArchiveClient, table_name: str, pk: str, sk: str
) -> dict[str, object] | None:
    """Obtém a entrada a partir da fonte configurada.

    Args:
        client: Cliente externo que executa a operação de infraestrutura.
        table_name: Nome validado do recurso, campo ou operação correspondente.
        pk: Entrada ``pk``; a forma aceita é definida pela anotação de tipo e validada antes do
        uso.
        sk: Entrada ``sk``; a forma aceita é definida pela anotação de tipo e validada antes do
        uso.

    Returns:
        Valor ``dict[str, object] | None`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    try:
        response = client.get_item(
            TableName=table_name,
            Key={"pk": {"S": pk}, "sk": {"S": sk}},
            ConsistentRead=True,
        )
    except ClientError as error:
        raise_if_dynamodb_throttled(error)
        raise
    decoded = decode_get_item(response)
    item = None if decoded is None else cast(dict[str, object], _normalize_numbers(decoded))
    if item is not None and (item.get("pk") != pk or item.get("sk") != sk):
        raise DynamoControlProtocolError("DynamoDB GetItem returned an unexpected key")
    return item


def _replay(
    client: DynamoArchiveClient,
    table_name: str,
    scope: str,
    key: str,
    fingerprint: str,
) -> Mapping[str, object] | None:
    """Executa a etapa interna ``replay`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        client: Cliente externo que executa a operação de infraestrutura.
        table_name: Nome validado do recurso, campo ou operação correspondente.
        scope: Entrada ``scope``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``Mapping[str, object] | None`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
        IdempotencyConflict: Se a operação não puder preservar as invariantes descritas.
    """
    item = _get(client, table_name, _marker_pk(scope, key), "META")
    if item is None:
        return None
    if set(item) != {"pk", "sk", "operation", "fingerprint", "result", "ttl"}:
        raise DynamoControlProtocolError("DynamoDB idempotency marker has an invalid shape")
    if _required_text(item, "operation") != scope:
        raise DynamoControlProtocolError("DynamoDB idempotency operation is invalid")
    if _required_text(item, "fingerprint") != fingerprint:
        raise IdempotencyConflict("idempotency key was reused with different input")
    result = item.get("result")
    if not isinstance(result, Mapping):
        raise DynamoControlProtocolError("DynamoDB idempotency result must be a mapping")
    return cast(Mapping[str, object], result)


def _cancellation_positions(reasons: object, count: int) -> set[int] | None:
    """Executa a etapa interna ``cancellation_positions`` e devolve o resultado validado
    indicado pela assinatura.

    Args:
        reasons: Entrada ``reasons``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        count: Entrada ``count``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``set[int] | None`` produzido pela operação após as validações.
    """
    if not isinstance(reasons, list) or len(reasons) != count:
        return None
    failures: set[int] = set()
    for index, raw in enumerate(reasons):
        if not isinstance(raw, Mapping):
            return None
        code = raw.get("Code")
        if code == "None":
            continue
        if code != "ConditionalCheckFailed":
            return None
        failures.add(index)
    return failures or None


def _query_pages(
    client: DynamoArchiveClient,
    table_name: str,
    pk: str,
    *,
    sk_prefix: str | None = None,
) -> tuple[dict[str, object], ...]:
    """Consulta pages usando somente chaves previamente validadas.

    Args:
        client: Cliente externo que executa a operação de infraestrutura.
        table_name: Nome validado do recurso, campo ou operação correspondente.
        pk: Entrada ``pk``; a forma aceita é definida pela anotação de tipo e validada antes do
        uso.
        sk_prefix: Entrada ``sk_prefix``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``tuple[dict[str, object], ...]`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    items: list[dict[str, object]] = []
    exclusive_start_key: SerializedKey | None = None
    seen_page_keys: set[tuple[str, str]] = set()
    while True:
        values: dict[str, AttributeValue] = {":pk": {"S": pk}}
        expression = "pk = :pk"
        if sk_prefix is not None:
            values[":prefix"] = {"S": sk_prefix}
            expression += " AND begins_with(sk, :prefix)"
        request: dict[str, object] = {
            "TableName": table_name,
            "KeyConditionExpression": expression,
            "ExpressionAttributeValues": values,
            "ConsistentRead": True,
        }
        if exclusive_start_key is not None:
            request["ExclusiveStartKey"] = exclusive_start_key
        try:
            response = client.query(**request)
        except ClientError as error:
            raise_if_dynamodb_throttled(error)
            raise
        if not isinstance(response, Mapping):
            raise DynamoControlProtocolError("DynamoDB Query response must be a mapping")
        unexpected = set(response) - {
            "Items",
            "Count",
            "ScannedCount",
            "LastEvaluatedKey",
            "ConsumedCapacity",
            "ResponseMetadata",
        }
        if unexpected:
            raise DynamoControlProtocolError("DynamoDB Query response contains unknown fields")
        metadata = response.get("ResponseMetadata")
        if not isinstance(metadata, Mapping) or metadata.get("HTTPStatusCode") != 200:
            raise DynamoControlProtocolError("DynamoDB Query response status must be 200")
        raw_items = response.get("Items")
        count = response.get("Count")
        scanned = response.get("ScannedCount")
        if not isinstance(raw_items, list):
            raise DynamoControlProtocolError("DynamoDB Query Items must be a list")
        if isinstance(count, bool) or not isinstance(count, int) or count != len(raw_items):
            raise DynamoControlProtocolError("DynamoDB Query Count is inconsistent")
        if isinstance(scanned, bool) or not isinstance(scanned, int) or scanned < count:
            raise DynamoControlProtocolError("DynamoDB Query ScannedCount is invalid")
        for raw in raw_items:
            item = _decode_serialized_item(raw, "Query")
            item_pk = _required_text(item, "pk")
            item_sk = _required_text(item, "sk")
            if item_pk != pk or (sk_prefix is not None and not item_sk.startswith(sk_prefix)):
                raise DynamoControlProtocolError("DynamoDB Query returned an unsolicited item")
            logical_key = (item_pk, item_sk)
            if logical_key in seen_page_keys:
                raise DynamoControlProtocolError("DynamoDB Query returned a duplicate item")
            seen_page_keys.add(logical_key)
            items.append(item)
        last = response.get("LastEvaluatedKey")
        if last is None:
            break
        if not isinstance(last, Mapping) or set(last) != {"pk", "sk"}:
            raise DynamoControlProtocolError("DynamoDB Query LastEvaluatedKey is invalid")
        decoded_last = _decode_serialized_item(last, "LastEvaluatedKey")
        last_pk = _required_text(decoded_last, "pk")
        last_sk = _required_text(decoded_last, "sk")
        if last_pk != pk or (sk_prefix is not None and not last_sk.startswith(sk_prefix)):
            raise DynamoControlProtocolError("DynamoDB Query LastEvaluatedKey is unsolicited")
        logical_last = (last_pk, last_sk)
        if exclusive_start_key is not None:
            previous = _decode_serialized_item(exclusive_start_key, "ExclusiveStartKey")
            if logical_last == (_required_text(previous, "pk"), _required_text(previous, "sk")):
                raise DynamoControlProtocolError("DynamoDB Query pagination did not advance")
        exclusive_start_key = cast(SerializedKey, dict(last))
    return tuple(items)


def encode_projection_partition_catalog(
    dataset_version: str,
    dataset: str,
    partition: str,
    projection_pk: str,
    projection_sk: str,
    *,
    required_archives: Sequence[tuple[str, str]],
    catalog_generation: int,
) -> dict[str, object]:
    """Codifica projeção partição catálogo no formato persistido pela camada de destino.

    Args:
        dataset_version: Identificador imutável da versão do dataset.
        dataset: Nome do dataset permitido pelo registro de contratos.
        partition: Identificador canônico da partição física ou lógica.
        projection_pk: Entrada ``projection_pk``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        projection_sk: Entrada ``projection_sk``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        required_archives: Entrada ``required_archives``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        catalog_generation: Entrada ``catalog_generation``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    version = require_key_component(dataset_version, "dataset_version")
    dataset_name = require_key_component(dataset, "dataset")
    day = partition_date(partition)
    if not isinstance(projection_pk, str) or not projection_pk:
        raise ValueError("projection_pk must be a non-empty string")
    if not isinstance(projection_sk, str) or not projection_sk:
        raise ValueError("projection_sk must be a non-empty string")
    if len(projection_pk.encode("utf-8")) > 2048 or len(projection_sk.encode("utf-8")) > 1024:
        raise ValueError("projection target exceeds DynamoDB key limits")
    matched = _PROJECTION_PK.fullmatch(projection_pk)
    if (
        matched is None
        or matched.group("version") != version
        or matched.group("day") != day.strftime("%Y%m%d")
        or _PROJECTION_SK.fullmatch(projection_sk) is None
    ):
        raise ValueError("projection target must identify the exact version and partition day")
    if isinstance(catalog_generation, bool) or not isinstance(catalog_generation, int):
        raise TypeError("catalog_generation must be an integer")
    if catalog_generation <= 0:
        raise ValueError("catalog_generation must be positive")
    normalized: list[dict[str, str]] = []
    identities: list[tuple[str, date]] = []
    for required_dataset, required_partition in required_archives:
        required_name = require_key_component(required_dataset, "required archive dataset")
        required_day = partition_date(required_partition)
        if required_day != day:
            raise ValueError("required archives must belong to the projection day")
        identities.append((required_name, required_day))
        normalized.append({"dataset": required_name, "partition": required_partition})
    if not identities:
        raise ValueError("required_archives must be non-empty")
    if len(identities) > 48:
        raise ValueError("required_archives exceeds the safe transactional limit of 48")
    if len(set(identities)) != len(identities) or identities != sorted(identities):
        raise ValueError("required_archives must be physically unique and canonically ordered")
    if (dataset_name, day) not in identities:
        raise ValueError("projection catalog scope must be one of its required archives")
    digest = hashlib.sha256(canonical_bytes([projection_pk, projection_sk, normalized])).hexdigest()
    item: dict[str, object] = {
        "pk": f"DATASET#{version}#INGESTION#HOTPROJ#{dataset_name}#{day:%Y%m%d}",
        "sk": f"TARGET#{digest}",
        "entityType": "HOT_PROJECTION_PARTITION",
        "datasetVersion": version,
        "dataset": dataset_name,
        "partition": partition,
        "partitionDate": day.isoformat(),
        "projectionPk": projection_pk,
        "projectionSk": projection_sk,
        "requiredArchives": normalized,
        "catalogGeneration": catalog_generation,
    }
    _ensure_size(item)
    return item


def encode_projection_target_set_catalog(
    dataset_version: str,
    dataset: str,
    partition: str,
    projection_pk: str,
    operational_sk: str,
    *,
    targets: Sequence[Mapping[str, object]],
    catalog_generation: int,
) -> dict[str, object]:
    """Codifica projeção destino set catálogo no formato persistido pela camada de destino.

    Args:
        dataset_version: Identificador imutável da versão do dataset.
        dataset: Nome do dataset permitido pelo registro de contratos.
        partition: Identificador canônico da partição física ou lógica.
        projection_pk: Entrada ``projection_pk``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        operational_sk: Entrada ``operational_sk``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        targets: Entrada ``targets``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        catalog_generation: Entrada ``catalog_generation``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    version = require_key_component(dataset_version, "dataset_version")
    dataset_name = require_key_component(dataset, "dataset")
    day = partition_date(partition)
    matched = _PROJECTION_PK.fullmatch(projection_pk)
    if (
        matched is None
        or matched.group("version") != version
        or matched.group("day") != day.strftime("%Y%m%d")
        or _PROJECTION_SK.fullmatch(operational_sk) is None
        or operational_sk.startswith("REVISION#")
    ):
        raise ValueError("projection target set must identify an operational projection day")
    if isinstance(catalog_generation, bool) or not isinstance(catalog_generation, int):
        raise TypeError("catalog_generation must be an integer")
    if catalog_generation <= 0:
        raise ValueError("catalog_generation must be positive")
    if not isinstance(targets, Sequence) or isinstance(targets, str | bytes) or not targets:
        raise ValueError("projection target set must not be empty")
    normalized_targets: list[dict[str, object]] = []
    identities: list[tuple[str, str]] = []
    for raw_target in targets:
        if set(raw_target) != {
            "kind",
            "sk",
            "materializationRevision",
            "requiredArchives",
        }:
            raise ValueError("projection target set entry has an invalid shape")
        kind = raw_target.get("kind")
        target_sk = raw_target.get("sk")
        revision = raw_target.get("materializationRevision")
        raw_archives = raw_target.get("requiredArchives")
        if kind not in {"OPERATIONAL", "REVISION"}:
            raise ValueError("projection target set kind is invalid")
        if not isinstance(target_sk, str) or _PROJECTION_SK.fullmatch(target_sk) is None:
            raise ValueError("projection target set sort key is invalid")
        if not isinstance(revision, str) or re.fullmatch(r"pmr_[0-9a-f]{64}", revision) is None:
            raise ValueError("projection target set revision is invalid")
        if kind == "OPERATIONAL" and target_sk != operational_sk:
            raise ValueError("operational target set entry differs from operational_sk")
        if kind == "REVISION" and target_sk != f"REVISION#{revision}":
            raise ValueError("revision target set entry differs from its revision")
        if not isinstance(raw_archives, Sequence) or isinstance(raw_archives, str | bytes):
            raise TypeError("projection target set requiredArchives must be a sequence")
        archives: list[dict[str, str]] = []
        physical: list[tuple[str, date]] = []
        for raw_archive in raw_archives:
            if not isinstance(raw_archive, Sequence) or len(raw_archive) != 2:
                raise ValueError("projection target set archive identity is invalid")
            archive_dataset, archive_partition = raw_archive
            archive_name = require_key_component(archive_dataset, "required archive dataset")
            if not isinstance(archive_partition, str):
                raise TypeError("required archive partition must be a string")
            archive_day = partition_date(archive_partition)
            if archive_day != day:
                raise ValueError("required archives must belong to the projection day")
            archives.append({"dataset": archive_name, "partition": archive_partition})
            physical.append((archive_name, archive_day))
        if (
            not archives
            or len(archives) > 48
            or physical != sorted(physical)
            or len(set(physical)) != len(physical)
            or (dataset_name, day) not in physical
        ):
            raise ValueError("projection target set requiredArchives are not canonical")
        identities.append((cast(str, kind), target_sk))
        normalized_targets.append(
            {
                "kind": kind,
                "sk": target_sk,
                "materializationRevision": revision,
                "requiredArchives": archives,
            }
        )
    if identities != sorted(identities) or len(set(identities)) != len(identities):
        raise ValueError("projection target set entries must be unique and canonically ordered")
    target_digest = hashlib.sha256(canonical_bytes([projection_pk, operational_sk])).hexdigest()
    catalog_revision = "pcr_" + hashlib.sha256(canonical_bytes(normalized_targets)).hexdigest()
    item: dict[str, object] = {
        "pk": f"DATASET#{version}#INGESTION#HOTPROJ#{dataset_name}#{day:%Y%m%d}",
        "sk": f"TARGET#{target_digest}",
        "entityType": "HOT_PROJECTION_TARGET_SET",
        "datasetVersion": version,
        "dataset": dataset_name,
        "partition": partition,
        "partitionDate": day.isoformat(),
        "projectionPk": projection_pk,
        "operationalSk": operational_sk,
        "targets": normalized_targets,
        "catalogGeneration": catalog_generation,
        "catalogRevision": catalog_revision,
    }
    _ensure_size(item)
    return item


type ArchiveIdentity = tuple[str, str]
type ProjectionTarget = tuple[SerializedKey, tuple[ArchiveIdentity, ...]]


def _catalog_snapshot(
    client: DynamoArchiveClient,
    table_name: str,
    version: str,
    dataset: str,
    partition: str,
    generation: int,
) -> tuple[tuple[SerializedKey, ...], tuple[ProjectionTarget, ...], str]:
    """Executa a etapa interna ``catalog_snapshot`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        client: Cliente externo que executa a operação de infraestrutura.
        table_name: Nome validado do recurso, campo ou operação correspondente.
        version: Entrada ``version``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        dataset: Nome do dataset permitido pelo registro de contratos.
        partition: Identificador canônico da partição física ou lógica.
        generation: Entrada ``generation``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``tuple[tuple[SerializedKey, ...], tuple[ProjectionTarget, ...], str]`` produzido
        pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
        ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
    """
    day = partition_date(partition)
    day_compact = day.strftime("%Y%m%d")
    fact_catalog_pk = f"DATASET#{version}#INGESTION#HOTPART#{dataset}#{day_compact}"
    fact_catalogs = _query_pages(client, table_name, fact_catalog_pk)
    expected_fact_fields = {
        "pk",
        "sk",
        "entityType",
        "datasetVersion",
        "dataset",
        "partition",
        "partitionDate",
        "hotPk",
        "catalogGeneration",
        "targetCount",
        "targetDigest",
    }
    permitted_hot_pks = {
        f"DATASET#{version}#{family}#{dataset}#{day_compact}" for family in _HOT_FAMILIES
    }
    facts: list[SerializedKey] = []
    catalog_evidence: list[object] = []
    seen_fact_keys: set[tuple[str, str]] = set()
    seen_hot_pks: set[str] = set()
    segment_catalogs: dict[str, list[Mapping[str, object]]] = {}
    summaries: list[Mapping[str, object]] = []
    for catalog in fact_catalogs:
        if catalog.get("entityType") == "HOT_PARTITION_SEGMENT":
            hot_pk = _required_text(catalog, "hotPk")
            segment_catalogs.setdefault(hot_pk, []).append(catalog)
        else:
            summaries.append(catalog)
    for summary in summaries:
        catalog = dict(summary)
        hot_pk = _required_text(catalog, "hotPk")
        expected_sk = "PK#" + hashlib.sha256(hot_pk.encode()).hexdigest()
        chained = catalog.get("catalogFormat") == "CHAIN_V1"
        expected_summary_fields = expected_fact_fields | ({"catalogFormat"} if chained else set())
        if (
            set(catalog) != expected_summary_fields
            or catalog.get("entityType") != "HOT_PARTITION"
            or catalog.get("datasetVersion") != version
            or catalog.get("dataset") != dataset
            or catalog.get("partition") != partition
            or catalog.get("partitionDate") != day.isoformat()
            or catalog.get("catalogGeneration") != generation
            or catalog.get("sk") != expected_sk
            or hot_pk not in permitted_hot_pks
            or hot_pk in seen_hot_pks
        ):
            raise DynamoControlProtocolError("DynamoDB HOTPART item is inconsistent")
        seen_hot_pks.add(hot_pk)
        catalog_evidence.append(catalog)
        partition_targets = _query_pages(client, table_name, hot_pk)
        target_identities: list[tuple[str, str]] = []
        for target in partition_targets:
            sk = _required_text(target, "sk")
            logical = (hot_pk, sk)
            if (
                target.get("pk") != hot_pk
                or target.get("entityType") != "HOT_RECORD"
                or target.get("datasetVersion") != version
                or target.get("sourceDataset") != dataset
                or logical in seen_fact_keys
            ):
                raise DynamoControlProtocolError("DynamoDB hot record is inconsistent")
            seen_fact_keys.add(logical)
            target_identities.append(logical)
            facts.append({"pk": {"S": hot_pk}, "sk": {"S": sk}})
        if catalog.get("targetCount") != len(target_identities):
            raise DynamoControlProtocolError("DynamoDB HOTPART target summary is inconsistent")
        if not chained:
            if catalog.get("targetDigest") != _fingerprint(sorted(target_identities)):
                raise DynamoControlProtocolError("DynamoDB HOTPART target summary is inconsistent")
            continue
        previous_digest = hashlib.sha256(canonical_bytes([])).hexdigest()
        expected_start = 0
        chained_targets: list[tuple[str, str]] = []
        expected_segment_fields = {
            "pk",
            "sk",
            "entityType",
            "datasetVersion",
            "dataset",
            "partition",
            "hotPk",
            "catalogGeneration",
            "start",
            "previousTargetDigest",
            "targetCount",
            "targetDigest",
            "targets",
        }
        for segment in sorted(
            segment_catalogs.pop(hot_pk, []), key=lambda item: _required_text(item, "sk")
        ):
            raw_targets = segment.get("targets")
            if not isinstance(raw_targets, list):
                raise DynamoControlProtocolError("DynamoDB HOTPART segment targets are invalid")
            targets: list[tuple[str, str]] = []
            for target in raw_targets:
                if not isinstance(target, Mapping) or set(target) != {"pk", "sk"}:
                    raise DynamoControlProtocolError("DynamoDB HOTPART segment target is invalid")
                targets.append((_required_text(target, "pk"), _required_text(target, "sk")))
            digest = hashlib.sha256(canonical_bytes([previous_digest, targets])).hexdigest()
            if (
                set(segment) != expected_segment_fields
                or segment.get("pk") != catalog.get("pk")
                or segment.get("sk") != f"SEG#{expected_start:020d}"
                or segment.get("datasetVersion") != version
                or segment.get("dataset") != dataset
                or segment.get("partition") != partition
                or segment.get("hotPk") != hot_pk
                or segment.get("catalogGeneration") != generation
                or segment.get("start") != expected_start
                or segment.get("previousTargetDigest") != previous_digest
                or segment.get("targetCount") != len(targets)
                or segment.get("targetDigest") != digest
                or len(set(targets)) != len(targets)
            ):
                raise DynamoControlProtocolError("DynamoDB HOTPART segment is inconsistent")
            expected_start += len(targets)
            previous_digest = digest
            chained_targets.extend(targets)
            catalog_evidence.append(segment)
        if (
            expected_start != len(target_identities)
            or previous_digest != catalog.get("targetDigest")
            or set(chained_targets) != set(target_identities)
        ):
            raise DynamoControlProtocolError("DynamoDB HOTPART target summary is inconsistent")
    if segment_catalogs:
        raise DynamoControlProtocolError("DynamoDB HOTPART segment has no summary")

    projection_catalog_pk = f"DATASET#{version}#INGESTION#HOTPROJ#{dataset}#{day_compact}"
    projection_catalogs = _query_pages(client, table_name, projection_catalog_pk)
    expected_projection_fields = {
        "pk",
        "sk",
        "entityType",
        "datasetVersion",
        "dataset",
        "partition",
        "partitionDate",
        "projectionPk",
        "projectionSk",
        "requiredArchives",
        "catalogGeneration",
    }
    projections: list[ProjectionTarget] = []
    seen_projection_keys: set[tuple[str, str]] = set()
    for catalog in projection_catalogs:
        if catalog.get("entityType") == "HOT_PROJECTION_TARGET_SET":
            expected_target_set_fields = {
                "pk",
                "sk",
                "entityType",
                "datasetVersion",
                "dataset",
                "partition",
                "partitionDate",
                "projectionPk",
                "operationalSk",
                "targets",
                "catalogGeneration",
                "catalogRevision",
            }
            projection_pk = _required_text(catalog, "projectionPk")
            operational_sk = _required_text(catalog, "operationalSk")
            raw_targets = catalog.get("targets")
            if not isinstance(raw_targets, list):
                raise DynamoControlProtocolError("DynamoDB projection target set is invalid")
            normalized_targets: list[dict[str, object]] = []
            decoded_targets: list[tuple[str, str, str, tuple[ArchiveIdentity, ...]]] = []
            for raw_target in raw_targets:
                if not isinstance(raw_target, Mapping) or set(raw_target) != {
                    "kind",
                    "sk",
                    "materializationRevision",
                    "requiredArchives",
                }:
                    raise DynamoControlProtocolError(
                        "DynamoDB projection target set entry is invalid"
                    )
                raw_dependencies = raw_target.get("requiredArchives")
                if not isinstance(raw_dependencies, list):
                    raise DynamoControlProtocolError(
                        "DynamoDB projection target dependencies are invalid"
                    )
                target_dependencies: list[ArchiveIdentity] = []
                for raw_dependency in raw_dependencies:
                    if not isinstance(raw_dependency, Mapping) or set(raw_dependency) != {
                        "dataset",
                        "partition",
                    }:
                        raise DynamoControlProtocolError(
                            "DynamoDB projection target dependency is invalid"
                        )
                    target_dependencies.append(
                        (
                            _required_text(raw_dependency, "dataset"),
                            _required_text(raw_dependency, "partition"),
                        )
                    )
                kind = _required_text(raw_target, "kind")
                target_sk = _required_text(raw_target, "sk")
                revision = _required_text(raw_target, "materializationRevision")
                dependency_tuple = tuple(target_dependencies)
                normalized_targets.append(
                    {
                        "kind": kind,
                        "sk": target_sk,
                        "materializationRevision": revision,
                        "requiredArchives": dependency_tuple,
                    }
                )
                decoded_targets.append((kind, target_sk, revision, dependency_tuple))
            try:
                canonical_catalog = encode_projection_target_set_catalog(
                    version,
                    dataset,
                    partition,
                    projection_pk,
                    operational_sk,
                    targets=normalized_targets,
                    catalog_generation=generation,
                )
            except (TypeError, ValueError) as error:
                raise DynamoControlProtocolError(
                    "DynamoDB projection target set is inconsistent"
                ) from error
            if set(catalog) != expected_target_set_fields or catalog != canonical_catalog:
                raise DynamoControlProtocolError("DynamoDB projection target set is inconsistent")
            for kind, target_sk, revision, dependency_tuple in decoded_targets:
                logical = (projection_pk, target_sk)
                target_item = _get(client, table_name, projection_pk, target_sk)
                expected_entity = "PROJECTION" if kind == "OPERATIONAL" else "PROJECTION_REVISION"
                if (
                    logical in seen_projection_keys
                    or target_item is None
                    or target_item.get("entityType") != expected_entity
                    or target_item.get("datasetVersion") != version
                    or target_item.get("materializationRevision") != revision
                    or partition_date(target_item.get("partition")) != day
                ):
                    raise ConditionalWriteError("projection catalog target is missing or changed")
                persisted_dependencies = target_item.get("requiredArchives")
                if (
                    not isinstance(persisted_dependencies, list)
                    or [
                        {"dataset": dependency[0], "partition": dependency[1]}
                        for dependency in dependency_tuple
                    ]
                    != persisted_dependencies
                ):
                    raise ConditionalWriteError("projection catalog target dependencies changed")
                seen_projection_keys.add(logical)
                projections.append(
                    ({"pk": {"S": projection_pk}, "sk": {"S": target_sk}}, dependency_tuple)
                )
            catalog_evidence.append(catalog)
            continue
        projection_pk = _required_text(catalog, "projectionPk")
        projection_sk = _required_text(catalog, "projectionSk")
        raw_dependencies = catalog.get("requiredArchives")
        if not isinstance(raw_dependencies, list) or not raw_dependencies:
            raise DynamoControlProtocolError("DynamoDB projection dependencies are invalid")
        dependencies: list[ArchiveIdentity] = []
        physical_dependencies: list[tuple[str, date]] = []
        for raw_dependency in raw_dependencies:
            if not isinstance(raw_dependency, Mapping) or set(raw_dependency) != {
                "dataset",
                "partition",
            }:
                raise DynamoControlProtocolError("DynamoDB projection dependency is invalid")
            dependency_dataset = _required_text(raw_dependency, "dataset")
            dependency_partition = _required_text(raw_dependency, "partition")
            dependency_day = partition_date(dependency_partition)
            if dependency_day != day:
                raise DynamoControlProtocolError("DynamoDB projection dependency day is invalid")
            dependencies.append((dependency_dataset, dependency_partition))
            physical_dependencies.append((dependency_dataset, dependency_day))
        dependency_tuple = tuple(dependencies)
        physical_dependency_tuple = tuple(physical_dependencies)
        logical = (projection_pk, projection_sk)
        expected_digest = hashlib.sha256(
            canonical_bytes(
                [
                    projection_pk,
                    projection_sk,
                    [
                        {"dataset": dependency[0], "partition": dependency[1]}
                        for dependency in dependency_tuple
                    ],
                ]
            )
        ).hexdigest()
        matched = _PROJECTION_PK.fullmatch(projection_pk)
        if (
            set(catalog) != expected_projection_fields
            or catalog.get("entityType") != "HOT_PROJECTION_PARTITION"
            or catalog.get("datasetVersion") != version
            or catalog.get("dataset") != dataset
            or catalog.get("partition") != partition
            or catalog.get("partitionDate") != day.isoformat()
            or catalog.get("catalogGeneration") != generation
            or catalog.get("sk") != f"TARGET#{expected_digest}"
            or matched is None
            or matched.group("version") != version
            or matched.group("day") != day_compact
            or _PROJECTION_SK.fullmatch(projection_sk) is None
            or physical_dependency_tuple != tuple(sorted(physical_dependency_tuple))
            or len(set(physical_dependency_tuple)) != len(physical_dependency_tuple)
            or (dataset, day) not in physical_dependency_tuple
            or logical in seen_projection_keys
        ):
            raise DynamoControlProtocolError("DynamoDB projection catalog is inconsistent")
        target_item = _get(client, table_name, projection_pk, projection_sk)
        if (
            target_item is None
            or target_item.get("entityType") != "PROJECTION"
            or target_item.get("datasetVersion") != version
            or partition_date(target_item.get("partition")) != day
        ):
            raise ConditionalWriteError("projection catalog target is missing or changed")
        seen_projection_keys.add(logical)
        catalog_evidence.append(catalog)
        projections.append(
            ({"pk": {"S": projection_pk}, "sk": {"S": projection_sk}}, dependency_tuple)
        )
    facts.sort(key=lambda key: (cast(str, key["pk"]["S"]), cast(str, key["sk"]["S"])))
    projections.sort(
        key=lambda value: (cast(str, value[0]["pk"]["S"]), cast(str, value[0]["sk"]["S"]))
    )
    digest = _fingerprint(
        {
            "generation": generation,
            "catalog": sorted(
                catalog_evidence,
                key=lambda item: (
                    cast(Mapping[str, object], item).get("pk", ""),
                    cast(Mapping[str, object], item).get("sk", ""),
                ),
            ),
        }
    )
    return tuple(facts), tuple(projections), digest


def _fact_catalog_seal_gates(
    client: DynamoArchiveClient,
    table_name: str,
    version: str,
    dataset: str,
    partition: str,
    generation: int,
    targets: Sequence[SerializedKey],
) -> list[dict[str, object]]:
    """Executa a etapa interna ``fact_catalog_seal_gates`` e devolve o resultado validado
    indicado pela assinatura.

    Args:
        client: Cliente externo que executa a operação de infraestrutura.
        table_name: Nome validado do recurso, campo ou operação correspondente.
        version: Entrada ``version``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        dataset: Nome do dataset permitido pelo registro de contratos.
        partition: Identificador canônico da partição física ou lógica.
        generation: Entrada ``generation``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        targets: Entrada ``targets``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``list[dict[str, object]]`` produzido pela operação após as validações.

    Raises:
        ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
    """
    day = partition_date(partition)
    day_compact = day.strftime("%Y%m%d")
    grouped: dict[str, list[tuple[str, str]]] = {}
    for target in targets:
        pk = cast(str, target["pk"]["S"])
        grouped.setdefault(pk, []).append((pk, cast(str, target["sk"]["S"])))
    catalog_pk = f"DATASET#{version}#INGESTION#HOTPART#{dataset}#{day_compact}"
    gates: list[dict[str, object]] = []
    for family in _HOT_FAMILIES:
        hot_pk = f"DATASET#{version}#{family}#{dataset}#{day_compact}"
        catalog_sk = "PK#" + hashlib.sha256(hot_pk.encode()).hexdigest()
        catalog = _get(client, table_name, catalog_pk, catalog_sk)
        identities = sorted(grouped.get(hot_pk, []))
        if catalog is None:
            gates.append(
                {
                    "ConditionCheck": {
                        "TableName": table_name,
                        "Key": {"pk": {"S": catalog_pk}, "sk": {"S": catalog_sk}},
                        "ConditionExpression": "attribute_not_exists(pk)",
                    }
                }
            )
            continue
        target_digest = _fingerprint(identities)
        if catalog.get("catalogFormat") == "CHAIN_V1":
            target_digest = hashlib.sha256(canonical_bytes([])).hexdigest()
            chained_targets: list[tuple[str, str]] = []
            start = 0
            segments = [
                item
                for item in _query_pages(client, table_name, catalog_pk)
                if item.get("entityType") == "HOT_PARTITION_SEGMENT" and item.get("hotPk") == hot_pk
            ]
            for segment in sorted(segments, key=lambda item: _required_text(item, "sk")):
                raw_targets = segment.get("targets")
                if not isinstance(raw_targets, list) or segment.get("start") != start:
                    raise ConditionalWriteError(
                        "fact catalog segment changed before retention seal"
                    )
                segment_targets: list[tuple[str, str]] = []
                for target in raw_targets:
                    if not isinstance(target, Mapping) or set(target) != {"pk", "sk"}:
                        raise ConditionalWriteError(
                            "fact catalog segment changed before retention seal"
                        )
                    segment_targets.append(
                        (_required_text(target, "pk"), _required_text(target, "sk"))
                    )
                target_digest = hashlib.sha256(
                    canonical_bytes([target_digest, segment_targets])
                ).hexdigest()
                chained_targets.extend(segment_targets)
                start += len(segment_targets)
            if start != len(identities) or set(chained_targets) != set(identities):
                raise ConditionalWriteError("fact catalog segment changed before retention seal")
        if (
            catalog.get("entityType") != "HOT_PARTITION"
            or catalog.get("datasetVersion") != version
            or catalog.get("dataset") != dataset
            or catalog.get("partition") != partition
            or catalog.get("hotPk") != hot_pk
            or catalog.get("catalogGeneration") != generation
            or catalog.get("targetCount") != len(identities)
            or catalog.get("targetDigest") != target_digest
        ):
            raise ConditionalWriteError("fact catalog summary changed before retention seal")
        gates.append(
            {
                "ConditionCheck": {
                    "TableName": table_name,
                    "Key": {"pk": {"S": catalog_pk}, "sk": {"S": catalog_sk}},
                    "ConditionExpression": (
                        "entityType = :type AND datasetVersion = :version "
                        "AND dataset = :dataset AND #partition = :partition AND hotPk = :hotPk "
                        "AND catalogGeneration = :generation AND targetCount = :count "
                        "AND targetDigest = :digest"
                    ),
                    "ExpressionAttributeNames": {"#partition": "partition"},
                    "ExpressionAttributeValues": {
                        ":type": {"S": "HOT_PARTITION"},
                        ":version": {"S": version},
                        ":dataset": {"S": dataset},
                        ":partition": {"S": partition},
                        ":hotPk": {"S": hot_pk},
                        ":generation": {"N": str(generation)},
                        ":count": {"N": str(len(identities))},
                        ":digest": {"S": target_digest},
                    },
                }
            }
        )
    return gates


class DynamoArchivePartitionRepository(ArchivePartitionRepository):
    """Agrupa o estado e as operações de ``DynamoArchivePartitionRepository`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        client: DynamoArchiveClient,
        table_name: str,
        *,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            client: Cliente externo que executa a operação de infraestrutura.
            table_name: Nome validado do recurso, campo ou operação correspondente.
            clock: Função injetável que fornece o instante atual para validação e testes.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(table_name, str):
            raise TypeError("table_name must be a string")
        if not table_name:
            raise ValueError("table_name must not be empty")
        if not callable(clock):
            raise TypeError("clock must be callable")
        self._client = client
        self._table_name = table_name
        self._clock = clock

    @staticmethod
    def _result(partition: ArchivePartition) -> dict[str, object]:
        """Executa a etapa interna ``result`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            partition: Identificador canônico da partição física ou lógica.

        Returns:
            Valor ``dict[str, object]`` produzido pela operação após as validações.
        """
        return {
            "kind": "archive-partition",
            "item": _archive_item(partition, catalog=False),
        }

    @staticmethod
    def _decode_result(result: Mapping[str, object]) -> ArchivePartition:
        """Decodifica resultado e valida sua forma antes de devolvê-lo.

        Args:
            result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``ArchivePartition`` produzido pela operação após as validações.

        Raises:
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        if set(result) != {"kind", "item"} or result.get("kind") != "archive-partition":
            raise DynamoControlProtocolError("DynamoDB archive replay result is invalid")
        item = result.get("item")
        if not isinstance(item, Mapping):
            raise DynamoControlProtocolError("DynamoDB archive replay item is invalid")
        return _decode_archive_item(cast(Mapping[str, object], item), catalog=False)

    def _transact(
        self,
        items: list[dict[str, object]],
        *,
        scope: str,
        key: str,
        fingerprint: str,
        conditional_positions: frozenset[int],
        conditional_error: Exception,
    ) -> ArchivePartition | None:
        """Executa a etapa interna ``transact`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            items: Entrada ``items``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            scope: Entrada ``scope``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            conditional_positions: Entrada ``conditional_positions``; a forma aceita é definida
            pela anotação de tipo e validada antes do uso.
            conditional_error: Entrada ``conditional_error``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.

        Returns:
            Valor ``ArchivePartition | None`` produzido pela operação após as validações.
        """
        try:
            validate_transaction_response(self._client.transact_write_items(TransactItems=items))
            return None
        except ClientError as error:
            raise_if_dynamodb_throttled(error)
            code = error.response.get("Error", {}).get("Code")
            if code not in {"ConditionalCheckFailedException", "TransactionCanceledException"}:
                raise
            replay = _replay(self._client, self._table_name, scope, key, fingerprint)
            if replay is not None:
                return self._decode_result(replay)
            failures = _cancellation_positions(
                error.response.get("CancellationReasons"), len(items)
            )
            if code == "TransactionCanceledException" and (
                failures is None or not failures <= conditional_positions
            ):
                raise
            raise conditional_error from None

    def put(
        self,
        partition: ArchivePartition,
        *,
        expected_absent: bool,
        idempotency_key: str,
    ) -> None:
        """Persiste o valor após validar identidade e pré-condições da escrita.

        Args:
            partition: Identificador canônico da partição física ou lógica.
            expected_absent: Indica se a operação exige que o recurso ainda não exista.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
        """
        validate_new_archive_partition(partition)
        if type(expected_absent) is not bool:
            raise TypeError("expected_absent must be a boolean")
        if expected_absent is not True:
            raise ConditionalWriteError("archive partition creation requires expected_absent=True")
        key = _idempotency_key(idempotency_key)
        fingerprint = _fingerprint(
            {"partition": self._result(partition), "expectedAbsent": expected_absent}
        )
        replay = _replay(self._client, self._table_name, "archive-partition-put", key, fingerprint)
        if replay is not None:
            self._decode_result(replay)
            return
        main = _archive_item(partition, catalog=False)
        catalog = _archive_item(partition, catalog=True)
        main_put: dict[str, object] = {
            "TableName": self._table_name,
            "Item": serialize_item(main),
        }
        catalog_put: dict[str, object] = {
            "TableName": self._table_name,
            "Item": serialize_item(catalog),
        }
        main_put["ConditionExpression"] = "attribute_not_exists(pk)"
        catalog_put["ConditionExpression"] = "attribute_not_exists(pk)"
        conditional_positions = frozenset({0, 1})
        marker = _marker(
            "archive-partition-put", key, fingerprint, self._result(partition), self._clock
        )
        self._transact(
            [
                {"Put": main_put},
                {"Put": catalog_put},
                _marker_put(marker, self._table_name),
            ],
            scope="archive-partition-put",
            key=key,
            fingerprint=fingerprint,
            conditional_positions=conditional_positions,
            conditional_error=ConditionalWriteError("archive partition already exists"),
        )

    def query(self, dataset_version: str, dataset: str) -> tuple[ArchivePartition, ...]:
        """Consulta os itens que atendem às chaves e aos limites informados.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            dataset: Nome do dataset permitido pelo registro de contratos.

        Returns:
            Valor ``tuple[ArchivePartition, ...]`` produzido pela operação após as validações.

        Raises:
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        version = require_key_component(dataset_version, "dataset_version")
        dataset_name = require_key_component(dataset, "dataset")
        items = _query_pages(
            self._client,
            self._table_name,
            _archive_catalog_pk(version, dataset_name),
            sk_prefix="PARTITION#",
        )
        partitions = tuple(_decode_archive_item(item, catalog=True) for item in items)
        if any(
            item.dataset_version != version or item.dataset != dataset_name for item in partitions
        ):
            raise DynamoControlProtocolError("DynamoDB archive Query mixed datasets or versions")
        return partitions

    def get(
        self,
        dataset_version: str,
        dataset: str,
        partition: str,
    ) -> ArchivePartition | None:
        """Read the authoritative archive item by exact key with strong consistency."""
        version = require_key_component(dataset_version, "dataset_version")
        dataset_name = require_key_component(dataset, "dataset")
        partition_name = require_key_component(partition, "partition")
        item = _get(
            self._client,
            self._table_name,
            _archive_pk(version, dataset_name, partition_name),
            "META",
        )
        if item is None:
            return None
        decoded = _decode_archive_item(item, catalog=False)
        if (
            decoded.dataset_version,
            decoded.dataset,
            decoded.partition,
        ) != (version, dataset_name, partition_name):
            raise DynamoControlProtocolError("DynamoDB archive GetItem mixed identities")
        return decoded

    def record_reconciliation(
        self,
        dataset_version: str,
        dataset: str,
        partition: str,
        *,
        observed_counts: ReconciliationCounts,
        reconciled_at: datetime,
        expected_state: ArchiveState,
        idempotency_key: str,
    ) -> ArchivePartition:
        """Obtém ou registra reconciliação como evidência da execução atual.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            dataset: Nome do dataset permitido pelo registro de contratos.
            partition: Identificador canônico da partição física ou lógica.
            observed_counts: Valor efetivamente observado que será comparado com a evidência
            esperada.
            reconciled_at: Instante UTC com fuso horário usado pela regra temporal.
            expected_state: Estado previamente observado usado no controle de concorrência.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``ArchivePartition`` produzido pela operação após as validações.

        Raises:
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
            ValueError: Se um valor estiver fora das invariantes aceitas.
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        version = require_key_component(dataset_version, "dataset_version")
        dataset_name = require_key_component(dataset, "dataset")
        partition_date(partition)
        if expected_state is not ArchiveState.VALIDATED:
            raise ConditionalWriteError("reconciliation requires expected_state VALIDATED")
        if (
            type(reconciled_at) is not datetime
            or reconciled_at.tzinfo is None
            or reconciled_at.utcoffset() != timedelta(0)
        ):
            raise ValueError("reconciled_at must be an aware UTC datetime")
        key = _idempotency_key(idempotency_key)
        normalized_counts = _reconciliation_counts(observed_counts)
        fingerprint = _fingerprint(
            {
                "datasetVersion": version,
                "dataset": dataset_name,
                "partition": partition,
                "observedCounts": normalized_counts,
                "reconciledAt": reconciled_at,
                "expectedState": expected_state.value,
            }
        )
        replay = _replay(
            self._client, self._table_name, "archive-partition-reconcile", key, fingerprint
        )
        if replay is not None:
            return self._decode_result(replay)
        raw_current = _get(
            self._client, self._table_name, _archive_pk(version, dataset_name, partition), "META"
        )
        if raw_current is None:
            raise ConditionalWriteError("archive partition is missing")
        current = _decode_archive_item(raw_current, catalog=False)
        if current.state is not expected_state:
            raise ConditionalWriteError("archive partition state differs from expected_state")
        generation = current.metadata.get("catalogGeneration")
        if isinstance(generation, bool) or not isinstance(generation, int) or generation <= 0:
            raise DynamoControlProtocolError("archive catalog generation is invalid")
        expected_counts = current.metadata.get("counts")
        if not isinstance(expected_counts, Mapping) or normalized_counts != dict(expected_counts):
            raise ConditionalWriteError("observed reconciliation counts differ from archive counts")
        canonical_v2 = "aggregateDigest" in current.metadata
        if canonical_v2:
            digest = current.metadata.get("aggregateDigest")
            if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
                raise DynamoControlProtocolError("canonical aggregate digest is invalid")
            if current.metadata.get("hotItemCount") != 0:
                raise ConditionalWriteError("canonical-v2 archive cannot depend on hot facts")
            facts: tuple[SerializedKey, ...] = ()
            projections: tuple[ProjectionTarget, ...] = ()
        else:
            facts, projections, digest = _catalog_snapshot(
                self._client,
                self._table_name,
                version,
                dataset_name,
                partition,
                generation,
            )
            if len(facts) != current.metadata.get("hotItemCount") or len(
                projections
            ) != current.metadata.get("projectionItemCount"):
                raise ConditionalWriteError("hot catalog target count differs from archive catalog")
        metadata = dict(current.metadata)
        metadata["reconciliation"] = {
            "state": "PASSED",
            "expected": dict(expected_counts),
            "observed": normalized_counts,
            "reconciledAt": reconciled_at.astimezone(UTC).isoformat().replace("+00:00", "Z"),
        }
        metadata["expirationEligible"] = True
        metadata["catalogDigest"] = digest
        changed = ArchivePartition(
            current.dataset_version,
            current.dataset,
            current.partition,
            current.state,
            metadata,
        )
        validate_archive_partition(changed)
        old_fingerprint = _fingerprint(current.metadata)
        new_fingerprint = _fingerprint(changed.metadata)
        marker = _marker(
            "archive-partition-reconcile", key, fingerprint, self._result(changed), self._clock
        )
        values = {
            ":state": {"S": ArchiveState.VALIDATED.value},
            ":oldFingerprint": {"S": old_fingerprint},
            ":metadata": serialize_item({"value": changed.metadata})["value"],
            ":newFingerprint": {"S": new_fingerprint},
        }
        updates: list[dict[str, object]] = []
        for item_key in (
            {"pk": {"S": _archive_pk(version, dataset_name, partition)}, "sk": {"S": "META"}},
            {
                "pk": {"S": _archive_catalog_pk(version, dataset_name)},
                "sk": {"S": _archive_catalog_sk(partition)},
            },
        ):
            updates.append(
                {
                    "Update": {
                        "TableName": self._table_name,
                        "Key": item_key,
                        "UpdateExpression": (
                            "SET metadata = :metadata, metadataFingerprint = :newFingerprint"
                        ),
                        "ConditionExpression": (
                            "#state = :state AND metadataFingerprint = :oldFingerprint"
                        ),
                        "ExpressionAttributeNames": {"#state": "state"},
                        "ExpressionAttributeValues": values,
                    }
                }
            )
        transaction: list[dict[str, object]] = list(updates)
        if not canonical_v2:
            seal: dict[str, object] = {
                "pk": _retention_pk(version, dataset_name, partition),
                "sk": "META",
                "entityType": "RETENTION_SET",
                "datasetVersion": version,
                "dataset": dataset_name,
                "partition": partition,
                "catalogGeneration": generation,
                "catalogDigest": digest,
                "hotItemCount": len(facts),
                "projectionItemCount": len(projections),
            }
            fact_seal_gates = _fact_catalog_seal_gates(
                self._client,
                self._table_name,
                version,
                dataset_name,
                partition,
                generation,
                facts,
            )
            transaction.extend(
                [
                    *fact_seal_gates,
                    {
                        "Put": {
                            "TableName": self._table_name,
                            "Item": serialize_item(seal),
                            "ConditionExpression": "attribute_not_exists(pk)",
                        }
                    },
                ]
            )
        transaction.append(_marker_put(marker, self._table_name))
        replayed = self._transact(
            transaction,
            scope="archive-partition-reconcile",
            key=key,
            fingerprint=fingerprint,
            conditional_positions=frozenset(range(len(transaction) - 1)),
            conditional_error=ConditionalWriteError(
                "archive reconciliation changed concurrently or catalog generation was sealed"
            ),
        )
        return changed if replayed is None else replayed

    def update_state(
        self,
        dataset_version: str,
        dataset: str,
        partition: str,
        state: ArchiveState,
        *,
        expected_state: ArchiveState,
        idempotency_key: str,
    ) -> ArchivePartition:
        """Atualiza estado usando o estado esperado para controlar concorrência.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            dataset: Nome do dataset permitido pelo registro de contratos.
            partition: Identificador canônico da partição física ou lógica.
            state: Estado imutável que será validado ou persistido.
            expected_state: Estado previamente observado usado no controle de concorrência.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``ArchivePartition`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        version = require_key_component(dataset_version, "dataset_version")
        dataset_name = require_key_component(dataset, "dataset")
        partition_date(partition)
        if not isinstance(state, ArchiveState) or not isinstance(expected_state, ArchiveState):
            raise TypeError("state and expected_state must be ArchiveState values")
        validate_archive_transition(expected_state, state)
        key = _idempotency_key(idempotency_key)
        fingerprint = _fingerprint(
            {
                "datasetVersion": version,
                "dataset": dataset_name,
                "partition": partition,
                "state": state.value,
                "expectedState": expected_state.value,
            }
        )
        replay = _replay(
            self._client, self._table_name, "archive-partition-state", key, fingerprint
        )
        if replay is not None:
            return self._decode_result(replay)
        raw_current = _get(
            self._client, self._table_name, _archive_pk(version, dataset_name, partition), "META"
        )
        if raw_current is None:
            raise ConditionalWriteError("archive partition is missing")
        current = _decode_archive_item(raw_current, catalog=False)
        if (
            current.dataset_version != version
            or current.dataset != dataset_name
            or partition_date(current.partition) != partition_date(partition)
        ):
            raise DynamoControlProtocolError("DynamoDB archive item identity is inconsistent")
        if current.state is not expected_state:
            raise ConditionalWriteError("archive partition state differs from expected_state")
        changed = ArchivePartition(
            current.dataset_version,
            current.dataset,
            current.partition,
            state,
            current.metadata,
        )
        validate_archive_partition(changed)
        marker = _marker(
            "archive-partition-state", key, fingerprint, self._result(changed), self._clock
        )
        values = {
            ":state": {"S": state.value},
            ":expected": {"S": expected_state.value},
            ":version": {"S": version},
            ":dataset": {"S": dataset_name},
            ":metadataFingerprint": {"S": _fingerprint(current.metadata)},
        }
        updates: list[dict[str, object]] = []
        for item_key in (
            {
                "pk": {"S": _archive_pk(version, dataset_name, partition)},
                "sk": {"S": "META"},
            },
            {
                "pk": {"S": _archive_catalog_pk(version, dataset_name)},
                "sk": {"S": _archive_catalog_sk(partition)},
            },
        ):
            updates.append(
                {
                    "Update": {
                        "TableName": self._table_name,
                        "Key": item_key,
                        "UpdateExpression": "SET #state = :state",
                        "ConditionExpression": (
                            "#state = :expected AND datasetVersion = :version "
                            "AND dataset = :dataset AND metadataFingerprint = :metadataFingerprint"
                        ),
                        "ExpressionAttributeNames": {"#state": "state"},
                        "ExpressionAttributeValues": values,
                    }
                }
            )
        replayed = self._transact(
            [*updates, _marker_put(marker, self._table_name)],
            scope="archive-partition-state",
            key=key,
            fingerprint=fingerprint,
            conditional_positions=frozenset({0, 1}),
            conditional_error=ConditionalWriteError("archive partition state changed concurrently"),
        )
        return changed if replayed is None else replayed


class DynamoHotExpirationRepository(HotExpirationRepository):
    """Agrupa o estado e as operações de ``DynamoHotExpirationRepository`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        client: DynamoArchiveClient,
        table_name: str,
        *,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            client: Cliente externo que executa a operação de infraestrutura.
            table_name: Nome validado do recurso, campo ou operação correspondente.
            clock: Função injetável que fornece o instante atual para validação e testes.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(table_name, str):
            raise TypeError("table_name must be a string")
        if not table_name:
            raise ValueError("table_name must not be empty")
        if not callable(clock):
            raise TypeError("clock must be callable")
        self._client = client
        self._table_name = table_name
        self._clock = clock

    def _archive(self, version: str, dataset: str, partition: str) -> ArchivePartition:
        """Executa a etapa interna ``archive`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            version: Entrada ``version``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            dataset: Nome do dataset permitido pelo registro de contratos.
            partition: Identificador canônico da partição física ou lógica.

        Returns:
            Valor ``ArchivePartition`` produzido pela operação após as validações.

        Raises:
            ArchiveNotAvailable: Se a operação não puder preservar as invariantes descritas.
        """
        raw = _get(self._client, self._table_name, _archive_pk(version, dataset, partition), "META")
        if raw is None:
            raise ArchiveNotAvailable("archive partition is missing")
        archive = _decode_archive_item(raw, catalog=False)
        if archive.state is not ArchiveState.AVAILABLE:
            raise ArchiveNotAvailable("archive partition is not AVAILABLE")
        reconciliation = archive.metadata.get("reconciliation")
        if (
            not isinstance(reconciliation, Mapping)
            or reconciliation.get("state") != "PASSED"
            or archive.metadata.get("expirationEligible") is not True
        ):
            raise ArchiveNotAvailable("archive partition is not reconciled and eligible")
        return archive

    @staticmethod
    def _sealed_gate(
        table_name: str,
        version: str,
        dataset: str,
        partition: str,
        generation: int,
        digest: str,
        ttl_value: int,
        authorization_fingerprint: str,
    ) -> dict[str, object]:
        """Executa a etapa interna ``sealed_gate`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            table_name: Nome validado do recurso, campo ou operação correspondente.
            version: Entrada ``version``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            dataset: Nome do dataset permitido pelo registro de contratos.
            partition: Identificador canônico da partição física ou lógica.
            generation: Entrada ``generation``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.
            digest: Entrada ``digest``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            ttl_value: Entrada ``ttl_value``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            authorization_fingerprint: Entrada ``authorization_fingerprint``; a forma aceita é
            definida pela anotação de tipo e validada antes do uso.

        Returns:
            Valor ``dict[str, object]`` produzido pela operação após as validações.
        """
        return {
            "ConditionCheck": {
                "TableName": table_name,
                "Key": {
                    "pk": {"S": _retention_pk(version, dataset, partition)},
                    "sk": {"S": "META"},
                },
                "ConditionExpression": (
                    "catalogGeneration = :generation AND catalogDigest = :digest "
                    "AND authorizedTtl = :ttl AND authorizationFingerprint = :authorization"
                ),
                "ExpressionAttributeValues": {
                    ":generation": {"N": str(generation)},
                    ":digest": {"S": digest},
                    ":ttl": {"N": str(ttl_value)},
                    ":authorization": {"S": authorization_fingerprint},
                },
            }
        }

    @staticmethod
    def _closed_archive_gate(
        table_name: str,
        version: str,
        dataset: str,
        partition: str,
        generation: int,
        digest: str,
    ) -> dict[str, object]:
        """Executa a etapa interna ``closed_archive_gate`` e devolve o resultado validado
        indicado pela assinatura.

        Args:
            table_name: Nome validado do recurso, campo ou operação correspondente.
            version: Entrada ``version``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            dataset: Nome do dataset permitido pelo registro de contratos.
            partition: Identificador canônico da partição física ou lógica.
            generation: Entrada ``generation``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.
            digest: Entrada ``digest``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``dict[str, object]`` produzido pela operação após as validações.
        """
        return {
            "ConditionCheck": {
                "TableName": table_name,
                "Key": {
                    "pk": {"S": _archive_pk(version, dataset, partition)},
                    "sk": {"S": "META"},
                },
                "ConditionExpression": (
                    "#state = :available AND metadata.reconciliation.#result = :passed "
                    "AND metadata.expirationEligible = :true "
                    "AND metadata.catalogGeneration = :generation "
                    "AND metadata.catalogDigest = :digest"
                ),
                "ExpressionAttributeNames": {"#state": "state", "#result": "state"},
                "ExpressionAttributeValues": {
                    ":available": {"S": ArchiveState.AVAILABLE.value},
                    ":passed": {"S": "PASSED"},
                    ":true": {"BOOL": True},
                    ":generation": {"N": str(generation)},
                    ":digest": {"S": digest},
                },
            }
        }

    def _dependency_gates(
        self,
        version: str,
        dependencies: Sequence[ArchiveIdentity],
        ttl_value: int,
        authorization_fingerprint: str,
    ) -> list[dict[str, object]]:
        """Executa a etapa interna ``dependency_gates`` e devolve o resultado validado indicado
        pela assinatura.

        Args:
            version: Entrada ``version``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            dependencies: Entrada ``dependencies``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            ttl_value: Entrada ``ttl_value``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            authorization_fingerprint: Entrada ``authorization_fingerprint``; a forma aceita é
            definida pela anotação de tipo e validada antes do uso.

        Returns:
            Valor ``list[dict[str, object]]`` produzido pela operação após as validações.

        Raises:
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        gates: list[dict[str, object]] = []
        for dependency_dataset, dependency_partition in sorted(set(dependencies)):
            archive = self._archive(version, dependency_dataset, dependency_partition)
            generation = archive.metadata.get("catalogGeneration")
            digest = archive.metadata.get("catalogDigest")
            if isinstance(generation, bool) or not isinstance(generation, int):
                raise DynamoControlProtocolError("archive catalog generation is invalid")
            if not isinstance(digest, str):
                raise DynamoControlProtocolError("archive catalog digest is invalid")
            gates.extend(
                (
                    self._closed_archive_gate(
                        self._table_name,
                        version,
                        dependency_dataset,
                        dependency_partition,
                        generation,
                        digest,
                    ),
                    self._sealed_gate(
                        self._table_name,
                        version,
                        dependency_dataset,
                        dependency_partition,
                        generation,
                        digest,
                        ttl_value,
                        authorization_fingerprint,
                    ),
                )
            )
        return gates

    def _claim_authorization(
        self,
        version: str,
        dependencies: Sequence[ArchiveIdentity],
        ttl_value: int,
        authorization_fingerprint: str,
        owner: str,
    ) -> None:
        """Executa a etapa interna ``claim_authorization`` e valida seus efeitos antes de
        concluir.

        Args:
            version: Entrada ``version``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            dependencies: Entrada ``dependencies``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            ttl_value: Entrada ``ttl_value``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            authorization_fingerprint: Entrada ``authorization_fingerprint``; a forma aceita é
            definida pela anotação de tipo e validada antes do uso.
            owner: Identidade do worker que possui ou solicita o lease.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
            ValueError: Se um valor estiver fora das invariantes aceitas.
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
        """
        actions: list[dict[str, object]] = []
        for dependency_dataset, dependency_partition in sorted(set(dependencies)):
            archive = self._archive(version, dependency_dataset, dependency_partition)
            generation = archive.metadata.get("catalogGeneration")
            digest = archive.metadata.get("catalogDigest")
            if isinstance(generation, bool) or not isinstance(generation, int):
                raise DynamoControlProtocolError("archive catalog generation is invalid")
            if not isinstance(digest, str):
                raise DynamoControlProtocolError("archive catalog digest is invalid")
            actions.append(
                {
                    "Update": {
                        "TableName": self._table_name,
                        "Key": {
                            "pk": {
                                "S": _retention_pk(
                                    version, dependency_dataset, dependency_partition
                                )
                            },
                            "sk": {"S": "META"},
                        },
                        "UpdateExpression": (
                            "SET authorizedTtl = if_not_exists(authorizedTtl, :ttl), "
                            "authorizationFingerprint = "
                            "if_not_exists(authorizationFingerprint, :authorization), "
                            "authorizationOwner = if_not_exists(authorizationOwner, :owner)"
                        ),
                        "ConditionExpression": (
                            "catalogGeneration = :generation AND catalogDigest = :digest AND "
                            "(attribute_not_exists(authorizedTtl) OR "
                            "(authorizedTtl = :ttl AND "
                            "authorizationFingerprint = :authorization))"
                        ),
                        "ExpressionAttributeValues": {
                            ":generation": {"N": str(generation)},
                            ":digest": {"S": digest},
                            ":ttl": {"N": str(ttl_value)},
                            ":authorization": {"S": authorization_fingerprint},
                            ":owner": {"S": owner},
                        },
                    }
                }
            )
        if not actions or len(actions) > 100:
            raise ValueError("TTL authorization claim exceeds transaction limits")
        try:
            validate_transaction_response(self._client.transact_write_items(TransactItems=actions))
        except ClientError as error:
            raise_if_dynamodb_throttled(error)
            code = error.response.get("Error", {}).get("Code")
            if code not in {"ConditionalCheckFailedException", "TransactionCanceledException"}:
                raise
            failures = _cancellation_positions(
                error.response.get("CancellationReasons"), len(actions)
            )
            if code == "TransactionCanceledException" and failures is None:
                raise
            raise ConditionalWriteError(
                "archive partition is already authorized with a different TTL"
            ) from None

    def _write_chunk(
        self,
        *,
        targets: Sequence[SerializedKey],
        dependencies: Sequence[ArchiveIdentity],
        version: str,
        ttl_value: int,
        operation_pk: str,
        operation_fingerprint: str,
        generation: int,
        catalog_digest: str,
        chunk_index: int,
        completed_before: int,
        planned_target_count: int,
        authorization_fingerprint: str,
    ) -> None:
        """Grava chunk e devolve a evidência produzida pela operação.

        Args:
            targets: Entrada ``targets``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            dependencies: Entrada ``dependencies``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            version: Entrada ``version``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            ttl_value: Entrada ``ttl_value``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            operation_pk: Entrada ``operation_pk``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            operation_fingerprint: Entrada ``operation_fingerprint``; a forma aceita é definida
            pela anotação de tipo e validada antes do uso.
            generation: Entrada ``generation``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.
            catalog_digest: Entrada ``catalog_digest``; a forma aceita é definida pela anotação
            de tipo e validada antes do uso.
            chunk_index: Entrada ``chunk_index``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            completed_before: Entrada ``completed_before``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.
            planned_target_count: Quantidade inteira não negativa usada na reconciliação.
            authorization_fingerprint: Entrada ``authorization_fingerprint``; a forma aceita é
            definida pela anotação de tipo e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
            ValueError: Se um valor estiver fora das invariantes aceitas.
            ArchiveNotAvailable: Se a operação não puder preservar as invariantes descritas.
        """
        gates = self._dependency_gates(version, dependencies, ttl_value, authorization_fingerprint)
        progress: dict[str, object] = {
            "pk": operation_pk,
            "sk": f"PROGRESS#{chunk_index:08d}",
            "entityType": "TTL_PROGRESS",
            "fingerprint": operation_fingerprint,
            "catalogGeneration": generation,
            "catalogDigest": catalog_digest,
            "ttlValue": ttl_value,
            "targetCount": len(targets),
            "targetDigest": _fingerprint(
                [(cast(str, key["pk"]["S"]), cast(str, key["sk"]["S"])) for key in targets]
            ),
        }
        progress_values = serialize_item(progress)
        actions: list[dict[str, object]] = list(gates)
        for target in targets:
            actions.append(
                {
                    "Update": {
                        "TableName": self._table_name,
                        "Key": target,
                        "UpdateExpression": "SET #ttl = :ttl",
                        "ConditionExpression": (
                            "attribute_exists(pk) AND datasetVersion = :version"
                        ),
                        "ExpressionAttributeNames": {"#ttl": "ttl"},
                        "ExpressionAttributeValues": {
                            ":ttl": {"N": str(ttl_value)},
                            ":version": {"S": version},
                        },
                    }
                }
            )
        stored_progress = _get(
            self._client, self._table_name, operation_pk, f"PROGRESS#{chunk_index:08d}"
        )
        if stored_progress is None:
            actions.append(
                {
                    "Update": {
                        "TableName": self._table_name,
                        "Key": {"pk": {"S": operation_pk}, "sk": {"S": "SUMMARY"}},
                        "UpdateExpression": (
                            "SET entityType = :type, fingerprint = :fingerprint, "
                            "catalogGeneration = :generation, catalogDigest = :digest, "
                            "ttlValue = :ttl, plannedTargetCount = :planned, "
                            "completedTargetCount = :completed, completedChunks = :chunks"
                        ),
                        "ConditionExpression": (
                            "attribute_not_exists(pk) OR "
                            "(fingerprint = :fingerprint AND catalogGeneration = :generation "
                            "AND catalogDigest = :digest AND ttlValue = :ttl "
                            "AND plannedTargetCount = :planned "
                            "AND completedTargetCount = :before AND completedChunks = :index)"
                        ),
                        "ExpressionAttributeValues": {
                            ":type": {"S": "TTL_PROGRESS_SUMMARY"},
                            ":fingerprint": {"S": operation_fingerprint},
                            ":generation": {"N": str(generation)},
                            ":digest": {"S": catalog_digest},
                            ":ttl": {"N": str(ttl_value)},
                            ":planned": {"N": str(planned_target_count)},
                            ":before": {"N": str(completed_before)},
                            ":completed": {"N": str(completed_before + len(targets))},
                            ":index": {"N": str(chunk_index)},
                            ":chunks": {"N": str(chunk_index + 1)},
                        },
                    }
                }
            )
            actions.append(
                {
                    "Put": {
                        "TableName": self._table_name,
                        "Item": progress_values,
                        "ConditionExpression": "attribute_not_exists(pk)",
                    },
                }
            )
        else:
            if stored_progress != progress:
                raise ConditionalWriteError("TTL chunk progress differs from persisted evidence")
            actions.append(
                {
                    "ConditionCheck": {
                        "TableName": self._table_name,
                        "Key": {
                            "pk": {"S": operation_pk},
                            "sk": {"S": f"PROGRESS#{chunk_index:08d}"},
                        },
                        "ConditionExpression": (
                            "fingerprint = :fingerprint AND catalogGeneration = :generation "
                            "AND catalogDigest = :digest AND ttlValue = :ttl "
                            "AND targetCount = :count AND targetDigest = :targetDigest"
                        ),
                        "ExpressionAttributeValues": {
                            ":fingerprint": {"S": operation_fingerprint},
                            ":generation": {"N": str(generation)},
                            ":digest": {"S": catalog_digest},
                            ":ttl": {"N": str(ttl_value)},
                            ":count": {"N": str(len(targets))},
                            ":targetDigest": progress_values["targetDigest"],
                        },
                    }
                }
            )
        if len(actions) > 100:
            raise ValueError("TTL chunk exceeds DynamoDB transaction limits")
        try:
            validate_transaction_response(self._client.transact_write_items(TransactItems=actions))
        except ClientError as error:
            raise_if_dynamodb_throttled(error)
            code = error.response.get("Error", {}).get("Code")
            if code not in {"ConditionalCheckFailedException", "TransactionCanceledException"}:
                raise
            failures = _cancellation_positions(
                error.response.get("CancellationReasons"), len(actions)
            )
            if code == "TransactionCanceledException" and failures is None:
                raise
            if code == "ConditionalCheckFailedException" or (
                failures is not None and any(position < len(gates) for position in failures)
            ):
                raise ArchiveNotAvailable(
                    "archive AVAILABLE/reconciliation seal changed during TTL mutation"
                ) from None
            raise ConditionalWriteError("TTL target or progress changed concurrently") from None

    @staticmethod
    def _completion_result(
        count: int, ttl_value: int, generation: int, catalog_digest: str
    ) -> dict[str, object]:
        """Consolida o resultado de completion a partir das evidências acumuladas.

        Args:
            count: Entrada ``count``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            ttl_value: Entrada ``ttl_value``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            generation: Entrada ``generation``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.
            catalog_digest: Entrada ``catalog_digest``; a forma aceita é definida pela anotação
            de tipo e validada antes do uso.

        Returns:
            Valor ``dict[str, object]`` produzido pela operação após as validações.
        """
        return {
            "kind": "ttl",
            "targetCount": count,
            "ttlValue": ttl_value,
            "catalogGeneration": generation,
            "catalogDigest": catalog_digest,
        }

    def authorize_expiration(
        self,
        dataset_version: str,
        dataset: str,
        partition: str,
        ttl_epoch_s: int,
        *,
        expected_archive_state: ArchiveState,
        idempotency_key: str,
    ) -> int:
        """Autoriza expiração somente após validar as evidências exigidas.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            dataset: Nome do dataset permitido pelo registro de contratos.
            partition: Identificador canônico da partição física ou lógica.
            ttl_epoch_s: Entrada ``ttl_epoch_s``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            expected_archive_state: Valor esperado usado para detectar concorrência ou
            divergência de estado.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``int`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ArchiveNotAvailable: Se a operação não puder preservar as invariantes descritas.
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        version = require_key_component(dataset_version, "dataset_version")
        dataset_name = require_key_component(dataset, "dataset")
        partition_date(partition)
        ttl_value = _ttl(ttl_epoch_s)
        if not isinstance(expected_archive_state, ArchiveState):
            raise TypeError("expected_archive_state must be an ArchiveState")
        if expected_archive_state is not ArchiveState.AVAILABLE:
            raise ArchiveNotAvailable("expected_archive_state must be AVAILABLE")
        key = _idempotency_key(idempotency_key)
        fingerprint = _fingerprint(
            {
                "datasetVersion": version,
                "dataset": dataset_name,
                "partition": partition,
                "ttl": ttl_value,
                "expectedArchiveState": expected_archive_state.value,
            }
        )
        replay = _replay(self._client, self._table_name, "hot-expiration", key, fingerprint)
        archive = self._archive(version, dataset_name, partition)
        generation = archive.metadata.get("catalogGeneration")
        sealed_digest = archive.metadata.get("catalogDigest")
        if isinstance(generation, bool) or not isinstance(generation, int) or generation <= 0:
            raise DynamoControlProtocolError("archive catalog generation is invalid")
        if not isinstance(sealed_digest, str):
            raise DynamoControlProtocolError("archive catalog digest is invalid")
        fact_targets, projection_targets, discovered_digest = _catalog_snapshot(
            self._client,
            self._table_name,
            version,
            dataset_name,
            partition,
            generation,
        )
        if discovered_digest != sealed_digest:
            raise ConditionalWriteError("hot catalog changed after reconciliation seal")
        expected_facts = archive.metadata.get("hotItemCount")
        expected_projections = archive.metadata.get("projectionItemCount")
        if len(fact_targets) != expected_facts or len(projection_targets) != expected_projections:
            raise ConditionalWriteError("hot catalog target count differs from archive catalog")
        target_count = len(fact_targets) + len(projection_targets)
        completion_result = self._completion_result(
            target_count, ttl_value, generation, sealed_digest
        )
        if replay is not None and replay != completion_result:
            raise DynamoControlProtocolError("DynamoDB TTL replay result is invalid")
        final_dependencies = tuple(
            sorted(
                {
                    (dataset_name, partition),
                    *(
                        dependency
                        for _projection, dependencies in projection_targets
                        for dependency in dependencies
                    ),
                }
            )
        )
        if len(final_dependencies) > 48:
            raise ValueError("TTL dependency set exceeds the safe transactional limit of 48")
        operation_pk = _marker_pk("hot-expiration", key)
        authorization_fingerprint = _fingerprint(
            {"datasetVersion": version, "partition": partition, "ttl": ttl_value}
        )
        self._claim_authorization(
            version,
            final_dependencies,
            ttl_value,
            authorization_fingerprint,
            operation_pk,
        )
        chunk_index = 0
        completed_count = 0
        for start in range(0, len(fact_targets), _MAX_TRANSACTION_TARGETS):
            chunk = fact_targets[start : start + _MAX_TRANSACTION_TARGETS]
            self._write_chunk(
                targets=chunk,
                dependencies=((dataset_name, partition),),
                version=version,
                ttl_value=ttl_value,
                operation_pk=operation_pk,
                operation_fingerprint=fingerprint,
                generation=generation,
                catalog_digest=sealed_digest,
                chunk_index=chunk_index,
                completed_before=completed_count,
                planned_target_count=target_count,
                authorization_fingerprint=authorization_fingerprint,
            )
            completed_count += len(chunk)
            chunk_index += 1
        for projection_target, dependencies in projection_targets:
            self._write_chunk(
                targets=(projection_target,),
                dependencies=dependencies,
                version=version,
                ttl_value=ttl_value,
                operation_pk=operation_pk,
                operation_fingerprint=fingerprint,
                generation=generation,
                catalog_digest=sealed_digest,
                chunk_index=chunk_index,
                completed_before=completed_count,
                planned_target_count=target_count,
                authorization_fingerprint=authorization_fingerprint,
            )
            completed_count += 1
            chunk_index += 1

        # Ainda não existe evidência de sucesso. Redescobrimos o conjunto fechado e lemos cada
        # destino após a Query, para observar uma mutação ocorrida durante o snapshot final.
        final_facts, final_projections, final_digest = _catalog_snapshot(
            self._client,
            self._table_name,
            version,
            dataset_name,
            partition,
            generation,
        )
        if (
            final_digest != sealed_digest
            or final_facts != fact_targets
            or final_projections != projection_targets
        ):
            raise ConditionalWriteError("hot catalog changed while applying TTL")
        all_targets = (*fact_targets, *(target for target, _dependencies in projection_targets))
        for target in all_targets:
            current = _get(
                self._client,
                self._table_name,
                cast(str, target["pk"]["S"]),
                cast(str, target["sk"]["S"]),
            )
            if (
                current is None
                or current.get("datasetVersion") != version
                or current.get("ttl") != ttl_value
            ):
                raise ConditionalWriteError("TTL target changed during final verification")
        completion = _marker(
            "hot-expiration",
            key,
            fingerprint,
            completion_result,
            self._clock,
        )
        final_items = self._dependency_gates(
            version, final_dependencies, ttl_value, authorization_fingerprint
        )
        if completed_count:
            final_items.append(
                {
                    "ConditionCheck": {
                        "TableName": self._table_name,
                        "Key": {"pk": {"S": operation_pk}, "sk": {"S": "SUMMARY"}},
                        "ConditionExpression": (
                            "fingerprint = :fingerprint AND catalogGeneration = :generation "
                            "AND catalogDigest = :digest AND ttlValue = :ttl "
                            "AND plannedTargetCount = :count AND completedTargetCount = :count "
                            "AND completedChunks = :chunks"
                        ),
                        "ExpressionAttributeValues": {
                            ":fingerprint": {"S": fingerprint},
                            ":generation": {"N": str(generation)},
                            ":digest": {"S": sealed_digest},
                            ":ttl": {"N": str(ttl_value)},
                            ":count": {"N": str(completed_count)},
                            ":chunks": {"N": str(chunk_index)},
                        },
                    }
                }
            )
        if replay is None:
            final_items.append(_marker_put(completion, self._table_name))
        else:
            final_items.append(
                {
                    "ConditionCheck": {
                        "TableName": self._table_name,
                        "Key": {"pk": {"S": operation_pk}, "sk": {"S": "META"}},
                        "ConditionExpression": "fingerprint = :fingerprint AND #result = :result",
                        "ExpressionAttributeNames": {"#result": "result"},
                        "ExpressionAttributeValues": {
                            ":fingerprint": {"S": fingerprint},
                            ":result": serialize_item({"value": completion_result})["value"],
                        },
                    }
                }
            )
        try:
            validate_transaction_response(
                self._client.transact_write_items(TransactItems=final_items)
            )
        except ClientError as error:
            raise_if_dynamodb_throttled(error)
            code = error.response.get("Error", {}).get("Code")
            if code not in {"ConditionalCheckFailedException", "TransactionCanceledException"}:
                raise
            replay_after_failure = _replay(
                self._client, self._table_name, "hot-expiration", key, fingerprint
            )
            if replay_after_failure == completion_result and replay is None:
                return target_count
            failures = _cancellation_positions(
                error.response.get("CancellationReasons"), len(final_items)
            )
            if code == "TransactionCanceledException" and failures is None:
                raise
            raise ConditionalWriteError("TTL completion evidence changed concurrently") from None
        return target_count


__all__ = [
    "DynamoArchivePartitionRepository",
    "DynamoHotExpirationRepository",
    "encode_projection_partition_catalog",
    "encode_projection_target_set_catalog",
]
