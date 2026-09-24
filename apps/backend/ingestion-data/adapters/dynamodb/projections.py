"""Lê fatos quentes e publica projeções operacionais versionadas no DynamoDB.

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
from collections.abc import Callable, Iterator, Mapping
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any, Protocol, cast

from boto3.dynamodb.types import TypeDeserializer  # type: ignore[import-untyped]
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from adapters.dynamodb.archive_partitions import encode_projection_target_set_catalog
from adapters.dynamodb.client import (
    DynamoControlProtocolError,
    decode_get_item,
    raise_if_dynamodb_throttled,
    validate_transaction_response,
)
from adapters.dynamodb.codec import serialize_item, serialized_item_bytes
from domain.archive import partition_date, require_key_component
from domain.archive_records import ARCHIVE_SHAPES
from domain.canonical_json import canonical_bytes
from domain.identity import payload_hash, record_id
from domain.models import CanonicalRecord, CanonicalValue, RecordType, Scalar, TimeWindow
from ports import (
    ArchiveDependency,
    ConditionalWriteError,
    CurrentProjection,
    EventProjectionItem,
    IdempotencyConflict,
    Projection,
    ProjectionRepository,
)

type AttributeValue = dict[str, Any]
type SerializedKey = dict[str, AttributeValue]

_DESERIALIZER = TypeDeserializer()
_FACT_PK = re.compile(
    r"^DATASET#(?P<version>[^#\s]+)#(?P<family>FACT#TS|INCIDENT#TS|CONTEXT#TS|"
    r"INGESTION#SOURCE)#(?P<dataset>[^#\s]+)#(?P<day>[0-9]{8})$"
)
_DAY = re.compile(r"^DAY#(?P<day>[0-9]{8})$")
_VIEW_KEY = re.compile(
    r"^(?:OVERVIEW#[^#\s]+|INCIDENTS#DAY|INCIDENTS#ACTIVE|"
    r"MONITORING#[^#\s]+|GEOGRAPHY#[^#\s]+)$"
)
_MATERIALIZATION_REVISION = re.compile(r"^pmr_[0-9a-f]{64}$")
_FAMILY = {
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
_DATETIME_MEASURES = frozenset(
    {
        "closed_at",
        "finished_at",
        "firstSeenAt",
        "last_run_at",
        "range_end",
        "range_end_ms",
        "range_start",
        "range_start_ms",
        "resolved_at",
        "updatedAt",
    }
)
_DECIMAL_MEASURES = frozenset(
    field
    for _, measures, _ in ARCHIVE_SHAPES.values()
    for field, kind in measures.items()
    if kind == "decimal"
)
_MAX_INPUT_PARTITIONS = 48
_MAX_PROJECTION_DEPENDENCIES = 47
_MAX_ACTIONS = 100
_MAX_ITEM_BYTES = 200 * 1024
_TRANSACTION_BUDGET = 4 * 1024 * 1024 - 64 * 1024
_MARKER_TTL_SECONDS = 90 * 24 * 60 * 60


class DynamoProjectionClient(Protocol):
    """Define o contrato mínimo de dynamo projeção cliente usado para injeção de dependência.

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


def _text(value: object, field: str) -> str:
    """Executa a etapa interna ``text`` e devolve o resultado validado indicado pela assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(value, str) or not value:
        raise DynamoControlProtocolError(f"DynamoDB projection {field} must be non-empty text")
    return value


def _projection_fence_key(dataset_version: str) -> tuple[str, str]:
    """Monta a chave de projeção fence a partir de componentes validados.

    Args:
        dataset_version: Identificador imutável da versão do dataset.

    Returns:
        Valor ``tuple[str, str]`` produzido pela operação após as validações.
    """
    return f"DATASET#{dataset_version}#INGESTION#PROJECTION_FENCE", "ACTIVE"


def _normalize_number(value: object) -> object:
    """Normaliza número para o modelo canônico da ingestão.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``object`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    if type(value) is Decimal:
        if not value.is_finite():
            raise DynamoControlProtocolError("DynamoDB projection contains a non-finite number")
        return int(value) if value == value.to_integral_value() else value
    if isinstance(value, Mapping):
        return {key: _normalize_number(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_normalize_number(item) for item in value]
    return value


def _decode_item(raw: object, context: str) -> dict[str, object]:
    """Decodifica item e valida sua forma antes de devolvê-lo.

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
            decoded[name] = _DESERIALIZER.deserialize(cast(dict[str, Any], attribute))
    except (KeyError, TypeError, ValueError) as error:
        raise DynamoControlProtocolError(
            f"DynamoDB {context} item contains an invalid AttributeValue"
        ) from error
    return decoded


def _utc(value: object, field: str) -> datetime:
    """Executa a etapa interna ``utc`` e devolve o resultado validado indicado pela assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``datetime`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(value, str):
        raise DynamoControlProtocolError(f"DynamoDB hot record {field} must be UTC text")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise DynamoControlProtocolError(f"DynamoDB hot record {field} is invalid") from error
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        raise DynamoControlProtocolError(f"DynamoDB hot record {field} must be UTC")
    return parsed.astimezone(UTC)


def _canonical_value(
    value: object, field: str, *, preserve_decimal: bool = False
) -> CanonicalValue:
    """Produz a representação canônica de valor.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.
        preserve_decimal: Entrada ``preserve_decimal``; a forma aceita é definida pela anotação
        de tipo e validada antes do uso.

    Returns:
        Valor ``CanonicalValue`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    if type(value) is Decimal:
        if not value.is_finite():
            raise DynamoControlProtocolError(f"DynamoDB hot record {field} is non-finite")
        if not preserve_decimal and value == value.to_integral_value():
            return int(value)
        return value
    if value is None or type(value) in {str, bool, int}:
        return cast(CanonicalValue, value)
    if isinstance(value, list):
        return [_canonical_value(item, field, preserve_decimal=preserve_decimal) for item in value]
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise DynamoControlProtocolError(f"DynamoDB hot record {field} has a non-text key")
        return {
            cast(str, key): _canonical_value(item, field, preserve_decimal=preserve_decimal)
            for key, item in value.items()
        }
    raise DynamoControlProtocolError(f"DynamoDB hot record {field} has an invalid value")


def _scalar(value: object, field: str) -> Scalar:
    """Executa a etapa interna ``scalar`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``Scalar`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    canonical = _canonical_value(value, field)
    if isinstance(canonical, Mapping | list | tuple):
        raise DynamoControlProtocolError(f"DynamoDB hot record {field} must be scalar")
    return canonical


def _canonical_record(item: Mapping[str, object], expected_pk: str) -> CanonicalRecord:
    """Produz a representação canônica de registro.

    Args:
        item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        expected_pk: Valor esperado usado para detectar concorrência ou divergência de estado.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
        ValueError: Se um valor estiver fora das invariantes aceitas.
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    fields = {
        "pk",
        "sk",
        "entityType",
        "recordId",
        "payloadHash",
        "datasetVersion",
        "schemaVersion",
        "recordType",
        "sourceSystem",
        "sourceDataset",
        "naturalKey",
        "observedAt",
        "window",
        "dimensions",
        "measures",
        "quality",
        "qualityFlags",
    }
    if (
        set(item) != fields
        or item.get("entityType") != "HOT_RECORD"
        or item.get("pk") != expected_pk
    ):
        raise DynamoControlProtocolError("DynamoDB hot record has an invalid shape or key")
    matched = _FACT_PK.fullmatch(expected_pk)
    assert matched is not None
    try:
        record_type = RecordType(_text(item.get("recordType"), "recordType"))
        if _FAMILY[record_type] != matched.group("family"):
            raise ValueError
        natural_raw = item.get("naturalKey")
        if not isinstance(natural_raw, list) or not natural_raw:
            raise TypeError
        natural: list[tuple[str, Scalar]] = []
        for part in natural_raw:
            if not isinstance(part, Mapping) or set(part) != {"name", "value"}:
                raise TypeError
            natural.append(
                (
                    _text(part.get("name"), "naturalKey.name"),
                    _scalar(part.get("value"), "naturalKey.value"),
                )
            )
        observed_raw = item.get("observedAt")
        observed_at = None if observed_raw is None else _utc(observed_raw, "observedAt")
        window_raw = item.get("window")
        window = None
        if window_raw is not None:
            if not isinstance(window_raw, Mapping) or set(window_raw) != {
                "start",
                "end",
                "grainSeconds",
            }:
                raise TypeError
            grain = window_raw.get("grainSeconds")
            if type(grain) is Decimal and grain == grain.to_integral_value():
                grain = int(grain)
            if isinstance(grain, bool) or not isinstance(grain, int):
                raise TypeError
            window = TimeWindow(
                _utc(window_raw.get("start"), "window.start"),
                _utc(window_raw.get("end"), "window.end"),
                grain,
            )
        dimensions = item.get("dimensions")
        measures = item.get("measures")
        quality = item.get("quality")
        flags = item.get("qualityFlags")
        if not isinstance(dimensions, Mapping):
            raise TypeError
        if not isinstance(measures, Mapping):
            raise TypeError
        if not isinstance(quality, Mapping):
            raise TypeError
        if not isinstance(flags, list) or any(not isinstance(flag, str) for flag in flags):
            raise TypeError
        normalized_dimensions = {
            key: _canonical_value(value, "dimensions")
            for key, value in cast(Mapping[object, object], dimensions).items()
            if isinstance(key, str)
        }
        normalized_measures: dict[str, CanonicalValue] = {}
        for key, value in cast(Mapping[object, object], measures).items():
            if not isinstance(key, str):
                continue
            normalized_measures[key] = (
                _utc(value, f"measures.{key}")
                if key in _DATETIME_MEASURES and value is not None
                else _canonical_value(
                    value,
                    "measures",
                    preserve_decimal=key in _DECIMAL_MEASURES,
                )
            )
        normalized_quality = {
            key: _scalar(value, "quality")
            for key, value in cast(Mapping[object, object], quality).items()
            if isinstance(key, str)
        }
        if (
            len(normalized_dimensions) != len(dimensions)
            or len(normalized_measures) != len(measures)
            or len(normalized_quality) != len(quality)
        ):
            raise TypeError
        record = CanonicalRecord(
            _text(item.get("schemaVersion"), "schemaVersion"),
            record_type,
            _text(item.get("sourceSystem"), "sourceSystem"),
            _text(item.get("sourceDataset"), "sourceDataset"),
            tuple(natural),
            observed_at,
            window,
            normalized_dimensions,
            normalized_measures,
            normalized_quality,
            tuple(flags),
        )
        if (
            record.source_dataset != matched.group("dataset")
            or item.get("datasetVersion") != matched.group("version")
            or item.get("recordId") != record_id(record)
        ):
            raise ValueError
        record_identifier = _text(item.get("recordId"), "recordId")
        sk = _text(item.get("sk"), "sk")
        effective_observed = observed_at or datetime.strptime(
            matched.group("day"), "%Y%m%d"
        ).replace(tzinfo=UTC)
        delta = effective_observed - datetime(1970, 1, 1, tzinfo=UTC)
        expected_millis = (
            delta.days * 86_400_000 + delta.seconds * 1_000 + delta.microseconds // 1_000
        )
        if sk != f"TS#{expected_millis}#{record_identifier}":
            raise ValueError
        encoded_payload_hash = _text(item.get("payloadHash"), "payloadHash")
        if encoded_payload_hash != payload_hash(record):
            raise ValueError
        return record
    except (KeyError, TypeError, ValueError) as error:
        raise DynamoControlProtocolError("DynamoDB hot record is inconsistent") from error


def _query_pages(
    client: DynamoProjectionClient, table_name: str, pk: str
) -> Iterator[tuple[CanonicalRecord, ...]]:
    """Consulta pages usando somente chaves previamente validadas.

    Args:
        client: Cliente externo que executa a operação de infraestrutura.
        table_name: Nome validado do recurso, campo ou operação correspondente.
        pk: Entrada ``pk``; a forma aceita é definida pela anotação de tipo e validada antes do
        uso.

    Returns:
        Iterador que produz os itens válidos à medida que são processados.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    start: SerializedKey | None = None
    previous_key: tuple[str, str] | None = None
    previous_cursor: tuple[str, str] | None = None
    while True:
        request: dict[str, object] = {
            "TableName": table_name,
            "KeyConditionExpression": "pk = :pk",
            "ExpressionAttributeValues": {":pk": {"S": pk}},
            "ConsistentRead": True,
        }
        if start is not None:
            request["ExclusiveStartKey"] = start
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
        raw_items = response.get("Items")
        count = response.get("Count")
        scanned = response.get("ScannedCount")
        if unexpected or not isinstance(raw_items, list):
            raise DynamoControlProtocolError("DynamoDB Query response has an invalid shape")
        if isinstance(count, bool) or not isinstance(count, int) or count != len(raw_items):
            raise DynamoControlProtocolError("DynamoDB Query Count is inconsistent")
        if isinstance(scanned, bool) or not isinstance(scanned, int) or scanned < count:
            raise DynamoControlProtocolError("DynamoDB Query ScannedCount is invalid")
        metadata = response.get("ResponseMetadata")
        if not isinstance(metadata, Mapping) or metadata.get("HTTPStatusCode") != 200:
            raise DynamoControlProtocolError("DynamoDB Query status must be 200")
        records: list[CanonicalRecord] = []
        for raw in raw_items:
            item = _decode_item(raw, "Query")
            logical = (_text(item.get("pk"), "pk"), _text(item.get("sk"), "sk"))
            if previous_cursor is not None and logical <= previous_cursor:
                raise DynamoControlProtocolError("DynamoDB Query item is behind the input cursor")
            if previous_key is not None and logical <= previous_key:
                raise DynamoControlProtocolError(
                    "DynamoDB Query keys did not advance monotonically"
                )
            previous_key = logical
            records.append(_canonical_record(item, pk))
        if records:
            yield tuple(records)
        raw_last = response.get("LastEvaluatedKey")
        if raw_last is None:
            break
        last = _decode_item(raw_last, "LastEvaluatedKey")
        if set(last) != {"pk", "sk"} or last.get("pk") != pk:
            raise DynamoControlProtocolError("DynamoDB Query LastEvaluatedKey is invalid")
        last_key = (_text(last.get("pk"), "pk"), _text(last.get("sk"), "sk"))
        if previous_key is not None and last_key < previous_key:
            raise DynamoControlProtocolError(
                "DynamoDB Query cursor regressed behind returned items"
            )
        if previous_cursor is not None and last_key <= previous_cursor:
            raise DynamoControlProtocolError(
                "DynamoDB Query pagination did not advance monotonically"
            )
        previous_cursor = last_key
        start = cast(SerializedKey, dict(cast(Mapping[str, AttributeValue], raw_last)))


def _projection_day(partition_key: str) -> date:
    """Executa a etapa interna ``projection_day`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        partition_key: Chave usada para identificar, consultar ou persistir o recurso.

    Returns:
        Valor ``date`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    matched = _DAY.fullmatch(partition_key)
    if matched is None:
        return partition_date(partition_key)
    try:
        return datetime.strptime(matched.group("day"), "%Y%m%d").date()
    except ValueError as error:
        raise ValueError("projection partition_key must identify a real day") from error


def _projection_pk(projection: Projection) -> str:
    """Executa a etapa interna ``projection_pk`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        projection: Entrada ``projection``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if _VIEW_KEY.fullmatch(projection.key) is None:
        raise ValueError("projection key is not a supported operational view")
    if projection.key == "INCIDENTS#ACTIVE":
        return f"DATASET#{projection.dataset_version}#VIEW#INCIDENTS#ACTIVE"
    return (
        f"DATASET#{projection.dataset_version}#VIEW#{projection.key}#"
        f"{_projection_day(projection.partition_key):%Y%m%d}"
    )


def _dynamo(value: object) -> object:
    """Executa a etapa interna ``dynamo`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``object`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    if value is None or isinstance(value, str | bool | Decimal):
        if isinstance(value, Decimal) and not value.is_finite():
            raise ValueError("projection Decimal values must be finite")
        return value
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("projection float values must be finite")
        return Decimal(str(value))
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() != timedelta(0):
            raise ValueError("projection datetimes must be aware UTC")
        return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise TypeError("projection mapping keys must be strings")
        return {key: _dynamo(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_dynamo(item) for item in value]
    raise TypeError(f"unsupported projection value: {type(value).__name__}")


def _marker_pk(key: str) -> str:
    """Executa a etapa interna ``marker_pk`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return "INGESTION#IDEMPOTENCY#projection-put#" + hashlib.sha256(key.encode()).hexdigest()


def _head_pk(projection_pk: str, operational_sk: str) -> str:
    """Executa a etapa interna ``head_pk`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        projection_pk: Entrada ``projection_pk``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        operational_sk: Entrada ``operational_sk``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    digest = hashlib.sha256(canonical_bytes([projection_pk, operational_sk])).hexdigest()
    return f"INGESTION#PROJECTION_HEAD#{digest}"


def _catalog_key(
    dataset_version: str,
    dataset: str,
    partition: str,
    projection_pk: str,
    operational_sk: str,
) -> tuple[str, str]:
    """Monta a chave de catálogo a partir de componentes validados.

    Args:
        dataset_version: Identificador imutável da versão do dataset.
        dataset: Nome do dataset permitido pelo registro de contratos.
        partition: Identificador canônico da partição física ou lógica.
        projection_pk: Entrada ``projection_pk``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        operational_sk: Entrada ``operational_sk``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.

    Returns:
        Valor ``tuple[str, str]`` produzido pela operação após as validações.
    """
    day = partition_date(partition)
    digest = hashlib.sha256(canonical_bytes([projection_pk, operational_sk])).hexdigest()
    return (
        f"DATASET#{dataset_version}#INGESTION#HOTPROJ#{dataset}#{day:%Y%m%d}",
        f"TARGET#{digest}",
    )


def _archive_pairs(value: object, *, context: str) -> tuple[tuple[str, str], ...]:
    """Executa a etapa interna ``archive_pairs`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        context: Contexto validado compartilhado durante o processamento.

    Returns:
        Valor ``tuple[tuple[str, str], ...]`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(value, list) or not value:
        raise DynamoControlProtocolError(f"DynamoDB {context} dependencies are invalid")
    pairs: list[tuple[str, str]] = []
    for entry in value:
        if not isinstance(entry, Mapping) or set(entry) != {"dataset", "partition"}:
            raise DynamoControlProtocolError(f"DynamoDB {context} dependency is invalid")
        pairs.append(
            (_text(entry.get("dataset"), "dataset"), _text(entry.get("partition"), "partition"))
        )
    physical = tuple((dataset, partition_date(partition)) for dataset, partition in pairs)
    if physical != tuple(sorted(physical)) or len(set(physical)) != len(physical):
        raise DynamoControlProtocolError(f"DynamoDB {context} dependencies are not canonical")
    return tuple(pairs)


def _validate_current(
    item: Mapping[str, object],
    *,
    projection: Projection,
    pk: str,
    operational_sk: str,
) -> tuple[str, tuple[tuple[str, str], ...]]:
    """Valida current contra as invariantes deste módulo.

    Args:
        item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        projection: Entrada ``projection``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        pk: Entrada ``pk``; a forma aceita é definida pela anotação de tipo e validada antes do
        uso.
        operational_sk: Entrada ``operational_sk``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.

    Returns:
        Valor ``tuple[str, tuple[tuple[str, str], ...]]`` produzido pela operação após as
        validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    expected = {
        "pk",
        "sk",
        "entityType",
        "datasetVersion",
        "partition",
        "projectionPartitionKey",
        "projectionKey",
        "projectionVersion",
        "materializationRevision",
        "requiredArchives",
        "payload",
        "payloadFingerprint",
    }
    dependencies = _archive_pairs(item.get("requiredArchives"), context="projection")
    revision = _text(item.get("materializationRevision"), "materializationRevision")
    persisted_partition_key = _text(item.get("projectionPartitionKey"), "projectionPartitionKey")
    payload = item.get("payload")
    if (
        set(item) != expected
        or item.get("pk") != pk
        or item.get("sk") != operational_sk
        or item.get("entityType") != "PROJECTION"
        or item.get("datasetVersion") != projection.dataset_version
        or (
            projection.key != "INCIDENTS#ACTIVE"
            and persisted_partition_key != projection.partition_key
        )
        or item.get("projectionKey") != projection.key
        or item.get("projectionVersion") != projection.projection_version
        or not isinstance(payload, Mapping)
        or item.get("payloadFingerprint") != hashlib.sha256(canonical_bytes(payload)).hexdigest()
        or _MATERIALIZATION_REVISION.fullmatch(revision) is None
    ):
        raise DynamoControlProtocolError("DynamoDB operational projection has an invalid shape")
    if projection.key == "INCIDENTS#ACTIVE":
        persisted_day = _projection_day(persisted_partition_key)
        if partition_date(item.get("partition")) != persisted_day or any(
            partition_date(partition) != persisted_day for _, partition in dependencies
        ):
            raise DynamoControlProtocolError(
                "DynamoDB ACTIVE projection partition metadata is inconsistent"
            )
    return revision, dependencies


def _validate_head(
    item: Mapping[str, object],
    *,
    head_pk: str,
    projection: Projection,
    projection_pk: str,
    operational_sk: str,
    revision: str,
    dependencies: tuple[tuple[str, str], ...],
) -> None:
    """Valida head contra as invariantes deste módulo.

    Args:
        item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        head_pk: Entrada ``head_pk``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        projection: Entrada ``projection``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        projection_pk: Entrada ``projection_pk``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        operational_sk: Entrada ``operational_sk``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        revision: Entrada ``revision``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        dependencies: Entrada ``dependencies``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    if (
        set(item)
        != {
            "pk",
            "sk",
            "entityType",
            "datasetVersion",
            "projectionPk",
            "operationalSk",
            "projectionKey",
            "projectionVersion",
            "materializationRevision",
            "requiredArchives",
        }
        or item.get("pk") != head_pk
        or item.get("sk") != "META"
        or item.get("entityType") != "PROJECTION_HEAD"
        or item.get("datasetVersion") != projection.dataset_version
        or item.get("projectionPk") != projection_pk
        or item.get("operationalSk") != operational_sk
        or item.get("projectionKey") != projection.key
        or item.get("projectionVersion") != projection.projection_version
        or item.get("materializationRevision") != revision
        or _archive_pairs(item.get("requiredArchives"), context="projection head") != dependencies
    ):
        raise DynamoControlProtocolError("DynamoDB projection head has an invalid shape")


def _catalog_targets(
    item: Mapping[str, object] | None,
    *,
    dataset_version: str,
    dataset: str,
    partition: str,
    projection_pk: str,
    operational_sk: str,
) -> tuple[list[dict[str, object]], str | None]:
    """Executa a etapa interna ``catalog_targets`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        dataset_version: Identificador imutável da versão do dataset.
        dataset: Nome do dataset permitido pelo registro de contratos.
        partition: Identificador canônico da partição física ou lógica.
        projection_pk: Entrada ``projection_pk``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        operational_sk: Entrada ``operational_sk``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.

    Returns:
        Valor ``tuple[list[dict[str, object]], str | None]`` produzido pela operação após as
        validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    if item is None:
        return [], None
    expected = {
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
    raw_targets = item.get("targets")
    if set(item) != expected or not isinstance(raw_targets, list):
        raise DynamoControlProtocolError(
            "DynamoDB projection target-set catalog has an invalid shape"
        )
    normalized: list[dict[str, object]] = []
    for target in raw_targets:
        if not isinstance(target, Mapping):
            raise DynamoControlProtocolError("DynamoDB projection target-set entry is invalid")
        archives = _archive_pairs(target.get("requiredArchives"), context="projection catalog")
        normalized.append(
            {
                "kind": target.get("kind"),
                "sk": target.get("sk"),
                "materializationRevision": target.get("materializationRevision"),
                "requiredArchives": archives,
            }
        )
    try:
        canonical = encode_projection_target_set_catalog(
            dataset_version,
            dataset,
            partition,
            projection_pk,
            operational_sk,
            targets=normalized,
            catalog_generation=1,
        )
    except (TypeError, ValueError) as error:
        raise DynamoControlProtocolError(
            "DynamoDB projection target-set catalog is invalid"
        ) from error
    if dict(item) != canonical:
        raise DynamoControlProtocolError("DynamoDB projection target-set catalog is inconsistent")
    return normalized, cast(str, item["catalogRevision"])


def _get(
    client: DynamoProjectionClient, table_name: str, pk: str, sk: str
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
    if decoded is None:
        return None
    result = cast(dict[str, object], _normalize_number(decoded))
    if result.get("pk") != pk or result.get("sk") != sk:
        raise DynamoControlProtocolError("DynamoDB GetItem returned an unsolicited item")
    return result


def _conditional_positions(reasons: object, action_count: int) -> frozenset[int] | None:
    """Executa a etapa interna ``conditional_positions`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        reasons: Entrada ``reasons``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        action_count: Quantidade inteira não negativa usada na reconciliação.

    Returns:
        Valor ``frozenset[int] | None`` produzido pela operação após as validações.
    """
    if not isinstance(reasons, list) or len(reasons) != action_count:
        return None
    failed: set[int] = set()
    for index, reason in enumerate(reasons):
        if not isinstance(reason, Mapping):
            return None
        code = reason.get("Code")
        if code == "None":
            continue
        if code != "ConditionalCheckFailed":
            return None
        failed.add(index)
    return frozenset(failed) if failed else None


def _validate_marker(
    marker: Mapping[str, object],
    *,
    marker_pk: str,
    fingerprint: str,
    result: Mapping[str, str],
) -> None:
    """Valida marker contra as invariantes deste módulo.

    Args:
        marker: Entrada ``marker``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        marker_pk: Entrada ``marker_pk``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
        IdempotencyConflict: Se a operação não puder preservar as invariantes descritas.
    """
    stored_result = marker.get("result")
    if (
        set(marker) != {"pk", "sk", "entityType", "operation", "fingerprint", "result", "ttl"}
        or marker.get("pk") != marker_pk
        or marker.get("sk") != "META"
        or marker.get("entityType") != "IDEMPOTENCY_MARKER"
        or marker.get("operation") != "projection-put"
        or not isinstance(marker.get("ttl"), int)
        or cast(int, marker["ttl"]) <= 0
        or not isinstance(stored_result, Mapping)
        or set(stored_result) != {"projectionPk", "operationalSk", "materializationRevision"}
        or any(not isinstance(value, str) or not value for value in stored_result.values())
    ):
        raise DynamoControlProtocolError("DynamoDB projection marker has an invalid shape")
    if marker.get("fingerprint") != fingerprint or stored_result != result:
        raise IdempotencyConflict("idempotency key was reused with different input")


class DynamoProjectionRepository(ProjectionRepository):
    """Agrupa o estado e as operações de ``DynamoProjectionRepository`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        client: DynamoProjectionClient,
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

    def get_current(
        self, dataset_version: str, key: str, operational_sort_key: str
    ) -> CurrentProjection | None:
        """Obtém current a partir da fonte configurada.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            operational_sort_key: Chave usada para identificar, consultar ou persistir o
            recurso.

        Returns:
            Valor ``CurrentProjection | None`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        version = require_key_component(dataset_version, "dataset_version")
        if key != "INCIDENTS#ACTIVE" or operational_sort_key != "CURRENT":
            raise ValueError("only the global active-incident current view can be read")
        pk = f"DATASET#{version}#VIEW#INCIDENTS#ACTIVE"
        item = _get(self._client, self._table_name, pk, operational_sort_key)
        if item is None:
            return None
        expected = {
            "pk",
            "sk",
            "entityType",
            "datasetVersion",
            "partition",
            "projectionPartitionKey",
            "projectionKey",
            "projectionVersion",
            "materializationRevision",
            "requiredArchives",
            "payload",
            "payloadFingerprint",
        }
        payload = item.get("payload")
        revision = item.get("materializationRevision")
        dependencies = _archive_pairs(item.get("requiredArchives"), context="projection")
        if (
            set(item) != expected
            or item.get("pk") != pk
            or item.get("sk") != operational_sort_key
            or item.get("entityType") != "PROJECTION"
            or item.get("datasetVersion") != version
            or item.get("projectionKey") != key
            or item.get("projectionVersion") != "1.0"
            or not isinstance(revision, str)
            or _MATERIALIZATION_REVISION.fullmatch(revision) is None
            or not isinstance(payload, Mapping)
            or item.get("payloadFingerprint")
            != hashlib.sha256(canonical_bytes(_normalize_number(payload))).hexdigest()
        ):
            raise DynamoControlProtocolError(
                "DynamoDB active-incident current projection is invalid"
            )
        return CurrentProjection(
            cast(Mapping[str, object], _normalize_number(payload)),
            revision,
            tuple(ArchiveDependency(dataset, partition) for dataset, partition in dependencies),
        )

    def query_inputs(
        self, dataset_version: str, partition_keys: tuple[str, ...]
    ) -> tuple[CanonicalRecord, ...]:
        """Consulta entradas usando somente chaves previamente validadas.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            partition_keys: Entrada ``partition_keys``; a forma aceita é definida pela anotação
            de tipo e validada antes do uso.

        Returns:
            Valor ``tuple[CanonicalRecord, ...]`` produzido pela operação após as validações.
        """
        return tuple(
            record
            for batch in self.iter_input_batches(dataset_version, partition_keys)
            for record in batch
        )

    def iter_input_batches(
        self, dataset_version: str, partition_keys: tuple[str, ...]
    ) -> Iterator[tuple[CanonicalRecord, ...]]:
        """Produz entrada batches de forma incremental e com memória limitada.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            partition_keys: Entrada ``partition_keys``; a forma aceita é definida pela anotação
            de tipo e validada antes do uso.

        Returns:
            Iterador que produz os itens válidos à medida que são processados.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        version = require_key_component(dataset_version, "dataset_version")
        if not isinstance(partition_keys, tuple):
            raise TypeError("partition_keys must be a tuple")
        if not partition_keys or len(partition_keys) > _MAX_INPUT_PARTITIONS:
            raise ValueError("partition_keys must contain between 1 and 48 values")
        if any(not isinstance(pk, str) for pk in partition_keys):
            raise TypeError("partition_keys must contain strings")
        if len(set(partition_keys)) != len(partition_keys):
            raise ValueError("partition_keys must be unique")
        for pk in partition_keys:
            matched = _FACT_PK.fullmatch(pk)
            if matched is None or matched.group("version") != version:
                raise ValueError("partition key must identify an exact fact partition and version")
            try:
                datetime.strptime(matched.group("day"), "%Y%m%d")
            except ValueError as error:
                raise ValueError("partition key must identify a real day") from error
        days = {cast(re.Match[str], _FACT_PK.fullmatch(pk)).group("day") for pk in partition_keys}
        if len(days) != 1:
            raise ValueError("projection input partitions must identify one day")
        for pk in sorted(partition_keys):
            for records in _query_pages(self._client, self._table_name, pk):
                yield tuple(
                    sorted(
                        records,
                        key=lambda item: (
                            item.source_dataset,
                            item.observed_at or datetime.min.replace(tzinfo=UTC),
                            repr(item.natural_key),
                        ),
                    )
                )

    def _assert_projection_mutable(self, dataset_version: str) -> None:
        """Executa a etapa interna ``assert_projection_mutable`` e valida seus efeitos antes de
        concluir.

        Args:
            dataset_version: Identificador imutável da versão do dataset.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
        """
        fence_pk, fence_sk = _projection_fence_key(dataset_version)
        try:
            validate_transaction_response(
                self._client.transact_write_items(
                    TransactItems=[
                        {
                            "ConditionCheck": {
                                "TableName": self._table_name,
                                "Key": {"pk": {"S": fence_pk}, "sk": {"S": fence_sk}},
                                "ConditionExpression": "attribute_not_exists(pk)",
                            }
                        }
                    ]
                )
            )
        except ClientError as error:
            raise_if_dynamodb_throttled(error)
            code = error.response.get("Error", {}).get("Code")
            if code == "ConditionalCheckFailedException":
                raise ConditionalWriteError("projection dataset version is active") from None
            if code != "TransactionCanceledException":
                raise
            if _conditional_positions(error.response.get("CancellationReasons"), 1) == frozenset(
                {0}
            ):
                raise ConditionalWriteError("projection dataset version is active") from None
            raise

    def put_event_items(self, items: tuple[EventProjectionItem, ...]) -> None:
        """Persist a bounded Event/Evidence batch behind the candidate activation fence."""
        if not isinstance(items, tuple) or not items or len(items) > 25:
            raise ValueError("event projection batch must contain between 1 and 25 items")
        if any(not isinstance(item, EventProjectionItem) for item in items):
            raise TypeError("event projection batch must contain EventProjectionItem values")
        versions = {item.dataset_version for item in items}
        if len(versions) != 1:
            raise ValueError("event projection batch must belong to one dataset version")
        version = next(iter(versions))
        if len({(item.pk, item.sk) for item in items}) != len(items):
            raise ValueError("event projection batch keys must be unique")

        puts: list[dict[str, object]] = []
        for item in items:
            dynamo_payload = _dynamo(item.payload)
            stored = cast(
                dict[str, object],
                _dynamo(
                    {
                        "pk": item.pk,
                        "sk": item.sk,
                        "entityType": item.entity_type,
                        "datasetVersion": item.dataset_version,
                        "materializationRevision": item.materialization_revision,
                        "payload": dynamo_payload,
                        "payloadFingerprint": hashlib.sha256(
                            canonical_bytes(_normalize_number(dynamo_payload))
                        ).hexdigest(),
                    }
                ),
            )
            serialized = serialize_item(stored)
            if serialized_item_bytes(serialized) > _MAX_ITEM_BYTES:
                raise ValueError("event projection item exceeds the safe DynamoDB size")
            puts.append(
                {
                    "Put": {
                        "TableName": self._table_name,
                        "Item": serialized,
                        "ConditionExpression": (
                            "attribute_not_exists(pk) OR materializationRevision = :revision"
                        ),
                        "ExpressionAttributeValues": {
                            ":revision": {"S": item.materialization_revision}
                        },
                    }
                }
            )

        fence_pk, fence_sk = _projection_fence_key(version)
        actions: list[dict[str, object]] = [
            {
                "ConditionCheck": {
                    "TableName": self._table_name,
                    "Key": {"pk": {"S": fence_pk}, "sk": {"S": fence_sk}},
                    "ConditionExpression": "attribute_not_exists(pk)",
                }
            },
            *puts,
        ]
        token = hashlib.sha256(
            canonical_bytes([(item.pk, item.sk, item.materialization_revision) for item in items])
        ).hexdigest()[:36]
        try:
            response = self._client.transact_write_items(
                TransactItems=actions,
                ClientRequestToken=token,
            )
            validate_transaction_response(response)
        except ClientError as error:
            raise_if_dynamodb_throttled(error)
            code = error.response.get("Error", {}).get("Code")
            if code != "TransactionCanceledException":
                raise
            positions = _conditional_positions(
                error.response.get("CancellationReasons"), len(actions)
            )
            if positions is not None and 0 in positions:
                raise ConditionalWriteError("event projection dataset version is active") from None
            if positions:
                raise ConditionalWriteError(
                    "event projection identity has divergent content"
                ) from None
            raise

    def put(
        self,
        projection: Projection,
        *,
        expected_projection_version: str | None,
        idempotency_key: str,
        expected_materialization_revision: str | None = None,
    ) -> None:
        """Persiste o valor após validar identidade e pré-condições da escrita.

        Args:
            projection: Entrada ``projection``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.
            expected_projection_version: Valor esperado usado para detectar concorrência ou
            divergência de estado.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.
            expected_materialization_revision: Valor esperado usado para detectar concorrência
            ou divergência de estado.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
        """
        if not isinstance(projection, Projection):
            raise TypeError("projection must be a Projection")
        require_key_component(projection.dataset_version, "dataset_version")
        require_key_component(projection.projection_version, "projection_version")
        if expected_projection_version is not None:
            require_key_component(expected_projection_version, "expected_projection_version")
            if _MATERIALIZATION_REVISION.fullmatch(expected_projection_version) is not None:
                raise ValueError(
                    "expected_projection_version must be a projection contract version"
                )
        if expected_materialization_revision is not None:
            if not isinstance(expected_materialization_revision, str):
                raise TypeError("expected_materialization_revision must be a string")
            if _MATERIALIZATION_REVISION.fullmatch(expected_materialization_revision) is None:
                raise ValueError(
                    "expected_materialization_revision must be a materialization revision"
                )
        if not isinstance(idempotency_key, str):
            raise TypeError("idempotency_key must be a string")
        if not idempotency_key or len(idempotency_key.encode()) > 1024:
            raise ValueError("idempotency_key must contain at most 1024 bytes")
        now = self._clock()
        if type(now) is not datetime or now.tzinfo is None or now.utcoffset() != timedelta(0):
            raise ValueError("clock must return an aware UTC datetime")

        pk = _projection_pk(projection)
        operational_sk = projection.operational_sort_key
        revision = projection.materialization_revision
        revision_sk = f"REVISION#{revision}"
        head_pk = _head_pk(pk, operational_sk)
        dependencies = tuple(
            (dependency.dataset, dependency.partition)
            for dependency in projection.required_archives
        )
        fingerprint = hashlib.sha256(
            canonical_bytes(
                {
                    "projection": {
                        "datasetVersion": projection.dataset_version,
                        "partitionKey": projection.partition_key,
                        "key": projection.key,
                        "projectionVersion": projection.projection_version,
                        "requiredArchives": [
                            {"dataset": dataset, "partition": partition}
                            for dataset, partition in dependencies
                        ],
                        "payload": projection.payload,
                    },
                    "expectedProjectionVersion": expected_projection_version,
                    "expectedMaterializationRevision": expected_materialization_revision,
                }
            )
        ).hexdigest()
        marker_pk = _marker_pk(idempotency_key)
        marker_result = {
            "projectionPk": pk,
            "operationalSk": operational_sk,
            "materializationRevision": revision,
        }
        replay = _get(self._client, self._table_name, marker_pk, "META")
        if replay is not None:
            self._assert_projection_mutable(projection.dataset_version)
            _validate_marker(
                replay,
                marker_pk=marker_pk,
                fingerprint=fingerprint,
                result=marker_result,
            )
            return

        current = _get(self._client, self._table_name, pk, operational_sk)
        head = _get(self._client, self._table_name, head_pk, "META")
        if (current is None) != (head is None):
            raise DynamoControlProtocolError("DynamoDB projection target and head disagree")
        current_revision: str | None = None
        previous_dependencies: tuple[tuple[str, str], ...] = ()
        if current is not None and head is not None:
            current_revision, previous_dependencies = _validate_current(
                current, projection=projection, pk=pk, operational_sk=operational_sk
            )
            _validate_head(
                head,
                head_pk=head_pk,
                projection=projection,
                projection_pk=pk,
                operational_sk=operational_sk,
                revision=current_revision,
                dependencies=previous_dependencies,
            )
        if current_revision is None:
            if (
                expected_projection_version is not None
                or expected_materialization_revision is not None
            ):
                raise ConditionalWriteError(
                    "projection target is absent but an existing version was expected"
                )
        else:
            if expected_projection_version != projection.projection_version:
                raise ConditionalWriteError("projection contract differs from expected version")
            if (
                expected_materialization_revision is not None
                and expected_materialization_revision != current_revision
            ):
                raise ConditionalWriteError(
                    "projection materialization differs from expected revision"
                )

        dynamo_payload = _dynamo(projection.payload)
        projection_item = cast(
            dict[str, object],
            _dynamo(
                {
                    "pk": pk,
                    "sk": operational_sk,
                    "entityType": "PROJECTION",
                    "datasetVersion": projection.dataset_version,
                    "partition": dependencies[0][1],
                    "projectionPartitionKey": projection.partition_key,
                    "projectionKey": projection.key,
                    "projectionVersion": projection.projection_version,
                    "materializationRevision": revision,
                    "requiredArchives": [
                        {"dataset": dataset, "partition": partition}
                        for dataset, partition in dependencies
                    ],
                    "payload": dynamo_payload,
                    "payloadFingerprint": hashlib.sha256(
                        canonical_bytes(_normalize_number(dynamo_payload))
                    ).hexdigest(),
                }
            ),
        )
        revision_item = cast(
            dict[str, object],
            _dynamo(
                {
                    **projection_item,
                    "sk": revision_sk,
                    "entityType": "PROJECTION_REVISION",
                    "operationalSk": operational_sk,
                }
            ),
        )
        head_item = cast(
            dict[str, object],
            _dynamo(
                {
                    "pk": head_pk,
                    "sk": "META",
                    "entityType": "PROJECTION_HEAD",
                    "datasetVersion": projection.dataset_version,
                    "projectionPk": pk,
                    "operationalSk": operational_sk,
                    "projectionKey": projection.key,
                    "projectionVersion": projection.projection_version,
                    "materializationRevision": revision,
                    "requiredArchives": [
                        {"dataset": dataset, "partition": partition}
                        for dataset, partition in dependencies
                    ],
                }
            ),
        )
        marker_item = cast(
            dict[str, object],
            _dynamo(
                {
                    "pk": marker_pk,
                    "sk": "META",
                    "entityType": "IDEMPOTENCY_MARKER",
                    "operation": "projection-put",
                    "fingerprint": fingerprint,
                    "result": marker_result,
                    "ttl": int(now.timestamp()) + _MARKER_TTL_SECONDS,
                }
            ),
        )
        if current_revision == revision:
            replay_actions = [
                {
                    "ConditionCheck": {
                        "TableName": self._table_name,
                        "Key": {
                            "pk": {"S": _projection_fence_key(projection.dataset_version)[0]},
                            "sk": {"S": _projection_fence_key(projection.dataset_version)[1]},
                        },
                        "ConditionExpression": "attribute_not_exists(pk)",
                    }
                },
                {
                    "ConditionCheck": {
                        "TableName": self._table_name,
                        "Key": {"pk": {"S": head_pk}, "sk": {"S": "META"}},
                        "ConditionExpression": (
                            "entityType = :head AND materializationRevision = :expected"
                        ),
                        "ExpressionAttributeValues": {
                            ":head": {"S": "PROJECTION_HEAD"},
                            ":expected": {"S": revision},
                        },
                    }
                },
                {
                    "Put": {
                        "TableName": self._table_name,
                        "Item": serialize_item(marker_item),
                        "ConditionExpression": "attribute_not_exists(pk)",
                    }
                },
            ]
            try:
                validate_transaction_response(
                    self._client.transact_write_items(TransactItems=replay_actions)
                )
                return
            except ClientError as error:
                raise_if_dynamodb_throttled(error)
                if error.response.get("Error", {}).get("Code") != "TransactionCanceledException":
                    raise
                replay = _get(self._client, self._table_name, marker_pk, "META")
                if replay is not None:
                    _validate_marker(
                        replay,
                        marker_pk=marker_pk,
                        fingerprint=fingerprint,
                        result=marker_result,
                    )
                    return
                failed = _conditional_positions(error.response.get("CancellationReasons"), 3)
                if failed == frozenset({0}):
                    raise ConditionalWriteError("projection dataset version is active") from None
                if failed == frozenset({1}):
                    raise ConditionalWriteError(
                        "projection materialization changed during idempotent replay"
                    ) from None
                if failed == frozenset({2}):
                    raise ConditionalWriteError("projection idempotency marker changed") from None
                raise
        all_items = [projection_item, revision_item, head_item, marker_item]
        if any(serialized_item_bytes(serialize_item(item)) > _MAX_ITEM_BYTES for item in all_items):
            raise ValueError("projection transaction item exceeds the internal 200 KiB limit")

        dependency_union = (
            dependencies
            if projection.key == "INCIDENTS#ACTIVE"
            else tuple(
                sorted(
                    set(previous_dependencies) | set(dependencies),
                    key=lambda pair: (pair[0], partition_date(pair[1])),
                )
            )
        )
        if len(dependency_union) > _MAX_PROJECTION_DEPENDENCIES:
            raise ValueError("previous and new required archives exceed 47 physical dependencies")
        fence_pk, fence_sk = _projection_fence_key(projection.dataset_version)
        actions: list[dict[str, object]] = [
            {
                "ConditionCheck": {
                    "TableName": self._table_name,
                    "Key": {"pk": {"S": fence_pk}, "sk": {"S": fence_sk}},
                    "ConditionExpression": "attribute_not_exists(pk)",
                }
            }
        ]
        fence_position = 0
        seal_positions: set[int] = set()
        for dataset, partition in dependency_union:
            seal_positions.add(len(actions))
            actions.append(
                {
                    "ConditionCheck": {
                        "TableName": self._table_name,
                        "Key": {
                            "pk": {
                                "S": f"DATASET#{projection.dataset_version}#INGESTION#RETENTION#"
                                f"{dataset}#{partition_date(partition):%Y%m%d}"
                            },
                            "sk": {"S": "META"},
                        },
                        "ConditionExpression": "attribute_not_exists(pk)",
                    }
                }
            )
        projection_position = len(actions)
        projection_put: dict[str, object] = {
            "TableName": self._table_name,
            "Item": serialize_item(projection_item),
        }
        if current_revision is None:
            projection_put["ConditionExpression"] = "attribute_not_exists(pk)"
        else:
            projection_put["ConditionExpression"] = (
                "entityType = :projection AND projectionVersion = :version "
                "AND materializationRevision = :expected"
            )
            projection_put["ExpressionAttributeValues"] = {
                ":projection": {"S": "PROJECTION"},
                ":version": {"S": projection.projection_version},
                ":expected": {"S": current_revision},
            }
        actions.append({"Put": projection_put})
        revision_position = len(actions)
        actions.append(
            {
                "Put": {
                    "TableName": self._table_name,
                    "Item": serialize_item(revision_item),
                    "ConditionExpression": "attribute_not_exists(pk)",
                }
            }
        )
        head_position = len(actions)
        head_put: dict[str, object] = {
            "TableName": self._table_name,
            "Item": serialize_item(head_item),
        }
        if current_revision is None:
            head_put["ConditionExpression"] = "attribute_not_exists(pk)"
        else:
            head_put["ConditionExpression"] = (
                "entityType = :head AND projectionVersion = :version "
                "AND materializationRevision = :expected"
            )
            head_put["ExpressionAttributeValues"] = {
                ":head": {"S": "PROJECTION_HEAD"},
                ":version": {"S": projection.projection_version},
                ":expected": {"S": current_revision},
            }
        actions.append({"Put": head_put})

        catalog_positions: set[int] = set()
        if projection.key != "INCIDENTS#ACTIVE":
            dependency_set = set(dependencies)
            for dataset, partition in dependency_union:
                catalog_pk, catalog_sk = _catalog_key(
                    projection.dataset_version,
                    dataset,
                    partition,
                    pk,
                    operational_sk,
                )
                existing_catalog = _get(self._client, self._table_name, catalog_pk, catalog_sk)
                targets, expected_catalog_revision = _catalog_targets(
                    existing_catalog,
                    dataset_version=projection.dataset_version,
                    dataset=dataset,
                    partition=partition,
                    projection_pk=pk,
                    operational_sk=operational_sk,
                )
                targets = [target for target in targets if target["kind"] != "OPERATIONAL"]
                if (dataset, partition) in dependency_set:
                    targets.extend(
                        [
                            {
                                "kind": "OPERATIONAL",
                                "sk": operational_sk,
                                "materializationRevision": revision,
                                "requiredArchives": dependencies,
                            },
                            {
                                "kind": "REVISION",
                                "sk": revision_sk,
                                "materializationRevision": revision,
                                "requiredArchives": dependencies,
                            },
                        ]
                    )
                targets.sort(
                    key=lambda target: (
                        cast(str, target["kind"]),
                        cast(str, target["sk"]),
                    )
                )
                catalog = encode_projection_target_set_catalog(
                    projection.dataset_version,
                    dataset,
                    partition,
                    pk,
                    operational_sk,
                    targets=targets,
                    catalog_generation=1,
                )
                catalog_positions.add(len(actions))
                serialized_catalog = serialize_item(catalog)
                catalog_put: dict[str, object] = {
                    "TableName": self._table_name,
                    "Item": serialized_catalog,
                }
                if expected_catalog_revision is None:
                    catalog_put["ConditionExpression"] = "attribute_not_exists(pk)"
                else:
                    catalog_put["ConditionExpression"] = (
                        "entityType = :catalog AND catalogRevision = :expected"
                    )
                    catalog_put["ExpressionAttributeValues"] = {
                        ":catalog": {"S": "HOT_PROJECTION_TARGET_SET"},
                        ":expected": {"S": expected_catalog_revision},
                    }
                actions.append({"Put": catalog_put})
        marker_position = len(actions)
        actions.append(
            {
                "Put": {
                    "TableName": self._table_name,
                    "Item": serialize_item(marker_item),
                    "ConditionExpression": "attribute_not_exists(pk)",
                }
            }
        )
        if len(actions) > _MAX_ACTIONS:
            raise ValueError("projection transaction exceeds 100 DynamoDB actions")
        request_bytes = len(
            json.dumps(
                {"TransactItems": actions},
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        )
        if request_bytes >= _TRANSACTION_BUDGET:
            raise ValueError("projection transaction exceeds the conservative 4 MiB budget")
        try:
            validate_transaction_response(self._client.transact_write_items(TransactItems=actions))
        except ClientError as error:
            raise_if_dynamodb_throttled(error)
            if error.response.get("Error", {}).get("Code") != "TransactionCanceledException":
                raise
            replay = _get(self._client, self._table_name, marker_pk, "META")
            if replay is not None:
                _validate_marker(
                    replay,
                    marker_pk=marker_pk,
                    fingerprint=fingerprint,
                    result=marker_result,
                )
                return
            failed = _conditional_positions(error.response.get("CancellationReasons"), len(actions))
            if failed is None:
                raise
            known_positions = (
                seal_positions
                | {
                    fence_position,
                    projection_position,
                    revision_position,
                    head_position,
                    marker_position,
                }
                | catalog_positions
            )
            if not failed <= known_positions:
                raise
            if fence_position in failed:
                raise ConditionalWriteError("projection dataset version is active") from None
            if failed & seal_positions:
                raise ConditionalWriteError(
                    "projection archive dependency is already sealed"
                ) from None
            if head_position in failed:
                raise ConditionalWriteError(
                    "projection materialization differs from expected revision"
                ) from None
            if failed & catalog_positions:
                raise ConditionalWriteError("projection catalog changed concurrently") from None
            if failed:
                raise ConditionalWriteError("versioned projection state is immutable") from None
            raise


__all__ = ["DynamoProjectionClient", "DynamoProjectionRepository"]
