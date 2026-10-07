"""Persist incremental batch claims and state transitions with DynamoDB CAS."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Protocol

from boto3.dynamodb.types import TypeSerializer  # type: ignore[import-untyped]
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from adapters.dynamodb.client import decode_get_item
from domain.canonical_json import canonical_bytes
from domain.incremental_batches import (
    BatchState,
    IncrementalBatchManifest,
    IncrementalBatchRecord,
    IncrementalBatchReference,
)
from ports import ConditionalWriteError, IdempotencyConflict
from ports.incremental import IncrementalBatchRepository

_SERIALIZER = TypeSerializer()
_BATCH_ID = re.compile(r"^bat_[0-9a-f]{64}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_SAFE_ERROR_CODE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
_COUNT_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")
_ALLOWED_TRANSITIONS = frozenset(
    {
        (BatchState.RECEIVED, BatchState.VALIDATING),
        (BatchState.RETRYABLE_FAILED, BatchState.VALIDATING),
        (BatchState.VALIDATING, BatchState.INGESTING),
        (BatchState.VALIDATING, BatchState.RETRYABLE_FAILED),
        (BatchState.INGESTING, BatchState.COMMITTING),
        (BatchState.INGESTING, BatchState.RETRYABLE_FAILED),
    }
)


class IncrementalBatchDynamoClient(Protocol):
    def put_item(self, **kwargs: object) -> Mapping[str, object]: ...
    def get_item(self, **kwargs: object) -> Mapping[str, object]: ...
    def update_item(self, **kwargs: object) -> Mapping[str, object]: ...


class IncrementalBatchRepositoryError(RuntimeError):
    """The DynamoDB response could not prove the requested batch operation."""


def _serialize(value: Mapping[str, object]) -> dict[str, object]:
    return {name: _SERIALIZER.serialize(item) for name, item in value.items()}


def _batch_id(value: object) -> str:
    if not isinstance(value, str) or _BATCH_ID.fullmatch(value) is None:
        raise ValueError("batch_id must be a canonical incremental batch ID")
    return value


def _key(batch_id: str) -> dict[str, object]:
    return _serialize({"pk": f"BATCH#{_batch_id(batch_id)}", "sk": "META"})


def _utc_text(value: datetime) -> str:
    if type(value) is not datetime or value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError("clock must return an aware UTC datetime")
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _integer(value: object, field: str) -> int:
    if isinstance(value, Decimal):
        if value != value.to_integral_value():
            raise IncrementalBatchRepositoryError(f"DynamoDB {field} must be an integer")
        value = int(value)
    if type(value) is not int or value < 0:
        raise IncrementalBatchRepositoryError(f"DynamoDB {field} must be non-negative")
    return value


def _reference_mapping(reference: IncrementalBatchReference) -> dict[str, object]:
    if not isinstance(reference, IncrementalBatchReference):
        raise TypeError("reference must be an IncrementalBatchReference")
    for field, value in (
        ("bucket", reference.bucket),
        ("key", reference.key),
        ("versionId", reference.version_id),
    ):
        if not isinstance(value, str) or not value or value.strip() != value:
            raise ValueError(f"reference {field} must be a non-empty canonical string")
    return {
        "bucket": reference.bucket,
        "key": reference.key,
        "versionId": reference.version_id,
    }


def _decode_reference(value: object) -> IncrementalBatchReference:
    if not isinstance(value, Mapping) or set(value) != {"bucket", "key", "versionId"}:
        raise IncrementalBatchRepositoryError("DynamoDB batch reference has an invalid shape")
    try:
        bucket = value["bucket"]
        key = value["key"]
        version_id = value["versionId"]
    except KeyError as error:
        raise IncrementalBatchRepositoryError("DynamoDB batch reference is incomplete") from error
    if not all(isinstance(item, str) and item for item in (bucket, key, version_id)):
        raise IncrementalBatchRepositoryError("DynamoDB batch reference contains invalid text")
    return IncrementalBatchReference(bucket, key, version_id)


def _counts(value: Mapping[str, int]) -> dict[str, int]:
    result: dict[str, int] = {}
    for name, count in value.items():
        if not isinstance(name, str) or _COUNT_NAME.fullmatch(name) is None:
            raise ValueError("counts keys must be safe identifiers")
        if type(count) is not int or count < 0:
            raise ValueError("counts values must be non-negative integers")
        result[name] = count
    return result


class DynamoIncrementalBatchRepository(IncrementalBatchRepository):
    def __init__(
        self,
        client: IncrementalBatchDynamoClient,
        table_name: str,
        *,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        if not isinstance(table_name, str) or not table_name or table_name.strip() != table_name:
            raise ValueError("table_name must be a non-empty canonical string")
        if not callable(clock):
            raise TypeError("clock must be callable")
        self._client = client
        self._table_name = table_name
        self._clock = clock

    def _now(self) -> str:
        return _utc_text(self._clock())

    def _get(self, batch_id: str) -> dict[str, object] | None:
        response = self._client.get_item(
            TableName=self._table_name,
            Key=_key(batch_id),
            ConsistentRead=True,
        )
        item = decode_get_item(response)
        if item is not None and (item.get("pk") != f"BATCH#{batch_id}" or item.get("sk") != "META"):
            raise IncrementalBatchRepositoryError("DynamoDB returned a different batch key")
        return item

    def _record(self, item: Mapping[str, object]) -> IncrementalBatchRecord:
        required = {
            "pk",
            "sk",
            "batchId",
            "manifestSha256",
            "reference",
            "state",
            "version",
            "createdAt",
            "updatedAt",
        }
        if not required.issubset(item) or set(item) - (required | {"counts", "errorCode"}):
            raise IncrementalBatchRepositoryError("DynamoDB batch item has an invalid shape")
        batch_id = _batch_id(item.get("batchId"))
        if item.get("pk") != f"BATCH#{batch_id}" or item.get("sk") != "META":
            raise IncrementalBatchRepositoryError("DynamoDB batch item identity is inconsistent")
        digest = item.get("manifestSha256")
        if not isinstance(digest, str) or _SHA256.fullmatch(digest) is None:
            raise IncrementalBatchRepositoryError("DynamoDB manifest checksum is invalid")
        raw_state = item.get("state")
        if not isinstance(raw_state, str):
            raise IncrementalBatchRepositoryError("DynamoDB batch state is invalid")
        try:
            state = BatchState(raw_state)
        except (TypeError, ValueError) as error:
            raise IncrementalBatchRepositoryError("DynamoDB batch state is invalid") from error
        if not all(
            isinstance(item.get(name), str) and item.get(name)
            for name in ("createdAt", "updatedAt")
        ):
            raise IncrementalBatchRepositoryError("DynamoDB batch timestamps are invalid")
        if "counts" in item:
            raw_counts = item["counts"]
            if not isinstance(raw_counts, Mapping):
                raise IncrementalBatchRepositoryError("DynamoDB batch counts are invalid")
            try:
                _counts({str(name): _integer(count, "count") for name, count in raw_counts.items()})
            except ValueError as error:
                raise IncrementalBatchRepositoryError(
                    "DynamoDB batch counts are invalid"
                ) from error
        error_code = item.get("errorCode")
        if error_code is not None and (
            not isinstance(error_code, str) or _SAFE_ERROR_CODE.fullmatch(error_code) is None
        ):
            raise IncrementalBatchRepositoryError("DynamoDB batch error code is invalid")
        return IncrementalBatchRecord(
            batch_id=batch_id,
            state=state,
            version=_integer(item.get("version"), "version"),
            manifest_sha256=digest,
            reference=_decode_reference(item.get("reference")),
        )

    @staticmethod
    def _manifest_digest(manifest: IncrementalBatchManifest) -> str:
        if not isinstance(manifest, IncrementalBatchManifest):
            raise TypeError("manifest must be an IncrementalBatchManifest")
        return hashlib.sha256(canonical_bytes(manifest.to_mapping())).hexdigest()

    def claim(
        self,
        manifest: IncrementalBatchManifest,
        reference: IncrementalBatchReference,
    ) -> IncrementalBatchRecord:
        digest = self._manifest_digest(manifest)
        batch_id = _batch_id(manifest.batch_id)
        reference_value = _reference_mapping(reference)
        now = self._now()
        item = {
            "pk": f"BATCH#{batch_id}",
            "sk": "META",
            "batchId": batch_id,
            "manifestSha256": digest,
            "reference": reference_value,
            "state": BatchState.RECEIVED.value,
            "version": 0,
            "createdAt": now,
            "updatedAt": now,
        }
        try:
            self._client.put_item(
                TableName=self._table_name,
                Item=_serialize(item),
                ConditionExpression="attribute_not_exists(pk)",
            )
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise
            existing = self._get(batch_id)
            if existing is None:
                raise ConditionalWriteError(
                    "batch claim conflicted without a stored item"
                ) from None
            record = self._record(existing)
            if record.manifest_sha256 != digest or record.reference != reference:
                raise IdempotencyConflict(
                    "batch_id was reused with a different manifest or reference"
                ) from None
            return record
        return self._record(item)

    def _update(
        self,
        batch_id: str,
        expected_state: BatchState,
        expected_version: int,
        next_state: BatchState,
        *,
        counts: Mapping[str, int] | None = None,
        error_code: str | None = None,
    ) -> IncrementalBatchRecord:
        canonical_id = _batch_id(batch_id)
        if not isinstance(expected_state, BatchState) or not isinstance(next_state, BatchState):
            raise TypeError("expected_state and next_state must be BatchState values")
        if type(expected_version) is not int or expected_version < 0:
            raise ValueError("expected_version must be a non-negative integer")
        values: dict[str, object] = {
            ":expectedState": expected_state.value,
            ":expectedVersion": expected_version,
            ":nextState": next_state.value,
            ":nextVersion": expected_version + 1,
            ":updatedAt": self._now(),
        }
        expressions = [
            "#state = :nextState",
            "#version = :nextVersion",
            "#updatedAt = :updatedAt",
        ]
        names = {"#state": "state", "#version": "version", "#updatedAt": "updatedAt"}
        if counts is not None:
            values[":counts"] = _counts(counts)
            names["#counts"] = "counts"
            expressions.append("#counts = :counts")
        if error_code is not None:
            if not isinstance(error_code, str) or _SAFE_ERROR_CODE.fullmatch(error_code) is None:
                raise ValueError("error_code must be a safe code of at most 128 characters")
            values[":errorCode"] = error_code
            names["#errorCode"] = "errorCode"
            expressions.append("#errorCode = :errorCode")
        try:
            response = self._client.update_item(
                TableName=self._table_name,
                Key=_key(canonical_id),
                UpdateExpression="SET " + ", ".join(expressions),
                ConditionExpression=(
                    "attribute_exists(pk) AND #state = :expectedState "
                    "AND #version = :expectedVersion"
                ),
                ExpressionAttributeNames=names,
                ExpressionAttributeValues=_serialize(values),
                ReturnValues="ALL_NEW",
            )
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                raise ConditionalWriteError(
                    "batch state or version differs from expected"
                ) from None
            raise
        if not isinstance(response, Mapping) or "Attributes" not in response:
            raise IncrementalBatchRepositoryError("DynamoDB update returned no batch item")
        item = decode_get_item({"Item": response["Attributes"]})
        if item is None:
            raise IncrementalBatchRepositoryError("DynamoDB update returned no batch item")
        record = self._record(item)
        if (
            record.batch_id != canonical_id
            or record.state is not next_state
            or record.version != expected_version + 1
        ):
            raise IncrementalBatchRepositoryError("DynamoDB update confirmation is inconsistent")
        return record

    def transition(
        self,
        batch_id: str,
        expected_state: BatchState,
        expected_version: int,
        next_state: BatchState,
    ) -> IncrementalBatchRecord:
        if not isinstance(expected_state, BatchState) or not isinstance(next_state, BatchState):
            raise TypeError("expected_state and next_state must be BatchState values")
        if (expected_state, next_state) not in _ALLOWED_TRANSITIONS:
            raise ValueError("batch transition is not allowed by the lifecycle")
        return self._update(batch_id, expected_state, expected_version, next_state)

    def finish(
        self,
        batch_id: str,
        expected_state: BatchState,
        expected_version: int,
        next_state: BatchState,
        *,
        counts: Mapping[str, int],
        error_code: str | None = None,
    ) -> IncrementalBatchRecord:
        if not isinstance(expected_state, BatchState) or not isinstance(next_state, BatchState):
            raise TypeError("expected_state and next_state must be BatchState values")
        if next_state not in {BatchState.COMPLETED, BatchState.QUARANTINED}:
            raise ValueError("finish next_state must be COMPLETED or QUARANTINED")
        if next_state is BatchState.COMPLETED and expected_state is not BatchState.COMMITTING:
            raise ValueError("COMPLETED requires a transition from COMMITTING")
        if next_state is BatchState.QUARANTINED and expected_state not in {
            BatchState.VALIDATING,
            BatchState.INGESTING,
        }:
            raise ValueError("QUARANTINED requires a transition from VALIDATING or INGESTING")
        return self._update(
            batch_id,
            expected_state,
            expected_version,
            next_state,
            counts=counts,
            error_code=error_code,
        )


__all__ = [
    "DynamoIncrementalBatchRepository",
    "IncrementalBatchDynamoClient",
    "IncrementalBatchRepositoryError",
]
