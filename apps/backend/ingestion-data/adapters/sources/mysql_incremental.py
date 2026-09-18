"""Exporta páginas físicas incrementais do MySQL sem normalizar colunas adicionais."""

from __future__ import annotations

import re

from adapters.sources.mysql_reader import (
    ConnectionFactory,
    MySqlConnectionSettings,
    MySqlSourceReader,
)
from contracts.registry import DatasetRegistry
from domain.datasets import DatasetDescriptor
from domain.incremental_batches import PhysicalColumn
from domain.models import TimeWindow
from ports.contracts import Cursor
from ports.incremental import IncrementalExportSource
from ports.models import SourcePage

_SUPPORTED_RAW_TYPES = re.compile(
    r"^(?:BIGINT|INT|TINYINT|DOUBLE|VARCHAR\([1-9][0-9]*\)|TEXT|ENUM\(.*\))$"
)


class MySqlIncrementalExportSource(MySqlSourceReader, IncrementalExportSource):
    """Lê colunas observadas, preservando o cursor do descritor para paginação estável."""

    def __init__(
        self,
        registry: DatasetRegistry,
        settings: MySqlConnectionSettings,
        *,
        connection_factory: ConnectionFactory | None = None,
    ) -> None:
        super().__init__(
            registry,
            settings,
            connection_factory=connection_factory,
        )
        self._observed: dict[str, tuple[PhysicalColumn, ...]] = {}

    def observe_schema(self, descriptor: DatasetDescriptor) -> tuple[PhysicalColumn, ...]:
        """Observa as colunas físicas e falha antes da exportação em caso de tipo não suportado."""
        approved = self._require_descriptor(descriptor)
        columns = self._observe_columns(approved)
        if any(_SUPPORTED_RAW_TYPES.fullmatch(column.physical_type) is None for column in columns):
            raise ValueError("incremental source contains an unsupported physical type")
        self._observed[approved.table] = columns
        return columns

    def read_page(
        self,
        descriptor: DatasetDescriptor,
        window: TimeWindow,  # type: ignore[override]
        after: Cursor | None,
        limit: int,
    ) -> SourcePage:
        """Lê uma página com a projeção observada e a chave de cursor canônica do descritor."""
        if not isinstance(window, TimeWindow):
            raise TypeError("incremental export window must be a TimeWindow")
        approved = self._require_descriptor(descriptor)
        try:
            columns = self._observed[approved.table]
        except KeyError as error:
            raise ValueError("observe_schema must be called before incremental export") from error
        selected = tuple(column.name for column in columns)
        page = self._read_selected_page(approved, selected, window, after, limit)
        for row in page.rows:
            if tuple(row) != selected:
                raise ValueError("source row shape differs from observed schema")
        return page


__all__ = ["MySqlIncrementalExportSource"]
