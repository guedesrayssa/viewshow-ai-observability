"""Seleciona as evidências mais recentes de saúde de fontes e coletores.

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
from datetime import datetime, timedelta
from decimal import Decimal

from application.projections._common import (
    FORMULA_VERSION,
    PROJECTION_VERSION,
    InputWatermark,
    ProjectionCoverage,
    coverage,
    numeric,
    records_tuple,
    watermarks,
)
from domain.models import CanonicalRecord, RecordType


@dataclass(frozen=True, slots=True)
class SourceMonitoring:
    """Representa os dados de ``SourceMonitoring`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        source: Identificador da fonte de dados processada.
        observed_at: Valor efetivamente observado que será comparado com a evidência esperada.
        finished_at: Instante UTC com fuso horário usado pela regra temporal.
        rows_processed: Entrada ``rows_processed``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        duration_seconds: Duração ou prazo expresso em segundos.
        quality_flags: Entrada ``quality_flags``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
    """

    source: str
    observed_at: datetime
    finished_at: datetime | None
    rows_processed: Decimal | None
    duration_seconds: Decimal | None
    quality_flags: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class MonitoringView:
    """Representa os dados de ``MonitoringView`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        sources: Entrada ``sources``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        coverage: Entrada ``coverage``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        input_watermarks: Entrada ``input_watermarks``; a forma aceita é definida pela anotação
        de tipo e validada antes do uso.
        projection_version: Versão imutável usada para identidade e compatibilidade.
        formula_version: Versão imutável usada para identidade e compatibilidade.
    """

    sources: tuple[SourceMonitoring, ...]
    coverage: ProjectionCoverage
    input_watermarks: tuple[InputWatermark, ...]
    projection_version: str = PROJECTION_VERSION
    formula_version: str = FORMULA_VERSION


def _source(record: CanonicalRecord) -> str:
    """Executa a etapa interna ``source`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        record: Registro canônico consumido pela operação.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    candidate = record.dimensions.get("source")
    if isinstance(candidate, str) and candidate:
        return candidate
    return record.source_dataset


def _finished(record: CanonicalRecord) -> datetime | None:
    """Executa a etapa interna ``finished`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        record: Registro canônico consumido pela operação.

    Returns:
        Valor ``datetime | None`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    for field in ("finished_at", "last_run_at"):
        value = record.measures.get(field)
        if value is not None:
            if not isinstance(value, datetime):
                raise ValueError(f"{field} must be a datetime or null")
            if value.tzinfo is None or value.utcoffset() != timedelta(0):
                raise ValueError(f"{field} must be an aware UTC datetime")
            return value
    return None


def _first_measure(record: CanonicalRecord, fields: tuple[str, ...]) -> Decimal | None:
    """Executa a etapa interna ``first_measure`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        record: Registro canônico consumido pela operação.
        fields: Entrada ``fields``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``Decimal | None`` produzido pela operação após as validações.
    """
    for field in fields:
        value = record.measures.get(field)
        if value is not None:
            return numeric(value, field)
    return None


def build_monitoring(records: Iterable[CanonicalRecord]) -> MonitoringView:
    """Constrói monitoramento a partir das entradas validadas.

    Args:
        records: Registros canônicos consumidos pela operação.

    Returns:
        Valor ``MonitoringView`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    source = records_tuple(records)
    if any(
        record.record_type
        not in {RecordType.UPSTREAM_SOURCE_HEALTH, RecordType.UPSTREAM_COLLECTOR_RUN}
        for record in source
    ):
        raise ValueError("monitoring accepts only source-health and collector-run facts")
    identities: dict[tuple[str, str, tuple[tuple[str, object], ...]], CanonicalRecord] = {}
    by_source: dict[str, list[CanonicalRecord]] = {}
    for record in source:
        if record.observed_at is None:
            raise ValueError("monitoring inputs must have observed_at")
        identity = (record.source_system, record.source_dataset, record.natural_key)
        duplicate = identities.get(identity)
        if duplicate is not None and duplicate != record:
            raise ValueError("monitoring contains a conflicting duplicate canonical identity")
        identities[identity] = record
        by_source.setdefault(_source(record), []).append(record)
    latest: dict[str, CanonicalRecord] = {}
    for source_name, candidates in by_source.items():
        latest_at = max(
            record.observed_at for record in candidates if record.observed_at is not None
        )
        tied = tuple(record for record in candidates if record.observed_at == latest_at)
        if any(record != tied[0] for record in tied[1:]):
            raise ValueError("monitoring source has conflicting records at the latest timestamp")
        latest[source_name] = tied[0]
    entries = tuple(
        SourceMonitoring(
            source_name,
            record.observed_at,  # type: ignore[arg-type]
            _finished(record),
            _first_measure(
                record,
                (
                    "rows_last_run",
                    "rows_upserted",
                    "rows_inserted",
                    "points_inserted",
                    "entries_read",
                ),
            ),
            _first_measure(record, ("duration_s",)),
            tuple(sorted(record.quality_flags)),
        )
        for source_name, record in sorted(latest.items())
    )
    return MonitoringView(entries, coverage(source), watermarks(source))


__all__ = ["MonitoringView", "SourceMonitoring", "build_monitoring"]
