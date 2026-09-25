"""Define janelas e registros canônicos imutáveis compartilhados pelas camadas.

Papel no fluxo:
    Este arquivo pertence ao núcleo de domínio e deve permanecer determinístico, sem acesso a
    rede, sistema de arquivos, banco de dados ou variáveis de ambiente.

Garantias e limites:
    As validações falham de forma fechada: valores ambíguos ou incompletos são rejeitados antes
    de atravessar uma porta de persistência.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from enum import StrEnum
from types import MappingProxyType
from typing import cast

type Scalar = str | int | float | bool | Decimal | datetime | None
type CanonicalValue = (
    Scalar | list["CanonicalValue"] | tuple["CanonicalValue", ...] | Mapping[str, "CanonicalValue"]
)


class RecordType(StrEnum):
    """Enumera os estados aceitos para registro type."""

    SIGNAL_OBSERVATION = "SignalObservation"
    DIMENSIONAL_METRIC_AGGREGATE = "DimensionalMetricAggregate"
    APPLICATION_ERROR_AGGREGATE = "ApplicationErrorAggregate"
    INCIDENT = "Incident"
    UPSTREAM_SOURCE_HEALTH = "UpstreamSourceHealth"
    UPSTREAM_COLLECTOR_RUN = "UpstreamCollectorRun"
    LIVE_EVENT_CONTEXT = "LiveEventContext"
    FINDING_STATUS_TRANSITION = "FindingStatusTransition"
    SHADOW_OBSERVATION = "ShadowObservation"


def _require_utc(value: datetime, field_name: str) -> None:
    """Valida e devolve utc, rejeitando entradas fora do contrato.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field_name: Nome validado do recurso, campo ou operação correspondente.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError(f"{field_name} must be an aware UTC datetime")


def _freeze(value: object) -> object:
    """Executa a etapa interna ``freeze`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``object`` produzido pela operação após as validações.
    """
    if isinstance(value, Mapping):
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, list | tuple):
        return tuple(_freeze(item) for item in value)
    return value


@dataclass(frozen=True, slots=True)
class TimeWindow:
    """Representa os dados de ``TimeWindow`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        start: Entrada ``start``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        end: Entrada ``end``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        grain_seconds: Duração ou prazo expresso em segundos.
    """

    start: datetime
    end: datetime
    grain_seconds: int

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        _require_utc(self.start, "window start")
        _require_utc(self.end, "window end")
        if self.end <= self.start:
            raise ValueError("window end must be after start")
        if self.grain_seconds <= 0:
            raise ValueError("window grain_seconds must be positive")

    @classmethod
    def from_epoch_ms(cls, start: int, end: int) -> TimeWindow:
        """Cria a instância a partir de época Unix ms previamente validado.

        Args:
            start: Entrada ``start``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            end: Entrada ``end``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Valor ``TimeWindow`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if end <= start:
            raise ValueError("window end must be after start")
        return cls(
            datetime.fromtimestamp(start / 1000, UTC),
            datetime.fromtimestamp(end / 1000, UTC),
            (end - start) // 1000,
        )


@dataclass(frozen=True, slots=True)
class CanonicalRecord:
    """Representa os dados de ``CanonicalRecord`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        schema_version: Versão imutável usada para identidade e compatibilidade.
        record_type: Entrada ``record_type``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        source_system: Entrada ``source_system``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        source_dataset: Entrada ``source_dataset``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        natural_key: Chave usada para identificar, consultar ou persistir o recurso.
        observed_at: Valor efetivamente observado que será comparado com a evidência esperada.
        window: Janela temporal UTC, fechada no início e aberta no fim.
        dimensions: Entrada ``dimensions``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        measures: Entrada ``measures``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        quality: Entrada ``quality``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        quality_flags: Entrada ``quality_flags``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
    """

    schema_version: str
    record_type: RecordType
    source_system: str
    source_dataset: str
    natural_key: tuple[tuple[str, Scalar], ...]
    observed_at: datetime | None
    window: TimeWindow | None
    dimensions: Mapping[str, CanonicalValue]
    measures: Mapping[str, CanonicalValue]
    quality: Mapping[str, Scalar]
    quality_flags: tuple[str, ...]

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if self.observed_at is not None:
            _require_utc(self.observed_at, "observed_at")
        elif self.window is not None:
            raise ValueError("window requires observed_at")
        object.__setattr__(
            self,
            "natural_key",
            tuple((key, cast(Scalar, _freeze(value))) for key, value in self.natural_key),
        )
        object.__setattr__(
            self,
            "dimensions",
            cast(Mapping[str, CanonicalValue], _freeze(self.dimensions)),
        )
        object.__setattr__(
            self,
            "measures",
            cast(Mapping[str, CanonicalValue], _freeze(self.measures)),
        )
        object.__setattr__(
            self,
            "quality",
            cast(Mapping[str, Scalar], _freeze(self.quality)),
        )
        object.__setattr__(self, "quality_flags", tuple(self.quality_flags))

    def with_measures(self, measures: Mapping[str, CanonicalValue]) -> CanonicalRecord:
        """Devolve uma cópia imutável da instância com medidas substituído.

        Args:
            measures: Entrada ``measures``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``CanonicalRecord`` produzido pela operação após as validações.
        """
        return replace(self, measures=measures)
