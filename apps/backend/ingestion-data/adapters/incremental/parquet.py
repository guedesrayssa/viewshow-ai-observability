"""Encode observed MySQL pages as deterministic raw Parquet files."""

from __future__ import annotations

import hashlib
import math
import re
from collections.abc import Iterable, Mapping
from decimal import Decimal
from pathlib import Path

import pyarrow as pa  # type: ignore[import-untyped]
import pyarrow.parquet as pq  # type: ignore[import-untyped]

from domain.canonical_json import canonical_bytes
from domain.incremental_batches import EncodedRawBatch, PhysicalColumn
from ports.incremental import RawBatchCodec

_INTEGER_TYPES = frozenset({"BIGINT", "INT", "TINYINT"})
_TEXT_TYPES = re.compile(r"^(?:VARCHAR\([1-9][0-9]*\)|TEXT|ENUM\(.*\))$")


def _arrow_type(column: PhysicalColumn) -> pa.DataType:
    if column.physical_type in _INTEGER_TYPES:
        return pa.int64()
    if column.physical_type == "DOUBLE":
        return pa.float64()
    if _TEXT_TYPES.fullmatch(column.physical_type):
        return pa.string()
    raise ValueError(f"unsupported raw physical type {column.physical_type!r}")


def _validate_columns(columns: tuple[PhysicalColumn, ...]) -> tuple[str, ...]:
    if not columns:
        raise ValueError("raw schema must contain at least one column")
    names = tuple(column.name for column in columns)
    if len(set(names)) != len(names) or any(
        not isinstance(name, str) or not name for name in names
    ):
        raise ValueError("raw schema column names must be unique non-empty strings")
    if any(type(column.ordinal) is not int for column in columns):
        raise TypeError("raw schema column ordinals must be integers")
    if tuple(column.ordinal for column in columns) != tuple(range(1, len(columns) + 1)):
        raise ValueError("raw schema column ordinals must be contiguous and ordered")
    for column in columns:
        if not isinstance(column.nullable, bool):
            raise TypeError("raw schema nullable must be a boolean")
        _arrow_type(column)
    return names


def _schema_fingerprint(columns: tuple[PhysicalColumn, ...]) -> str:
    return hashlib.sha256(
        canonical_bytes(
            {
                "format": "argus-raw-incremental",
                "contractVersion": "1.0",
                "columns": [
                    {
                        "name": column.name,
                        "physicalType": column.physical_type,
                        "nullable": column.nullable,
                        "ordinal": column.ordinal,
                    }
                    for column in columns
                ],
            }
        )
    ).hexdigest()


def _value(column: PhysicalColumn, value: object) -> object:
    if value is None:
        if not column.nullable:
            raise ValueError(f"raw column {column.name!r} cannot be null")
        return None
    if column.physical_type in _INTEGER_TYPES:
        if isinstance(value, bool) or not isinstance(value, int):
            raise TypeError(f"raw column {column.name!r} must be an integer")
        return value
    if column.physical_type == "DOUBLE":
        if isinstance(value, bool) or not isinstance(value, int | float | Decimal):
            raise TypeError(f"raw column {column.name!r} must be numeric")
        numeric = float(value)
        if not math.isfinite(numeric):
            raise ValueError(f"raw column {column.name!r} must be finite")
        return numeric
    if _TEXT_TYPES.fullmatch(column.physical_type):
        if not isinstance(value, str):
            raise TypeError(f"raw column {column.name!r} must be text")
        return value
    raise ValueError(f"unsupported raw physical type {column.physical_type!r}")


def _rows(
    columns: tuple[PhysicalColumn, ...],
    rows: Iterable[Mapping[str, object]],
    names: tuple[str, ...],
) -> list[dict[str, object]]:
    encoded: list[dict[str, object]] = []
    for row in rows:
        if not isinstance(row, Mapping) or set(row) != set(names):
            raise ValueError("raw row shape differs from observed columns")
        encoded.append({column.name: _value(column, row[column.name]) for column in columns})
    return encoded


class RawParquetCodec(RawBatchCodec):
    """Writes exactly the observed physical columns in source cursor order."""

    def encode(
        self,
        columns: tuple[PhysicalColumn, ...],
        rows: Iterable[Mapping[str, object]],
        destination: Path,
    ) -> EncodedRawBatch:
        names = _validate_columns(columns)
        if not isinstance(destination, Path):
            raise TypeError("destination must be a Path")
        values = _rows(columns, rows, names)
        fingerprint = _schema_fingerprint(columns)
        schema = pa.schema(
            [
                pa.field(column.name, _arrow_type(column), nullable=column.nullable)
                for column in columns
            ],
            metadata={
                b"format": b"argus-raw-incremental",
                b"contractVersion": b"1.0",
                b"schemaFingerprint": fingerprint.encode(),
            },
        )
        table = pa.Table.from_pylist(values, schema=schema)
        pq.write_table(
            table,
            destination,
            compression="zstd",
            compression_level=3,
            version="2.6",
            data_page_version="2.0",
            use_dictionary=False,
            write_statistics=True,
        )
        body = destination.read_bytes()
        return EncodedRawBatch(
            destination,
            len(values),
            len(body),
            hashlib.sha256(body).hexdigest(),
            fingerprint,
        )


__all__ = ["RawParquetCodec"]
