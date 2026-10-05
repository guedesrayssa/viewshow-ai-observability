"""Mantém invisíveis as entregas da fila incremental enquanto a execução as detém.

Papel no fluxo:
    O ``ingest-incremental`` processa as mensagens recebidas uma de cada vez, na thread
    principal, e a escrita de um lote pode passar do ``visibility_timeout`` da fila. Este
    módulo roda numa thread separada, verifica as entregas a cada ``check_interval_seconds``
    e renova, com ``ChangeMessageVisibility``, só as que estão a ``renew_before_seconds`` ou
    menos de voltar a ficar visíveis. Cobre também as mensagens que aguardam a vez.

Garantias e limites:
    O prazo de cada entrega é contado a partir do instante anterior ao ``ReceiveMessage``,
    então nunca é posterior ao prazo real da fila. Uma renovação que falha, ou um prazo que
    expira antes da renovação, marca a perda da visibilidade: a thread para e ``check``
    passa a levantar ``VisibilityHeartbeatLost``. Quem chama deve abortar sem confirmar,
    sem mudar o estado do lote e sem processar as mensagens que aguardavam, porque outra
    execução pode já ter recebido a mesma mensagem.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Iterable

from domain.incremental_batches import BatchDelivery
from ports import IncrementalBatchQueue

_LOGGER = logging.getLogger(__name__)


class VisibilityHeartbeatLost(RuntimeError):
    """A execução deixou de garantir a posse exclusiva de uma entrega da fila."""


class VisibilityHeartbeat:
    """Renova a visibilidade das entregas ainda não liberadas pela execução."""

    def __init__(
        self,
        queue: IncrementalBatchQueue,
        *,
        visibility_timeout_seconds: int,
        check_interval_seconds: float,
        renew_before_seconds: float,
        clock: Callable[[], float],
    ) -> None:
        if (
            isinstance(visibility_timeout_seconds, bool)
            or not isinstance(visibility_timeout_seconds, int)
            or visibility_timeout_seconds <= 0
        ):
            raise ValueError("visibility_timeout_seconds must be a positive integer")
        if not 0 < renew_before_seconds <= visibility_timeout_seconds:
            raise ValueError("renew_before_seconds must be within the visibility timeout")
        if not 0 < check_interval_seconds < renew_before_seconds:
            raise ValueError("check_interval_seconds must be shorter than renew_before_seconds")
        self._queue = queue
        self._timeout = visibility_timeout_seconds
        self._interval = float(check_interval_seconds)
        self._renew_before = float(renew_before_seconds)
        self._clock = clock
        self._deadlines: dict[str, tuple[BatchDelivery, float]] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._error: BaseException | None = None
        self._thread = threading.Thread(target=self._run, name="visibility-heartbeat", daemon=True)
        self._started = False

    def track(self, deliveries: Iterable[BatchDelivery], received_at: float) -> None:
        """Passa a acompanhar entregas recebidas no instante ``received_at`` ou depois."""
        deadline = received_at + self._timeout
        with self._lock:
            for delivery in deliveries:
                self._deadlines[delivery.message_id] = (delivery, deadline)

    def release(self, delivery: BatchDelivery) -> None:
        """Encerra a renovação de uma entrega; espera uma renovação em curso terminar."""
        with self._lock:
            self._deadlines.pop(delivery.message_id, None)

    def tick(self) -> None:
        """Faz uma verificação e renova as entregas perto do fim da invisibilidade."""
        with self._lock:
            if self._error is not None:
                return
            for message_id, (delivery, deadline) in list(self._deadlines.items()):
                now = self._clock()
                remaining = deadline - now
                if remaining > self._renew_before:
                    continue
                if remaining <= 0:
                    self._fail(delivery, VisibilityHeartbeatLost("visibility expired"))
                    return
                try:
                    self._queue.extend_visibility(delivery, self._timeout)
                except Exception as error:
                    self._fail(delivery, error)
                    return
                self._deadlines[message_id] = (delivery, now + self._timeout)

    def _fail(self, delivery: BatchDelivery, error: BaseException) -> None:
        self._error = error
        _LOGGER.warning(
            "ingest-incremental visibility heartbeat failed batch_id=%s message_id=%s "
            "dataset=%s error_type=%s error=%s",
            delivery.batch_id,
            delivery.message_id,
            delivery.source_dataset,
            type(error).__name__,
            error,
        )

    def check(self) -> None:
        """Levanta ``VisibilityHeartbeatLost`` se alguma renovação falhou."""
        with self._lock:
            error = self._error
        if error is not None:
            raise VisibilityHeartbeatLost("incremental queue visibility was lost") from error

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            self.tick()
            with self._lock:
                if self._error is not None:
                    return

    def start(self) -> None:
        self._thread.start()
        self._started = True

    def stop(self, timeout_seconds: float = 60.0) -> None:
        """Para a thread; uma renovação em curso termina antes do retorno."""
        self._stop.set()
        if self._started:
            self._thread.join(timeout_seconds)
            self._started = False


__all__ = ["VisibilityHeartbeat", "VisibilityHeartbeatLost"]
