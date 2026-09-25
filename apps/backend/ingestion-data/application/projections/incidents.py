"""Constrói as visões diária e ativa de incidentes a partir do estado da origem.

Papel no fluxo:
    No fluxo da aplicação, este módulo coordena regras do domínio por meio das interfaces de
    ``ports`` e não depende diretamente de SDKs ou formatos de infraestrutura.

Garantias e limites:
    A ordem das operações preserva idempotência, reconciliação e retomada segura quando uma
    execução é interrompida.
"""

from __future__ import annotations

import base64
import hashlib
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta

from application.projections._common import (
    FORMULA_VERSION,
    PROJECTION_VERSION,
    InputWatermark,
    ProjectionCoverage,
    coverage,
    records_tuple,
    watermarks,
)
from domain.models import CanonicalRecord, RecordType

_TERMINAL_STATES = frozenset({"resolved", "closed", "cancelled", "canceled"})


@dataclass(frozen=True, slots=True)
class IncidentItem:
    """Representa os dados de ``IncidentItem`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        incident_id: Identificador estável da entidade ou operação correspondente.
        number: Entrada ``number``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        opened_at: Instante UTC com fuso horário usado pela regra temporal.
        state: Estado imutável que será validado ou persistido.
        priority: Entrada ``priority``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        resolved_at: Instante UTC com fuso horário usado pela regra temporal.
        closed_at: Instante UTC com fuso horário usado pela regra temporal.
    """

    incident_id: str
    number: str | None
    opened_at: datetime
    state: str | None
    priority: str | None
    resolved_at: datetime | None
    closed_at: datetime | None


@dataclass(frozen=True, slots=True)
class IncidentView:
    """Representa os dados de ``IncidentView`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        incidents: Entrada ``incidents``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        is_current_pointer: Entrada ``is_current_pointer``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        coverage: Entrada ``coverage``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        input_watermarks: Entrada ``input_watermarks``; a forma aceita é definida pela anotação
        de tipo e validada antes do uso.
        projection_version: Versão imutável usada para identidade e compatibilidade.
        formula_version: Versão imutável usada para identidade e compatibilidade.
    """

    incidents: tuple[IncidentItem, ...]
    is_current_pointer: bool
    coverage: ProjectionCoverage
    input_watermarks: tuple[InputWatermark, ...]
    projection_version: str = PROJECTION_VERSION
    formula_version: str = FORMULA_VERSION


@dataclass(frozen=True, slots=True)
class IncidentViews:
    """Representa os dados de ``IncidentViews`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        day: Entrada ``day``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        active: Entrada ``active``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
    """

    day: IncidentView
    active: IncidentView


def _optional_text(value: object, field: str) -> str | None:
    """Converte texto quando presente e preserva a ausência como ``None``.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``str | None`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field} must be a non-empty string or null")
    return value


def _optional_datetime(value: object, field: str) -> datetime | None:
    """Converte datetime quando presente e preserva a ausência como ``None``.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``datetime | None`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if value is None:
        return None
    if not isinstance(value, datetime):
        raise ValueError(f"{field} must be a datetime or null")
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError(f"{field} must be an aware UTC datetime")
    return value


def incident_id(record: CanonicalRecord) -> str:
    """Calcula ou valida o identificador de incidente.

    Args:
        record: Registro canônico consumido pela operação.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    natural = dict(record.natural_key)
    value = natural.get("sys_id", natural.get("id"))
    if not isinstance(value, str) or not value:
        raise ValueError("incident natural key must identify sys_id")
    digest = hashlib.sha256(f"incident:v1:servicenow:{value}".encode()).digest()
    return "inc_" + base64.b32encode(digest).decode("ascii").lower()[:26]


def _item(record: CanonicalRecord) -> IncidentItem:
    """Executa a etapa interna ``item`` e devolve o resultado validado indicado pela assinatura.

    Args:
        record: Registro canônico consumido pela operação.

    Returns:
        Valor ``IncidentItem`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if record.observed_at is None:
        raise ValueError("incident must have opened_at as observed_at")
    return IncidentItem(
        incident_id(record),
        _optional_text(record.dimensions.get("number"), "number"),
        record.observed_at,
        _optional_text(record.dimensions.get("state"), "state"),
        _optional_text(record.dimensions.get("priority"), "priority"),
        _optional_datetime(record.measures.get("resolved_at"), "resolved_at"),
        _optional_datetime(record.measures.get("closed_at"), "closed_at"),
    )


def _is_active(item: IncidentItem) -> bool:
    """Informa se ativo satisfaz a condição esperada.

    Args:
        item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.
    """
    state = item.state.casefold() if item.state is not None else None
    return item.resolved_at is None and item.closed_at is None and state not in _TERMINAL_STATES


def build_incident_views(records: Iterable[CanonicalRecord]) -> IncidentViews:
    """Constrói incidente views a partir das entradas validadas.

    Args:
        records: Registros canônicos consumidos pela operação.

    Returns:
        Valor ``IncidentViews`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    source = records_tuple(records)
    if any(
        record.source_dataset != "incidents" or record.record_type is not RecordType.INCIDENT
        for record in source
    ):
        raise ValueError("incident views accept only incidents canonical facts")
    items = tuple(
        sorted((_item(record) for record in source), key=lambda x: (x.opened_at, x.incident_id))
    )
    evidence = coverage(source)
    marks = watermarks(source)
    day = IncidentView(items, False, evidence, marks)
    active_items = tuple(
        sorted(
            (item for item in items if _is_active(item)),
            key=lambda item: (item.priority or "", item.opened_at, item.incident_id),
        )
    )
    active = IncidentView(active_items, True, evidence, marks)
    return IncidentViews(day, active)


__all__ = [
    "IncidentItem",
    "IncidentView",
    "IncidentViews",
    "build_incident_views",
    "incident_id",
]
