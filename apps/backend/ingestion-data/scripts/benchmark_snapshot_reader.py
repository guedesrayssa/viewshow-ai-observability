"""Restore a benchmark snapshot and measure real resilient MySQL keyset pagination."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
import re
import shutil
import stat
import subprocess
import sys
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import BinaryIO, cast

import pymysql
from pymysql.connections import Connection
from pymysql.cursors import SSDictCursor

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adapters.sources.mysql_reader import (  # noqa: E402
    MySqlConnectionSettings,
    MySqlSourceReader,
)
from adapters.sources.mysql_retry import (  # noqa: E402
    MySqlRetryEvent,
    MySqlRetryPolicy,
    RetryingMySqlSourceReader,
)
from adapters.sources.mysql_snapshot_preparer import MySqlSnapshotPreparer  # noqa: E402
from contracts.registry import DatasetRegistry  # noqa: E402

_QUERY_RETRY_ATTEMPTS = 4
_POLL_CHUNK_BYTES = 1024 * 1024
_PIPELINE_COMPONENTS = ("encode", "upload", "athena", "projection")
_DEFAULT_SMALL_PARQUET_BYTES = 32 * 1024 * 1024
_PIPELINE_PROVENANCE_FIELDS = {
    "snapshotSha256",
    "importId",
    "label",
    "runId",
    "datasetVersion",
    "canaryCompletedAt",
}
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_IMPORT_ID = re.compile(r"^imp_[0-9A-HJKMNP-TV-Z]{26}$")
_LABEL = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_DATASET_VERSION = re.compile(r"^dsv_[0-9a-f]{64}$")


class BenchmarkReaderError(RuntimeError):
    """Raised when the local benchmark environment or snapshot is invalid."""


def _compose_command() -> list[str]:
    root = Path(__file__).resolve().parents[1]
    return ["docker", "compose", "-f", str(root / "docker-compose.test.yml")]


def _mysql_client_arguments(*, database: bool) -> list[str]:
    arguments = [
        *_compose_command(),
        "exec",
        "-e",
        "MYSQL_PWD=root-test-only",
        "-T",
        "mysql",
        "mysql",
        "-uroot",
    ]
    if database:
        arguments.extend(("--binary-mode=1", "argus"))
    return arguments


def _mysql_environment() -> dict[str, str]:
    return dict(os.environ)


_SnapshotIdentity = tuple[int, int, int, int, int, int]


def _snapshot_identity(metadata: os.stat_result) -> _SnapshotIdentity:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_nlink,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _assert_snapshot_identity(source: BinaryIO, expected: _SnapshotIdentity) -> None:
    metadata = os.fstat(source.fileno())
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or _snapshot_identity(metadata) != expected
    ):
        raise BenchmarkReaderError("snapshot descriptor changed identity")


@contextmanager
def _locked_snapshot(snapshot: Path) -> Iterator[tuple[BinaryIO, _SnapshotIdentity]]:
    snapshot = Path(snapshot)
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_CLOEXEC"):
        raise BenchmarkReaderError("snapshot locking requires POSIX descriptor safeguards")
    try:
        path_metadata = os.lstat(snapshot)
        descriptor = os.open(snapshot, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as error:
        raise BenchmarkReaderError("snapshot could not be locked") from error
    try:
        metadata = os.fstat(descriptor)
    except OSError as error:
        os.close(descriptor)
        raise BenchmarkReaderError("snapshot could not be locked") from error
    identity = _snapshot_identity(metadata)
    if (
        stat.S_ISLNK(path_metadata.st_mode)
        or not stat.S_ISREG(metadata.st_mode)
        or path_metadata.st_dev != metadata.st_dev
        or path_metadata.st_ino != metadata.st_ino
        or metadata.st_nlink != 1
    ):
        os.close(descriptor)
        raise BenchmarkReaderError("snapshot must be a regular non-symlink file")
    try:
        source = os.fdopen(descriptor, "rb", closefd=True)
    except OSError as error:
        os.close(descriptor)
        raise BenchmarkReaderError("snapshot could not be locked") from error
    try:
        yield source, identity
    finally:
        source.close()


def _sha256_stream(source: BinaryIO) -> str:
    digest = hashlib.sha256()
    try:
        source.seek(0)
        while chunk := source.read(_POLL_CHUNK_BYTES):
            digest.update(chunk)
        source.seek(0)
    except OSError as error:
        raise BenchmarkReaderError("snapshot could not be hashed") from error
    return digest.hexdigest()


def _restore_snapshot_stream(source: BinaryIO) -> None:
    """Replace the test database from the already locked gzip descriptor."""
    reset = subprocess.run(
        [
            *_mysql_client_arguments(database=False),
            "-e",
            "DROP DATABASE IF EXISTS argus; CREATE DATABASE argus "
            "CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;",
        ],
        env=_mysql_environment(),
        capture_output=True,
        check=False,
    )
    if reset.returncode != 0:
        raise BenchmarkReaderError(
            f"could not reset MySQL: {reset.stderr.decode('utf-8', errors='replace').strip()}"
        )

    process = subprocess.Popen(
        _mysql_client_arguments(database=True),
        env=_mysql_environment(),
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    if process.stdin is None or process.stderr is None:
        process.kill()
        raise BenchmarkReaderError("could not open the MySQL restore stream")
    try:
        source.seek(0)
        with gzip.GzipFile(fileobj=source, mode="rb") as decompressed:
            shutil.copyfileobj(decompressed, process.stdin, length=_POLL_CHUNK_BYTES)
        process.stdin.close()
        stderr = process.stderr.read()
        status = process.wait()
    except BaseException:
        process.kill()
        process.wait()
        raise
    if status != 0:
        raise BenchmarkReaderError(
            f"could not restore MySQL: {stderr.decode('utf-8', errors='replace').strip()}"
        )


def restore_snapshot(snapshot: Path) -> None:
    """Replace the test database and stream one locked gzip dump to the client."""
    with _locked_snapshot(snapshot) as (source, identity):
        _restore_snapshot_stream(source)
        _assert_snapshot_identity(source, identity)


def _settings() -> MySqlConnectionSettings:
    return MySqlConnectionSettings(
        host=os.environ.get(
            "MYSQL_TEST_HOST",
            os.environ.get("MYSQL_SNAPSHOT_TEST_HOST", "127.0.0.1"),
        ),
        port=int(
            os.environ.get(
                "MYSQL_TEST_PORT",
                os.environ.get("MYSQL_SNAPSHOT_TEST_PORT", "33077"),
            )
        ),
        user="ingestion",
        password="ingestion-test-only",
        database="argus",
        read_timeout_seconds=300,
        write_timeout_seconds=300,
    )


def _connect(settings: MySqlConnectionSettings) -> Connection:
    return pymysql.connect(
        host=settings.host,
        port=settings.port,
        user=settings.user,
        password=settings.password,
        database=settings.database,
        charset="utf8mb4",
        autocommit=True,
        connect_timeout=settings.connect_timeout_seconds,
        read_timeout=settings.read_timeout_seconds,
        write_timeout=settings.write_timeout_seconds,
        cursorclass=SSDictCursor,
    )


class _DisconnectingConnectionFactory:
    def __init__(self, settings: MySqlConnectionSettings, after_page: int | None) -> None:
        self._settings = settings
        self._after_page = after_page
        self._attempts = 0
        self._disconnected = False

    def __call__(self) -> Connection:
        self._attempts += 1
        if (
            self._after_page is not None
            and not self._disconnected
            and self._attempts == self._after_page + 1
        ):
            self._disconnected = True
            raise pymysql.err.OperationalError(2013, "benchmark-injected disconnect")
        return _connect(self._settings)


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, math.ceil(percentile * len(ordered)) - 1)
    return ordered[index]


def _rounded(value: float) -> float:
    return round(value, 6)


def _summarize_query_durations(
    durations_by_dataset: Mapping[str, list[float]],
) -> dict[str, float]:
    durations_ms = [
        duration
        for dataset_durations in durations_by_dataset.values()
        for duration in dataset_durations
    ]
    signal_durations = durations_by_dataset.get("signal_bucket", [])
    if not signal_durations:
        raise BenchmarkReaderError("signal_bucket produced no measured pages")
    quartile_size = max(1, math.ceil(len(signal_durations) / 4))
    return {
        "queryP50Ms": _rounded(_percentile(durations_ms, 0.50)),
        "queryP95Ms": _rounded(_percentile(durations_ms, 0.95)),
        "queryP99Ms": _rounded(_percentile(durations_ms, 0.99)),
        "firstQuartileP99Ms": _rounded(_percentile(signal_durations[:quartile_size], 0.99)),
        "lastQuartileP99Ms": _rounded(_percentile(signal_durations[-quartile_size:], 0.99)),
    }


def _non_negative_number(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise BenchmarkReaderError(f"{field} must be a number")
    result = float(value)
    if not math.isfinite(result) or result < 0:
        raise BenchmarkReaderError(f"{field} must be finite and non-negative")
    return result


def _positive_integer(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise BenchmarkReaderError(f"{field} must be a positive integer")
    return value


def _summarize_pipeline_observations(
    observations: Sequence[Mapping[str, object]],
    *,
    small_file_bytes: int = _DEFAULT_SMALL_PARQUET_BYTES,
) -> dict[str, object]:
    """Summarize measured phase-2 components without inventing missing samples."""
    _positive_integer(small_file_bytes, "small_file_bytes")
    if isinstance(observations, str | bytes) or not isinstance(observations, Sequence):
        raise BenchmarkReaderError("pipeline observations must be an array")
    durations: dict[str, list[float]] = {name: [] for name in _PIPELINE_COMPONENTS}
    parquet_rows = 0
    parquet_bytes = 0
    parquet_objects = 0
    small_objects = 0
    for index, observation in enumerate(observations):
        if not isinstance(observation, Mapping):
            raise BenchmarkReaderError(f"pipeline observation {index} must be an object")
        component = observation.get("component")
        if component not in durations:
            raise BenchmarkReaderError(f"pipeline observation {index} has an unknown component")
        expected_fields = (
            {"component", "durationMs", "parquetRows", "parquetBytes"}
            if component == "encode"
            else {"component", "durationMs"}
        )
        if set(observation) != expected_fields:
            raise BenchmarkReaderError(
                f"pipeline observation {index} fields differ from the benchmark schema"
            )
        durations[cast(str, component)].append(
            _non_negative_number(observation["durationMs"], "durationMs")
        )
        if component == "encode":
            rows = _positive_integer(observation["parquetRows"], "parquetRows")
            byte_count = _positive_integer(observation["parquetBytes"], "parquetBytes")
            parquet_rows += rows
            parquet_bytes += byte_count
            parquet_objects += 1
            small_objects += byte_count < small_file_bytes
    missing = [name for name in _PIPELINE_COMPONENTS if not durations[name]]
    if missing:
        raise BenchmarkReaderError(
            f"pipeline observations are missing components: {', '.join(missing)}"
        )
    p95 = {name: _rounded(_percentile(durations[name], 0.95)) for name in _PIPELINE_COMPONENTS}
    return {
        "sampleCount": {name: len(durations[name]) for name in _PIPELINE_COMPONENTS},
        "p50Ms": {
            name: _rounded(_percentile(durations[name], 0.50)) for name in _PIPELINE_COMPONENTS
        },
        "p95Ms": p95,
        "p99Ms": {
            name: _rounded(_percentile(durations[name], 0.99)) for name in _PIPELINE_COMPONENTS
        },
        "bottleneckByP95": max(_PIPELINE_COMPONENTS, key=p95.__getitem__),
        "parquetObjectCount": parquet_objects,
        "parquetRows": parquet_rows,
        "parquetBytes": parquet_bytes,
        "smallParquetObjectCount": small_objects,
    }


def _regular_json_document(path: Path, description: str) -> dict[str, object]:
    path = Path(path)
    if not path.is_file() or path.is_symlink():
        raise BenchmarkReaderError(f"{description} must be a regular non-symlink file")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise BenchmarkReaderError(f"{description} is not valid JSON") from error
    if not isinstance(document, dict):
        raise BenchmarkReaderError(f"{description} must be a JSON object")
    return document


def _utc_timestamp(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise BenchmarkReaderError(f"{field} must be a UTC timestamp")
    try:
        parsed = datetime.fromisoformat(f"{value[:-1]}+00:00")
    except ValueError as error:
        raise BenchmarkReaderError(f"{field} must be a UTC timestamp") from error
    offset = parsed.utcoffset()
    if offset is None or offset.total_seconds() != 0:
        raise BenchmarkReaderError(f"{field} must be a UTC timestamp")
    return value


def _pipeline_provenance(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != _PIPELINE_PROVENANCE_FIELDS:
        raise BenchmarkReaderError("pipeline provenance differs from the closed schema")
    snapshot_sha256 = value.get("snapshotSha256")
    import_id = value.get("importId")
    label = value.get("label")
    run_id = value.get("runId")
    dataset_version = value.get("datasetVersion")
    if not isinstance(snapshot_sha256, str) or not _SHA256.fullmatch(snapshot_sha256):
        raise BenchmarkReaderError("pipeline snapshotSha256 is invalid")
    if not isinstance(import_id, str) or not _IMPORT_ID.fullmatch(import_id):
        raise BenchmarkReaderError("pipeline importId is invalid")
    if not isinstance(label, str) or not _LABEL.fullmatch(label):
        raise BenchmarkReaderError("pipeline label is invalid")
    expected_run_id = f"run_import_{import_id[4:]}"
    if run_id != expected_run_id:
        raise BenchmarkReaderError("pipeline runId does not match importId")
    if dataset_version is not None and (
        not isinstance(dataset_version, str) or not _DATASET_VERSION.fullmatch(dataset_version)
    ):
        raise BenchmarkReaderError("pipeline datasetVersion is invalid")
    _utc_timestamp(value.get("canaryCompletedAt"), "pipeline canaryCompletedAt")
    return dict(value)


def _verify_pipeline_provenance(
    provenance: Mapping[str, object],
    evidence: Mapping[str, object],
    snapshot_sha256: str,
) -> None:
    if not _SHA256.fullmatch(snapshot_sha256):
        raise BenchmarkReaderError("current snapshot SHA-256 is invalid")
    expected = {
        "snapshotSha256": evidence.get("snapshotSha256"),
        "importId": evidence.get("importId"),
        "label": evidence.get("label"),
        "runId": evidence.get("runId"),
        "datasetVersion": evidence.get("datasetVersion"),
        "canaryCompletedAt": evidence.get("completedAt"),
    }
    state = evidence.get("state")
    if (
        evidence.get("schemaVersion") != 1
        or state not in {"READY", "FAILED"}
        or evidence.get("candidateActivated") is not False
        or evidence.get("candidateVersion") != expected["datasetVersion"]
        or (state == "READY" and expected["datasetVersion"] is None)
        or (state == "FAILED" and expected["datasetVersion"] is not None)
    ):
        raise BenchmarkReaderError("canary evidence is not a current terminal canary")
    _utc_timestamp(expected["canaryCompletedAt"], "canary completedAt")
    if expected["snapshotSha256"] != snapshot_sha256 or dict(provenance) != expected:
        raise BenchmarkReaderError(
            "pipeline observations do not match the current snapshot and canary evidence"
        )


def _load_pipeline_observations(
    path: Path,
    *,
    canary_evidence_path: Path,
    snapshot_sha256: str,
) -> dict[str, object]:
    document = _regular_json_document(path, "pipeline observations")
    if set(document) - {"provenance", "observations", "smallFileBytes"}:
        raise BenchmarkReaderError("pipeline observations document has unknown fields")
    provenance = _pipeline_provenance(document.get("provenance"))
    evidence = _regular_json_document(canary_evidence_path, "canary evidence")
    _verify_pipeline_provenance(provenance, evidence, snapshot_sha256)
    observations = document.get("observations")
    if not isinstance(observations, list):
        raise BenchmarkReaderError("pipeline observations document requires an observations array")
    small_file_bytes = document.get("smallFileBytes", _DEFAULT_SMALL_PARQUET_BYTES)
    summary = _summarize_pipeline_observations(
        observations,
        small_file_bytes=_positive_integer(small_file_bytes, "smallFileBytes"),
    )
    summary["provenance"] = provenance
    return summary


def _sha256_file(path: Path) -> str:
    with _locked_snapshot(path) as (source, identity):
        digest = _sha256_stream(source)
        _assert_snapshot_identity(source, identity)
        return digest


def _write_json(path: Path, document: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def benchmark_snapshot_reader(
    *,
    snapshot: Path,
    rows: int,
    page_size: int,
    disconnect_after_page: int | None,
    output_json: Path,
    pipeline_observations_json: Path | None = None,
    canary_evidence_json: Path | None = None,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict[str, object]:
    """Restore, preflight and paginate all canonical tables with bounded-memory checks."""
    if isinstance(rows, bool) or not isinstance(rows, int) or rows <= 0:
        raise BenchmarkReaderError("rows must be a positive integer")
    if (
        isinstance(page_size, bool)
        or not isinstance(page_size, int)
        or not 1 <= page_size <= 10_000
    ):
        raise BenchmarkReaderError("page_size must be between 1 and 10000")
    if disconnect_after_page is not None and (
        isinstance(disconnect_after_page, bool)
        or not isinstance(disconnect_after_page, int)
        or disconnect_after_page < 1
    ):
        raise BenchmarkReaderError("disconnect_after_page must be a positive integer")
    if (pipeline_observations_json is None) != (canary_evidence_json is None):
        raise BenchmarkReaderError(
            "pipeline observations and canary evidence must be provided together"
        )
    pipeline_diagnostics = None
    with _locked_snapshot(snapshot) as (snapshot_source, snapshot_identity):
        snapshot_sha256 = _sha256_stream(snapshot_source)
        _assert_snapshot_identity(snapshot_source, snapshot_identity)
        if pipeline_observations_json is not None and canary_evidence_json is not None:
            pipeline_diagnostics = _load_pipeline_observations(
                pipeline_observations_json,
                canary_evidence_path=canary_evidence_json,
                snapshot_sha256=snapshot_sha256,
            )

        restore_started = monotonic()
        _restore_snapshot_stream(snapshot_source)
        restore_duration = monotonic() - restore_started
        try:
            _assert_snapshot_identity(snapshot_source, snapshot_identity)
            restored_sha256 = _sha256_stream(snapshot_source)
            _assert_snapshot_identity(snapshot_source, snapshot_identity)
        except BenchmarkReaderError as error:
            raise BenchmarkReaderError("snapshot changed while it was being restored") from error
        if restored_sha256 != snapshot_sha256:
            raise BenchmarkReaderError("snapshot changed while it was being restored")

    registry = DatasetRegistry.load_argus_v2()
    settings = _settings()
    preflight_started = monotonic()
    MySqlSnapshotPreparer(registry, settings).prepare(tuple(registry))
    preflight_duration = monotonic() - preflight_started

    factory = _DisconnectingConnectionFactory(settings, disconnect_after_page)
    inner = MySqlSourceReader(
        registry,
        settings,
        connection_factory=factory,
        force_cursor_index=True,
    )
    retry_events: list[MySqlRetryEvent] = []
    reader = RetryingMySqlSourceReader(
        inner,
        MySqlRetryPolicy(_QUERY_RETRY_ATTEMPTS, 1, 1),
        sleep=lambda _seconds: None,
        random_value=lambda: 0.0,
        on_retry=retry_events.append,
    )

    durations_by_dataset: dict[str, list[float]] = {}
    observed_rows = 0
    duplicate_rows = 0
    query_pages = 0
    benchmark_started = monotonic()
    for descriptor in registry:
        dataset_durations = durations_by_dataset.setdefault(descriptor.table, [])
        after: tuple[object, ...] | None = None
        previous_key: tuple[object, ...] | None = None
        while True:
            query_started = monotonic()
            page = reader.read_page(descriptor, None, after, page_size)
            query_pages += 1
            dataset_durations.append((monotonic() - query_started) * 1_000)
            for row in page.rows:
                key = tuple(row[field] for field in descriptor.cursor_key)
                if previous_key is not None:
                    if key == previous_key:
                        duplicate_rows += 1
                    elif key < previous_key:
                        raise BenchmarkReaderError(
                            f"reader returned an out-of-order key for {descriptor.table}"
                        )
                previous_key = key
            observed_rows += len(page.rows)
            if not page.rows or len(page.rows) < page_size:
                break
            if page.next_cursor is None or page.next_cursor == after:
                raise BenchmarkReaderError(
                    f"reader did not advance the cursor for {descriptor.table}"
                )
            after = page.next_cursor
    duration_seconds = monotonic() - benchmark_started
    missing = max(0, rows - observed_rows)
    duplicates = duplicate_rows + max(0, observed_rows - rows)
    duration_metrics = _summarize_query_durations(durations_by_dataset)
    report: dict[str, object] = {
        "rows": rows,
        "pageSize": page_size,
        "restoreDurationSeconds": _rounded(restore_duration),
        "preflightDurationSeconds": _rounded(preflight_duration),
        "durationSeconds": _rounded(duration_seconds),
        "rowsPerSecond": _rounded(observed_rows / duration_seconds) if duration_seconds else 0.0,
        "queryPages": query_pages,
        **duration_metrics,
        "retries": len(retry_events),
        "duplicates": duplicates,
        "missing": missing,
        "pipelineDiagnostics": pipeline_diagnostics,
    }
    _write_json(Path(output_json), report)
    return report


def _parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--rows", type=int, required=True)
    parser.add_argument("--page-size", type=int, required=True)
    parser.add_argument("--disconnect-after-page", type=int)
    parser.add_argument("--pipeline-observations-json", type=Path)
    parser.add_argument("--canary-evidence-json", type=Path)
    parser.add_argument("--output-json", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    arguments = _parse_arguments(sys.argv[1:] if argv is None else argv)
    report = benchmark_snapshot_reader(
        snapshot=arguments.snapshot,
        rows=arguments.rows,
        page_size=arguments.page_size,
        disconnect_after_page=arguments.disconnect_after_page,
        output_json=arguments.output_json,
        pipeline_observations_json=arguments.pipeline_observations_json,
        canary_evidence_json=arguments.canary_evidence_json,
    )
    sys.stdout.write(json.dumps(report, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BenchmarkReaderError as error:
        sys.stderr.write(f"{error}\n")
        raise SystemExit(1) from error
