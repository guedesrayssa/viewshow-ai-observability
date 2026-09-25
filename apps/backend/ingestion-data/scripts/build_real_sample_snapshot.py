"""Build a small canonical snapshot by copying real rows from an ARGUS dump."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import sys
from pathlib import Path


def _canonical_tables(registry: Path) -> tuple[str, ...]:
    document = json.loads(registry.read_text(encoding="utf-8"))
    descriptors = document.get("descriptors")
    if (
        not isinstance(descriptors, list)
        or len(descriptors) != 23
        or not all(isinstance(item, str) and item for item in descriptors)
        or len(set(descriptors)) != len(descriptors)
    ):
        raise ValueError("registry must contain 23 unique descriptor names")
    return tuple(descriptors)


def _first_schema_and_inserts(
    source: Path, tables: tuple[str, ...]
) -> tuple[dict[str, bytes], dict[str, bytes]]:
    create_prefixes = {f"CREATE TABLE `{table}`".encode(): table for table in tables}
    insert_prefixes = {f"INSERT INTO `{table}`".encode(): table for table in tables}
    creates: dict[str, bytes] = {}
    inserts: dict[str, bytes] = {}
    current_kind: str | None = None
    current_table: str | None = None
    current: list[bytes] = []
    with source.open("rb") as stream:
        for line in stream:
            if current_table is None:
                for prefix, table in create_prefixes.items():
                    if table not in creates and line.startswith(prefix):
                        current_kind = "create"
                        current_table = table
                        current = [line]
                        break
                if current_table is None:
                    for prefix, table in insert_prefixes.items():
                        if table not in inserts and line.startswith(prefix):
                            current_kind = "insert"
                            current_table = table
                            current = [line]
                            break
            else:
                current.append(line)
            if current_table is not None and line.rstrip().endswith(b";"):
                target = creates if current_kind == "create" else inserts
                target[current_table] = b"".join(current)
                current_kind = None
                current_table = None
                current = []
                if len(creates) == len(tables) and len(inserts) == len(tables):
                    break
    missing_creates = sorted(set(tables) - set(creates))
    missing_inserts = sorted(set(tables) - set(inserts))
    if missing_creates or missing_inserts:
        raise ValueError(
            "source dump is incomplete: "
            f"missing CREATEs={missing_creates}; missing INSERTs={missing_inserts}"
        )
    return creates, inserts


def build_snapshot(*, source: Path, registry: Path, output: Path) -> tuple[int, str]:
    tables = _canonical_tables(registry)
    creates, inserts = _first_schema_and_inserts(source, tables)
    statements = [b"SET NAMES utf8mb4;", b"SET FOREIGN_KEY_CHECKS=0;"]
    statements.extend(creates[table].rstrip() for table in tables)
    statements.extend(inserts[table].rstrip() for table in tables)
    payload = b"\n\n".join(statements) + b"\n"
    compressed = gzip.compress(payload, compresslevel=9, mtime=0)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp")
    temporary.write_bytes(compressed)
    temporary.replace(output)
    return len(compressed), hashlib.sha256(compressed).hexdigest()


def main(argv: list[str] | None = None) -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--registry",
        type=Path,
        default=root / "contracts" / "argus" / "v2" / "registry.json",
    )
    arguments = parser.parse_args(argv)
    size, digest = build_snapshot(
        source=arguments.source,
        registry=arguments.registry,
        output=arguments.output,
    )
    sys.stdout.write(
        f"real ARGUS sample: {arguments.output}\n"
        f"  tables         23\n"
        f"  bytes          {size}\n"
        f"  sha256         {digest}\n"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        sys.stderr.write(f"{error}\n")
        raise SystemExit(1) from error
