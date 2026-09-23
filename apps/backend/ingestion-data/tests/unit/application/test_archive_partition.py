"""Verify archive partition keys use canonical dataset event-time boundaries."""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path

import pytest

from adapters.archive.parquet import schema_fingerprint_for_descriptor
from application.archive_partition import (
    ArchivePartitionPublisher,
    ArchivePublicationError,
    archive_partition_key,
)
from contracts.argus.v2.normalizers import normalize_row
from contracts.registry import DatasetRegistry
from domain.archive import canonical_archive_key, canonical_staging_archive_key, partition_date
from ports import ArchiveObject, ArchivePartition, ArchiveState, EncodedPartition
from tests.fakes import (
    FakeArchiveObjectStore,
    FakeArchivePartitionRepository,
    FakeAthenaValidator,
    FakeGlueCatalog,
    FakeHotExpirationRepository,
    FakeIngestionBackend,
)

PARTITION = "year=2026/month=09/day=01"
NOW = datetime(2026, 9, 9, 12, tzinfo=UTC)


def _canonical_metadata(
    *,
    sha256: str,
    byte_count: int = 99,
    row_count: int = 7,
    generation: str = "b" * 64,
    dataset_version: str = "dsv_a",
    dataset: str = "app_error",
    partition: str = PARTITION,
) -> dict[str, object]:
    day = partition_date(partition)
    start = datetime.combine(day, time.min, tzinfo=UTC)
    key = canonical_archive_key(
        dataset_version,
        dataset,
        partition,
        sha256,
        aggregate_digest=generation,
        ordinal=0,
    )
    return {
        "interval": {
            "start": start.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "end": (start + timedelta(days=1))
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
        },
        "counts": {"accepted": row_count, "rejected": 0, "persisted": row_count},
        "objects": (
            {
                "objectKey": key,
                "rowCount": row_count,
                "byteCount": byte_count,
                "sha256": sha256,
            },
        ),
        "aggregateDigest": generation,
        "reconciliation": {"state": "PENDING"},
        "expirationEligible": False,
        "hotItemCount": 0,
        "catalogGeneration": 1,
        "catalogDigest": None,
    }


def test_event_time_descriptor_uses_the_canonical_utc_observation_day() -> None:
    """Using local time here would place edge-of-day events in the wrong Athena partition."""
    descriptor = DatasetRegistry.load_argus_v2().require("app_error")
    record = normalize_row(
        descriptor,
        {
            "timestamp": 1788220800000,
            "error_code": "E-42",
            "manufacturer": "Acme",
            "errors": 7,
            "devices": None,
        },
    )

    assert archive_partition_key(record, descriptor, snapshot_date=date(2026, 9, 1)) == (
        "year=2026/month=09/day=01"
    )


def test_snapshot_descriptor_uses_the_snapshot_extraction_date() -> None:
    """A state dataset has no event-time archive axis, even when it stores a last-seen time."""
    descriptor = DatasetRegistry.load_argus_v2().require("signal_meta")
    record = normalize_row(
        descriptor,
        {
            "source": "apollo",
            "last_ingested_ts": 1788220800000,
            "last_run_at": None,
            "rows_total": 10,
            "rows_last_run": 1,
        },
    )

    assert archive_partition_key(record, descriptor, snapshot_date=date(2026, 9, 1)) == (
        "snapshot_date=2026-09-01"
    )


def test_canonical_staging_key_is_run_independent_and_ordinal_scoped() -> None:
    assert canonical_staging_archive_key("dsv_a", "app_error", PARTITION, "a" * 64, ordinal=7) == (
        "staging/canonical/dsv_a/app_error/year=2026/month=09/day=01/"
        "part-00007-" + "a" * 64 + ".parquet"
    )


def test_canonical_publish_reconciles_objects_before_available_and_reuses_available(
    tmp_path: Path,
) -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("app_error")
    encoded = EncodedPartition(
        tmp_path / "part.parquet",
        7,
        99,
        "a" * 64,
        dataset="app_error",
        dataset_version="dsv_a",
        schema_version="1.0",
        schema_fingerprint=schema_fingerprint_for_descriptor(descriptor),
    )
    archive = ArchivePartition(
        "dsv_a",
        "app_error",
        PARTITION,
        ArchiveState.STAGING,
        _canonical_metadata(sha256=encoded.sha256),
    )
    backend = FakeIngestionBackend()
    calls: list[str] = []

    class Objects(FakeArchiveObjectStore):
        def promote(self, *args: object, **kwargs: object) -> ArchiveObject:
            calls.append("promote")
            return super().promote(*args, **kwargs)  # type: ignore[arg-type]

    class Catalog(FakeGlueCatalog):
        def register_partition(self, *args: object, **kwargs: object) -> None:
            calls.append("glue")
            return super().register_partition(*args, **kwargs)  # type: ignore[arg-type]

    class Athena(FakeAthenaValidator):
        def validate_partition(self, *args: object, **kwargs: object) -> int:
            calls.append("athena")
            return super().validate_partition(*args, **kwargs)  # type: ignore[arg-type]

    class Partitions(FakeArchivePartitionRepository):
        def update_state(self, *args: object, **kwargs: object) -> ArchivePartition:
            result = super().update_state(*args, **kwargs)  # type: ignore[arg-type]
            if result.state is ArchiveState.AVAILABLE:
                calls.append("available")
            return result

    objects = Objects()
    publisher = ArchivePartitionPublisher(
        objects,
        Catalog(),
        Athena({("app_error", "dsv_a", PARTITION): 7}),
        Partitions(backend),
        FakeHotExpirationRepository(backend),
        "archive-bucket",
        lambda: NOW,
        schema_fingerprint_for_descriptor,
    )
    staged_key = canonical_staging_archive_key(
        "dsv_a", "app_error", PARTITION, encoded.sha256, ordinal=0
    )
    objects.objects[staged_key] = ArchiveObject(staged_key, encoded.sha256, encoded.byte_size)
    staged = (objects.objects[staged_key],)

    first = publisher.publish_canonical(
        staged,
        descriptor,
        archive,
        idempotency_key="canonical-a",
    )
    objects.objects.pop(staged_key)
    replay = publisher.publish_canonical(
        (),
        descriptor,
        archive,
        idempotency_key="canonical-replay",
    )

    assert first == replay
    assert replay.state is ArchiveState.AVAILABLE
    assert replay.metadata["hotItemCount"] == 0
    assert "projectionItemCount" not in replay.metadata
    assert calls == ["promote", "glue", "athena", "available"]


def test_canonical_pre_marker_replay_reads_10417_partitions_in_linear_work() -> None:
    partition_count = 10_417
    dataset_version = "dsv_scale"
    dataset = "app_error"
    generation = "b" * 64
    checksum = "a" * 64
    descriptor = DatasetRegistry.load_argus_v2().require(dataset)
    backend = FakeIngestionBackend()
    objects = FakeArchiveObjectStore()
    requested: list[ArchivePartition] = []

    for offset in range(partition_count):
        day = date(1998, 1, 1) + timedelta(days=offset)
        partition = f"year={day:%Y}/month={day:%m}/day={day:%d}"
        pending = _canonical_metadata(
            sha256=checksum,
            row_count=1,
            generation=generation,
            dataset_version=dataset_version,
            dataset=dataset,
            partition=partition,
        )
        archive = ArchivePartition(
            dataset_version,
            dataset,
            partition,
            ArchiveState.STAGING,
            pending,
        )
        requested.append(archive)
        available = dict(pending)
        counts = dict(available["counts"])  # type: ignore[arg-type]
        available["reconciliation"] = {
            "state": "PASSED",
            "expected": counts,
            "observed": counts,
            "reconciledAt": "2026-09-09T12:00:00.000Z",
        }
        available["expirationEligible"] = True
        available["catalogDigest"] = generation
        backend.archive_partitions[(dataset_version, dataset, partition)] = ArchivePartition(
            dataset_version,
            dataset,
            partition,
            ArchiveState.AVAILABLE,
            available,
        )
        object_key = available["objects"][0]["objectKey"]  # type: ignore[index]
        objects.objects[object_key] = ArchiveObject(object_key, checksum, 99)  # type: ignore[arg-type]

    class CountingPartitions(FakeArchivePartitionRepository):
        def __init__(self) -> None:
            super().__init__(backend)
            self.get_calls = 0
            self.get_items = 0
            self.query_calls = 0
            self.query_items = 0

        def get(
            self, dataset_version: str, dataset: str, partition: str
        ) -> ArchivePartition | None:
            self.get_calls += 1
            result = self.partitions.get((dataset_version, dataset, partition))
            self.get_items += int(result is not None)
            return result

        def query(self, dataset_version: str, dataset: str) -> tuple[ArchivePartition, ...]:
            result = super().query(dataset_version, dataset)
            self.query_calls += 1
            self.query_items += len(result)
            if self.query_calls > 1:
                raise AssertionError("canonical replay reread the complete partition catalog")
            return result

    partitions = CountingPartitions()
    publisher = ArchivePartitionPublisher(
        objects,
        FakeGlueCatalog(),
        FakeAthenaValidator({}),
        partitions,
        FakeHotExpirationRepository(backend),
        "archive-bucket",
        lambda: NOW,
        schema_fingerprint_for_descriptor,
    )

    for ordinal, archive in enumerate(requested):
        assert publisher.preflight_canonical(descriptor, archive) is not None
        replay = publisher.publish_canonical(
            (),
            descriptor,
            archive,
            idempotency_key=f"pre-marker-replay-{ordinal}",
        )
        assert replay.state is ArchiveState.AVAILABLE

    assert partitions.query_calls == partitions.query_items == 0
    assert partitions.get_calls == 2 * partition_count
    assert partitions.get_items == 2 * partition_count


def test_canonical_available_replay_rejects_a_conflicting_catalog_digest_without_staging(
    tmp_path: Path,
) -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("app_error")
    backend = FakeIngestionBackend()
    objects = FakeArchiveObjectStore()
    publisher = ArchivePartitionPublisher(
        objects,
        FakeGlueCatalog(),
        FakeAthenaValidator({("app_error", "dsv_a", PARTITION): 7}),
        FakeArchivePartitionRepository(backend),
        FakeHotExpirationRepository(backend),
        "archive-bucket",
        lambda: NOW,
        schema_fingerprint_for_descriptor,
    )
    archive = ArchivePartition(
        "dsv_a",
        "app_error",
        PARTITION,
        ArchiveState.STAGING,
        _canonical_metadata(sha256="a" * 64),
    )
    staged_key = canonical_staging_archive_key("dsv_a", "app_error", PARTITION, "a" * 64, ordinal=0)
    staged = ArchiveObject(staged_key, "a" * 64, 99)
    objects.objects[staged_key] = staged
    published = publisher.publish_canonical(
        (staged,), descriptor, archive, idempotency_key="publish"
    )
    identity = ("dsv_a", "app_error", PARTITION)
    metadata = dict(published.metadata)
    metadata["catalogDigest"] = "c" * 64
    backend.archive_partitions[identity] = ArchivePartition(
        published.dataset_version,
        published.dataset,
        published.partition,
        published.state,
        metadata,
    )
    objects.objects.pop(staged_key)

    with pytest.raises(ArchivePublicationError, match="catalogDigest"):
        publisher.publish_canonical(
            (), descriptor, archive, idempotency_key="replay-conflicting-catalog"
        )


def test_canonical_publish_rejects_changed_checksum_for_available_identity(
    tmp_path: Path,
) -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("app_error")
    backend = FakeIngestionBackend()
    objects = FakeArchiveObjectStore()
    publisher = ArchivePartitionPublisher(
        objects,
        FakeGlueCatalog(),
        FakeAthenaValidator({("app_error", "dsv_a", PARTITION): 7}),
        FakeArchivePartitionRepository(backend),
        FakeHotExpirationRepository(backend),
        "archive-bucket",
        lambda: NOW,
        schema_fingerprint_for_descriptor,
    )

    def publish(sha256: str, key: str) -> ArchivePartition:
        archive = ArchivePartition(
            "dsv_a",
            "app_error",
            PARTITION,
            ArchiveState.STAGING,
            _canonical_metadata(sha256=sha256),
        )
        staged_key = canonical_staging_archive_key(
            "dsv_a", "app_error", PARTITION, sha256, ordinal=0
        )
        staged = ArchiveObject(staged_key, sha256, 99)
        objects.objects[staged_key] = staged
        return publisher.publish_canonical((staged,), descriptor, archive, idempotency_key=key)

    publish("a" * 64, "first")
    with pytest.raises(ArchivePublicationError, match="differs"):
        publish("c" * 64, "changed")


def test_canonical_publish_rejects_an_empty_logical_partition_before_side_effects() -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("app_error")
    backend = FakeIngestionBackend()
    metadata = _canonical_metadata(sha256="a" * 64, row_count=0)
    metadata["objects"] = ()
    archive = ArchivePartition(
        "dsv_a",
        "app_error",
        PARTITION,
        ArchiveState.STAGING,
        metadata,
    )
    publisher = ArchivePartitionPublisher(
        FakeArchiveObjectStore(),
        FakeGlueCatalog(),
        FakeAthenaValidator({}),
        FakeArchivePartitionRepository(backend),
        FakeHotExpirationRepository(backend),
        "archive-bucket",
        lambda: NOW,
        schema_fingerprint_for_descriptor,
    )

    with pytest.raises(ArchivePublicationError, match="at least one"):
        publisher.publish_canonical((), descriptor, archive, idempotency_key="empty")

    assert backend.archive_partitions == {}
