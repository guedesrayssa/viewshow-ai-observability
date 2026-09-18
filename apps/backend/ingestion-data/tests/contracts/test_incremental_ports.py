from __future__ import annotations

import inspect

from ports.incremental import (
    IncrementalBatchObjectStore,
    IncrementalBatchQueue,
    IncrementalBatchRepository,
    IncrementalExportSource,
)


def test_incremental_ports_expose_the_minimum_boundary() -> None:
    assert inspect.signature(IncrementalExportSource.observe_schema).parameters.keys() == {
        "self",
        "descriptor",
    }
    assert inspect.signature(IncrementalExportSource.read_page).parameters.keys() == {
        "self",
        "descriptor",
        "window",
        "after",
        "limit",
    }
    assert hasattr(IncrementalBatchObjectStore, "publish")
    assert hasattr(IncrementalBatchObjectStore, "load_manifest")
    assert hasattr(IncrementalBatchObjectStore, "read_page")
    assert hasattr(IncrementalBatchQueue, "send")
    assert hasattr(IncrementalBatchQueue, "receive")
    assert hasattr(IncrementalBatchQueue, "ack")
    assert hasattr(IncrementalBatchRepository, "claim")
    assert hasattr(IncrementalBatchRepository, "transition")
    assert hasattr(IncrementalBatchRepository, "finish")
