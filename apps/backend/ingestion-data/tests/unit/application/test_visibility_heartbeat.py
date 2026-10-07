"""Verify the visibility heartbeat of incremental queue deliveries."""

from __future__ import annotations

import threading
import time

import pytest

from application.visibility_heartbeat import VisibilityHeartbeat, VisibilityHeartbeatLost
from domain.incremental_batches import BatchDelivery, IncrementalBatchReference
from tests.fakes import FakeIncrementalBatchQueue


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def delivery(message_id: str) -> BatchDelivery:
    return BatchDelivery(
        message_id,
        "bat_" + "a" * 64,
        "signal_bucket",
        IncrementalBatchReference("bucket-name", "key", "version-1"),
        f"receipt-{message_id}",
    )


def heartbeat(
    queue: FakeIncrementalBatchQueue, clock: FakeClock, **changes: float
) -> VisibilityHeartbeat:
    options: dict[str, float] = {
        "visibility_timeout_seconds": 300,
        "check_interval_seconds": 15,
        "renew_before_seconds": 60,
    }
    options.update(changes)
    return VisibilityHeartbeat(queue, clock=clock, **options)  # type: ignore[arg-type]


def run_checks(subject: VisibilityHeartbeat, clock: FakeClock, until: float) -> None:
    while clock.now < until:
        clock.now += 15
        subject.tick()


def test_renews_only_when_sixty_seconds_or_less_remain() -> None:
    queue, clock = FakeIncrementalBatchQueue(), FakeClock()
    subject = heartbeat(queue, clock)
    subject.track((delivery("m-1"),), received_at=0.0)

    run_checks(subject, clock, until=225)
    assert queue.extensions == []

    run_checks(subject, clock, until=240)
    assert queue.extensions == [("m-1", 300)]

    run_checks(subject, clock, until=465)
    assert queue.extensions == [("m-1", 300)]

    run_checks(subject, clock, until=480)
    assert queue.extensions == [("m-1", 300), ("m-1", 300)]
    subject.check()


def test_waiting_deliveries_are_renewed_and_released_ones_are_not() -> None:
    queue, clock = FakeIncrementalBatchQueue(), FakeClock()
    subject = heartbeat(queue, clock)
    first, waiting = delivery("m-1"), delivery("m-2")
    subject.track((first, waiting), received_at=0.0)

    subject.release(first)
    run_checks(subject, clock, until=240)

    assert queue.extensions == [("m-2", 300)]


def test_renewal_failure_stops_renewals_and_check_raises() -> None:
    queue, clock = FakeIncrementalBatchQueue(), FakeClock()
    subject = heartbeat(queue, clock)
    subject.track((delivery("m-1"), delivery("m-2")), received_at=0.0)
    queue.extension_failure = RuntimeError("receipt handle has expired")

    run_checks(subject, clock, until=240)
    queue.extension_failure = None
    run_checks(subject, clock, until=480)

    assert queue.extensions == []
    with pytest.raises(VisibilityHeartbeatLost):
        subject.check()


def test_deadline_passed_before_renewal_counts_as_loss() -> None:
    queue, clock = FakeIncrementalBatchQueue(), FakeClock()
    subject = heartbeat(queue, clock)
    subject.track((delivery("m-1"),), received_at=0.0)

    clock.now = 300
    subject.tick()

    assert queue.extensions == []
    with pytest.raises(VisibilityHeartbeatLost):
        subject.check()


def test_cannot_release_a_delivery_after_a_failed_renewal() -> None:
    queue, clock = FakeIncrementalBatchQueue(), FakeClock()
    subject = heartbeat(queue, clock)
    item = delivery("m-1")
    subject.track((item,), received_at=0.0)
    queue.extension_failure = RuntimeError("receipt handle has expired")

    run_checks(subject, clock, until=240)

    with pytest.raises(VisibilityHeartbeatLost):
        subject.release(item)


@pytest.mark.parametrize(
    "changes",
    [
        {"visibility_timeout_seconds": 0},
        {"renew_before_seconds": 301},
        {"check_interval_seconds": 60},
    ],
)
def test_rejects_configuration_that_could_miss_the_deadline(changes: dict[str, float]) -> None:
    with pytest.raises(ValueError):
        heartbeat(FakeIncrementalBatchQueue(), FakeClock(), **changes)


def test_thread_renews_in_parallel_until_stopped() -> None:
    queue = FakeIncrementalBatchQueue()
    renewed = threading.Event()
    original_extend = queue.extend_visibility

    def extend(item: BatchDelivery, seconds: int) -> None:
        original_extend(item, seconds)
        renewed.set()

    queue.extend_visibility = extend  # type: ignore[method-assign]
    subject = VisibilityHeartbeat(
        queue,
        visibility_timeout_seconds=1,
        check_interval_seconds=0.01,
        renew_before_seconds=1,
        clock=time.monotonic,
    )
    subject.track((delivery("m-1"),), received_at=time.monotonic())

    subject.start()
    assert renewed.wait(5)
    subject.stop()
    count = len(queue.extensions)
    time.sleep(0.05)

    assert len(queue.extensions) == count
