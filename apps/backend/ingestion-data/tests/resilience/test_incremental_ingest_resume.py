"""Verify an incremental batch resumes after facts and outbox are durable."""

from __future__ import annotations

from domain.incremental_batches import BatchState
from tests.unit.application.test_ingest_incremental import (
    ingest_service,
    manifest,
    rebuild_service,
)


def test_crash_after_hot_write_replays_without_duplicate_fact_or_event() -> None:
    first, dependencies = ingest_service(fail_before_batch_finish=True)

    assert first.drain(limit=1).retryable == 1
    assert dependencies.queue.acked == ()
    batch_id = manifest(dependencies.registry).batch_id
    assert dependencies.batches.records[batch_id].state is BatchState.COMMITTING

    replay = rebuild_service(dependencies)
    assert replay.drain(limit=1).completed == 1
    assert len(dependencies.hot_sink.records) == 1
    assert len(dependencies.outbox.events) == 1
    assert dependencies.hot_sink.write_calls == 2
    assert dependencies.batches.counts[batch_id] == {
        "written": 0,
        "unchanged": 1,
    }
    assert dependencies.queue.acked == ("delivery-1",)
