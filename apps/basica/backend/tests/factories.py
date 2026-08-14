"""Fábricas de dados de domínio usadas pelos testes.

Todos os registros são posicionados em relação a `BASE_TIME`, o que mantém os
testes determinísticos e independentes do relógio da máquina.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from app.domain.models import DeviceInfo, ErrorEvent, Heartbeat, NetworkInfo, PlaybackEvent, Span
from app.domain.time_window import TimeWindow
from app.repositories import InMemoryTelemetryRepository

BASE_TIME = datetime(2026, 8, 11, 12, 0, tzinfo=timezone.utc)


def at(minutes: float = 0, seconds: float = 0) -> datetime:
    """Instante deslocado a partir de `BASE_TIME`."""
    return BASE_TIME + timedelta(minutes=minutes, seconds=seconds)


def window(start_minutes: float = -1, end_minutes: float = 60) -> TimeWindow:
    """Janela ampla o bastante para conter os registros das fábricas."""
    return TimeWindow(at(start_minutes), at(end_minutes))


def device(**overrides: str) -> DeviceInfo:
    return DeviceInfo(
        **{
            "model": "tv-box-a",
            "os": "android",
            "os_version": "13",
            "app_version": "2.4.0",
            **overrides,
        }
    )


def network(**overrides: str) -> NetworkInfo:
    return NetworkInfo(
        **{"isp": "isp-alpha", "cdn": "cdn-1", "connection_type": "wifi", **overrides}
    )


def span(
    span_id: str,
    service: str,
    *,
    trace_id: str = "trace-1",
    minutes: float = 0,
    seconds: float = 0,
    duration_ms: float = 100.0,
    status: str = "ok",
    parent_span_id: str | None = None,
    operation: str = "handle",
) -> Span:
    return Span(
        span_id=span_id,
        trace_id=trace_id,
        service=service,
        operation=operation,
        started_at=at(minutes, seconds),
        duration_ms=duration_ms,
        status=status,
        parent_span_id=parent_span_id,
    )


def event(
    session_id: str = "session-1",
    *,
    minutes: float = 0,
    seconds: float = 0,
    **overrides: Any,
) -> PlaybackEvent:
    fields: dict[str, Any] = {
        "event_type": "playback",
        "device": device(),
        "network": network(),
        "playback_duration_ms": 60_000.0,
        "bitrate_kbps": 4_000.0,
        **overrides,
    }
    return PlaybackEvent(session_id=session_id, occurred_at=at(minutes, seconds), **fields)


def error(
    session_id: str = "session-1",
    error_code: str = "PLAYER_TIMEOUT",
    *,
    minutes: float = 0,
    seconds: float = 0,
    **overrides: Any,
) -> ErrorEvent:
    fields: dict[str, Any] = {
        "message": "timeout ao carregar manifesto",
        "module": "player",
        "service": "playback-api",
        "device": device(),
        "network": network(),
        **overrides,
    }
    return ErrorEvent(
        session_id=session_id, error_code=error_code, occurred_at=at(minutes, seconds), **fields
    )


def heartbeat(
    session_id: str = "session-1",
    *,
    minutes: float = 0,
    seconds: float = 0,
    **overrides: Any,
) -> Heartbeat:
    fields: dict[str, Any] = {"device": device(), "network": network(), **overrides}
    return Heartbeat(session_id=session_id, occurred_at=at(minutes, seconds), **fields)


def repository(
    *,
    events: list[PlaybackEvent] | None = None,
    errors: list[ErrorEvent] | None = None,
    heartbeats: list[Heartbeat] | None = None,
    **options: Any,
) -> InMemoryTelemetryRepository:
    """Repositório pré-carregado com os registros informados."""
    store = InMemoryTelemetryRepository(**options)
    store.add_events(events or [])
    store.add_errors(errors or [])
    store.add_heartbeats(heartbeats or [])
    return store
