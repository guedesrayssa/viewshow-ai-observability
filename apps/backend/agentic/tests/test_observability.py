import json
import logging
import unittest
from unittest.mock import Mock

from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode
from view_show_agentic import AgenticTelemetry, TelemetryConfig


def metric_names(reader: InMemoryMetricReader):
    data = reader.get_metrics_data()
    return {
        metric.name
        for resource in data.resource_metrics
        for scope in resource.scope_metrics
        for metric in scope.metrics
    }


class AgenticTelemetryTest(unittest.TestCase):
    def setUp(self):
        self.reader = InMemoryMetricReader()
        self.spans = InMemorySpanExporter()
        self.telemetry = AgenticTelemetry(
            TelemetryConfig(service_version="test"), self.reader, self.spans
        )

    def tearDown(self):
        self.telemetry.shutdown()

    def test_records_worker_and_bedrock_metrics(self):
        with (
            self.telemetry.message("incident.detected", "message-1"),
            self.telemetry.investigation("golden-set"),
            self.telemetry.bedrock_invocation("test-model"),
        ):
            self.telemetry.bedrock_tokens("input", 100)
            self.telemetry.bedrock_tokens("output", 20)
            self.telemetry.record_time_to_signal("incident.detected", 4.2)
            self.telemetry.golden_set_match("detector")
            self.telemetry.golden_set_promotion("hypothesis")
            self.telemetry.record_queue_state(
                depth=2, dlq_depth=0, oldest_message_age_seconds=3
            )

        # The message boundary flushes the previous collection interval.
        self.telemetry.record_queue_state(
            depth=2, dlq_depth=0, oldest_message_age_seconds=3
        )

        self.assertTrue(
            {
                "analysis_messages_total",
                "analysis_run_duration_seconds",
                "anomaly_time_to_signal_seconds",
                "agent_investigation_duration_seconds",
                "bedrock_invocation_duration_seconds",
                "bedrock_invocations_total",
                "bedrock_tokens_total",
                "golden_set_matches_total",
                "golden_set_promotions_total",
                "sqs_queue_depth_messages",
            }.issubset(metric_names(self.reader))
        )
        self.assertEqual(
            {span.name for span in self.spans.get_finished_spans()},
            {"analysis.message", "agent.investigate", "bedrock.explain"},
        )

    def test_failure_is_rethrown_and_counted(self):
        with (
            self.assertRaisesRegex(RuntimeError, "boom"),
            self.telemetry.message("incident.detected", "message-2"),
        ):
            raise RuntimeError("boom")
        self.assertIn("analysis_messages_total", metric_names(self.reader))
        self.assertEqual(
            self.spans.get_finished_spans()[-1].status.status_code,
            StatusCode.ERROR,
        )

    def test_extracts_w3c_parent_from_queue_carrier(self):
        trace_id = "0123456789abcdef0123456789abcdef"
        parent_span_id = "0123456789abcdef"
        with self.telemetry.message(
            "incident.detected",
            "message-3",
            {"traceparent": f"00-{trace_id}-{parent_span_id}-01"},
        ):
            pass

        span = self.spans.get_finished_spans()[-1]
        self.assertEqual(format(span.context.trace_id, "032x"), trace_id)
        self.assertEqual(format(span.parent.span_id, "016x"), parent_span_id)

    def test_message_does_not_force_synchronous_flush(self):
        self.telemetry.force_flush = Mock(return_value=True)

        with self.telemetry.message("incident.detected", "message-4"):
            pass

        self.telemetry.force_flush.assert_not_called()

    def test_structured_log_redacts_prompt_and_token(self):
        with self.assertLogs("view-show-agentic", logging.INFO) as captured:
            self.telemetry.log.emit(
                "info", "safe", prompt="private", nested={"token": "private"}
            )
        payload = json.loads(captured.output[0].split(":", 2)[-1])
        self.assertEqual(payload["prompt"], "[REDACTED]")
        self.assertEqual(payload["nested"]["token"], "[REDACTED]")


if __name__ == "__main__":
    unittest.main()
