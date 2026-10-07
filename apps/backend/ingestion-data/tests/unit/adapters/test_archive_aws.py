"""Verify AWS archive adapters publish and validate ingestion partitions."""

from __future__ import annotations

import base64
import hashlib
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import BinaryIO, cast

import pytest
from botocore.exceptions import ClientError  # type: ignore[import-untyped]
from botocore.session import get_session  # type: ignore[import-untyped]

from adapters.archive.athena import AthenaQueryError, AwsAthenaValidator
from adapters.archive.glue import AwsGlueCatalog, GlueCatalogDrift
from adapters.archive.parquet import (
    athena_schema_for_descriptor,
    schema_fingerprint_for_descriptor,
)
from adapters.archive.s3 import (
    MAX_COPY_OBJECT_SIZE,
    MAX_MULTIPART_PART_SIZE,
    MIN_MULTIPART_PART_SIZE,
    ArchiveChecksumMismatch,
    ArchiveStorageError,
    S3ArchiveStore,
    canonical_archive_key,
    staging_archive_key,
)
from application.archive_partition import ArchivePartitionPublisher, ArchivePublicationError
from contracts.registry import DatasetRegistry
from domain.archive import (
    canonical_staging_archive_key,
    legacy_canonical_archive_key,
    partition_date,
)
from ports import (
    ArchiveObject,
    ArchivePartition,
    ArchiveReconciliationError,
    ArchiveState,
    ConditionalWriteError,
    EncodedPartition,
)
from tests.fakes import (
    FakeArchiveObjectStore,
    FakeArchivePartitionRepository,
    FakeAthenaValidator,
    FakeGlueCatalog,
    FakeHotExpirationRepository,
    FakeIngestionBackend,
)

REGISTRY = DatasetRegistry.load_argus_v2()
PARTITION = "year=2026/month=09/day=01"
SNAPSHOT_PARTITION = "snapshot_date=2026-09-01"
SHA = hashlib.sha256(b"archive-body").hexdigest()
NOW = datetime(2026, 9, 9, 12, tzinfo=UTC)
OWNER = "123456789012"


def _client_error(code: str, operation: str) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": "secret upstream detail"}},
        operation,
    )


class MemoryS3:
    def __init__(self) -> None:
        self.objects: dict[str, dict[str, object]] = {}
        self.versions: dict[tuple[str, str], dict[str, object]] = {}
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.uploaded_parts: list[int] = []
        self._multipart: dict[str, object] | None = None
        self._next_version = 1
        self.swap_source_before_copy = False

    def _store(self, key: str, value: dict[str, object]) -> dict[str, object]:
        version_id = f"version-{self._next_version}"
        self._next_version += 1
        stored = {**value, "VersionId": version_id, "ETag": f'"etag-{version_id}"'}
        self.objects[key] = stored
        self.versions[(key, version_id)] = dict(stored)
        return stored

    def head_object(self, **kwargs: object) -> Mapping[str, object]:
        self.calls.append(("head_object", dict(kwargs)))
        key = cast(str, kwargs["Key"])
        try:
            return self.objects[key]
        except KeyError:
            raise _client_error("404", "HeadObject") from None

    def put_object(self, **kwargs: object) -> Mapping[str, object]:
        self.calls.append(("put_object", dict(kwargs)))
        key = cast(str, kwargs["Key"])
        if kwargs.get("IfNoneMatch") == "*" and key in self.objects:
            raise _client_error("PreconditionFailed", "PutObject")
        body = cast(BinaryIO, kwargs["Body"])
        content = body.read()
        checksum = cast(str, kwargs["ChecksumSHA256"])
        assert base64.b64encode(hashlib.sha256(content).digest()).decode() == checksum
        self._store(
            key,
            {
                "Body": content,
                "ContentLength": len(content),
                "ChecksumSHA256": checksum,
                "Metadata": dict(cast(Mapping[str, str], kwargs["Metadata"])),
            },
        )
        return {"ChecksumSHA256": checksum}

    def create_multipart_upload(self, **kwargs: object) -> Mapping[str, object]:
        self.calls.append(("create_multipart_upload", dict(kwargs)))
        self._multipart = dict(kwargs)
        return {"UploadId": "upload-1"}

    def upload_part(self, **kwargs: object) -> Mapping[str, object]:
        self.calls.append(("upload_part", dict(kwargs)))
        body = cast(bytes, kwargs["Body"])
        self.uploaded_parts.append(len(body))
        return {
            "ETag": f"etag-{kwargs['PartNumber']}",
            "ChecksumSHA256": cast(str, kwargs["ChecksumSHA256"]),
        }

    def complete_multipart_upload(self, **kwargs: object) -> Mapping[str, object]:
        self.calls.append(("complete_multipart_upload", dict(kwargs)))
        assert self._multipart is not None
        key = cast(str, kwargs["Key"])
        if kwargs.get("IfNoneMatch") == "*" and key in self.objects:
            raise _client_error("PreconditionFailed", "CompleteMultipartUpload")
        metadata = cast(Mapping[str, str], self._multipart["Metadata"])
        checksum = metadata["aws-checksum-sha256"]
        self._store(
            key,
            {
                "ContentLength": int(metadata["source-size"]),
                "ChecksumSHA256": checksum,
                "Metadata": dict(metadata),
            },
        )
        return {"ChecksumSHA256": checksum}

    def abort_multipart_upload(self, **kwargs: object) -> Mapping[str, object]:
        self.calls.append(("abort_multipart_upload", dict(kwargs)))
        return {}

    def copy_object(self, **kwargs: object) -> Mapping[str, object]:
        self.calls.append(("copy_object", dict(kwargs)))
        key = cast(str, kwargs["Key"])
        if kwargs.get("IfNoneMatch") == "*" and key in self.objects:
            raise _client_error("PreconditionFailed", "CopyObject")
        source = cast(Mapping[str, str], kwargs["CopySource"])
        source_key = source["Key"]
        if self.swap_source_before_copy:
            replacement = b"swapped-source"
            replacement_checksum = base64.b64encode(hashlib.sha256(replacement).digest()).decode()
            self._store(
                source_key,
                {
                    "Body": replacement,
                    "ContentLength": len(replacement),
                    "ChecksumSHA256": replacement_checksum,
                    "Metadata": {
                        "sha256": hashlib.sha256(replacement).hexdigest(),
                        "source-sha256": hashlib.sha256(replacement).hexdigest(),
                        "source-size": str(len(replacement)),
                        "aws-checksum-sha256": replacement_checksum,
                        "checksum-type": "full",
                        "checksum-parts": "1",
                    },
                },
            )
            self.swap_source_before_copy = False
        version_id = source.get("VersionId")
        selected = (
            self.versions[(source_key, version_id)]
            if version_id is not None
            else self.objects[source_key]
        )
        if kwargs.get("CopySourceIfMatch") not in (None, selected["ETag"]):
            raise _client_error("PreconditionFailed", "CopyObject")
        copied = dict(selected)
        if kwargs.get("MetadataDirective") == "REPLACE":
            metadata = dict(cast(Mapping[str, str], kwargs["Metadata"]))
            copied["Metadata"] = metadata
            body = copied.get("Body")
            copied["ChecksumSHA256"] = (
                base64.b64encode(hashlib.sha256(body).digest()).decode()
                if isinstance(body, bytes)
                else metadata["aws-checksum-sha256"]
            )
        stored = self._store(key, copied)
        return {"CopyObjectResult": {"ChecksumSHA256": stored["ChecksumSHA256"]}}


def _encoded(path: Path, body: bytes = b"archive-body") -> EncodedPartition:
    path.write_bytes(body)
    return EncodedPartition(path, 1, len(body), hashlib.sha256(body).hexdigest())


def test_archive_keys_use_the_exact_staging_and_canonical_layout() -> None:
    assert staging_archive_key("run-17", "app_error", PARTITION, "a" * 64) == (
        "staging/run_id=run-17/dataset=app_error/date=2026-09-01/" + "a" * 64 + ".parquet"
    )
    assert legacy_canonical_archive_key("dsv_a", "app_error", PARTITION, "a" * 64) == (
        "canonical/schema_version=1.0/dataset_version=dsv_a/dataset=app_error/"
        "year=2026/month=09/day=01/part-" + "a" * 64 + ".parquet"
    )
    assert "snapshot_date=2026-09-01" in legacy_canonical_archive_key(
        "dsv_a", "signal_meta", SNAPSHOT_PARTITION, "a" * 64
    )
    with pytest.raises(TypeError):
        canonical_archive_key("dsv_a", "app_error", PARTITION, "a" * 64)  # type: ignore[call-arg]
    with pytest.raises(ValueError, match="component"):
        staging_archive_key("../escape", "app_error", PARTITION, "a" * 64)

    generated = canonical_archive_key(
        "dsv_a",
        "app_error",
        PARTITION,
        "a" * 64,
        aggregate_digest="b" * 64,
        ordinal=3,
    )
    assert generated == (
        "canonical/schema_version=1.0/dataset_version=dsv_a/dataset=app_error/"
        f"{PARTITION}/generation={'b' * 64}/part-00003-{'a' * 64}.parquet"
    )


def test_s3_stage_streams_file_and_translates_hex_checksum_to_aws_base64(tmp_path: Path) -> None:
    client = MemoryS3()
    partition = _encoded(tmp_path / "part.parquet")
    key = staging_archive_key("run-1", "app_error", PARTITION, partition.sha256)
    store = S3ArchiveStore(
        client,
        "archive-bucket",
        multipart_threshold=1024,
        expected_bucket_owner=OWNER,
    )

    result = store.stage(partition, key, expected_absent=True, idempotency_key="stage-1")

    put = next(payload for name, payload in client.calls if name == "put_object")
    assert put["ChecksumSHA256"] == base64.b64encode(bytes.fromhex(partition.sha256)).decode()
    assert put["ChecksumAlgorithm"] == "SHA256"
    assert put["ContentLength"] == partition.byte_size
    assert put["ExpectedBucketOwner"] == OWNER
    assert put["Metadata"] == {
        "sha256": partition.sha256,
        "source-sha256": partition.sha256,
        "source-size": str(partition.byte_size),
        "aws-checksum-sha256": base64.b64encode(bytes.fromhex(partition.sha256)).decode(),
        "checksum-type": "full",
        "checksum-parts": "1",
    }
    assert (result.key, result.sha256, result.size) == (
        key,
        partition.sha256,
        partition.byte_size,
    )
    assert result.version_id == "version-1"
    assert result.etag == '"etag-version-1"'
    assert client.calls[-1][0] == "head_object"
    assert all(
        payload["ExpectedBucketOwner"] == OWNER
        for name, payload in client.calls
        if name == "head_object"
    )


def test_archive_owner_parameters_are_supported_by_the_pinned_botocore_model() -> None:
    model = get_session().get_service_model("s3")
    expected = {
        "HeadObject": {"ExpectedBucketOwner"},
        "PutObject": {"ExpectedBucketOwner"},
        "CreateMultipartUpload": {"ExpectedBucketOwner"},
        "UploadPart": {"ExpectedBucketOwner"},
        "CompleteMultipartUpload": {"ExpectedBucketOwner"},
        "AbortMultipartUpload": {"ExpectedBucketOwner"},
        "CopyObject": {"ExpectedBucketOwner", "ExpectedSourceBucketOwner"},
    }

    for operation, owner_fields in expected.items():
        members = model.operation_model(operation).input_shape.members
        assert owner_fields <= set(members)


def test_s3_stage_accepts_deterministic_canonical_v2_key(tmp_path: Path) -> None:
    client = MemoryS3()
    partition = _encoded(tmp_path / "part-v2.parquet")
    key = canonical_staging_archive_key(
        "dsv_a", "app_error", PARTITION, partition.sha256, ordinal=2
    )

    result = S3ArchiveStore(client, "archive-bucket", expected_bucket_owner=OWNER).stage(
        partition,
        key,
        expected_absent=True,
        idempotency_key="stage-v2",
    )

    assert result.key == key
    assert [name for name, _payload in client.calls].count("put_object") == 1


def test_s3_stage_rejects_changed_local_file_before_calling_aws(tmp_path: Path) -> None:
    client = MemoryS3()
    partition = _encoded(tmp_path / "part.parquet")
    partition.path.write_bytes(b"changed")
    store = S3ArchiveStore(client, "archive-bucket", expected_bucket_owner=OWNER)

    with pytest.raises(ArchiveStorageError, match="local encoded partition"):
        store.stage(
            partition,
            staging_archive_key("run-1", "app_error", PARTITION, partition.sha256),
            expected_absent=True,
            idempotency_key="stage-corrupt",
        )
    assert client.calls == []


def test_s3_head_classifies_conflicting_physical_checksum_evidence(tmp_path: Path) -> None:
    client = MemoryS3()
    partition = _encoded(tmp_path / "part.parquet")
    key = staging_archive_key("run-1", "app_error", PARTITION, partition.sha256)
    store = S3ArchiveStore(client, "archive-bucket", expected_bucket_owner=OWNER)
    store.stage(partition, key, expected_absent=True, idempotency_key="stage-head")
    metadata = cast(dict[str, str], client.objects[key]["Metadata"])
    metadata["source-sha256"] = "0" * 64

    with pytest.raises(ArchiveChecksumMismatch, match="metadata"):
        store.head(key)


def test_s3_multipart_upload_keeps_each_buffer_bounded_and_confirms_composite_checksum(
    tmp_path: Path,
) -> None:
    client = MemoryS3()
    body = b"x" * (MIN_MULTIPART_PART_SIZE + 17)
    partition = _encoded(tmp_path / "large.parquet", body)
    store = S3ArchiveStore(
        client,
        "archive-bucket",
        multipart_threshold=MIN_MULTIPART_PART_SIZE,
        multipart_part_size=MIN_MULTIPART_PART_SIZE,
        expected_bucket_owner=OWNER,
    )

    store.stage(
        partition,
        staging_archive_key("run-1", "app_error", PARTITION, partition.sha256),
        expected_absent=True,
        idempotency_key="stage-large",
    )

    assert client.uploaded_parts == [MIN_MULTIPART_PART_SIZE, 17]
    create = next(payload for name, payload in client.calls if name == "create_multipart_upload")
    complete = next(
        payload for name, payload in client.calls if name == "complete_multipart_upload"
    )
    assert create["ChecksumType"] == "COMPOSITE"
    assert complete["ChecksumType"] == "COMPOSITE"
    part_digests = (
        hashlib.sha256(body[:MIN_MULTIPART_PART_SIZE]).digest()
        + hashlib.sha256(body[MIN_MULTIPART_PART_SIZE:]).digest()
    )
    composite = base64.b64encode(hashlib.sha256(part_digests).digest()).decode() + "-2"
    assert complete.get("ChecksumSHA256") is None
    assert cast(Mapping[str, str], create["Metadata"])["aws-checksum-sha256"] == composite
    assert all(
        payload["ExpectedBucketOwner"] == OWNER
        for name, payload in client.calls
        if name
        in {
            "head_object",
            "create_multipart_upload",
            "upload_part",
            "complete_multipart_upload",
        }
    )


def test_s3_multipart_part_checksum_divergence_is_terminal_corruption(tmp_path: Path) -> None:
    class CorruptPartChecksum(MemoryS3):
        def upload_part(self, **kwargs: object) -> Mapping[str, object]:
            result = dict(super().upload_part(**kwargs))
            result["ChecksumSHA256"] = base64.b64encode(b"x" * 32).decode()
            return result

    client = CorruptPartChecksum()
    body = b"x" * (MIN_MULTIPART_PART_SIZE + 1)
    partition = _encoded(tmp_path / "corrupt-part.parquet", body)
    store = S3ArchiveStore(
        client,
        "archive-bucket",
        multipart_threshold=1,
        multipart_part_size=MIN_MULTIPART_PART_SIZE,
        expected_bucket_owner=OWNER,
    )

    with pytest.raises(ArchiveChecksumMismatch, match="part checksum"):
        store.stage(
            partition,
            staging_archive_key("run-1", "app_error", PARTITION, partition.sha256),
            expected_absent=True,
            idempotency_key="stage-corrupt-part",
        )
    abort = next(payload for name, payload in client.calls if name == "abort_multipart_upload")
    assert abort["ExpectedBucketOwner"] == OWNER


def test_s3_uses_single_put_until_the_file_spans_multiple_parts(tmp_path: Path) -> None:
    client = MemoryS3()
    partition = _encoded(tmp_path / "one-part.parquet", b"small-enough")
    store = S3ArchiveStore(
        client,
        "archive-bucket",
        multipart_threshold=1,
        multipart_part_size=MIN_MULTIPART_PART_SIZE,
        expected_bucket_owner=OWNER,
    )

    store.stage(
        partition,
        staging_archive_key("run-1", "app_error", PARTITION, partition.sha256),
        expected_absent=True,
        idempotency_key="stage-one-part",
    )

    assert any(name == "put_object" for name, _ in client.calls)
    assert not any(name == "create_multipart_upload" for name, _ in client.calls)


def test_s3_rejects_unpromotable_size_and_invalid_part_size_before_aws() -> None:
    client = MemoryS3()
    oversized = EncodedPartition(
        Path("not-opened.parquet"),
        1,
        MAX_COPY_OBJECT_SIZE + 1,
        "a" * 64,
    )
    store = S3ArchiveStore(
        client,
        "archive-bucket",
        multipart_threshold=MAX_COPY_OBJECT_SIZE * 2,
        expected_bucket_owner=OWNER,
    )

    with pytest.raises(ValueError, match="5 GiB"):
        store.stage(
            oversized,
            staging_archive_key("run", "app_error", PARTITION, oversized.sha256),
            expected_absent=True,
            idempotency_key="oversized",
        )
    with pytest.raises(ValueError, match="at most 5 GiB"):
        S3ArchiveStore(
            client,
            "archive-bucket",
            multipart_part_size=MAX_MULTIPART_PART_SIZE + 1,
            expected_bucket_owner=OWNER,
        )
    staged = ArchiveObject(
        staging_archive_key("run", "app_error", PARTITION, "a" * 64),
        "a" * 64,
        MAX_COPY_OBJECT_SIZE + 1,
        version_id="version-1",
        etag='"etag-version-1"',
    )
    with pytest.raises(ValueError, match="5 GiB"):
        store.promote(
            staged,
            legacy_canonical_archive_key("dsv_a", "app_error", PARTITION, "a" * 64),
            expected_absent=True,
            idempotency_key="oversized-promote",
        )
    assert client.calls == []


@pytest.mark.parametrize(
    "bucket",
    [
        "bad bucket",
        "ab",
        "UPPERCASE",
        "192.168.0.1",
        "bucket..name",
        "xn--reserved",
        "sthree-reserved",
        "amzn-s3-demo-reserved",
        "reserved-s3alias",
        "reserved--ol-s3",
        "reserved.mrap",
        "reserved--x-s3",
        "reserved--table-s3",
    ],
)
def test_s3_rejects_noncanonical_bucket_names(bucket: str) -> None:
    with pytest.raises(ValueError, match="bucket"):
        S3ArchiveStore(MemoryS3(), bucket, expected_bucket_owner=OWNER)


@pytest.mark.parametrize(
    "key",
    [
        "staging/run_id=../dataset=app_error/date=2026-09-01/" + "a" * 64 + ".parquet",
        "staging/run_id=run/dataset=app_error/date=2026-99-99/" + "a" * 64 + ".parquet",
        "staging/run_id=%72un/dataset=app_error/date=2026-09-01/" + "a" * 64 + ".parquet",
    ],
)
def test_s3_public_stage_rejects_noncanonical_keys_before_io(key: str) -> None:
    client = MemoryS3()
    encoded = EncodedPartition(Path("not-opened.parquet"), 1, 1, "a" * 64)
    with pytest.raises(ValueError, match="layout"):
        S3ArchiveStore(client, "archive-bucket", expected_bucket_owner=OWNER).stage(
            encoded,
            key,
            expected_absent=True,
            idempotency_key="invalid-key",
        )
    assert client.calls == []


@pytest.mark.parametrize(
    "key",
    [
        "canonical/schema_version=1.0/dataset_version=%64sv_a/dataset=app_error/"
        + PARTITION
        + "/part-"
        + "a" * 64
        + ".parquet",
        "canonical/schema_version=1.0/dataset_version=dsv_a/dataset=../"
        + PARTITION
        + "/part-"
        + "a" * 64
        + ".parquet",
        "canonical/schema_version=1.0/dataset_version=dsv_a/dataset=app_error/"
        "year=2026/month=99/day=01/part-" + "a" * 64 + ".parquet",
    ],
)
def test_s3_public_promote_rejects_noncanonical_keys_before_io(key: str) -> None:
    client = MemoryS3()
    staged = ArchiveObject(
        staging_archive_key("run", "app_error", PARTITION, "a" * 64),
        "a" * 64,
        1,
        version_id="version-1",
        etag='"etag-version-1"',
    )

    with pytest.raises(ValueError, match="layout"):
        S3ArchiveStore(client, "archive-bucket", expected_bucket_owner=OWNER).promote(
            staged,
            key,
            expected_absent=True,
            idempotency_key="invalid-key",
        )

    assert client.calls == []


def test_s3_promotion_is_conditional_idempotent_and_revalidates_source(tmp_path: Path) -> None:
    client = MemoryS3()
    partition = _encoded(tmp_path / "part.parquet")
    store = S3ArchiveStore(client, "archive-bucket", expected_bucket_owner=OWNER)
    staged_key = staging_archive_key("run-1", "app_error", PARTITION, partition.sha256)
    canonical_key = legacy_canonical_archive_key("dsv_a", "app_error", PARTITION, partition.sha256)
    staged = store.stage(partition, staged_key, expected_absent=True, idempotency_key="stage")

    first = store.promote(staged, canonical_key, expected_absent=True, idempotency_key="promote-1")
    replay = store.promote(staged, canonical_key, expected_absent=True, idempotency_key="promote-2")

    copy = next(payload for name, payload in client.calls if name == "copy_object")
    assert copy["IfNoneMatch"] == "*"
    assert copy["ChecksumAlgorithm"] == "SHA256"
    assert copy["ExpectedBucketOwner"] == OWNER
    assert copy["ExpectedSourceBucketOwner"] == OWNER
    assert first == replay
    assert (first.key, first.sha256, first.size) == (
        canonical_key,
        partition.sha256,
        partition.byte_size,
    )
    assert first.version_id is not None
    assert first.etag is not None
    assert sum(name == "copy_object" for name, _ in client.calls) == 1

    client.objects[staged_key]["Metadata"] = {"sha256": "b" * 64}
    with pytest.raises(ArchiveChecksumMismatch, match="metadata"):
        store.promote(
            staged,
            legacy_canonical_archive_key("dsv_b", "app_error", PARTITION, partition.sha256),
            expected_absent=True,
            idempotency_key="promote-tampered",
        )


def test_s3_promotion_preserves_staging_head_unavailability() -> None:
    class UnavailableHead(MemoryS3):
        def head_object(self, **kwargs: object) -> Mapping[str, object]:
            self.calls.append(("head_object", dict(kwargs)))
            raise _client_error("ServiceUnavailable", "HeadObject")

    client = UnavailableHead()
    staged = ArchiveObject(
        staging_archive_key("run", "app_error", PARTITION, "a" * 64),
        "a" * 64,
        12,
        version_id="version-1",
        etag='"etag-version-1"',
    )

    with pytest.raises(ArchiveStorageError, match="HeadObject"):
        S3ArchiveStore(client, "archive-bucket", expected_bucket_owner=OWNER).promote(
            staged,
            legacy_canonical_archive_key("dsv_a", "app_error", PARTITION, staged.sha256),
            expected_absent=True,
            idempotency_key="promote-unavailable-head",
        )


def test_s3_promotion_classifies_valid_but_different_staging_head_as_corruption(
    tmp_path: Path,
) -> None:
    client = MemoryS3()
    partition = _encoded(tmp_path / "part.parquet")
    store = S3ArchiveStore(client, "archive-bucket", expected_bucket_owner=OWNER)
    staged_key = staging_archive_key("run", "app_error", PARTITION, partition.sha256)
    staged = store.stage(partition, staged_key, expected_absent=True, idempotency_key="stage")
    replacement = b"different-physical-object"
    replacement_sha = hashlib.sha256(replacement).hexdigest()
    replacement_checksum = base64.b64encode(hashlib.sha256(replacement).digest()).decode()
    client.objects[staged_key].update(
        Body=replacement,
        ContentLength=len(replacement),
        ChecksumSHA256=replacement_checksum,
        Metadata={
            "sha256": replacement_sha,
            "source-sha256": replacement_sha,
            "source-size": str(len(replacement)),
            "aws-checksum-sha256": replacement_checksum,
            "checksum-type": "full",
            "checksum-parts": "1",
        },
    )

    with pytest.raises(ArchiveChecksumMismatch, match="staged archive object"):
        store.promote(
            staged,
            legacy_canonical_archive_key("dsv_a", "app_error", PARTITION, staged.sha256),
            expected_absent=True,
            idempotency_key="promote-different-head",
        )


def test_s3_promotion_pins_the_verified_source_version_across_a_swap(tmp_path: Path) -> None:
    client = MemoryS3()
    partition = _encoded(tmp_path / "part.parquet")
    store = S3ArchiveStore(client, "archive-bucket", expected_bucket_owner=OWNER)
    staged_key = staging_archive_key("run-1", "app_error", PARTITION, partition.sha256)
    canonical_key = legacy_canonical_archive_key("dsv_a", "app_error", PARTITION, partition.sha256)
    staged = store.stage(partition, staged_key, expected_absent=True, idempotency_key="stage")
    client.swap_source_before_copy = True

    promoted = store.promote(
        staged,
        canonical_key,
        expected_absent=True,
        idempotency_key="promote-source-version",
    )

    copy = next(payload for name, payload in client.calls if name == "copy_object")
    assert cast(Mapping[str, str], copy["CopySource"])["VersionId"] == staged.version_id
    assert copy["CopySourceIfMatch"] == staged.etag
    assert promoted.sha256 == partition.sha256
    assert client.objects[canonical_key]["Body"] == b"archive-body"
    assert client.objects[staged_key]["Body"] == b"swapped-source"


def test_archive_store_fake_converges_on_identical_durable_objects() -> None:
    store = FakeArchiveObjectStore()
    encoded = EncodedPartition(Path("part.parquet"), 1, 12, "a" * 64)
    first = store.stage(
        encoded,
        "staging/part.parquet",
        expected_absent=True,
        idempotency_key="stage-first",
    )
    replay = store.stage(
        encoded,
        "staging/part.parquet",
        expected_absent=True,
        idempotency_key="stage-after-restart",
    )
    assert replay == first
    with pytest.raises(ConditionalWriteError, match="immutable"):
        store.stage(
            EncodedPartition(Path("other.parquet"), 1, 13, "b" * 64),
            "staging/part.parquet",
            expected_absent=True,
            idempotency_key="stage-conflict",
        )


class MemoryGlue:
    def __init__(self) -> None:
        self.tables: dict[str, dict[str, object]] = {}
        self.partitions: dict[tuple[str, tuple[str, ...]], dict[str, object]] = {}
        self.create_table_calls: list[dict[str, object]] = []

    def get_table(self, **kwargs: object) -> Mapping[str, object]:
        name = cast(str, kwargs["Name"])
        if name not in self.tables:
            raise _client_error("EntityNotFoundException", "GetTable")
        return {"Table": self.tables[name]}

    def create_table(self, **kwargs: object) -> Mapping[str, object]:
        request = dict(kwargs)
        self.create_table_calls.append(request)
        table = dict(cast(Mapping[str, object], request["TableInput"]))
        self.tables[cast(str, table["Name"])] = table
        return {}

    def get_partition(self, **kwargs: object) -> Mapping[str, object]:
        key = (cast(str, kwargs["TableName"]), tuple(cast(list[str], kwargs["PartitionValues"])))
        if key not in self.partitions:
            raise _client_error("EntityNotFoundException", "GetPartition")
        return {"Partition": self.partitions[key]}

    def create_partition(self, **kwargs: object) -> Mapping[str, object]:
        table = cast(str, kwargs["TableName"])
        item = dict(cast(Mapping[str, object], kwargs["PartitionInput"]))
        self.partitions[(table, tuple(cast(list[str], item["Values"])))] = item
        return {}


def test_glue_table_uses_complete_public_schema_and_parquet_storage_contract() -> None:
    client = MemoryGlue()
    descriptor = REGISTRY.require("app_error")
    catalog = AwsGlueCatalog(client, "view_show_ingestion")
    root = "s3://archive-bucket/canonical/schema_version=1.0/"

    catalog.ensure_table(descriptor, root, idempotency_key="table-app-error")
    catalog.ensure_table(descriptor, root, idempotency_key="table-app-error-replay")

    table = cast(Mapping[str, object], client.tables["app_error"])
    storage = cast(Mapping[str, object], table["StorageDescriptor"])
    columns = cast(list[dict[str, str]], storage["Columns"])
    assert {column["Name"]: column["Type"] for column in columns} == {
        name.lower(): field_type
        for name, field_type in athena_schema_for_descriptor(descriptor).items()
    }
    assert all(column["Name"] == column["Name"].lower() for column in columns)
    assert table["PartitionKeys"] == [
        {"Name": "dataset_version", "Type": "string"},
        {"Name": "year", "Type": "string"},
        {"Name": "month", "Type": "string"},
        {"Name": "day", "Type": "string"},
    ]
    assert cast(str, storage["InputFormat"]).endswith("parquet.MapredParquetInputFormat")
    assert cast(str, storage["OutputFormat"]).endswith("parquet.MapredParquetOutputFormat")
    serde = cast(Mapping[str, str], storage["SerdeInfo"])
    assert serde["SerializationLibrary"].endswith("parquet.serde.ParquetHiveSerDe")
    assert len(client.create_table_calls) == 1

    columns[0]["Type"] = "binary"
    with pytest.raises(GlueCatalogDrift, match="differs"):
        catalog.ensure_table(descriptor, root, idempotency_key="table-drift")
    assert len(client.create_table_calls) == 1


def test_glue_partition_is_idempotent_and_location_drift_fails_closed() -> None:
    client = MemoryGlue()
    descriptor = REGISTRY.require("signal_meta")
    catalog = AwsGlueCatalog(client, "view_show_ingestion")
    root = "s3://archive-bucket/canonical/schema_version=1.0/"
    location = root + "dataset_version=dsv_a/dataset=signal_meta/snapshot_date=2026-09-01/"
    catalog.ensure_table(descriptor, root, idempotency_key="table")
    catalog.register_legacy_partition(
        descriptor,
        "dsv_a",
        SNAPSHOT_PARTITION,
        location,
        expected_absent=True,
        idempotency_key="partition-1",
    )
    catalog.register_legacy_partition(
        descriptor,
        "dsv_a",
        SNAPSHOT_PARTITION,
        location,
        expected_absent=True,
        idempotency_key="partition-2",
    )

    stored = client.partitions[("signal_meta", ("dsv_a", "2026-09-01"))]
    assert stored["Values"] == ["dsv_a", "2026-09-01"]
    assert cast(Mapping[str, object], stored["StorageDescriptor"])["Location"] == location
    with pytest.raises(ValueError, match="canonical prefix"):
        catalog.register_legacy_partition(
            descriptor,
            "dsv_a",
            SNAPSHOT_PARTITION,
            root + "dataset_version=dsv_other/dataset=signal_meta/snapshot_date=2026-09-01/",
            expected_absent=True,
            idempotency_key="partition-drift",
        )


def test_glue_partition_location_is_scoped_to_the_committed_generation() -> None:
    client = MemoryGlue()
    descriptor = REGISTRY.require("signal_meta")
    catalog = AwsGlueCatalog(client, "view_show_ingestion")
    root = "s3://archive-bucket/canonical/schema_version=1.0/"
    generation = "a" * 64
    location = (
        root
        + "dataset_version=dsv_a/dataset=signal_meta/snapshot_date=2026-09-01/"
        + f"generation={generation}/"
    )
    catalog.ensure_table(descriptor, root, idempotency_key="table-generation")

    catalog.register_partition(
        descriptor,
        "dsv_a",
        SNAPSHOT_PARTITION,
        location,
        aggregate_digest=generation,
        expected_absent=True,
        idempotency_key="partition-generation",
    )

    stored = client.partitions[("signal_meta", ("dsv_a", "2026-09-01"))]
    assert cast(Mapping[str, object], stored["StorageDescriptor"])["Location"] == location


def test_glue_fake_matches_real_idempotent_partition_semantics() -> None:
    descriptor = REGISTRY.require("signal_meta")
    catalog = FakeGlueCatalog()
    location = "s3://bucket/canonical/schema_version=1.0/"
    partition_location = location + (
        "dataset_version=dsv_a/dataset=signal_meta/snapshot_date=2026-09-01/"
    )
    catalog.ensure_table(descriptor, location, idempotency_key="table-1")
    catalog.register_legacy_partition(
        descriptor,
        "dsv_a",
        SNAPSHOT_PARTITION,
        partition_location,
        expected_absent=True,
        idempotency_key="partition-1",
    )
    catalog.register_legacy_partition(
        descriptor,
        "dsv_a",
        SNAPSHOT_PARTITION,
        partition_location,
        expected_absent=True,
        idempotency_key="partition-after-restart",
    )


@pytest.mark.parametrize(
    ("dataset", "partition"),
    [("app_error", PARTITION), ("signal_meta", SNAPSHOT_PARTITION)],
)
def test_glue_keeps_overlapping_days_separate_by_dataset_version(
    dataset: str, partition: str
) -> None:
    client = MemoryGlue()
    descriptor = REGISTRY.require(dataset)
    catalog = AwsGlueCatalog(client, "view_show_ingestion")
    root = "s3://archive-bucket/canonical/schema_version=1.0/"
    catalog.ensure_table(descriptor, root, idempotency_key=f"table-{dataset}")

    for dataset_version in ("dsv_a", "dsv_b"):
        location = root + f"dataset_version={dataset_version}/dataset={dataset}/{partition}/"
        catalog.register_legacy_partition(
            descriptor,
            dataset_version,
            partition,
            location,
            expected_absent=True,
            idempotency_key=f"partition-{dataset_version}",
        )

    assert len(client.partitions) == 2
    assert {values[0] for table, values in client.partitions if table == dataset} == {
        "dsv_a",
        "dsv_b",
    }


def test_glue_partition_and_table_drift_are_rejected_during_registration() -> None:
    client = MemoryGlue()
    descriptor = REGISTRY.require("signal_meta")
    catalog = AwsGlueCatalog(client, "view_show_ingestion")
    root = "s3://archive-bucket/canonical/schema_version=1.0/"
    location = root + "dataset_version=dsv_a/dataset=signal_meta/snapshot_date=2026-09-01/"
    catalog.ensure_table(descriptor, root, idempotency_key="table")
    catalog.register_legacy_partition(
        descriptor,
        "dsv_a",
        SNAPSHOT_PARTITION,
        location,
        expected_absent=True,
        idempotency_key="partition",
    )
    stored = client.partitions[("signal_meta", ("dsv_a", "2026-09-01"))]
    stored["Parameters"] = {"classification": "json"}
    with pytest.raises(GlueCatalogDrift, match="partition differs"):
        catalog.register_legacy_partition(
            descriptor,
            "dsv_a",
            SNAPSHOT_PARTITION,
            location,
            expected_absent=True,
            idempotency_key="partition-drift",
        )
    stored["Parameters"] = {"classification": "parquet"}
    partition_storage = cast(dict[str, object], stored["StorageDescriptor"])
    original_partition_location = partition_storage["Location"]
    partition_storage["Location"] = location + "drift/"
    with pytest.raises(GlueCatalogDrift, match="partition differs"):
        catalog.register_legacy_partition(
            descriptor,
            "dsv_a",
            SNAPSHOT_PARTITION,
            location,
            expected_absent=True,
            idempotency_key="partition-storage-drift",
        )
    partition_storage["Location"] = original_partition_location

    client.tables["signal_meta"]["Parameters"] = {"classification": "json"}
    with pytest.raises(GlueCatalogDrift, match="table differs"):
        catalog.register_legacy_partition(
            descriptor,
            "dsv_b",
            SNAPSHOT_PARTITION,
            root + "dataset_version=dsv_b/dataset=signal_meta/snapshot_date=2026-09-01/",
            expected_absent=True,
            idempotency_key="table-drift",
        )
    table = client.tables["signal_meta"]
    table["Parameters"] = {"classification": "parquet", "EXTERNAL": "TRUE"}
    table_storage = cast(dict[str, object], table["StorageDescriptor"])
    table_storage["InputFormat"] = "invalid.InputFormat"
    with pytest.raises(GlueCatalogDrift, match="table differs"):
        catalog.register_legacy_partition(
            descriptor,
            "dsv_b",
            SNAPSHOT_PARTITION,
            root + "dataset_version=dsv_b/dataset=signal_meta/snapshot_date=2026-09-01/",
            expected_absent=True,
            idempotency_key="table-storage-drift",
        )


class FakeClock:
    def __init__(self) -> None:
        self.value = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.value

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.value += seconds


class MemoryAthena:
    def __init__(self, states: list[str], count: str = "7") -> None:
        self.states = states
        self.count = count
        self.start_request: dict[str, object] | None = None
        self.start_requests: list[dict[str, object]] = []

    def start_query_execution(self, **kwargs: object) -> Mapping[str, object]:
        self.start_request = dict(kwargs)
        self.start_requests.append(dict(kwargs))
        return {"QueryExecutionId": "query-1"}

    def get_query_execution(self, **kwargs: object) -> Mapping[str, object]:
        state = self.states.pop(0) if len(self.states) > 1 else self.states[0]
        return {
            "QueryExecution": {
                "QueryExecutionId": "query-1",
                "Status": {"State": state},
            }
        }

    def get_query_results(self, **kwargs: object) -> Mapping[str, object]:
        return {
            "ResultSet": {
                "ResultSetMetadata": {"ColumnInfo": [{"Name": "row_count", "Type": "bigint"}]},
                "Rows": [
                    {"Data": [{"VarCharValue": "row_count"}]},
                    {"Data": [{"VarCharValue": self.count}]},
                ],
            }
        }


def test_athena_uses_allowlisted_table_exact_partition_and_configured_destinations() -> None:
    client = MemoryAthena(["QUEUED", "RUNNING", "SUCCEEDED"])
    clock = FakeClock()
    validator = AwsAthenaValidator(
        client,
        database="view_show_ingestion",
        workgroup="ingestion-validation",
        output_location="s3://archive-bucket/athena-results/",
        timeout_seconds=10,
        poll_interval_seconds=1,
        monotonic=clock.monotonic,
        sleep=clock.sleep,
    )

    assert validator.validate_legacy_partition("app_error", "dsv_a", PARTITION, 7) == 7
    assert client.start_request is not None
    assert client.start_request["QueryString"] == (
        'SELECT COUNT(*) AS "row_count" FROM "view_show_ingestion"."app_error" '
        "WHERE \"dataset_version\" = 'dsv_a' AND \"year\" = '2026' "
        "AND \"month\" = '09' AND \"day\" = '01'"
    )
    assert client.start_request["WorkGroup"] == "ingestion-validation"
    assert client.start_request["ResultConfiguration"] == {
        "OutputLocation": "s3://archive-bucket/athena-results/"
    }
    assert "ClientRequestToken" not in client.start_request
    assert clock.sleeps == [1, 1]


def test_athena_requests_a_sentinel_row_before_rejecting_pagination() -> None:
    class BoundaryTokenAthena(MemoryAthena):
        def __init__(self) -> None:
            super().__init__(["SUCCEEDED"])
            self.result_requests: list[dict[str, object]] = []

        def get_query_results(self, **kwargs: object) -> Mapping[str, object]:
            self.result_requests.append(dict(kwargs))
            response = dict(super().get_query_results(**kwargs))
            if kwargs.get("MaxResults") == 2:
                response["NextToken"] = "athena-page-boundary"
            return response

    client = BoundaryTokenAthena()
    validator = AwsAthenaValidator(
        client,
        database="view_show_ingestion",
        workgroup="wg",
        output_location="s3://bucket/results/",
    )

    assert validator.validate_legacy_partition("app_error", "dsv_a", PARTITION, 7) == 7
    assert client.result_requests == [{"QueryExecutionId": "query-1", "MaxResults": 3}]


def test_athena_sentinel_rejects_an_extra_count_row() -> None:
    class ExtraRowAthena(MemoryAthena):
        def get_query_results(self, **_kwargs: object) -> Mapping[str, object]:
            return {
                "ResultSet": {
                    "ResultSetMetadata": {"ColumnInfo": [{"Name": "row_count", "Type": "bigint"}]},
                    "Rows": [
                        {"Data": [{"VarCharValue": "row_count"}]},
                        {"Data": [{"VarCharValue": "7"}]},
                        {"Data": [{"VarCharValue": "unexpected"}]},
                    ],
                }
            }

    validator = AwsAthenaValidator(
        ExtraRowAthena(["SUCCEEDED"]),
        database="view_show_ingestion",
        workgroup="wg",
        output_location="s3://bucket/results/",
    )

    with pytest.raises(AthenaQueryError, match="count result is invalid"):
        validator.validate_legacy_partition("app_error", "dsv_a", PARTITION, 7)


@pytest.mark.parametrize(
    ("table", "partition", "partition_predicate"),
    [
        (
            "app_error",
            PARTITION,
            "\"year\" = '2026' AND \"month\" = '09' AND \"day\" = '01'",
        ),
        ("signal_meta", SNAPSHOT_PARTITION, "\"snapshot_date\" = '2026-09-01'"),
    ],
)
def test_athena_filters_overlapping_partitions_by_dataset_version(
    table: str, partition: str, partition_predicate: str
) -> None:
    queries: list[str] = []
    for dataset_version in ("dsv_a", "dsv_b"):
        client = MemoryAthena(["SUCCEEDED"])
        validator = AwsAthenaValidator(
            client,
            database="view_show_ingestion",
            workgroup="wg",
            output_location="s3://bucket/results/",
        )
        assert validator.validate_legacy_partition(table, dataset_version, partition, 7) == 7
        assert client.start_request is not None
        queries.append(cast(str, client.start_request["QueryString"]))

    assert queries[0] != queries[1]
    assert "\"dataset_version\" = 'dsv_a'" in queries[0]
    assert "\"dataset_version\" = 'dsv_b'" in queries[1]
    assert all(partition_predicate in query for query in queries)


def test_athena_query_is_scoped_to_the_registered_generation() -> None:
    client = MemoryAthena(["SUCCEEDED"])
    validator = AwsAthenaValidator(
        client,
        database="view_show_ingestion",
        workgroup="wg",
        output_location="s3://bucket/results/",
    )

    assert (
        validator.validate_partition(
            "app_error",
            "dsv_a",
            PARTITION,
            7,
            aggregate_digest="a" * 64,
        )
        == 7
    )
    assert client.start_request is not None
    assert f"/generation={'a' * 64}/" in cast(str, client.start_request["QueryString"])


@pytest.mark.parametrize("state", ["FAILED", "CANCELLED"])
def test_athena_terminal_failure_is_sanitized(state: str) -> None:
    client = MemoryAthena([state])
    validator = AwsAthenaValidator(
        client,
        database="view_show_ingestion",
        workgroup="wg",
        output_location="s3://bucket/results/",
        timeout_seconds=1,
        poll_interval_seconds=0.1,
    )
    with pytest.raises(AthenaQueryError) as captured:
        validator.validate_legacy_partition("app_error", "dsv_a", PARTITION, 7)
    assert "secret" not in str(captured.value)
    assert state in str(captured.value)


def test_athena_timeout_is_monotonic_and_count_mismatch_fails_closed() -> None:
    clock = FakeClock()
    timeout_client = MemoryAthena(["RUNNING"])
    validator = AwsAthenaValidator(
        timeout_client,
        database="view_show_ingestion",
        workgroup="wg",
        output_location="s3://bucket/results/",
        timeout_seconds=2,
        poll_interval_seconds=1,
        monotonic=clock.monotonic,
        sleep=clock.sleep,
    )
    with pytest.raises(AthenaQueryError, match="timed out"):
        validator.validate_legacy_partition("app_error", "dsv_a", PARTITION, 7)
    assert clock.value == 2

    mismatch = AwsAthenaValidator(
        MemoryAthena(["SUCCEEDED"], count="6"),
        database="view_show_ingestion",
        workgroup="wg",
        output_location="s3://bucket/results/",
    )
    with pytest.raises(ArchiveReconciliationError, match="expected 7"):
        mismatch.validate_legacy_partition("app_error", "dsv_a", PARTITION, 7)
    with pytest.raises(ValueError, match="allowlisted"):
        mismatch.validate_legacy_partition("app_error; DROP TABLE x", "dsv_a", PARTITION, 7)


def _archive_metadata(
    dataset: str, dataset_version: str, partition: str, sha256: str, row_count: int
) -> dict[str, object]:
    day = partition_date(partition)
    start = datetime(day.year, day.month, day.day, tzinfo=UTC)
    return {
        "interval": {
            "start": start.isoformat().replace("+00:00", "Z"),
            "end": (start + timedelta(days=1)).isoformat().replace("+00:00", "Z"),
        },
        "counts": {"accepted": row_count, "rejected": 0, "persisted": row_count},
        "s3Uri": (
            "s3://archive-bucket/"
            + legacy_canonical_archive_key(dataset_version, dataset, partition, sha256)
        ),
        "sha256": sha256,
        "reconciliation": {"state": "PENDING"},
        "expirationEligible": False,
        "hotItemCount": 0,
        "projectionItemCount": 0,
        "catalogGeneration": 1,
        "catalogDigest": None,
    }


def test_publish_marks_available_but_defers_ttl_authorization(tmp_path: Path) -> None:
    calls: list[str] = []
    backend = FakeIngestionBackend()
    descriptor = REGISTRY.require("app_error")
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
        _archive_metadata("app_error", "dsv_a", PARTITION, encoded.sha256, encoded.row_count),
    )

    class Objects(FakeArchiveObjectStore):
        def stage(self, *args: object, **kwargs: object) -> ArchiveObject:
            calls.append("stage")
            return super().stage(*args, **kwargs)  # type: ignore[arg-type]

        def head(self, key: str) -> ArchiveObject | None:
            calls.append("head")
            return super().head(key)

        def promote(self, *args: object, **kwargs: object) -> ArchiveObject:
            calls.append("promote")
            return super().promote(*args, **kwargs)  # type: ignore[arg-type]

    class Catalog(FakeGlueCatalog):
        def register_legacy_partition(self, *args: object, **kwargs: object) -> None:
            calls.append("glue")
            super().register_legacy_partition(*args, **kwargs)  # type: ignore[arg-type]

    class Validator(FakeAthenaValidator):
        def validate_legacy_partition(
            self, table: str, dataset_version: str, partition: str, expected_row_count: int
        ) -> int:
            calls.append(f"athena:{expected_row_count}")
            return super().validate_legacy_partition(
                table, dataset_version, partition, expected_row_count
            )

    class Partitions(FakeArchivePartitionRepository):
        def update_state(self, *args: object, **kwargs: object) -> ArchivePartition:
            result = super().update_state(*args, **kwargs)  # type: ignore[arg-type]
            if result.state is ArchiveState.AVAILABLE:
                calls.append("available")
            return result

    class Expiration(FakeHotExpirationRepository):
        def authorize_expiration(self, *args: object, **kwargs: object) -> int:
            calls.append("ttl")
            return super().authorize_expiration(*args, **kwargs)  # type: ignore[arg-type]

    publisher = ArchivePartitionPublisher(
        object_store=Objects(),
        glue_catalog=Catalog(),
        athena=Validator({("app_error", "dsv_a", PARTITION): 7}),
        partitions=Partitions(backend),
        expiration=Expiration(backend),
        bucket="archive-bucket",
        clock=lambda: NOW,
        schema_fingerprint=schema_fingerprint_for_descriptor,
    )

    result = publisher.publish(
        encoded,
        descriptor,
        archive,
        run_id="run-a",
        idempotency_key="publish-a",
    )

    assert result.state is ArchiveState.AVAILABLE
    assert calls == ["stage", "head", "promote", "glue", "athena:7", "available"]
    assert backend.ttl_authorizations == {}

    publisher.authorize_expiration(descriptor, result, idempotency_key="authorize-a")

    assert calls == ["stage", "head", "promote", "glue", "athena:7", "available", "ttl"]
    ttl = backend.ttl_authorizations[("dsv_a", "app_error", PARTITION)][0]
    assert ttl == int((datetime(2026, 9, 2, tzinfo=UTC) + timedelta(days=30)).timestamp())


def test_publish_count_mismatch_never_marks_available_or_enables_ttl(tmp_path: Path) -> None:
    calls: list[str] = []
    backend = FakeIngestionBackend()
    descriptor = REGISTRY.require("app_error")
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
        _archive_metadata("app_error", "dsv_a", PARTITION, encoded.sha256, encoded.row_count),
    )

    class Partitions(FakeArchivePartitionRepository):
        def update_state(self, *args: object, **kwargs: object) -> ArchivePartition:
            result = super().update_state(*args, **kwargs)  # type: ignore[arg-type]
            if result.state is ArchiveState.AVAILABLE:
                calls.append("available")
            return result

    class Expiration(FakeHotExpirationRepository):
        def authorize_expiration(self, *args: object, **kwargs: object) -> int:
            calls.append("ttl")
            return super().authorize_expiration(*args, **kwargs)  # type: ignore[arg-type]

    class NonEnforcingValidator(FakeAthenaValidator):
        def validate_legacy_partition(
            self, table: str, dataset_version: str, partition: str, expected_row_count: int
        ) -> int:
            return 6

    publisher = ArchivePartitionPublisher(
        object_store=FakeArchiveObjectStore(),
        glue_catalog=FakeGlueCatalog(),
        athena=NonEnforcingValidator({}),
        partitions=Partitions(backend),
        expiration=Expiration(backend),
        bucket="archive-bucket",
        clock=lambda: NOW,
        schema_fingerprint=schema_fingerprint_for_descriptor,
    )

    with pytest.raises(ArchiveReconciliationError):
        publisher.publish(
            encoded,
            descriptor,
            archive,
            run_id="run-a",
            idempotency_key="publish-a",
        )
    assert calls == []


@pytest.mark.parametrize(
    "restart_state",
    [
        ArchiveState.UPLOADED,
        ArchiveState.CATALOGED,
        ArchiveState.VALIDATED,
        ArchiveState.AVAILABLE,
    ],
)
def test_publish_resumes_from_every_durable_checkpoint(
    tmp_path: Path, restart_state: ArchiveState
) -> None:
    descriptor = REGISTRY.require("app_error")
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
        _archive_metadata("app_error", "dsv_a", PARTITION, encoded.sha256, encoded.row_count),
    )
    backend = FakeIngestionBackend()
    before_restart = FakeArchivePartitionRepository(backend)
    before_restart.put(archive, expected_absent=True, idempotency_key="seed-staging")
    current = archive
    for state in (
        ArchiveState.UPLOADED,
        ArchiveState.CATALOGED,
        ArchiveState.VALIDATED,
        ArchiveState.AVAILABLE,
    ):
        if state is ArchiveState.AVAILABLE:
            current = before_restart.record_reconciliation(
                "dsv_a",
                "app_error",
                PARTITION,
                observed_counts={"accepted": 7, "rejected": 0, "persisted": 7},
                reconciled_at=NOW,
                expected_state=ArchiveState.VALIDATED,
                idempotency_key="seed-reconciled",
            )
        current = before_restart.update_state(
            "dsv_a",
            "app_error",
            PARTITION,
            state,
            expected_state=current.state,
            idempotency_key=f"seed-{state.value.lower()}",
        )
        if state is restart_state:
            break

    ttl_calls: list[tuple[str, str, str]] = []

    class Expiration(FakeHotExpirationRepository):
        def authorize_expiration(self, *args: object, **kwargs: object) -> int:
            ttl_calls.append(cast(tuple[str, str, str], args[:3]))
            return super().authorize_expiration(*args, **kwargs)  # type: ignore[arg-type]

    publisher = ArchivePartitionPublisher(
        object_store=FakeArchiveObjectStore(),
        glue_catalog=FakeGlueCatalog(),
        athena=FakeAthenaValidator({("app_error", "dsv_a", PARTITION): 7}),
        partitions=FakeArchivePartitionRepository(backend),
        expiration=Expiration(backend),
        bucket="archive-bucket",
        clock=lambda: NOW,
        schema_fingerprint=schema_fingerprint_for_descriptor,
    )

    result = publisher.publish(
        encoded,
        descriptor,
        archive,
        run_id="run-a",
        idempotency_key=f"restart-{restart_state.value.lower()}",
    )

    assert result.state is ArchiveState.AVAILABLE
    assert ttl_calls == []


def test_publish_fails_closed_when_another_worker_wins_the_state_cas(tmp_path: Path) -> None:
    descriptor = REGISTRY.require("app_error")
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
        _archive_metadata("app_error", "dsv_a", PARTITION, encoded.sha256, encoded.row_count),
    )
    backend = FakeIngestionBackend()

    class RacingPartitions(FakeArchivePartitionRepository):
        raced = False

        def update_state(self, *args: object, **kwargs: object) -> ArchivePartition:
            state = cast(ArchiveState, args[3])
            if state is ArchiveState.UPLOADED and not self.raced:
                self.raced = True
                super().update_state(
                    "dsv_a",
                    "app_error",
                    PARTITION,
                    ArchiveState.UPLOADED,
                    expected_state=ArchiveState.STAGING,
                    idempotency_key="concurrent-winner",
                )
            return super().update_state(*args, **kwargs)  # type: ignore[arg-type]

    ttl_calls: list[object] = []

    class Expiration(FakeHotExpirationRepository):
        def authorize_expiration(self, *args: object, **kwargs: object) -> int:
            ttl_calls.append(args)
            return super().authorize_expiration(*args, **kwargs)  # type: ignore[arg-type]

    publisher = ArchivePartitionPublisher(
        object_store=FakeArchiveObjectStore(),
        glue_catalog=FakeGlueCatalog(),
        athena=FakeAthenaValidator({("app_error", "dsv_a", PARTITION): 7}),
        partitions=RacingPartitions(backend),
        expiration=Expiration(backend),
        bucket="archive-bucket",
        clock=lambda: NOW,
        schema_fingerprint=schema_fingerprint_for_descriptor,
    )

    with pytest.raises(ConditionalWriteError, match="expected_state"):
        publisher.publish(
            encoded,
            descriptor,
            archive,
            run_id="run-a",
            idempotency_key="racing-publisher",
        )

    persisted = backend.archive_partitions[("dsv_a", "app_error", PARTITION)]
    assert persisted.state is ArchiveState.UPLOADED
    assert ttl_calls == []


def test_publish_rejects_crossed_or_schema_drifted_handle_before_aws_or_cas(
    tmp_path: Path,
) -> None:
    descriptor = REGISTRY.require("app_error")
    backend = FakeIngestionBackend()
    objects = FakeArchiveObjectStore()
    publisher = ArchivePartitionPublisher(
        object_store=objects,
        glue_catalog=FakeGlueCatalog(),
        athena=FakeAthenaValidator({}),
        partitions=FakeArchivePartitionRepository(backend),
        expiration=FakeHotExpirationRepository(backend),
        bucket="archive-bucket",
        clock=lambda: NOW,
        schema_fingerprint=schema_fingerprint_for_descriptor,
    )
    archive = ArchivePartition(
        "dsv_a",
        "app_error",
        PARTITION,
        ArchiveState.STAGING,
        _archive_metadata("app_error", "dsv_a", PARTITION, "a" * 64, 7),
    )

    for encoded in (
        EncodedPartition(
            tmp_path / "crossed.parquet",
            7,
            99,
            "a" * 64,
            dataset="signal_meta",
            dataset_version="dsv_a",
            schema_version="1.0",
            schema_fingerprint=schema_fingerprint_for_descriptor(descriptor),
        ),
        EncodedPartition(
            tmp_path / "drift.parquet",
            7,
            99,
            "a" * 64,
            dataset="app_error",
            dataset_version="dsv_a",
            schema_version="1.0",
            schema_fingerprint="b" * 64,
        ),
        EncodedPartition(
            tmp_path / "wrong-version.parquet",
            7,
            99,
            "a" * 64,
            dataset="app_error",
            dataset_version="dsv_b",
            schema_version="1.0",
            schema_fingerprint=schema_fingerprint_for_descriptor(descriptor),
        ),
        EncodedPartition(
            tmp_path / "wrong-schema-version.parquet",
            7,
            99,
            "a" * 64,
            dataset="app_error",
            dataset_version="dsv_a",
            schema_version="2.0",
            schema_fingerprint=schema_fingerprint_for_descriptor(descriptor),
        ),
    ):
        with pytest.raises(ArchivePublicationError, match="identity"):
            publisher.publish(
                encoded,
                descriptor,
                archive,
                run_id="run-a",
                idempotency_key=encoded.path.name,
            )

    assert objects.objects == {}
    assert backend.archive_partitions == {}
