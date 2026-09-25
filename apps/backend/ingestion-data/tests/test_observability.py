"""Verify stable, redacted telemetry emitted by the ingestion service."""

import json
import logging
import unittest

from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from view_show_ingestion import IngestionTelemetry, TelemetryConfig


def metric_names(reader: InMemoryMetricReader):
    data = reader.get_metrics_data()
    return {
        metric.name
        for resource in data.resource_metrics
        for scope in resource.scope_metrics
        for metric in scope.metrics
    }


class IngestionTelemetryTest(unittest.TestCase):
    def setUp(self):
        self.reader = InMemoryMetricReader()
        self.spans = InMemorySpanExporter()
        self.telemetry = IngestionTelemetry(
            TelemetryConfig(service_version="test"), self.reader, self.spans
        )

    def tearDown(self):
        self.telemetry.shutdown()

    def test_records_run_stage_volume_and_quality_metrics(self):
        with (
            self.telemetry.run("sync", "run-test"),
            self.telemetry.stage("read", "orders"),
        ):
            self.telemetry.record_source(
                "orders", read=10, written=8, unmodified=2, records_per_minute=60
            )
            self.telemetry.record_bytes("read", 512)
            self.telemetry.record_chunk_duration("orders", 0.2)
            self.telemetry.record_projection_duration("overview", 0.3)
            self.telemetry.record_quality(
                "orders",
                source_lag_seconds=5,
                coverage_ratio=0.99,
                last_successful_sync_timestamp=1_700_000_000,
            )
            self.telemetry.record_watermark("source", 1_700_000_000)
            self.telemetry.reject("orders", "invalid_schema")
            self.telemetry.schema_drift("orders")
            self.telemetry.lease_acquired("daily-sync")

        # Synchronous gauges report values recorded in the current collection
        # interval; the run flush above intentionally closed the prior one.
        self.telemetry.record_source("orders", records_per_minute=60)
        self.telemetry.record_quality(
            "orders",
            source_lag_seconds=5,
            coverage_ratio=0.99,
            last_successful_sync_timestamp=1_700_000_000,
        )

        self.assertTrue(
            {
                "ingestion_runs_total",
                "ingestion_pipeline_run_duration_seconds",
                "ingestion_stage_duration_seconds",
                "ingestion_records_read_total",
                "ingestion_records_written_total",
                "ingestion_records_unmodified_total",
                "ingestion_records_rate_per_minute",
                "ingestion_source_lag_seconds",
                "ingestion_coverage_ratio",
                "ingestion_records_rejected_total",
            }.issubset(metric_names(self.reader))
        )
        spans = self.spans.get_finished_spans()
        self.assertEqual(spans[-1].name, "ingestion.run")
        self.assertEqual(spans[-1].attributes["viewshow.command"], "sync")
        self.assertIn("ingestion.stage.read", {span.name for span in spans})

    def test_failure_is_rethrown_and_counted(self):
        with (
            self.assertRaisesRegex(RuntimeError, "boom"),
            self.telemetry.run("sync", "run-failed"),
        ):
            raise RuntimeError("boom")
        self.assertIn("ingestion_runs_total", metric_names(self.reader))
        self.assertEqual(
            self.spans.get_finished_spans()[-1].status.status_code,
            StatusCode.ERROR,
        )

    def test_structured_log_redacts_secrets(self):
        with self.assertLogs("view-show-ingestion", logging.INFO) as captured:
            self.telemetry.log.emit("info", "safe", token="private", nested={"password": "private"})
        payload = json.loads(captured.output[0].split(":", 2)[-1])
        self.assertEqual(payload["token"], "[REDACTED]")
        self.assertEqual(payload["nested"]["password"], "[REDACTED]")


if __name__ == "__main__":
    unittest.main()
