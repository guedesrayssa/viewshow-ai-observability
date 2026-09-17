"""Metrics, traces, and structured logs for the future analysis worker."""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.propagate import extract
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import MetricReader, PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    SimpleSpanProcessor,
    SpanExporter,
)
from opentelemetry.trace import SpanKind, Status, StatusCode

_REDACTED_KEYS = {
    "authorization",
    "cookie",
    "password",
    "secret",
    "token",
    "access_token",
    "refresh_token",
    "prompt",
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
    service_name: str = "view-show-agentic"
    service_version: str = "development"
    environment: str = "development"
    cloud_region: str = "local"
    service_instance_id: str = "local"
    otlp_endpoint: str = ""

    @classmethod
    def from_environment(cls) -> TelemetryConfig:
        return cls(
            service_name=os.getenv("OTEL_SERVICE_NAME", "view-show-agentic"),
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
        )


class StructuredLogger:
    def __init__(self, config: TelemetryConfig) -> None:
        self._config = config
        self._logger = logging.getLogger(config.service_name)
        if not self._logger.handlers:
            handler = logging.StreamHandler(sys.stdout)
            handler.setFormatter(logging.Formatter("%(message)s"))
            self._logger.addHandler(handler)
        self._logger.setLevel(logging.INFO)
        self._logger.propagate = False

    def emit(self, level: str, message: str, **fields: Any) -> None:
        span_context = trace.get_current_span().get_span_context()
        payload: dict[str, Any] = {
            "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
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


@dataclass
class OperationState:
    status: str = "success"

    def fail(self) -> None:
        self.status = "failure"

    def retry(self) -> None:
        self.status = "retry"

    def throttled(self) -> None:
        self.status = "throttled"


class AgenticTelemetry:
    """Low-cardinality telemetry facade for the future SQS analysis worker."""

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

        self._messages = self._meter.create_counter("analysis_messages_total")
        self._run_duration = self._meter.create_histogram(
            "analysis_run_duration_seconds", unit="s"
        )
        self._time_to_signal = self._meter.create_histogram(
            "anomaly_time_to_signal_seconds", unit="s"
        )
        self._investigation_duration = self._meter.create_histogram(
            "agent_investigation_duration_seconds", unit="s"
        )
        self._bedrock_duration = self._meter.create_histogram(
            "bedrock_invocation_duration_seconds", unit="s"
        )
        self._bedrock_invocations = self._meter.create_counter(
            "bedrock_invocations_total"
        )
        self._bedrock_fallback = self._meter.create_counter("bedrock_fallback_total")
        self._bedrock_tokens = self._meter.create_counter("bedrock_tokens_total")
        self._golden_matches = self._meter.create_counter("golden_set_matches_total")
        self._golden_promotions = self._meter.create_counter(
            "golden_set_promotions_total"
        )
        self._queue_depth = self._meter.create_gauge("sqs_queue_depth_messages")
        self._dlq_depth = self._meter.create_gauge("sqs_dead_letter_queue_messages")
        self._oldest_message_age = self._meter.create_gauge(
            "sqs_oldest_message_age_seconds", unit="s"
        )

    @contextmanager
    def message(
        self,
        event_type: str,
        message_id: str,
        carrier: Mapping[str, str] | None = None,
    ) -> Iterator[OperationState]:
        state = OperationState()
        started = time.monotonic()
        parent_context = extract(carrier) if carrier else None
        with self._tracer.start_as_current_span(
            "analysis.message", context=parent_context, kind=SpanKind.CONSUMER
        ) as span:
            span.set_attribute("messaging.message.id", message_id)
            span.set_attribute("viewshow.event_type", event_type)
            self.log.emit(
                "info",
                "analysis message started",
                event_type=event_type,
                message_id=message_id,
            )
            try:
                yield state
            except Exception as error:
                state.status = "failure"
                span.record_exception(error)
                span.set_status(Status(StatusCode.ERROR, str(error)))
                self.log.emit(
                    "error",
                    "analysis message failed",
                    event_type=event_type,
                    message_id=message_id,
                    error_type=type(error).__name__,
                )
                raise
            finally:
                if state.status not in {
                    "success",
                    "failure",
                    "retry",
                    "throttled",
                }:
                    state.status = "failure"
                if state.status == "failure":
                    span.set_status(Status(StatusCode.ERROR))
                duration = time.monotonic() - started
                attributes = {"event_type": event_type, "status": state.status}
                self._messages.add(1, attributes)
                self._run_duration.record(duration, attributes)
                span.set_attribute("viewshow.analysis_status", state.status)
                self.log.emit(
                    "info",
                    "analysis message finished",
                    event_type=event_type,
                    message_id=message_id,
                    status=state.status,
                    duration_seconds=duration,
                )

    @contextmanager
    def investigation(self, diagnosis_source: str) -> Iterator[OperationState]:
        state = OperationState()
        started = time.monotonic()
        with self._tracer.start_as_current_span("agent.investigate") as span:
            span.set_attribute("viewshow.diagnosis_source", diagnosis_source)
            try:
                yield state
            except Exception as error:
                state.status = "failure"
                span.record_exception(error)
                span.set_status(Status(StatusCode.ERROR, str(error)))
                raise
            finally:
                self._investigation_duration.record(
                    time.monotonic() - started,
                    {"diagnosis_source": diagnosis_source},
                )

    @contextmanager
    def bedrock_invocation(self, model_id: str) -> Iterator[OperationState]:
        state = OperationState()
        started = time.monotonic()
        with self._tracer.start_as_current_span(
            "bedrock.explain", kind=SpanKind.CLIENT
        ) as span:
            span.set_attribute("gen_ai.system", "aws.bedrock")
            span.set_attribute("gen_ai.request.model", model_id)
            try:
                yield state
            except Exception as error:
                state.status = "failure"
                span.record_exception(error)
                span.set_status(Status(StatusCode.ERROR, str(error)))
                raise
            finally:
                attributes = {"model_id": model_id, "status": state.status}
                self._bedrock_duration.record(time.monotonic() - started, attributes)
                self._bedrock_invocations.add(1, {"status": state.status})

    def record_time_to_signal(self, event_type: str, seconds: float) -> None:
        self._time_to_signal.record(seconds, {"event_type": event_type})

    def bedrock_fallback(self, reason: str) -> None:
        self._bedrock_fallback.add(1, {"reason": reason})

    def bedrock_tokens(self, token_type: str, count: int) -> None:
        self._bedrock_tokens.add(count, {"token_type": token_type})

    def golden_set_match(self, component: str) -> None:
        self._golden_matches.add(1, {"component": component})

    def golden_set_promotion(self, component: str) -> None:
        self._golden_promotions.add(1, {"component": component})

    def record_queue_state(
        self, *, depth: int, dlq_depth: int, oldest_message_age_seconds: float
    ) -> None:
        self._queue_depth.set(depth)
        self._dlq_depth.set(dlq_depth)
        self._oldest_message_age.set(oldest_message_age_seconds)

    def force_flush(self, timeout_millis: int = 5_000) -> bool:
        metrics_ok = self._meter_provider.force_flush(timeout_millis)
        traces_ok = self._tracer_provider.force_flush(timeout_millis)
        return metrics_ok and traces_ok

    def shutdown(self) -> None:
        self._meter_provider.shutdown()
        self._tracer_provider.shutdown()
