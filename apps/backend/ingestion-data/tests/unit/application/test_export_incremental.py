"""Verify the incremental raw export application boundary."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path

import pytest

from application.export_incremental import ExportIncremental, ExportIncrementalRequest
from contracts.registry import DatasetRegistry
from domain.identity import dataset_version
from domain.incremental_batches import IncrementalBatchDefinition, PhysicalColumn
from domain.models import TimeWindow
from tests.fakes import (
    FakeIncrementalBatchQueue,
    FakeIncrementalBatchStore,
    FakeIncrementalExportSource,
    FakeLeaseRepository,
    FakeManifestRepository,
    FakeRawBatchCodec,
    FakeWindowCommitRepository,
    valid_active_manifest,
)

_DUMP_SHA256 = "c1d86081679d66c392b63710bda4517b047f029c5403ad1502d731ab5ac126ea"


def _at(minute: int) -> datetime:
    return datetime(2026, 9, 1, 0, minute, tzinfo=UTC)


def window() -> TimeWindow:
    return TimeWindow(_at(0), _at(15), 900)


@dataclass(frozen=True, slots=True)
class ExportDependencies:
    store: FakeIncrementalBatchStore
    queue: FakeIncrementalBatchQueue
    commits: FakeWindowCommitRepository
    leases: FakeLeaseRepository
    effects: list[str]


def _dataset_version(registry: DatasetRegistry) -> str:
    snapshot = registry.snapshot
    return dataset_version(
        str(snapshot["sourceSystem"]),
        _DUMP_SHA256,
        str(snapshot["physicalContractVersion"]),
        str(snapshot["canonicalSchemaVersion"]),
    )


def export_service(
    tmp_path: Path, *, rows: tuple[dict[str, object], ...] | None = None
) -> tuple[ExportIncremental, ExportDependencies]:
    registry = DatasetRegistry.load_argus_v2()
    version = _dataset_version(registry)
    source = FakeIncrementalExportSource(
        (
            PhysicalColumn("bucket_ts", "BIGINT", False, 1),
            PhysicalColumn("sinal", "VARCHAR(64)", False, 2),
        ),
        (
            {"bucket_ts": 1, "sinal": "alpha"},
            {"bucket_ts": 2, "sinal": "beta"},
        )
        if rows is None
        else rows,
    )
    effects: list[str] = []
    store = FakeIncrementalBatchStore(effects=effects)
    queue = FakeIncrementalBatchQueue(effects=effects)
    commits = FakeWindowCommitRepository(effects=effects)
    leases = FakeLeaseRepository(effects=effects)
    service = ExportIncremental(
        registry,
        FakeManifestRepository(
            valid_active_manifest(
                registry.names(),
                version,
                source_watermark=window().start,
                physical_contract_version=str(registry.snapshot["physicalContractVersion"]),
                canonical_schema_version=str(registry.snapshot["canonicalSchemaVersion"]),
                dump_checksum_sha256=_DUMP_SHA256,
            )
        ),
        source,
        FakeRawBatchCodec(),
        store,
        queue,
        commits,
        leases,
        workdir=tmp_path,
        clock=lambda: _at(0),
    )
    return service, ExportDependencies(store, queue, commits, leases, effects)


def request(*, window: TimeWindow) -> ExportIncrementalRequest:
    return ExportIncrementalRequest(
        _dataset_version(DatasetRegistry.load_argus_v2()),
        IncrementalBatchDefinition("argus", "signal_bucket", window, 0, "1.0"),
        page_size=1,
        lease_ttl_seconds=60,
    )


def test_export_publishes_manifest_then_message_then_watermark(tmp_path: Path) -> None:
    """Committing before the queue accepts the reference would lose a batch."""
    service, dependencies = export_service(tmp_path)

    result = service.execute(request(window=window()))

    assert result.batch_id.startswith("bat_")
    assert result.row_count == 2
    assert dependencies.store.published[0].source_dataset == "signal_bucket"
    assert dependencies.queue.sent[0].batch_id == result.batch_id
    assert (
        dependencies.commits.get_watermark(
            _dataset_version(DatasetRegistry.load_argus_v2()), "export:signal_bucket"
        )
        == window().end
    )
    assert dependencies.effects == [
        "lease.acquire",
        "store.publish",
        "queue.send",
        "watermark.commit",
        "lease.release",
    ]


def test_export_rejects_mismatched_source_system_before_any_effect(tmp_path: Path) -> None:
    """Publishing ARGUS rows under another source identity would corrupt batch provenance."""
    service, dependencies = export_service(tmp_path)
    valid = request(window=window())
    invalid = replace(
        valid,
        definition=replace(valid.definition, source_system="not-argus"),
    )

    with pytest.raises(ValueError, match="source_system"):
        service.execute(invalid)

    assert dependencies.effects == []


def test_empty_export_releases_lease_without_publishing_or_advancing(tmp_path: Path) -> None:
    """The positive-row-count manifest contract must reject an empty source window early."""
    service, dependencies = export_service(tmp_path, rows=())

    with pytest.raises(ValueError, match="empty batch"):
        service.execute(request(window=window()))

    assert dependencies.effects == ["lease.acquire", "lease.release"]
    assert (
        dependencies.commits.get_watermark(
            _dataset_version(DatasetRegistry.load_argus_v2()), "export:signal_bucket"
        )
        is None
    )
