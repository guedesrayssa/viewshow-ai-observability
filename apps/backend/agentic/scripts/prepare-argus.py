#!/usr/bin/env python3
"""Extrai os recortes analíticos do dump sanitizado do Argus.

O dump nunca é executado. O arquivo é lido como texto, linha a linha, e apenas
as tabelas necessárias ao treino e à avaliação são materializadas. As saídas
ficam em ``apps/backend/agentic/data/``, que é ignorado pelo Git.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import math
import re
import shutil
import sys
import tempfile
from collections import Counter, defaultdict
from contextlib import ExitStack
from pathlib import Path
from typing import Iterable


QOE_COLUMNS = [
    "hour_ts", "sinal", "sessions", "errors", "startup_errors",
    "latency_ms_avg", "latency_ms_p50", "latency_ms_p95",
    "bufferratio_avg", "jointime_s_avg", "dropped_frames_avg", "stalls_avg",
    "bitrate_mbps_avg", "bitrate_mbps_p50",
]
ACTIVE_COLUMNS = [
    "bucket_ts", "sinal", "active_sessions", "active_with_error",
    "joins_in_bucket", "latency_ms_p50", "latency_ms_p95",
    "bufferratio_avg", "jointime_s_avg", "dropped_frames_avg",
]
ACTIVE_METRICS = ACTIVE_COLUMNS[2:]
LABEL_COLUMNS = [
    "id", "tier", "kind", "ts_start", "ts_end", "severity", "region",
    "services", "description", "narrative_md", "metrics_cited", "source_doc",
    "notes", "provenance", "verdict",
]
SIGNAL_COLUMNS = ["bts", "source", "entity", "metric", "value"]
TABLE_COLUMNS = {
    "live_qoe_hourly": QOE_COLUMNS,
    "live_active_15min": ACTIVE_COLUMNS,
    "incident_label": LABEL_COLUMNS,
    "signal_bucket": SIGNAL_COLUMNS,
}
INSERT_RE = re.compile(r"^INSERT INTO `([^`]+)` \((.*)\) VALUES")


def sql_tuples(text: str) -> Iterable[list[object]]:
    """Lê tuplas VALUES do mysqldump sem executar SQL."""
    i = 0
    row: list[object] | None = None
    while i < len(text):
        char = text[i]
        if char.isspace() or char in ",;":
            i += 1
        elif char == "(":
            if row is not None:
                raise ValueError("início de tupla inesperado")
            row = []
            i += 1
        elif char == ")":
            if row is None:
                raise ValueError("fim de tupla inesperado")
            yield row
            row = None
            i += 1
        elif char == "'":
            if row is None:
                raise ValueError("string fora de uma tupla")
            i += 1
            value: list[str] = []
            while i < len(text):
                char = text[i]
                if char == "\\":
                    i += 1
                    if i >= len(text):
                        raise ValueError("escape incompleto")
                    value.append({"n": "\n", "r": "\r", "t": "\t", "0": "\0"}.get(text[i], text[i]))
                elif char == "'":
                    if i + 1 < len(text) and text[i + 1] == "'":
                        value.append("'")
                        i += 1
                    else:
                        i += 1
                        break
                else:
                    value.append(char)
                i += 1
            else:
                raise ValueError("string não terminada")
            row.append("".join(value))
        else:
            end = i
            while end < len(text) and text[end] not in ",);":
                end += 1
            token = text[i:end].strip()
            if row is None:
                raise ValueError("valor fora de uma tupla")
            if token == "NULL":
                row.append(None)
            else:
                row.append(float(token) if any(mark in token for mark in ".eE") else int(token))
            i = end
    if row is not None:
        raise ValueError("tupla não terminada")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def required_indexes(table: str, insert_columns: list[str]) -> list[int]:
    required = TABLE_COLUMNS[table]
    missing = set(required) - set(insert_columns)
    if missing:
        raise ValueError(f"{table}: colunas ausentes no INSERT: {sorted(missing)}")
    return [insert_columns.index(name) for name in required]


def prepare(source: Path, destination: Path, include_signal_bucket: bool) -> dict[str, object]:
    if destination.exists():
        raise SystemExit(f"recusando sobrescrever diretório existente: {destination}")
    if not source.is_file():
        raise SystemExit(f"dump não encontrado: {source}")

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{destination.name}-", dir=destination.parent))
    counts: Counter[str] = Counter()
    timestamp_ranges: dict[str, list[int | None]] = defaultdict(lambda: [None, None])
    signal_counts: Counter[tuple[str, str]] = Counter()
    signal_entities: dict[tuple[str, str], set[str]] = defaultdict(set)
    channels: dict[str, set[str]] = defaultdict(set)
    labels_by_provenance: Counter[str] = Counter()

    try:
        with ExitStack() as stack:
            outputs = {
                "live_qoe_hourly": stack.enter_context(gzip.open(temporary / "qoe.csv.gz", "wt", newline="", encoding="utf-8")),
                "live_active_15min": stack.enter_context(gzip.open(temporary / "detector.csv.gz", "wt", newline="", encoding="utf-8")),
                "incident_label": stack.enter_context(gzip.open(temporary / "incident-labels.csv.gz", "wt", newline="", encoding="utf-8")),
            }
            if include_signal_bucket:
                outputs["signal_bucket"] = stack.enter_context(gzip.open(temporary / "signal-bucket.csv.gz", "wt", newline="", encoding="utf-8"))

            writers = {table: csv.writer(handle) for table, handle in outputs.items()}
            writers["live_qoe_hourly"].writerow(QOE_COLUMNS)
            writers["live_active_15min"].writerow(["timestamp", "scope_id", "metric", "value"])
            writers["incident_label"].writerow(LABEL_COLUMNS)
            if include_signal_bucket:
                writers["signal_bucket"].writerow(SIGNAL_COLUMNS)

            active_table: str | None = None
            indexes: list[int] = []
            with gzip.open(source, "rt", encoding="utf-8") as stream:
                for line_number, line in enumerate(stream, 1):
                    match = INSERT_RE.match(line)
                    if match:
                        table = match.group(1)
                        active_table = table if table in TABLE_COLUMNS else None
                        if active_table:
                            insert_columns = re.findall(r"`([^`]+)`", match.group(2))
                            indexes = required_indexes(active_table, insert_columns)
                            tail = line.split(" VALUES", 1)[1].strip()
                            if tail:
                                process_rows(active_table, tail, indexes, writers, counts, timestamp_ranges,
                                             signal_counts, signal_entities, channels, labels_by_provenance,
                                             include_signal_bucket)
                        continue
                    if not active_table:
                        continue
                    try:
                        process_rows(active_table, line, indexes, writers, counts, timestamp_ranges,
                                     signal_counts, signal_entities, channels, labels_by_provenance,
                                     include_signal_bucket)
                    except Exception as error:
                        raise ValueError(f"linha {line_number}, tabela {active_table}: {error}") from error
                    if line.rstrip().endswith(";"):
                        active_table = None

        with (temporary / "signal-summary.csv").open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(["source", "metric", "rows", "entities"])
            for key in sorted(signal_counts):
                writer.writerow([*key, signal_counts[key], len(signal_entities[key])])

        manifest: dict[str, object] = {
            "schema_version": "argus-analysis-extract-v1",
            "source_file": source.name,
            "source_sha256": sha256(source),
            "gzip_crc_verified": True,
            "include_signal_bucket": include_signal_bucket,
            "rows": dict(sorted(counts.items())),
            "timestamp_ranges_ms": dict(sorted(timestamp_ranges.items())),
            "channels": {table: len(values) for table, values in sorted(channels.items())},
            "labels_by_provenance": dict(sorted(labels_by_provenance.items())),
            "outputs": sorted(path.name for path in temporary.iterdir() if path.name != "manifest.json"),
        }
        (temporary / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.rename(destination)
        return manifest
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def process_rows(
    table: str,
    text: str,
    indexes: list[int],
    writers: dict[str, csv.writer],
    counts: Counter[str],
    timestamp_ranges: dict[str, list[int | None]],
    signal_counts: Counter[tuple[str, str]],
    signal_entities: dict[tuple[str, str], set[str]],
    channels: dict[str, set[str]],
    labels_by_provenance: Counter[str],
    include_signal_bucket: bool,
) -> None:
    for parsed in sql_tuples(text):
        if len(parsed) <= max(indexes):
            raise ValueError(f"largura inesperada: {len(parsed)}")
        row = [parsed[index] for index in indexes]
        counts[table] += 1
        timestamp = int(row[0] if table != "incident_label" else row[3])
        bounds = timestamp_ranges[table]
        bounds[0] = timestamp if bounds[0] is None else min(bounds[0], timestamp)
        bounds[1] = timestamp if bounds[1] is None else max(bounds[1], timestamp)

        if table == "live_qoe_hourly":
            writers[table].writerow(row)
            channels[table].add(str(row[1]))
        elif table == "live_active_15min":
            channels[table].add(str(row[1]))
            for metric, value in zip(ACTIVE_METRICS, row[2:]):
                if value is not None and (not isinstance(value, float) or math.isfinite(value)):
                    writers[table].writerow([row[0], row[1], metric, value])
                    counts["detector_vectors"] += 1
        elif table == "incident_label":
            writers[table].writerow(row)
            labels_by_provenance[str(row[13])] += 1
        elif table == "signal_bucket":
            key = (str(row[1]), str(row[3]))
            signal_counts[key] += 1
            signal_entities[key].add(str(row[2]))
            if include_signal_bucket:
                writers[table].writerow(row)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dump", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--include-signal-bucket", action="store_true")
    args = parser.parse_args()
    manifest = prepare(args.dump, args.output, args.include_signal_bucket)
    print(json.dumps(manifest, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(f"erro: {error}", file=sys.stderr)
        raise SystemExit(1)
