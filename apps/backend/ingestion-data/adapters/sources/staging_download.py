"""Download an explicitly pinned S3 version into a bounded private local file."""

from __future__ import annotations

import base64
import hashlib
import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import BinaryIO, Protocol, cast

from scripts.upload_snapshot import DEFAULT_UPLOAD_LIMITS, SnapshotUploadError

CHUNK_BYTES = 1024 * 1024


class StagingS3Client(Protocol):
    def head_object(self, **kwargs: object) -> Mapping[str, object]: ...
    def get_object(self, **kwargs: object) -> Mapping[str, object]: ...


class S3StagingDownloader:
    def __init__(self, client: StagingS3Client, *, expected_bucket_owner: str) -> None:
        self._client, self._owner = client, expected_bucket_owner

    @staticmethod
    def _validate(response: Mapping[str, object], version_id: str, expected_size: int) -> None:
        size = response.get("ContentLength")
        if (
            type(size) is not int
            or size != expected_size
            or response.get("VersionId") != version_id
        ):
            raise SnapshotUploadError("Staging object identity does not match")

    @staticmethod
    def _checksum(response: Mapping[str, object], expected_part_count: int) -> bytes:
        value = response.get("ChecksumSHA256")
        match = (
            re.fullmatch(r"([A-Za-z0-9+/]{43}=)-([1-9][0-9]{0,4})", value)
            if isinstance(value, str)
            else None
        )
        if response.get("ChecksumType") != "COMPOSITE" or match is None:
            raise SnapshotUploadError("Staging checksum evidence is invalid")
        digest = base64.b64decode(match[1], validate=True)
        if (
            len(digest) != hashlib.sha256().digest_size
            or base64.b64encode(digest).decode("ascii") != match[1]
            or int(match[2]) != expected_part_count
        ):
            raise SnapshotUploadError("Staging checksum evidence is invalid")
        if "PartsCount" in response and (
            type(response["PartsCount"]) is not int or response["PartsCount"] != expected_part_count
        ):
            raise SnapshotUploadError("Staging checksum part count does not match")
        return digest

    def download(
        self,
        bucket: str,
        key: str,
        destination: Path,
        *,
        version_id: str,
        expected_size: int,
        part_size_bytes: int,
        expected_part_count: int,
    ) -> None:
        if (
            not version_id
            or version_id.lower() == "null"
            or type(expected_size) is not int
            or not 0 < expected_size <= DEFAULT_UPLOAD_LIMITS.max_input_bytes
            or type(part_size_bytes) is not int
            or not 0 < part_size_bytes <= 5 * 1024**3
            or type(expected_part_count) is not int
            or not 1 <= expected_part_count <= 10000
            or expected_part_count != (expected_size + part_size_bytes - 1) // part_size_bytes
        ):
            raise SnapshotUploadError("Invalid staging object identity")
        request = {
            "Bucket": bucket,
            "Key": key,
            "VersionId": version_id,
            "ExpectedBucketOwner": self._owner,
            "ChecksumMode": "ENABLED",
        }
        body: BinaryIO | None = None
        complete = False
        try:
            head = self._client.head_object(**request)
            self._validate(head, version_id, expected_size)
            expected_checksum = self._checksum(head, expected_part_count)
            response = self._client.get_object(**request)
            body = cast(BinaryIO, response["Body"])
            self._validate(response, version_id, expected_size)
            if self._checksum(response, expected_part_count) != expected_checksum:
                raise SnapshotUploadError("Staging checksum evidence does not match")
            fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "wb") as output:
                os.fchmod(output.fileno(), 0o600)
                size = 0
                composite = hashlib.sha256()
                # S3 COMPOSITE is SHA256 of the concatenated binary part digests, not
                # SHA256 of the full body. The upload contract fixes these part boundaries.
                for _part in range(expected_part_count):
                    remaining = min(part_size_bytes, expected_size - size)
                    part = hashlib.sha256()
                    while remaining:
                        amount = min(CHUNK_BYTES, remaining)
                        chunk = body.read(amount)
                        if not chunk or len(chunk) > amount:
                            raise SnapshotUploadError("Staging stream size does not match")
                        remaining -= len(chunk)
                        size += len(chunk)
                        part.update(chunk)
                        output.write(chunk)
                    composite.update(part.digest())
                if body.read(1):
                    raise SnapshotUploadError("Staging stream exceeds expected size")
                if composite.digest() != expected_checksum:
                    raise SnapshotUploadError("Staging checksum does not match downloaded content")
            complete = True
        finally:
            try:
                if body is not None:
                    body.close()
            finally:
                if not complete:
                    destination.unlink(missing_ok=True)
