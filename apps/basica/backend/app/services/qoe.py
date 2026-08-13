"""Métricas de qualidade de experiência (QoE) da reprodução."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from app.domain.clock import to_iso
from app.domain.models import PlaybackEvent
from app.domain.statistics import mean, percentile, rate, rounded
from app.domain.time_window import TimeWindow, group_by_bucket
from app.repositories import TelemetryRepository


@dataclass(frozen=True, slots=True)
class QoeMetrics:
    """Indicadores de QoE de um conjunto de eventos de reprodução."""

    events: int
    sessions: int
    playback_hours: float
    startup_samples: int
    startup_p50_ms: float | None
    startup_p95_ms: float | None
    startup_avg_ms: float | None
    rebuffer_rate: float | None
    rebuffer_count: int
    average_bitrate_kbps: float | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "events": self.events,
            "sessions": self.sessions,
            "playback_hours": rounded(self.playback_hours, 3),
            "startup_time_ms": {
                "samples": self.startup_samples,
                "p50": rounded(self.startup_p50_ms, 1),
                "p95": rounded(self.startup_p95_ms, 1),
                "average": rounded(self.startup_avg_ms, 1),
            },
            "rebuffer": {
                "rate": rounded(self.rebuffer_rate),
                "count": self.rebuffer_count,
            },
            "average_bitrate_kbps": rounded(self.average_bitrate_kbps, 1),
        }


class QoeService:
    """Consolida VST, rebuffer e bitrate a partir dos eventos de reprodução."""

    def __init__(self, repository: TelemetryRepository) -> None:
        self._repository = repository

    def metrics(self, window: TimeWindow) -> dict[str, Any]:
        """Métricas agregadas de QoE da janela."""
        events = self._repository.events(window)
        return {"window": window.as_dict(), "metrics": self.summarize(events).as_dict()}

    def timeseries(self, window: TimeWindow, interval: timedelta) -> dict[str, Any]:
        """Evolução das métricas de QoE ao longo da janela."""
        buckets = window.buckets(interval)
        grouped = group_by_bucket(self._repository.events(window), buckets)

        points = [
            {
                "start": to_iso(bucket.start),
                "end": to_iso(bucket.end),
                "metrics": self.summarize(events).as_dict(),
            }
            for bucket, events in zip(buckets, grouped, strict=True)
        ]
        return {
            "window": window.as_dict(),
            "interval_seconds": int(interval.total_seconds()),
            "points": points,
        }

    @staticmethod
    def summarize(events: Sequence[PlaybackEvent]) -> QoeMetrics:
        """Calcula os indicadores de QoE de uma coleção de eventos.

        O rebuffer rate segue a definição usual do mercado: tempo travado
        dividido pelo tempo total de visualização (reprodução + travamentos).
        O bitrate médio é ponderado pela duração de reprodução de cada amostra.
        """
        startup_times = [
            event.startup_time_ms for event in events if event.startup_time_ms is not None
        ]
        playback_ms = sum(event.playback_duration_ms for event in events)
        rebuffer_ms = sum(event.rebuffer_duration_ms for event in events)

        bitrate_samples = [
            (event.bitrate_kbps, event.playback_duration_ms)
            for event in events
            if event.bitrate_kbps is not None
        ]
        total_weight = sum(weight for _, weight in bitrate_samples)
        if total_weight:
            average_bitrate = (
                sum(bitrate * weight for bitrate, weight in bitrate_samples) / total_weight
            )
        else:
            average_bitrate = mean([bitrate for bitrate, _ in bitrate_samples])

        return QoeMetrics(
            events=len(events),
            sessions=len({event.session_id for event in events}),
            playback_hours=playback_ms / 3_600_000,
            startup_samples=len(startup_times),
            startup_p50_ms=percentile(startup_times, 50),
            startup_p95_ms=percentile(startup_times, 95),
            startup_avg_ms=mean(startup_times),
            rebuffer_rate=rate(rebuffer_ms, playback_ms + rebuffer_ms),
            rebuffer_count=sum(event.rebuffer_count for event in events),
            average_bitrate_kbps=average_bitrate,
        )
