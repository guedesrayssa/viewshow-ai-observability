"""Converte registros canônicos e metadados para o formato de atributos do DynamoDB.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Mapping
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any, cast

from boto3.dynamodb.types import TypeSerializer  # type: ignore[import-untyped]

from domain.identity import payload_hash, record_id
from domain.models import CanonicalRecord, RecordType

type DynamoItem = dict[str, object]
type AttributeValue = dict[str, Any]
type SerializedItem = dict[str, AttributeValue]

_MAX_PARTITION_KEY_BYTES = 2048
_MAX_SORT_KEY_BYTES = 1024
_MAX_INTERNAL_ITEM_BYTES = 200 * 1024
_TEMPORAL_PARTITION = re.compile(
    r"^year=(?P<year>[0-9]{4})/month=(?P<month>[0-9]{2})/day=(?P<day>[0-9]{2})$"
)
_SNAPSHOT_PARTITION = re.compile(
    r"^snapshot_date=(?P<year>[0-9]{4})-(?P<month>[0-9]{2})-(?P<day>[0-9]{2})$"
)
_FAMILY_BY_RECORD_TYPE: Mapping[RecordType, str] = {
    RecordType.SIGNAL_OBSERVATION: "FACT#TS",
    RecordType.DIMENSIONAL_METRIC_AGGREGATE: "FACT#TS",
    RecordType.APPLICATION_ERROR_AGGREGATE: "FACT#TS",
    RecordType.SHADOW_OBSERVATION: "FACT#TS",
    RecordType.INCIDENT: "INCIDENT#TS",
    RecordType.LIVE_EVENT_CONTEXT: "CONTEXT#TS",
    RecordType.FINDING_STATUS_TRANSITION: "CONTEXT#TS",
    RecordType.UPSTREAM_SOURCE_HEALTH: "INGESTION#SOURCE",
    RecordType.UPSTREAM_COLLECTOR_RUN: "INGESTION#SOURCE",
}
_SERIALIZER = TypeSerializer()


class DynamoEncodingError(ValueError):
    """Indica que ``DynamoEncodingError`` impediu a operação de continuar com segurança."""


class EncodedKeyTooLarge(DynamoEncodingError):
    """Indica que ``EncodedKeyTooLarge`` impediu a operação de continuar com segurança."""


class EncodedItemTooLarge(DynamoEncodingError):
    """Indica que ``EncodedItemTooLarge`` impediu a operação de continuar com segurança."""


def _partition_date(partition: str) -> date:
    """Obtém a data de partição após validar o calendário e o formato.

    Args:
        partition: Identificador canônico da partição física ou lógica.

    Returns:
        Valor ``date`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(partition, str):
        raise TypeError("partition must be a string")
    matched = _TEMPORAL_PARTITION.fullmatch(partition) or _SNAPSHOT_PARTITION.fullmatch(partition)
    if matched is None:
        raise ValueError("partition must use year=YYYY/month=MM/day=DD or snapshot_date=YYYY-MM-DD")
    try:
        return date(
            int(matched.group("year")),
            int(matched.group("month")),
            int(matched.group("day")),
        )
    except ValueError as error:
        raise ValueError("partition contains an invalid calendar date") from error


def validate_partition(partition: str) -> None:
    """Valida partição contra as invariantes deste módulo.

    Args:
        partition: Identificador canônico da partição física ou lógica.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.
    """
    _partition_date(partition)


def _require_key_component(value: object, field: str) -> str:
    """Valida e devolve chave component, rejeitando entradas fora do contrato.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    if not value:
        raise ValueError(f"{field} must not be empty")
    if "#" in value or any(character.isspace() for character in value):
        raise ValueError(f"{field} must not contain key delimiters or whitespace")
    return value


def _utc_text(value: datetime) -> str:
    """Converte utc para sua representação textual canônica.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError("datetime values must be aware UTC datetimes")
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _epoch_milliseconds(value: datetime) -> int:
    """Executa a etapa interna ``epoch_milliseconds`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``int`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError("datetime values must be aware UTC datetimes")
    delta = value.astimezone(UTC) - datetime(1970, 1, 1, tzinfo=UTC)
    return delta.days * 86_400_000 + delta.seconds * 1_000 + delta.microseconds // 1_000


def _dynamo_value(value: object) -> object:
    """Produz o valor de dynamo usado pela etapa seguinte.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``object`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    if value is None or isinstance(value, str | bool):
        return value
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError("Decimal values must be finite")
        return value
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("float values must be finite")
        return Decimal(str(value))
    if isinstance(value, datetime):
        return _utc_text(value)
    if isinstance(value, Mapping):
        normalized: dict[str, object] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError("DynamoDB map keys must be strings")
            normalized[key] = _dynamo_value(item)
        return normalized
    if isinstance(value, list | tuple):
        return [_dynamo_value(item) for item in value]
    raise TypeError(f"unsupported DynamoDB value: {type(value).__name__}")


def serialize_item(item: Mapping[str, object]) -> SerializedItem:
    """Serializa item de maneira determinística.

    Args:
        item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``SerializedItem`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    serialized: SerializedItem = {}
    for key, value in item.items():
        if not isinstance(key, str):
            raise TypeError("DynamoDB attribute names must be strings")
        serialized[key] = cast(AttributeValue, _SERIALIZER.serialize(value))
    return serialized


def serialized_item_bytes(item: SerializedItem) -> int:
    """Converte serialized item para sua representação binária determinística.

    Args:
        item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``int`` produzido pela operação após as validações.
    """
    return len(
        json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    )


def _validate_encoded_item(item: DynamoItem) -> DynamoItem:
    """Valida encoded item contra as invariantes deste módulo.

    Args:
        item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``DynamoItem`` produzido pela operação após as validações.

    Raises:
        DynamoEncodingError: Se a operação não puder preservar as invariantes descritas.
        EncodedKeyTooLarge: Se a operação não puder preservar as invariantes descritas.
        EncodedItemTooLarge: Se a operação não puder preservar as invariantes descritas.
    """
    pk = item.get("pk")
    sk = item.get("sk")
    if not isinstance(pk, str) or not isinstance(sk, str):
        raise DynamoEncodingError("encoded items require string pk and sk")
    pk_bytes = len(pk.encode("utf-8"))
    sk_bytes = len(sk.encode("utf-8"))
    if pk_bytes > _MAX_PARTITION_KEY_BYTES:
        raise EncodedKeyTooLarge(
            f"partition key uses {pk_bytes} bytes; DynamoDB permits at most 2048"
        )
    if sk_bytes > _MAX_SORT_KEY_BYTES:
        raise EncodedKeyTooLarge(f"sort key uses {sk_bytes} bytes; DynamoDB permits at most 1024")
    encoded_bytes = serialized_item_bytes(serialize_item(item))
    if encoded_bytes > _MAX_INTERNAL_ITEM_BYTES:
        raise EncodedItemTooLarge(
            f"encoded item uses {encoded_bytes} bytes; internal limit is 200 KiB"
        )
    return item


def _record_timestamp(record: CanonicalRecord, partition_date: date) -> datetime:
    """Obtém ou registra timestamp como evidência da execução atual.

    Args:
        record: Registro canônico consumido pela operação.
        partition_date: Data civil usada para particionamento ou proveniência.

    Returns:
        Valor ``datetime`` produzido pela operação após as validações.
    """
    if record.observed_at is not None:
        return record.observed_at
    return datetime(
        partition_date.year,
        partition_date.month,
        partition_date.day,
        tzinfo=UTC,
    )


def encode_hot_record(
    record: CanonicalRecord,
    dataset_version: str,
    partition: str,
) -> DynamoItem:
    """Codifica quente registro no formato persistido pela camada de destino.

    Args:
        record: Registro canônico consumido pela operação.
        dataset_version: Identificador imutável da versão do dataset.
        partition: Identificador canônico da partição física ou lógica.

    Returns:
        Valor ``DynamoItem`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(record, CanonicalRecord):
        raise TypeError("record must be a CanonicalRecord")
    version = _require_key_component(dataset_version, "dataset_version")
    dataset = _require_key_component(record.source_dataset, "source_dataset")
    partition_day = _partition_date(partition)
    try:
        family = _FAMILY_BY_RECORD_TYPE[record.record_type]
    except KeyError as error:
        raise ValueError(f"unsupported record type: {record.record_type!r}") from error
    identity = record_id(record)
    observed = _record_timestamp(record, partition_day)
    day = partition_day.strftime("%Y%m%d")
    pk = f"DATASET#{version}#{family}#{dataset}#{day}"
    sk = f"TS#{_epoch_milliseconds(observed)}#{identity}"
    window: object = None
    if record.window is not None:
        window = {
            "start": _utc_text(record.window.start),
            "end": _utc_text(record.window.end),
            "grainSeconds": record.window.grain_seconds,
        }
    raw_item: DynamoItem = {
        "pk": pk,
        "sk": sk,
        "entityType": "HOT_RECORD",
        "recordId": identity,
        "payloadHash": payload_hash(record),
        "datasetVersion": version,
        "schemaVersion": record.schema_version,
        "recordType": record.record_type.value,
        "sourceSystem": record.source_system,
        "sourceDataset": dataset,
        "naturalKey": [{"name": name, "value": value} for name, value in record.natural_key],
        "observedAt": _utc_text(record.observed_at) if record.observed_at is not None else None,
        "window": window,
        "dimensions": record.dimensions,
        "measures": record.measures,
        "quality": record.quality,
        "qualityFlags": list(record.quality_flags),
    }
    return _validate_encoded_item(cast(DynamoItem, _dynamo_value(raw_item)))


def encode_hot_partition_catalog(
    dataset_version: str,
    dataset: str,
    partition: str,
    hot_pk: str,
    *,
    catalog_generation: int = 1,
    target_count: int | None = None,
    target_digest: str | None = None,
) -> DynamoItem:
    """Codifica quente partição catálogo no formato persistido pela camada de destino.

    Args:
        dataset_version: Identificador imutável da versão do dataset.
        dataset: Nome do dataset permitido pelo registro de contratos.
        partition: Identificador canônico da partição física ou lógica.
        hot_pk: Entrada ``hot_pk``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        catalog_generation: Entrada ``catalog_generation``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        target_count: Quantidade inteira não negativa usada na reconciliação.
        target_digest: Entrada ``target_digest``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.

    Returns:
        Valor ``DynamoItem`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    version = _require_key_component(dataset_version, "dataset_version")
    dataset_name = _require_key_component(dataset, "dataset")
    if not isinstance(hot_pk, str) or not hot_pk:
        raise ValueError("hot_pk must be a non-empty string")
    partition_day = _partition_date(partition)
    day = partition_day.strftime("%Y%m%d")
    if isinstance(catalog_generation, bool) or not isinstance(catalog_generation, int):
        raise TypeError("catalog_generation must be an integer")
    if catalog_generation <= 0:
        raise ValueError("catalog_generation must be positive")
    if target_count is not None and (
        isinstance(target_count, bool) or not isinstance(target_count, int) or target_count < 0
    ):
        raise ValueError("target_count must be a non-negative integer")
    if target_digest is not None and re.fullmatch(r"[0-9a-f]{64}", target_digest) is None:
        raise ValueError("target_digest must be a lowercase SHA-256 digest")
    if (target_count is None) != (target_digest is None):
        raise ValueError("target_count and target_digest must be provided together")
    permitted = {
        f"DATASET#{version}#{family}#{dataset_name}#{day}"
        for family in ("FACT#TS", "INCIDENT#TS", "CONTEXT#TS", "INGESTION#SOURCE")
    }
    if hot_pk not in permitted:
        raise ValueError("hot_pk must identify the exact version, dataset, family, and day")
    pk = f"DATASET#{version}#INGESTION#HOTPART#{dataset_name}#{day}"
    sk = "PK#" + hashlib.sha256(hot_pk.encode("utf-8")).hexdigest()
    item: DynamoItem = {
        "pk": pk,
        "sk": sk,
        "entityType": "HOT_PARTITION",
        "datasetVersion": version,
        "dataset": dataset_name,
        "partition": partition,
        "partitionDate": partition_day.isoformat(),
        "hotPk": hot_pk,
        "catalogGeneration": catalog_generation,
    }
    if target_count is not None and target_digest is not None:
        item["targetCount"] = target_count
        item["targetDigest"] = target_digest
    return _validate_encoded_item(item)


__all__ = [
    "AttributeValue",
    "DynamoEncodingError",
    "DynamoItem",
    "EncodedItemTooLarge",
    "EncodedKeyTooLarge",
    "SerializedItem",
    "encode_hot_partition_catalog",
    "encode_hot_record",
    "serialize_item",
    "serialized_item_bytes",
    "validate_partition",
]
