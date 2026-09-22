"""Verify ingestion checkpoints resume safely after interrupted processing."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Never

import boto3  # type: ignore[import-untyped]
import pymysql
import pytest
from moto import mock_aws

from adapters.dynamodb.control import DynamoControlRepository
from adapters.sources.mysql_retry import MySqlRetryPolicy, RetryingMySqlSourceReader
from application.backfill import BackfillFailed
from ports import IdempotencyConflict, StaleCheckpoint
from tests.unit.application.test_backfill import build_backfill

NOW = datetime(2026, 9, 8, 12, 0, tzinfo=UTC)


def test_exhausted_lost_read_keeps_the_durable_checkpoint_and_reuses_its_cursor(
    tmp_path: Path,
) -> None:
    harness = build_backfill(tmp_path)
    descriptor = harness.registry.require("signal_bucket")
    durable_cursor = (1_788_000_000_000, "apollo", "edge-a", "requests")
    harness.checkpoints.checkpoints[(harness.version, descriptor.table)] = durable_cursor
    attempted_cursors: list[tuple[object, ...] | None] = []
    advance_calls = 0
    original_read_page = harness.reader.read_page

    def lose_connection(current, window, after, limit):  # type: ignore[no-untyped-def]
        if current == descriptor:
            attempted_cursors.append(after)
            raise pymysql.err.OperationalError(2013, "lost connection")
        return original_read_page(current, window, after, limit)

    harness.reader.read_page = lose_connection  # type: ignore[method-assign]

    def fail_if_checkpoint_advances(*_args: object, **_kwargs: object) -> Never:
        nonlocal advance_calls
        advance_calls += 1
        raise AssertionError("checkpoint must not advance after an exhausted read")

    harness.checkpoints.advance = fail_if_checkpoint_advances  # type: ignore[method-assign]
    harness.service._reader_factory = lambda: RetryingMySqlSourceReader(
        harness.reader,
        MySqlRetryPolicy(max_attempts=2, base_delay_ms=1, max_delay_ms=1),
        sleep=lambda _delay: None,
        random_value=lambda: 0.5,
    )

    with pytest.raises(BackfillFailed):
        harness.service.execute(harness.request)

    assert attempted_cursors == [durable_cursor, durable_cursor]
    assert advance_calls == 0
    assert harness.checkpoints.get(harness.version, descriptor.table) == durable_cursor


def _table() -> object:
    client = boto3.client("dynamodb", region_name="us-east-1")
    client.create_table(
        TableName="hot",
        KeySchema=[
            {"AttributeName": "pk", "KeyType": "HASH"},
            {"AttributeName": "sk", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "pk", "AttributeType": "S"},
            {"AttributeName": "sk", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    return client


@pytest.mark.aws
@mock_aws
def test_checkpoint_resume_is_monotonic_and_compare_and_swap_safe() -> None:
    client = _table()
    first_worker = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    second_worker = DynamoControlRepository(client, "hot", clock=lambda: NOW)

    first = first_worker.advance(
        "dsv_a",
        "signal_bucket",
        (1000, "a"),
        expected_cursor=None,
        idempotency_key="page-1",
    )
    winner = first_worker.advance(
        "dsv_a",
        "signal_bucket",
        (2000, "a"),
        expected_cursor=first,
        idempotency_key="page-2",
    )

    with pytest.raises(StaleCheckpoint):
        second_worker.advance(
            "dsv_a",
            "signal_bucket",
            (1500, "a"),
            expected_cursor=first,
            idempotency_key="stale-worker",
        )
    with pytest.raises(StaleCheckpoint):
        second_worker.advance(
            "dsv_a",
            "signal_bucket",
            (1000, "z"),
            expected_cursor=winner,
            idempotency_key="backward-worker",
        )

    assert second_worker.get("dsv_a", "signal_bucket") == winner


@pytest.mark.aws
@mock_aws
def test_checkpoint_replay_survives_restart_and_returns_original_result() -> None:
    client = _table()
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    original = repository.advance(
        "dsv_a",
        "signal_bucket",
        (1000, "a"),
        expected_cursor=None,
        idempotency_key="page-1",
    )
    repository.advance(
        "dsv_a",
        "signal_bucket",
        (2000, "a"),
        expected_cursor=original,
        idempotency_key="page-2",
    )

    restarted = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    assert (
        restarted.advance(
            "dsv_a",
            "signal_bucket",
            (1000, "a"),
            expected_cursor=None,
            idempotency_key="page-1",
        )
        == original
    )
    with pytest.raises(IdempotencyConflict):
        restarted.advance(
            "dsv_a",
            "signal_bucket",
            (9999, "z"),
            expected_cursor=None,
            idempotency_key="page-1",
        )


@pytest.mark.aws
@mock_aws
def test_failed_checkpoint_cas_does_not_reserve_idempotency_key() -> None:
    client = _table()
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    current = repository.advance(
        "dsv_a",
        "signal_bucket",
        (1000, "a"),
        expected_cursor=None,
        idempotency_key="page-1",
    )

    for _ in range(2):
        with pytest.raises(StaleCheckpoint):
            repository.advance(
                "dsv_a",
                "signal_bucket",
                (2000, "a"),
                expected_cursor=None,
                idempotency_key="retryable-page",
            )

    assert repository.advance(
        "dsv_a",
        "signal_bucket",
        (2000, "a"),
        expected_cursor=current,
        idempotency_key="retryable-page",
    ) == (2000, "a")


@pytest.mark.aws
@mock_aws
def test_checkpoint_uses_the_documented_exact_key_shape() -> None:
    client = _table()
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    repository.advance(
        "dsv_a",
        "signal_bucket",
        (1000, "a"),
        expected_cursor=None,
        idempotency_key="page-1",
    )

    response = client.get_item(
        TableName="hot",
        Key={
            "pk": {"S": "DATASET#dsv_a#INGESTION#SOURCE#signal_bucket"},
            "sk": {"S": "CHECKPOINT"},
        },
        ConsistentRead=True,
    )
    assert response["Item"]["cursorCanonical"]["S"]
    assert "ttl" not in response["Item"]
