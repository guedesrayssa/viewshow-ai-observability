"""Send and receive closed incremental batch envelopes on an SQS FIFO queue."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from typing import Protocol
from urllib.parse import urlsplit

from domain.canonical_json import canonical_bytes
from domain.incremental_batches import BatchDelivery, IncrementalBatchReference
from ports.incremental import IncrementalBatchQueue

MAX_SQS_MESSAGE_BYTES = 256 * 1024
_BATCH_ID = re.compile(r"^bat_[0-9a-f]{64}$")
_DATASET = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
_BUCKET = re.compile(r"^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$")
_MANIFEST_KEY = re.compile(
    r"^raw/argus/incremental/dataset=(?P<dataset>[A-Za-z0-9_.-]{1,128})/"
    r"window_start=[0-9]{8}T[0-9]{9}Z/batch_id=(?P<batch>bat_[0-9a-f]{64})/manifest\.json$"
)


class IncrementalSqsClient(Protocol):
    def send_message(self, **kwargs: object) -> Mapping[str, object]: ...
    def receive_message(self, **kwargs: object) -> Mapping[str, object]: ...
    def delete_message(self, **kwargs: object) -> Mapping[str, object]: ...
    def change_message_visibility(self, **kwargs: object) -> Mapping[str, object]: ...


def _text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value or value.strip() != value:
        raise ValueError(f"{field} must be a non-empty canonical string")
    if any(ord(character) < 32 for character in value):
        raise ValueError(f"{field} contains control characters")
    return value


def _queue_url(value: object) -> str:
    url = _text(value, "queue_url")
    parsed = urlsplit(url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or not parsed.path.endswith(".fifo")
        or bool(parsed.query)
        or bool(parsed.fragment)
        or any(character.isspace() for character in url)
    ):
        raise ValueError("queue_url must identify an absolute SQS FIFO queue")
    return url


def _reference(
    value: object,
    *,
    expected_batch_id: str | None = None,
    expected_dataset: str | None = None,
) -> IncrementalBatchReference:
    if isinstance(value, IncrementalBatchReference):
        reference = value
    else:
        if not isinstance(value, Mapping) or set(value) != {"bucket", "key", "versionId"}:
            raise ValueError("manifest fields must be exactly bucket, key and versionId")
        reference = IncrementalBatchReference(
            _text(value.get("bucket"), "manifest.bucket"),
            _text(value.get("key"), "manifest.key"),
            _text(value.get("versionId"), "manifest.versionId"),
        )
    if _BUCKET.fullmatch(reference.bucket) is None or ".." in reference.bucket:
        raise ValueError("manifest.bucket must be a canonical S3 bucket name")
    matched = _MANIFEST_KEY.fullmatch(reference.key)
    if matched is None:
        raise ValueError("manifest.key is not an incremental manifest key")
    if expected_batch_id is not None and matched.group("batch") != expected_batch_id:
        raise ValueError("manifest.key batch identity differs from batchId")
    if expected_dataset is not None and matched.group("dataset") != expected_dataset:
        raise ValueError("manifest.key dataset differs from sourceDataset")
    _text(reference.version_id, "manifest.versionId")
    return reference


class SqsIncrementalBatchQueue(IncrementalBatchQueue):
    def __init__(self, client: IncrementalSqsClient, queue_url: str) -> None:
        self._client = client
        self._queue_url = _queue_url(queue_url)

    def send(
        self,
        reference: IncrementalBatchReference,
        *,
        batch_id: str,
        dataset: str,
    ) -> None:
        if not isinstance(batch_id, str) or _BATCH_ID.fullmatch(batch_id) is None:
            raise ValueError("batch_id must be a canonical incremental batch ID")
        if not isinstance(dataset, str) or _DATASET.fullmatch(dataset) is None:
            raise ValueError("dataset must be a safe non-empty identifier")
        validated = _reference(
            reference,
            expected_batch_id=batch_id,
            expected_dataset=dataset,
        )
        body = canonical_bytes(
            {
                "contractVersion": "1.0",
                "batchId": batch_id,
                "sourceDataset": dataset,
                "manifest": {
                    "bucket": validated.bucket,
                    "key": validated.key,
                    "versionId": validated.version_id,
                },
            }
        )
        if len(body) > MAX_SQS_MESSAGE_BYTES:
            raise ValueError("incremental queue message size exceeds 256 KiB")
        self._client.send_message(
            QueueUrl=self._queue_url,
            MessageBody=body.decode("utf-8"),
            MessageGroupId=dataset,
            MessageDeduplicationId=batch_id,
        )

    def _delivery(self, value: object) -> BatchDelivery:
        if not isinstance(value, Mapping):
            raise ValueError("SQS message must be a mapping")
        message_id = _text(value.get("MessageId"), "MessageId")
        receipt_handle = _text(value.get("ReceiptHandle"), "ReceiptHandle")
        raw_body = _text(value.get("Body"), "Body")
        if len(raw_body.encode("utf-8")) > MAX_SQS_MESSAGE_BYTES:
            raise ValueError("incremental queue message size exceeds 256 KiB")
        try:
            payload = json.loads(raw_body)
        except (TypeError, ValueError) as error:
            raise ValueError("incremental queue message body must be JSON") from error
        if not isinstance(payload, Mapping) or set(payload) != {
            "contractVersion",
            "batchId",
            "sourceDataset",
            "manifest",
        }:
            raise ValueError("incremental queue message fields are not closed")
        if payload.get("contractVersion") != "1.0":
            raise ValueError("incremental queue contractVersion must be '1.0'")
        batch_id = _text(payload.get("batchId"), "batchId")
        dataset = _text(payload.get("sourceDataset"), "sourceDataset")
        if _BATCH_ID.fullmatch(batch_id) is None:
            raise ValueError("batchId must be a canonical incremental batch ID")
        if _DATASET.fullmatch(dataset) is None:
            raise ValueError("sourceDataset must be a safe identifier")
        reference = _reference(
            payload.get("manifest"),
            expected_batch_id=batch_id,
            expected_dataset=dataset,
        )
        return BatchDelivery(message_id, batch_id, dataset, reference, receipt_handle)

    def receive(self, limit: int) -> tuple[BatchDelivery, ...]:
        if type(limit) is not int:
            raise TypeError("limit must be an integer")
        if limit < 1 or limit > 10:
            raise ValueError("limit must be between 1 and 10")
        response = self._client.receive_message(
            QueueUrl=self._queue_url,
            MaxNumberOfMessages=limit,
            WaitTimeSeconds=20,
        )
        if not isinstance(response, Mapping):
            raise ValueError("SQS ReceiveMessage response must be a mapping")
        messages = response.get("Messages", [])
        if not isinstance(messages, list):
            raise ValueError("SQS ReceiveMessage Messages must be a list")
        return tuple(self._delivery(message) for message in messages)

    def ack(self, delivery: BatchDelivery) -> None:
        if not isinstance(delivery, BatchDelivery):
            raise TypeError("delivery must be a BatchDelivery")
        self._client.delete_message(
            QueueUrl=self._queue_url,
            ReceiptHandle=_text(delivery.receipt_handle, "receipt_handle"),
        )

    def extend_visibility(self, delivery: BatchDelivery, seconds: int) -> None:
        if not isinstance(delivery, BatchDelivery):
            raise TypeError("delivery must be a BatchDelivery")
        if type(seconds) is not int:
            raise TypeError("seconds must be an integer")
        if seconds < 0 or seconds > 43_200:
            raise ValueError("seconds must be between 0 and 43200")
        self._client.change_message_visibility(
            QueueUrl=self._queue_url,
            ReceiptHandle=_text(delivery.receipt_handle, "receipt_handle"),
            VisibilityTimeout=seconds,
        )


__all__ = ["IncrementalSqsClient", "MAX_SQS_MESSAGE_BYTES", "SqsIncrementalBatchQueue"]
