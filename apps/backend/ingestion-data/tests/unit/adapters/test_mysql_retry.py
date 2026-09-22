"""Verify lost MySQL reads are retried without leaking connections."""

from __future__ import annotations

from collections.abc import Mapping

import pymysql
import pytest

from adapters.sources.mysql_reader import MySqlConnectionSettings, MySqlSourceReader
from adapters.sources.mysql_retry import (
    MySqlQueryRetriesExhausted,
    MySqlRetryPolicy,
    RetryingMySqlSourceReader,
)
from contracts.registry import DatasetRegistry
from domain.datasets import DatasetDescriptor
from domain.models import TimeWindow
from domain.quality import CoverageStatus
from ports import CoverageObservation, SchemaObservation, SourcePage, SourceReader


class RecordingConnection:
    def __init__(self, response: tuple[Mapping[str, object], ...] | Exception) -> None:
        self._response = response
        self.closed = 0

    def cursor(self, _cursor_type: object) -> RecordingConnection:
        return self

    def __enter__(self) -> RecordingConnection:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def execute(self, _statement: str, _parameters: tuple[object, ...]) -> None:
        if isinstance(self._response, Exception):
            raise self._response

    def fetchall(self) -> list[Mapping[str, object]]:
        assert not isinstance(self._response, Exception)
        return list(self._response)

    def close(self) -> None:
        self.closed += 1


class ScriptedReader(SourceReader):
    def __init__(self, pages: list[SourcePage | Exception]) -> None:
        self._pages = pages
        self.page_cursors: list[tuple[object, ...] | None] = []

    def validate_schema(self, _descriptor: DatasetDescriptor) -> SchemaObservation:
        return SchemaObservation("a" * 64, True)

    def measure_coverage(self, _descriptor: DatasetDescriptor) -> CoverageObservation:
        return CoverageObservation(CoverageStatus.COMPLETE, 0, None)

    def read_page(
        self,
        _descriptor: DatasetDescriptor,
        _window: TimeWindow | None,
        after: tuple[object, ...] | None,
        _limit: int,
    ) -> SourcePage:
        self.page_cursors.append(after)
        outcome = self._pages.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


@pytest.fixture
def registry() -> DatasetRegistry:
    return DatasetRegistry.load_argus_v2()


def _settings() -> MySqlConnectionSettings:
    return MySqlConnectionSettings("127.0.0.1", 3306, "reader", "secret", "argus")


def test_lost_page_opens_a_fresh_connection_and_closes_every_attempt(
    registry: DatasetRegistry,
) -> None:
    descriptor = registry.require("signal_bucket")
    row = {
        "bts": 1_788_000_000_000,
        "source": "apollo",
        "entity": "edge-a",
        "metric": "requests",
        "value": 7,
    }
    connections = [
        RecordingConnection(pymysql.err.OperationalError(2013, "lost connection")),
        RecordingConnection((row,)),
    ]
    opened: list[RecordingConnection] = []

    def connect() -> RecordingConnection:
        connection = connections.pop(0)
        opened.append(connection)
        return connection

    delays: list[float] = []
    reader = RetryingMySqlSourceReader(
        MySqlSourceReader(registry, _settings(), connection_factory=connect),  # type: ignore[arg-type]
        MySqlRetryPolicy(max_attempts=4, base_delay_ms=250, max_delay_ms=4_000),
        sleep=delays.append,
        random_value=lambda: 0.5,
    )

    page = reader.read_page(descriptor, None, None, 100)

    assert page.rows == (row,)
    assert page.next_cursor == (1_788_000_000_000, "apollo", "edge-a", "requests")
    assert delays == [0.125]
    assert [connection.closed for connection in opened] == [1, 1]


@pytest.mark.parametrize("mysql_code, timed_out", [(2006, False), (2013, True)])
def test_retryable_mysql_codes_continue_until_the_attempt_budget_is_exhausted(
    registry: DatasetRegistry, mysql_code: int, timed_out: bool
) -> None:
    descriptor = registry.require("signal_bucket")
    reader = ScriptedReader(
        [pymysql.err.OperationalError(mysql_code, "lost connection") for _ in range(4)]
    )
    delays: list[float] = []
    retrying = RetryingMySqlSourceReader(
        reader,
        MySqlRetryPolicy(max_attempts=4, base_delay_ms=250, max_delay_ms=4_000),
        sleep=delays.append,
        random_value=lambda: 0.5,
    )

    with pytest.raises(MySqlQueryRetriesExhausted) as captured:
        retrying.read_page(
            descriptor,
            None,
            (1_788_000_000_000, "apollo", "edge-a", "requests"),
            100,
        )

    assert captured.value.mysql_code == mysql_code
    assert captured.value.attempts == 4
    assert captured.value.timed_out is timed_out
    assert len(reader.page_cursors) == 4
    assert delays == [0.125, 0.25, 0.5]


@pytest.mark.parametrize(
    "error",
    [pymysql.err.OperationalError(1045, "access denied"), ValueError("invalid source row")],
)
def test_non_retryable_mysql_and_contract_errors_escape_immediately(
    registry: DatasetRegistry, error: Exception
) -> None:
    reader = ScriptedReader([error])
    delays: list[float] = []
    retrying = RetryingMySqlSourceReader(
        reader,
        MySqlRetryPolicy(max_attempts=4, base_delay_ms=250, max_delay_ms=4_000),
        sleep=delays.append,
        random_value=lambda: 0.5,
    )

    with pytest.raises(type(error)):
        retrying.read_page(registry.require("signal_bucket"), None, None, 100)

    assert len(reader.page_cursors) == 1
    assert delays == []
