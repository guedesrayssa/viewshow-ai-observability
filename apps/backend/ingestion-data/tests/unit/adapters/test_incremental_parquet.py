"""Verify raw incremental Parquet batches retain their physical schema."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from adapters.incremental.parquet import RawParquetCodec
from domain.incremental_batches import PhysicalColumn


def _columns() -> tuple[PhysicalColumn, ...]:
    return (
        PhysicalColumn("bucket_ts", "BIGINT", False, 1),
        PhysicalColumn("sinal", "VARCHAR(64)", False, 2),
        PhysicalColumn("nova_coluna", "VARCHAR(64)", True, 3),
    )


def test_raw_parquet_preserves_extra_columns_and_schema(tmp_path: Path) -> None:
    """Removing an additive source field would silently make the raw archive lossy."""
    destination = tmp_path / "data.parquet"

    encoded = RawParquetCodec().encode(
        _columns(),
        ({"bucket_ts": 1, "sinal": "alpha", "nova_coluna": "preservada"},),
        destination,
    )

    table = pq.read_table(destination)
    assert table.to_pylist() == [
        {"bucket_ts": 1, "sinal": "alpha", "nova_coluna": "preservada"}
    ]
    assert table.schema.field("bucket_ts").type == pa.int64()
    assert table.schema.metadata == {
        b"format": b"argus-raw-incremental",
        b"contractVersion": b"1.0",
        b"schemaFingerprint": encoded.schema_fingerprint.encode(),
    }
    assert encoded.row_count == 1
    assert encoded.sha256 == hashlib.sha256(destination.read_bytes()).hexdigest()


def test_raw_parquet_rejects_non_finite_float_before_writing(tmp_path: Path) -> None:
    """NaN values would make raw content semantically non-portable across readers."""
    destination = tmp_path / "invalid.parquet"

    with pytest.raises(ValueError, match="finite"):
        RawParquetCodec().encode(
            (PhysicalColumn("value", "DOUBLE", False, 1),),
            ({"value": float("nan")},),
            destination,
        )

    assert not destination.exists()


def test_raw_parquet_rejects_rows_with_different_observed_shape(tmp_path: Path) -> None:
    """An omitted source field must fail instead of becoming an implicit null."""
    with pytest.raises(ValueError, match="row shape"):
        RawParquetCodec().encode(
            _columns(),
            ({"bucket_ts": 1, "sinal": "alpha"},),
            tmp_path / "invalid.parquet",
        )
