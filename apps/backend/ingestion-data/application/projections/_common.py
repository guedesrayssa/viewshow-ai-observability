"""Centraliza validações, cobertura e cálculos compartilhados pelas projeções.

Papel no fluxo:
    No fluxo da aplicação, este módulo coordena regras do domínio por meio das interfaces de
    ``ports`` e não depende diretamente de SDKs ou formatos de infraestrutura.

Garantias e limites:
    A ordem das operações preserva idempotência, reconciliação e retomada segura quando uma
    execução é interrompida.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from domain.models import CanonicalRecord
from domain.quality import CoverageStatus

PROJECTION_VERSION = "1.0"
FORMULA_VERSION = "1.0"


@dataclass(frozen=True, slots=True)
class InputWatermark:
    """Representa os dados de ``InputWatermark`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        dataset: Nome do dataset permitido pelo registro de contratos.
        observed_at: Valor efetivamente observado que será comparado com a evidência esperada.
        record_count: Quantidade inteira não negativa usada na reconciliação.
    """

    dataset: str
    observed_at: datetime
    record_count: int


@dataclass(frozen=True, slots=True)
class ProjectionCoverage:
    """Representa os dados de ``ProjectionCoverage`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        status: Entrada ``status``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        policies: Entrada ``policies``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        quality_flags: Entrada ``quality_flags``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
    """

    status: CoverageStatus
    policies: tuple[str, ...]
    quality_flags: tuple[str, ...]


def records_tuple(records: Iterable[CanonicalRecord]) -> tuple[CanonicalRecord, ...]:
    """Executa a etapa interna ``records_tuple`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        records: Registros canônicos consumidos pela operação.

    Returns:
        Valor ``tuple[CanonicalRecord, ...]`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    result = tuple(records)
    if any(not isinstance(item, CanonicalRecord) for item in result):
        raise TypeError("records must contain only CanonicalRecord values")
    return result


def require_dataset(
    records: tuple[CanonicalRecord, ...], permitted: frozenset[str], projection: str
) -> None:
    """Valida e devolve dataset, rejeitando entradas fora do contrato.

    Args:
        records: Registros canônicos consumidos pela operação.
        permitted: Entrada ``permitted``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        projection: Entrada ``projection``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    unexpected = sorted({record.source_dataset for record in records} - permitted)
    if unexpected:
        raise ValueError(f"{projection} does not accept datasets: {unexpected}")


def require_one_dataset_and_grain(records: tuple[CanonicalRecord, ...], projection: str) -> None:
    """Valida e devolve one dataset and grain, rejeitando entradas fora do contrato.

    Args:
        records: Registros canônicos consumidos pela operação.
        projection: Entrada ``projection``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    datasets = {record.source_dataset for record in records}
    grains = {
        record.window.grain_seconds if record.window is not None else None for record in records
    }
    if len(datasets) > 1 or len(grains) > 1:
        raise ValueError(f"{projection} records must have one dataset and one grain")


def watermarks(records: tuple[CanonicalRecord, ...]) -> tuple[InputWatermark, ...]:
    """Executa a etapa interna ``watermarks`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        records: Registros canônicos consumidos pela operação.

    Returns:
        Valor ``tuple[InputWatermark, ...]`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    grouped: dict[str, list[datetime]] = {}
    for record in records:
        if record.observed_at is None:
            raise ValueError("projection inputs must have an explicit observed_at watermark")
        grouped.setdefault(record.source_dataset, []).append(record.observed_at)
    return tuple(
        InputWatermark(dataset, max(values), len(values))
        for dataset, values in sorted(grouped.items())
    )


def coverage(records: tuple[CanonicalRecord, ...]) -> ProjectionCoverage:
    """Executa a etapa interna ``coverage`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        records: Registros canônicos consumidos pela operação.

    Returns:
        Valor ``ProjectionCoverage`` produzido pela operação após as validações.
    """
    policies: set[str] = set()
    flags: set[str] = set()
    ambiguous = False
    for record in records:
        policy = record.quality.get("coveragePolicy")
        if isinstance(policy, str) and policy:
            policies.add(policy)
        flags.update(record.quality_flags)
        bot_status = record.quality.get("botCoverageStatus")
        if bot_status != "reliable" and bot_status is not None:
            ambiguous = True
    if not records:
        status = CoverageStatus.UNAVAILABLE
    elif flags or ambiguous:
        status = CoverageStatus.PARTIAL
    else:
        status = CoverageStatus.COMPLETE
    return ProjectionCoverage(status, tuple(sorted(policies)), tuple(sorted(flags)))


def numeric(value: object, field: str) -> Decimal:
    """Executa a etapa interna ``numeric`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``Decimal`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if isinstance(value, bool) or not isinstance(value, int | Decimal):
        raise ValueError(f"{field} must be an integer or Decimal")
    converted = Decimal(value)
    if not converted.is_finite() or converted < 0:
        raise ValueError(f"{field} must be finite and non-negative")
    return converted


def optional_numeric(value: object, field: str) -> Decimal | None:
    """Converte numeric quando presente e preserva a ausência como ``None``.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``Decimal | None`` produzido pela operação após as validações.
    """
    return None if value is None else numeric(value, field)


def sum_measure(records: tuple[CanonicalRecord, ...], field: str) -> Decimal | None:
    """Soma medida sem inventar valores ausentes.

    Args:
        records: Registros canônicos consumidos pela operação.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``Decimal | None`` produzido pela operação após as validações.
    """
    values = [
        numeric(record.measures[field], field) for record in records if field in record.measures
    ]
    return sum(values, Decimal(0)) if values else None


def ratio(numerator: Decimal | None, denominator: Decimal | None) -> Decimal | None:
    """Calcula a proporção de a entrada quando o denominador é válido.

    Args:
        numerator: Entrada ``numerator``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        denominator: Entrada ``denominator``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``Decimal | None`` produzido pela operação após as validações.
    """
    if numerator is None or denominator is None or denominator == 0:
        return None
    return numerator / denominator


def required_text(values: Mapping[str, object], field: str) -> str:
    """Obtém texto e rejeita a ausência ou um formato inválido.

    Args:
        values: Coleção de valores consumida pela operação.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    value = values.get(field)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field} must be a non-empty string")
    return value
