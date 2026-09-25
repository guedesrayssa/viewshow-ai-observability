"""Verify pending ingestion outbox events are published with safe retries."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from adapters.dynamodb.outbox import DynamoOutboxRepository
from application.publish_outbox import OutboxPublisher, PublishResult
from domain.models import TimeWindow
from ports import OutboxEvent, PublishReceipt
from tests.fakes import FakeOutboxRepository

NOW = datetime(2026, 9, 9, 12, tzinfo=UTC)


def _event(created_at: datetime) -> OutboxEvent:
    window_end = created_at.replace(second=0, microsecond=0)
    return DynamoOutboxRepository.build_event(
        "dsv_a",
        "ANOMALY_DETECTION",
        TimeWindow(window_end - timedelta(minutes=15), window_end, 900),
        created_at=created_at,
    )


class RecordingPublisher:
    def __init__(self) -> None:
        self.events: list[OutboxEvent] = []

    def publish(self, event: OutboxEvent, *, idempotency_key: str) -> PublishReceipt:
        assert idempotency_key == event.idempotency_key
        self.events.append(event)
        return PublishReceipt(f"message-{len(self.events)}")


def test_publish_pending_processes_oldest_first_with_bounded_limit() -> None:
    old = _event(NOW - timedelta(hours=2))
    new = _event(NOW)
    repository = FakeOutboxRepository({new.event_id: new, old.event_id: old})
    transport = RecordingPublisher()

    result = OutboxPublisher(repository, transport).publish_pending(1)

    assert result == PublishResult(attempted=1, published=1)
    assert transport.events == [old]
    assert repository.list_pending(10) == (new,)


def test_publish_failure_is_propagated_and_never_marks_event() -> None:
    event = _event(NOW)
    repository = FakeOutboxRepository({event.event_id: event})

    class FailingPublisher(RecordingPublisher):
        def publish(self, event: OutboxEvent, *, idempotency_key: str) -> PublishReceipt:
            raise TimeoutError("transient SQS timeout")

    with pytest.raises(TimeoutError, match="transient"):
        OutboxPublisher(repository, FailingPublisher()).publish_pending(10)

    assert repository.list_pending(10) == (event,)


def test_poison_oldest_event_blocks_later_events_without_acknowledging_anything() -> None:
    poison = _event(NOW - timedelta(hours=1))
    later = _event(NOW)
    repository = FakeOutboxRepository({later.event_id: later, poison.event_id: poison})

    class RejectingPublisher(RecordingPublisher):
        def publish(self, event: OutboxEvent, *, idempotency_key: str) -> PublishReceipt:
            self.events.append(event)
            raise ValueError("permanent contract rejection")

    transport = RejectingPublisher()
    with pytest.raises(ValueError, match="permanent"):
        OutboxPublisher(repository, transport).publish_pending(10)

    assert transport.events == [poison]
    assert repository.list_pending(10) == (poison, later)


def test_invalid_limit_is_rejected_before_repository_access() -> None:
    repository = FakeOutboxRepository()
    for value in (0, -1, True):
        with pytest.raises((TypeError, ValueError)):
            OutboxPublisher(repository, RecordingPublisher()).publish_pending(value)
