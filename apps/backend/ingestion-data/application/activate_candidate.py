"""Expõe a operação atômica que transforma um manifesto candidato em ativo.

Papel no fluxo:
    No fluxo da aplicação, este módulo coordena regras do domínio por meio das interfaces de
    ``ports`` e não depende diretamente de SDKs ou formatos de infraestrutura.

Garantias e limites:
    A ordem das operações preserva idempotência, reconciliação e retomada segura quando uma
    execução é interrompida.
"""

from __future__ import annotations

from ports import CandidateManifest, ManifestRepository


def activate_candidate(
    repository: ManifestRepository,
    expected_active: str | None,
    candidate: CandidateManifest,
    *,
    idempotency_key: str,
) -> CandidateManifest:
    """Ativa candidato por meio de uma troca atômica do estado esperado.

    Args:
        repository: Porta de persistência usada pelo caso de uso.
        expected_active: Valor esperado usado para detectar concorrência ou divergência de
        estado.
        candidate: Manifesto candidato que poderá se tornar ativo.
        idempotency_key: Chave estável que identifica uma repetição da mesma operação.

    Returns:
        Valor ``CandidateManifest`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    if not isinstance(repository, ManifestRepository):
        raise TypeError("repository must implement ManifestRepository")
    return repository.activate(
        expected_active,
        candidate,
        idempotency_key=idempotency_key,
    )


__all__ = ["activate_candidate"]
