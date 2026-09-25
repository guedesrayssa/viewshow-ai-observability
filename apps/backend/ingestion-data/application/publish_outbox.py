"""Publica um lote limitado de eventos pendentes e registra seus recibos.

Papel no fluxo:
    No fluxo da aplicação, este módulo coordena regras do domínio por meio das interfaces de
    ``ports`` e não depende diretamente de SDKs ou formatos de infraestrutura.

Garantias e limites:
    A ordem das operações preserva idempotência, reconciliação e retomada segura quando uma
    execução é interrompida.
"""

from __future__ import annotations

from dataclasses import dataclass

from ports import AnalysisRequestPublisher, OutboxRepository


@dataclass(frozen=True, slots=True)
class PublishResult:
    """Representa os dados de ``PublishResult`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        attempted: Entrada ``attempted``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        published: Entrada ``published``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
    """

    attempted: int
    published: int

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        for field in ("attempted", "published"):
            value = getattr(self, field)
            if isinstance(value, bool) or not isinstance(value, int):
                raise TypeError(f"{field} must be an integer")
            if value < 0:
                raise ValueError(f"{field} must be non-negative")
        if self.published > self.attempted:
            raise ValueError("published must not exceed attempted")


class OutboxPublisher:
    """Agrupa o estado e as operações de ``OutboxPublisher`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        repository: OutboxRepository,
        publisher: AnalysisRequestPublisher,
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            repository: Porta de persistência usada pelo caso de uso.
            publisher: Entrada ``publisher``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._repository = repository
        self._publisher = publisher

    def publish_pending(self, limit: int) -> PublishResult:
        """Publica pendente preservando idempotência e validação de resposta.

        Args:
            limit: Quantidade máxima de itens que a operação pode processar.

        Returns:
            Valor ``PublishResult`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if isinstance(limit, bool) or not isinstance(limit, int):
            raise TypeError("limit must be an integer")
        if limit <= 0:
            raise ValueError("limit must be positive")
        events = self._repository.list_pending(limit)
        published = 0
        for event in events:
            receipt = self._publisher.publish(event, idempotency_key=event.idempotency_key)
            self._repository.mark_published(
                event.event_id,
                receipt.message_id,
                expected_state="PENDING",
                idempotency_key=f"publish-outbox:{event.event_id}",
            )
            published += 1
        return PublishResult(attempted=len(events), published=published)


def publish_pending(
    repository: OutboxRepository,
    publisher: AnalysisRequestPublisher,
    limit: int,
) -> PublishResult:
    """Publica pendente preservando idempotência e validação de resposta.

    Args:
        repository: Porta de persistência usada pelo caso de uso.
        publisher: Entrada ``publisher``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        limit: Quantidade máxima de itens que a operação pode processar.

    Returns:
        Valor ``PublishResult`` produzido pela operação após as validações.
    """
    return OutboxPublisher(repository, publisher).publish_pending(limit)


__all__ = ["OutboxPublisher", "PublishResult", "publish_pending"]
