"""Persist canonical-set commit markers as immutable, checksum-bound S3 objects."""

from __future__ import annotations

import base64
import hashlib
import json
import re
from collections.abc import Mapping
from typing import IO, Protocol, cast

from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from domain.archive import canonical_set_marker_key
from domain.canonical_json import canonical_bytes
from domain.canonical_set import (
    CanonicalSet,
    canonical_set_from_document,
    canonical_set_to_document,
)
from ports import CanonicalSetStore, ConditionalWriteError

MAX_CANONICAL_SET_BYTES = 8 * 1024 * 1024
_BUCKET = re.compile(r"^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$")
_OWNER = re.compile(r"^[0-9]{12}$")
_SAFE_ERROR_CODE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")


class CanonicalSetS3Client(Protocol):
    def put_object(self, **kwargs: object) -> Mapping[str, object]: ...

    def get_object(self, **kwargs: object) -> Mapping[str, object]: ...


class CanonicalSetStorageError(RuntimeError):
    """S3 returned evidence that cannot safely identify a canonical set."""


class CanonicalSetChecksumMismatch(CanonicalSetStorageError):
    """The marker bytes, length, or checksum differ from S3 physical evidence."""


class CanonicalSetEvidenceError(ConditionalWriteError):
    """A checksum-valid marker contradicts the canonical-set logical contract."""


class CanonicalSetConflict(CanonicalSetEvidenceError):
    """A dataset version was already committed with different evidence."""


def canonical_set_key(dataset_version: str) -> str:
    return canonical_set_marker_key(dataset_version)


def _error_code(error: ClientError) -> str:
    raw = error.response.get("Error", {}).get("Code")
    return raw if isinstance(raw, str) and _SAFE_ERROR_CODE.fullmatch(raw) else "Unknown"


def _missing(error: ClientError) -> bool:
    return _error_code(error) in {"404", "NoSuchKey", "NotFound"}


def _precondition(error: ClientError) -> bool:
    return _error_code(error) in {
        "409",
        "412",
        "ConditionalRequestConflict",
        "PreconditionFailed",
    }


def _reject_duplicate_members(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON member {key!r}")
        result[key] = value
    return result


class S3CanonicalSetStore(CanonicalSetStore):
    """Use the manifest object itself as the only authoritative commit marker."""

    def __init__(
        self,
        client: CanonicalSetS3Client,
        bucket: str,
        *,
        expected_bucket_owner: str,
        max_manifest_bytes: int = MAX_CANONICAL_SET_BYTES,
    ) -> None:
        if not isinstance(bucket, str) or _BUCKET.fullmatch(bucket) is None or ".." in bucket:
            raise ValueError("bucket must be a canonical S3 bucket name")
        if (
            not isinstance(expected_bucket_owner, str)
            or _OWNER.fullmatch(expected_bucket_owner) is None
        ):
            raise ValueError("expected_bucket_owner must be a 12-digit AWS account ID")
        if isinstance(max_manifest_bytes, bool) or not isinstance(max_manifest_bytes, int):
            raise TypeError("max_manifest_bytes must be an integer")
        if max_manifest_bytes <= 0 or max_manifest_bytes > MAX_CANONICAL_SET_BYTES:
            raise ValueError("max_manifest_bytes must be within the canonical 8 MiB limit")
        self._client = client
        self.bucket = bucket
        self.expected_bucket_owner = expected_bucket_owner
        self.max_manifest_bytes = max_manifest_bytes

    def get(self, dataset_version: str) -> CanonicalSet | None:
        key = canonical_set_key(dataset_version)
        try:
            response = self._client.get_object(
                Bucket=self.bucket,
                Key=key,
                ChecksumMode="ENABLED",
                ExpectedBucketOwner=self.expected_bucket_owner,
            )
        except ClientError as error:
            if _missing(error):
                return None
            raise CanonicalSetStorageError(f"S3 GetObject failed ({_error_code(error)})") from None
        try:
            content_length = response["ContentLength"]
            checksum = response["ChecksumSHA256"]
            metadata = response["Metadata"]
            body = response["Body"]
            if (
                isinstance(content_length, bool)
                or not isinstance(content_length, int)
                or content_length < 0
                or content_length > self.max_manifest_bytes
            ):
                raise ValueError("canonical set manifest exceeds its maximum size")
            if not isinstance(checksum, str) or not isinstance(metadata, Mapping):
                raise TypeError
            if not hasattr(body, "read"):
                raise TypeError
            payload = cast(IO[bytes], body).read(self.max_manifest_bytes + 1)
            if not isinstance(payload, bytes) or len(payload) != content_length:
                raise CanonicalSetChecksumMismatch(
                    "canonical set manifest length differs from S3 evidence"
                )
            payload_sha = hashlib.sha256(payload).digest()
            expected_checksum = base64.b64encode(payload_sha).decode("ascii")
            if checksum != expected_checksum or metadata.get("sha256") != payload_sha.hex():
                raise CanonicalSetChecksumMismatch(
                    "canonical set manifest checksum differs from S3 evidence"
                )
        except (KeyError, TypeError, ValueError) as error:
            raise CanonicalSetStorageError("canonical set S3 evidence is invalid") from error
        try:
            document = json.loads(payload, object_pairs_hook=_reject_duplicate_members)
            if (
                not isinstance(document, Mapping)
                or document.get("datasetVersion") != dataset_version
            ):
                raise CanonicalSetConflict(
                    "canonical set manifest dataset version differs from its key"
                )
            value = canonical_set_from_document(document)
            if canonical_set_key(value.dataset_version) != key:
                raise ValueError("canonical set manifest key is not canonical")
            return value
        except (KeyError, TypeError, ValueError, json.JSONDecodeError, RecursionError) as error:
            raise CanonicalSetEvidenceError("canonical set manifest evidence is invalid") from error

    def commit(self, value: CanonicalSet, *, idempotency_key: str) -> CanonicalSet:
        if not isinstance(value, CanonicalSet):
            raise TypeError("value must be a CanonicalSet")
        if not isinstance(idempotency_key, str) or not idempotency_key:
            raise ValueError("idempotency_key must be a non-empty string")
        key = canonical_set_key(value.dataset_version)
        payload = canonical_bytes(canonical_set_to_document(value))
        if len(payload) > self.max_manifest_bytes:
            raise ValueError("canonical set manifest exceeds its maximum size")
        digest = hashlib.sha256(payload).digest()
        checksum = base64.b64encode(digest).decode("ascii")
        try:
            self._client.put_object(
                Bucket=self.bucket,
                Key=key,
                Body=payload,
                ContentLength=len(payload),
                ContentType="application/json",
                ChecksumAlgorithm="SHA256",
                ChecksumSHA256=checksum,
                IfNoneMatch="*",
                Metadata={"sha256": digest.hex()},
                ExpectedBucketOwner=self.expected_bucket_owner,
            )
        except ClientError as error:
            if not _precondition(error):
                raise CanonicalSetStorageError(
                    f"S3 PutObject failed ({_error_code(error)})"
                ) from None
        confirmed = self.get(value.dataset_version)
        if confirmed is None:
            raise CanonicalSetStorageError("committed canonical set manifest is missing")
        if confirmed != value:
            raise CanonicalSetConflict(
                "canonical set for dataset version already exists and differs from evidence"
            )
        return confirmed


__all__ = [
    "MAX_CANONICAL_SET_BYTES",
    "CanonicalSetChecksumMismatch",
    "CanonicalSetConflict",
    "CanonicalSetEvidenceError",
    "CanonicalSetStorageError",
    "S3CanonicalSetStore",
    "canonical_set_key",
]
