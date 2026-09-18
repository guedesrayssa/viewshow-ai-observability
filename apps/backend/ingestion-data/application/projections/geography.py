"""Agrega fatos geográficos por estado e provedor de internet.

Papel no fluxo:
    No fluxo da aplicação, este módulo coordena regras do domínio por meio das interfaces de
    ``ports`` e não depende diretamente de SDKs ou formatos de infraestrutura.

Garantias e limites:
    A ordem das operações preserva idempotência, reconciliação e retomada segura quando uma
    execução é interrompida.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal

from application.projections._common import (
    FORMULA_VERSION,
    PROJECTION_VERSION,
    InputWatermark,
    ProjectionCoverage,
    coverage,
    numeric,
    ratio,
    records_tuple,
    required_text,
    watermarks,
)
from domain.models import CanonicalRecord, RecordType


@dataclass(frozen=True, slots=True)
class GeographicMetric:
    """Representa os dados de ``GeographicMetric`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        state: Estado imutável que será validado ou persistido.
        isp: Entrada ``isp``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        sessions: Entrada ``sessions``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        errors: Entrada ``errors``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        error_rate: Entrada ``error_rate``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
    """

    state: str
    isp: str
    sessions: Decimal
    errors: Decimal
    error_rate: Decimal | None


@dataclass(frozen=True, slots=True)
class GeographyView:
    """Representa os dados de ``GeographyView`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        locations: Entrada ``locations``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        coverage: Entrada ``coverage``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        input_watermarks: Entrada ``input_watermarks``; a forma aceita é definida pela anotação
        de tipo e validada antes do uso.
        projection_version: Versão imutável usada para identidade e compatibilidade.
        formula_version: Versão imutável usada para identidade e compatibilidade.
    """

    locations: tuple[GeographicMetric, ...]
    coverage: ProjectionCoverage
    input_watermarks: tuple[InputWatermark, ...]
    projection_version: str = PROJECTION_VERSION
    formula_version: str = FORMULA_VERSION


def build_geography(records: Iterable[CanonicalRecord]) -> GeographyView:
    """Constrói geografia a partir das entradas validadas.

    Args:
        records: Registros canônicos consumidos pela operação.

    Returns:
        Valor ``GeographyView`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    source = records_tuple(records)
    if any(
        record.source_dataset != "geo_hourly"
        or record.record_type is not RecordType.DIMENSIONAL_METRIC_AGGREGATE
        or record.window is None
        or record.window.grain_seconds != 3600
        for record in source
    ):
        raise ValueError("geography accepts only hourly geo_hourly facts")
    grouped: dict[tuple[str, str], tuple[Decimal, Decimal]] = {}
    for record in source:
        key = (
            required_text(record.dimensions, "state_province"),
            required_text(record.dimensions, "isp"),
        )
        sessions = numeric(record.measures.get("sessions"), "sessions")
        errors = numeric(record.measures.get("errors"), "errors")
        prior_sessions, prior_errors = grouped.get(key, (Decimal(0), Decimal(0)))
        grouped[key] = (prior_sessions + sessions, prior_errors + errors)
    locations = tuple(
        GeographicMetric(state, isp, sessions, errors, ratio(errors, sessions))
        for (state, isp), (sessions, errors) in sorted(grouped.items())
    )
    return GeographyView(locations, coverage(source), watermarks(source))


__all__ = ["GeographicMetric", "GeographyView", "build_geography"]
