"""Verify telemetry adapters emit safe ingestion metrics, logs and traces."""

from __future__ import annotations

import io
import json
from argparse import Namespace
from datetime import UTC, datetime
from pathlib import Path
from types import MappingProxyType, SimpleNamespace

import pytest

from adapters.telemetry.cloudwatch_metrics import CloudWatchMetrics
from adapters.telemetry.json_logging import JsonLogger
from adapters.telemetry.runtime import BoundedDiskUsageReporter, observe_command
from bootstrap.cli import main
from bootstrap.config import Settings
from bootstrap.container import build_container
from domain.disk_budget import DiskBudget, DiskBudgetExceeded, DiskUsage
from domain.run import RunStage
from domain.telemetry_identity import METRICS_NAMESPACE, SERVICE_NAME
from ports import OutboxBacklog


def _publish_settings() -> Settings:
    return Settings.from_env(
        {
            "OPERATIONAL_TABLE_NAME": "view-show-operacional",
            "ANALYSIS_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/123/analysis",
        },
        command="publish-outbox",
    )


def test_import_telemetry_keeps_request_correlation_out_of_dimensions():
    from application.import_dump import ImportDumpFailed
    from tests.unit.application.test_import_dump import IMPORT_ID

    logs, metrics = io.StringIO(), io.StringIO()

    def fail(_arguments):
        raise ImportDumpFailed(
            IMPORT_ID,
            "VALIDATION_ERROR",
            cause_type="SnapshotUploadError",
        )

    observed = observe_command(
        "import-dump",
        "snapshot",
        fail,
        {
            "logger": JsonLogger(environment="local", stream=logs),
            "metrics": CloudWatchMetrics(stream=metrics),
        },
    )
    with pytest.raises(ImportDumpFailed):
        observed(Namespace(import_id=IMPORT_ID))
    failure = next(
        json.loads(line)
        for line in logs.getvalue().splitlines()
        if json.loads(line)["event"] == "ingestion.run.failed"
    )
    assert failure["requestId"] == "req_import_01K59Z5XE00000000000000000"
    assert failure["errorCode"] == "VALIDATION_ERROR"
    assert failure["causeType"] == "SnapshotUploadError"
    documents = [json.loads(line) for line in metrics.getvalue().splitlines()]
    assert documents and all(document["command"] == "import-dump" for document in documents)
    assert IMPORT_ID not in metrics.getvalue()


def test_logger_emits_one_json_line_with_correlation_fields() -> None:
    output = io.StringIO()
    logger = JsonLogger(
        environment="learner-lab",
        stream=output,
        clock=lambda: datetime(2026, 9, 9, 12, 30, tzinfo=UTC),
    ).bind(traceId="trace-1", runId="run-1", datasetVersion="v1")

    logger.info(
        "ingestion.run.finished",
        stage="COMPLETED",
        dataset="signal_bucket",
        windowStart="2026-09-09T12:00:00Z",
        windowEnd="2026-09-09T12:15:00Z",
        recordsRead=10,
        recordsWritten=9,
        recordsRejected=1,
        recordsUnchanged=0,
        durationMs=123,
        errorCode=None,
    )

    assert output.getvalue().count("\n") == 1
    record = json.loads(output.getvalue())
    assert record["timestamp"] == "2026-09-09T12:30:00.000Z"
    assert record["level"] == "info"
    assert record["service_name"] == SERVICE_NAME
    assert record["event"] == "ingestion.run.finished"
    assert record["message"] == "ingestion.run.finished"
    assert record["traceId"] == "trace-1"
    assert record["recordsRead"] == 10


def test_logger_redacts_recursively_and_fail_closed_for_unknown_objects() -> None:
    output = io.StringIO()
    logger = JsonLogger(environment="local", stream=output)
    sentinels = (
        "password-sentinel",
        "dsn-sentinel",
        "payload-sentinel",
        "token-sentinel",
        "pem-sentinel",
    )

    class Dangerous:
        def __str__(self) -> str:
            return "object-secret-sentinel"

    logger.error(
        "restore_failed",
        mysql_password=sentinels[0],
        dsn=f"mysql://user:{sentinels[1]}@db/argus",
        nested={
            "items": [{"raw": sentinels[2]}],
            "AWS_SESSION_TOKEN": sentinels[3],
            "private_key": f"-----BEGIN PRIVATE KEY-----{sentinels[4]}",
        },
        unknown=Dangerous(),
    )

    rendered = output.getvalue()
    assert all(secret not in rendered for secret in (*sentinels, "object-secret-sentinel"))
    record = json.loads(rendered)
    assert record["mysql_password"] == "[REDACTED]"
    assert record["dsn"] == "[REDACTED]"
    assert record["nested"]["items"][0]["raw"] == "[REDACTED]"
    assert record["unknown"] == "[UNSERIALIZABLE]"


def test_logger_sanitizes_environment_and_service_name_envelope_values() -> None:
    output = io.StringIO()
    sentinel = "envelope-secret"

    JsonLogger(
        environment=f"MYSQL_PWD={sentinel}",
        service_name=f"mysql://user:{sentinel}@host/db",
        stream=output,
    ).info("ingestion.run.started")

    assert sentinel not in output.getvalue()


def test_emf_uses_default_namespace_units_and_low_cardinality_dimensions() -> None:
    output = io.StringIO()
    metrics = CloudWatchMetrics(stream=output)

    metrics.increment(
        "Runs",
        1,
        {"command": "sync", "status": "SUCCEEDED", "source_mode": "live"},
    )

    document = json.loads(output.getvalue())
    directive = document["_aws"]["CloudWatchMetrics"][0]
    assert directive["Namespace"] == METRICS_NAMESPACE
    assert directive["Dimensions"] == [["command", "source_mode", "status"]]
    assert directive["Metrics"] == [{"Name": "Runs", "Unit": "Count"}]
    assert document["Runs"] == 1


def test_emf_accepts_closed_domain_stage_and_coverage_values() -> None:
    output = io.StringIO()

    CloudWatchMetrics(stream=output).gauge(
        "CoverageRatio",
        0.75,
        {"stage": "PUBLISHING", "coverage_status": "complete"},
    )

    assert json.loads(output.getvalue())["CoverageRatio"] == 0.75


def test_emf_accepts_disabled_run_status_and_stage() -> None:
    output = io.StringIO()
    CloudWatchMetrics(stream=output).increment(
        "Runs", 1, {"command": "sync", "status": "SKIPPED_DISABLED", "stage": "SKIPPED_DISABLED"}
    )
    document = json.loads(output.getvalue())
    assert document["Runs"] == 1
    assert document["status"] == "SKIPPED_DISABLED"
    assert document["stage"] == "SKIPPED_DISABLED"


@pytest.mark.parametrize(
    ("method", "metric", "unit", "value", "dimensions"),
    [
        (
            "timing",
            "MySqlPageDurationMs",
            "Milliseconds",
            125.0,
            {"command": "backfill", "source_mode": "snapshot", "dataset": "signal_bucket"},
        ),
        (
            "increment",
            "MySqlPageRows",
            "Count",
            10,
            {"command": "backfill", "source_mode": "snapshot", "dataset": "signal_bucket"},
        ),
        (
            "increment",
            "MySqlRetries",
            "Count",
            1,
            {"command": "backfill", "source_mode": "snapshot", "dataset": "signal_bucket"},
        ),
        (
            "timing",
            "MySqlCursorIndexDurationMs",
            "Milliseconds",
            125.0,
            {"command": "backfill", "source_mode": "snapshot"},
        ),
        (
            "timing",
            "MySqlPreflightDurationMs",
            "Milliseconds",
            125.0,
            {"command": "backfill", "source_mode": "snapshot"},
        ),
        (
            "increment",
            "MySqlPreflightFailures",
            "Count",
            1,
            {"command": "backfill", "source_mode": "snapshot"},
        ),
    ],
)
def test_emf_allowlists_mysql_resilience_metrics_with_exact_units(
    method: str,
    metric: str,
    unit: str,
    value: int | float,
    dimensions: dict[str, str],
) -> None:
    output = io.StringIO()
    metrics = CloudWatchMetrics(stream=output)

    getattr(metrics, method)(metric, value, dimensions)

    document = json.loads(output.getvalue())
    assert document[metric] == value
    assert document["_aws"]["CloudWatchMetrics"][0]["Metrics"] == [
        {"Name": metric, "Unit": unit}
    ]
    assert {key: document[key] for key in dimensions} == dimensions


@pytest.mark.parametrize(
    ("metric", "command", "status", "value"),
    [
        ("IncrementalBatches", "ingest-incremental", "COMPLETED", 1),
        ("IncrementalBatches", "ingest-incremental", "RETRYABLE_FAILED", 1),
        ("IncrementalBatches", "ingest-incremental", "QUARANTINED", 1),
        ("IncrementalSchemaExtraColumns", "ingest-incremental", "COMPLETED", 2),
        ("IncrementalBatchQuarantined", "ingest-incremental", "QUARANTINED", 1),
    ],
)
def test_emf_accepts_incremental_task_events_with_alarm_dimensions(
    metric: str,
    command: str,
    status: str,
    value: int,
) -> None:
    output = io.StringIO()

    CloudWatchMetrics(stream=output).increment(
        metric,
        value,
        {"command": command, "status": status, "dataset": "signal_bucket"},
    )

    document = json.loads(output.getvalue())
    directive = document["_aws"]["CloudWatchMetrics"][0]
    assert directive["Dimensions"] == [["command", "dataset", "status"]]
    assert set(document) - {"_aws", metric} == {"command", "dataset", "status"}
    assert "batchId" not in document


def test_runtime_emits_incremental_export_lag_with_exact_alarm_dimensions() -> None:
    metric_output = io.StringIO()
    now = datetime(2026, 9, 10, 12, 30, tzinfo=UTC)

    def export(arguments: Namespace) -> SimpleNamespace:
        arguments.dataset = "signal_bucket"
        arguments._runtime_window_end = datetime(2026, 9, 10, 12, 0, tzinfo=UTC)
        return SimpleNamespace(stage=RunStage.SUCCEEDED)

    observed = observe_command(
        "export-incremental",
        "live",
        export,
        {
            "logger": JsonLogger(environment="local", stream=io.StringIO()),
            "metrics": CloudWatchMetrics(stream=metric_output),
            "clock": lambda: now,
        },
    )

    observed(Namespace(command="export-incremental"))

    documents = [json.loads(line) for line in metric_output.getvalue().splitlines()]
    lag = next(document for document in documents if "IncrementalBatchLagSeconds" in document)
    assert lag["IncrementalBatchLagSeconds"] == 1800.0
    assert {key: lag[key] for key in ("command", "status", "dataset")} == {
        "command": "export-incremental",
        "status": "SUCCEEDED",
        "dataset": "signal_bucket",
    }
    assert lag["_aws"]["CloudWatchMetrics"][0]["Dimensions"] == [
        ["command", "dataset", "status"]
    ]
    assert "source_mode" not in lag
    assert "batchId" not in lag


@pytest.mark.parametrize("dimension", ["runId", "traceId", "datasetVersion", "error"])
def test_emf_rejects_high_cardinality_dimensions(dimension: str) -> None:
    with pytest.raises(ValueError, match="dimension"):
        CloudWatchMetrics(stream=io.StringIO()).gauge("RecordsRead", 2, {dimension: "x"})


def test_emf_rejects_metrics_and_components_without_runtime_emitters() -> None:
    metrics = CloudWatchMetrics(stream=io.StringIO())

    with pytest.raises(ValueError, match="metric name"):
        metrics.increment("LeaseConflict", 1, {"command": "sync"})
    for component in ("OBJECT_STORE", "GLUE", "ATHENA"):
        with pytest.raises(ValueError, match="non-allowlisted value"):
            metrics.increment(
                "ArchiveFailures",
                1,
                {"command": "backfill", "component": component},
            )


@pytest.mark.parametrize("value", [float("nan"), float("inf"), True])
def test_emf_rejects_non_finite_or_boolean_values(value: object) -> None:
    with pytest.raises((TypeError, ValueError), match="numeric|finite"):
        CloudWatchMetrics(stream=io.StringIO()).gauge(  # type: ignore[arg-type]
            "RecordsRead", value, {"command": "backfill"}
        )


def test_telemetry_output_failure_never_changes_business_result() -> None:
    class BrokenStream:
        def write(self, _value: str) -> int:
            raise RuntimeError("collector failed")

        def flush(self) -> None:
            raise RuntimeError("collector failed")

    JsonLogger(environment="local", stream=BrokenStream()).info("ingestion.run.started")
    CloudWatchMetrics(stream=BrokenStream()).timing("RunDurationMs", 10, {"command": "backfill"})


def test_runtime_field_extraction_never_replaces_business_result() -> None:
    class HostileResult:
        @property
        def stage(self) -> str:
            raise RuntimeError("broken telemetry property")

    result = HostileResult()
    observed = observe_command(
        "validate",
        "snapshot",
        lambda _arguments: result,
        {
            "logger": JsonLogger(environment="local", stream=io.StringIO()),
            "metrics": CloudWatchMetrics(stream=io.StringIO()),
        },
    )

    assert observed(Namespace(command="validate")) is result


def test_runtime_observer_preserves_explicit_backfill_run_id() -> None:
    output = io.StringIO()
    observed_run_ids: list[str] = []

    def handler(arguments: Namespace) -> SimpleNamespace:
        observed_run_ids.append(arguments._runtime_run_id)
        return SimpleNamespace(stage=RunStage.SUCCEEDED)

    observed = observe_command(
        "backfill",
        "snapshot",
        handler,
        {
            "logger": JsonLogger(environment="learner-lab", stream=output),
            "metrics": CloudWatchMetrics(stream=io.StringIO()),
        },
    )

    observed(Namespace(command="backfill", run_id="backfill-explicit-123"))

    assert observed_run_ids == ["backfill-explicit-123"]
    assert json.loads(output.getvalue().splitlines()[0])["runId"] == "backfill-explicit-123"


def test_runtime_base_exception_from_telemetry_never_replaces_business_result() -> None:
    class HostileMetrics:
        def increment(self, *_args: object, **_kwargs: object) -> None:
            raise KeyboardInterrupt("collector interrupted")

        def timing(self, *_args: object, **_kwargs: object) -> None:
            raise KeyboardInterrupt("collector interrupted")

        def gauge(self, *_args: object, **_kwargs: object) -> None:
            raise KeyboardInterrupt("collector interrupted")

    result = SimpleNamespace(stage="SUCCEEDED")
    observed = observe_command(
        "validate",
        "snapshot",
        lambda _arguments: result,
        {
            "logger": JsonLogger(environment="local", stream=io.StringIO()),
            "metrics": HostileMetrics(),
        },
    )

    assert observed(Namespace(command="validate")) is result


def test_runtime_does_not_invent_duration_when_clock_has_no_evidence() -> None:
    metric_output = io.StringIO()
    result = SimpleNamespace(stage="SUCCEEDED")
    observed = observe_command(
        "validate",
        "snapshot",
        lambda _arguments: result,
        {
            "logger": JsonLogger(environment="local", stream=io.StringIO()),
            "metrics": CloudWatchMetrics(stream=metric_output),
            "monotonic": lambda: (_ for _ in ()).throw(RuntimeError("clock unavailable")),
        },
    )

    assert observed(Namespace(command="validate")) is result
    documents = [json.loads(line) for line in metric_output.getvalue().splitlines()]
    assert any("Runs" in document for document in documents)
    assert all("RunDurationMs" not in document for document in documents)


def test_runtime_does_not_relabel_outbox_publish_counts_as_record_counts() -> None:
    from application.publish_outbox import PublishResult

    metric_output = io.StringIO()
    result = PublishResult(attempted=7, published=3)
    observed = observe_command(
        "publish-outbox",
        None,
        lambda _arguments: result,
        {
            "logger": JsonLogger(environment="local", stream=io.StringIO()),
            "metrics": CloudWatchMetrics(stream=metric_output),
            "monotonic": lambda: 10.0,
        },
    )

    assert observed(Namespace(command="publish-outbox")) is result
    documents = [json.loads(line) for line in metric_output.getvalue().splitlines()]
    assert all(
        not {"RecordsRead", "RecordsWritten", "RecordsRejected", "RecordsUnchanged"}
        & document.keys()
        for document in documents
    )


def test_runtime_observer_emits_available_dataset_window_version_and_counts() -> None:
    log_output = io.StringIO()
    metric_output = io.StringIO()
    result = SimpleNamespace(
        dataset_version="dsv_safe",
        dataset="signal_bucket",
        stage="SUCCEEDED",
        records_read=5,
        records_written=3,
        records_rejected=1,
        records_unchanged=1,
        unrelated_integer=987654,
    )
    observed = observe_command(
        "reprocess",
        "snapshot",
        lambda _arguments: result,
        {
            "logger": JsonLogger(environment="local", stream=log_output),
            "metrics": CloudWatchMetrics(stream=metric_output),
        },
    )

    observed(
        Namespace(
            command="reprocess",
            dataset="signal_bucket",
            start="2026-09-09T12:00:00Z",
            end="2026-09-09T12:15:00Z",
            ignored_integer=123456,
        )
    )

    finished = json.loads(log_output.getvalue().splitlines()[-1])
    metric_documents = [json.loads(line) for line in metric_output.getvalue().splitlines()]
    assert finished["datasetVersion"] == "dsv_safe"
    assert finished["dataset"] == "signal_bucket"
    assert finished["windowStart"] == "2026-09-09T12:00:00Z"
    assert finished["windowEnd"] == "2026-09-09T12:15:00Z"
    assert finished["recordsRead"] == 5
    assert finished["recordsWritten"] == 3
    assert finished["recordsRejected"] == 1
    assert finished["recordsUnchanged"] == 1
    assert "ignored_integer" not in finished
    assert "unrelated_integer" not in finished
    assert all("datasetVersion" not in document for document in metric_documents)
    assert all("windowStart" not in document for document in metric_documents)
    assert all(document["dataset"] == "signal_bucket" for document in metric_documents)


def test_runtime_observer_emits_failed_event_for_failed_result_without_leaking_error() -> None:
    output = io.StringIO()
    sentinel = "failed-result-secret"
    result = SimpleNamespace(
        succeeded=False,
        error=f"MYSQL_PASSWORD={sentinel}",
    )
    observed = observe_command(
        "validate",
        "snapshot",
        lambda _arguments: result,
        {
            "logger": JsonLogger(environment="local", stream=output),
            "metrics": CloudWatchMetrics(stream=io.StringIO()),
        },
    )

    assert observed(Namespace(command="validate")) is result

    records = [json.loads(line) for line in output.getvalue().splitlines()]
    assert sentinel not in output.getvalue()
    assert [record["event"] for record in records] == [
        "ingestion.run.started",
        "ingestion.run.failed",
        "ingestion.run.finished",
    ]
    assert records[1]["errorCode"] == "CommandFailed"
    assert records[1]["message"] == "MYSQL_PASSWORD=[REDACTED]"


def test_runtime_handler_emits_correlated_json_and_emf_on_success() -> None:
    log_output = io.StringIO()
    metric_output = io.StringIO()
    readings = iter((20.0, 20.25))

    class EmptyOutbox:
        def list_pending(self, _limit: int) -> tuple[object, ...]:
            return ()

    telemetry = MappingProxyType(
        {
            "logger": JsonLogger(environment="local", stream=log_output),
            "metrics": CloudWatchMetrics(stream=metric_output),
            "monotonic": lambda: next(readings),
        }
    )
    runtime = build_container(
        _publish_settings(),
        factories={
            "outbox": EmptyOutbox,
            "queue": object,
            "telemetry": lambda: telemetry,
        },
    ).resolve("publish-outbox")

    result = runtime.handler(Namespace(command="publish-outbox", limit=7))

    logs = [json.loads(line) for line in log_output.getvalue().splitlines()]
    metrics = [json.loads(line) for line in metric_output.getvalue().splitlines()]
    assert result.attempted == 0
    assert [record["event"] for record in logs] == [
        "ingestion.run.started",
        "ingestion.run.finished",
    ]
    assert logs[0]["traceId"] == logs[1]["traceId"]
    assert logs[0]["runId"] == logs[1]["runId"]
    assert logs[0]["stage"] == "STARTING"
    assert logs[1]["stage"] == "SUCCEEDED"
    assert "recordsRead" not in logs[1]
    assert "recordsWritten" not in logs[1]
    assert logs[1]["durationMs"] == 250.0
    assert "limit" not in logs[0]
    assert "limit" not in logs[1]
    metric_names = {
        document["_aws"]["CloudWatchMetrics"][0]["Metrics"][0]["Name"] for document in metrics
    }
    assert metric_names == {"Runs", "RunDurationMs"}
    assert all("traceId" not in document and "runId" not in document for document in metrics)


def test_cli_executes_observed_handler_with_redacted_json_and_failed_emf(capsys) -> None:
    log_output = io.StringIO()
    metric_output = io.StringIO()
    readings = iter((30.0, 30.125))
    sentinel = "runtime-secret-sentinel"

    class FailingOutbox:
        def list_pending(self, _limit: int) -> tuple[object, ...]:
            raise RuntimeError(f"MYSQL_PASSWORD={sentinel}")

    telemetry = MappingProxyType(
        {
            "logger": JsonLogger(environment="local", stream=log_output),
            "metrics": CloudWatchMetrics(stream=metric_output),
            "monotonic": lambda: next(readings),
        }
    )
    runtime = build_container(
        _publish_settings(),
        factories={
            "outbox": FailingOutbox,
            "queue": object,
            "telemetry": lambda: telemetry,
        },
    ).resolve("publish-outbox")

    assert (
        main(
            ["publish-outbox", "--limit", "7"],
            handler_factory=lambda _command: runtime.handler,
        )
        == 1
    )

    logs = [json.loads(line) for line in log_output.getvalue().splitlines()]
    metrics = [json.loads(line) for line in metric_output.getvalue().splitlines()]
    assert capsys.readouterr().err == ""
    assert sentinel not in log_output.getvalue()
    assert sentinel not in metric_output.getvalue()
    assert [record["event"] for record in logs] == [
        "ingestion.run.started",
        "ingestion.run.failed",
        "ingestion.run.finished",
    ]
    assert logs[1]["errorCode"] == "RuntimeError"
    assert logs[1]["message"] == "MYSQL_PASSWORD=[REDACTED]"
    assert logs[2]["stage"] == "FAILED"
    assert logs[2]["durationMs"] == 125.0
    runs = [document for document in metrics if "Runs" in document]
    assert len(runs) == 1
    assert runs[0]["Runs"] == 1
    assert runs[0]["command"] == "publish-outbox"
    assert runs[0]["status"] == "FAILED"


def test_keyboard_interrupt_emits_one_terminal_sequence_and_returns_130(capsys) -> None:
    log_output = io.StringIO()
    metric_output = io.StringIO()
    readings = iter((40.0, 40.5))
    sentinel = "interrupt-secret"

    def interrupt(_arguments: Namespace) -> None:
        raise KeyboardInterrupt(f"MYSQL_PASSWORD={sentinel}")

    observed = observe_command(
        "sync",
        "live",
        interrupt,
        {
            "logger": JsonLogger(environment="local", stream=log_output),
            "metrics": CloudWatchMetrics(stream=metric_output),
            "monotonic": lambda: next(readings),
        },
    )

    assert main(["sync"], handler_factory=lambda _command: observed) == 130

    captured = capsys.readouterr()
    logs = [json.loads(line) for line in log_output.getvalue().splitlines()]
    metrics = [json.loads(line) for line in metric_output.getvalue().splitlines()]
    assert captured.err == ""
    assert sentinel not in log_output.getvalue()
    assert [record["event"] for record in logs] == [
        "ingestion.run.started",
        "ingestion.run.failed",
        "ingestion.run.finished",
    ]
    assert logs[1]["errorCode"] == "KeyboardInterrupt"
    assert logs[2]["durationMs"] == 500.0
    assert len([document for document in metrics if "Runs" in document]) == 1
    assert len([document for document in metrics if "RunDurationMs" in document]) == 1
    assert all(document["status"] == "FAILED" for document in metrics)


def test_runtime_observer_does_not_capture_system_exit() -> None:
    log_output = io.StringIO()
    metric_output = io.StringIO()

    def exit_handler(_arguments: Namespace) -> None:
        raise SystemExit(7)

    observed = observe_command(
        "validate",
        "snapshot",
        exit_handler,
        {
            "logger": JsonLogger(environment="local", stream=log_output),
            "metrics": CloudWatchMetrics(stream=metric_output),
        },
    )

    with pytest.raises(SystemExit) as raised:
        observed(Namespace(command="validate"))

    assert raised.value.code == 7
    assert [json.loads(line)["event"] for line in log_output.getvalue().splitlines()] == [
        "ingestion.run.started"
    ]
    assert metric_output.getvalue() == ""


def test_runtime_extracts_sync_watermarks_and_local_disk_from_the_typed_result() -> None:
    from application.sync import SyncResult

    metric_output = io.StringIO()
    result = SyncResult(
        {},
        {"ANOMALY_DETECTION": datetime(2026, 9, 10, 11, 45, tzinfo=UTC)},
        0,
        stage=RunStage.SUCCEEDED,
        local_disk_usage=DiskUsage(1000, 20, 30, 900, {"sqliteBytes": 20}),
    )
    observed = observe_command(
        "sync",
        "live",
        lambda _arguments: result,
        {
            "logger": JsonLogger(environment="local", stream=io.StringIO()),
            "metrics": CloudWatchMetrics(stream=metric_output),
            "monotonic": lambda: 10.0,
        },
    )

    assert observed(Namespace(command="sync")) is result

    documents = [json.loads(line) for line in metric_output.getvalue().splitlines()]
    watermark = next(document for document in documents if "WatermarkEpochSeconds" in document)
    disk = next(document for document in documents if "LocalDiskPeakBytes" in document)
    assert watermark["event_type"] == "ANOMALY_DETECTION"
    assert (
        watermark["WatermarkEpochSeconds"] == datetime(2026, 9, 10, 11, 45, tzinfo=UTC).timestamp()
    )
    assert disk["LocalDiskPeakBytes"] == 30


def test_disk_metrics_emit_bounded_inflight_thresholds_heartbeat_and_fatal(
    tmp_path: Path,
) -> None:
    metric_output = io.StringIO()
    monotonic = [0.0]
    reporter = BoundedDiskUsageReporter(
        CloudWatchMetrics(stream=metric_output),
        command="import-dump",
        source_mode="snapshot",
        monotonic=lambda: monotonic[0],
        interval_seconds=60.0,
    )
    budget = DiskBudget(
        tmp_path,
        100,
        free_bytes=lambda _path: 1_000,
        usage_reporter=reporter,
    )
    artifact = tmp_path / "records.jsonl"

    artifact.write_bytes(b"x" * 10)
    budget.observe()
    artifact.write_bytes(b"x" * 81)
    budget.observe()
    artifact.write_bytes(b"x" * 85)
    for _ in range(10):
        budget.reserve(0, "bounded reserve")
    monotonic[0] = 60.0
    budget.heartbeat()
    artifact.write_bytes(b"x" * 91)
    budget.reserve(0, "critical crossing")
    artifact.write_bytes(b"x" * 101)
    with pytest.raises(DiskBudgetExceeded):
        budget.observe()

    documents = [json.loads(line) for line in metric_output.getvalue().splitlines()]
    current = [
        document["LocalDiskCurrentBytes"]
        for document in documents
        if "LocalDiskCurrentBytes" in document
    ]
    peak = [
        document["LocalDiskPeakBytes"]
        for document in documents
        if "LocalDiskPeakBytes" in document
    ]
    assert current == [10.0, 81.0, 85.0, 91.0, 101.0]
    assert peak == current
    assert len(documents) == 10
    assert all(
        document["command"] == "import-dump"
        and document["source_mode"] == "snapshot"
        and "status" not in document
        for document in documents
    )


def test_disk_metrics_remain_bounded_when_the_monotonic_clock_is_unavailable() -> None:
    metric_output = io.StringIO()

    def unavailable_clock() -> float:
        raise RuntimeError("clock unavailable")

    reporter = BoundedDiskUsageReporter(
        CloudWatchMetrics(stream=metric_output),
        command="import-dump",
        source_mode="snapshot",
        monotonic=unavailable_clock,
    )

    for _ in range(10):
        reporter.report_disk_usage(10, 10, 100, reason="observe")
    reporter.report_disk_usage(10, 10, 100, reason="fatal")

    documents = [json.loads(line) for line in metric_output.getvalue().splitlines()]
    assert len(documents) == 4


def test_runtime_emits_source_lag_only_for_allowlisted_live_observations() -> None:
    from application.sync import SyncResult, SyncSourceResult

    metric_output = io.StringIO()
    now = datetime(2026, 9, 10, 12, 0, tzinfo=UTC)
    result = SyncResult(
        {
            "signal_bucket": SyncSourceResult(
                "signal_bucket",
                True,
                1,
                0,
                now,
                latest_observed_at=datetime(2026, 9, 10, 11, 45, tzinfo=UTC),
            ),
            "unapproved_dataset": SyncSourceResult(
                "unapproved_dataset",
                True,
                1,
                0,
                now,
                latest_observed_at=datetime(2026, 9, 10, 11, 30, tzinfo=UTC),
            ),
            "live_qoe_hourly": SyncSourceResult(
                "live_qoe_hourly",
                True,
                0,
                0,
                now,
            ),
        },
        {},
        0,
    )
    observed = observe_command(
        "sync",
        "live",
        lambda _arguments: result,
        {
            "logger": JsonLogger(environment="local", stream=io.StringIO()),
            "metrics": CloudWatchMetrics(stream=metric_output),
            "monotonic": lambda: 10.0,
            "clock": lambda: now,
        },
    )

    assert observed(Namespace(command="sync")) is result

    documents = [json.loads(line) for line in metric_output.getvalue().splitlines()]
    source_lags = [document for document in documents if "SourceLagSeconds" in document]
    assert len(source_lags) == 1
    assert source_lags[0]["SourceLagSeconds"] == 900.0
    assert source_lags[0]["dataset"] == "signal_bucket"
    assert source_lags[0]["source_mode"] == "live"
    assert all("CoverageRatio" not in document for document in documents)


def test_runtime_inspects_outbox_once_and_emits_only_observed_age() -> None:
    from application.publish_outbox import PublishResult

    metric_output = io.StringIO()

    class Backlog:
        calls = 0

        def inspect_pending(self) -> OutboxBacklog:
            self.calls += 1
            return OutboxBacklog(4, datetime(2026, 9, 10, 11, 55, tzinfo=UTC))

    backlog = Backlog()
    observed = observe_command(
        "publish-outbox",
        None,
        lambda _arguments: PublishResult(0, 0),
        {
            "logger": JsonLogger(environment="local", stream=io.StringIO()),
            "metrics": CloudWatchMetrics(stream=metric_output),
            "monotonic": lambda: 10.0,
            "clock": lambda: datetime(2026, 9, 10, 12, 0, tzinfo=UTC),
        },
        outbox_backlog=backlog,
    )

    observed(Namespace(command="publish-outbox"))

    documents = [json.loads(line) for line in metric_output.getvalue().splitlines()]
    assert backlog.calls == 1
    assert (
        next(document for document in documents if "OutboxPendingCount" in document)[
            "OutboxPendingCount"
        ]
        == 4
    )
    assert (
        next(document for document in documents if "OutboxOldestAgeSeconds" in document)[
            "OutboxOldestAgeSeconds"
        ]
        == 300.0
    )
