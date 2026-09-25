"""Acumula e valida contagens de leitura, aceitação, rejeição e persistência.

Papel no fluxo:
    No fluxo da aplicação, este módulo coordena regras do domínio por meio das interfaces de
    ``ports`` e não depende diretamente de SDKs ou formatos de infraestrutura.

Garantias e limites:
    A ordem das operações preserva idempotência, reconciliação e retomada segura quando uma
    execução é interrompida.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Reconciliation:
    """Representa os dados de ``Reconciliation`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        read: Entrada ``read``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        accepted: Entrada ``accepted``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        rejected: Entrada ``rejected``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        unchanged: Entrada ``unchanged``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        written: Entrada ``written``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
    """

    read: int
    accepted: int
    rejected: int
    unchanged: int
    written: int

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        counters = (self.read, self.accepted, self.rejected, self.unchanged, self.written)
        if any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in counters
        ):
            raise ValueError("reconciliation counters must be non-negative integers")
        if self.accepted + self.rejected != self.read:
            raise ValueError("accepted plus rejected must equal read")
        if self.unchanged + self.written != self.accepted:
            raise ValueError("unchanged plus written must equal accepted")


__all__ = ["Reconciliation"]
