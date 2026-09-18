"""Verify incremental export resume behavior around queue failures."""

from __future__ import annotations

from pathlib import Path

import pytest

from contracts.registry import DatasetRegistry
from tests.unit.application.test_export_incremental import (
    _dataset_version,
    export_service,
    request,
    window,
)


def test_send_failure_does_not_advance_export_watermark(tmp_path: Path) -> None:
    """A queue outage must leave the window eligible for a replay."""
    service, dependencies = export_service(tmp_path)
    dependencies.queue.failure = RuntimeError("unavailable")

    with pytest.raises(RuntimeError, match="unavailable"):
        service.execute(request(window=window()))

    assert (
        dependencies.commits.get_watermark(
            _dataset_version(DatasetRegistry.load_argus_v2()), "export:signal_bucket"
        )
        is None
    )
    assert dependencies.effects == [
        "lease.acquire",
        "store.publish",
        "queue.send",
        "lease.release",
    ]


def test_retry_reuses_identical_manifest_and_advances_once(tmp_path: Path) -> None:
    """Recreating a batch identity on retry would make downstream ingestion ambiguous."""
    service, dependencies = export_service(tmp_path)
    dependencies.queue.failures_remaining = 1

    with pytest.raises(RuntimeError, match="planned queue failure"):
        service.execute(request(window=window()))
    result = service.execute(request(window=window()))

    assert result.batch_id == dependencies.store.manifests[0].batch_id
    assert dependencies.queue.successful_sends == 1
    assert len(dependencies.leases.acquisitions) == 2
    assert len(dependencies.leases.releases) == 2
    assert dependencies.leases.leases == {}
    assert dependencies.effects == [
        "lease.acquire",
        "store.publish",
        "queue.send",
        "lease.release",
        "lease.acquire",
        "store.publish",
        "queue.send",
        "watermark.commit",
        "lease.release",
    ]
