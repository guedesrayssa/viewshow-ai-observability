"""Verify canonical-set markers are immutable, bounded, and fail closed."""

from __future__ import annotations

import base64
import hashlib
import io
import json
from collections.abc import Mapping
from typing import cast

import pytest
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from adapters.archive.s3_canonical_sets import (
    CanonicalSetChecksumMismatch,
    CanonicalSetConflict,
    CanonicalSetEvidenceError,
    CanonicalSetStorageError,
    S3CanonicalSetStore,
)
from domain.canonical_set import canonical_set_to_document
from tests.unit.domain.test_canonical_set import canonical_set


def _client_error(code: str, operation: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "secret"}}, operation)


class MemoryS3:
    def __init__(self) -> None:
        self.objects: dict[str, dict[str, object]] = {}
        self.calls: list[tuple[str, dict[str, object]]] = []

    def put_object(self, **kwargs: object) -> Mapping[str, object]:
        self.calls.append(("put_object", dict(kwargs)))
        key = cast(str, kwargs["Key"])
        if kwargs.get("IfNoneMatch") == "*" and key in self.objects:
            raise _client_error("PreconditionFailed", "PutObject")
        body = cast(bytes, kwargs["Body"])
        checksum = base64.b64encode(hashlib.sha256(body).digest()).decode("ascii")
        assert kwargs["ChecksumSHA256"] == checksum
        self.objects[key] = {
            "Body": body,
            "ContentLength": len(body),
            "ChecksumSHA256": checksum,
            "Metadata": dict(cast(Mapping[str, str], kwargs["Metadata"])),
        }
        return {"ChecksumSHA256": checksum}

    def get_object(self, **kwargs: object) -> Mapping[str, object]:
        self.calls.append(("get_object", dict(kwargs)))
        key = cast(str, kwargs["Key"])
        if key not in self.objects:
            raise _client_error("NoSuchKey", "GetObject")
        stored = self.objects[key]
        return {**stored, "Body": io.BytesIO(cast(bytes, stored["Body"]))}


def store(client: MemoryS3) -> S3CanonicalSetStore:
    return S3CanonicalSetStore(
        client,
        "archive-bucket",
        expected_bucket_owner="123456789012",
    )


def replace_stored_payload(client: MemoryS3, body: bytes) -> None:
    key = "canonical/schema_version=1.0/dataset_version=dsv_a/manifest.json"
    checksum = base64.b64encode(hashlib.sha256(body).digest()).decode("ascii")
    client.objects[key].update(
        Body=body,
        ContentLength=len(body),
        ChecksumSHA256=checksum,
        Metadata={"sha256": hashlib.sha256(body).hexdigest()},
    )


def test_commit_is_conditional_checksum_bound_and_replay_safe() -> None:
    client = MemoryS3()
    repository = store(client)
    value = canonical_set()

    assert repository.commit(value, idempotency_key="commit-a") == value
    assert repository.commit(value, idempotency_key="commit-a-replay") == value
    assert repository.get("dsv_a") == value

    put = next(payload for name, payload in client.calls if name == "put_object")
    assert put["Key"] == ("canonical/schema_version=1.0/dataset_version=dsv_a/manifest.json")
    assert put["IfNoneMatch"] == "*"
    assert put["ExpectedBucketOwner"] == "123456789012"
    assert put["ChecksumAlgorithm"] == "SHA256"
    assert (
        cast(Mapping[str, str], put["Metadata"])["sha256"]
        == hashlib.sha256(cast(bytes, put["Body"])).hexdigest()
    )
    assert all(payload["ExpectedBucketOwner"] == "123456789012" for _, payload in client.calls)
    assert not any(name.startswith("list_") for name, _ in client.calls)


def test_same_dataset_version_with_different_evidence_is_terminal_conflict() -> None:
    client = MemoryS3()
    repository = store(client)
    repository.commit(canonical_set(), idempotency_key="commit-original")

    with pytest.raises(CanonicalSetConflict, match="differs"):
        repository.commit(
            canonical_set(object_sha="e" * 64),
            idempotency_key="commit-conflict",
        )


def test_get_preserves_s3_unavailability_as_a_storage_failure() -> None:
    class UnavailableS3(MemoryS3):
        def get_object(self, **_kwargs: object) -> Mapping[str, object]:
            raise _client_error("ServiceUnavailable", "GetObject")

    with pytest.raises(CanonicalSetStorageError, match="ServiceUnavailable"):
        store(UnavailableS3()).get("dsv_a")


@pytest.mark.parametrize("corruption", ["schema", "counts", "object", "digest", "checksum"])
def test_read_rejects_invalid_schema_checksum_and_unexpected_keys(corruption: str) -> None:
    client = MemoryS3()
    repository = store(client)
    value = canonical_set()
    repository.commit(value, idempotency_key="commit")
    stored = client.objects["canonical/schema_version=1.0/dataset_version=dsv_a/manifest.json"]

    if corruption == "schema":
        document = canonical_set_to_document(value)
        document["signedUrl"] = "https://example.invalid/secret"
        body = json.dumps(document, separators=(",", ":"), sort_keys=True).encode()
        stored["Body"] = body
        stored["ContentLength"] = len(body)
        checksum = base64.b64encode(hashlib.sha256(body).digest()).decode("ascii")
        stored["ChecksumSHA256"] = checksum
        stored["Metadata"] = {"sha256": hashlib.sha256(body).hexdigest()}
    elif corruption == "checksum":
        stored["ChecksumSHA256"] = base64.b64encode(b"x" * 32).decode("ascii")
    else:
        document = canonical_set_to_document(value)
        if corruption == "counts":
            document["totalSourceRows"] = cast(int, document["totalSourceRows"]) + 1
        elif corruption == "digest":
            document["aggregateDigest"] = "0" * 64
        else:
            datasets = cast(list[dict[str, object]], document["datasets"])
            app_error = next(item for item in datasets if item["dataset"] == "app_error")
            partitions = cast(list[dict[str, object]], app_error["partitions"])
            objects = cast(list[dict[str, object]], partitions[0]["objects"])
            objects[0]["objectKey"] = cast(str, objects[0]["objectKey"]).replace(
                "generation=", "generation=unexpected-"
            )
        body = json.dumps(document, separators=(",", ":"), sort_keys=True).encode()
        stored["Body"] = body
        stored["ContentLength"] = len(body)
        checksum = base64.b64encode(hashlib.sha256(body).digest()).decode("ascii")
        stored["ChecksumSHA256"] = checksum
        stored["Metadata"] = {"sha256": hashlib.sha256(body).hexdigest()}

    expected_error = (
        CanonicalSetChecksumMismatch if corruption == "checksum" else CanonicalSetEvidenceError
    )
    with pytest.raises(expected_error):
        repository.get("dsv_a")


def test_get_rejects_manifest_whose_payload_claims_another_dataset_version() -> None:
    client = MemoryS3()
    repository = store(client)
    value = canonical_set()
    repository.commit(value, idempotency_key="commit")
    key = "canonical/schema_version=1.0/dataset_version=dsv_a/manifest.json"
    stored = client.objects[key]
    document = canonical_set_to_document(value)
    document["datasetVersion"] = "dsv_other"
    body = json.dumps(document, separators=(",", ":"), sort_keys=True).encode()
    checksum = base64.b64encode(hashlib.sha256(body).digest()).decode("ascii")
    stored.update(
        Body=body,
        ContentLength=len(body),
        ChecksumSHA256=checksum,
        Metadata={"sha256": hashlib.sha256(body).hexdigest()},
    )

    with pytest.raises(CanonicalSetConflict, match="dataset version"):
        repository.get("dsv_a")


def test_get_rejects_duplicate_json_members_even_with_matching_checksum() -> None:
    client = MemoryS3()
    repository = store(client)
    repository.commit(canonical_set(), idempotency_key="commit")
    key = "canonical/schema_version=1.0/dataset_version=dsv_a/manifest.json"
    original = cast(bytes, client.objects[key]["Body"])
    duplicate = b'{"schemaVersion":"1.0",' + original[1:]
    replace_stored_payload(client, duplicate)

    with pytest.raises(CanonicalSetEvidenceError):
        repository.get("dsv_a")


def test_get_rejects_hostile_json_depth_below_manifest_size_limit() -> None:
    client = MemoryS3()
    repository = store(client)
    repository.commit(canonical_set(), idempotency_key="commit")
    depth = 10_000
    hostile = (b"[" * depth) + b"0" + (b"]" * depth)
    assert len(hostile) < repository.max_manifest_bytes
    replace_stored_payload(client, hostile)

    with pytest.raises(CanonicalSetEvidenceError):
        repository.get("dsv_a")
