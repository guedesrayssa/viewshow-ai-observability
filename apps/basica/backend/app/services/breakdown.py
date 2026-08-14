"""Segmentação das métricas por dispositivo e por rede."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from typing import Any

from app.domain.aggregation import sessions_of
from app.domain.models import ErrorEvent, PlaybackEvent
from app.domain.statistics import rate, ratio, rounded
from app.domain.time_window import TimeWindow
from app.errors import ValidationError
from app.repositories import TelemetryRepository
from app.services.qoe import QoeService

# Ambas as famílias de dimensões funcionam para eventos e para erros, porque os
# dois modelos carregam os mesmos blocos `device` e `network`.
DEVICE_DIMENSIONS: Mapping[str, Callable[[Any], str]] = {
    "model": lambda record: record.device.model,
    "os": lambda record: record.device.os,
    "os_version": lambda record: record.device.os_version,
    "app_version": lambda record: record.device.app_version,
}

NETWORK_DIMENSIONS: Mapping[str, Callable[[Any], str]] = {
    "isp": lambda record: record.network.isp,
    "cdn": lambda record: record.network.cdn,
    "connection_type": lambda record: record.network.connection_type,
}


class BreakdownService:
    """Compara volume, erros e QoE entre segmentos da base."""

    def __init__(self, repository: TelemetryRepository, qoe_service: QoeService) -> None:
        self._repository = repository
        self._qoe = qoe_service

    def devices(
        self, window: TimeWindow, *, dimension: str = "model", limit: int = 20
    ) -> dict[str, Any]:
        """Segmenta por modelo, sistema operacional ou versão do app."""
        return self._breakdown(window, dimension, DEVICE_DIMENSIONS, limit)

    def network(
        self, window: TimeWindow, *, dimension: str = "cdn", limit: int = 20
    ) -> dict[str, Any]:
        """Segmenta por ISP, CDN ou tipo de conexão."""
        return self._breakdown(window, dimension, NETWORK_DIMENSIONS, limit)

    def _breakdown(
        self,
        window: TimeWindow,
        dimension: str,
        dimensions: Mapping[str, Callable[[Any], str]],
        limit: int,
    ) -> dict[str, Any]:
        select = dimensions.get(dimension)
        if select is None:
            allowed = ", ".join(f"`{name}`" for name in dimensions)
            raise ValidationError(f"O parâmetro `dimension` deve ser um destes valores: {allowed}.")

        events = self._repository.events(window)
        errors = self._repository.errors(window)

        grouped_events = _group(events, select)
        grouped_errors = _group(errors, select)

        groups = [
            self._describe(
                value,
                grouped_events.get(value, []),
                grouped_errors.get(value, []),
                total_events=len(events),
            )
            for value in set(grouped_events) | set(grouped_errors)
        ]
        groups.sort(key=lambda group: (-group["events"], group["value"]))

        return {
            "window": window.as_dict(),
            "dimension": dimension,
            "total_groups": len(groups),
            "breakdown": groups[:limit],
        }

    def _describe(
        self,
        value: str,
        events: Sequence[PlaybackEvent],
        errors: Sequence[ErrorEvent],
        *,
        total_events: int,
    ) -> dict[str, Any]:
        metrics = self._qoe.summarize(events)

        return {
            "value": value,
            "events": len(events),
            "sessions": len(sessions_of(events, errors)),
            "errors": len(errors),
            "error_rate": rounded(rate(len(errors), len(events))),
            "traffic_share": rounded(ratio(len(events), total_events)),
            "qoe": metrics.as_dict(),
        }


def _group(records: Sequence[Any], select: Callable[[Any], str]) -> dict[str, list[Any]]:
    grouped: dict[str, list[Any]] = {}
    for record in records:
        grouped.setdefault(select(record), []).append(record)
    return grouped
