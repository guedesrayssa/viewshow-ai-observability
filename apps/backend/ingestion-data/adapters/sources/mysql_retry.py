"""Repeat transient MySQL source reads without changing their requested cursor."""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, TypeVar, cast

import pymysql

from domain.datasets import DatasetDescriptor
from domain.models import TimeWindow
from ports import CoverageObservation, Cursor, SchemaObservation, SourcePage, SourceReader

Result = TypeVar("Result")


class MySqlQueryRetriesExhausted(RuntimeError):
    def __init__(self, *, mysql_code: int, attempts: int, timed_out: bool) -> None:
        self.mysql_code = mysql_code
        self.attempts = attempts
        self.timed_out = timed_out
        super().__init__("MySQL query retries exhausted")


@dataclass(frozen=True, slots=True)
class MySqlRetryPolicy:
    max_attempts: int
    base_delay_ms: int
    max_delay_ms: int


@dataclass(frozen=True, slots=True)
class MySqlRetryEvent:
    operation: Literal["schema", "coverage", "page"]
    dataset: str | None
    mysql_code: int
    attempt: int
    delay_seconds: float


class RetryingMySqlSourceReader(SourceReader):
    """Retry only lost MySQL reads while retaining the caller's original request."""

    def __init__(
        self,
        inner: SourceReader,
        policy: MySqlRetryPolicy,
        *,
        sleep: Callable[[float], None] = time.sleep,
        random_value: Callable[[], float] = random.random,
        on_retry: Callable[[MySqlRetryEvent], None] | None = None,
    ) -> None:
        self._inner = inner
        self._policy = policy
        self._sleep = sleep
        self._random_value = random_value
        self._on_retry = on_retry

    def validate_schema(self, descriptor: DatasetDescriptor) -> SchemaObservation:
        return self._retry(
            "schema", descriptor.table, lambda: self._inner.validate_schema(descriptor)
        )

    def measure_coverage(self, descriptor: DatasetDescriptor) -> CoverageObservation:
        return self._retry(
            "coverage", descriptor.table, lambda: self._inner.measure_coverage(descriptor)
        )

    def read_page(
        self,
        descriptor: DatasetDescriptor,
        window: TimeWindow | None,
        after: Cursor | None,
        limit: int,
    ) -> SourcePage:
        return self._retry(
            "page",
            descriptor.table,
            lambda: self._inner.read_page(descriptor, window, after, limit),
        )

    def _retry(
        self,
        operation: Literal["schema", "coverage", "page"],
        dataset: str | None,
        query: Callable[[], Result],
    ) -> Result:
        for attempt in range(1, self._policy.max_attempts + 1):
            try:
                return query()
            except pymysql.err.OperationalError as error:
                mysql_code = _retryable_mysql_code(error)
                if mysql_code is None:
                    raise
                if attempt == self._policy.max_attempts:
                    raise MySqlQueryRetriesExhausted(
                        mysql_code=mysql_code,
                        attempts=attempt,
                        timed_out=mysql_code == 2013,
                    ) from error
                delay_seconds = self._delay_seconds(attempt)
                self._notify_retry(
                    MySqlRetryEvent(operation, dataset, mysql_code, attempt, delay_seconds)
                )
                self._sleep(delay_seconds)
        raise AssertionError("retry policy must allow at least one attempt")

    def _delay_seconds(self, attempt: int) -> float:
        ceiling_ms = min(
            self._policy.max_delay_ms,
            self._policy.base_delay_ms * (2 ** (attempt - 1)),
        )
        return cast(float, (ceiling_ms * self._random_value()) / 1_000)

    def _notify_retry(self, event: MySqlRetryEvent) -> None:
        if self._on_retry is None:
            return
        try:
            self._on_retry(event)
        except Exception:
            return


def _retryable_mysql_code(error: pymysql.err.OperationalError) -> int | None:
    if not error.args:
        return None
    mysql_code = error.args[0]
    if type(mysql_code) is int and mysql_code in {2006, 2013}:
        return mysql_code
    return None


__all__ = [
    "MySqlQueryRetriesExhausted",
    "MySqlRetryEvent",
    "MySqlRetryPolicy",
    "RetryingMySqlSourceReader",
]
