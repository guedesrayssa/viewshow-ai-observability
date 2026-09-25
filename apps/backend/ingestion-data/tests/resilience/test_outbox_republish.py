"""Verify failed outbox events can be republished without duplicate effects."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from adapters.dynamodb.outbox import DynamoOutboxRepository
from application.publish_outbox import OutboxPublisher
from domain.models import TimeWindow
from ports import ConditionalWriteError, OutboxEvent, PublishReceipt
from tests.fakes import FakeOutboxRepository


def test_send_success_followed_by_mark_failure_republishes_same_logical_event() -> None:
    window_end = datetime(2026, 9, 9, 12, tzinfo=UTC)
    event = DynamoOutboxRepository.build_event(
        "dsv_a",
        "ANOMALY_DETECTION",
        TimeWindow(window_end - timedelta(minutes=15), window_end, 900),
        created_at=window_end,
    )

    class FailFirstMarkRepository(FakeOutboxRepository):
        def __init__(self) -> None:
            super().__init__({event.event_id: event})
            self.mark_attempts = 0

        def mark_published(
            self,
            event_id: str,
            message_id: str,
            *,
            expected_state: str,
            idempotency_key: str,
        ) -> None:
            self.mark_attempts += 1
            if self.mark_attempts == 1:
                raise ConditionalWriteError("simulated acknowledgement loss")
            super().mark_published(
                event_id,
                message_id,
                expected_state=expected_state,
                idempotency_key=idempotency_key,
            )

    class StandardQueue:
        def __init__(self) -> None:
            self.envelopes: list[tuple[str, str]] = []

        def publish(self, event: OutboxEvent, *, idempotency_key: str) -> PublishReceipt:
            self.envelopes.append((event.event_id, event.idempotency_key))
            return PublishReceipt(f"message-{len(self.envelopes)}")

    repository = FailFirstMarkRepository()
    queue = StandardQueue()
    publisher = OutboxPublisher(repository, queue)

    with pytest.raises(ConditionalWriteError):
        publisher.publish_pending(1)
    assert repository.list_pending(1) == (event,)

    publisher.publish_pending(1)

    assert queue.envelopes == [
        (event.event_id, event.idempotency_key),
        (event.event_id, event.idempotency_key),
    ]
    assert repository.list_pending(1) == ()
