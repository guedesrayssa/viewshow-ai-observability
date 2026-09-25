"""Immutable contracts for raw, incremental ARGUS batches."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path

from domain.analysis import canonical_utc_text, parse_canonical_utc_text
from domain.identity import sha256_id
from domain.models import TimeWindow

_SHA256 = re.compile(r"[0-9a-f]{64}")
_RAW_PREFIX = "raw/argus/incremental/"


class BatchState(StrEnum):
    RECEIVED = "RECEIVED"
    VALIDATING = "VALIDATING"
    INGESTING = "INGESTING"
    COMMITTING = "COMMITTING"
    COMPLETED = "COMPLETED"
    RETRYABLE_FAILED = "RETRYABLE_FAILED"
    QUARANTINED = "QUARANTINED"


@dataclass(frozen=True, slots=True)
class PhysicalColumn:
    name: str
    physical_type: str
    nullable: bool
    ordinal: int


@dataclass(frozen=True, slots=True)
class IncrementalBatchDefinition:
    source_system: str
    source_dataset: str
    window: TimeWindow
    revision: int
    exporter_version: str

    @property
    def batch_id(self) -> str:
        return incremental_batch_id(
            self.source_system,
            self.source_dataset,
            self.window,
            self.revision,
            self.exporter_version,
        )


@dataclass(frozen=True, slots=True)
class IncrementalBatchReference:
    bucket: str
    key: str
    version_id: str


@dataclass(frozen=True, slots=True)
class RawBatchPage:
    rows: tuple[Mapping[str, object], ...]
    next_offset: int | None


@dataclass(frozen=True, slots=True)
class EncodedRawBatch:
    path: Path
    row_count: int
    size_bytes: int
    sha256: str
    schema_fingerprint: str


@dataclass(frozen=True, slots=True)
class IncrementalBatchRecord:
    batch_id: str
    state: BatchState
    version: int
    manifest_sha256: str
    reference: IncrementalBatchReference


@dataclass(frozen=True, slots=True)
class BatchDelivery:
    message_id: str
    batch_id: str
    source_dataset: str
    reference: IncrementalBatchReference
    receipt_handle: str = field(repr=False)


@dataclass(frozen=True, slots=True)
class IncrementalBatchManifest:
    batch_id: str
    source_system: str
    source_dataset: str
    window: TimeWindow
    revision: int
    data_key: str
    data_version_id: str
    data_size_bytes: int
    data_sha256: str
    schema_fingerprint: str
    columns: tuple[PhysicalColumn, ...]
    extra_columns: tuple[str, ...]
    row_count: int
    exporter_version: str
    contract_version: str = "1.0"

    @classmethod
    def from_mapping(cls, payload: Mapping[str, object]) -> IncrementalBatchManifest:
        _closed_mapping(
            payload,
            {
                "contractVersion", "batchId", "sourceSystem", "sourceDataset", "window",
                "revision", "data", "schema", "rowCount", "exporterVersion",
            },
            "manifest",
        )
        if payload["contractVersion"] != "1.0":
            raise ValueError("contractVersion must be '1.0'")
        source_system = _text(payload["sourceSystem"], "sourceSystem")
        source_dataset = _text(payload["sourceDataset"], "sourceDataset")
        exporter_version = _text(payload["exporterVersion"], "exporterVersion")
        revision = _positive_int(payload["revision"], "revision", allow_zero=True)
        if revision != 0:
            raise ValueError("incremental MVP requires revision=0")

        window_payload = _mapping(payload["window"], "window")
        _closed_mapping(window_payload, {"start", "end"}, "window")
        start = parse_canonical_utc_text(window_payload["start"], "window.start")
        end = parse_canonical_utc_text(window_payload["end"], "window.end")
        window = TimeWindow(start, end, int((end - start).total_seconds()))

        expected_batch_id = incremental_batch_id(
            source_system, source_dataset, window, revision, exporter_version
        )
        batch_id = _text(payload["batchId"], "batchId")
        if batch_id != expected_batch_id:
            raise ValueError("batchId does not match incremental batch identity")

        data = _mapping(payload["data"], "data")
        _closed_mapping(data, {"key", "versionId", "sizeBytes", "sha256"}, "data")
        data_key = _text(data["key"], "data.key")
        if not data_key.startswith(_RAW_PREFIX):
            raise ValueError(f"data.key must be under {_RAW_PREFIX}")
        data_version_id = _text(data["versionId"], "data.versionId")
        data_size_bytes = _positive_int(data["sizeBytes"], "data.sizeBytes")
        data_sha256 = _sha256(data["sha256"], "data.sha256")

        schema = _mapping(payload["schema"], "schema")
        _closed_mapping(schema, {"fingerprint", "columns", "extraColumns"}, "schema")
        schema_fingerprint = _sha256(schema["fingerprint"], "schema.fingerprint")
        columns_raw = schema["columns"]
        if not isinstance(columns_raw, list):
            raise TypeError("schema.columns must be a list")
        columns = tuple(_column(value, index) for index, value in enumerate(columns_raw))
        extras_raw = schema["extraColumns"]
        if not isinstance(extras_raw, list) or not all(
            isinstance(item, str) for item in extras_raw
        ):
            raise TypeError("schema.extraColumns must be a list of strings")
        extra_columns = tuple(extras_raw)

        return cls(
            batch_id=batch_id,
            source_system=source_system,
            source_dataset=source_dataset,
            window=window,
            revision=revision,
            data_key=data_key,
            data_version_id=data_version_id,
            data_size_bytes=data_size_bytes,
            data_sha256=data_sha256,
            schema_fingerprint=schema_fingerprint,
            columns=columns,
            extra_columns=extra_columns,
            row_count=_positive_int(payload["rowCount"], "rowCount"),
            exporter_version=exporter_version,
        )

    def to_mapping(self) -> dict[str, object]:
        return {
            "contractVersion": self.contract_version,
            "batchId": self.batch_id,
            "sourceSystem": self.source_system,
            "sourceDataset": self.source_dataset,
            "window": {
                "start": canonical_utc_text(self.window.start, "window.start"),
                "end": canonical_utc_text(self.window.end, "window.end"),
            },
            "revision": self.revision,
            "data": {
                "key": self.data_key,
                "versionId": self.data_version_id,
                "sizeBytes": self.data_size_bytes,
                "sha256": self.data_sha256,
            },
            "schema": {
                "fingerprint": self.schema_fingerprint,
                "columns": [
                    {
                        "name": column.name,
                        "physicalType": column.physical_type,
                        "nullable": column.nullable,
                        "ordinal": column.ordinal,
                    }
                    for column in self.columns
                ],
                "extraColumns": list(self.extra_columns),
            },
            "rowCount": self.row_count,
            "exporterVersion": self.exporter_version,
        }


def incremental_batch_id(
    source_system: str,
    source_dataset: str,
    window: TimeWindow,
    revision: int,
    exporter_version: str,
) -> str:
    if revision != 0:
        raise ValueError("incremental MVP requires revision=0")
    return sha256_id(
        "bat_",
        {
            "sourceSystem": source_system,
            "sourceDataset": source_dataset,
            "windowStart": canonical_utc_text(window.start, "window.start"),
            "windowEnd": canonical_utc_text(window.end, "window.end"),
            "revision": revision,
            "exporterVersion": exporter_version,
        },
    )


def _mapping(value: object, field_name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise TypeError(f"{field_name} must be a mapping")
    return value


def _closed_mapping(value: Mapping[str, object], allowed: set[str], field_name: str) -> None:
    if set(value) != allowed:
        raise ValueError(f"{field_name} fields must be exactly {sorted(allowed)}")


def _text(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field_name} must be a non-empty string")
    return value


def _positive_int(value: object, field_name: str, *, allow_zero: bool = False) -> int:
    if type(value) is not int or value < 0 or (value == 0 and not allow_zero):
        qualifier = "non-negative" if allow_zero else "positive"
        raise ValueError(f"{field_name} must be a {qualifier} integer")
    return value


def _sha256(value: object, field_name: str) -> str:
    digest = _text(value, field_name)
    if _SHA256.fullmatch(digest) is None:
        raise ValueError(f"{field_name} must be a lowercase SHA-256 hexadecimal digest")
    return digest


def _column(value: object, index: int) -> PhysicalColumn:
    column = _mapping(value, f"schema.columns[{index}]")
    _closed_mapping(column, {"name", "physicalType", "nullable", "ordinal"}, "column")
    nullable = column["nullable"]
    if type(nullable) is not bool:
        raise TypeError("column.nullable must be a boolean")
    return PhysicalColumn(
        name=_text(column["name"], "column.name"),
        physical_type=_text(column["physicalType"], "column.physicalType"),
        nullable=nullable,
        ordinal=_positive_int(column["ordinal"], "column.ordinal"),
    )
