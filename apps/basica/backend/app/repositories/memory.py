"""Repositório em memória dos registros de telemetria.

Usado em desenvolvimento e nos testes. Mantém cada coleção ordenada por
horário, o que permite recortar janelas com busca binária, e um índice
secundário por `trace_id`, para que abrir um trace no dashboard não exija
varrer toda a base. Tudo é protegido por lock porque o servidor atende
requisições em múltiplas threads.

Os dados vivem no processo: reiniciar o servidor zera a base e cada worker
enxerga a própria fatia. Para produção, use `DynamoDbTelemetryRepository`.
"""

from __future__ import annotations

import bisect
import threading
from collections.abc import Iterable
from datetime import datetime, timedelta
from typing import Generic, TypeVar

from app.domain.models import ErrorEvent, Heartbeat, PlaybackEvent
from app.domain.time_window import TimeWindow
from app.repositories.base import TelemetryRepository

RecordT = TypeVar("RecordT", PlaybackEvent, ErrorEvent, Heartbeat)
TracedT = TypeVar("TracedT", PlaybackEvent, ErrorEvent)

DEFAULT_RETENTION = timedelta(hours=24)
DEFAULT_MAX_RECORDS = 200_000


def _occurred_at(record: PlaybackEvent | ErrorEvent | Heartbeat) -> datetime:
    return record.occurred_at


class _Timeline(Generic[RecordT]):
    """Coleção ordenada por horário, com retenção e limite de tamanho."""

    def __init__(self, *, retention: timedelta, max_records: int) -> None:
        self._retention = retention
        self._max_records = max_records
        self._lock = threading.RLock()
        self._records: list[RecordT] = []

    def add(self, records: Iterable[RecordT]) -> list[RecordT]:
        """Insere os registros e devolve os que saíram por retenção ou limite."""
        with self._lock:
            for record in records:
                bisect.insort(self._records, record, key=_occurred_at)
            return self._prune()

    def range(self, window: TimeWindow | None = None) -> list[RecordT]:
        """Registros da janela (limites inclusivos), do mais antigo ao mais novo."""
        with self._lock:
            if window is None:
                return list(self._records)
            start = bisect.bisect_left(self._records, window.start, key=_occurred_at)
            end = bisect.bisect_right(self._records, window.end, key=_occurred_at)
            return self._records[start:end]

    def clear(self) -> list[RecordT]:
        with self._lock:
            discarded = self._records
            self._records = []
            return discarded

    def __len__(self) -> int:
        with self._lock:
            return len(self._records)

    def _prune(self) -> list[RecordT]:
        """Descarta registros fora da retenção ou além do limite de memória.

        O corte usa o registro mais recente como referência (e não o relógio),
        de modo que cargas históricas se comportem de forma previsível. Datas
        muito à frente do relógio do servidor são barradas ainda na ingestão,
        justamente para que um único registro torto não expire a base inteira.
        """
        if not self._records:
            return []

        cutoff = self._records[-1].occurred_at - self._retention
        expired = bisect.bisect_left(self._records, cutoff, key=_occurred_at)
        excess = max(len(self._records) - self._max_records, 0)

        removed = max(expired, excess)
        if not removed:
            return []

        evicted = self._records[:removed]
        del self._records[:removed]
        return evicted


class _TraceIndex(Generic[TracedT]):
    """Índice secundário `trace_id` → registros, sincronizado com a retenção."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._by_trace: dict[str, list[TracedT]] = {}

    def add(self, records: Iterable[TracedT]) -> None:
        with self._lock:
            for record in records:
                if record.trace_id:
                    self._by_trace.setdefault(record.trace_id, []).append(record)

    def discard(self, records: Iterable[TracedT]) -> None:
        with self._lock:
            for record in records:
                if not record.trace_id:
                    continue
                bucket = self._by_trace.get(record.trace_id)
                if bucket is None:
                    continue
                try:
                    bucket.remove(record)
                except ValueError:
                    continue
                if not bucket:
                    del self._by_trace[record.trace_id]

    def get(self, trace_id: str) -> list[TracedT]:
        with self._lock:
            return sorted(self._by_trace.get(trace_id, ()), key=_occurred_at)

    def clear(self) -> None:
        with self._lock:
            self._by_trace.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._by_trace)


class InMemoryTelemetryRepository(TelemetryRepository):
    """Armazenamento em memória, ordenado por horário e indexado por trace."""

    def __init__(
        self,
        *,
        retention: timedelta = DEFAULT_RETENTION,
        max_records: int = DEFAULT_MAX_RECORDS,
    ) -> None:
        self._write_lock = threading.RLock()
        self._events: _Timeline[PlaybackEvent] = _Timeline(
            retention=retention, max_records=max_records
        )
        self._errors: _Timeline[ErrorEvent] = _Timeline(
            retention=retention, max_records=max_records
        )
        self._heartbeats: _Timeline[Heartbeat] = _Timeline(
            retention=retention, max_records=max_records
        )
        self._event_traces: _TraceIndex[PlaybackEvent] = _TraceIndex()
        self._error_traces: _TraceIndex[ErrorEvent] = _TraceIndex()

    # Escrita ------------------------------------------------------------

    def add_events(self, events: Iterable[PlaybackEvent]) -> int:
        return self._add(list(events), self._events, self._event_traces)

    def add_errors(self, errors: Iterable[ErrorEvent]) -> int:
        return self._add(list(errors), self._errors, self._error_traces)

    def add_heartbeats(self, heartbeats: Iterable[Heartbeat]) -> int:
        records = list(heartbeats)
        with self._write_lock:
            self._heartbeats.add(records)
        return len(records)

    # Leitura ------------------------------------------------------------

    def events(self, window: TimeWindow | None = None) -> list[PlaybackEvent]:
        return self._events.range(window)

    def errors(self, window: TimeWindow | None = None) -> list[ErrorEvent]:
        return self._errors.range(window)

    def heartbeats(self, window: TimeWindow | None = None) -> list[Heartbeat]:
        return self._heartbeats.range(window)

    def records_for_trace(self, trace_id: str) -> tuple[list[PlaybackEvent], list[ErrorEvent]]:
        """Eventos e erros de um trace, resolvidos pelo índice secundário."""
        return self._event_traces.get(trace_id), self._error_traces.get(trace_id)

    def stats(self) -> dict[str, int]:
        """Quantidade de registros retidos por coleção."""
        return {
            "events": len(self._events),
            "errors": len(self._errors),
            "heartbeats": len(self._heartbeats),
            "traces": len(self._event_traces) + len(self._error_traces),
        }

    def clear(self) -> None:
        with self._write_lock:
            self._events.clear()
            self._errors.clear()
            self._heartbeats.clear()
            self._event_traces.clear()
            self._error_traces.clear()

    def _add(
        self,
        records: list[TracedT],
        timeline: _Timeline[TracedT],
        index: _TraceIndex[TracedT],
    ) -> int:
        """Grava na linha do tempo e mantém o índice de traces em sincronia.

        O índice recebe tudo o que foi gravado e só então devolve o que a
        retenção descartou — inclusive registros que já entraram vencidos.
        """
        with self._write_lock:
            evicted = timeline.add(records)
            index.add(records)
            index.discard(evicted)
        return len(records)
