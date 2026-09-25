"""Representa o contrato físico versionado de cada tabela permitida.

Papel no fluxo:
    Este arquivo pertence ao núcleo de domínio e deve permanecer determinístico, sem acesso a
    rede, sistema de arquivos, banco de dados ou variáveis de ambiente.

Garantias e limites:
    As validações falham de forma fechada: valores ambíguos ou incompletos são rejeitados antes
    de atravessar uma porta de persistência.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import NamedTuple, cast

from domain.models import RecordType

_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_INGESTION_MODES = frozenset({"backfill", "sync"})


class DatasetColumn(NamedTuple):
    """Representa ``DatasetColumn`` como um valor posicional imutável.

    Os campos formam parte do contrato e mantêm ordem estável durante comparações.

    Attributes:
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        sql_type: Entrada ``sql_type``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        nullable: Entrada ``nullable``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
    """

    name: str
    sql_type: str
    nullable: bool

    def as_contract(self) -> tuple[str, str, bool]:
        """Representa a instância como contrato.

        Returns:
            Valor ``tuple[str, str, bool]`` produzido pela operação após as validações.
        """
        return (self.name, self.sql_type, self.nullable)


@dataclass(frozen=True, slots=True)
class DatasetDescriptor:
    """Representa os dados de ``DatasetDescriptor`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        table: Nome da tabela previamente autorizado pelo contrato.
        record_type: Entrada ``record_type``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        columns: Entrada ``columns``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        natural_key: Chave usada para identificar, consultar ou persistir o recurso.
        cursor_key: Chave usada para identificar, consultar ou persistir o recurso.
        timestamp_field: Entrada ``timestamp_field``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        grain_seconds: Duração ou prazo expresso em segundos.
        retention: Entrada ``retention``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        coverage_policy: Entrada ``coverage_policy``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        required_modes: Entrada ``required_modes``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        archive_partition: Entrada ``archive_partition``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        normalizer: Entrada ``normalizer``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
    """

    table: str
    record_type: RecordType
    columns: tuple[DatasetColumn, ...]
    natural_key: tuple[str, ...]
    cursor_key: tuple[str, ...]
    timestamp_field: str | None
    grain_seconds: int | None
    retention: Mapping[str, int | None]
    coverage_policy: str
    required_modes: tuple[str, ...]
    archive_partition: Mapping[str, str | None]
    normalizer: str

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not _IDENTIFIER.fullmatch(self.table):
            raise ValueError("table must be a valid SQL identifier")
        if not self.columns:
            raise ValueError("descriptor must declare columns")
        column_names = tuple(column.name for column in self.columns)
        if len(set(column_names)) != len(column_names):
            raise ValueError(f"descriptor {self.table!r} declares a column twice")
        for key_name, key in (("natural_key", self.natural_key), ("cursor_key", self.cursor_key)):
            if not key:
                raise ValueError(f"{key_name} cannot be empty")
            if len(set(key)) != len(key):
                raise ValueError(f"{key_name} cannot contain duplicates")
            if any(part not in column_names for part in key):
                raise ValueError(f"{key_name} references a column not declared by {self.table!r}")
        nullable_by_name = {column.name: column.nullable for column in self.columns}
        if any(nullable_by_name[part] for part in self.natural_key):
            raise ValueError("natural_key cannot reference a nullable column")
        if self.timestamp_field is not None and self.timestamp_field not in column_names:
            raise ValueError("timestamp_field must reference a declared column")
        archive_strategy = self.archive_partition.get("strategy")
        archive_field = self.archive_partition.get("field")
        if archive_strategy == "event_time":
            if archive_field not in column_names:
                raise ValueError("archive partition field must reference a declared column")
            if archive_field != self.timestamp_field:
                raise ValueError("archive partition field must equal timestamp_field")
        elif archive_strategy == "snapshot_date":
            if archive_field is not None:
                raise ValueError("snapshot_date archive partition cannot declare a field")
        else:
            raise ValueError("archive partition strategy is unsupported")
        if self.grain_seconds is not None:
            if isinstance(self.grain_seconds, bool) or self.grain_seconds <= 0:
                raise ValueError("grain_seconds must be a positive integer or null")
        if not self.coverage_policy:
            raise ValueError("coverage_policy cannot be empty")
        if not self.required_modes or not set(self.required_modes) <= _INGESTION_MODES:
            raise ValueError("required_modes must contain only supported ingestion modes")
        if not self.normalizer or not _IDENTIFIER.fullmatch(self.normalizer):
            raise ValueError("normalizer must be a non-empty identifier")
        object.__setattr__(
            self,
            "retention",
            cast(Mapping[str, int | None], MappingProxyType(dict(self.retention))),
        )
        object.__setattr__(
            self,
            "archive_partition",
            cast(Mapping[str, str | None], MappingProxyType(dict(self.archive_partition))),
        )

    @property
    def supports_live_window_sync(self) -> bool:
        """Verifica a condição associada a supports live janela sync.

        Returns:
            Valor ``bool`` produzido pela operação após as validações.
        """

        return (
            self.archive_partition.get("strategy") == "event_time"
            and self.timestamp_field is not None
        )


__all__ = ["DatasetColumn", "DatasetDescriptor"]
