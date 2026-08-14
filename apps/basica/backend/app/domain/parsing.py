"""Conversão dos payloads recebidos pela ingestão em modelos de domínio.

A validação é tolerante nas bordas (campos opcionais ganham valores padrão) e
estrita no núcleo: sem `session_id` não há telemetria útil, e um campo presente
com tipo errado é sempre rejeitado em vez de silenciosamente ignorado.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from app.domain.clock import ensure_utc
from app.domain.models import (
    SPAN_ERROR,
    SPAN_OK,
    UNKNOWN,
    DeviceInfo,
    ErrorEvent,
    Heartbeat,
    NetworkInfo,
    PlaybackEvent,
    Span,
)

_VALID_SPAN_STATUSES = {SPAN_OK, SPAN_ERROR}
_DEFAULT_EVENT_TYPE = "playback"

# Tolerância para relógios adiantados nos dispositivos. Datas além disso são
# recusadas: como a retenção do repositório é medida a partir do registro mais
# recente, um único horário absurdo no futuro expiraria toda a base.
MAX_FUTURE_SKEW = timedelta(minutes=5)


class PayloadError(ValueError):
    """Item de telemetria inválido; rejeita apenas o item, não o lote."""


def _text(value: Any, *, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PayloadError(f"O campo `{field}` deve ser um texto não vazio.")
    return value.strip()


def require_text(payload: dict[str, Any], field: str) -> str:
    """Campo textual obrigatório."""
    if field not in payload or payload[field] is None:
        raise PayloadError(f"O campo `{field}` é obrigatório.")
    return _text(payload[field], field=field)


def optional_text(payload: dict[str, Any], field: str, *, default: str = UNKNOWN) -> str:
    """Campo textual opcional; ausente ou vazio, assume o valor padrão."""
    value = payload.get(field)
    if value is None:
        return default
    if isinstance(value, str) and not value.strip():
        return default
    return _text(value, field=field)


def optional_identifier(payload: dict[str, Any], field: str) -> str | None:
    """Identificador opcional que permanece ``None`` quando ausente."""
    value = payload.get(field)
    if value is None:
        return None
    return _text(value, field=field)


def optional_flag(payload: dict[str, Any], field: str, *, default: bool = False) -> bool:
    """Booleano opcional; strings como `true`/`false` também são aceitas."""
    value = payload.get(field)
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in {"true", "false"}:
        return value.strip().lower() == "true"
    raise PayloadError(f"O campo `{field}` deve ser booleano.")


def optional_number(
    payload: dict[str, Any],
    field: str,
    *,
    default: float | None = None,
    minimum: float | None = 0.0,
) -> float | None:
    """Número opcional, com piso configurável (por padrão, não negativo)."""
    value = payload.get(field)
    if value is None:
        return default
    # ``bool`` é subclasse de ``int``: precisa ser recusado explicitamente.
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise PayloadError(f"O campo `{field}` deve ser numérico.")

    try:
        number = float(value)
    except ValueError as exc:
        raise PayloadError(f"O campo `{field}` deve ser numérico.") from exc

    if number != number or number in (float("inf"), float("-inf")):
        raise PayloadError(f"O campo `{field}` deve ser um número finito.")
    if minimum is not None and number < minimum:
        raise PayloadError(f"O campo `{field}` não pode ser menor que {minimum:g}.")
    return number


def optional_count(payload: dict[str, Any], field: str, *, default: int = 0) -> int:
    """Contagem inteira não negativa."""
    number = optional_number(payload, field, default=float(default))
    if number is None:
        return default
    if number != int(number):
        raise PayloadError(f"O campo `{field}` deve ser um número inteiro.")
    return int(number)


def read_timestamp(
    payload: dict[str, Any],
    field: str,
    *,
    now: datetime,
    fallback: datetime | None = None,
) -> datetime:
    """Data ISO 8601 do registro; ausente, assume `fallback` (ou a ingestão)."""
    value = payload.get(field)
    if value is None:
        return ensure_utc(fallback or now)
    if not isinstance(value, str):
        raise PayloadError(f"O campo `{field}` deve ser uma data ISO 8601 em formato texto.")

    try:
        moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise PayloadError(
            f"O campo `{field}` deve ser uma data ISO 8601, por exemplo `2026-08-11T12:00:00Z`."
        ) from exc

    moment = ensure_utc(moment)
    if moment - ensure_utc(now) > MAX_FUTURE_SKEW:
        raise PayloadError(
            f"O campo `{field}` está muito à frente do horário do servidor; "
            "verifique o relógio do dispositivo."
        )
    return moment


def _nested(payload: dict[str, Any], field: str) -> dict[str, Any]:
    value = payload.get(field)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise PayloadError(f"O campo `{field}` deve ser um objeto JSON.")
    return value


def parse_device(payload: dict[str, Any]) -> DeviceInfo:
    """Extrai o bloco `device` do payload."""
    device = _nested(payload, "device")
    return DeviceInfo(
        model=optional_text(device, "model"),
        os=optional_text(device, "os"),
        os_version=optional_text(device, "os_version"),
        app_version=optional_text(device, "app_version"),
    )


def parse_network(payload: dict[str, Any]) -> NetworkInfo:
    """Extrai o bloco `network` do payload."""
    network = _nested(payload, "network")
    return NetworkInfo(
        isp=optional_text(network, "isp"),
        cdn=optional_text(network, "cdn"),
        connection_type=optional_text(network, "connection_type"),
    )


def parse_spans(
    payload: dict[str, Any],
    *,
    trace_id: str | None,
    now: datetime,
    default_started_at: datetime,
) -> tuple[Span, ...]:
    """Converte o bloco `spans` em spans de trace, exigindo `trace_id`."""
    raw_spans = payload.get("spans")
    if raw_spans is None:
        return ()
    if not isinstance(raw_spans, list):
        raise PayloadError("O campo `spans` deve ser uma lista de objetos JSON.")
    if not raw_spans:
        return ()
    if not trace_id:
        raise PayloadError("O campo `spans` exige que `trace_id` seja informado.")

    spans: list[Span] = []
    for index, raw in enumerate(raw_spans):
        if not isinstance(raw, dict):
            raise PayloadError(f"O span na posição {index} deve ser um objeto JSON.")

        status = optional_text(raw, "status", default=SPAN_OK).lower()
        if status not in _VALID_SPAN_STATUSES:
            raise PayloadError(
                f"O campo `status` do span na posição {index} deve ser `ok` ou `error`."
            )

        spans.append(
            Span(
                span_id=optional_identifier(raw, "span_id") or f"{trace_id}-{index}",
                trace_id=trace_id,
                service=optional_text(raw, "service"),
                operation=optional_text(raw, "operation"),
                started_at=read_timestamp(raw, "started_at", now=now, fallback=default_started_at),
                duration_ms=optional_number(raw, "duration_ms", default=0.0) or 0.0,
                status=status,
                parent_span_id=optional_identifier(raw, "parent_span_id"),
            )
        )
    return tuple(spans)


def parse_playback_event(payload: dict[str, Any], *, now: datetime) -> PlaybackEvent:
    """Converte um payload de `/v1/telemetry/events`."""
    occurred_at = read_timestamp(payload, "timestamp", now=now)
    trace_id = optional_identifier(payload, "trace_id")

    return PlaybackEvent(
        session_id=require_text(payload, "session_id"),
        event_type=optional_text(payload, "event_type", default=_DEFAULT_EVENT_TYPE).lower(),
        occurred_at=occurred_at,
        device=parse_device(payload),
        network=parse_network(payload),
        content_id=optional_identifier(payload, "content_id"),
        trace_id=trace_id,
        startup_time_ms=optional_number(payload, "startup_time_ms"),
        rebuffer_duration_ms=optional_number(payload, "rebuffer_duration_ms", default=0.0) or 0.0,
        rebuffer_count=optional_count(payload, "rebuffer_count"),
        playback_duration_ms=optional_number(payload, "playback_duration_ms", default=0.0) or 0.0,
        bitrate_kbps=optional_number(payload, "bitrate_kbps"),
        spans=parse_spans(payload, trace_id=trace_id, now=now, default_started_at=occurred_at),
    )


def parse_error_event(payload: dict[str, Any], *, now: datetime) -> ErrorEvent:
    """Converte um payload de `/v1/telemetry/errors`."""
    occurred_at = read_timestamp(payload, "timestamp", now=now)
    trace_id = optional_identifier(payload, "trace_id")

    return ErrorEvent(
        session_id=require_text(payload, "session_id"),
        error_code=require_text(payload, "error_code").upper(),
        occurred_at=occurred_at,
        message=optional_text(payload, "message", default=""),
        module=optional_text(payload, "module"),
        service=optional_text(payload, "service"),
        fatal=optional_flag(payload, "fatal"),
        device=parse_device(payload),
        network=parse_network(payload),
        content_id=optional_identifier(payload, "content_id"),
        trace_id=trace_id,
        spans=parse_spans(payload, trace_id=trace_id, now=now, default_started_at=occurred_at),
    )


def parse_heartbeat(payload: dict[str, Any], *, now: datetime) -> Heartbeat:
    """Converte um payload de `/v1/telemetry/heartbeat`."""
    return Heartbeat(
        session_id=require_text(payload, "session_id"),
        occurred_at=read_timestamp(payload, "timestamp", now=now),
        device=parse_device(payload),
        network=parse_network(payload),
        content_id=optional_identifier(payload, "content_id"),
    )
