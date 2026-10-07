"""Prepare stable snapshot cursor indexes and reject unsafe MySQL query plans."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from decimal import Decimal
from typing import cast

import pymysql
from pymysql.connections import Connection
from pymysql.cursors import SSDictCursor

from adapters.sources.mysql_reader import (
    MAX_PAGE_SIZE,
    MySqlConnectionSettings,
    QueryParameters,
    build_page_query,
    quote_identifier,
)
from contracts.registry import DatasetRegistry
from domain.datasets import DatasetDescriptor
from ports import QueryPlanEvidence, SnapshotPreparer

CURSOR_INDEX_NAME = "ix_ingestion_cursor"
_INITIAL_ACCESS_TYPES = frozenset({"const", "eq_ref", "ref", "range", "index"})
_RESUMED_ACCESS_TYPES = frozenset({"const", "eq_ref", "ref", "range"})
type ConnectionFactory = Callable[[], Connection]


class QueryPlanInvalid(RuntimeError):
    """Raised when MySQL cannot prove cursor-safe snapshot pagination."""

    def __init__(self, dataset: str) -> None:
        self.dataset = dataset
        super().__init__(f"query plan is invalid for dataset {dataset}")


class MySqlSnapshotPreparer(SnapshotPreparer):
    def __init__(
        self,
        registry: DatasetRegistry,
        settings: MySqlConnectionSettings,
        *,
        connection_factory: ConnectionFactory | None = None,
    ) -> None:
        if not isinstance(registry, DatasetRegistry):
            raise TypeError("registry must be a DatasetRegistry")
        if not isinstance(settings, MySqlConnectionSettings):
            raise TypeError("settings must be MySqlConnectionSettings")
        self._registry = registry
        self._settings = settings
        self._connection_factory = connection_factory or self._connect

    def _connect(self) -> Connection:
        settings = self._settings
        return pymysql.connect(
            host=settings.host,
            port=settings.port,
            user=settings.user,
            password=settings.password,
            database=settings.database,
            charset="utf8mb4",
            autocommit=True,
            connect_timeout=settings.connect_timeout_seconds,
            read_timeout=settings.ddl_timeout_seconds,
            write_timeout=settings.ddl_timeout_seconds,
            cursorclass=SSDictCursor,
        )

    def _require_descriptor(self, descriptor: DatasetDescriptor) -> DatasetDescriptor:
        if not isinstance(descriptor, DatasetDescriptor):
            raise TypeError("descriptor must be a DatasetDescriptor")
        try:
            approved = self._registry.require(descriptor.table)
        except KeyError as error:
            raise ValueError("descriptor is not present in the registry") from error
        if descriptor != approved:
            raise ValueError("descriptor differs from the registry contract")
        return approved

    def _fetch_all(
        self, statement: str, parameters: QueryParameters = ()
    ) -> tuple[Mapping[str, object], ...]:
        connection = self._connection_factory()
        try:
            with connection.cursor(SSDictCursor) as cursor:
                cursor.execute(statement, parameters)
                rows = cast(list[Mapping[str, object]], cursor.fetchall())
                return tuple(dict(row) for row in rows)
        finally:
            connection.close()

    def _execute(self, statement: str, parameters: QueryParameters = ()) -> None:
        connection = self._connection_factory()
        try:
            with connection.cursor(SSDictCursor) as cursor:
                cursor.execute(statement, parameters)
        finally:
            connection.close()

    def _indexes(self, descriptor: DatasetDescriptor) -> dict[str, tuple[str, ...]]:
        rows = self._fetch_all(
            """SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s
ORDER BY INDEX_NAME, SEQ_IN_INDEX""",
            (self._settings.database, descriptor.table),
        )
        grouped: dict[str, list[tuple[int, str]]] = {}
        for row in rows:
            name = row.get("INDEX_NAME")
            column = row.get("COLUMN_NAME")
            position = row.get("SEQ_IN_INDEX")
            if (
                not isinstance(name, str)
                or not name
                or not isinstance(column, str)
                or not column
                or isinstance(position, bool)
                or not isinstance(position, int)
                or position <= 0
            ):
                raise ValueError("INFORMATION_SCHEMA returned an invalid index definition")
            grouped.setdefault(name, []).append((position, column))
        return {
            name: tuple(column for _, column in sorted(columns))
            for name, columns in grouped.items()
        }

    @staticmethod
    def _has_cursor_prefix(columns: tuple[str, ...], cursor: tuple[str, ...]) -> bool:
        return columns[: len(cursor)] == cursor

    def _add_reserved_index(self, descriptor: DatasetDescriptor) -> None:
        table = quote_identifier(descriptor.table)
        columns = ", ".join(quote_identifier(column) for column in descriptor.cursor_key)
        statement = (
            f"ALTER TABLE {table} ADD INDEX {quote_identifier(CURSOR_INDEX_NAME)} "
            f"({columns}), ALGORITHM=INPLACE, LOCK=NONE"
        )
        for attempt in range(2):
            try:
                self._execute(statement)
                break
            except pymysql.err.OperationalError as error:
                code = error.args[0] if error.args else None
                if code not in {2006, 2013}:
                    raise
                observed = self._indexes(descriptor).get(CURSOR_INDEX_NAME)
                if observed is not None:
                    if self._has_cursor_prefix(observed, descriptor.cursor_key):
                        return
                    raise QueryPlanInvalid(descriptor.table) from error
                if attempt == 1:
                    raise
        observed = self._indexes(descriptor).get(CURSOR_INDEX_NAME)
        if observed is None or not self._has_cursor_prefix(observed, descriptor.cursor_key):
            raise QueryPlanInvalid(descriptor.table)

    def _ensure_index(self, descriptor: DatasetDescriptor) -> tuple[str, bool]:
        expected = (
            "PRIMARY" if descriptor.cursor_key == descriptor.natural_key else CURSOR_INDEX_NAME
        )
        indexes = self._indexes(descriptor)
        observed = indexes.get(expected)
        if observed is not None:
            if not self._has_cursor_prefix(observed, descriptor.cursor_key):
                raise QueryPlanInvalid(descriptor.table)
            return expected, False
        if expected == "PRIMARY":
            raise QueryPlanInvalid(descriptor.table)
        self._add_reserved_index(descriptor)
        self._execute(f"ANALYZE TABLE {quote_identifier(descriptor.table)}")
        return expected, True

    @staticmethod
    def _find_table(node: object, dataset: str) -> Mapping[str, object] | None:
        if isinstance(node, Mapping):
            if node.get("table_name") == dataset and "access_type" in node:
                return cast(Mapping[str, object], node)
            for value in node.values():
                found = MySqlSnapshotPreparer._find_table(value, dataset)
                if found is not None:
                    return found
        elif isinstance(node, list):
            for value in node:
                found = MySqlSnapshotPreparer._find_table(value, dataset)
                if found is not None:
                    return found
        return None

    @staticmethod
    def _uses_filesort(node: object) -> bool:
        if isinstance(node, Mapping):
            for key, value in node.items():
                if key == "using_filesort" and value is True:
                    return True
                if MySqlSnapshotPreparer._uses_filesort(value):
                    return True
        elif isinstance(node, list):
            return any(MySqlSnapshotPreparer._uses_filesort(value) for value in node)
        elif isinstance(node, str):
            return "using filesort" in node.lower()
        return False

    @staticmethod
    def _estimated_rows(table: Mapping[str, object]) -> int:
        value = table.get("rows_examined_per_scan", table.get("rows_produced_per_join", 0))
        if isinstance(value, Decimal):
            value = int(value)
        if isinstance(value, bool) or not isinstance(value, int | float) or value < 0:
            raise ValueError("EXPLAIN returned invalid estimated rows")
        return int(value)

    def _explain(
        self,
        descriptor: DatasetDescriptor,
        index_name: str,
        after: tuple[object, ...] | None,
    ) -> tuple[str, int]:
        statement, parameters = build_page_query(
            descriptor,
            None,
            after,
            MAX_PAGE_SIZE,
            forced_index=index_name,
        )
        rows = self._fetch_all(f"EXPLAIN FORMAT=JSON {statement}", parameters)
        if len(rows) != 1:
            raise QueryPlanInvalid(descriptor.table)
        raw = rows[0].get("EXPLAIN")
        if not isinstance(raw, str):
            raise QueryPlanInvalid(descriptor.table)
        try:
            plan = json.loads(raw)
        except (TypeError, ValueError) as error:
            raise QueryPlanInvalid(descriptor.table) from error
        table = self._find_table(plan, descriptor.table)
        if table is None:
            raise QueryPlanInvalid(descriptor.table)
        access_type = table.get("access_type")
        key = table.get("key")
        used = table.get("used_key_parts")
        allowed = _INITIAL_ACCESS_TYPES if after is None else _RESUMED_ACCESS_TYPES
        if (
            not isinstance(access_type, str)
            or access_type not in allowed
            or key != index_name
            or not isinstance(used, list)
            or tuple(used[: len(descriptor.cursor_key)]) != descriptor.cursor_key
            or (after is not None and self._uses_filesort(plan))
        ):
            raise QueryPlanInvalid(descriptor.table)
        return access_type, self._estimated_rows(table)

    def _first_cursor(
        self, descriptor: DatasetDescriptor, index_name: str
    ) -> tuple[object, ...] | None:
        statement, parameters = build_page_query(
            descriptor,
            None,
            None,
            MAX_PAGE_SIZE,
            selected_columns=descriptor.cursor_key,
            forced_index=index_name,
        )
        rows = self._fetch_all(statement, parameters)
        if not rows:
            return None
        row = rows[-1]
        try:
            return tuple(row[column] for column in descriptor.cursor_key)
        except KeyError as error:
            raise ValueError("cursor probe returned an unexpected shape") from error

    def _has_resumed_row(
        self,
        descriptor: DatasetDescriptor,
        index_name: str,
        after: tuple[object, ...],
    ) -> bool:
        statement, parameters = build_page_query(
            descriptor,
            None,
            after,
            1,
            selected_columns=descriptor.cursor_key,
            forced_index=index_name,
        )
        rows = self._fetch_all(statement, parameters)
        if not rows:
            return False
        if len(rows) != 1 or tuple(rows[0]) != descriptor.cursor_key:
            raise ValueError("resumed cursor probe returned an unexpected shape")
        return True

    def prepare(self, descriptors: tuple[DatasetDescriptor, ...]) -> tuple[QueryPlanEvidence, ...]:
        if not isinstance(descriptors, tuple):
            raise TypeError("descriptors must be a tuple")
        approved = tuple(self._require_descriptor(descriptor) for descriptor in descriptors)
        evidence: list[QueryPlanEvidence] = []
        for descriptor in approved:
            index_name, created = self._ensure_index(descriptor)
            access_type, estimated_rows = self._explain(descriptor, index_name, None)
            first_cursor = self._first_cursor(descriptor, index_name)
            if first_cursor is not None and self._has_resumed_row(
                descriptor, index_name, first_cursor
            ):
                self._explain(descriptor, index_name, first_cursor)
            evidence.append(
                QueryPlanEvidence(
                    descriptor.table,
                    index_name,
                    descriptor.cursor_key,
                    created,
                    access_type,
                    estimated_rows,
                )
            )
        return tuple(evidence)


__all__ = ["CURSOR_INDEX_NAME", "MySqlSnapshotPreparer", "QueryPlanInvalid"]
