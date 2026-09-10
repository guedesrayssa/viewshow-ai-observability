"""Metrics, traces, and structured logs for ingestion jobs.

The module deliberately contains no ingestion business logic. Future batch
entrypoints wrap runs and stages with these hooks so short-lived processes can
flush telemetry before exiting.
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import MetricReader, PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    SimpleSpanProcessor,
    SpanExporter,
)
from opentelemetry.trace import Status, StatusCode

_REDACTED_KEYS = {
    "authorization",
    "cookie",
    "password",
    "secret",
    "token",
    "access_token",
    "refresh_token",
}


def _endpoint(base: str, signal: str) -> str:
    return f"{base.rstrip('/')}/v1/{signal}"


def _redact(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): "[REDACTED]"
            if str(key).lower() in _REDACTED_KEYS
            else _redact(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_redact(item) for item in value]
    return value


@dataclass(frozen=True)
class TelemetryConfig:
    service_name: str = "view-show-ingestion"
    service_version: str = "development"
    environment: str = "development"
    cloud_region: str = "local"
    service_instance_id: str = "local"
    otlp_endpoint: str = ""
    loki_push_url: str = ""

    @classmethod
    def from_environment(cls) -> TelemetryConfig:
        return cls(
            service_name=os.getenv("OTEL_SERVICE_NAME", "view-show-ingestion"),
            service_version=os.getenv(
                "OTEL_SERVICE_VERSION", os.getenv("COMMIT_SHA", "development")
            ),
            environment=os.getenv(
                "DEPLOYMENT_ENVIRONMENT",
                os.getenv(
                    "OTEL_DEPLOYMENT_ENVIRONMENT",
                    os.getenv("NODE_ENV", "development"),
                ),
            ),
            cloud_region=os.getenv(
                "AWS_REGION", os.getenv("AWS_DEFAULT_REGION", "local")
            ),
            service_instance_id=os.getenv(
                "OTEL_SERVICE_INSTANCE_ID", os.getenv("HOSTNAME", "local")
            ),
            otlp_endpoint=os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", ""),
            loki_push_url=os.getenv("LOKI_PUSH_URL", ""),
        )


class StructuredLogger:
    def __init__(self, config: TelemetryConfig) -> None:
        self._config = config
        self._logger = logging.getLogger(config.service_name)
        if not self._logger.handlers:
            handler = logging.StreamHandler()
            handler.setFormatter(logging.Formatter("%(message)s"))
            self._logger.addHandler(handler)
        self._logger.setLevel(logging.INFO)
        self._logger.propagate = False

    def emit(self, level: str, message: str, **fields: Any) -> None:
        span_context = trace.get_current_span().get_span_context()
        payload: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "level": level,
            "message": message,
            "service_name": self._config.service_name,
            "service_version": self._config.service_version,
            "environment": self._config.environment,
            **_redact(fields),
        }
        if span_context.is_valid:
            payload["trace_id"] = format(span_context.trace_id, "032x")
            payload["span_id"] = format(span_context.span_id, "016x")
        line = json.dumps(payload, separators=(",", ":"), default=str)
        self._logger.log(getattr(logging, level.upper(), logging.INFO), line)
        self._push_loki(line, level)

    def _push_loki(self, line: str, level: str) -> None:
        if not self._config.loki_push_url:
            return
        body = json.dumps(
            {
                "streams": [
                    {
                        "stream": {
                            "service_name": self._config.service_name,
                            "environment": self._config.environment,
                            "level": level,
                        },
                        "values": [[str(time.time_ns()), line]],
                    }
                ]
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            self._config.loki_push_url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=2):
                pass
        except (OSError, ValueError, urllib.error.URLError):
            # Telemetry transport must never fail an ingestion run.
            return


@dataclass
class RunState:
    status: str = "SUCCEEDED"

    def partial(self) -> None:
        self.status = "PARTIAL"

    def skipped_locked(self) -> None:
        self.status = "SKIPPED_LOCKED"


class IngestionTelemetry:
    """Low-cardinality telemetry facade for future ingestion entrypoints."""

    def __init__(
        self,
        config: TelemetryConfig | None = None,
        metric_reader: MetricReader | None = None,
        span_exporter: SpanExporter | None = None,
    ) -> None:
        self.config = config or TelemetryConfig.from_environment()
        resource = Resource.create(
            {
                "service.name": self.config.service_name,
                "service.version": self.config.service_version,
                "deployment.environment.name": self.config.environment,
                "cloud.region": self.config.cloud_region,
                "service.instance.id": self.config.service_instance_id,
            }
        )
        readers = []
        if metric_reader is not None:
            readers.append(metric_reader)
        elif self.config.otlp_endpoint:
            readers.append(
                PeriodicExportingMetricReader(
                    OTLPMetricExporter(
                        endpoint=_endpoint(self.config.otlp_endpoint, "metrics")
                    ),
                    export_interval_millis=15_000,
                )
            )
        self._meter_provider = MeterProvider(resource=resource, metric_readers=readers)
        self._tracer_provider = TracerProvider(resource=resource)
        if span_exporter is not None:
            self._tracer_provider.add_span_processor(SimpleSpanProcessor(span_exporter))
        elif self.config.otlp_endpoint:
            self._tracer_provider.add_span_processor(
                BatchSpanProcessor(
                    OTLPSpanExporter(
                        endpoint=_endpoint(self.config.otlp_endpoint, "traces")
                    )
                )
            )
        self._meter = self._meter_provider.get_meter(__name__)
        self._tracer = self._tracer_provider.get_tracer(__name__)
        self.log = StructuredLogger(self.config)

        self._records_read = self._meter.create_counter("ingestion_records_read_total")
        self._records_written = self._meter.create_counter(
            "ingestion_records_written_total"
        )
        self._records_unmodified = self._meter.create_counter(
            "ingestion_records_unmodified_total"
        )
        self._bytes = self._meter.create_counter("ingestion_bytes_transferred_total")
        self._records_rejected = self._meter.create_counter(
            "ingestion_records_rejected_total"
        )
        self._schema_drift = self._meter.create_counter("ingestion_schema_drift_total")
        self._lease_acquired = self._meter.create_counter(
            "ingestion_lease_acquisitions_total"
        )
        self._lease_conflicts = self._meter.create_counter(
            "ingestion_lease_conflicts_total"
        )
        self._runs = self._meter.create_counter("ingestion_runs_total")
        self._run_duration = self._meter.create_histogram(
            "ingestion_pipeline_run_duration_seconds", unit="s"
        )
        self._stage_duration = self._meter.create_histogram(
            "ingestion_stage_duration_seconds", unit="s"
        )
        self._chunk_duration = self._meter.create_histogram(
            "ingestion_chunk_processing_seconds", unit="s"
        )
        self._projection_duration = self._meter.create_histogram(
            "ingestion_projections_rebuild_seconds", unit="s"
        )
        self._records_rate = self._meter.create_gauge(
            "ingestion_records_rate_per_minute"
        )
        self._source_lag = self._meter.create_gauge(
            "ingestion_source_lag_seconds", unit="s"
        )
        self._coverage = self._meter.create_gauge("ingestion_coverage_ratio")
        self._watermark = self._meter.create_gauge(
            "ingestion_watermark_timestamp_seconds", unit="s"
        )
        self._last_sync = self._meter.create_gauge(
            "ingestion_last_successful_sync_timestamp", unit="s"
        )

    @contextmanager
    def run(self, command: str, run_id: str) -> Iterator[RunState]:
        state = RunState()
        started = time.monotonic()
        try:
            with self._tracer.start_as_current_span("ingestion.run") as span:
                span.set_attribute("viewshow.command", command)
                span.set_attribute("viewshow.run_id", run_id)
                self.log.emit(
                    "info", "ingestion run started", command=command, run_id=run_id
                )
                try:
                    yield state
                except Exception as error:
                    state.status = "FAILED"
                    span.record_exception(error)
                    span.set_status(Status(StatusCode.ERROR, str(error)))
                    self.log.emit(
                        "error",
                        "ingestion run failed",
                        command=command,
                        run_id=run_id,
                        error_type=type(error).__name__,
                    )
                    raise
                finally:
                    if state.status not in {
                        "SUCCEEDED",
                        "PARTIAL",
                        "FAILED",
                        "SKIPPED_LOCKED",
                    }:
                        state.status = "FAILED"
                    duration = time.monotonic() - started
                    self._runs.add(1, {"status": state.status})
                    self._run_duration.record(duration, {"command": command})
                    span.set_attribute("viewshow.run_status", state.status)
                    self.log.emit(
                        "info",
                        "ingestion run finished",
                        command=command,
                        run_id=run_id,
                        status=state.status,
                        duration_seconds=duration,
                    )
        finally:
            self._force_flush_safely()

    @contextmanager
    def stage(self, stage: str, source_dataset: str | None = None) -> Iterator[None]:
        started = time.monotonic()
        attributes = {"stage": stage}
        with self._tracer.start_as_current_span(f"ingestion.stage.{stage}") as span:
            span.set_attribute("viewshow.stage", stage)
            if source_dataset:
                span.set_attribute("viewshow.source_dataset", source_dataset)
            try:
                yield
            except Exception as error:
                span.record_exception(error)
                span.set_status(Status(StatusCode.ERROR, str(error)))
                raise
            finally:
                self._stage_duration.record(time.monotonic() - started, attributes)

    def record_source(
        self,
        source_dataset: str,
        *,
        read: int = 0,
        written: int = 0,
        unmodified: int = 0,
        records_per_minute: float | None = None,
    ) -> None:
        attributes = {"source_dataset": source_dataset}
        if read:
            self._records_read.add(read, attributes)
        if written:
            self._records_written.add(written, attributes)
        if unmodified:
            self._records_unmodified.add(unmodified, attributes)
        if records_per_minute is not None:
            self._records_rate.set(
                records_per_minute,
                {"worker": self.config.service_name, **attributes},
            )

    def record_bytes(self, direction: str, count: int) -> None:
        self._bytes.add(count, {"direction": direction})

    def record_chunk_duration(self, source_dataset: str, seconds: float) -> None:
        self._chunk_duration.record(seconds, {"source_dataset": source_dataset})

    def record_projection_duration(self, projection_name: str, seconds: float) -> None:
        self._projection_duration.record(seconds, {"projection_name": projection_name})

    def record_quality(
        self,
        source_dataset: str,
        *,
        source_lag_seconds: float,
        coverage_ratio: float,
        last_successful_sync_timestamp: float,
    ) -> None:
        attributes = {"source_dataset": source_dataset}
        self._source_lag.set(source_lag_seconds, attributes)
        self._coverage.set(coverage_ratio, attributes)
        self._last_sync.set(last_successful_sync_timestamp, attributes)

    def record_watermark(self, watermark_type: str, timestamp_seconds: float) -> None:
        self._watermark.set(timestamp_seconds, {"watermark_type": watermark_type})

    def reject(self, source_dataset: str, reason: str, count: int = 1) -> None:
        self._records_rejected.add(
            count, {"source_dataset": source_dataset, "reason": reason}
        )

    def schema_drift(self, source_dataset: str, count: int = 1) -> None:
        self._schema_drift.add(count, {"source_dataset": source_dataset})

    def lease_acquired(self, scope: str) -> None:
        self._lease_acquired.add(1, {"scope": scope})

    def lease_conflict(self, scope: str) -> None:
        self._lease_conflicts.add(1, {"scope": scope})

    def force_flush(self, timeout_millis: int = 5_000) -> bool:
        metrics_ok = self._meter_provider.force_flush(timeout_millis)
        traces_ok = self._tracer_provider.force_flush(timeout_millis)
        return metrics_ok and traces_ok

    def _force_flush_safely(self) -> None:
        try:
            self.force_flush()
        except Exception:  # noqa: BLE001 - telemetry must not fail a batch run
            self.log.emit("warning", "telemetry flush failed")

    def shutdown(self) -> None:
        self._meter_provider.shutdown()
        self._tracer_provider.shutdown()
