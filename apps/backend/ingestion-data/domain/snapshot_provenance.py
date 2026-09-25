"""Valida a data de extração que identifica a proveniência do snapshot.

Papel no fluxo:
    Este arquivo pertence ao núcleo de domínio e deve permanecer determinístico, sem acesso a
    rede, sistema de arquivos, banco de dados ou variáveis de ambiente.

Garantias e limites:
    As validações falham de forma fechada: valores ambíguos ou incompletos são rejeitados antes
    de atravessar uma porta de persistência.
"""

from __future__ import annotations

import re
from datetime import date

_ISO_DATE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")


def parse_snapshot_extracted_on(value: object, field: str = "snapshotExtractedOn") -> date:
    """Converte snapshot extracted on para a representação interna validada.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``date`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, str) or _ISO_DATE.fullmatch(value) is None:
        raise ValueError(f"{field} must be a canonical ISO date (YYYY-MM-DD)")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as error:
        raise ValueError(f"{field} must be a valid calendar date") from error
    if parsed.isoformat() != value:
        raise ValueError(f"{field} must be a canonical ISO date (YYYY-MM-DD)")
    return parsed


__all__ = ["parse_snapshot_extracted_on"]
