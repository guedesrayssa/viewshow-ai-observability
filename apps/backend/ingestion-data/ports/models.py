"""Define os valores imutáveis transportados através das portas da aplicação.

Papel no fluxo:
    Este módulo forma a fronteira tipada entre os casos de uso e seus adaptadores concretos.

Garantias e limites:
    Implementações devem preservar as invariantes descritas aqui, inclusive idempotência,
    controle de concorrência e imutabilidade dos valores transportados.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from enum import StrEnum
from math import isfinite
from pathlib import Path
from types import MappingProxyType
from typing import TypedDict, cast

from domain.canonical_json import canonical_bytes
from domain.models import TimeWindow
from domain.quality import CoverageStatus

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_OUTBOX_ENVELOPE_FIELDS = frozenset(
    {"datasetVersion", "eventId", "eventType", "idempotencyKey", "createdAt"}
)
_CANONICAL_PARTITION = re.compile(
    r"^(?:year=[0-9]{4}/month=[0-9]{2}/day=[0-9]{2}|snapshot_date=[0-9]{4}-[0-9]{2}-[0-9]{2})$"
)
_COMPACT_PROJECTION_DAY = re.compile(
    r"^DAY#(?P<year>[0-9]{4})(?P<month>[0-9]{2})(?P<day>[0-9]{2})$"
)
_ISO_PROJECTION_DAY = re.compile(r"^(?P<year>[0-9]{4})-(?P<month>[0-9]{2})-(?P<day>[0-9]{2})$")
_PROJECTION_KEY = re.compile(
    r"^(?:OVERVIEW#[^#\s]+|INCIDENTS#DAY|INCIDENTS#ACTIVE|"
    r"MONITORING#[^#\s]+|GEOGRAPHY#[^#\s]+)$"
)
_INCIDENT_ID = re.compile(r"^inc_[a-z2-7]{26}$")


class ArchiveState(StrEnum):
    """Enumera os estados aceitos para arquivo histórico estado."""

    STAGING = "STAGING"
    UPLOADED = "UPLOADED"
    CATALOGED = "CATALOGED"
    VALIDATED = "VALIDATED"
    AVAILABLE = "AVAILABLE"
    FAILED = "FAILED"


class ReconciliationCounts(TypedDict):
    """Descreve o formato fechado de ``ReconciliationCounts`` trocado entre as camadas.

    As chaves declaradas fazem parte do contrato de dados e não devem ser ampliadas
    implicitamente por adaptadores.

    Attributes:
        accepted: Entrada ``accepted``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        rejected: Entrada ``rejected``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        persisted: Entrada ``persisted``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
    """

    accepted: int
    rejected: int
    persisted: int


def _freeze(value: object) -> object:
    """Executa a etapa interna ``freeze`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``object`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise TypeError("mapping keys must be strings")
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, list | tuple):
        return tuple(_freeze(item) for item in value)
    if value is None:
        return value
    if isinstance(value, str | bool | int | bytes):
        if type(value) not in (str, bool, int, bytes):
            raise TypeError(f"unsupported canonical value type: {type(value).__name__}")
        return value
    if isinstance(value, Decimal):
        if type(value) is not Decimal:
            raise TypeError(f"unsupported canonical value type: {type(value).__name__}")
        if not value.is_finite():
            raise ValueError("canonical Decimal values must be finite")
        return value
    if isinstance(value, float):
        if type(value) is not float:
            raise TypeError(f"unsupported canonical value type: {type(value).__name__}")
        if not isfinite(value):
            raise ValueError("canonical float values must be finite")
        return value
    if isinstance(value, datetime):
        if type(value) is not datetime:
            raise TypeError(f"unsupported canonical value type: {type(value).__name__}")
        _require_utc(value, "canonical datetime")
        return value
    raise TypeError(f"unsupported canonical value type: {type(value).__name__}")


def _freeze_mapping(value: Mapping[str, object]) -> Mapping[str, object]:
    """Executa a etapa interna ``freeze_mapping`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``Mapping[str, object]`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    if not isinstance(value, Mapping):
        raise TypeError("value must be a mapping")
    return cast(Mapping[str, object], _freeze(value))


def _require_text(value: object, field: str) -> None:
    """Valida e devolve texto, rejeitando entradas fora do contrato.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    if not value:
        raise ValueError(f"{field} must not be empty")


def _require_key_component(value: object, field: str) -> None:
    """Valida e devolve chave component, rejeitando entradas fora do contrato.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    _require_text(value, field)
    assert isinstance(value, str)
    if "#" in value or any(character.isspace() for character in value):
        raise ValueError(f"{field} must not contain key delimiters or whitespace")


def _canonical_partition_day(partition: str, field: str) -> date:
    """Produz a representação canônica de partição dia.

    Args:
        partition: Identificador canônico da partição física ou lógica.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``date`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if _CANONICAL_PARTITION.fullmatch(partition) is None:
        raise ValueError(f"{field} must use the canonical layout")
    raw_day = (
        partition.removeprefix("snapshot_date=")
        if partition.startswith("snapshot_date=")
        else partition.replace("year=", "").replace("/month=", "-").replace("/day=", "-")
    )
    try:
        return date.fromisoformat(raw_day)
    except ValueError as error:
        raise ValueError(f"{field} must identify a real date") from error


def _projection_partition_day(partition_key: str) -> date:
    """Executa a etapa interna ``projection_partition_day`` e devolve o resultado validado
    indicado pela assinatura.

    Args:
        partition_key: Chave usada para identificar, consultar ou persistir o recurso.

    Returns:
        Valor ``date`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if _CANONICAL_PARTITION.fullmatch(partition_key) is not None:
        return _canonical_partition_day(partition_key, "partition_key")
    matched = _COMPACT_PROJECTION_DAY.fullmatch(partition_key) or _ISO_PROJECTION_DAY.fullmatch(
        partition_key
    )
    if matched is None:
        raise ValueError("partition_key must identify the projection day")
    try:
        return date(
            int(matched.group("year")),
            int(matched.group("month")),
            int(matched.group("day")),
        )
    except ValueError as error:
        raise ValueError("partition_key must identify a real projection day") from error


def _require_utc(value: object, field: str) -> None:
    """Valida e devolve utc, rejeitando entradas fora do contrato.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, datetime):
        raise TypeError(f"{field} must be a datetime")
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError(f"{field} must be an aware UTC datetime")


def _require_non_negative_int(value: object, field: str) -> None:
    """Valida e devolve non negative inteiro, rejeitando entradas fora do contrato.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field} must be an integer")
    if value < 0:
        raise ValueError(f"{field} must be non-negative")


def _require_sha256(value: object, field: str) -> None:
    """Valida e devolve sha256, rejeitando entradas fora do contrato.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    if _SHA256.fullmatch(value) is None:
        raise ValueError(f"{field} must be a lowercase SHA-256 hexadecimal digest")


@dataclass(frozen=True, slots=True)
class SourcePage:
    """Representa os dados de ``SourcePage`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        rows: Entrada ``rows``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        next_cursor: Entrada ``next_cursor``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
    """

    rows: tuple[Mapping[str, object], ...]
    next_cursor: tuple[object, ...] | None

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        object.__setattr__(self, "rows", tuple(_freeze_mapping(row) for row in self.rows))
        if self.next_cursor is not None:
            frozen_cursor = _freeze(self.next_cursor)
            object.__setattr__(self, "next_cursor", cast(tuple[object, ...], frozen_cursor))


@dataclass(frozen=True, slots=True)
class SchemaObservation:
    """Representa os dados de ``SchemaObservation`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        is_compatible: Entrada ``is_compatible``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        differences: Entrada ``differences``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
    """

    fingerprint: str
    is_compatible: bool
    differences: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        _require_sha256(self.fingerprint, "fingerprint")
        if not isinstance(self.is_compatible, bool):
            raise TypeError("is_compatible must be a boolean")
        if any(not isinstance(item, str) for item in self.differences):
            raise TypeError("differences must contain only strings")
        object.__setattr__(self, "differences", tuple(self.differences))


@dataclass(frozen=True, slots=True)
class CoverageObservation:
    """Representa os dados de ``CoverageObservation`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        status: Entrada ``status``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        row_count: Quantidade inteira não negativa usada na reconciliação.
        observed_window: Valor efetivamente observado que será comparado com a evidência
        esperada.
        coverage_numerator: Entrada ``coverage_numerator``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        coverage_denominator: Entrada ``coverage_denominator``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        latest_observed_at: Instante UTC com fuso horário usado pela regra temporal.
        verified_through: Entrada ``verified_through``; a forma aceita é definida pela anotação
        de tipo e validada antes do uso.
    """

    status: CoverageStatus
    row_count: int
    observed_window: TimeWindow | None
    coverage_numerator: int | None = None
    coverage_denominator: int | None = None
    latest_observed_at: datetime | None = None
    verified_through: datetime | None = None

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(self.status, CoverageStatus):
            raise TypeError("status must be a CoverageStatus")
        _require_non_negative_int(self.row_count, "row_count")
        if self.observed_window is not None and not isinstance(self.observed_window, TimeWindow):
            raise TypeError("observed_window must be a TimeWindow or None")
        if (self.coverage_numerator is None) != (self.coverage_denominator is None):
            raise ValueError("coverage numerator and denominator must be provided together")
        if self.coverage_numerator is not None:
            _require_non_negative_int(self.coverage_numerator, "coverage_numerator")
            _require_non_negative_int(self.coverage_denominator, "coverage_denominator")
            assert self.coverage_denominator is not None
            if self.coverage_denominator == 0:
                raise ValueError("coverage_denominator must be positive")
            if self.coverage_numerator > self.coverage_denominator:
                raise ValueError("coverage_numerator cannot exceed coverage_denominator")
        for name in ("latest_observed_at", "verified_through"):
            value = getattr(self, name)
            if value is not None:
                _require_utc(value, name)


@dataclass(frozen=True, slots=True)
class RestoreRequest:
    """Representa os dados de ``RestoreRequest`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        bucket: Nome do bucket S3 autorizado para a operação.
        key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        version_id: Identificador estável da entidade ou operação correspondente.
        expected_sha256: Valor esperado usado para detectar concorrência ou divergência de
        estado.
    """

    bucket: str
    key: str
    version_id: str
    expected_sha256: str

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        for name in ("bucket", "key", "version_id"):
            _require_text(getattr(self, name), name)
        _require_sha256(self.expected_sha256, "expected_sha256")


@dataclass(frozen=True, slots=True)
class RestoreResult:
    """Representa os dados de ``RestoreResult`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        compressed_sha256: Entrada ``compressed_sha256``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        compressed_bytes: Quantidade de bytes usada como tamanho ou limite.
    """

    compressed_sha256: str
    compressed_bytes: int

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        _require_sha256(self.compressed_sha256, "compressed_sha256")
        _require_non_negative_int(self.compressed_bytes, "compressed_bytes")


@dataclass(frozen=True, slots=True)
class WriteResult:
    """Representa os dados de ``WriteResult`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        written: Entrada ``written``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        unchanged: Entrada ``unchanged``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
    """

    written: int
    unchanged: int

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        _require_non_negative_int(self.written, "written")
        _require_non_negative_int(self.unchanged, "unchanged")


@dataclass(frozen=True, slots=True)
class Lease:
    """Representa os dados de ``Lease`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        source: Identificador da fonte de dados processada.
        owner: Identidade do worker que possui ou solicita o lease.
        expires_at: Instante UTC com fuso horário usado pela regra temporal.
    """

    source: str
    owner: str
    expires_at: datetime

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        _require_text(self.source, "source")
        _require_text(self.owner, "owner")
        _require_utc(self.expires_at, "expires_at")


@dataclass(frozen=True, slots=True)
class CandidateManifest:
    """Representa os dados de ``CandidateManifest`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        dataset_version: Identificador imutável da versão do dataset.
        metadata: Metadados associados ao registro ou à transição.
    """

    dataset_version: str
    metadata: Mapping[str, object]

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        _require_text(self.dataset_version, "dataset_version")
        object.__setattr__(self, "metadata", _freeze_mapping(self.metadata))


@dataclass(frozen=True, slots=True)
class ArchiveDependency:
    """Representa os dados de ``ArchiveDependency`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        dataset: Nome do dataset permitido pelo registro de contratos.
        partition: Identificador canônico da partição física ou lógica.
    """

    dataset: str
    partition: str

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        _require_key_component(self.dataset, "dependency dataset")
        _require_text(self.partition, "dependency partition")
        _canonical_partition_day(self.partition, "dependency partition")

    @property
    def physical_identity(self) -> tuple[str, date]:
        """Executa a etapa interna ``physical_identity`` e devolve o resultado validado indicado
        pela assinatura.

        Returns:
            Valor ``tuple[str, date]`` produzido pela operação após as validações.
        """
        return self.dataset, _canonical_partition_day(self.partition, "dependency partition")


class OverviewProjectionPayload(TypedDict):
    """Descreve o formato fechado de ``OverviewProjectionPayload`` trocado entre as camadas.

    As chaves declaradas fazem parte do contrato de dados e não devem ser ampliadas
    implicitamente por adaptadores.

    Attributes:
        projectionVersion: Entrada ``projectionVersion``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        formulaVersion: Entrada ``formulaVersion``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        inputWatermarks: Entrada ``inputWatermarks``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        observedThrough: Entrada ``observedThrough``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        coverage: Entrada ``coverage``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        qualityFlags: Entrada ``qualityFlags``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.
        metrics: Porta de métricas que recebe observações de baixa cardinalidade.
    """

    projectionVersion: str
    formulaVersion: str
    inputWatermarks: Mapping[str, datetime]
    observedThrough: datetime
    coverage: str
    qualityFlags: tuple[str, ...]
    metrics: Mapping[str, int | Decimal | None]


class IncidentProjectionPayload(TypedDict):
    """Descreve o formato fechado de ``IncidentProjectionPayload`` trocado entre as camadas.

    As chaves declaradas fazem parte do contrato de dados e não devem ser ampliadas
    implicitamente por adaptadores.

    Attributes:
        projectionVersion: Entrada ``projectionVersion``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        formulaVersion: Entrada ``formulaVersion``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        inputWatermarks: Entrada ``inputWatermarks``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        observedThrough: Entrada ``observedThrough``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        coverage: Entrada ``coverage``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        qualityFlags: Entrada ``qualityFlags``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.
        incidentId: Entrada ``incidentId``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        number: Entrada ``number``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        openedAt: Entrada ``openedAt``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        state: Estado imutável que será validado ou persistido.
        priority: Entrada ``priority``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        resolvedAt: Entrada ``resolvedAt``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        closedAt: Entrada ``closedAt``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
    """

    projectionVersion: str
    formulaVersion: str
    inputWatermarks: Mapping[str, datetime]
    observedThrough: datetime
    coverage: str
    qualityFlags: tuple[str, ...]
    incidentId: str
    number: str | None
    openedAt: datetime
    state: str | None
    priority: str | None
    resolvedAt: datetime | None
    closedAt: datetime | None


class ActiveIncidentPayload(TypedDict):
    """Descreve o formato fechado de ``ActiveIncidentPayload`` trocado entre as camadas.

    As chaves declaradas fazem parte do contrato de dados e não devem ser ampliadas
    implicitamente por adaptadores.

    Attributes:
        incidentId: Entrada ``incidentId``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        number: Entrada ``number``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        openedAt: Entrada ``openedAt``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        state: Estado imutável que será validado ou persistido.
        priority: Entrada ``priority``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
    """

    incidentId: str
    number: str | None
    openedAt: datetime
    state: str | None
    priority: str | None


class ActiveIncidentsProjectionPayload(TypedDict):
    """Descreve o formato fechado de ``ActiveIncidentsProjectionPayload`` trocado entre as
    camadas.

    As chaves declaradas fazem parte do contrato de dados e não devem ser ampliadas
    implicitamente por adaptadores.

    Attributes:
        projectionVersion: Entrada ``projectionVersion``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        formulaVersion: Entrada ``formulaVersion``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        inputWatermarks: Entrada ``inputWatermarks``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        observedThrough: Entrada ``observedThrough``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        coverage: Entrada ``coverage``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        qualityFlags: Entrada ``qualityFlags``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.
        incidents: Entrada ``incidents``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
    """

    projectionVersion: str
    formulaVersion: str
    inputWatermarks: Mapping[str, datetime]
    observedThrough: datetime
    coverage: str
    qualityFlags: tuple[str, ...]
    incidents: tuple[ActiveIncidentPayload, ...]


class MonitoringProjectionPayload(TypedDict):
    """Descreve o formato fechado de ``MonitoringProjectionPayload`` trocado entre as camadas.

    As chaves declaradas fazem parte do contrato de dados e não devem ser ampliadas
    implicitamente por adaptadores.

    Attributes:
        projectionVersion: Entrada ``projectionVersion``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        formulaVersion: Entrada ``formulaVersion``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        inputWatermarks: Entrada ``inputWatermarks``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        observedThrough: Entrada ``observedThrough``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        coverage: Entrada ``coverage``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        qualityFlags: Entrada ``qualityFlags``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.
        source: Identificador da fonte de dados processada.
        observedAt: Entrada ``observedAt``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        finishedAt: Entrada ``finishedAt``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        rowsProcessed: Entrada ``rowsProcessed``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        durationSeconds: Entrada ``durationSeconds``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
    """

    projectionVersion: str
    formulaVersion: str
    inputWatermarks: Mapping[str, datetime]
    observedThrough: datetime
    coverage: str
    qualityFlags: tuple[str, ...]
    source: str
    observedAt: datetime
    finishedAt: datetime | None
    rowsProcessed: int | Decimal | None
    durationSeconds: int | Decimal | None


class GeographyProjectionPayload(TypedDict):
    """Descreve o formato fechado de ``GeographyProjectionPayload`` trocado entre as camadas.

    As chaves declaradas fazem parte do contrato de dados e não devem ser ampliadas
    implicitamente por adaptadores.

    Attributes:
        projectionVersion: Entrada ``projectionVersion``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        formulaVersion: Entrada ``formulaVersion``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        inputWatermarks: Entrada ``inputWatermarks``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        observedThrough: Entrada ``observedThrough``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        coverage: Entrada ``coverage``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        qualityFlags: Entrada ``qualityFlags``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.
        dimensionId: Entrada ``dimensionId``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        state: Estado imutável que será validado ou persistido.
        isp: Entrada ``isp``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        sessions: Entrada ``sessions``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        errors: Entrada ``errors``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        errorRate: Entrada ``errorRate``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        metric: Entrada ``metric``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
    """

    projectionVersion: str
    formulaVersion: str
    inputWatermarks: Mapping[str, datetime]
    observedThrough: datetime
    coverage: str
    qualityFlags: tuple[str, ...]
    dimensionId: str
    state: str
    isp: str
    sessions: int | Decimal
    errors: int | Decimal
    errorRate: int | Decimal | None
    metric: str


type ProjectionPayload = (
    OverviewProjectionPayload
    | IncidentProjectionPayload
    | ActiveIncidentsProjectionPayload
    | MonitoringProjectionPayload
    | GeographyProjectionPayload
)


_PROJECTION_COMMON_FIELDS = {
    "projectionVersion",
    "formulaVersion",
    "inputWatermarks",
    "observedThrough",
    "coverage",
    "qualityFlags",
}
_OVERVIEW_FIELDS = _PROJECTION_COMMON_FIELDS | {"metrics"}
_INCIDENT_FIELDS = _PROJECTION_COMMON_FIELDS | {
    "incidentId",
    "number",
    "openedAt",
    "state",
    "priority",
    "resolvedAt",
    "closedAt",
}
_ACTIVE_INCIDENTS_FIELDS = _PROJECTION_COMMON_FIELDS | {"incidents"}
_MONITORING_FIELDS = _PROJECTION_COMMON_FIELDS | {
    "source",
    "observedAt",
    "finishedAt",
    "rowsProcessed",
    "durationSeconds",
}
_GEOGRAPHY_FIELDS = _PROJECTION_COMMON_FIELDS | {
    "dimensionId",
    "state",
    "isp",
    "sessions",
    "errors",
    "errorRate",
    "metric",
}
_OVERVIEW_METRICS = {
    "sessions",
    "errors",
    "startupErrors",
    "botErrors",
    "humanErrors",
    "errorRate",
}
_TERMINAL_INCIDENT_STATES = frozenset({"resolved", "closed", "cancelled", "canceled"})


def _projection_number(value: object, field: str, *, nullable: bool = True) -> None:
    """Executa a etapa interna ``projection_number`` e valida seus efeitos antes de concluir.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.
        nullable: Entrada ``nullable``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if value is None and nullable:
        return
    if isinstance(value, bool) or not isinstance(value, int | Decimal):
        raise TypeError(f"projection payload {field} must be numeric or null")
    if isinstance(value, Decimal) and not value.is_finite():
        raise ValueError(f"projection payload {field} must be finite")
    if value < 0:
        raise ValueError(f"projection payload {field} must be non-negative")


def _projection_optional_text(value: object, field: str, *, nullable: bool = True) -> None:
    """Converte projeção optional para sua representação textual canônica.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.
        nullable: Entrada ``nullable``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if value is None and nullable:
        return
    if not isinstance(value, str) or not value:
        raise ValueError(f"projection payload {field} must be non-empty text or null")


def _projection_ratio(numerator: object, denominator: object) -> int | Decimal | None:
    """Executa a etapa interna ``projection_ratio`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        numerator: Entrada ``numerator``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        denominator: Entrada ``denominator``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``int | Decimal | None`` produzido pela operação após as validações.
    """
    if numerator is None or denominator is None or denominator == 0:
        return None
    assert isinstance(numerator, int | Decimal)
    assert isinstance(denominator, int | Decimal)
    return Decimal(numerator) / Decimal(denominator)


def _validate_active_incidents(value: object) -> None:
    """Valida ativo incidentes contra as invariantes deste módulo.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, tuple):
        raise TypeError("projection payload incidents must be a tuple")
    normalized_order: list[tuple[str, datetime, str]] = []
    incident_ids: set[str] = set()
    expected_fields = {"incidentId", "number", "openedAt", "state", "priority"}
    for item in value:
        if not isinstance(item, Mapping) or set(item) != expected_fields:
            raise ValueError("projection payload active incident has an invalid shape")
        incident_id = item.get("incidentId")
        if not isinstance(incident_id, str) or _INCIDENT_ID.fullmatch(incident_id) is None:
            raise ValueError("projection payload active incidentId is invalid")
        if incident_id in incident_ids:
            raise ValueError("projection payload active incidents must be unique")
        incident_ids.add(incident_id)
        _projection_optional_text(item.get("number"), "active incident number")
        _projection_optional_text(item.get("state"), "active incident state")
        state = item.get("state")
        if isinstance(state, str) and state.casefold() in _TERMINAL_INCIDENT_STATES:
            raise ValueError("projection payload active incident has a terminal state")
        _projection_optional_text(item.get("priority"), "active incident priority")
        raw_priority = item.get("priority")
        if isinstance(raw_priority, str) and (
            "#" in raw_priority or any(character.isspace() for character in raw_priority)
        ):
            raise ValueError("projection payload active priority is not a safe key component")
        opened_at = item.get("openedAt")
        _require_utc(opened_at, "projection payload active incident openedAt")
        normalized_order.append((raw_priority or "", cast(datetime, opened_at), incident_id))
    if normalized_order != sorted(normalized_order):
        raise ValueError("projection payload active incidents must be canonically ordered")


def _validate_projection_payload(projection: Projection) -> None:
    """Valida projeção payload contra as invariantes deste módulo.

    Args:
        projection: Entrada ``projection``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    payload = projection.payload
    if _PROJECTION_KEY.fullmatch(projection.key) is None:
        raise ValueError("projection key is not a supported operational view")
    if projection.projection_version != "1.0":
        raise ValueError("projection_version must be 1.0")
    expected_fields = (
        _OVERVIEW_FIELDS
        if projection.key.startswith("OVERVIEW#")
        else _ACTIVE_INCIDENTS_FIELDS
        if projection.key == "INCIDENTS#ACTIVE"
        else _INCIDENT_FIELDS
        if projection.key == "INCIDENTS#DAY"
        else _MONITORING_FIELDS
        if projection.key.startswith("MONITORING#")
        else _GEOGRAPHY_FIELDS
    )
    if set(payload) != expected_fields:
        raise ValueError("projection payload has an invalid shape")
    if payload.get("projectionVersion") != projection.projection_version:
        raise ValueError("projection payload projectionVersion differs from projection_version")
    if payload.get("formulaVersion") != "1.0":
        raise ValueError("projection payload formulaVersion must be 1.0")
    watermarks = payload.get("inputWatermarks")
    if not isinstance(watermarks, Mapping) or not watermarks or len(watermarks) > 48:
        raise ValueError("projection payload inputWatermarks must contain 1 to 48 datasets")
    if any(not isinstance(dataset, str) or not dataset for dataset in watermarks):
        raise TypeError("projection payload inputWatermarks keys must be non-empty text")
    for watermark in watermarks.values():
        _require_utc(watermark, "projection payload inputWatermark")
    dependency_datasets = {item.dataset for item in projection.required_archives}
    if set(watermarks) != dependency_datasets:
        raise ValueError("projection payload inputWatermarks differ from required archives")
    observed_through = payload.get("observedThrough")
    _require_utc(observed_through, "projection payload observedThrough")
    projection_day = _projection_partition_day(projection.partition_key)
    if cast(datetime, observed_through).date() != projection_day:
        raise ValueError("projection payload observedThrough must belong to the partition day")
    if observed_through != max(cast(Mapping[str, datetime], watermarks).values()):
        raise ValueError("projection payload observedThrough must equal the latest input watermark")
    if payload.get("coverage") not in {item.value for item in CoverageStatus}:
        raise ValueError("projection payload coverage is invalid")
    flags = payload.get("qualityFlags")
    if (
        not isinstance(flags, tuple)
        or any(not isinstance(flag, str) or not flag for flag in flags)
        or flags != tuple(sorted(set(flags)))
        or len(flags) > 64
    ):
        raise ValueError("projection payload qualityFlags must be unique and ordered")

    if projection.key.startswith("OVERVIEW#"):
        metrics = payload.get("metrics")
        if not isinstance(metrics, Mapping) or set(metrics) != _OVERVIEW_METRICS:
            raise ValueError("projection payload metrics has an invalid shape")
        for field, value in metrics.items():
            _projection_number(value, f"metrics.{field}")
        expected_rate = _projection_ratio(metrics.get("errors"), metrics.get("sessions"))
        if metrics.get("errorRate") != expected_rate:
            raise ValueError("projection payload metrics.errorRate is inconsistent with counts")
        return
    if projection.key == "INCIDENTS#ACTIVE":
        _validate_active_incidents(payload.get("incidents"))
        return
    if projection.key == "INCIDENTS#DAY":
        incident_id = payload.get("incidentId")
        if not isinstance(incident_id, str) or _INCIDENT_ID.fullmatch(incident_id) is None:
            raise ValueError("projection payload incidentId is invalid")
        for field in ("number", "state"):
            _projection_optional_text(payload.get(field), field)
        _projection_optional_text(payload.get("priority"), "priority")
        opened_at = payload.get("openedAt")
        _require_utc(opened_at, "projection payload openedAt")
        if cast(datetime, opened_at).date() != projection_day:
            raise ValueError("projection payload openedAt must belong to the partition day")
        resolved_at = payload.get("resolvedAt")
        closed_at = payload.get("closedAt")
        for field, value in (("resolvedAt", resolved_at), ("closedAt", closed_at)):
            if value is not None:
                _require_utc(value, f"projection payload {field}")
                if cast(datetime, value) < cast(datetime, opened_at):
                    raise ValueError(f"projection payload {field} must not precede openedAt")
        if (
            resolved_at is not None
            and closed_at is not None
            and cast(datetime, closed_at) < cast(datetime, resolved_at)
        ):
            raise ValueError("projection payload closedAt must not precede resolvedAt")
        return
    if projection.key.startswith("MONITORING#"):
        source = projection.key.removeprefix("MONITORING#")
        if payload.get("source") != source:
            raise ValueError("projection payload source differs from projection key")
        _require_utc(payload.get("observedAt"), "projection payload observedAt")
        if payload.get("finishedAt") is not None:
            _require_utc(payload.get("finishedAt"), "projection payload finishedAt")
        _projection_number(payload.get("rowsProcessed"), "rowsProcessed")
        _projection_number(payload.get("durationSeconds"), "durationSeconds")
        return
    metric = projection.key.removeprefix("GEOGRAPHY#")
    if payload.get("metric") != metric:
        raise ValueError("projection payload metric differs from projection key")
    for field in ("dimensionId", "state", "isp"):
        _projection_optional_text(payload.get(field), field, nullable=False)
        assert isinstance(payload.get(field), str)
        if field == "dimensionId" and (
            "#" in cast(str, payload.get(field))
            or any(character.isspace() for character in cast(str, payload.get(field)))
        ):
            raise ValueError(f"projection payload {field} must not contain a key delimiter")
    for field in ("sessions", "errors"):
        _projection_number(payload.get(field), field, nullable=False)
    _projection_number(payload.get("errorRate"), "errorRate")
    expected_rate = _projection_ratio(payload.get("errors"), payload.get("sessions"))
    if payload.get("errorRate") != expected_rate:
        raise ValueError("projection payload errorRate is inconsistent with counts")


def _epoch_milliseconds(value: datetime) -> int:
    """Executa a etapa interna ``epoch_milliseconds`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``int`` produzido pela operação após as validações.
    """
    _require_utc(value, "projection timestamp")
    delta = value - datetime(1970, 1, 1, tzinfo=value.tzinfo)
    return delta.days * 86_400_000 + delta.seconds * 1_000 + delta.microseconds // 1_000


@dataclass(frozen=True, slots=True)
class Projection:
    """Representa os dados de ``Projection`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        dataset_version: Identificador imutável da versão do dataset.
        partition_key: Chave usada para identificar, consultar ou persistir o recurso.
        key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        projection_version: Versão imutável usada para identidade e compatibilidade.
        required_archives: Entrada ``required_archives``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        payload: Entrada ``payload``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
    """

    dataset_version: str
    partition_key: str
    key: str
    projection_version: str
    required_archives: tuple[ArchiveDependency, ...]
    payload: Mapping[str, object]

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        _require_text(self.dataset_version, "dataset_version")
        _require_text(self.partition_key, "partition_key")
        _require_text(self.key, "key")
        _require_text(self.projection_version, "projection_version")
        if not isinstance(self.required_archives, tuple) or any(
            not isinstance(item, ArchiveDependency) for item in self.required_archives
        ):
            raise TypeError("required_archives must be a tuple of ArchiveDependency")
        if not self.required_archives:
            raise ValueError("required_archives must not be empty")
        if len(self.required_archives) > 47:
            raise ValueError("required_archives exceeds the safe transactional limit of 47")
        identities = tuple(item.physical_identity for item in self.required_archives)
        if identities != tuple(sorted(identities)) or len(set(identities)) != len(identities):
            raise ValueError("required_archives must be physically unique and canonically ordered")
        projection_day = _projection_partition_day(self.partition_key)
        if any(
            _canonical_partition_day(item.partition, "dependency partition") != projection_day
            for item in self.required_archives
        ):
            raise ValueError("required_archives must belong to the projection day")
        _validate_projection_payload(self)
        object.__setattr__(self, "payload", _freeze_mapping(self.payload))

    @property
    def materialization_revision(self) -> str:
        """Executa a etapa interna ``materialization_revision`` e devolve o resultado validado
        indicado pela assinatura.

        Returns:
            Valor ``str`` produzido pela operação após as validações.
        """
        digest = hashlib.sha256(
            canonical_bytes(
                {
                    "datasetVersion": self.dataset_version,
                    "partitionKey": self.partition_key,
                    "key": self.key,
                    "projectionVersion": self.projection_version,
                    "requiredArchives": [
                        {"dataset": item.dataset, "partition": item.partition}
                        for item in self.required_archives
                    ],
                    "payload": self.payload,
                }
            )
        ).hexdigest()
        return "pmr_" + digest

    @property
    def operational_sort_key(self) -> str:
        """Monta a chave de operational sort a partir de componentes validados.

        Returns:
            Valor ``str`` produzido pela operação após as validações.
        """
        observed_through = cast(datetime, self.payload["observedThrough"])
        timestamp = _epoch_milliseconds(observed_through)
        if self.key.startswith("OVERVIEW#") or self.key.startswith("MONITORING#"):
            return f"T#{timestamp}"
        if self.key == "INCIDENTS#DAY":
            opened_at = cast(datetime, self.payload["openedAt"])
            return (
                f"OPENED#{_epoch_milliseconds(opened_at)}#{cast(str, self.payload['incidentId'])}"
            )
        if self.key == "INCIDENTS#ACTIVE":
            return "CURRENT"
        return f"T#{timestamp}#{cast(str, self.payload['dimensionId'])}"


@dataclass(frozen=True, slots=True)
class CurrentProjection:
    """Mantém a evidência durável mínima para atualizar uma projeção com CAS.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        payload: Entrada ``payload``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        materialization_revision: Entrada ``materialization_revision``; a forma aceita é
        definida pela anotação de tipo e validada antes do uso.
        required_archives: Entrada ``required_archives``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
    """

    payload: Mapping[str, object]
    materialization_revision: str
    required_archives: tuple[ArchiveDependency, ...]

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        if not isinstance(self.materialization_revision, str) or not re.fullmatch(
            r"pmr_[0-9a-f]{64}", self.materialization_revision
        ):
            raise ValueError("materialization_revision must be a pmr SHA-256 identifier")
        if not isinstance(self.required_archives, tuple) or any(
            not isinstance(item, ArchiveDependency) for item in self.required_archives
        ):
            raise TypeError("required_archives must be a tuple of ArchiveDependency")
        object.__setattr__(self, "payload", _freeze_mapping(self.payload))


@dataclass(frozen=True, slots=True)
class EventProjectionItem:
    """One deterministic Event/Evidence item written below a candidate dataset namespace."""

    dataset_version: str
    pk: str
    sk: str
    entity_type: str
    payload: Mapping[str, object]

    def __post_init__(self) -> None:
        _require_key_component(self.dataset_version, "dataset_version")
        _require_text(self.pk, "pk")
        _require_text(self.sk, "sk")
        _require_text(self.entity_type, "entity_type")
        if not self.pk.startswith(f"DATASET#{self.dataset_version}#"):
            raise ValueError("event projection pk must belong to dataset_version")
        if self.entity_type not in {
            "EVENT",
            "EVENT_LOOKUP",
            "INCIDENT_EVENT",
            "EVIDENCE",
            "EVENT_PROJECTION_SUMMARY",
        }:
            raise ValueError("event projection entity_type is unsupported")
        object.__setattr__(self, "payload", _freeze_mapping(self.payload))

    @property
    def materialization_revision(self) -> str:
        return (
            "pmr_"
            + hashlib.sha256(
                canonical_bytes(
                    {
                        "datasetVersion": self.dataset_version,
                        "pk": self.pk,
                        "sk": self.sk,
                        "entityType": self.entity_type,
                        "payload": self.payload,
                    }
                )
            ).hexdigest()
        )


@dataclass(frozen=True, slots=True)
class EncodedPartition:
    """Representa os dados de ``EncodedPartition`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        path: Caminho local do artefato lido ou produzido.
        row_count: Quantidade inteira não negativa usada na reconciliação.
        byte_size: Entrada ``byte_size``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        sha256: Entrada ``sha256``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        dataset: Nome do dataset permitido pelo registro de contratos.
        dataset_version: Identificador imutável da versão do dataset.
        schema_version: Versão imutável usada para identidade e compatibilidade.
        schema_fingerprint: Entrada ``schema_fingerprint``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
    """

    path: Path
    row_count: int
    byte_size: int
    sha256: str
    dataset: str | None = None
    dataset_version: str | None = None
    schema_version: str | None = None
    schema_fingerprint: str | None = None

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        if not isinstance(self.path, Path):
            raise TypeError("path must be a Path")
        _require_non_negative_int(self.row_count, "row_count")
        _require_non_negative_int(self.byte_size, "byte_size")
        _require_sha256(self.sha256, "sha256")
        for name in ("dataset", "dataset_version", "schema_version"):
            value = getattr(self, name)
            if value is not None:
                _require_text(value, name)
        if self.schema_fingerprint is not None:
            _require_sha256(self.schema_fingerprint, "schema_fingerprint")


@dataclass(frozen=True, slots=True)
class ArchiveObject:
    """Representa os dados de ``ArchiveObject`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        sha256: Entrada ``sha256``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        size: Entrada ``size``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        version_id: Identificador estável da entidade ou operação correspondente.
        etag: Entrada ``etag``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
    """

    key: str
    sha256: str
    size: int
    version_id: str | None = None
    etag: str | None = None

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        _require_text(self.key, "key")
        _require_sha256(self.sha256, "sha256")
        _require_non_negative_int(self.size, "size")
        for name in ("version_id", "etag"):
            value = getattr(self, name)
            if value is not None:
                _require_text(value, name)


@dataclass(frozen=True, slots=True)
class ArchivePartition:
    """Representa os dados de ``ArchivePartition`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        dataset_version: Identificador imutável da versão do dataset.
        dataset: Nome do dataset permitido pelo registro de contratos.
        partition: Identificador canônico da partição física ou lógica.
        state: Estado imutável que será validado ou persistido.
        metadata: Metadados associados ao registro ou à transição.
    """

    dataset_version: str
    dataset: str
    partition: str
    state: ArchiveState
    metadata: Mapping[str, object]

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        for name in ("dataset_version", "dataset", "partition"):
            _require_text(getattr(self, name), name)
        if not isinstance(self.state, ArchiveState):
            raise TypeError("state must be an ArchiveState")
        object.__setattr__(self, "metadata", _freeze_mapping(self.metadata))


@dataclass(frozen=True, slots=True)
class OutboxEvent:
    """Representa os dados de ``OutboxEvent`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        event_id: Identificador estável da entidade ou operação correspondente.
        dataset_version: Identificador imutável da versão do dataset.
        event_type: Entrada ``event_type``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        idempotency_key: Chave estável que identifica uma repetição da mesma operação.
        created_at: Instante UTC com fuso horário usado pela regra temporal.
        payload: Entrada ``payload``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
    """

    event_id: str
    dataset_version: str
    event_type: str
    idempotency_key: str
    created_at: datetime
    payload: Mapping[str, object]

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        for name in ("event_id", "dataset_version", "event_type", "idempotency_key"):
            _require_text(getattr(self, name), name)
        _require_utc(self.created_at, "created_at")
        reserved = _OUTBOX_ENVELOPE_FIELDS.intersection(self.payload)
        if reserved:
            raise ValueError(f"payload contains reserved envelope fields: {sorted(reserved)}")
        object.__setattr__(self, "payload", _freeze_mapping(self.payload))


@dataclass(frozen=True, slots=True)
class OutboxBacklog:
    """Representa uma fotografia eventualmente consistente da fila pendente.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        pending_count: Quantidade inteira não negativa usada na reconciliação.
        oldest_created_at: Instante UTC com fuso horário usado pela regra temporal.
    """

    pending_count: int
    oldest_created_at: datetime | None

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        _require_non_negative_int(self.pending_count, "pending_count")
        if self.oldest_created_at is not None:
            _require_utc(self.oldest_created_at, "oldest_created_at")
        if (self.pending_count == 0) != (self.oldest_created_at is None):
            raise ValueError("oldest_created_at must be present exactly when backlog is non-empty")


@dataclass(frozen=True, slots=True)
class PublishReceipt:
    """Representa os dados de ``PublishReceipt`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        message_id: Identificador estável da entidade ou operação correspondente.
    """

    message_id: str

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        _require_text(self.message_id, "message_id")


__all__ = [
    "ActiveIncidentPayload",
    "ActiveIncidentsProjectionPayload",
    "ArchiveDependency",
    "ArchiveObject",
    "ArchivePartition",
    "ArchiveState",
    "CandidateManifest",
    "CoverageObservation",
    "CurrentProjection",
    "EncodedPartition",
    "GeographyProjectionPayload",
    "IncidentProjectionPayload",
    "Lease",
    "MonitoringProjectionPayload",
    "OutboxEvent",
    "OutboxBacklog",
    "OverviewProjectionPayload",
    "Projection",
    "ProjectionPayload",
    "PublishReceipt",
    "RestoreRequest",
    "RestoreResult",
    "SchemaObservation",
    "SourcePage",
    "WriteResult",
]
