"""Visão em tempo real: CCU, volume, taxa de erros e alertas."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from app.domain.aggregation import sessions_of
from app.domain.clock import to_iso, utcnow
from app.domain.models import ErrorEvent, Heartbeat
from app.domain.statistics import rate, rounded
from app.domain.time_window import TimeWindow, group_by_bucket
from app.repositories import TelemetryRepository
from app.services.error_analytics import ErrorAnalyticsService
from app.services.qoe import QoeService

SEVERITY_CRITICAL = "critical"
SEVERITY_WARNING = "warning"
_SEVERITY_ORDER = {SEVERITY_CRITICAL: 0, SEVERITY_WARNING: 1}

DEFAULT_HEARTBEAT_TTL = timedelta(minutes=2)


@dataclass(frozen=True, slots=True)
class AlertThresholds:
    """Limiares que disparam os alertas do dashboard."""

    error_rate_warning: float = 0.02
    error_rate_critical: float = 0.05
    rebuffer_rate_warning: float = 0.01
    rebuffer_rate_critical: float = 0.03
    crash_free_warning: float = 0.995
    crash_free_critical: float = 0.99
    startup_p95_warning_ms: float = 4_000.0
    startup_p95_critical_ms: float = 8_000.0
    spike_multiplier: float = 3.0
    spike_min_occurrences: int = 5
    min_samples: int = 20


@dataclass(frozen=True, slots=True)
class Alert:
    """Alerta ativo, identificado de forma estável entre consultas."""

    id: str
    type: str
    severity: str
    metric: str
    value: float
    threshold: float
    message: str
    scope: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "severity": self.severity,
            "metric": self.metric,
            "value": rounded(self.value, 3),
            "threshold": self.threshold,
            "message": self.message,
            "scope": self.scope,
        }


class RealtimeService:
    """Consolida o estado atual da plataforma para o topo do dashboard."""

    def __init__(
        self,
        repository: TelemetryRepository,
        qoe_service: QoeService,
        error_service: ErrorAnalyticsService,
        *,
        heartbeat_ttl: timedelta = DEFAULT_HEARTBEAT_TTL,
        thresholds: AlertThresholds | None = None,
        clock: Callable[[], datetime] = utcnow,
    ) -> None:
        self._repository = repository
        self._qoe = qoe_service
        self._errors = error_service
        self._heartbeat_ttl = heartbeat_ttl
        self._thresholds = thresholds or AlertThresholds()
        self._clock = clock

    def overview(self, window: TimeWindow) -> dict[str, Any]:
        """CCU, volume de eventos e taxa de erros da janela."""
        events = self._repository.events(window)
        errors = self._repository.errors(window)
        heartbeats = self._repository.heartbeats(window)

        minutes = window.duration.total_seconds() / 60

        return {
            "window": window.as_dict(),
            "generated_at": to_iso(self._clock()),
            "ccu": self._concurrent_users(window, heartbeats),
            "active_sessions": len(sessions_of(events, errors, heartbeats)),
            "events": {
                "total": len(events),
                "per_minute": rounded(rate(len(events), minutes), 2),
            },
            "errors": {
                "total": len(errors),
                "fatal": sum(1 for error in errors if error.fatal),
                "per_minute": rounded(rate(len(errors), minutes), 2),
                "rate": rounded(rate(len(errors), len(events))),
            },
        }

    def alerts(self, window: TimeWindow, *, interval: timedelta) -> dict[str, Any]:
        """Alertas e anomalias ativos ao fim da janela."""
        events = self._repository.events(window)
        errors = self._repository.errors(window)
        qoe = self._qoe.summarize(events)
        summary = self._errors.summarize(window)

        alerts: list[Alert] = []
        if len(events) >= self._thresholds.min_samples:
            alerts += self._rate_alerts(summary.error_rate, qoe.rebuffer_rate)
        if summary.total_sessions >= self._thresholds.min_samples:
            alerts += self._crash_free_alerts(summary.crash_free_rate)
        if qoe.startup_samples >= self._thresholds.min_samples:
            alerts += self._startup_alerts(qoe.startup_p95_ms)
        alerts += self._spike_alerts(window, errors, interval)

        alerts.sort(key=lambda alert: (_SEVERITY_ORDER[alert.severity], alert.id))
        return {
            "window": window.as_dict(),
            "generated_at": to_iso(self._clock()),
            "alerts": [alert.as_dict() for alert in alerts],
        }

    def _concurrent_users(self, window: TimeWindow, heartbeats: Sequence[Heartbeat]) -> int:
        """Sessões distintas com heartbeat recente no fim da janela."""
        cutoff = max(window.end - self._heartbeat_ttl, window.start)
        return len({beat.session_id for beat in heartbeats if beat.occurred_at >= cutoff})

    def _rate_alerts(self, error_rate: float | None, rebuffer_rate: float | None) -> list[Alert]:
        alerts = []
        error_alert = self._threshold_alert(
            alert_id="error_rate",
            metric="errors.rate",
            value=error_rate,
            warning=self._thresholds.error_rate_warning,
            critical=self._thresholds.error_rate_critical,
            message="Taxa de erros acima do limiar aceitável.",
        )
        rebuffer_alert = self._threshold_alert(
            alert_id="rebuffer_rate",
            metric="qoe.rebuffer.rate",
            value=rebuffer_rate,
            warning=self._thresholds.rebuffer_rate_warning,
            critical=self._thresholds.rebuffer_rate_critical,
            message="Tempo de travamento acima do limiar aceitável.",
        )
        alerts += [alert for alert in (error_alert, rebuffer_alert) if alert]
        return alerts

    def _crash_free_alerts(self, crash_free_rate: float | None) -> list[Alert]:
        thresholds = self._thresholds
        if crash_free_rate is None:
            return []
        if crash_free_rate < thresholds.crash_free_critical:
            severity, threshold = SEVERITY_CRITICAL, thresholds.crash_free_critical
        elif crash_free_rate < thresholds.crash_free_warning:
            severity, threshold = SEVERITY_WARNING, thresholds.crash_free_warning
        else:
            return []

        return [
            Alert(
                id="crash_free_rate",
                type="threshold",
                severity=severity,
                metric="errors.crash_free_rate",
                value=crash_free_rate,
                threshold=threshold,
                message="Taxa de sessões sem falhas fatais abaixo do esperado.",
            )
        ]

    def _startup_alerts(self, startup_p95_ms: float | None) -> list[Alert]:
        if startup_p95_ms is None:
            return []
        alert = self._threshold_alert(
            alert_id="startup_time_p95",
            metric="qoe.startup_time_ms.p95",
            value=startup_p95_ms,
            warning=self._thresholds.startup_p95_warning_ms,
            critical=self._thresholds.startup_p95_critical_ms,
            message="Tempo de início de reprodução (VST) acima do limiar aceitável.",
        )
        return [alert] if alert else []

    def _spike_alerts(
        self, window: TimeWindow, errors: Sequence[ErrorEvent], interval: timedelta
    ) -> list[Alert]:
        """Detecta códigos de erro cujo último bucket destoa do histórico da janela."""
        buckets = window.buckets(interval)
        if len(buckets) < 3:
            return []

        by_code: dict[str, list[ErrorEvent]] = {}
        for error in errors:
            by_code.setdefault(error.error_code, []).append(error)

        alerts: list[Alert] = []
        for code in sorted(by_code):
            series = [len(group) for group in group_by_bucket(by_code[code], buckets)]
            current, history = series[-1], series[:-1]
            baseline = sum(history) / len(history)

            if current < self._thresholds.spike_min_occurrences:
                continue
            if baseline and current < baseline * self._thresholds.spike_multiplier:
                continue

            alerts.append(
                Alert(
                    id=f"error_spike:{code}",
                    type="anomaly",
                    severity=SEVERITY_WARNING,
                    metric="errors.occurrences",
                    value=float(current),
                    threshold=round(baseline * self._thresholds.spike_multiplier, 2),
                    message=(
                        f"Surto do erro `{code}`: {current} ocorrências no último intervalo "
                        f"contra média de {baseline:.1f}."
                    ),
                    scope=code,
                )
            )
        return alerts

    @staticmethod
    def _threshold_alert(
        *,
        alert_id: str,
        metric: str,
        value: float | None,
        warning: float,
        critical: float,
        message: str,
    ) -> Alert | None:
        """Alerta de limiar; métricas sem amostra (``None``) não disparam nada."""
        if value is None:
            return None
        if value >= critical:
            severity, threshold = SEVERITY_CRITICAL, critical
        elif value >= warning:
            severity, threshold = SEVERITY_WARNING, warning
        else:
            return None

        return Alert(
            id=alert_id,
            type="threshold",
            severity=severity,
            metric=metric,
            value=value,
            threshold=threshold,
            message=message,
        )
