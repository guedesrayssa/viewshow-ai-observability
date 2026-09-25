"""Centraliza os prazos de retenção aplicados a dados quentes e históricos.

Papel no fluxo:
    Este arquivo pertence ao núcleo de domínio e deve permanecer determinístico, sem acesso a
    rede, sistema de arquivos, banco de dados ou variáveis de ambiente.

Garantias e limites:
    As validações falham de forma fechada: valores ambíguos ou incompletos são rejeitados antes
    de atravessar uma porta de persistência.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class RetentionPolicy:
    """Representa os dados de ``RetentionPolicy`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        hot_days: Entrada ``hot_days``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        canonical_months: Entrada ``canonical_months``; a forma aceita é definida pela anotação
        de tipo e validada antes do uso.
        run_days: Entrada ``run_days``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        dump_days: Entrada ``dump_days``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        staging_days: Entrada ``staging_days``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.
        queue_days: Entrada ``queue_days``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
    """

    hot_days: int = 30
    canonical_months: int = 12
    run_days: int = 90
    dump_days: int = 30
    staging_days: int = 7
    queue_days: int = 14

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        for name, value in (
            ("hot_days", self.hot_days),
            ("canonical_months", self.canonical_months),
            ("run_days", self.run_days),
            ("dump_days", self.dump_days),
            ("staging_days", self.staging_days),
            ("queue_days", self.queue_days),
        ):
            if isinstance(value, bool) or not isinstance(value, int):
                raise TypeError(f"{name} must be an integer")
            if value <= 0:
                raise ValueError(f"{name} must be positive")


__all__ = ["RetentionPolicy"]
