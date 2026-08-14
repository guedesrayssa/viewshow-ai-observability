"""Análises sobre os erros reportados: resumo, ranking e detalhamento."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from app.domain.aggregation import count_by, ranking, sessions_of
from app.domain.clock import to_iso
from app.domain.models import ErrorEvent
from app.domain.statistics import rate, ratio, rounded
from app.domain.time_window import TimeWindow, group_by_bucket
from app.errors import ResourceNotFoundError
from app.repositories import TelemetryRepository

MAX_SAMPLE_MESSAGES = 5
MAX_SAMPLE_TRACES = 5


def _module_of(error: ErrorEvent) -> str:
    return error.module


@dataclass(frozen=True, slots=True)
class ErrorSummary:
    """Consolidação dos erros de uma janela.

    `error_rate` e `crash_free_rate` são ``None`` quando não houve base de
    cálculo (nenhum evento de reprodução ou nenhuma sessão observada).
    """

    total: int
    fatal: int
    unique_codes: int
    affected_sessions: int
    total_sessions: int
    sessions_with_fatal: int
    error_rate: float | None
    crash_free_rate: float | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "total_errors": self.total,
            "fatal_errors": self.fatal,
            "unique_error_codes": self.unique_codes,
            "affected_sessions": self.affected_sessions,
            "total_sessions": self.total_sessions,
            "error_rate": rounded(self.error_rate),
            "crash_free_rate": rounded(self.crash_free_rate),
        }


class ErrorAnalyticsService:
    """Responde às perguntas do dashboard sobre falhas da aplicação."""

    def __init__(self, repository: TelemetryRepository) -> None:
        self._repository = repository

    def summary(self, window: TimeWindow) -> dict[str, Any]:
        """Resumo de erros e taxa de sessões sem falhas."""
        return {"window": window.as_dict(), "summary": self.summarize(window).as_dict()}

    def summarize(self, window: TimeWindow) -> ErrorSummary:
        """Calcula o resumo de erros da janela.

        `crash_free_rate` considera apenas erros fatais: é a fração das sessões
        observadas na janela que não sofreu nenhuma falha fatal.
        """
        errors = self._repository.errors(window)
        events = self._repository.events(window)
        heartbeats = self._repository.heartbeats(window)
        sessions = sessions_of(events, errors, heartbeats)

        sessions_with_fatal = {error.session_id for error in errors if error.fatal}
        crash_free = rate(len(sessions_with_fatal), len(sessions))

        return ErrorSummary(
            total=len(errors),
            fatal=sum(1 for error in errors if error.fatal),
            unique_codes=len({error.error_code for error in errors}),
            affected_sessions=len({error.session_id for error in errors}),
            total_sessions=len(sessions),
            sessions_with_fatal=len(sessions_with_fatal),
            error_rate=rate(len(errors), len(events)),
            crash_free_rate=None if crash_free is None else 1.0 - crash_free,
        )

    def top(self, window: TimeWindow, *, limit: int = 10) -> dict[str, Any]:
        """Ranking dos códigos de erro mais frequentes na janela."""
        errors = self._repository.errors(window)
        by_code: dict[str, list[ErrorEvent]] = {}
        for error in errors:
            by_code.setdefault(error.error_code, []).append(error)

        ordered = sorted(by_code.items(), key=lambda item: (-len(item[1]), item[0]))[:limit]
        entries = [
            {
                "error_code": code,
                "occurrences": len(occurrences),
                "share": rounded(ratio(len(occurrences), len(errors))),
                "affected_sessions": len({error.session_id for error in occurrences}),
                "fatal_occurrences": sum(1 for error in occurrences if error.fatal),
                "top_module": count_by(occurrences, _module_of).most_common(1)[0][0],
                "first_seen": to_iso(min(error.occurred_at for error in occurrences)),
                "last_seen": to_iso(max(error.occurred_at for error in occurrences)),
            }
            for code, occurrences in ordered
        ]
        return {"window": window.as_dict(), "total_errors": len(errors), "errors": entries}

    def details(
        self,
        window: TimeWindow,
        error_code: str,
        *,
        interval: timedelta,
        limit: int = 10,
    ) -> dict[str, Any]:
        """Detalha as ocorrências e o impacto de um código de erro."""
        errors = self._repository.errors(window)
        code = error_code.strip().upper()
        occurrences = [error for error in errors if error.error_code == code]
        if not occurrences:
            raise ResourceNotFoundError(
                f"Nenhuma ocorrência do erro `{code}` na janela consultada."
            )

        buckets = window.buckets(interval)
        timeline = [
            {"start": to_iso(bucket.start), "occurrences": len(bucket_errors)}
            for bucket, bucket_errors in zip(
                buckets, group_by_bucket(occurrences, buckets), strict=True
            )
        ]

        return {
            "window": window.as_dict(),
            "error_code": code,
            "occurrences": len(occurrences),
            "share_of_errors": rounded(ratio(len(occurrences), len(errors))),
            "affected_sessions": len({error.session_id for error in occurrences}),
            "fatal_occurrences": sum(1 for error in occurrences if error.fatal),
            "first_seen": to_iso(min(error.occurred_at for error in occurrences)),
            "last_seen": to_iso(max(error.occurred_at for error in occurrences)),
            "breakdown": {
                "modules": self._rank(occurrences, lambda error: error.module, limit, "module"),
                "services": self._rank(occurrences, lambda error: error.service, limit, "service"),
                "devices": self._rank(
                    occurrences, lambda error: error.device.model, limit, "device_model"
                ),
                "app_versions": self._rank(
                    occurrences, lambda error: error.device.app_version, limit, "app_version"
                ),
                "cdns": self._rank(occurrences, lambda error: error.network.cdn, limit, "cdn"),
            },
            "timeline": timeline,
            "sample_messages": self._sample_messages(occurrences),
            "sample_traces": self._sample_traces(occurrences),
        }

    @staticmethod
    def _rank(errors: Sequence[ErrorEvent], key, limit: int, label: str) -> list[dict[str, Any]]:
        return ranking(count_by(errors, key), total=len(errors), limit=limit, label=label)

    @staticmethod
    def _sample_messages(errors: Sequence[ErrorEvent]) -> list[str]:
        messages: list[str] = []
        for error in errors:
            if error.message and error.message not in messages:
                messages.append(error.message)
            if len(messages) == MAX_SAMPLE_MESSAGES:
                break
        return messages

    @staticmethod
    def _sample_traces(errors: Sequence[ErrorEvent]) -> list[str]:
        traces: list[str] = []
        for error in errors:
            if error.trace_id and error.trace_id not in traces:
                traces.append(error.trace_id)
            if len(traces) == MAX_SAMPLE_TRACES:
                break
        return traces
