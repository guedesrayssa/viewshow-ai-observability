"""Contrato do repositório de telemetria.

Os serviços dependem desta interface, nunca de um armazenamento concreto. Hoje
existem duas implementações — memória (desenvolvimento e testes) e DynamoDB
(produção) — e ambas são exercitadas pelo mesmo conjunto de testes de contrato.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterable

from app.domain.models import ErrorEvent, Heartbeat, PlaybackEvent, Span
from app.domain.time_window import TimeWindow


class TelemetryRepository(ABC):
    """Leitura e escrita dos registros de telemetria."""

    # Escrita ------------------------------------------------------------

    @abstractmethod
    def add_events(self, events: Iterable[PlaybackEvent]) -> int:
        """Persiste eventos de reprodução e devolve quantos foram gravados."""

    @abstractmethod
    def add_errors(self, errors: Iterable[ErrorEvent]) -> int:
        """Persiste erros e devolve quantos foram gravados."""

    @abstractmethod
    def add_heartbeats(self, heartbeats: Iterable[Heartbeat]) -> int:
        """Persiste heartbeats e devolve quantos foram gravados."""

    # Leitura ------------------------------------------------------------

    @abstractmethod
    def events(self, window: TimeWindow | None = None) -> list[PlaybackEvent]:
        """Eventos da janela (limites inclusivos), do mais antigo ao mais novo."""

    @abstractmethod
    def errors(self, window: TimeWindow | None = None) -> list[ErrorEvent]:
        """Erros da janela (limites inclusivos), do mais antigo ao mais novo."""

    @abstractmethod
    def heartbeats(self, window: TimeWindow | None = None) -> list[Heartbeat]:
        """Heartbeats da janela (limites inclusivos), do mais antigo ao mais novo."""

    @abstractmethod
    def records_for_trace(self, trace_id: str) -> tuple[list[PlaybackEvent], list[ErrorEvent]]:
        """Eventos e erros de um trace, independentemente da janela."""

    @abstractmethod
    def stats(self) -> dict[str, int]:
        """Quantidade de registros armazenados por coleção."""

    @abstractmethod
    def clear(self) -> None:
        """Remove todos os registros. Uso em desenvolvimento e testes."""

    def spans(self, window: TimeWindow | None = None) -> list[Span]:
        """Todos os spans reportados por eventos e erros da janela.

        Derivado das demais leituras: vale para qualquer armazenamento.
        """
        spans = [span for record in self.events(window) for span in record.spans]
        spans.extend(span for record in self.errors(window) for span in record.spans)
        spans.sort(key=lambda span: span.started_at)
        return spans
