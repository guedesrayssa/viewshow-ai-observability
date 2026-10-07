"""Publish and read immutable, version-pinned incremental batches in S3."""

from __future__ import annotations

import base64
import hashlib
import re
from collections.abc import Mapping
from typing import Protocol

import pyarrow as pa  # type: ignore[import-untyped]
import pyarrow.parquet as pq  # type: ignore[import-untyped]
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from contracts.registry import DatasetRegistry
from domain.canonical_json import canonical_bytes
from domain.incremental_batches import (
    EncodedRawBatch,
    IncrementalBatchDefinition,
    IncrementalBatchManifest,
    IncrementalBatchReference,
    PhysicalColumn,
    RawBatchPage,
)
from ports import IdempotencyConflict
from ports.incremental import IncrementalBatchObjectStore

_BUCKET = re.compile(r"^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$")
_OWNER = re.compile(r"^[0-9]{12}$")
_DATASET = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
_BATCH_ID = re.compile(r"^bat_[0-9a-f]{64}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_TEXT_TYPE = re.compile(r"^(?:VARCHAR\([1-9][0-9]*\)|TEXT|ENUM\(.*\))$")
_PREFIX = "raw/argus/incremental"


class S3Body(Protocol):
    def read(self, amount: int | None = None) -> bytes: ...


class IncrementalS3Client(Protocol):
    def put_object(self, **kwargs: object) -> Mapping[str, object]: ...
    def head_object(self, **kwargs: object) -> Mapping[str, object]: ...
    def get_object(self, **kwargs: object) -> Mapping[str, object]: ...


class _ImmutableObjectConflict(ValueError):
    pass


def _required_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value or value.strip() != value:
        raise ValueError(f"{field} must be a non-empty canonical string")
    return value


def _checksum_b64(digest: str) -> str:
    if _SHA256.fullmatch(digest) is None:
        raise ValueError("checksum must be a lowercase SHA-256 hexadecimal digest")
    return base64.b64encode(bytes.fromhex(digest)).decode("ascii")


def _decode_checksum(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} checksum is missing")
    try:
        raw = base64.b64decode(value, validate=True)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} checksum is invalid") from error
    if len(raw) != hashlib.sha256().digest_size:
        raise ValueError(f"{field} checksum is invalid")
    return raw.hex()


def _version(response: object, field: str) -> str:
    if not isinstance(response, Mapping):
        raise ValueError(f"{field} response must be a mapping")
    return _required_text(response.get("VersionId"), f"{field} VersionId")


def _read_body(value: object) -> bytes:
    if isinstance(value, bytes):
        return value
    read = getattr(value, "read", None)
    if not callable(read):
        raise ValueError("S3 GetObject response body is invalid")
    body = read()
    if not isinstance(body, bytes):
        raise ValueError("S3 GetObject response body must produce bytes")
    return body


def _precondition_failed(error: ClientError) -> bool:
    code = error.response.get("Error", {}).get("Code")
    return code in {"409", "412", "ConditionalRequestConflict", "PreconditionFailed"}


def _window_start(definition: IncrementalBatchDefinition) -> str:
    milliseconds = definition.window.start.microsecond // 1000
    return definition.window.start.strftime("%Y%m%dT%H%M%S") + f"{milliseconds:03d}Z"


def _base_key(definition: IncrementalBatchDefinition) -> str:
    if _DATASET.fullmatch(definition.source_dataset) is None:
        raise ValueError("source_dataset cannot be used in an incremental S3 key")
    if _BATCH_ID.fullmatch(definition.batch_id) is None:
        raise ValueError("batch_id is invalid")
    return (
        f"{_PREFIX}/dataset={definition.source_dataset}/"
        f"window_start={_window_start(definition)}/batch_id={definition.batch_id}"
    )


def _arrow_type(column: PhysicalColumn) -> pa.DataType:
    if column.physical_type in {"BIGINT", "INT", "TINYINT"}:
        return pa.int64()
    if column.physical_type == "DOUBLE":
        return pa.float64()
    if _TEXT_TYPE.fullmatch(column.physical_type):
        return pa.string()
    raise ValueError("manifest physical schema contains an unsupported type")


def _validate_parquet(
    body: bytes,
    columns: tuple[PhysicalColumn, ...],
    schema_fingerprint: str,
    row_count: int,
) -> pa.Table:
    names = tuple(column.name for column in columns)
    if not names or len(set(names)) != len(names):
        raise ValueError("Parquet columns must have unique non-empty names")
    if tuple(column.ordinal for column in columns) != tuple(range(1, len(columns) + 1)):
        raise ValueError("Parquet column ordinals must be contiguous and ordered")
    try:
        table = pq.read_table(pa.BufferReader(body))
    except (OSError, pa.ArrowException) as error:
        raise ValueError("incremental batch is not valid Parquet") from error
    if table.num_rows != row_count:
        raise ValueError("Parquet row count differs from batch evidence")
    if table.column_names != list(names):
        raise ValueError("Parquet columns differ from declared schema")
    metadata = table.schema.metadata or {}
    if metadata != {
        b"format": b"argus-raw-incremental",
        b"contractVersion": b"1.0",
        b"schemaFingerprint": schema_fingerprint.encode("ascii"),
    }:
        raise ValueError("Parquet schema fingerprint differs from batch evidence")
    for index, column in enumerate(columns):
        field = table.schema.field(index)
        if field.type != _arrow_type(column) or field.nullable is not column.nullable:
            raise ValueError("Parquet physical schema differs from declared schema")
    return table


class S3IncrementalBatchStore(IncrementalBatchObjectStore):
    """Treats the manifest object as the commit marker for an immutable raw batch."""

    def __init__(
        self,
        client: IncrementalS3Client,
        bucket: str,
        *,
        expected_bucket_owner: str,
        registry: DatasetRegistry | None = None,
    ) -> None:
        if not isinstance(bucket, str) or _BUCKET.fullmatch(bucket) is None or ".." in bucket:
            raise ValueError("bucket must be a canonical S3 bucket name")
        if (
            not isinstance(expected_bucket_owner, str)
            or _OWNER.fullmatch(expected_bucket_owner) is None
        ):
            raise ValueError("expected_bucket_owner must be a 12-digit AWS account ID")
        self._client = client
        self._bucket = bucket
        self._expected_bucket_owner = expected_bucket_owner
        if registry is not None and not isinstance(registry, DatasetRegistry):
            raise TypeError("registry must be a DatasetRegistry")
        self._registry = registry or DatasetRegistry.load_argus_v2()

    def _request(self, key: str) -> dict[str, object]:
        return {
            "Bucket": self._bucket,
            "Key": key,
            "ExpectedBucketOwner": self._expected_bucket_owner,
        }

    def _validate_local(
        self,
        encoded: EncodedRawBatch,
        columns: tuple[PhysicalColumn, ...],
    ) -> bytes:
        try:
            body = encoded.path.read_bytes()
        except OSError as error:
            raise ValueError("cannot read encoded incremental batch") from error
        if len(body) != encoded.size_bytes or hashlib.sha256(body).hexdigest() != encoded.sha256:
            raise ValueError("encoded incremental batch size or checksum changed")
        _validate_parquet(body, columns, encoded.schema_fingerprint, encoded.row_count)
        return body

    def _head(
        self,
        key: str,
        version_id: str | None,
        *,
        expected_size: int | None = None,
        expected_sha256: str | None = None,
    ) -> str:
        request = self._request(key)
        request["ChecksumMode"] = "ENABLED"
        if version_id is not None:
            request["VersionId"] = version_id
        response = self._client.head_object(**request)
        actual_version = _version(response, "S3 HeadObject")
        if version_id is not None and actual_version != version_id:
            raise ValueError("S3 object version differs from the requested version")
        if expected_size is not None:
            size = response.get("ContentLength")
            if type(size) is not int or size != expected_size:
                raise ValueError("S3 object size differs from manifest evidence")
        if expected_sha256 is not None:
            digest = _decode_checksum(response.get("ChecksumSHA256"), "S3 object")
            if digest != expected_sha256:
                raise ValueError("S3 object checksum differs from manifest evidence")
        return actual_version

    def _put_immutable(self, key: str, body: bytes, digest: str, content_type: str) -> str:
        try:
            response = self._client.put_object(
                **self._request(key),
                Body=body,
                ContentLength=len(body),
                ContentType=content_type,
                ChecksumAlgorithm="SHA256",
                ChecksumSHA256=_checksum_b64(digest),
                IfNoneMatch="*",
            )
        except ClientError as error:
            if not _precondition_failed(error):
                raise
            try:
                return self._head(
                    key,
                    None,
                    expected_size=len(body),
                    expected_sha256=digest,
                )
            except ValueError as conflict:
                raise _ImmutableObjectConflict(
                    "immutable S3 object contains different content"
                ) from conflict
        version_id = _version(response, "S3 PutObject")
        self._head(
            key,
            version_id,
            expected_size=len(body),
            expected_sha256=digest,
        )
        return version_id

    def publish(
        self,
        definition: IncrementalBatchDefinition,
        columns: tuple[PhysicalColumn, ...],
        encoded: EncodedRawBatch,
    ) -> IncrementalBatchReference:
        if not isinstance(definition, IncrementalBatchDefinition):
            raise TypeError("definition must be an IncrementalBatchDefinition")
        if not isinstance(encoded, EncodedRawBatch):
            raise TypeError("encoded must be an EncodedRawBatch")
        if not columns or not all(isinstance(column, PhysicalColumn) for column in columns):
            raise ValueError("columns must contain the observed physical schema")
        body = self._validate_local(encoded, columns)
        descriptor = self._registry.require(definition.source_dataset)
        known_columns = {column.name for column in descriptor.columns}
        extra_columns = tuple(column.name for column in columns if column.name not in known_columns)
        base_key = _base_key(definition)
        data_key = f"{base_key}/data.parquet"
        manifest_key = f"{base_key}/manifest.json"

        try:
            data_version = self._put_immutable(
                data_key,
                body,
                encoded.sha256,
                "application/vnd.apache.parquet",
            )
        except _ImmutableObjectConflict as error:
            raise IdempotencyConflict(
                "incremental batch data differs from the existing batch identity"
            ) from error
        manifest = IncrementalBatchManifest(
            batch_id=definition.batch_id,
            source_system=definition.source_system,
            source_dataset=definition.source_dataset,
            window=definition.window,
            revision=definition.revision,
            data_key=data_key,
            data_version_id=data_version,
            data_size_bytes=encoded.size_bytes,
            data_sha256=encoded.sha256,
            schema_fingerprint=encoded.schema_fingerprint,
            columns=columns,
            extra_columns=extra_columns,
            row_count=encoded.row_count,
            exporter_version=definition.exporter_version,
        )
        manifest_mapping = manifest.to_mapping()
        validated_manifest = IncrementalBatchManifest.from_mapping(manifest_mapping)
        manifest_body = canonical_bytes(validated_manifest.to_mapping())
        manifest_digest = hashlib.sha256(manifest_body).hexdigest()
        try:
            manifest_version = self._put_immutable(
                manifest_key,
                manifest_body,
                manifest_digest,
                "application/json",
            )
        except _ImmutableObjectConflict as error:
            raise IdempotencyConflict(
                "incremental batch key already contains different immutable content"
            ) from error
        reference = IncrementalBatchReference(self._bucket, manifest_key, manifest_version)
        existing = self.load_manifest(reference)
        if canonical_bytes(existing.to_mapping()) != manifest_body:
            raise IdempotencyConflict(
                "incremental batch manifest differs from the existing batch identity"
            )
        return reference

    def _validate_reference(self, reference: IncrementalBatchReference) -> None:
        if not isinstance(reference, IncrementalBatchReference):
            raise TypeError("reference must be an IncrementalBatchReference")
        if reference.bucket != self._bucket:
            raise ValueError("manifest bucket differs from the configured bucket")
        _required_text(reference.version_id, "manifest version_id")
        if not reference.key.startswith(f"{_PREFIX}/") or not reference.key.endswith(
            "/manifest.json"
        ):
            raise ValueError("manifest key is outside the incremental batch prefix")

    def load_manifest(self, reference: IncrementalBatchReference) -> IncrementalBatchManifest:
        self._validate_reference(reference)
        response = self._client.get_object(
            **self._request(reference.key),
            VersionId=reference.version_id,
            ChecksumMode="ENABLED",
        )
        if _version(response, "S3 GetObject") != reference.version_id:
            raise ValueError("manifest version differs from the requested version")
        body = _read_body(response.get("Body"))
        size = response.get("ContentLength")
        if type(size) is not int or size != len(body):
            raise ValueError("manifest size differs from the downloaded body")
        if (
            _decode_checksum(response.get("ChecksumSHA256"), "manifest")
            != hashlib.sha256(body).hexdigest()
        ):
            raise ValueError("manifest checksum differs from the downloaded body")
        try:
            import json

            payload = json.loads(body)
        except (UnicodeDecodeError, ValueError) as error:
            raise ValueError("manifest body is not valid UTF-8 JSON") from error
        if not isinstance(payload, Mapping):
            raise ValueError("manifest body must be a JSON object")
        manifest = IncrementalBatchManifest.from_mapping(payload)
        if canonical_bytes(manifest.to_mapping()) != body:
            raise ValueError("manifest body must use canonical JSON encoding")
        base_key = _base_key(
            IncrementalBatchDefinition(
                manifest.source_system,
                manifest.source_dataset,
                manifest.window,
                manifest.revision,
                manifest.exporter_version,
            )
        )
        if (
            reference.key != f"{base_key}/manifest.json"
            or manifest.data_key != f"{base_key}/data.parquet"
        ):
            raise ValueError("manifest identity does not match its S3 keys")
        self._head(
            manifest.data_key,
            manifest.data_version_id,
            expected_size=manifest.data_size_bytes,
            expected_sha256=manifest.data_sha256,
        )
        return manifest

    def read_page(
        self,
        manifest: IncrementalBatchManifest,
        after: int | None,
        limit: int,
    ) -> RawBatchPage:
        if not isinstance(manifest, IncrementalBatchManifest):
            raise TypeError("manifest must be an IncrementalBatchManifest")
        if after is not None and (type(after) is not int or after < 0):
            raise ValueError("after offset must be a non-negative integer or None")
        if type(limit) is not int:
            raise TypeError("limit must be an integer")
        if limit <= 0:
            raise ValueError("limit must be positive")
        offset = after or 0
        if offset > manifest.row_count:
            raise ValueError("after offset exceeds the manifest row count")
        response = self._client.get_object(
            **self._request(manifest.data_key),
            VersionId=manifest.data_version_id,
            ChecksumMode="ENABLED",
        )
        if _version(response, "S3 GetObject") != manifest.data_version_id:
            raise ValueError("data version differs from the requested version")
        body = _read_body(response.get("Body"))
        if len(body) != manifest.data_size_bytes:
            raise ValueError("downloaded data size differs from manifest evidence")
        digest = hashlib.sha256(body).hexdigest()
        if digest != manifest.data_sha256:
            raise ValueError("downloaded data checksum differs from manifest evidence")
        if _decode_checksum(response.get("ChecksumSHA256"), "data") != digest:
            raise ValueError("S3 data checksum differs from the downloaded body")
        table = _validate_parquet(
            body,
            manifest.columns,
            manifest.schema_fingerprint,
            manifest.row_count,
        )
        if offset == manifest.row_count:
            return RawBatchPage((), None)
        end = min(offset + limit, manifest.row_count)
        rows = tuple(table.slice(offset, end - offset).to_pylist())
        return RawBatchPage(rows, end if end < manifest.row_count else None)


__all__ = ["IncrementalS3Client", "S3IncrementalBatchStore"]
