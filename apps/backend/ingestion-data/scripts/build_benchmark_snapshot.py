"""Build deterministic, restorable ARGUS benchmark snapshots without buffering all rows."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import sys
import tempfile
from collections import Counter
from collections.abc import Iterator, Mapping
from datetime import date
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from domain.snapshot_provenance import parse_snapshot_extracted_on

_IDENTIFIER = r"[A-Za-z_][A-Za-z0-9_]*"
_INSERT = re.compile(
    rf"INSERT\s+INTO\s+(?:`(?P<quoted>{_IDENTIFIER})`|(?P<plain>{_IDENTIFIER}))"
    r".*?\bVALUES\b(?P<values>.*?);",
    re.IGNORECASE | re.DOTALL,
)
_VARIANT = re.compile(r"^[a-z0-9-]{1,40}$")
_INSERT_BLOCK_ROWS = 1_000
_FIRST_SYNTHETIC_BUCKET_MS = 1_788_000_300_000


class BenchmarkSnapshotError(ValueError):
    """Raised before publishing a benchmark snapshot that violates its contract."""


def _fixture_row_count(values: str) -> int:
    count = 0
    depth = 0
    quoted = False
    position = 0
    while position < len(values):
        character = values[position]
        if character == "'":
            if quoted and position + 1 < len(values) and values[position + 1] == "'":
                position += 2
                continue
            quoted = not quoted
        elif not quoted:
            if character == "(":
                if depth == 0:
                    count += 1
                depth += 1
            elif character == ")":
                depth -= 1
                if depth < 0:
                    raise BenchmarkSnapshotError("fixture contains unbalanced value tuples")
        position += 1
    if quoted or depth != 0 or count == 0:
        raise BenchmarkSnapshotError("fixture contains an invalid INSERT value list")
    return count


def _fixture_counts(fixture: str) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for match in _INSERT.finditer(fixture):
        table = match.group("quoted") or match.group("plain")
        counts[table] += _fixture_row_count(match.group("values"))
    return dict(counts)


def _canonical_tables(root: Path) -> tuple[str, ...]:
    registry_path = root / "contracts" / "argus" / "v2" / "registry.json"
    try:
        document = json.loads(registry_path.read_text(encoding="utf-8"))
        descriptors = document["descriptors"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise BenchmarkSnapshotError("canonical registry could not be read") from error
    if (
        not isinstance(descriptors, list)
        or len(descriptors) != 23
        or not all(
            isinstance(table, str) and re.fullmatch(_IDENTIFIER, table) for table in descriptors
        )
        or len(set(descriptors)) != len(descriptors)
    ):
        raise BenchmarkSnapshotError("canonical registry must contain 23 unique table names")
    return tuple(descriptors)


def _read_text(path: Path, label: str) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as error:
        raise BenchmarkSnapshotError(f"{label} could not be read: {path}") from error


def _synthetic_blocks(rows: int, variant: str, rows_per_window: int | None) -> Iterator[str]:
    # Sem ``rows_per_window``, cada linha ocupa um bucket de 15 min com a mesma entidade.
    # Com ele, ``rows_per_window`` linhas compartilham o bucket, cada uma com entidade própria.
    remaining = rows
    offset = 0
    while remaining:
        block_rows = min(remaining, _INSERT_BLOCK_ROWS)
        yield "INSERT INTO signal_bucket (bts, source, entity, metric, value) VALUES\n"
        for block_offset in range(block_rows):
            index = offset + block_offset
            if rows_per_window is None:
                bucket = _FIRST_SYNTHETIC_BUCKET_MS + index * 900_000
                entity = f"benchmark-{variant}"
            else:
                window, position = divmod(index, rows_per_window)
                bucket = _FIRST_SYNTHETIC_BUCKET_MS + window * 900_000
                entity = f"benchmark-{variant}-{position:06d}"
            suffix = ";" if block_offset == block_rows - 1 else ","
            yield (
                f"    ({bucket}, 'benchmark-{variant}', '{entity}', "
                f"'row-count', {index + 1}.0){suffix}\n"
            )
        remaining -= block_rows
        offset += block_rows


def _write_gzip_stream(output: Path, chunks: Iterator[str]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=f".{output.name}.",
            dir=output.parent,
            delete=False,
        ) as raw:
            temporary_path = Path(raw.name)
            with gzip.GzipFile(
                filename="",
                mode="wb",
                fileobj=raw,
                compresslevel=9,
                mtime=0,
            ) as compressed:
                for chunk in chunks:
                    compressed.write(chunk.encode("utf-8"))
        os.replace(temporary_path, output)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def _snapshot_chunks(
    schema: str,
    fixture: str,
    synthetic_rows: int,
    variant: str,
    rows_per_window: int | None,
) -> Iterator[str]:
    yield schema.rstrip()
    yield "\n\n"
    yield fixture.strip()
    yield "\n"
    if synthetic_rows:
        yield "\n"
        yield from _synthetic_blocks(synthetic_rows, variant, rows_per_window)


def _sha256(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def _write_manifest(path: Path, document: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            prefix=f".{path.name}.",
            dir=path.parent,
            delete=False,
        ) as stream:
            temporary_path = Path(stream.name)
            json.dump(document, stream, indent=2, sort_keys=True)
            stream.write("\n")
        os.replace(temporary_path, path)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def build_benchmark_snapshot(
    *,
    rows: int,
    snapshot_extracted_on: date,
    variant: str,
    output: Path,
    manifest: Path,
    rows_per_window: int | None = None,
) -> dict[str, object]:
    """Write one deterministic gzip dump and its content-addressed manifest."""
    if isinstance(rows, bool) or not isinstance(rows, int) or rows <= 0:
        raise BenchmarkSnapshotError("rows must be a positive integer")
    if type(snapshot_extracted_on) is not date:
        raise BenchmarkSnapshotError("snapshot_extracted_on must be a date")
    if not isinstance(variant, str) or _VARIANT.fullmatch(variant) is None:
        raise BenchmarkSnapshotError("variant must match [a-z0-9-]{1,40}")
    if rows_per_window is not None and (
        isinstance(rows_per_window, bool)
        or not isinstance(rows_per_window, int)
        or not 0 < rows_per_window <= 999_999
    ):
        raise BenchmarkSnapshotError("rows_per_window must be an integer between 1 and 999999")
    output = Path(output)
    manifest = Path(manifest)
    if not output.name.endswith(".sql.gz"):
        raise BenchmarkSnapshotError("output must end in .sql.gz")
    if output.resolve() == manifest.resolve():
        raise BenchmarkSnapshotError("output and manifest must be different files")

    root = Path(__file__).resolve().parents[1]
    schema = _read_text(root / "contracts" / "argus" / "v2" / "db_schema.sql", "schema")
    fixture = _read_text(root / "tests" / "fixtures" / "argus_v2_minimal.sql", "fixture")
    tables = _canonical_tables(root)
    fixture_counts = _fixture_counts(fixture)
    if set(fixture_counts) != set(tables) or any(fixture_counts[table] < 1 for table in tables):
        raise BenchmarkSnapshotError("official fixture must contain every canonical table")
    fixture_rows = sum(fixture_counts.values())
    if rows < fixture_rows:
        raise BenchmarkSnapshotError(
            f"rows must be at least {fixture_rows} to preserve the official fixture"
        )
    synthetic_rows = rows - fixture_rows
    table_counts = {table: fixture_counts[table] for table in tables}
    table_counts["signal_bucket"] += synthetic_rows

    _write_gzip_stream(
        output,
        _snapshot_chunks(schema, fixture, synthetic_rows, variant, rows_per_window),
    )
    sha256, compressed_bytes = _sha256(output)
    document: dict[str, object] = {
        "compressedBytes": compressed_bytes,
        "rowCount": rows,
        "sha256": sha256,
        "snapshotExtractedOn": snapshot_extracted_on.isoformat(),
        "tableCounts": table_counts,
        "variant": variant,
    }
    if rows_per_window is not None:
        document["rowsPerWindow"] = rows_per_window
    _write_manifest(manifest, document)
    return document


def _parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, required=True)
    parser.add_argument(
        "--snapshot-extracted-on",
        type=parse_snapshot_extracted_on,
        required=True,
    )
    parser.add_argument("--variant", default="baseline")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--rows-per-window", type=int, default=None)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    arguments = _parse_arguments(sys.argv[1:] if argv is None else argv)
    document = build_benchmark_snapshot(
        rows=arguments.rows,
        snapshot_extracted_on=arguments.snapshot_extracted_on,
        variant=arguments.variant,
        output=arguments.output,
        manifest=arguments.manifest,
        rows_per_window=arguments.rows_per_window,
    )
    sys.stdout.write(json.dumps(document, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BenchmarkSnapshotError as error:
        sys.stderr.write(f"{error}\n")
        raise SystemExit(1) from error
