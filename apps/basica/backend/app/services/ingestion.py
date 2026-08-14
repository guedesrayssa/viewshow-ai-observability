"""Serviço de ingestão dos três endpoints de telemetria.

O contrato é o de uma API de coleta: um item inválido no meio de um lote não
derruba o lote inteiro — ele volta descrito em `rejected` para que o SDK possa
corrigir o envio sem perder os demais registros.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, TypeVar

from app.domain.clock import utcnow
from app.domain.models import ErrorEvent, Heartbeat, PlaybackEvent
from app.domain.parsing import (
    PayloadError,
    parse_error_event,
    parse_heartbeat,
    parse_playback_event,
)
from app.errors import PayloadTooLargeError, UnprocessablePayloadError, ValidationError
from app.repositories import TelemetryRepository

RecordT = TypeVar("RecordT", PlaybackEvent, ErrorEvent, Heartbeat)

DEFAULT_MAX_BATCH_SIZE = 500


@dataclass(frozen=True, slots=True)
class RejectedItem:
    """Item recusado, identificado pela posição no lote enviado."""

    index: int
    reason: str

    def as_dict(self) -> dict[str, Any]:
        return {"index": self.index, "reason": self.reason}


@dataclass(frozen=True, slots=True)
class IngestionResult:
    """Resultado de uma ingestão, com aceitos e recusados."""

    resource: str
    received: int
    accepted: int
    rejected: tuple[RejectedItem, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "resource": self.resource,
            "received": self.received,
            "accepted": self.accepted,
            "rejected": [item.as_dict() for item in self.rejected],
        }


class TelemetryIngestionService:
    """Valida, converte e persiste os registros enviados pelos dispositivos."""

    def __init__(
        self,
        repository: TelemetryRepository,
        *,
        max_batch_size: int = DEFAULT_MAX_BATCH_SIZE,
        clock: Callable[[], datetime] = utcnow,
    ) -> None:
        self._repository = repository
        self._max_batch_size = max_batch_size
        self._clock = clock

    def ingest_events(self, payload: Any) -> IngestionResult:
        """Ingere eventos de reprodução."""
        return self._ingest("events", payload, parse_playback_event, self._repository.add_events)

    def ingest_errors(self, payload: Any) -> IngestionResult:
        """Ingere exceções e falhas da aplicação."""
        return self._ingest("errors", payload, parse_error_event, self._repository.add_errors)

    def ingest_heartbeats(self, payload: Any) -> IngestionResult:
        """Ingere sinais de presença das sessões ativas."""
        return self._ingest("heartbeats", payload, parse_heartbeat, self._repository.add_heartbeats)

    def _ingest(
        self,
        resource: str,
        payload: Any,
        parse: Callable[..., RecordT],
        persist: Callable[[Sequence[RecordT]], int],
    ) -> IngestionResult:
        items = self._normalize(payload)
        now = self._clock()

        accepted: list[RecordT] = []
        rejected: list[RejectedItem] = []
        for index, item in enumerate(items):
            try:
                accepted.append(parse(item, now=now))
            except PayloadError as exc:
                rejected.append(RejectedItem(index=index, reason=str(exc)))

        if not accepted:
            raise UnprocessablePayloadError(
                "Nenhum registro do lote pôde ser aproveitado.",
                details=[item.as_dict() for item in rejected],
            )

        persist(accepted)
        return IngestionResult(
            resource=resource,
            received=len(items),
            accepted=len(accepted),
            rejected=tuple(rejected),
        )

    def _normalize(self, payload: Any) -> list[dict[str, Any]]:
        """Aceita um objeto JSON ou uma lista de objetos JSON."""
        if isinstance(payload, dict):
            items = [payload]
        elif isinstance(payload, list):
            invalid = [index for index, item in enumerate(payload) if not isinstance(item, dict)]
            if invalid:
                raise ValidationError(
                    "Todos os itens do lote devem ser objetos JSON.",
                    details=[
                        {"index": index, "reason": "item não é um objeto JSON"} for index in invalid
                    ],
                )
            items = list(payload)
        else:
            raise ValidationError(
                "O corpo da requisição deve ser um objeto JSON ou uma lista de objetos JSON, "
                "enviado com `Content-Type: application/json`."
            )

        if not items:
            raise ValidationError("O lote enviado não pode estar vazio.")
        if len(items) > self._max_batch_size:
            raise PayloadTooLargeError(
                f"O lote excede o limite de {self._max_batch_size} registros por requisição."
            )
        return items
