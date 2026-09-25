"""Confirma janelas e eventos de outbox na mesma transação do DynamoDB.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
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
from domain.analysis import (
    ALLOWED_ANALYSIS_EVENT_TYPES,
    DEFAULT_FORECAST_MODEL,
    MAX_OUTBOX_ITEM_BYTES,
    PENDING_OUTBOX_PARTITION_KEY,
    ForecastModel,
    canonical_utc_text,
    parse_canonical_utc_text,
    pending_analysis_outbox_item,
    validate_analysis_event,
    validate_window_commit_contract,
)
from domain.canonical_json import canonical_bytes
from domain.identity import sha256_id
from domain.models import TimeWindow
from ports import (
    ConditionalWriteError,
    IdempotencyConflict,
    OutboxBacklog,
    OutboxBacklogInspector,
    OutboxEvent,
    OutboxRepository,
    WindowCommitRepository,
)

type AttributeValue = dict[str, Any]

_INDEX_NAME = "outbox-pending-index"
_MARKER_TTL_SECONDS = 90 * 24 * 60 * 60
_MAX_BUCKET_EVIDENCE_INTERVALS = 256
_DESERIALIZER = TypeDeserializer()


class DynamoOutboxClient(Protocol):
    """Define o contrato mínimo de dynamo outbox cliente usado para injeção de dependência.

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


def _text(value: object, field: str, *, key_component: bool = False) -> str:
    """Executa a etapa interna ``text`` e devolve o resultado validado indicado pela assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.
        key_component: Entrada ``key_component``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.

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
    if key_component and ("#" in value or any(character.isspace() for character in value)):
        raise ValueError(f"{field} must not contain key delimiters or whitespace")
    return value


def _utc(value: object, field: str) -> datetime:
    """Executa a etapa interna ``utc`` e devolve o resultado validado indicado pela assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``datetime`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if type(value) is not datetime:
        raise TypeError(f"{field} must be a datetime")
    assert isinstance(value, datetime)
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError(f"{field} must be an aware UTC datetime")
    return value.astimezone(UTC)


def _utc_text(value: datetime) -> str:
    """Converte utc para sua representação textual canônica.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return canonical_utc_text(value, "datetime")


def _parse_utc_text(value: object, field: str) -> datetime:
    """Converte utc texto para a representação interna validada.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``datetime`` produzido pela operação após as validações.
    """
    return parse_canonical_utc_text(value, field)


def _event_identity(
    dataset_version: str, event_type: str, window_end: datetime
) -> dict[str, object]:
    """Executa a etapa interna ``event_identity`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        dataset_version: Identificador imutável da versão do dataset.
        event_type: Entrada ``event_type``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        window_end: Entrada ``window_end``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.
    """
    return {
        "datasetVersion": dataset_version,
        "eventType": event_type,
        "windowEnd": window_end,
    }


def _window_payload(window: TimeWindow) -> dict[str, object]:
    """Monta o payload de janela com o conjunto fechado de campos.

    Args:
        window: Janela temporal UTC, fechada no início e aberta no fim.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.
    """
    return {
        "start": _utc_text(window.start),
        "end": _utc_text(window.end),
        "grainSeconds": window.grain_seconds,
    }


def _target_window(window: TimeWindow) -> dict[str, object]:
    """Executa a etapa interna ``target_window`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        window: Janela temporal UTC, fechada no início e aberta no fim.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.
    """
    return {
        "start": _utc_text(window.end),
        "end": _utc_text(window.end + timedelta(hours=1)),
    }


def build_analysis_event(
    dataset_version: str,
    event_type: str,
    window: TimeWindow,
    *,
    created_at: datetime,
    forecast_model: ForecastModel = DEFAULT_FORECAST_MODEL,
) -> OutboxEvent:
    """Constrói análise evento a partir das entradas validadas.

    Args:
        dataset_version: Identificador imutável da versão do dataset.
        event_type: Entrada ``event_type``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        window: Janela temporal UTC, fechada no início e aberta no fim.
        created_at: Instante UTC com fuso horário usado pela regra temporal.
        forecast_model: Identidade do modelo declarada em eventos ``QOE_FORECAST``.

    Returns:
        Valor ``OutboxEvent`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    version = _text(dataset_version, "dataset_version", key_component=True)
    kind = _text(event_type, "event_type")
    if kind not in ALLOWED_ANALYSIS_EVENT_TYPES:
        raise ValueError("event_type must be ANOMALY_DETECTION or QOE_FORECAST")
    if not isinstance(window, TimeWindow):
        raise TypeError("window must be a TimeWindow")
    if kind == "ANOMALY_DETECTION" and window.grain_seconds != 900:
        raise ValueError("ANOMALY_DETECTION requires a 900-second window")
    if kind == "QOE_FORECAST" and window.grain_seconds != 3600:
        raise ValueError("QOE_FORECAST requires a 3600-second window")
    produced = _utc(created_at, "created_at")
    identity = _event_identity(version, kind, window.end)
    payload: dict[str, object] = {
        "window": _window_payload(window),
        "scope": {"kind": "global", "dimensions": {}},
        "inputWatermark": _utc_text(window.end),
    }
    if kind == "QOE_FORECAST":
        payload.update(
            {
                "model": forecast_model.payload(),
                "targetWindow": _target_window(window),
            }
        )
    event = OutboxEvent(
        sha256_id("evt_", identity),
        version,
        kind,
        sha256_id("ana_", identity),
        produced,
        payload,
    )
    validate_analysis_event(event)
    return event


def pending_outbox(event: OutboxEvent) -> dict[str, object]:
    """Executa a etapa interna ``pending_outbox`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        event: Evento de análise validado que será codificado ou publicado.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    if not isinstance(event, OutboxEvent):
        raise TypeError("event must be an OutboxEvent")
    return pending_analysis_outbox_item(event)


def _locator_item(event: OutboxEvent) -> dict[str, object]:
    """Monta o item de locator no formato esperado pela camada de destino.

    Args:
        event: Evento de análise validado que será codificado ou publicado.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.
    """
    target = pending_outbox(event)
    item = {
        "pk": f"INGESTION#OUTBOX#EVENT#{event.event_id}",
        "sk": "META",
        "entityType": "OUTBOX_LOCATOR",
        "eventId": event.event_id,
        "targetPk": target["pk"],
        "targetSk": target["sk"],
    }
    _ensure_size(item)
    return item


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
    if serialized_item_bytes(serialize_item(item)) > MAX_OUTBOX_ITEM_BYTES:
        raise ValueError("outbox item exceeds the internal 200 KiB limit")


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
            raise DynamoControlProtocolError("DynamoDB outbox contains a non-finite number")
        return int(decimal) if decimal == decimal.to_integral_value() else decimal
    if isinstance(value, Mapping):
        return {key: _normalize_numbers(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_normalize_numbers(item) for item in value]
    return value


def _decode_item(raw: object) -> dict[str, object]:
    """Decodifica item e valida sua forma antes de devolvê-lo.

    Args:
        raw: Entrada ``raw``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    if not isinstance(raw, Mapping) or not raw:
        raise DynamoControlProtocolError("DynamoDB outbox item must be a non-empty mapping")
    result: dict[str, object] = {}
    try:
        for name, attribute in raw.items():
            if not isinstance(name, str) or not isinstance(attribute, Mapping):
                raise TypeError
            result[name] = _normalize_numbers(
                _DESERIALIZER.deserialize(cast(dict[str, Any], attribute))
            )
    except (KeyError, TypeError, ValueError) as error:
        raise DynamoControlProtocolError(
            "DynamoDB outbox item contains an invalid AttributeValue"
        ) from error
    return result


def _decode_event(item: Mapping[str, object]) -> OutboxEvent:
    """Decodifica evento e valida sua forma antes de devolvê-lo.

    Args:
        item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``OutboxEvent`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    expected = {
        "pk",
        "sk",
        "entityType",
        "eventId",
        "datasetVersion",
        "eventType",
        "idempotencyKey",
        "createdAt",
        "payload",
        "state",
        "outboxStatePk",
        "outboxStateSk",
    }
    if set(item) != expected or item.get("entityType") != "ANALYSIS_OUTBOX":
        raise DynamoControlProtocolError("DynamoDB pending outbox item has an invalid shape")
    if item.get("state") != "PENDING" or item.get("outboxStatePk") != PENDING_OUTBOX_PARTITION_KEY:
        raise DynamoControlProtocolError("DynamoDB pending outbox item has an invalid state")
    payload = item.get("payload")
    if not isinstance(payload, Mapping):
        raise DynamoControlProtocolError("DynamoDB pending outbox payload must be a mapping")
    try:
        event = OutboxEvent(
            _text(item.get("eventId"), "eventId"),
            _text(item.get("datasetVersion"), "datasetVersion"),
            _text(item.get("eventType"), "eventType"),
            _text(item.get("idempotencyKey"), "idempotencyKey"),
            _parse_utc_text(item.get("createdAt"), "createdAt"),
            cast(Mapping[str, object], payload),
        )
        if dict(item) != pending_outbox(event):
            raise ValueError
        return event
    except (TypeError, ValueError) as error:
        raise DynamoControlProtocolError("DynamoDB pending outbox item is invalid") from error


def _decode_stored_event(item: Mapping[str, object]) -> OutboxEvent:
    """Decodifica stored evento e valida sua forma antes de devolvê-lo.

    Args:
        item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``OutboxEvent`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if item.get("state") == "PENDING":
        return _decode_event(item)
    expected = {
        "pk",
        "sk",
        "entityType",
        "eventId",
        "datasetVersion",
        "eventType",
        "idempotencyKey",
        "createdAt",
        "payload",
        "state",
        "messageId",
        "publishedAt",
    }
    if (
        set(item) != expected
        or item.get("entityType") != "ANALYSIS_OUTBOX"
        or item.get("state") != "PUBLISHED"
        or not isinstance(item.get("payload"), Mapping)
    ):
        raise DynamoControlProtocolError("DynamoDB published outbox item has an invalid shape")
    try:
        event = OutboxEvent(
            _text(item.get("eventId"), "eventId"),
            _text(item.get("datasetVersion"), "datasetVersion"),
            _text(item.get("eventType"), "eventType"),
            _text(item.get("idempotencyKey"), "idempotencyKey"),
            _parse_utc_text(item.get("createdAt"), "createdAt"),
            cast(Mapping[str, object], item["payload"]),
        )
        expected_pending = pending_outbox(event)
        if (
            item.get("pk") != expected_pending["pk"]
            or item.get("sk") != expected_pending["sk"]
            or not isinstance(item.get("messageId"), str)
        ):
            raise ValueError
        _parse_utc_text(item.get("publishedAt"), "publishedAt")
        return event
    except (TypeError, ValueError) as error:
        raise DynamoControlProtocolError("DynamoDB published outbox item is invalid") from error


def _bucket_evidence(
    raw: object, *, maximum_intervals: int | None = None
) -> tuple[tuple[str, int, int, int], ...]:
    """Executa a etapa interna ``bucket_evidence`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        raw: Entrada ``raw``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        maximum_intervals: Entrada ``maximum_intervals``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.

    Returns:
        Valor ``tuple[tuple[str, int, int, int], ...]`` produzido pela operação após as
        validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(raw, list):
        raise DynamoControlProtocolError("DynamoDB bucket evidence is invalid")
    if maximum_intervals is not None and len(raw) > maximum_intervals:
        raise DynamoControlProtocolError("DynamoDB bucket evidence exceeds the bounded tail")
    evidence: list[tuple[str, int, int, int]] = []
    for value in raw:
        if not isinstance(value, Mapping):
            raise DynamoControlProtocolError("DynamoDB bucket evidence is invalid")
        dataset, start, end, grain = (
            value.get("dataset"),
            value.get("startMs"),
            value.get("endMs"),
            value.get("grainSeconds"),
        )
        if (
            not isinstance(dataset, str)
            or not dataset
            or any(
                isinstance(item, bool) or not isinstance(item, int) for item in (start, end, grain)
            )
        ):
            raise DynamoControlProtocolError("DynamoDB bucket evidence is invalid")
        assert isinstance(start, int) and isinstance(end, int) and isinstance(grain, int)
        if start < 0 or end <= start or grain < 0:
            raise DynamoControlProtocolError("DynamoDB bucket evidence is invalid")
        if grain == 0:
            if end != start + 1:
                raise DynamoControlProtocolError("DynamoDB bucket evidence is invalid")
        elif start % (grain * 1000) != 0 or (end - start) % (grain * 1000) != 0:
            raise DynamoControlProtocolError("DynamoDB bucket evidence is invalid")
        evidence.append((dataset, start, end, grain))
    return tuple(evidence)


def _domain_cancellation(reasons: object, count: int, positions: frozenset[int]) -> bool:
    """Verifica a condição associada a domain cancellation.

    Args:
        reasons: Entrada ``reasons``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        count: Entrada ``count``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        positions: Entrada ``positions``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.
    """
    if not isinstance(reasons, list) or len(reasons) != count:
        return False
    failures: set[int] = set()
    for index, reason in enumerate(reasons):
        if not isinstance(reason, Mapping):
            return False
        code = reason.get("Code")
        if code == "None":
            continue
        if code != "ConditionalCheckFailed":
            return False
        failures.add(index)
    return bool(failures) and failures <= positions


class DynamoOutboxRepository(WindowCommitRepository, OutboxRepository, OutboxBacklogInspector):
    """Agrupa o estado e as operações de ``DynamoOutboxRepository`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    build_event = staticmethod(build_analysis_event)
    locator_item = staticmethod(_locator_item)

    def __init__(
        self,
        client: DynamoOutboxClient,
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
        """
        self._client = client
        self._table_name = _text(table_name, "table_name")
        if not callable(clock):
            raise TypeError("clock must be callable")
        self._clock = clock

    def _now(self) -> datetime:
        """Executa a etapa interna ``now`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``datetime`` produzido pela operação após as validações.
        """
        instant = _utc(self._clock(), "clock result")
        return instant.replace(microsecond=(instant.microsecond // 1_000) * 1_000)

    @staticmethod
    def _key(value: object) -> str:
        """Executa a etapa interna ``key`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            value: Valor não confiável que será validado ou convertido.

        Returns:
            Valor ``str`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        key = _text(value, "idempotency_key")
        if len(key.encode("utf-8")) > 1024:
            raise ValueError("idempotency_key exceeds the internal 1024-byte limit")
        return key

    def _get(self, pk: str, sk: str) -> dict[str, object] | None:
        """Obtém a entrada a partir da fonte configurada.

        Args:
            pk: Entrada ``pk``; a forma aceita é definida pela anotação de tipo e validada antes
            do uso.
            sk: Entrada ``sk``; a forma aceita é definida pela anotação de tipo e validada antes
            do uso.

        Returns:
            Valor ``dict[str, object] | None`` produzido pela operação após as validações.

        Raises:
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        try:
            response = self._client.get_item(
                TableName=self._table_name,
                Key={"pk": {"S": pk}, "sk": {"S": sk}},
                ConsistentRead=True,
            )
        except ClientError as error:
            raise_if_dynamodb_throttled(error)
            raise
        item = decode_get_item(response)
        if item is not None and (item.get("pk") != pk or item.get("sk") != sk):
            raise DynamoControlProtocolError("DynamoDB GetItem returned an unexpected key")
        return cast(dict[str, object] | None, _normalize_numbers(item))

    def get_watermark(self, dataset_version: str, source: str) -> datetime | None:
        """Obtém marca d'água a partir da fonte configurada.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            source: Identificador da fonte de dados processada.

        Returns:
            Valor ``datetime | None`` produzido pela operação após as validações.

        Raises:
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        item = self._get(f"DATASET#{dataset_version}#INGESTION#SOURCE#{source}", "WATERMARK")
        if item is None:
            return None
        value = item.get("publishedWatermark")
        if not isinstance(value, str):
            raise DynamoControlProtocolError("DynamoDB watermark is invalid")
        return _utc(datetime.fromisoformat(value.replace("Z", "+00:00")), "publishedWatermark")

    def get_bucket_evidence(
        self, dataset_version: str, source: str
    ) -> tuple[tuple[str, int, int, int], ...]:
        """Obtém bucket evidência a partir da fonte configurada.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            source: Identificador da fonte de dados processada.

        Returns:
            Valor ``tuple[tuple[str, int, int, int], ...]`` produzido pela operação após as
            validações.

        Raises:
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        item = self._get(f"DATASET#{dataset_version}#INGESTION#SOURCE#{source}", "WATERMARK")
        if item is None:
            return ()
        raw = item.get("bucketEvidence", [])
        try:
            _ensure_size(item)
        except ValueError as error:
            raise DynamoControlProtocolError(
                "DynamoDB bucket evidence exceeds the item limit"
            ) from error
        return _bucket_evidence(raw)

    def get_outbox_event(self, event_id: str) -> OutboxEvent | None:
        """Obtém outbox evento a partir da fonte configurada.

        Args:
            event_id: Identificador estável da entidade ou operação correspondente.

        Returns:
            Valor ``OutboxEvent | None`` produzido pela operação após as validações.

        Raises:
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        identity = _text(event_id, "event_id", key_component=True)
        locator = self._get(f"INGESTION#OUTBOX#EVENT#{identity}", "META")
        if locator is None:
            return None
        expected_locator_fields = {"pk", "sk", "entityType", "eventId", "targetPk", "targetSk"}
        if (
            set(locator) != expected_locator_fields
            or locator.get("entityType") != "OUTBOX_LOCATOR"
            or locator.get("eventId") != identity
        ):
            raise DynamoControlProtocolError("DynamoDB outbox locator is invalid")
        target = self._get(
            _text(locator.get("targetPk"), "outbox locator targetPk"),
            _text(locator.get("targetSk"), "outbox locator targetSk"),
        )
        if target is None:
            raise DynamoControlProtocolError("DynamoDB outbox locator has no event")
        event = _decode_stored_event(target)
        if event.event_id != identity:
            raise DynamoControlProtocolError("DynamoDB outbox locator points to another event")
        return event

    def _marker(
        self, scope: str, key: str, fingerprint: str, result: Mapping[str, object]
    ) -> dict[str, object]:
        """Executa a etapa interna ``marker`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            scope: Entrada ``scope``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``dict[str, object]`` produzido pela operação após as validações.
        """
        item = {
            "pk": _marker_pk(scope, key),
            "sk": "META",
            "operation": scope,
            "fingerprint": fingerprint,
            "result": result,
            "ttl": int(self._now().timestamp()) + _MARKER_TTL_SECONDS,
        }
        _ensure_size(item)
        return item

    def _replayed(self, scope: str, key: str, fingerprint: str) -> bool:
        """Verifica a condição associada a replayed.

        Args:
            scope: Entrada ``scope``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.

        Returns:
            Valor ``bool`` produzido pela operação após as validações.

        Raises:
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
            IdempotencyConflict: Se a operação não puder preservar as invariantes descritas.
        """
        marker = self._get(_marker_pk(scope, key), "META")
        if marker is None:
            return False
        if set(marker) != {"pk", "sk", "operation", "fingerprint", "result", "ttl"}:
            raise DynamoControlProtocolError("DynamoDB outbox idempotency marker is invalid")
        if marker.get("operation") != scope or marker.get("result") != {"kind": "none"}:
            raise DynamoControlProtocolError("DynamoDB outbox idempotency marker is invalid")
        if marker.get("fingerprint") != fingerprint:
            raise IdempotencyConflict("idempotency key was reused with different input")
        return True

    def _write(
        self,
        items: list[dict[str, object]],
        *,
        scope: str,
        key: str,
        fingerprint: str,
        conditional_positions: frozenset[int],
        error_message: str,
    ) -> None:
        """Grava a entrada e devolve a evidência produzida pela operação.

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
            error_message: Mensagem não confiável que será sanitizada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
        """
        try:
            validate_transaction_response(self._client.transact_write_items(TransactItems=items))
        except ClientError as error:
            raise_if_dynamodb_throttled(error)
            code = error.response.get("Error", {}).get("Code")
            if code not in {"ConditionalCheckFailedException", "TransactionCanceledException"}:
                raise
            if self._replayed(scope, key, fingerprint):
                return
            if code == "TransactionCanceledException" and not _domain_cancellation(
                error.response.get("CancellationReasons"), len(items), conditional_positions
            ):
                raise
            raise ConditionalWriteError(error_message) from None

    def commit_watermark_and_outboxes(
        self,
        dataset_version: str,
        source: str,
        watermark: datetime,
        events: tuple[OutboxEvent, ...],
        *,
        expected_watermark: datetime | None,
        idempotency_key: str,
        bucket_evidence: tuple[tuple[str, int, int, int], ...] = (),
    ) -> None:
        """Confirma marca d'água and outboxes atomicamente usando as evidências esperadas.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            source: Identificador da fonte de dados processada.
            watermark: Entrada ``watermark``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            events: Entrada ``events``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            expected_watermark: Valor esperado usado para detectar concorrência ou divergência
            de estado.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.
            bucket_evidence: Entrada ``bucket_evidence``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        version = _text(dataset_version, "dataset_version", key_component=True)
        source_name = _text(source, "source", key_component=True)
        published = _utc(watermark, "watermark")
        expected = (
            None if expected_watermark is None else _utc(expected_watermark, "expected_watermark")
        )
        key = self._key(idempotency_key)
        if isinstance(events, tuple) and any(
            not isinstance(event, OutboxEvent) for event in events
        ):
            raise TypeError("events must contain only OutboxEvent values")
        validate_window_commit_contract(version, source_name, published, events, expected)
        if expected is not None and published <= expected:
            raise ConditionalWriteError("watermark must move forward")
        assert isinstance(events, tuple)
        if any(event.dataset_version != version for event in events):
            raise ConditionalWriteError("outbox event belongs to another dataset version")
        if len({event.event_id for event in events}) != len(events):
            raise ConditionalWriteError("window contains duplicate outbox event ids")
        if len({event.event_type for event in events}) != len(events):
            raise ConditionalWriteError("window contains duplicate outbox event types")
        raw_evidence = [
            {"dataset": dataset, "startMs": start, "endMs": end, "grainSeconds": grain}
            for dataset, start, end, grain in bucket_evidence
        ]
        if len(bucket_evidence) > _MAX_BUCKET_EVIDENCE_INTERVALS:
            raise ValueError("bucket evidence exceeds the bounded tail")
        try:
            _bucket_evidence(raw_evidence, maximum_intervals=_MAX_BUCKET_EVIDENCE_INTERVALS)
        except DynamoControlProtocolError as error:
            raise ValueError("bucket evidence is invalid") from error
        event_items = [pending_outbox(event) for event in events]
        fingerprint = hashlib.sha256(
            canonical_bytes(
                {
                    "datasetVersion": version,
                    "source": source_name,
                    "watermark": published,
                    "events": event_items,
                    "expectedWatermark": expected,
                    "bucketEvidence": bucket_evidence,
                }
            )
        ).hexdigest()
        if self._replayed("window-commit", key, fingerprint):
            return
        watermark_item: dict[str, object] = {
            "pk": f"DATASET#{version}#INGESTION#SOURCE#{source_name}",
            "sk": "WATERMARK",
            "entityType": "WATERMARK",
            "datasetVersion": version,
            "source": source_name,
            "publishedWatermark": _utc_text(published),
        }
        if bucket_evidence:
            watermark_item["bucketEvidence"] = [
                {"dataset": dataset, "startMs": start, "endMs": end, "grainSeconds": grain}
                for dataset, start, end, grain in bucket_evidence
            ]
        _ensure_size(watermark_item)
        watermark_put: dict[str, object] = {
            "TableName": self._table_name,
            "Item": serialize_item(watermark_item),
        }
        if expected is None:
            watermark_put["ConditionExpression"] = "attribute_not_exists(pk)"
        else:
            watermark_put.update(
                {
                    "ConditionExpression": "publishedWatermark = :expected",
                    "ExpressionAttributeValues": serialize_item({":expected": _utc_text(expected)}),
                }
            )
        writes: list[dict[str, object]] = [{"Put": watermark_put}]
        for event, item in zip(events, event_items, strict=True):
            writes.extend(
                [
                    {
                        "Put": {
                            "TableName": self._table_name,
                            "Item": serialize_item(item),
                            "ConditionExpression": "attribute_not_exists(pk)",
                        }
                    },
                    {
                        "Put": {
                            "TableName": self._table_name,
                            "Item": serialize_item(_locator_item(event)),
                            "ConditionExpression": "attribute_not_exists(pk)",
                        }
                    },
                ]
            )
        marker = self._marker("window-commit", key, fingerprint, {"kind": "none"})
        writes.append(
            {
                "Put": {
                    "TableName": self._table_name,
                    "Item": serialize_item(marker),
                    "ConditionExpression": "attribute_not_exists(pk)",
                }
            }
        )
        self._write(
            writes,
            scope="window-commit",
            key=key,
            fingerprint=fingerprint,
            conditional_positions=frozenset(range(len(writes))),
            error_message="watermark or outbox state differs from the expected state",
        )

    def list_pending(self, limit: int) -> tuple[OutboxEvent, ...]:
        """Lista pendente respeitando os limites informados.

        Args:
            limit: Quantidade máxima de itens que a operação pode processar.

        Returns:
            Valor ``tuple[OutboxEvent, ...]`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        if isinstance(limit, bool) or not isinstance(limit, int):
            raise TypeError("limit must be an integer")
        if limit <= 0:
            raise ValueError("limit must be positive")
        result: list[OutboxEvent] = []
        start_key: object = None
        while len(result) < limit:
            request: dict[str, object] = {
                "TableName": self._table_name,
                "IndexName": _INDEX_NAME,
                "KeyConditionExpression": "#state_pk = :pending",
                "ExpressionAttributeNames": {"#state_pk": "outboxStatePk"},
                "ExpressionAttributeValues": {":pending": {"S": PENDING_OUTBOX_PARTITION_KEY}},
                "ScanIndexForward": True,
                "Limit": limit - len(result),
            }
            if start_key is not None:
                request["ExclusiveStartKey"] = start_key
            try:
                response = self._client.query(**request)
            except ClientError as error:
                raise_if_dynamodb_throttled(error)
                raise
            if not isinstance(response, Mapping):
                raise DynamoControlProtocolError("DynamoDB outbox Query response must be a mapping")
            raw_items = response.get("Items")
            if not isinstance(raw_items, list):
                raise DynamoControlProtocolError("DynamoDB outbox Query Items must be a list")
            for raw in raw_items:
                result.append(_decode_event(_decode_item(raw)))
                if len(result) == limit:
                    break
            next_key = response.get("LastEvaluatedKey")
            if next_key is None or len(result) == limit:
                break
            if not isinstance(next_key, Mapping) or not next_key or next_key == start_key:
                raise DynamoControlProtocolError("DynamoDB outbox Query pagination key is invalid")
            start_key = next_key
        ordered = sorted(
            result,
            key=lambda event: (event.created_at, event.event_type, event.event_id),
        )
        if result != ordered:
            raise DynamoControlProtocolError("DynamoDB outbox Query returned events out of order")
        return tuple(result)

    def inspect_pending(self) -> OutboxBacklog:
        """Executa a etapa interna ``inspect_pending`` e devolve o resultado validado indicado
        pela assinatura.

        Returns:
            Valor ``OutboxBacklog`` produzido pela operação após as validações.

        Raises:
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        request: dict[str, object] = {
            "TableName": self._table_name,
            "IndexName": _INDEX_NAME,
            "KeyConditionExpression": "#state_pk = :pending",
            "ExpressionAttributeNames": {"#state_pk": "outboxStatePk"},
            "ExpressionAttributeValues": {":pending": {"S": PENDING_OUTBOX_PARTITION_KEY}},
            "ProjectionExpression": "pk, sk, #state_pk, outboxStateSk, createdAt",
            "ScanIndexForward": True,
            "Limit": 100,
        }
        expected_fields = {"pk", "sk", "outboxStatePk", "outboxStateSk", "createdAt"}
        oldest: datetime | None = None
        count = 0
        start_key: object = None
        previous_key: object = None
        while True:
            if start_key is not None:
                if not isinstance(start_key, Mapping) or not start_key or start_key == previous_key:
                    raise DynamoControlProtocolError(
                        "DynamoDB outbox Query pagination key is invalid"
                    )
                previous_key = start_key
                request["ExclusiveStartKey"] = start_key
            try:
                page = self._client.query(**request)
            except ClientError as error:
                raise_if_dynamodb_throttled(error)
                raise
            if not isinstance(page, Mapping):
                raise DynamoControlProtocolError("DynamoDB outbox Query response must be a mapping")
            raw_items = page.get("Items")
            page_count = page.get("Count")
            scanned = page.get("ScannedCount")
            if (
                not isinstance(raw_items, list)
                or isinstance(page_count, bool)
                or not isinstance(page_count, int)
                or page_count < 0
                or scanned != page_count
                or len(raw_items) != page_count
                or page_count > 100
            ):
                raise DynamoControlProtocolError(
                    "DynamoDB projected outbox Query response is invalid"
                )
            for raw_item in raw_items:
                if not isinstance(raw_item, Mapping) or set(raw_item) != expected_fields:
                    raise DynamoControlProtocolError("DynamoDB projected outbox item is invalid")
            if oldest is None and raw_items:
                raw_created = raw_items[0].get("createdAt")
                if (
                    not isinstance(raw_created, Mapping)
                    or set(raw_created) != {"S"}
                    or not isinstance(raw_created.get("S"), str)
                ):
                    raise DynamoControlProtocolError("DynamoDB outbox createdAt is invalid")
                oldest = _parse_utc_text(raw_created["S"], "createdAt")
            count += page_count
            start_key = page.get("LastEvaluatedKey")
            if start_key is None:
                break
        if (count == 0) != (oldest is None):
            raise DynamoControlProtocolError("DynamoDB outbox count and oldest item disagree")
        return OutboxBacklog(count, oldest)

    def mark_published(
        self,
        event_id: str,
        message_id: str,
        *,
        expected_state: str,
        idempotency_key: str,
    ) -> None:
        """Marca published por meio de uma transição validada.

        Args:
            event_id: Identificador estável da entidade ou operação correspondente.
            message_id: Identificador estável da entidade ou operação correspondente.
            expected_state: Estado previamente observado usado no controle de concorrência.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        identity = _text(event_id, "event_id", key_component=True)
        message = _text(message_id, "message_id")
        if expected_state != "PENDING":
            raise ValueError("expected_state must be PENDING")
        key = self._key(idempotency_key)
        fingerprint = hashlib.sha256(
            canonical_bytes(
                {"eventId": identity, "messageId": message, "expectedState": expected_state}
            )
        ).hexdigest()
        if self._replayed("outbox-published", key, fingerprint):
            return
        locator = self._get(f"INGESTION#OUTBOX#EVENT#{identity}", "META")
        expected_locator_fields = {"pk", "sk", "entityType", "eventId", "targetPk", "targetSk"}
        if locator is None:
            raise ConditionalWriteError("outbox event does not exist")
        if (
            set(locator) != expected_locator_fields
            or locator.get("entityType") != "OUTBOX_LOCATOR"
            or locator.get("eventId") != identity
        ):
            raise DynamoControlProtocolError("DynamoDB outbox locator is invalid")
        target_pk = _text(locator.get("targetPk"), "outbox locator targetPk")
        target_sk = _text(locator.get("targetSk"), "outbox locator targetSk")
        values = serialize_item(
            {
                ":pending": "PENDING",
                ":published": "PUBLISHED",
                ":message_id": message,
                ":published_at": _utc_text(self._now()),
            }
        )
        marker = self._marker("outbox-published", key, fingerprint, {"kind": "none"})
        writes: list[dict[str, object]] = [
            {
                "Update": {
                    "TableName": self._table_name,
                    "Key": serialize_item({"pk": target_pk, "sk": target_sk}),
                    "ConditionExpression": "#state = :pending",
                    "UpdateExpression": (
                        "SET #state = :published, messageId = :message_id, "
                        "publishedAt = :published_at REMOVE outboxStatePk, outboxStateSk"
                    ),
                    "ExpressionAttributeNames": {"#state": "state"},
                    "ExpressionAttributeValues": values,
                }
            },
            {
                "Put": {
                    "TableName": self._table_name,
                    "Item": serialize_item(marker),
                    "ConditionExpression": "attribute_not_exists(pk)",
                }
            },
        ]
        self._write(
            writes,
            scope="outbox-published",
            key=key,
            fingerprint=fingerprint,
            conditional_positions=frozenset({0, 1}),
            error_message="outbox state differs from expected_state",
        )


__all__ = [
    "DynamoOutboxClient",
    "DynamoOutboxRepository",
    "build_analysis_event",
    "pending_outbox",
]
