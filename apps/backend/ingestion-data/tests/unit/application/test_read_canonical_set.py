"""Verify canonical projection input is bounded and marker-authorized."""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import cast

import pytest

import adapters.archive.parquet as parquet_module
from adapters.archive.parquet import PyArrowParquetEncoder, schema_fingerprint_for_descriptor
from adapters.archive.s3 import ArchiveChecksumMismatch, S3ArchiveStore
from application.read_canonical_set import CanonicalRecordSourceError, ReadCanonicalSet
from contracts.argus.v2.normalizers import normalize_row
from contracts.registry import EXPECTED_ARGUS_V2_DATASETS, DatasetRegistry
from domain.archive import canonical_archive_key
from domain.canonical_set import (
    MAX_CANONICAL_OBJECT_BYTES,
    CanonicalDatasetEvidence,
    CanonicalObjectEvidence,
    CanonicalPartitionEvidence,
    CanonicalSet,
    canonical_set_aggregate_digest,
)
from domain.models import CanonicalRecord
from ports import ArchiveObject, ArchivePartition, ArchiveState

PARTITION = "year=2026/month=09/day=01"
DATASET_VERSION = "dsv_canonical"
SOURCE_SHA = "d" * 64
SNAPSHOT_DATE = date(2026, 9, 1)


def _record() -> CanonicalRecord:
    descriptor = DatasetRegistry.load_argus_v2().require("app_error")
    return normalize_row(
        descriptor,
        {
            "timestamp": 1_788_220_800_000,
            "error_code": "E-42",
            "manufacturer": "Acme",
            "errors": 7,
            "devices": 1,
        },
    )


def _canonical_set(
    *,
    row_count: int = 1,
    byte_count: int = 7,
    object_sha: str = "a" * 64,
) -> CanonicalSet:
    descriptor = DatasetRegistry.load_argus_v2().require("app_error")
    logical = CanonicalObjectEvidence("", row_count, byte_count, object_sha)
    populated = CanonicalDatasetEvidence(
        "app_error",
        row_count,
        row_count,
        0,
        schema_fingerprint_for_descriptor(descriptor),
        "COMPLETE",
        (CanonicalPartitionEvidence("app_error", PARTITION, row_count, (logical,)),),
    )
    datasets = tuple(
        populated
        if name == "app_error"
        else CanonicalDatasetEvidence(name, 0, 0, 0, "b" * 64, "COMPLETE", ())
        for name in EXPECTED_ARGUS_V2_DATASETS
    )
    digest = canonical_set_aggregate_digest(
        schema_version="1.0",
        dataset_version=DATASET_VERSION,
        source_sha256=SOURCE_SHA,
        contract_version="2.0",
        snapshot_extracted_on=SNAPSHOT_DATE,
        datasets=datasets,
        total_source_rows=row_count,
        total_accepted_rows=row_count,
        total_rejected_rows=0,
    )
    finalized = tuple(
        replace(
            item,
            partitions=(
                replace(
                    item.partitions[0],
                    objects=(
                        replace(
                            logical,
                            object_key=canonical_archive_key(
                                DATASET_VERSION,
                                "app_error",
                                PARTITION,
                                object_sha,
                                aggregate_digest=digest,
                                ordinal=0,
                            ),
                        ),
                    ),
                ),
            ),
        )
        if item.dataset == "app_error"
        else item
        for item in datasets
    )
    return CanonicalSet(
        "1.0",
        DATASET_VERSION,
        SOURCE_SHA,
        "2.0",
        SNAPSHOT_DATE,
        digest,
        finalized,
        row_count,
        row_count,
        0,
    )


def _archive(
    value: CanonicalSet, *, state: ArchiveState = ArchiveState.AVAILABLE
) -> ArchivePartition:
    dataset = next(item for item in value.datasets if item.dataset == "app_error")
    evidence = dataset.partitions[0]
    start = datetime(2026, 9, 1, tzinfo=UTC)
    counts = {"accepted": evidence.row_count, "rejected": 0, "persisted": evidence.row_count}
    return ArchivePartition(
        value.dataset_version,
        "app_error",
        evidence.partition,
        state,
        {
            "interval": {
                "start": start.isoformat().replace("+00:00", "Z"),
                "end": (start + timedelta(days=1)).isoformat().replace("+00:00", "Z"),
            },
            "counts": counts,
            "objects": tuple(
                {
                    "objectKey": item.object_key,
                    "rowCount": item.row_count,
                    "byteCount": item.byte_count,
                    "sha256": item.sha256,
                }
                for item in evidence.objects
            ),
            "aggregateDigest": value.aggregate_digest,
            "reconciliation": {
                "state": "PASSED",
                "expected": counts,
                "observed": counts,
                "reconciledAt": "2026-09-09T00:00:00Z",
            },
            "expirationEligible": True,
            "hotItemCount": 0,
            "catalogGeneration": 1,
            "catalogDigest": value.aggregate_digest,
        },
    )


class Partitions:
    def __init__(self, values: Iterable[ArchivePartition]) -> None:
        self.values = tuple(values)

    def query(self, dataset_version: str, dataset: str) -> tuple[ArchivePartition, ...]:
        return tuple(
            value
            for value in self.values
            if (value.dataset_version, value.dataset) == (dataset_version, dataset)
        )


class Downloader:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload
        self.calls: list[tuple[str, str, int]] = []

    def download(
        self,
        key: str,
        destination: Path,
        *,
        expected_sha256: str,
        expected_size: int,
    ) -> ArchiveObject:
        self.calls.append((key, expected_sha256, expected_size))
        destination.write_bytes(self.payload)
        return ArchiveObject(key, hashlib.sha256(self.payload).hexdigest(), len(self.payload))


class BoundedParquet:
    def __init__(self, records: tuple[CanonicalRecord, ...]) -> None:
        self.records = records
        self.batch_sizes: list[int] = []

    def iter_batches(
        self,
        path: Path,
        descriptor: object,
        *,
        dataset_version: str,
        partition: str,
        expected_row_count: int,
        expected_schema_fingerprint: str,
        batch_size: int,
    ) -> Iterable[tuple[CanonicalRecord, ...]]:
        del path, descriptor, dataset_version, partition, expected_row_count
        assert expected_schema_fingerprint == schema_fingerprint_for_descriptor(
            DatasetRegistry.load_argus_v2().require("app_error")
        )
        self.batch_sizes.append(batch_size)
        for offset in range(0, len(self.records), batch_size):
            yield self.records[offset : offset + batch_size]


def test_reads_only_marker_keys_in_bounded_batches_after_available_preflight(
    tmp_path: Path,
) -> None:
    payload = b"archive"
    value = _canonical_set(
        row_count=3,
        byte_count=len(payload),
        object_sha=hashlib.sha256(payload).hexdigest(),
    )
    records = (_record(), _record(), _record())
    downloader = Downloader(payload)
    parquet = BoundedParquet(records)
    source = ReadCanonicalSet(
        DatasetRegistry.load_argus_v2(),
        Partitions((_archive(value),)),
        downloader,
        parquet,
        tmp_path,
    )

    batches = tuple(source.iter_batches(value, batch_size=2))

    evidence = next(item for item in value.datasets if item.dataset == "app_error").partitions[0]
    assert downloader.calls == [
        (evidence.objects[0].object_key, evidence.objects[0].sha256, len(payload))
    ]
    assert [len(next(iter(batch.values()))) for batch in batches] == [2, 1]
    assert parquet.batch_sizes == [2]
    assert not tuple(tmp_path.rglob("*.parquet"))


@pytest.mark.parametrize(
    "state", tuple(item for item in ArchiveState if item is not ArchiveState.AVAILABLE)
)
def test_rejects_non_available_partition_before_download(
    tmp_path: Path, state: ArchiveState
) -> None:
    payload = b"archive"
    value = _canonical_set(byte_count=len(payload), object_sha=hashlib.sha256(payload).hexdigest())
    downloader = Downloader(payload)
    source = ReadCanonicalSet(
        DatasetRegistry.load_argus_v2(),
        Partitions((_archive(value, state=state),)),
        downloader,
        BoundedParquet((_record(),)),
        tmp_path,
    )

    with pytest.raises(CanonicalRecordSourceError, match="AVAILABLE"):
        tuple(source.iter_batches(value))

    assert downloader.calls == []


@pytest.mark.parametrize("mutation", ("missing", "count", "object", "digest"))
def test_partition_drift_fails_before_any_download(tmp_path: Path, mutation: str) -> None:
    payload = b"archive"
    value = _canonical_set(byte_count=len(payload), object_sha=hashlib.sha256(payload).hexdigest())
    archive = _archive(value)
    if mutation == "missing":
        values: tuple[ArchivePartition, ...] = ()
    else:
        metadata = dict(archive.metadata)
        if mutation == "count":
            metadata["counts"] = {"accepted": 2, "rejected": 0, "persisted": 1}
        elif mutation == "object":
            metadata["objects"] = ()
        else:
            metadata["catalogDigest"] = "f" * 64
        values = (replace(archive, metadata=metadata),)
    downloader = Downloader(payload)
    source = ReadCanonicalSet(
        DatasetRegistry.load_argus_v2(),
        Partitions(values),
        downloader,
        BoundedParquet((_record(),)),
        tmp_path,
    )

    with pytest.raises((CanonicalRecordSourceError, ValueError)):
        tuple(source.iter_batches(value))

    assert downloader.calls == []


def test_reader_accepts_legacy_v2_partition_metadata_with_projection_count(
    tmp_path: Path,
) -> None:
    payload = b"archive"
    value = _canonical_set(byte_count=len(payload), object_sha=hashlib.sha256(payload).hexdigest())
    archive = _archive(value)
    metadata = {**dict(archive.metadata), "projectionItemCount": 2}
    downloader = Downloader(payload)
    source = ReadCanonicalSet(
        DatasetRegistry.load_argus_v2(),
        Partitions((replace(archive, metadata=metadata),)),
        downloader,
        BoundedParquet((_record(),)),
        tmp_path,
    )

    batches = tuple(source.iter_batches(value))

    assert len(batches) == 1
    assert len(downloader.calls) == 1


class StreamingBody:
    def __init__(self, value: bytes) -> None:
        self.value = value
        self.offset = 0
        self.requests: list[int] = []

    def read(self, size: int) -> bytes:
        self.requests.append(size)
        chunk = self.value[self.offset : self.offset + size]
        self.offset += len(chunk)
        return chunk

    def close(self) -> None:
        return None


class DownloadClient:
    def __init__(self, key: str, payload: bytes, *, content_length: int | None = None) -> None:
        self.key = key
        self.payload = payload
        self.content_length = len(payload) if content_length is None else content_length
        self.body = StreamingBody(payload)
        self.calls: list[dict[str, object]] = []

    def get_object(self, **kwargs: object) -> Mapping[str, object]:
        self.calls.append(dict(kwargs))
        assert kwargs["Key"] == self.key
        return {"Body": self.body, "ContentLength": self.content_length}


def test_s3_download_streams_with_expected_owner_and_validates_sha_and_size(tmp_path: Path) -> None:
    payload = b"canonical-object"
    value = _canonical_set(byte_count=len(payload), object_sha=hashlib.sha256(payload).hexdigest())
    item = (
        next(dataset for dataset in value.datasets if dataset.dataset == "app_error")
        .partitions[0]
        .objects[0]
    )
    client = DownloadClient(item.object_key, payload)
    store = S3ArchiveStore(
        cast(object, client),
        "archive-bucket",
        expected_bucket_owner="123456789012",
    )
    destination = tmp_path / "download.parquet"

    observed = store.download(
        item.object_key,
        destination,
        expected_sha256=item.sha256,
        expected_size=item.byte_count,
        chunk_size=4,
    )

    assert observed == ArchiveObject(item.object_key, item.sha256, item.byte_count)
    assert destination.read_bytes() == payload
    assert client.calls == [
        {
            "Bucket": "archive-bucket",
            "Key": item.object_key,
            "ExpectedBucketOwner": "123456789012",
            "ChecksumMode": "ENABLED",
        }
    ]
    assert max(client.body.requests) == 4


@pytest.mark.parametrize("mismatch", ("size", "sha256"))
def test_s3_download_rejects_marker_evidence_mismatch_and_removes_partial_file(
    tmp_path: Path, mismatch: str
) -> None:
    payload = b"canonical-object"
    expected_sha = hashlib.sha256(payload).hexdigest()
    value = _canonical_set(byte_count=len(payload), object_sha=expected_sha)
    item = (
        next(dataset for dataset in value.datasets if dataset.dataset == "app_error")
        .partitions[0]
        .objects[0]
    )
    downloaded = payload + b"x" if mismatch == "size" else b"canonical-objecx"
    content_length = len(payload)
    client = DownloadClient(item.object_key, downloaded, content_length=content_length)
    store = S3ArchiveStore(
        cast(object, client),
        "archive-bucket",
        expected_bucket_owner="123456789012",
    )
    destination = tmp_path / "download.parquet"

    with pytest.raises(ArchiveChecksumMismatch):
        store.download(
            item.object_key,
            destination,
            expected_sha256=item.sha256,
            expected_size=item.byte_count,
            chunk_size=4,
        )

    assert not destination.exists()


def test_parquet_reader_uses_iter_batches_for_a_512_mib_object(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("app_error")
    path = tmp_path / "bounded.parquet"
    with path.open("wb") as stream:
        stream.truncate(MAX_CANONICAL_OBJECT_BYTES)
    calls: list[int] = []

    class Footer:
        num_rows = 0

    class SpyParquetFile:
        metadata = Footer()
        schema_arrow = parquet_module.schema_for_descriptor(descriptor)

        def __init__(self, observed: Path) -> None:
            assert observed == path

        def iter_batches(self, *, batch_size: int):  # type: ignore[no-untyped-def]
            calls.append(batch_size)
            return iter(())

        def read(self, *_args: object, **_kwargs: object) -> object:
            raise AssertionError("full-file read is forbidden")

        def read_row_group(self, *_args: object, **_kwargs: object) -> object:
            raise AssertionError("row-group materialization is forbidden")

    monkeypatch.setattr(parquet_module.pq, "ParquetFile", SpyParquetFile)
    monkeypatch.setattr(
        parquet_module.pq,
        "read_table",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("read_table is forbidden")),
    )
    monkeypatch.setattr(
        parquet_module,
        "read_partition",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("read_partition is forbidden")
        ),
    )
    monkeypatch.setattr(
        parquet_module,
        "_iter_partition",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("full partition materialization is forbidden")
        ),
    )

    batches = tuple(
        PyArrowParquetEncoder().iter_batches(
            path,
            descriptor,
            dataset_version=DATASET_VERSION,
            partition=PARTITION,
            expected_row_count=0,
            expected_schema_fingerprint=schema_fingerprint_for_descriptor(descriptor),
            batch_size=2_048,
        )
    )

    assert batches == ()
    assert calls == [2_048]


def test_parquet_reader_rejects_footer_schema_dataset_version_and_partition_drift(
    tmp_path: Path,
) -> None:
    registry = DatasetRegistry.load_argus_v2()
    descriptor = registry.require("app_error")
    record = _record()
    encoded = PyArrowParquetEncoder().write_partition(
        (record,),
        descriptor,
        tmp_path / "real.parquet",
        dataset_version=DATASET_VERSION,
        expected_absent=True,
        idempotency_key="reader-validation",
    )
    reader = PyArrowParquetEncoder()

    with pytest.raises(ValueError, match="row count"):
        tuple(
            reader.iter_batches(
                encoded.path,
                descriptor,
                dataset_version=DATASET_VERSION,
                partition=PARTITION,
                expected_row_count=2,
                expected_schema_fingerprint=encoded.schema_fingerprint or "",
                batch_size=1,
            )
        )
    with pytest.raises(ValueError, match="schema"):
        tuple(
            reader.iter_batches(
                encoded.path,
                descriptor,
                dataset_version=DATASET_VERSION,
                partition=PARTITION,
                expected_row_count=1,
                expected_schema_fingerprint="f" * 64,
                batch_size=1,
            )
        )
    with pytest.raises(ValueError, match="dataset version"):
        tuple(
            reader.iter_batches(
                encoded.path,
                descriptor,
                dataset_version="dsv_other",
                partition=PARTITION,
                expected_row_count=1,
                expected_schema_fingerprint=encoded.schema_fingerprint or "",
                batch_size=1,
            )
        )
    with pytest.raises(ValueError, match="partition"):
        tuple(
            reader.iter_batches(
                encoded.path,
                descriptor,
                dataset_version=DATASET_VERSION,
                partition="year=2026/month=09/day=02",
                expected_row_count=1,
                expected_schema_fingerprint=encoded.schema_fingerprint or "",
                batch_size=1,
            )
        )
