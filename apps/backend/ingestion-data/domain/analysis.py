"""Define o contrato fechado dos eventos de análise e mensagens da outbox.

Papel no fluxo:
    Este arquivo pertence ao núcleo de domínio e deve permanecer determinístico, sem acesso a
    rede, sistema de arquivos, banco de dados ou variáveis de ambiente.

Garantias e limites:
    As validações falham de forma fechada: valores ambíguos ou incompletos são rejeitados antes
    de atravessar uma porta de persistência.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

from domain.canonical_json import canonical_bytes
from domain.identity import sha256_id

ALLOWED_ANALYSIS_EVENT_TYPES = frozenset({"ANOMALY_DETECTION", "QOE_FORECAST"})
MAX_ANALYSIS_MESSAGE_BYTES = 256 * 1024
MAX_OUTBOX_ITEM_BYTES = 200 * 1024
PENDING_OUTBOX_PARTITION_KEY = "OUTBOX#PENDING"

_MODEL_TEXT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")


@dataclass(frozen=True)
class ForecastModel:
    """Identidade do modelo de previsão que o worker exige que coincida com o seu bundle.

    Attributes:
        name: Nome do modelo, o mesmo do bundle aprovado.
        version: Versão do modelo, a mesma do bundle aprovado.
    """

    name: str
    version: str

    def __post_init__(self) -> None:
        """Rejeita nomes ou versões fora do alfabeto seguro e do limite de 64 caracteres.

        Raises:
            ValueError: Se ``name`` ou ``version`` forem inválidos.
        """
        for label, value in (("name", self.name), ("version", self.version)):
            if not isinstance(value, str) or _MODEL_TEXT.fullmatch(value) is None:
                raise ValueError(f"forecast model {label} is invalid")

    def payload(self) -> dict[str, str]:
        """Devolve o objeto ``model`` do payload de ``QOE_FORECAST``."""
        return {"name": self.name, "version": self.version}


# O nome é o do bundle gerado por ``train-models.py``; a versão vem da configuração do ambiente.
DEFAULT_FORECAST_MODEL = ForecastModel("qoe-random-forest", "2026.09.1")


class AnalysisEvent(Protocol):
    """Define o contrato mínimo de análise evento usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    @property
    def event_id(self) -> str:
        """Calcula ou valida o identificador de evento.

        Returns:
            Valor ``str`` produzido pela operação após as validações.
        """
        ...

    @property
    def dataset_version(self) -> str:
        """Executa a etapa interna ``dataset_version`` e devolve o resultado validado indicado
        pela assinatura.

        Returns:
            Valor ``str`` produzido pela operação após as validações.
        """
        ...

    @property
    def event_type(self) -> str:
        """Executa a etapa interna ``event_type`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``str`` produzido pela operação após as validações.
        """
        ...

    @property
    def idempotency_key(self) -> str:
        """Monta a chave de idempotência a partir de componentes validados.

        Returns:
            Valor ``str`` produzido pela operação após as validações.
        """
        ...

    @property
    def created_at(self) -> datetime:
        """Executa a etapa interna ``created_at`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``datetime`` produzido pela operação após as validações.
        """
        ...

    @property
    def payload(self) -> Mapping[str, object]:
        """Executa a etapa interna ``payload`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...


def require_text(value: object, field: str, *, key_component: bool = False) -> str:
    """Valida e devolve texto, rejeitando entradas fora do contrato.

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


def require_utc_milliseconds(value: object, field: str) -> datetime:
    """Valida e devolve utc milliseconds, rejeitando entradas fora do contrato.

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
    instant = value.astimezone(UTC)
    if instant.microsecond % 1000:
        raise ValueError(f"{field} must use millisecond precision")
    return instant


def canonical_utc_text(value: object, field: str) -> str:
    """Produz a representação canônica de utc texto.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    instant = require_utc_milliseconds(value, field)
    return instant.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_canonical_utc_text(value: object, field: str) -> datetime:
    """Converte canônico utc texto para a representação interna validada.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``datetime`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError(f"{field} must be canonical UTC text")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise ValueError(f"{field} must be canonical UTC text") from error
    parsed = require_utc_milliseconds(parsed, field)
    if canonical_utc_text(parsed, field) != value:
        raise ValueError(f"{field} must use millisecond UTC precision")
    return parsed


def _event_identity(event: AnalysisEvent, window_end: datetime) -> dict[str, object]:
    """Executa a etapa interna ``event_identity`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        event: Evento de análise validado que será codificado ou publicado.
        window_end: Entrada ``window_end``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.
    """
    return {
        "datasetVersion": event.dataset_version,
        "eventType": event.event_type,
        "windowEnd": window_end,
    }


def validate_analysis_event(
    event: AnalysisEvent,
    *,
    expected_watermark: datetime | None = None,
) -> datetime:
    """Valida análise evento contra as invariantes deste módulo.

    Args:
        event: Evento de análise validado que será codificado ou publicado.
        expected_watermark: Valor esperado usado para detectar concorrência ou divergência de
        estado.

    Returns:
        Valor ``datetime`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    require_text(event.event_id, "event.event_id")
    require_text(event.dataset_version, "event.dataset_version", key_component=True)
    event_type = require_text(event.event_type, "event.event_type")
    require_text(event.idempotency_key, "event.idempotency_key")
    require_utc_milliseconds(event.created_at, "event.created_at")

    # Esta allowlist precisa anteceder todos os ramos de payload dependentes do tipo.
    if event_type not in ALLOWED_ANALYSIS_EVENT_TYPES:
        raise ValueError("outbox event type is not supported")

    expected_fields = {"window", "scope", "inputWatermark"}
    if event_type == "QOE_FORECAST":
        expected_fields |= {"model", "targetWindow"}
    if not isinstance(event.payload, Mapping) or set(event.payload) != expected_fields:
        raise ValueError("outbox payload has an invalid closed shape")

    window = event.payload.get("window")
    if not isinstance(window, Mapping) or set(window) != {"start", "end", "grainSeconds"}:
        raise ValueError("outbox payload window has an invalid shape")
    start = parse_canonical_utc_text(window.get("start"), "payload.window.start")
    end = parse_canonical_utc_text(window.get("end"), "payload.window.end")
    grain = window.get("grainSeconds")
    required_grain = 900 if event_type == "ANOMALY_DETECTION" else 3600
    if isinstance(grain, bool) or not isinstance(grain, int) or grain != required_grain:
        raise ValueError("outbox payload window grain is invalid")
    if end - start != timedelta(seconds=grain):
        raise ValueError("outbox payload window duration differs from its grain")
    if event.payload.get("inputWatermark") != canonical_utc_text(end, "payload.window.end"):
        raise ValueError("outbox payload inputWatermark must equal the window end")

    scope = event.payload.get("scope")
    if not isinstance(scope, Mapping) or set(scope) != {"kind", "dimensions"}:
        raise ValueError("outbox payload scope has an invalid shape")
    if scope.get("kind") != "global" or scope.get("dimensions") != {}:
        raise ValueError("outbox payload supports only the closed global scope")

    if event_type == "QOE_FORECAST":
        model = event.payload.get("model")
        target = event.payload.get("targetWindow")
        if not isinstance(model, Mapping) or set(model) != {"name", "version"}:
            raise ValueError("outbox forecast model is invalid")
        model_name, model_version = model["name"], model["version"]
        if not isinstance(model_name, str) or not isinstance(model_version, str):
            raise ValueError("outbox forecast model is invalid")
        ForecastModel(model_name, model_version)
        if not isinstance(target, Mapping) or set(target) != {"start", "end"}:
            raise ValueError("outbox forecast targetWindow has an invalid shape")
        target_start = parse_canonical_utc_text(target.get("start"), "payload.targetWindow.start")
        target_end = parse_canonical_utc_text(target.get("end"), "payload.targetWindow.end")
        if target_start != end or target_end - target_start != timedelta(hours=1):
            raise ValueError("outbox forecast targetWindow must be the following hour")

    identity = _event_identity(event, end)
    if event.event_id != sha256_id("evt_", identity):
        raise ValueError("outbox eventId is not the deterministic window identity")
    if event.idempotency_key != sha256_id("ana_", identity):
        raise ValueError("outbox idempotencyKey is not the deterministic analysis identity")
    if expected_watermark is not None:
        watermark = require_utc_milliseconds(expected_watermark, "watermark")
        if end != watermark:
            raise ValueError("outbox payload inputWatermark must equal the committed watermark")
    return end


def validate_window_commit_contract(
    dataset_version: object,
    source: object,
    watermark: object,
    events: object,
    expected_watermark: object,
) -> None:
    """Valida janela commit contrato contra as invariantes deste módulo.

    Args:
        dataset_version: Identificador imutável da versão do dataset.
        source: Identificador da fonte de dados processada.
        watermark: Entrada ``watermark``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        events: Entrada ``events``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        expected_watermark: Valor esperado usado para detectar concorrência ou divergência de
        estado.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    version = require_text(dataset_version, "dataset_version", key_component=True)
    require_text(source, "source", key_component=True)
    published = require_utc_milliseconds(watermark, "watermark")
    if expected_watermark is not None:
        require_utc_milliseconds(expected_watermark, "expected_watermark")
    if not isinstance(events, tuple):
        raise TypeError("events must be a tuple")
    if len(events) > 2:
        raise ValueError("a window commit accepts at most two outbox events")
    for event in events:
        if event.dataset_version != version:
            continue
        validate_analysis_event(event, expected_watermark=published)


def _dynamodb_attribute_value(value: object) -> dict[str, object]:
    """Produz o valor de dynamodb atributo usado pela etapa seguinte.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    if value is None:
        return {"NULL": True}
    if type(value) is bool:
        return {"BOOL": value}
    if type(value) is str:
        return {"S": value}
    if type(value) is int:
        return {"N": str(value)}
    if isinstance(value, Mapping):
        encoded: dict[str, object] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError("DynamoDB map keys must be strings")
            encoded[key] = _dynamodb_attribute_value(item)
        return {"M": encoded}
    if isinstance(value, list | tuple):
        return {"L": [_dynamodb_attribute_value(item) for item in value]}
    raise TypeError(f"unsupported DynamoDB outbox value: {type(value).__name__}")


def _epoch_milliseconds(value: datetime) -> int:
    """Executa a etapa interna ``epoch_milliseconds`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``int`` produzido pela operação após as validações.
    """
    instant = require_utc_milliseconds(value, "event.created_at")
    delta = instant - datetime(1970, 1, 1, tzinfo=UTC)
    return delta.days * 86_400_000 + delta.seconds * 1_000 + delta.microseconds // 1_000


def pending_analysis_outbox_item(event: AnalysisEvent) -> dict[str, object]:
    """Monta o item de pendente análise outbox no formato esperado pela camada de destino.

    Args:
        event: Evento de análise validado que será codificado ou publicado.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    validate_analysis_event(event)
    created = require_utc_milliseconds(event.created_at, "event.created_at")
    created_text = canonical_utc_text(created, "event.created_at")
    item: dict[str, object] = {
        "pk": f"INGESTION#OUTBOX#{created:%Y%m%d}",
        "sk": (f"CREATED#{_epoch_milliseconds(created)}#{event.event_type}#{event.event_id}"),
        "entityType": "ANALYSIS_OUTBOX",
        "eventId": event.event_id,
        "datasetVersion": event.dataset_version,
        "eventType": event.event_type,
        "idempotencyKey": event.idempotency_key,
        "createdAt": created_text,
        "payload": event.payload,
        "state": "PENDING",
        "outboxStatePk": PENDING_OUTBOX_PARTITION_KEY,
        "outboxStateSk": f"{created_text}#{event.event_type}#{event.event_id}",
    }
    wire_item = {key: _dynamodb_attribute_value(value) for key, value in item.items()}
    if len(canonical_bytes(wire_item)) > MAX_OUTBOX_ITEM_BYTES:
        raise ValueError("outbox item exceeds the internal 200 KiB limit")
    return item


def analysis_envelope(event: AnalysisEvent) -> dict[str, object]:
    """Executa a etapa interna ``analysis_envelope`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        event: Evento de análise validado que será codificado ou publicado.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.
    """
    occurred_at = validate_analysis_event(event)
    identity = _event_identity(event, occurred_at)
    return {
        "eventId": event.event_id,
        "eventType": event.event_type,
        "schemaVersion": "1.0",
        "idempotencyKey": event.idempotency_key,
        "traceId": sha256_id("trc_", identity),
        "occurredAt": canonical_utc_text(occurred_at, "event.window_end"),
        "producedAt": canonical_utc_text(event.created_at, "event.created_at"),
        "source": "data-ingestion-service",
        "payload": {"datasetVersion": event.dataset_version, **dict(event.payload)},
    }


def analysis_message_body(event: AnalysisEvent) -> bytes:
    """Executa a etapa interna ``analysis_message_body`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        event: Evento de análise validado que será codificado ou publicado.

    Returns:
        Valor ``bytes`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    body = canonical_bytes(analysis_envelope(event))
    if len(body) > MAX_ANALYSIS_MESSAGE_BYTES:
        raise ValueError("SQS message exceeds the 256 KiB limit")
    return body


def validate_publish_request(event: AnalysisEvent, idempotency_key: object) -> bytes:
    """Valida publish requisição contra as invariantes deste módulo.

    Args:
        event: Evento de análise validado que será codificado ou publicado.
        idempotency_key: Chave estável que identifica uma repetição da mesma operação.

    Returns:
        Valor ``bytes`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    key = require_text(idempotency_key, "idempotency_key")
    if key != event.idempotency_key:
        raise ValueError("idempotency_key must match event.idempotency_key")
    return analysis_message_body(event)


__all__ = [
    "ALLOWED_ANALYSIS_EVENT_TYPES",
    "AnalysisEvent",
    "DEFAULT_FORECAST_MODEL",
    "ForecastModel",
    "MAX_ANALYSIS_MESSAGE_BYTES",
    "MAX_OUTBOX_ITEM_BYTES",
    "PENDING_OUTBOX_PARTITION_KEY",
    "analysis_envelope",
    "analysis_message_body",
    "canonical_utc_text",
    "parse_canonical_utc_text",
    "pending_analysis_outbox_item",
    "require_text",
    "require_utc_milliseconds",
    "validate_analysis_event",
    "validate_publish_request",
    "validate_window_commit_contract",
]
