"""Verify immutable, version-pinned incremental S3 batches."""

from __future__ import annotations

import base64
import hashlib
import io
import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from botocore.exceptions import ClientError

from adapters.incremental.parquet import RawParquetCodec
from domain.incremental_batches import (
    EncodedRawBatch,
    IncrementalBatchDefinition,
    PhysicalColumn,
)
from domain.models import TimeWindow
from ports import IdempotencyConflict


class RecordingS3Client:
    def __init__(self) -> None:
        self.puts: list[dict[str, object]] = []
        self.gets: list[dict[str, object]] = []
        self.heads: list[dict[str, object]] = []
        self.objects: dict[tuple[str, str], bytes] = {}
        self.current: dict[str, str] = {}
        self.corrupt_head_checksum = False
        self.corrupt_download = False

    def put_object(self, **kwargs: object) -> dict[str, object]:
        request = dict(kwargs)
        key = request["Key"]
        assert isinstance(key, str)
        if request.get("IfNoneMatch") == "*" and key in self.current:
            raise ClientError(
                {"Error": {"Code": "PreconditionFailed", "Message": "exists"}},
                "PutObject",
            )
        body = request["Body"]
        assert isinstance(body, bytes)
        version = f"version-{len(self.puts) + 1}"
        self.puts.append(request)
        self.objects[(key, version)] = body
        self.current[key] = version
        return {"VersionId": version}

    def head_object(self, **kwargs: object) -> dict[str, object]:
        request = dict(kwargs)
        self.heads.append(request)
        key = request["Key"]
        version = request.get("VersionId")
        assert isinstance(key, str)
        if version is None:
            version = self.current[key]
        assert isinstance(version, str)
        body = self.objects[(key, version)]
        digest = hashlib.sha256(body).digest()
        if self.corrupt_head_checksum:
            digest = b"x" * 32
        return {
            "VersionId": version,
            "ContentLength": len(body),
            "ChecksumSHA256": base64.b64encode(digest).decode("ascii"),
        }

    def get_object(self, **kwargs: object) -> dict[str, object]:
        request = dict(kwargs)
        self.gets.append(request)
        key = request["Key"]
        version = request["VersionId"]
        assert isinstance(key, str) and isinstance(version, str)
        body = self.objects[(key, version)]
        downloaded = body + b"corrupt" if self.corrupt_download else body
        return {
            "VersionId": version,
            "ContentLength": len(body),
            "ChecksumSHA256": base64.b64encode(hashlib.sha256(body).digest()).decode("ascii"),
            "Body": io.BytesIO(downloaded),
        }


def definition() -> IncrementalBatchDefinition:
    return IncrementalBatchDefinition(
        "ARGUS",
        "live_active_15min",
        TimeWindow(
            datetime(2026, 9, 17, 10, tzinfo=UTC),
            datetime(2026, 9, 17, 10, 15, tzinfo=UTC),
            900,
        ),
        0,
        "1.0",
    )


def columns() -> tuple[PhysicalColumn, ...]:
    return (
        PhysicalColumn("bucket_ts", "BIGINT", False, 1),
        PhysicalColumn("sinal", "VARCHAR(64)", False, 2),
    )


def encoded_file(tmp_path: Path) -> EncodedRawBatch:
    return RawParquetCodec().encode(
        columns(),
        (
            {"bucket_ts": 1, "sinal": "alpha"},
            {"bucket_ts": 2, "sinal": "beta"},
        ),
        tmp_path / "data.parquet",
    )


def store(client: RecordingS3Client):
    try:
        from adapters.incremental.s3_batches import S3IncrementalBatchStore
    except ModuleNotFoundError:
        pytest.fail("The incremental S3 batch store is missing")
    return S3IncrementalBatchStore(
        client,
        "bucket-name",
        expected_bucket_owner="123456789012",
    )


def test_publish_writes_data_before_manifest_and_returns_manifest_version(
    tmp_path: Path,
) -> None:
    client = RecordingS3Client()

    reference = store(client).publish(definition(), columns(), encoded_file(tmp_path))

    assert [call["Key"].rsplit("/", 1)[-1] for call in client.puts] == [
        "data.parquet",
        "manifest.json",
    ]
    assert reference.version_id == "version-2"
    assert reference.key == (
        "raw/argus/incremental/dataset=live_active_15min/"
        "window_start=20260917T100000000Z/"
        f"batch_id={definition().batch_id}/manifest.json"
    )
    assert all(call["ChecksumAlgorithm"] == "SHA256" for call in client.puts)
    assert all(call["ExpectedBucketOwner"] == "123456789012" for call in client.puts)
    assert client.puts[-1]["IfNoneMatch"] == "*"


def test_publish_replay_accepts_only_identical_existing_manifest(tmp_path: Path) -> None:
    client = RecordingS3Client()
    adapter = store(client)
    encoded = encoded_file(tmp_path)
    first = adapter.publish(definition(), columns(), encoded)

    replay = adapter.publish(definition(), columns(), encoded)

    assert replay == first
    assert len(client.puts) == 2


def test_publish_replay_rejects_same_batch_id_with_different_data(tmp_path: Path) -> None:
    client = RecordingS3Client()
    adapter = store(client)
    adapter.publish(definition(), columns(), encoded_file(tmp_path))
    changed = RawParquetCodec().encode(
        columns(),
        ({"bucket_ts": 1, "sinal": "changed"},),
        tmp_path / "changed.parquet",
    )

    with pytest.raises(IdempotencyConflict):
        adapter.publish(definition(), columns(), changed)


@pytest.mark.parametrize(
    "invalid_kind",
    ["row_count", "fingerprint", "columns", "ordinals"],
)
def test_publish_validates_complete_local_batch_before_manifest_put(
    tmp_path: Path,
    invalid_kind: str,
) -> None:
    client = RecordingS3Client()
    encoded = encoded_file(tmp_path)
    declared_columns = columns()
    if invalid_kind == "row_count":
        encoded = replace(encoded, row_count=encoded.row_count + 1)
    elif invalid_kind == "fingerprint":
        encoded = replace(encoded, schema_fingerprint="0" * 64)
    elif invalid_kind == "columns":
        declared_columns = (
            columns()[0],
            PhysicalColumn("different_column", "VARCHAR(64)", False, 2),
        )
    else:
        declared_columns = (
            PhysicalColumn("bucket_ts", "BIGINT", False, 2),
            PhysicalColumn("sinal", "VARCHAR(64)", False, 3),
        )

    with pytest.raises(ValueError, match="row count|fingerprint|columns|schema|ordinal"):
        store(client).publish(definition(), declared_columns, encoded)

    assert all(not str(call["Key"]).endswith("/manifest.json") for call in client.puts)


def test_publish_derives_extra_columns_from_allowlisted_descriptor(tmp_path: Path) -> None:
    client = RecordingS3Client()
    observed = (*columns(), PhysicalColumn("nova_coluna", "TEXT", True, 3))
    encoded = RawParquetCodec().encode(
        observed,
        ({"bucket_ts": 1, "sinal": "alpha", "nova_coluna": "preservada"},),
        tmp_path / "with-extra.parquet",
    )

    adapter = store(client)
    manifest = adapter.load_manifest(adapter.publish(definition(), observed, encoded))

    assert manifest.extra_columns == ("nova_coluna",)


def test_load_rejects_data_checksum_mismatch(tmp_path: Path) -> None:
    client = RecordingS3Client()
    adapter = store(client)
    reference = adapter.publish(definition(), columns(), encoded_file(tmp_path))
    client.corrupt_head_checksum = True

    with pytest.raises(ValueError, match="checksum"):
        adapter.load_manifest(reference)


def test_load_rejects_noncanonical_manifest_json(tmp_path: Path) -> None:
    client = RecordingS3Client()
    adapter = store(client)
    reference = adapter.publish(definition(), columns(), encoded_file(tmp_path))
    canonical = client.objects[(reference.key, reference.version_id)]
    payload = json.loads(canonical)
    client.objects[(reference.key, reference.version_id)] = json.dumps(payload, indent=2).encode()

    with pytest.raises(ValueError, match="canonical"):
        adapter.load_manifest(reference)


def test_read_page_downloads_exact_version_and_bounds_offsets(tmp_path: Path) -> None:
    client = RecordingS3Client()
    adapter = store(client)
    manifest = adapter.load_manifest(
        adapter.publish(definition(), columns(), encoded_file(tmp_path))
    )

    first = adapter.read_page(manifest, None, 1)
    second = adapter.read_page(manifest, first.next_offset, 10)

    assert first.rows == ({"bucket_ts": 1, "sinal": "alpha"},)
    assert first.next_offset == 1
    assert second.rows == ({"bucket_ts": 2, "sinal": "beta"},)
    assert second.next_offset is None
    assert client.gets[-1]["VersionId"] == manifest.data_version_id
    with pytest.raises(ValueError, match="offset"):
        adapter.read_page(manifest, 3, 1)


def test_read_page_rejects_downloaded_body_that_differs_from_evidence(tmp_path: Path) -> None:
    client = RecordingS3Client()
    adapter = store(client)
    manifest = adapter.load_manifest(
        adapter.publish(definition(), columns(), encoded_file(tmp_path))
    )
    client.corrupt_download = True

    with pytest.raises(ValueError, match="checksum|size"):
        adapter.read_page(manifest, None, 1)


def test_read_page_rejects_physical_schema_that_contradicts_manifest(tmp_path: Path) -> None:
    client = RecordingS3Client()
    adapter = store(client)
    manifest = adapter.load_manifest(
        adapter.publish(definition(), columns(), encoded_file(tmp_path))
    )
    wrong_path = tmp_path / "wrong-schema.parquet"
    wrong_schema = pa.schema(
        [pa.field("bucket_ts", pa.string(), nullable=False), pa.field("sinal", pa.string())],
        metadata={
            b"format": b"argus-raw-incremental",
            b"contractVersion": b"1.0",
            b"schemaFingerprint": manifest.schema_fingerprint.encode(),
        },
    )
    pq.write_table(
        pa.Table.from_pylist([{"bucket_ts": "1", "sinal": "alpha"}], schema=wrong_schema),
        wrong_path,
    )
    wrong_body = wrong_path.read_bytes()
    client.objects[(manifest.data_key, manifest.data_version_id)] = wrong_body
    contradicted = replace(
        manifest,
        row_count=1,
        data_size_bytes=len(wrong_body),
        data_sha256=hashlib.sha256(wrong_body).hexdigest(),
    )

    with pytest.raises(ValueError, match="physical schema"):
        adapter.read_page(contradicted, None, 1)
