"""Associa identidades determinísticas a um registro canônico normalizado.

Papel no fluxo:
    No fluxo da aplicação, este módulo coordena regras do domínio por meio das interfaces de
    ``ports`` e não depende diretamente de SDKs ou formatos de infraestrutura.

Garantias e limites:
    A ordem das operações preserva idempotência, reconciliação e retomada segura quando uma
    execução é interrompida.
"""

from __future__ import annotations

from dataclasses import dataclass

from domain.identity import payload_hash, record_id
from domain.models import CanonicalRecord


@dataclass(frozen=True, slots=True)
class IdentifiedRecord:
    """Representa os dados de ``IdentifiedRecord`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        record: Registro canônico consumido pela operação.
        record_id: Identificador estável da entidade ou operação correspondente.
        payload_hash: Entrada ``payload_hash``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.
    """

    record: CanonicalRecord
    record_id: str
    payload_hash: str


def identify_record(record: CanonicalRecord) -> IdentifiedRecord:
    """Calcula a identidade determinística de registro.

    Args:
        record: Registro canônico consumido pela operação.

    Returns:
        Valor ``IdentifiedRecord`` produzido pela operação após as validações.
    """
    return IdentifiedRecord(record, record_id(record), payload_hash(record))


__all__ = ["IdentifiedRecord", "identify_record"]
