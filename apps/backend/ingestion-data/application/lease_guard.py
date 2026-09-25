"""Gerencia a posse cooperativa e limitada de leases durante casos de uso longos.

Papel no fluxo:
    No fluxo da aplicação, este módulo coordena regras do domínio por meio das interfaces de
    ``ports`` e não depende diretamente de SDKs ou formatos de infraestrutura.

Garantias e limites:
    A ordem das operações preserva idempotência, reconciliação e retomada segura quando uma
    execução é interrompida.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from datetime import datetime, timedelta

from ports import Lease, LeaseBusy, LeaseRepository


class LeaseGuard:
    """Agrupa o estado e as operações de ``LeaseGuard`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        repository: LeaseRepository,
        sources: tuple[str, ...],
        owner: str,
        ttl_seconds: int,
        clock: Callable[[], datetime],
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            repository: Porta de persistência usada pelo caso de uso.
            sources: Entrada ``sources``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            owner: Identidade do worker que possui ou solicita o lease.
            ttl_seconds: Duração do lease ou da retenção, expressa em segundos.
            clock: Função injetável que fornece o instante atual para validação e testes.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        if not sources or len(sources) != len(set(sources)):
            raise ValueError("lease sources must be a non-empty unique tuple")
        if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int):
            raise TypeError("lease ttl must be an integer")
        if ttl_seconds <= 0:
            raise ValueError("lease ttl must be positive")
        self._repository = repository
        self._sources = sources
        self._owner = owner
        self._ttl_seconds = ttl_seconds
        self._clock = clock
        self._leases: dict[str, Lease] = {}
        self._sequences: dict[str, int] = {}
        self._interval = max(0.05, min(float(ttl_seconds) / 3, 30.0))
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._error: Exception | None = None
        self._thread = threading.Thread(
            target=self._run,
            name=f"lease-guard-{owner}",
            daemon=True,
        )
        self._started = False

    def _now(self) -> datetime:
        """Executa a etapa interna ``now`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``datetime`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        value = self._clock()
        if (
            not isinstance(value, datetime)
            or value.tzinfo is None
            or value.utcoffset() != timedelta(0)
        ):
            raise ValueError("clock must return an aware UTC datetime")
        return value

    def try_acquire(self) -> bool:
        """Verifica a condição associada a try acquire.

        Returns:
            Valor ``bool`` produzido pela operação após as validações.
        """
        try:
            for source in self._sources:
                lease = self._repository.acquire(
                    source,
                    self._owner,
                    self._now(),
                    self._ttl_seconds,
                    idempotency_key=f"lease-acquire:{self._owner}:{source}",
                )
                self._leases[source] = lease
                self._sequences[source] = 0
        except LeaseBusy:
            self.close()
            return False
        except BaseException:
            self.close()
            raise
        try:
            self._thread.start()
            self._started = True
        except BaseException:
            self.close()
            raise
        return True

    def _renew_all(self) -> None:
        """Renova all sem permitir redução do prazo já persistido.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        with self._lock:
            if self._error is not None:
                raise self._error
            now = self._now()
            try:
                for source in self._sources:
                    lease = self._leases[source]
                    sequence = self._sequences[source] + 1
                    self._leases[source] = self._repository.renew(
                        source,
                        self._owner,
                        now,
                        self._ttl_seconds,
                        expected_expires_at=lease.expires_at,
                        idempotency_key=(f"lease-renew:{self._owner}:{source}:{sequence}"),
                    )
                    self._sequences[source] = sequence
            except Exception as error:
                self._error = error
                raise

    def _run(self) -> None:
        """Executa a etapa interna ``run`` e valida seus efeitos antes de concluir.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        while not self._stop.wait(self._interval):
            try:
                self._renew_all()
            except Exception:
                return

    def checkpoint(self) -> None:
        """Renova e verifica o lease antes de continuar o processamento.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._renew_all()

    def fence(self) -> None:
        """Confirma que o lease ainda pertence à execução antes do efeito final.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self.stop()
        self._renew_all()

    def stop(self, timeout_seconds: float = 1.0) -> None:
        """Solicita a interrupção segura do processamento gerenciado.

        Args:
            timeout_seconds: Duração ou prazo expresso em segundos.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TimeoutError: Se a operação externa ultrapassar o tempo limite configurado.
        """
        self._stop.set()
        if self._started:
            self._thread.join(timeout_seconds)
            if self._thread.is_alive():
                raise TimeoutError("lease guard did not stop before the cleanup deadline")
            self._started = False

    def close(self) -> None:
        """Libera recursos locais ainda mantidos pela instância.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        try:
            self.stop()
        except Exception:
            pass
        for source in reversed(self._sources):
            if source not in self._leases:
                continue
            try:
                self._repository.release(
                    source,
                    self._owner,
                    idempotency_key=f"lease-release:{self._owner}:{source}",
                )
            except Exception:
                pass
        self._leases.clear()


__all__ = ["LeaseGuard"]
