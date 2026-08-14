"""Análise de causa raiz (RCA).

Reúne as visões que respondem "por que quebrou": qual módulo falhou, como está
a topologia de serviços, quais padrões de erro se repetem, o que aconteceu em
um trace específico e quais surtos de erro andam juntos.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import timedelta
from typing import Any

from app.domain.aggregation import count_by, ranking
from app.domain.clock import to_iso
from app.domain.fingerprint import normalize_message
from app.domain.models import ErrorEvent, Span
from app.domain.statistics import pearson, percentile, ratio, rounded
from app.domain.time_window import TimeWindow, group_by_bucket
from app.errors import ResourceNotFoundError
from app.repositories import TelemetryRepository

MAX_CORRELATION_SERIES = 15
MIN_SERIES_OCCURRENCES = 3
DEFAULT_MIN_CORRELATION = 0.6

HEALTH_HEALTHY = "healthy"
HEALTH_DEGRADED = "degraded"
HEALTH_CRITICAL = "critical"
_HEALTH_ORDER = (HEALTH_HEALTHY, HEALTH_DEGRADED, HEALTH_CRITICAL)

DEGRADED_ERROR_RATE = 0.02
CRITICAL_ERROR_RATE = 0.10


class RcaService:
    """Consultas de causa raiz sobre erros, spans e traces."""

    def __init__(self, repository: TelemetryRepository) -> None:
        self._repository = repository

    # Módulos ------------------------------------------------------------

    def modules_breakdown(self, window: TimeWindow, *, limit: int = 20) -> dict[str, Any]:
        """Aponta os módulos internos relacionados às falhas da janela."""
        errors = self._repository.errors(window)
        grouped: dict[str, list[ErrorEvent]] = {}
        for error in errors:
            grouped.setdefault(error.module, []).append(error)

        ordered = sorted(grouped.items(), key=lambda item: (-len(item[1]), item[0]))[:limit]
        modules = [
            {
                "module": module,
                "occurrences": len(occurrences),
                "share": rounded(ratio(len(occurrences), len(errors))),
                "affected_sessions": len({error.session_id for error in occurrences}),
                "fatal_occurrences": sum(1 for error in occurrences if error.fatal),
                "top_error_codes": ranking(
                    count_by(occurrences, lambda error: error.error_code),
                    total=len(occurrences),
                    limit=3,
                    label="error_code",
                ),
            }
            for module, occurrences in ordered
        ]
        return {"window": window.as_dict(), "total_errors": len(errors), "modules": modules}

    # Topologia ----------------------------------------------------------

    def topology_health(self, window: TimeWindow) -> dict[str, Any]:
        """Deriva saúde de serviços e dependências a partir dos spans da janela."""
        spans = self._repository.spans(window)
        # `span_id` só é único dentro de um trace: indexar por (trace, span)
        # evita ligar a chamada de um trace ao serviço pai de outro.
        by_id = {(span.trace_id, span.span_id): span for span in spans}

        services: dict[str, list[Span]] = {}
        for span in spans:
            services.setdefault(span.service, []).append(span)

        nodes = [self._describe_service(service, calls) for service, calls in services.items()]
        nodes.sort(key=lambda node: (-node["calls"], node["service"]))

        edges: dict[tuple[str, str], list[Span]] = {}
        for span in spans:
            parent = (
                by_id.get((span.trace_id, span.parent_span_id)) if span.parent_span_id else None
            )
            if parent is None or parent.service == span.service:
                continue
            edges.setdefault((parent.service, span.service), []).append(span)

        dependencies = [
            self._describe_dependency(source, target, calls)
            for (source, target), calls in edges.items()
        ]
        dependencies.sort(key=lambda edge: (-edge["calls"], edge["source"], edge["target"]))

        status = max(
            (node["status"] for node in nodes), key=_HEALTH_ORDER.index, default=HEALTH_HEALTHY
        )
        return {
            "window": window.as_dict(),
            "status": status,
            "services": nodes,
            "dependencies": dependencies,
        }

    # Fingerprints -------------------------------------------------------

    def fingerprints(self, window: TimeWindow, *, limit: int = 20) -> dict[str, Any]:
        """Lista os padrões recorrentes de erro na janela."""
        grouped = self._group_by_fingerprint(window)
        ordered = sorted(grouped.items(), key=lambda item: (-len(item[1]), item[0]))[:limit]

        return {
            "window": window.as_dict(),
            "total_fingerprints": len(grouped),
            "fingerprints": [
                self._describe_fingerprint(fingerprint, occurrences)
                for fingerprint, occurrences in ordered
            ],
        }

    def fingerprint_details(self, window: TimeWindow, fingerprint_id: str) -> dict[str, Any]:
        """Detalha os serviços afetados e o raio de impacto de um padrão."""
        occurrences = self._group_by_fingerprint(window).get(fingerprint_id.strip().lower())
        if not occurrences:
            raise ResourceNotFoundError(
                f"Nenhum padrão de erro `{fingerprint_id}` na janela consultada."
            )

        errors = self._repository.errors(window)
        sessions = {error.session_id for error in occurrences}
        total_sessions = {error.session_id for error in errors}

        details = self._describe_fingerprint(fingerprint_id.strip().lower(), occurrences)
        details.update(
            {
                "window": window.as_dict(),
                "affected_services": ranking(
                    count_by(occurrences, lambda error: error.service),
                    total=len(occurrences),
                    label="service",
                ),
                "impact_radius": {
                    "sessions": len(sessions),
                    "share_of_errors": rounded(ratio(len(occurrences), len(errors))),
                    "share_of_affected_sessions": rounded(
                        ratio(len(sessions), len(total_sessions))
                    ),
                    "devices": ranking(
                        count_by(occurrences, lambda error: error.device.model),
                        total=len(occurrences),
                        limit=5,
                        label="device_model",
                    ),
                    "cdns": ranking(
                        count_by(occurrences, lambda error: error.network.cdn),
                        total=len(occurrences),
                        limit=5,
                        label="cdn",
                    ),
                },
                "sample_traces": [error.trace_id for error in occurrences if error.trace_id][:5],
            }
        )
        return details

    # Traces -------------------------------------------------------------

    def trace(self, trace_id: str) -> dict[str, Any]:
        """Monta o waterfall ponta a ponta de um trace."""
        identifier = trace_id.strip()
        events, errors = self._repository.records_for_trace(identifier)
        spans = sorted(
            [span for record in (*events, *errors) for span in record.spans],
            key=lambda span: span.started_at,
        )
        if not spans and not errors and not events:
            raise ResourceNotFoundError(f"Trace `{identifier}` não encontrado.")

        started_at = min(
            [span.started_at for span in spans]
            + [record.occurred_at for record in (*events, *errors)]
        )
        finished_at = max(
            [span.ended_at for span in spans]
            + [record.occurred_at for record in (*events, *errors)]
        )
        depths = _span_depths(spans)

        return {
            "trace_id": identifier,
            "started_at": to_iso(started_at),
            "duration_ms": rounded((finished_at - started_at).total_seconds() * 1000, 3),
            "status": "error" if errors or any(span.failed for span in spans) else "ok",
            "sessions": sorted({record.session_id for record in (*events, *errors)}),
            "span_count": len(spans),
            "spans": [
                {
                    "span_id": span.span_id,
                    "parent_span_id": span.parent_span_id,
                    "service": span.service,
                    "operation": span.operation,
                    "depth": depths[span.span_id],
                    "offset_ms": rounded((span.started_at - started_at).total_seconds() * 1000, 3),
                    "duration_ms": rounded(span.duration_ms, 3),
                    "status": span.status,
                }
                for span in spans
            ],
            "errors": [
                {
                    "session_id": error.session_id,
                    "error_code": error.error_code,
                    "module": error.module,
                    "service": error.service,
                    "message": error.message,
                    "fatal": error.fatal,
                    "occurred_at": to_iso(error.occurred_at),
                }
                for error in sorted(errors, key=lambda error: error.occurred_at)
            ],
        }

    # Correlações --------------------------------------------------------

    def correlations(
        self,
        window: TimeWindow,
        *,
        interval: timedelta,
        minimum: float = DEFAULT_MIN_CORRELATION,
        limit: int = 10,
    ) -> dict[str, Any]:
        """Correlaciona séries temporais de erro para revelar surtos simultâneos.

        Cada série conta as ocorrências por bucket em uma dimensão (código de
        erro, módulo ou CDN); o coeficiente de Pearson entre duas séries indica
        se os surtos aconteceram juntos.
        """
        buckets = window.buckets(interval)
        errors = self._repository.errors(window)
        series = self._build_series(errors, buckets)

        pairs: list[dict[str, Any]] = []
        for index, (source, source_values) in enumerate(series):
            for target, target_values in series[index + 1 :]:
                coefficient = pearson(source_values, target_values)
                if abs(coefficient) < minimum:
                    continue
                pairs.append(
                    {
                        "source": source,
                        "target": target,
                        "coefficient": rounded(coefficient, 3),
                        "strength": "strong" if abs(coefficient) >= 0.8 else "moderate",
                    }
                )

        pairs.sort(key=lambda pair: -abs(pair["coefficient"]))
        return {
            "window": window.as_dict(),
            "interval_seconds": int(interval.total_seconds()),
            "buckets": len(buckets),
            "minimum_coefficient": minimum,
            "correlations": pairs[:limit],
        }

    # Auxiliares ---------------------------------------------------------

    def _group_by_fingerprint(self, window: TimeWindow) -> dict[str, list[ErrorEvent]]:
        grouped: dict[str, list[ErrorEvent]] = {}
        for error in self._repository.errors(window):
            grouped.setdefault(error.fingerprint, []).append(error)
        return grouped

    @staticmethod
    def _describe_fingerprint(
        fingerprint: str, occurrences: Sequence[ErrorEvent]
    ) -> dict[str, Any]:
        sample = occurrences[0]
        return {
            "fingerprint_id": fingerprint,
            "error_code": sample.error_code,
            "module": sample.module,
            "pattern": normalize_message(sample.message),
            "sample_message": sample.message,
            "occurrences": len(occurrences),
            "affected_sessions": len({error.session_id for error in occurrences}),
            "fatal_occurrences": sum(1 for error in occurrences if error.fatal),
            "first_seen": to_iso(min(error.occurred_at for error in occurrences)),
            "last_seen": to_iso(max(error.occurred_at for error in occurrences)),
        }

    @staticmethod
    def _describe_service(service: str, calls: Sequence[Span]) -> dict[str, Any]:
        failures = sum(1 for span in calls if span.failed)
        error_rate = ratio(failures, len(calls))
        latencies = [span.duration_ms for span in calls]

        if error_rate >= CRITICAL_ERROR_RATE:
            status = HEALTH_CRITICAL
        elif error_rate >= DEGRADED_ERROR_RATE:
            status = HEALTH_DEGRADED
        else:
            status = HEALTH_HEALTHY

        return {
            "service": service,
            "status": status,
            "calls": len(calls),
            "errors": failures,
            "error_rate": rounded(error_rate),
            "latency_ms": {
                "p50": rounded(percentile(latencies, 50), 1),
                "p95": rounded(percentile(latencies, 95), 1),
            },
        }

    @staticmethod
    def _describe_dependency(source: str, target: str, calls: Sequence[Span]) -> dict[str, Any]:
        failures = sum(1 for span in calls if span.failed)
        return {
            "source": source,
            "target": target,
            "calls": len(calls),
            "errors": failures,
            "error_rate": rounded(ratio(failures, len(calls))),
            "latency_p95_ms": rounded(percentile([span.duration_ms for span in calls], 95), 1),
        }

    @staticmethod
    def _build_series(
        errors: Sequence[ErrorEvent], buckets: Sequence[TimeWindow]
    ) -> list[tuple[dict[str, Any], list[float]]]:
        """Séries temporais candidatas, limitadas às dimensões mais relevantes."""
        dimensions = {
            "error_code": lambda error: error.error_code,
            "module": lambda error: error.module,
            "cdn": lambda error: error.network.cdn,
        }

        candidates: list[tuple[dict[str, Any], list[ErrorEvent]]] = []
        for dimension, select in dimensions.items():
            grouped: dict[str, list[ErrorEvent]] = {}
            for error in errors:
                grouped.setdefault(select(error), []).append(error)
            candidates.extend(
                ({"dimension": dimension, "value": value}, occurrences)
                for value, occurrences in grouped.items()
                if len(occurrences) >= MIN_SERIES_OCCURRENCES
            )

        candidates.sort(key=lambda item: (-len(item[1]), item[0]["dimension"], item[0]["value"]))
        return [
            (
                {**label, "occurrences": len(occurrences)},
                [float(len(group)) for group in group_by_bucket(occurrences, buckets)],
            )
            for label, occurrences in candidates[:MAX_CORRELATION_SERIES]
        ]


def _span_depths(spans: Sequence[Span]) -> dict[str, int]:
    """Profundidade de cada span na árvore do trace, tolerante a ciclos."""
    parents = {span.span_id: span.parent_span_id for span in spans}
    depths: dict[str, int] = {}

    for span_id in parents:
        depth = 0
        visited = {span_id}
        cursor = parents[span_id]
        while cursor in parents and cursor not in visited:
            visited.add(cursor)
            depth += 1
            cursor = parents[cursor]
        depths[span_id] = depth
    return depths
