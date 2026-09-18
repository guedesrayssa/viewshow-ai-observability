"""Classifica cobertura e confiabilidade das medidas derivadas da origem.

Papel no fluxo:
    Este arquivo pertence ao núcleo de domínio e deve permanecer determinístico, sem acesso a
    rede, sistema de arquivos, banco de dados ou variáveis de ambiente.

Garantias e limites:
    As validações falham de forma fechada: valores ambíguos ou incompletos são rejeitados antes
    de atravessar uma porta de persistência.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum

from domain.models import TimeWindow


class CoverageStatus(StrEnum):
    """Enumera os estados aceitos para cobertura status."""

    COMPLETE = "complete"
    PARTIAL = "partial"
    UNAVAILABLE = "unavailable"


class BotCoverage(StrEnum):
    """Enumera os estados aceitos para bot cobertura."""

    RELIABLE = "reliable"
    AMBIGUOUS_DEFAULT_ZERO = "ambiguous_default_zero"
    UNAVAILABLE = "unavailable"


BOT_RELIABLE_FROM_SQL = """SELECT MIN(hour_ts) AS first_bot_bucket
FROM error_cat_hourly
WHERE errors_bot > 0"""

type ScalarQuery = Callable[[str], object | None]


@dataclass(frozen=True, slots=True)
class BotCoverageReport:
    """Representa os dados de ``BotCoverageReport`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        bot_reliable_from_ms: Entrada ``bot_reliable_from_ms``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        status: Entrada ``status``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
    """

    bot_reliable_from_ms: int | None
    status: BotCoverage


def discover_bot_coverage(execute_scalar: ScalarQuery) -> BotCoverageReport:
    """Descobre bot cobertura a partir das evidências disponíveis na origem.

    Args:
        execute_scalar: Entrada ``execute_scalar``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.

    Returns:
        Valor ``BotCoverageReport`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    value = execute_scalar(BOT_RELIABLE_FROM_SQL)
    if value is None:
        return BotCoverageReport(None, BotCoverage.AMBIGUOUS_DEFAULT_ZERO)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("first_bot_bucket must be an epoch-millisecond integer or null")
    return BotCoverageReport(value, BotCoverage.RELIABLE)


def derive_human_errors(
    errors: int | Decimal,
    errors_bot: int | Decimal,
    bot_coverage: BotCoverage,
) -> int | Decimal | None:
    """Deriva human erros somente quando as entradas possuem cobertura suficiente.

    Args:
        errors: Entrada ``errors``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        errors_bot: Entrada ``errors_bot``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        bot_coverage: Entrada ``bot_coverage``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.

    Returns:
        Valor ``int | Decimal | None`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(bot_coverage, BotCoverage):
        raise TypeError("bot_coverage must be a BotCoverage")
    _validate_count(errors, "errors")
    _validate_count(errors_bot, "errors_bot")
    if errors_bot > errors:
        raise ValueError("errors_bot cannot be greater than errors")
    if bot_coverage is BotCoverage.RELIABLE:
        if isinstance(errors, Decimal) or isinstance(errors_bot, Decimal):
            return Decimal(errors) - Decimal(errors_bot)
        return errors - errors_bot
    return None


def derive_coverage_status(
    expected: TimeWindow,
    observed: TimeWindow | None,
) -> CoverageStatus:
    """Obtém o estado de derive cobertura sem inferir valores ausentes.

    Args:
        expected: Entrada ``expected``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        observed: Entrada ``observed``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``CoverageStatus`` produzido pela operação após as validações.
    """
    if observed is None:
        return CoverageStatus.UNAVAILABLE
    if observed.end <= expected.start or observed.start >= expected.end:
        return CoverageStatus.UNAVAILABLE
    if observed.start <= expected.start and observed.end >= expected.end:
        return CoverageStatus.COMPLETE
    return CoverageStatus.PARTIAL


def _validate_count(value: int | Decimal, field_name: str) -> None:
    """Valida contagem contra as invariantes deste módulo.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field_name: Nome validado do recurso, campo ou operação correspondente.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if isinstance(value, bool) or not isinstance(value, int | Decimal):
        raise TypeError(f"{field_name} must be an integer or Decimal count")
    if isinstance(value, Decimal) and not value.is_finite():
        raise ValueError(f"{field_name} must be finite")
    if value < 0:
        raise ValueError(f"{field_name} cannot be negative")


__all__ = [
    "BOT_RELIABLE_FROM_SQL",
    "BotCoverage",
    "BotCoverageReport",
    "CoverageStatus",
    "ScalarQuery",
    "derive_coverage_status",
    "derive_human_errors",
    "discover_bot_coverage",
]
