"""Calcula os indicadores resumidos exibidos na visão geral operacional.

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
from decimal import Decimal
from types import MappingProxyType
from typing import TypedDict, cast

from application.projections._common import (
    FORMULA_VERSION,
    PROJECTION_VERSION,
    InputWatermark,
    ProjectionCoverage,
    coverage,
    ratio,
    records_tuple,
    require_one_dataset_and_grain,
    sum_measure,
    watermarks,
)
from domain.models import CanonicalRecord, RecordType


class OverviewMetrics(TypedDict):
    """Descreve o formato fechado de ``OverviewMetrics`` trocado entre as camadas.

    As chaves declaradas fazem parte do contrato de dados e não devem ser ampliadas
    implicitamente por adaptadores.

    Attributes:
        sessions: Entrada ``sessions``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        errors: Entrada ``errors``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        startupErrors: Entrada ``startupErrors``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        botErrors: Entrada ``botErrors``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        humanErrors: Entrada ``humanErrors``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        errorRate: Entrada ``errorRate``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
    """

    sessions: Decimal | None
    errors: Decimal | None
    startupErrors: Decimal | None
    botErrors: Decimal | None
    humanErrors: Decimal | None
    errorRate: Decimal | None


@dataclass(frozen=True, slots=True)
class OverviewView:
    """Representa os dados de ``OverviewView`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        metrics: Porta de métricas que recebe observações de baixa cardinalidade.
        coverage: Entrada ``coverage``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        input_watermarks: Entrada ``input_watermarks``; a forma aceita é definida pela anotação
        de tipo e validada antes do uso.
        projection_version: Versão imutável usada para identidade e compatibilidade.
        formula_version: Versão imutável usada para identidade e compatibilidade.
    """

    metrics: Mapping[str, Decimal | None]
    coverage: ProjectionCoverage
    input_watermarks: tuple[InputWatermark, ...]
    projection_version: str = PROJECTION_VERSION
    formula_version: str = FORMULA_VERSION


def build_overview(records: Iterable[CanonicalRecord]) -> OverviewView:
    """Constrói overview a partir das entradas validadas.

    Args:
        records: Registros canônicos consumidos pela operação.

    Returns:
        Valor ``OverviewView`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    source = records_tuple(records)
    require_one_dataset_and_grain(source, "overview")
    if any(
        record.record_type
        not in {
            RecordType.SIGNAL_OBSERVATION,
            RecordType.DIMENSIONAL_METRIC_AGGREGATE,
            RecordType.APPLICATION_ERROR_AGGREGATE,
        }
        for record in source
    ):
        raise ValueError("overview accepts only canonical metric facts")
    sessions = sum_measure(source, "sessions")
    errors = sum_measure(source, "errors")
    bot_errors = sum_measure(source, "errorsBot")
    human_values = tuple(record.measures.get("humanErrors") for record in source)
    bot_coverage_is_reliable = all(
        record.quality.get("botCoverageStatus") == "reliable"
        for record in source
        if "humanErrors" in record.measures or "errorsBot" in record.measures
    )
    human_errors = (
        None
        if not bot_coverage_is_reliable or any(value is None for value in human_values)
        else sum_measure(source, "humanErrors")
    )
    metrics = OverviewMetrics(
        sessions=sessions,
        errors=errors,
        startupErrors=sum_measure(source, "startup_errors"),
        botErrors=bot_errors,
        humanErrors=human_errors,
        errorRate=ratio(errors, sessions),
    )
    return OverviewView(
        cast(Mapping[str, Decimal | None], MappingProxyType(dict(metrics))),
        coverage(source),
        watermarks(source),
    )


__all__ = ["OverviewMetrics", "OverviewView", "build_overview"]
