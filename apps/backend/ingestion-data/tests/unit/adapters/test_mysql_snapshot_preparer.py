"""Verify snapshot cursor indexes and query plans are prepared safely."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import replace

import pymysql
import pytest

from adapters.sources.mysql_reader import MySqlConnectionSettings
from adapters.sources.mysql_snapshot_preparer import (
    MySqlSnapshotPreparer,
    QueryPlanInvalid,
)
from contracts.registry import DatasetRegistry


class FakeCursor:
    def __init__(self, database: FakeDatabase) -> None:
        self._database = database
        self._rows: list[Mapping[str, object]] = []

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def execute(self, statement: str, parameters: tuple[object, ...] = ()) -> None:
        self._rows = self._database.execute(statement, parameters)

    def fetchall(self) -> list[Mapping[str, object]]:
        return self._rows

    def fetchone(self) -> Mapping[str, object] | None:
        return self._rows[0] if self._rows else None


class FakeConnection:
    def __init__(self, database: FakeDatabase) -> None:
        self._database = database

    def cursor(self, _cursor_type: object = None) -> FakeCursor:
        return FakeCursor(self._database)

    def close(self) -> None:
        return None


class FakeDatabase:
    def __init__(self, registry: DatasetRegistry) -> None:
        self.registry = registry
        self.indexes: dict[str, dict[str, tuple[str, ...]]] = {
            descriptor.table: {"PRIMARY": descriptor.natural_key} for descriptor in registry
        }
        self.statements: list[tuple[str, tuple[object, ...]]] = []
        self.rows: dict[str, tuple[object, ...]] = {
            "signal_bucket": (1_787_997_600_000, "apollo", "edge-a", "requests"),
            "finding_status_log": (1_787_997_600_000, "finding-1"),
            "live_event": (1_787_997_600_000, 7),
        }
        self.invalid_plan_for: str | None = None
        self.invalid_resumed_plan_for: str | None = None
        self.exhausted: set[str] = set()
        self.resumed_access_type = "range"
        self.resumed_using_filesort = False
        self.lose_alter_response_for: str | None = None
        self._lost_response = False

    def connect(self) -> FakeConnection:
        return FakeConnection(self)

    def execute(self, statement: str, parameters: tuple[object, ...]) -> list[Mapping[str, object]]:
        self.statements.append((statement, parameters))
        if "INFORMATION_SCHEMA.STATISTICS" in statement:
            table = str(parameters[1])
            return [
                {"INDEX_NAME": name, "COLUMN_NAME": column, "SEQ_IN_INDEX": position}
                for name, columns in self.indexes[table].items()
                for position, column in enumerate(columns, start=1)
            ]
        if statement.startswith("ALTER TABLE"):
            table = re.search(r"ALTER TABLE `([^`]+)`", statement).group(1)  # type: ignore[union-attr]
            columns = tuple(re.findall(r"`([^`]+)`", statement)[2:])
            self.indexes[table]["ix_ingestion_cursor"] = columns
            if table == self.lose_alter_response_for and not self._lost_response:
                self._lost_response = True
                raise pymysql.err.OperationalError(2013, "lost response")
            return []
        if statement.startswith("ANALYZE TABLE"):
            return []
        if statement.startswith("EXPLAIN FORMAT=JSON"):
            table = re.search(r"FROM `([^`]+)`", statement).group(1)  # type: ignore[union-attr]
            resumed = " WHERE " in statement
            expected = (
                "PRIMARY"
                if self.registry.require(table).cursor_key
                == self.registry.require(table).natural_key
                else "ix_ingestion_cursor"
            )
            used_key_parts = list(self.registry.require(table).cursor_key)
            if table == self.invalid_plan_for or (
                resumed and table == self.invalid_resumed_plan_for
            ):
                used_key_parts.pop()
            plan = {
                "query_block": {
                    "ordering_operation": {
                        "using_filesort": self.resumed_using_filesort if resumed else False,
                        "table": {
                            "table_name": table,
                            "access_type": self.resumed_access_type if resumed else "index",
                            "key": expected,
                            "used_key_parts": used_key_parts,
                            "rows_examined_per_scan": 3,
                        },
                    }
                }
            }
            return [{"EXPLAIN": json.dumps(plan)}]
        if statement.startswith("SELECT"):
            table = re.search(r"FROM `([^`]+)`", statement).group(1)  # type: ignore[union-attr]
            if " WHERE " in statement and table in self.exhausted:
                return []
            row = self.rows.get(table)
            if row is None:
                return []
            return [dict(zip(self.registry.require(table).cursor_key, row, strict=True))]
        raise AssertionError(f"unexpected SQL: {statement}")


@pytest.fixture(scope="module")
def registry() -> DatasetRegistry:
    return DatasetRegistry.load_argus_v2()


@pytest.fixture(scope="module")
def settings() -> MySqlConnectionSettings:
    return MySqlConnectionSettings("127.0.0.1", 3306, "ingestion", "secret", "argus")


def _divergent_descriptors(registry: DatasetRegistry):  # type: ignore[no-untyped-def]
    return tuple(
        registry.require(name) for name in ("signal_bucket", "finding_status_log", "live_event")
    )


def test_prepare_creates_reserved_cursor_indexes_once_and_analyzes_only_created_tables(
    registry: DatasetRegistry, settings: MySqlConnectionSettings
) -> None:
    database = FakeDatabase(registry)
    database.indexes["signal_bucket"]["external_cursor_index"] = registry.require(
        "signal_bucket"
    ).cursor_key
    preparer = MySqlSnapshotPreparer(registry, settings, connection_factory=database.connect)

    first = preparer.prepare(_divergent_descriptors(registry))
    second = preparer.prepare(_divergent_descriptors(registry))

    alter = [sql for sql, _ in database.statements if sql.startswith("ALTER TABLE")]
    analyze = [sql for sql, _ in database.statements if sql.startswith("ANALYZE TABLE")]
    assert alter == [
        "ALTER TABLE `signal_bucket` ADD INDEX `ix_ingestion_cursor` "
        "(`bts`, `source`, `entity`, `metric`), ALGORITHM=INPLACE, LOCK=NONE",
        "ALTER TABLE `finding_status_log` ADD INDEX `ix_ingestion_cursor` "
        "(`ts`, `finding_id`), ALGORITHM=INPLACE, LOCK=NONE",
        "ALTER TABLE `live_event` ADD INDEX `ix_ingestion_cursor` "
        "(`start_ts`, `tid`), ALGORITHM=INPLACE, LOCK=NONE",
    ]
    assert analyze == [
        "ANALYZE TABLE `signal_bucket`",
        "ANALYZE TABLE `finding_status_log`",
        "ANALYZE TABLE `live_event`",
    ]
    assert [e.index_name for e in first] == ["ix_ingestion_cursor"] * 3
    assert [e.cursor_columns for e in first] == [
        ("bts", "source", "entity", "metric"),
        ("ts", "finding_id"),
        ("start_ts", "tid"),
    ]
    assert all(e.created and e.access_type == "index" and e.estimated_rows == 3 for e in first)
    assert not any(e.created for e in second)
    assert not any("DROP INDEX" in sql for sql, _ in database.statements)


def test_prepare_accepts_primary_only_when_cursor_is_its_exact_prefix(
    registry: DatasetRegistry, settings: MySqlConnectionSettings
) -> None:
    database = FakeDatabase(registry)
    descriptor = registry.require("signal_meta")
    database.indexes[descriptor.table]["PRIMARY"] = (*descriptor.cursor_key, "description")

    evidence = MySqlSnapshotPreparer(
        registry, settings, connection_factory=database.connect
    ).prepare((descriptor,))

    assert evidence[0].index_name == "PRIMARY"
    assert evidence[0].created is False
    assert not any(
        sql.startswith(("ALTER TABLE", "ANALYZE TABLE")) for sql, _ in database.statements
    )


def test_prepare_rejects_a_divergent_reserved_index_without_removing_it(
    registry: DatasetRegistry, settings: MySqlConnectionSettings
) -> None:
    database = FakeDatabase(registry)
    descriptor = registry.require("live_event")
    database.indexes[descriptor.table]["ix_ingestion_cursor"] = ("tid", "start_ts")

    with pytest.raises(QueryPlanInvalid, match="live_event"):
        MySqlSnapshotPreparer(registry, settings, connection_factory=database.connect).prepare(
            (descriptor,)
        )

    assert not any(sql.startswith(("ALTER TABLE", "DROP INDEX")) for sql, _ in database.statements)


def test_prepare_rechecks_schema_after_a_lost_ddl_response(
    registry: DatasetRegistry, settings: MySqlConnectionSettings
) -> None:
    database = FakeDatabase(registry)
    database.lose_alter_response_for = "finding_status_log"
    descriptor = registry.require("finding_status_log")

    evidence = MySqlSnapshotPreparer(
        registry, settings, connection_factory=database.connect
    ).prepare((descriptor,))

    assert evidence[0].created is True
    assert sum(sql.startswith("ALTER TABLE") for sql, _ in database.statements) == 1


def test_prepare_rejects_explain_that_does_not_use_the_full_expected_prefix(
    registry: DatasetRegistry, settings: MySqlConnectionSettings
) -> None:
    database = FakeDatabase(registry)
    database.invalid_plan_for = "signal_bucket"

    with pytest.raises(QueryPlanInvalid, match="signal_bucket"):
        MySqlSnapshotPreparer(registry, settings, connection_factory=database.connect).prepare(
            (registry.require("signal_bucket"),)
        )


def test_prepare_rejects_a_partial_key_on_a_resumed_page_that_has_data(
    registry: DatasetRegistry, settings: MySqlConnectionSettings
) -> None:
    database = FakeDatabase(registry)
    database.invalid_resumed_plan_for = "signal_bucket"

    with pytest.raises(QueryPlanInvalid, match="signal_bucket"):
        MySqlSnapshotPreparer(registry, settings, connection_factory=database.connect).prepare(
            (registry.require("signal_bucket"),)
        )

    explains = [sql for sql, _ in database.statements if sql.startswith("EXPLAIN FORMAT=JSON")]
    assert len(explains) == 2
    assert " WHERE " not in explains[0]
    assert " WHERE " in explains[1]


def test_prepare_skips_only_resumed_explain_when_the_sampled_page_is_exhausted(
    registry: DatasetRegistry, settings: MySqlConnectionSettings
) -> None:
    database = FakeDatabase(registry)
    database.exhausted.add("live_event")
    database.resumed_access_type = "index"
    database.resumed_using_filesort = True

    evidence = MySqlSnapshotPreparer(
        registry, settings, connection_factory=database.connect
    ).prepare((registry.require("live_event"),))

    assert evidence[0].dataset == "live_event"
    explains = [sql for sql, _ in database.statements if sql.startswith("EXPLAIN FORMAT=JSON")]
    probes = [
        sql
        for sql, _ in database.statements
        if sql.startswith("SELECT `") and "INFORMATION_SCHEMA" not in sql
    ]
    assert len(explains) == 1
    assert " WHERE " not in explains[0]
    assert len(probes) == 2
    assert " WHERE " not in probes[0]
    assert " WHERE " in probes[1]


def test_prepare_rejects_full_index_scan_only_on_the_resumed_page(
    registry: DatasetRegistry, settings: MySqlConnectionSettings
) -> None:
    database = FakeDatabase(registry)
    database.resumed_access_type = "index"

    with pytest.raises(QueryPlanInvalid, match="live_event"):
        MySqlSnapshotPreparer(registry, settings, connection_factory=database.connect).prepare(
            (registry.require("live_event"),)
        )

    explains = [sql for sql, _ in database.statements if sql.startswith("EXPLAIN FORMAT=JSON")]
    assert len(explains) == 2
    assert " WHERE " not in explains[0]
    assert " WHERE " in explains[1]


def test_prepare_rejects_filesort_only_on_the_resumed_page(
    registry: DatasetRegistry, settings: MySqlConnectionSettings
) -> None:
    database = FakeDatabase(registry)
    database.resumed_using_filesort = True

    with pytest.raises(QueryPlanInvalid, match="live_event"):
        MySqlSnapshotPreparer(registry, settings, connection_factory=database.connect).prepare(
            (registry.require("live_event"),)
        )

    explains = [sql for sql, _ in database.statements if sql.startswith("EXPLAIN FORMAT=JSON")]
    assert len(explains) == 2
    assert " WHERE " not in explains[0]
    assert " WHERE " in explains[1]


def test_prepare_rejects_a_descriptor_not_supplied_by_the_registry(
    registry: DatasetRegistry, settings: MySqlConnectionSettings
) -> None:
    database = FakeDatabase(registry)
    forged = replace(registry.require("live_event"), cursor_key=("tid", "start_ts"))

    with pytest.raises(ValueError, match="registry"):
        MySqlSnapshotPreparer(registry, settings, connection_factory=database.connect).prepare(
            (forged,)
        )

    assert database.statements == []


def test_default_connection_uses_autocommit_and_ddl_timeouts(
    registry: DatasetRegistry, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, object] = {}
    connection = object()

    def connect(**kwargs: object) -> object:
        captured.update(kwargs)
        return connection

    monkeypatch.setattr("adapters.sources.mysql_snapshot_preparer.pymysql.connect", connect)
    preparer = MySqlSnapshotPreparer(
        registry,
        MySqlConnectionSettings(
            "127.0.0.1", 3306, "ingestion", "secret", "argus", ddl_timeout_seconds=777
        ),
    )

    assert preparer._connect() is connection
    assert captured["autocommit"] is True
    assert captured["read_timeout"] == 777
    assert captured["write_timeout"] == 777
