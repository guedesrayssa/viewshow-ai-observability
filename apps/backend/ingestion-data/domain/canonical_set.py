"""Model the immutable, authoritative evidence for one canonical archive generation."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime
from typing import cast

from contracts.registry import EXPECTED_ARGUS_V2_DATASETS
from domain.archive import canonical_archive_key, partition_date, require_key_component
from domain.canonical_json import canonical_bytes

MAX_CANONICAL_OBJECT_BYTES = 512 * 1024 * 1024
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_SET_FIELDS = frozenset(
    {
        "schemaVersion",
        "datasetVersion",
        "sourceSha256",
        "contractVersion",
        "snapshotExtractedOn",
        "aggregateDigest",
        "datasets",
        "totalSourceRows",
        "totalAcceptedRows",
        "totalRejectedRows",
    }
)
_DATASET_FIELDS = frozenset(
    {
        "dataset",
        "sourceRowCount",
        "acceptedRowCount",
        "rejectedRowCount",
        "schemaFingerprint",
        "coverage",
        "partitions",
    }
)
_PARTITION_FIELDS = frozenset({"dataset", "partition", "rowCount", "objects"})
_OBJECT_FIELDS = frozenset({"objectKey", "rowCount", "byteCount", "sha256"})


@dataclass(frozen=True, slots=True)
class CanonicalObjectEvidence:
    object_key: str
    row_count: int
    byte_count: int
    sha256: str


@dataclass(frozen=True, slots=True)
class CanonicalPartitionEvidence:
    dataset: str
    partition: str
    row_count: int
    objects: tuple[CanonicalObjectEvidence, ...]


@dataclass(frozen=True, slots=True)
class CanonicalDatasetEvidence:
    dataset: str
    source_row_count: int
    accepted_row_count: int
    rejected_row_count: int
    schema_fingerprint: str
    coverage: str
    partitions: tuple[CanonicalPartitionEvidence, ...]


@dataclass(frozen=True, slots=True)
class CanonicalSet:
    schema_version: str
    dataset_version: str
    source_sha256: str
    contract_version: str
    snapshot_extracted_on: date
    aggregate_digest: str
    datasets: tuple[CanonicalDatasetEvidence, ...]
    total_source_rows: int
    total_accepted_rows: int
    total_rejected_rows: int

    def __post_init__(self) -> None:
        """Reject incomplete, reordered, conflicting, or circular physical evidence."""
        _validate_canonical_set(self)


def _non_negative_int(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field} must be an integer")
    if value < 0:
        raise ValueError(f"{field} must be non-negative")
    return value


def _sha256(value: object, field: str) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise ValueError(f"{field} must be a lowercase hexadecimal SHA-256 digest")
    return value


def _nonempty_text(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    if not value:
        raise ValueError(f"{field} must not be empty")
    return value


def _logical_document(
    *,
    schema_version: str,
    dataset_version: str,
    source_sha256: str,
    contract_version: str,
    snapshot_extracted_on: date,
    datasets: tuple[CanonicalDatasetEvidence, ...],
    total_source_rows: int,
    total_accepted_rows: int,
    total_rejected_rows: int,
) -> dict[str, object]:
    return {
        "schemaVersion": schema_version,
        "datasetVersion": dataset_version,
        "sourceSha256": source_sha256,
        "contractVersion": contract_version,
        "snapshotExtractedOn": snapshot_extracted_on.isoformat(),
        "datasets": [
            {
                "dataset": dataset.dataset,
                "sourceRowCount": dataset.source_row_count,
                "acceptedRowCount": dataset.accepted_row_count,
                "rejectedRowCount": dataset.rejected_row_count,
                "schemaFingerprint": dataset.schema_fingerprint,
                "coverage": dataset.coverage,
                "partitions": [
                    {
                        "dataset": partition.dataset,
                        "partition": partition.partition,
                        "rowCount": partition.row_count,
                        "objects": [
                            {
                                "rowCount": item.row_count,
                                "byteCount": item.byte_count,
                                "sha256": item.sha256,
                            }
                            for item in partition.objects
                        ],
                    }
                    for partition in dataset.partitions
                ],
            }
            for dataset in datasets
        ],
        "totalSourceRows": total_source_rows,
        "totalAcceptedRows": total_accepted_rows,
        "totalRejectedRows": total_rejected_rows,
    }


def canonical_set_aggregate_digest(
    *,
    schema_version: str,
    dataset_version: str,
    source_sha256: str,
    contract_version: str,
    snapshot_extracted_on: date,
    datasets: tuple[CanonicalDatasetEvidence, ...],
    total_source_rows: int,
    total_accepted_rows: int,
    total_rejected_rows: int,
) -> str:
    """Hash logical evidence before generation-dependent object keys are inserted."""
    if not isinstance(snapshot_extracted_on, date) or isinstance(snapshot_extracted_on, datetime):
        raise TypeError("snapshot_extracted_on must be a date")
    document = _logical_document(
        schema_version=schema_version,
        dataset_version=dataset_version,
        source_sha256=source_sha256,
        contract_version=contract_version,
        snapshot_extracted_on=snapshot_extracted_on,
        datasets=datasets,
        total_source_rows=total_source_rows,
        total_accepted_rows=total_accepted_rows,
        total_rejected_rows=total_rejected_rows,
    )
    return hashlib.sha256(canonical_bytes(document)).hexdigest()


def _validate_canonical_set(value: CanonicalSet) -> None:
    if value.schema_version != "1.0":
        raise ValueError("schema_version must be 1.0")
    require_key_component(value.dataset_version, "dataset_version")
    _sha256(value.source_sha256, "source_sha256")
    _nonempty_text(value.contract_version, "contract_version")
    if not isinstance(value.snapshot_extracted_on, date) or isinstance(
        value.snapshot_extracted_on, datetime
    ):
        raise TypeError("snapshot_extracted_on must be a date")
    _sha256(value.aggregate_digest, "aggregate_digest")
    if not isinstance(value.datasets, tuple):
        raise TypeError("datasets must be a tuple")
    names = tuple(item.dataset for item in value.datasets)
    if names != EXPECTED_ARGUS_V2_DATASETS:
        raise ValueError("datasets must match the complete registry order without duplicates")

    object_keys: set[str] = set()
    expected_object_keys: list[tuple[str, str]] = []
    for dataset in value.datasets:
        if not isinstance(dataset, CanonicalDatasetEvidence):
            raise TypeError("datasets must contain CanonicalDatasetEvidence values")
        _non_negative_int(dataset.source_row_count, "dataset source row count")
        _non_negative_int(dataset.accepted_row_count, "dataset accepted row count")
        _non_negative_int(dataset.rejected_row_count, "dataset rejected row count")
        if dataset.source_row_count != dataset.accepted_row_count + dataset.rejected_row_count:
            raise ValueError("dataset source rows must equal accepted plus rejected rows")
        _nonempty_text(dataset.schema_fingerprint, "schema_fingerprint")
        _nonempty_text(dataset.coverage, "coverage")
        if not isinstance(dataset.partitions, tuple):
            raise TypeError("partitions must be a tuple")
        identities = tuple((item.dataset, item.partition) for item in dataset.partitions)
        if identities != tuple(sorted(identities)) or len(identities) != len(set(identities)):
            raise ValueError(
                "partitions must be ordered by dataset and partition without duplicates"
            )
        if sum(item.row_count for item in dataset.partitions) != dataset.accepted_row_count:
            raise ValueError("partition row counts must equal dataset accepted rows")
        for partition in dataset.partitions:
            if not isinstance(partition, CanonicalPartitionEvidence):
                raise TypeError("partitions must contain CanonicalPartitionEvidence values")
            if partition.dataset != dataset.dataset:
                raise ValueError("partition dataset must match its containing dataset")
            partition_date(partition.partition)
            _non_negative_int(partition.row_count, "partition row count")
            if not isinstance(partition.objects, tuple):
                raise TypeError("objects must be a tuple")
            keys = tuple(item.object_key for item in partition.objects)
            if keys != tuple(sorted(keys)) or len(keys) != len(set(keys)):
                raise ValueError("objects must be ordered by key without duplicates")
            if sum(item.row_count for item in partition.objects) != partition.row_count:
                raise ValueError("object row counts must equal the partition row count")
            for ordinal, item in enumerate(partition.objects):
                if not isinstance(item, CanonicalObjectEvidence):
                    raise TypeError("objects must contain CanonicalObjectEvidence values")
                _non_negative_int(item.row_count, "object row count")
                byte_count = _non_negative_int(item.byte_count, "object byte count")
                if byte_count > MAX_CANONICAL_OBJECT_BYTES:
                    raise ValueError("canonical object must be at most 512 MiB")
                _sha256(item.sha256, "object sha256")
                expected_key = canonical_archive_key(
                    value.dataset_version,
                    dataset.dataset,
                    partition.partition,
                    item.sha256,
                    aggregate_digest=value.aggregate_digest,
                    ordinal=ordinal,
                )
                if item.object_key in object_keys:
                    raise ValueError("canonical object keys must be globally unique")
                object_keys.add(item.object_key)
                expected_object_keys.append((item.object_key, expected_key))

    totals = (
        sum(item.source_row_count for item in value.datasets),
        sum(item.accepted_row_count for item in value.datasets),
        sum(item.rejected_row_count for item in value.datasets),
    )
    supplied = (
        _non_negative_int(value.total_source_rows, "total_source_rows"),
        _non_negative_int(value.total_accepted_rows, "total_accepted_rows"),
        _non_negative_int(value.total_rejected_rows, "total_rejected_rows"),
    )
    if totals != supplied or supplied[0] != supplied[1] + supplied[2]:
        raise ValueError("canonical set totals differ from dataset totals")
    expected_digest = canonical_set_aggregate_digest(
        schema_version=value.schema_version,
        dataset_version=value.dataset_version,
        source_sha256=value.source_sha256,
        contract_version=value.contract_version,
        snapshot_extracted_on=value.snapshot_extracted_on,
        datasets=value.datasets,
        total_source_rows=value.total_source_rows,
        total_accepted_rows=value.total_accepted_rows,
        total_rejected_rows=value.total_rejected_rows,
    )
    if expected_digest != value.aggregate_digest:
        raise ValueError("aggregate_digest differs from canonical logical evidence")
    if any(actual != expected for actual, expected in expected_object_keys):
        raise ValueError("canonical object key differs from its evidence")


def canonical_set_to_document(value: CanonicalSet) -> dict[str, object]:
    if not isinstance(value, CanonicalSet):
        raise TypeError("value must be a CanonicalSet")
    document = _logical_document(
        schema_version=value.schema_version,
        dataset_version=value.dataset_version,
        source_sha256=value.source_sha256,
        contract_version=value.contract_version,
        snapshot_extracted_on=value.snapshot_extracted_on,
        datasets=value.datasets,
        total_source_rows=value.total_source_rows,
        total_accepted_rows=value.total_accepted_rows,
        total_rejected_rows=value.total_rejected_rows,
    )
    document["aggregateDigest"] = value.aggregate_digest
    datasets = cast(list[dict[str, object]], document["datasets"])
    for dataset_document, dataset in zip(datasets, value.datasets, strict=True):
        partition_documents = cast(list[dict[str, object]], dataset_document["partitions"])
        for partition_document, partition in zip(
            partition_documents, dataset.partitions, strict=True
        ):
            object_documents = cast(list[dict[str, object]], partition_document["objects"])
            for object_document, item in zip(object_documents, partition.objects, strict=True):
                object_document["objectKey"] = item.object_key
    return document


def _mapping(value: object, fields: frozenset[str], name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping) or not all(isinstance(key, str) for key in value):
        raise ValueError(f"{name} must be a JSON object")
    if set(value) != fields:
        raise ValueError(f"{name} fields differ from the canonical schema")
    return cast(Mapping[str, object], value)


def _array(value: object, name: str) -> list[object]:
    if not isinstance(value, list):
        raise ValueError(f"{name} must be a JSON array")
    return value


def canonical_set_from_document(document: object) -> CanonicalSet:
    root = _mapping(document, _SET_FIELDS, "canonical set")
    raw_datasets = _array(root["datasets"], "datasets")
    datasets: list[CanonicalDatasetEvidence] = []
    for raw_dataset in raw_datasets:
        dataset = _mapping(raw_dataset, _DATASET_FIELDS, "dataset evidence")
        partitions: list[CanonicalPartitionEvidence] = []
        for raw_partition in _array(dataset["partitions"], "partitions"):
            partition = _mapping(raw_partition, _PARTITION_FIELDS, "partition evidence")
            objects: list[CanonicalObjectEvidence] = []
            for raw_object in _array(partition["objects"], "objects"):
                item = _mapping(raw_object, _OBJECT_FIELDS, "object evidence")
                objects.append(
                    CanonicalObjectEvidence(
                        _nonempty_text(item["objectKey"], "objectKey"),
                        _non_negative_int(item["rowCount"], "rowCount"),
                        _non_negative_int(item["byteCount"], "byteCount"),
                        _sha256(item["sha256"], "sha256"),
                    )
                )
            partitions.append(
                CanonicalPartitionEvidence(
                    _nonempty_text(partition["dataset"], "partition dataset"),
                    _nonempty_text(partition["partition"], "partition"),
                    _non_negative_int(partition["rowCount"], "partition rowCount"),
                    tuple(objects),
                )
            )
        datasets.append(
            CanonicalDatasetEvidence(
                _nonempty_text(dataset["dataset"], "dataset"),
                _non_negative_int(dataset["sourceRowCount"], "sourceRowCount"),
                _non_negative_int(dataset["acceptedRowCount"], "acceptedRowCount"),
                _non_negative_int(dataset["rejectedRowCount"], "rejectedRowCount"),
                _nonempty_text(dataset["schemaFingerprint"], "schemaFingerprint"),
                _nonempty_text(dataset["coverage"], "coverage"),
                tuple(partitions),
            )
        )
    snapshot = _nonempty_text(root["snapshotExtractedOn"], "snapshotExtractedOn")
    try:
        snapshot_date = date.fromisoformat(snapshot)
    except ValueError as error:
        raise ValueError("snapshotExtractedOn must be an ISO calendar date") from error
    if snapshot_date.isoformat() != snapshot:
        raise ValueError("snapshotExtractedOn must be a canonical ISO calendar date")
    return CanonicalSet(
        _nonempty_text(root["schemaVersion"], "schemaVersion"),
        _nonempty_text(root["datasetVersion"], "datasetVersion"),
        _sha256(root["sourceSha256"], "sourceSha256"),
        _nonempty_text(root["contractVersion"], "contractVersion"),
        snapshot_date,
        _sha256(root["aggregateDigest"], "aggregateDigest"),
        tuple(datasets),
        _non_negative_int(root["totalSourceRows"], "totalSourceRows"),
        _non_negative_int(root["totalAcceptedRows"], "totalAcceptedRows"),
        _non_negative_int(root["totalRejectedRows"], "totalRejectedRows"),
    )


__all__ = [
    "MAX_CANONICAL_OBJECT_BYTES",
    "CanonicalDatasetEvidence",
    "CanonicalObjectEvidence",
    "CanonicalPartitionEvidence",
    "CanonicalSet",
    "canonical_set_aggregate_digest",
    "canonical_set_from_document",
    "canonical_set_to_document",
]
