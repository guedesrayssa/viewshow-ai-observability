"""Exercise the real MySQL reader benchmark, including a lost connection."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from datetime import date
from pathlib import Path

import pytest

from scripts import benchmark_snapshot_reader as benchmark_module
from scripts.benchmark_snapshot_reader import benchmark_snapshot_reader
from scripts.build_benchmark_snapshot import build_benchmark_snapshot

EXPECTED_FIELDS = {
    "rows",
    "pageSize",
    "restoreDurationSeconds",
    "preflightDurationSeconds",
    "durationSeconds",
    "rowsPerSecond",
    "queryPages",
    "queryP50Ms",
    "queryP95Ms",
    "queryP99Ms",
    "firstQuartileP99Ms",
    "lastQuartileP99Ms",
    "retries",
    "duplicates",
    "missing",
    "pipelineDiagnostics",
}
SNAPSHOT_SHA256 = "f" * 64
IMPORT_ID = "imp_01K5Z9P7Z7A1B2C3D4E5F6G7H8"
RUN_ID = "run_import_01K5Z9P7Z7A1B2C3D4E5F6G7H8"
DATASET_VERSION = "dsv_" + "a" * 64
CANARY_COMPLETED_AT = "2026-09-22T12:34:56.789Z"


def _pipeline_document() -> dict[str, object]:
    return {
        "provenance": {
            "snapshotSha256": SNAPSHOT_SHA256,
            "importId": IMPORT_ID,
            "label": "phase2-1m-recovery",
            "runId": RUN_ID,
            "datasetVersion": DATASET_VERSION,
            "canaryCompletedAt": CANARY_COMPLETED_AT,
        },
        "smallFileBytes": 64,
        "observations": [
            {
                "component": "encode",
                "durationMs": 10.0,
                "parquetRows": 10,
                "parquetBytes": 40,
            },
            {"component": "upload", "durationMs": 30.0},
            {"component": "athena", "durationMs": 50.0},
            {"component": "projection", "durationMs": 70.0},
        ],
    }


def _canary_evidence() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "snapshotSha256": SNAPSHOT_SHA256,
        "importId": IMPORT_ID,
        "label": "phase2-1m-recovery",
        "runId": RUN_ID,
        "datasetVersion": DATASET_VERSION,
        "candidateVersion": DATASET_VERSION,
        "candidateActivated": False,
        "state": "READY",
        "completedAt": CANARY_COMPLETED_AT,
    }


def test_query_quartiles_use_only_signal_bucket_pages() -> None:
    summary = benchmark_module._summarize_query_durations(
        {
            "signal_bucket": [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0],
            "fast_small_table": [1.0, 1.0, 1.0, 1.0],
            "slow_small_table": [1_000.0, 1_000.0, 1_000.0, 1_000.0],
        }
    )

    assert summary == {
        "queryP50Ms": 40.0,
        "queryP95Ms": 1_000.0,
        "queryP99Ms": 1_000.0,
        "firstQuartileP99Ms": 20.0,
        "lastQuartileP99Ms": 80.0,
    }


@pytest.mark.parametrize(
    ("signal_durations", "expected_first", "expected_last"),
    [
        ([37.0], 37.0, 37.0),
        ([11.0, 22.0], 11.0, 22.0),
        ([10.0, 20.0, 30.0, 40.0, 50.0], 20.0, 50.0),
    ],
)
def test_signal_bucket_quartiles_have_defined_small_page_partitions(
    signal_durations: list[float],
    expected_first: float,
    expected_last: float,
) -> None:
    summary = benchmark_module._summarize_query_durations({"signal_bucket": signal_durations})

    assert summary["firstQuartileP99Ms"] == expected_first
    assert summary["lastQuartileP99Ms"] == expected_last


def test_pipeline_observations_identify_component_p95_and_parquet_shape() -> None:
    summary = benchmark_module._summarize_pipeline_observations(
        [
            {"component": "encode", "durationMs": 10.0, "parquetRows": 10, "parquetBytes": 40},
            {"component": "encode", "durationMs": 20.0, "parquetRows": 20, "parquetBytes": 80},
            {"component": "upload", "durationMs": 30.0},
            {"component": "upload", "durationMs": 40.0},
            {"component": "athena", "durationMs": 50.0},
            {"component": "athena", "durationMs": 60.0},
            {"component": "projection", "durationMs": 70.0},
            {"component": "projection", "durationMs": 80.0},
        ],
        small_file_bytes=64,
    )

    assert summary == {
        "sampleCount": {"encode": 2, "upload": 2, "athena": 2, "projection": 2},
        "p50Ms": {"encode": 10.0, "upload": 30.0, "athena": 50.0, "projection": 70.0},
        "p95Ms": {"encode": 20.0, "upload": 40.0, "athena": 60.0, "projection": 80.0},
        "p99Ms": {"encode": 20.0, "upload": 40.0, "athena": 60.0, "projection": 80.0},
        "bottleneckByP95": "projection",
        "parquetObjectCount": 2,
        "parquetRows": 30,
        "parquetBytes": 120,
        "smallParquetObjectCount": 1,
    }


@pytest.mark.parametrize(
    "observations",
    [
        [{"component": "encode", "durationMs": 1.0}],
        [
            {"component": "encode", "durationMs": 1.0, "parquetRows": 1},
            {"component": "upload", "durationMs": 1.0},
            {"component": "athena", "durationMs": 1.0},
            {"component": "projection", "durationMs": 1.0},
        ],
        [
            {"component": "encode", "durationMs": -1.0, "parquetRows": 1, "parquetBytes": 1},
            {"component": "upload", "durationMs": 1.0},
            {"component": "athena", "durationMs": 1.0},
            {"component": "projection", "durationMs": 1.0},
        ],
    ],
)
def test_pipeline_observations_fail_closed_when_incomplete(
    observations: list[dict[str, object]],
) -> None:
    with pytest.raises(benchmark_module.BenchmarkReaderError):
        benchmark_module._summarize_pipeline_observations(observations)


def test_pipeline_observations_are_bound_to_the_current_canary_and_snapshot(
    tmp_path: Path,
) -> None:
    observations = tmp_path / "pipeline.json"
    evidence = tmp_path / "canary.json"
    observations.write_text(json.dumps(_pipeline_document()), encoding="utf-8")
    evidence.write_text(json.dumps(_canary_evidence()), encoding="utf-8")

    summary = benchmark_module._load_pipeline_observations(
        observations,
        canary_evidence_path=evidence,
        snapshot_sha256=SNAPSHOT_SHA256,
    )

    assert summary["provenance"] == _pipeline_document()["provenance"]
    assert summary["bottleneckByP95"] == "projection"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("snapshotSha256", "e" * 64),
        ("importId", "imp_01K5Z9P7Z7A1B2C3D4E5F6G7H9"),
        ("label", "phase2-old"),
        ("runId", "run_import_01K5Z9P7Z7A1B2C3D4E5F6G7H9"),
        ("datasetVersion", "dsv_" + "b" * 64),
        ("canaryCompletedAt", "2026-09-21T12:34:56.789Z"),
    ],
)
def test_pipeline_observations_reject_stale_or_divergent_provenance(
    tmp_path: Path,
    field: str,
    value: str,
) -> None:
    document = _pipeline_document()
    document["provenance"][field] = value  # type: ignore[index]
    observations = tmp_path / "pipeline.json"
    evidence = tmp_path / "canary.json"
    observations.write_text(json.dumps(document), encoding="utf-8")
    evidence.write_text(json.dumps(_canary_evidence()), encoding="utf-8")

    with pytest.raises(benchmark_module.BenchmarkReaderError):
        benchmark_module._load_pipeline_observations(
            observations,
            canary_evidence_path=evidence,
            snapshot_sha256=SNAPSHOT_SHA256,
        )


@pytest.mark.parametrize(
    "document",
    [
        {"smallFileBytes": 64, "observations": _pipeline_document()["observations"]},
        {
            **_pipeline_document(),
            "provenance": {**_pipeline_document()["provenance"], "bucket": "private"},
        },
    ],
)
def test_pipeline_observations_reject_legacy_or_secret_bearing_provenance(
    tmp_path: Path,
    document: dict[str, object],
) -> None:
    observations = tmp_path / "pipeline.json"
    evidence = tmp_path / "canary.json"
    observations.write_text(json.dumps(document), encoding="utf-8")
    evidence.write_text(json.dumps(_canary_evidence()), encoding="utf-8")

    with pytest.raises(benchmark_module.BenchmarkReaderError):
        benchmark_module._load_pipeline_observations(
            observations,
            canary_evidence_path=evidence,
            snapshot_sha256=SNAPSHOT_SHA256,
        )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("schemaVersion", 2),
        ("state", None),
        ("candidateActivated", True),
        ("candidateVersion", "dsv_" + "b" * 64),
    ],
)
def test_pipeline_observations_reject_non_current_canary_evidence(
    tmp_path: Path,
    field: str,
    value: object,
) -> None:
    observations = tmp_path / "pipeline.json"
    evidence = tmp_path / "canary.json"
    canary = _canary_evidence()
    canary[field] = value
    observations.write_text(json.dumps(_pipeline_document()), encoding="utf-8")
    evidence.write_text(json.dumps(canary), encoding="utf-8")

    with pytest.raises(benchmark_module.BenchmarkReaderError):
        benchmark_module._load_pipeline_observations(
            observations,
            canary_evidence_path=evidence,
            snapshot_sha256=SNAPSHOT_SHA256,
        )


def _write_current_pipeline_evidence(tmp_path: Path, snapshot_sha256: str) -> tuple[Path, Path]:
    document = _pipeline_document()
    document["provenance"]["snapshotSha256"] = snapshot_sha256  # type: ignore[index]
    canary = _canary_evidence()
    canary["snapshotSha256"] = snapshot_sha256
    observations = tmp_path / "pipeline.json"
    evidence = tmp_path / "canary.json"
    observations.write_text(json.dumps(document), encoding="utf-8")
    evidence.write_text(json.dumps(canary), encoding="utf-8")
    return observations, evidence


def test_benchmark_restores_from_the_same_descriptor_that_was_hashed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    snapshot = tmp_path / "argus_dump.sql.gz"
    displaced = tmp_path / "original.sql.gz"
    original = b"original-snapshot-bytes"
    snapshot.write_bytes(original)
    snapshot_sha256 = hashlib.sha256(original).hexdigest()
    observations, evidence = _write_current_pipeline_evidence(tmp_path, snapshot_sha256)

    class RestoreObserved(RuntimeError):
        pass

    def observe_restore(source: object) -> None:
        snapshot.rename(displaced)
        snapshot.write_bytes(b"replacement-path-bytes")
        source.seek(0)  # type: ignore[attr-defined]
        assert source.read() == original  # type: ignore[attr-defined]
        raise RestoreObserved

    monkeypatch.setattr(benchmark_module, "_restore_snapshot_stream", observe_restore)

    with pytest.raises(RestoreObserved):
        benchmark_snapshot_reader(
            snapshot=snapshot,
            rows=1,
            page_size=1,
            disconnect_after_page=None,
            output_json=tmp_path / "report.json",
            pipeline_observations_json=observations,
            canary_evidence_json=evidence,
        )

    assert not (tmp_path / "report.json").exists()


def test_benchmark_rehashes_the_locked_descriptor_after_restore_before_reporting(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    snapshot = tmp_path / "argus_dump.sql.gz"
    original = b"original-snapshot-bytes"
    snapshot.write_bytes(original)
    snapshot_sha256 = hashlib.sha256(original).hexdigest()
    observations, evidence = _write_current_pipeline_evidence(tmp_path, snapshot_sha256)

    def mutate_during_restore(source: object) -> None:
        source.seek(0)  # type: ignore[attr-defined]
        assert source.read() == original  # type: ignore[attr-defined]
        snapshot.write_bytes(b"mutated-during-restore")

    monkeypatch.setattr(benchmark_module, "_restore_snapshot_stream", mutate_during_restore)

    with pytest.raises(
        benchmark_module.BenchmarkReaderError,
        match="snapshot changed while it was being restored",
    ):
        benchmark_snapshot_reader(
            snapshot=snapshot,
            rows=1,
            page_size=1,
            disconnect_after_page=None,
            output_json=tmp_path / "report.json",
            pipeline_observations_json=observations,
            canary_evidence_json=evidence,
        )

    assert not (tmp_path / "report.json").exists()


def test_snapshot_reader_benchmark_cli_loads_from_the_documented_file_path() -> None:
    service_root = Path(__file__).resolve().parents[2]

    result = subprocess.run(
        [sys.executable, "scripts/benchmark_snapshot_reader.py", "--help"],
        cwd=service_root,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "--disconnect-after-page" in result.stdout
    assert "--pipeline-observations-json" in result.stdout
    assert "--canary-evidence-json" in result.stdout


@pytest.mark.mysql
def test_snapshot_reader_benchmark_reports_complete_deterministic_pagination_and_one_retry(
    tmp_path: Path,
) -> None:
    snapshot = tmp_path / "argus_dump.sql.gz"
    manifest = tmp_path / "manifest.json"
    build_benchmark_snapshot(
        rows=103,
        snapshot_extracted_on=date(2026, 9, 1),
        variant="benchmark-test",
        output=snapshot,
        manifest=manifest,
    )

    clean_output = tmp_path / "clean.json"
    clean = benchmark_snapshot_reader(
        snapshot=snapshot,
        rows=103,
        page_size=5,
        disconnect_after_page=None,
        output_json=clean_output,
    )
    retry_output = tmp_path / "retry.json"
    retry = benchmark_snapshot_reader(
        snapshot=snapshot,
        rows=103,
        page_size=5,
        disconnect_after_page=10,
        output_json=retry_output,
    )

    assert set(clean) == EXPECTED_FIELDS
    assert json.loads(clean_output.read_text(encoding="utf-8")) == clean
    assert clean["rows"] == retry["rows"] == 103
    assert clean["pageSize"] == retry["pageSize"] == 5
    assert clean["missing"] == retry["missing"] == 0
    assert clean["duplicates"] == retry["duplicates"] == 0
    assert clean["retries"] == 0
    assert retry["retries"] == 1
    assert all(
        clean[field] >= 0
        for field in EXPECTED_FIELDS
        if field not in {"rows", "pageSize", "pipelineDiagnostics"}
    )
    assert clean["pipelineDiagnostics"] is None
