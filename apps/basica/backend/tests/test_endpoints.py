"""Testes de contrato HTTP: status, envelope de erro e payloads dos endpoints."""

from __future__ import annotations

import unittest

from app import create_app

TRACE_ID = "trace-e2e-1"


def _event(session_id: str, **overrides):
    payload = {
        "session_id": session_id,
        "event_type": "playback_start",
        "startup_time_ms": 1_800,
        "playback_duration_ms": 120_000,
        "rebuffer_duration_ms": 1_500,
        "rebuffer_count": 1,
        "bitrate_kbps": 4_500,
        "device": {"model": "tv-box-a", "os": "android", "app_version": "2.4.0"},
        "network": {"isp": "isp-alpha", "cdn": "cdn-1", "connection_type": "wifi"},
    }
    payload.update(overrides)
    return payload


def _error(session_id: str, error_code: str = "PLAYER_TIMEOUT", **overrides):
    payload = {
        "session_id": session_id,
        "error_code": error_code,
        "message": "timeout after 3500 ms",
        "module": "player",
        "service": "playback-api",
        "fatal": True,
        "trace_id": TRACE_ID,
        "device": {"model": "tv-box-a", "os": "android", "app_version": "2.4.0"},
        "network": {"isp": "isp-alpha", "cdn": "cdn-1", "connection_type": "wifi"},
        "spans": [
            {
                "span_id": "span-1",
                "service": "gateway",
                "operation": "GET /play",
                "duration_ms": 300,
            },
            {
                "span_id": "span-2",
                "parent_span_id": "span-1",
                "service": "cdn-edge",
                "operation": "GET /segment",
                "duration_ms": 150,
                "status": "error",
            },
        ],
    }
    payload.update(overrides)
    return payload


class ApiTestCase(unittest.TestCase):
    """Base com uma aplicação limpa e um conjunto mínimo de telemetria."""

    def setUp(self):
        self.client = create_app({"TESTING": True}).test_client()

    def seed(self):
        self.client.post("/v1/telemetry/events", json=[_event("session-1"), _event("session-2")])
        self.client.post(
            "/v1/telemetry/errors",
            json=[_error("session-1"), _error("session-2", "CDN_5XX", module="cdn")],
        )
        self.client.post("/v1/telemetry/heartbeat", json={"session_id": "session-1"})

    def get(self, path: str, expected: int = 200):
        response = self.client.get(path)
        self.assertEqual(response.status_code, expected, f"{path}: {response.get_json()}")
        return response.get_json()


class TelemetryEndpointTests(ApiTestCase):
    def test_endpoints_accept_a_single_record(self):
        for path, payload in (
            ("/v1/telemetry/events", _event("session-1")),
            ("/v1/telemetry/errors", _error("session-1")),
            ("/v1/telemetry/heartbeat", {"session_id": "session-1"}),
        ):
            response = self.client.post(path, json=payload)

            self.assertEqual(response.status_code, 202, path)
            self.assertEqual(response.get_json()["accepted"], 1, path)

    def test_events_accept_a_batch_and_report_rejected_items(self):
        response = self.client.post(
            "/v1/telemetry/events", json=[_event("session-1"), {"event_type": "playback"}]
        )

        body = response.get_json()
        self.assertEqual(response.status_code, 202)
        self.assertEqual((body["received"], body["accepted"]), (2, 1))
        self.assertEqual(body["rejected"][0]["index"], 1)

    def test_body_without_any_valid_record_returns_422(self):
        response = self.client.post("/v1/telemetry/errors", json=[{"session_id": "session-1"}])

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.get_json()["error"]["code"], "unprocessable_payload")

    def test_malformed_body_returns_400(self):
        response = self.client.post(
            "/v1/telemetry/events", data="não é json", content_type="application/json"
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"]["code"], "validation_error")

    def test_batch_above_the_limit_returns_413(self):
        client = create_app({"TESTING": True, "MAX_BATCH_SIZE": 2}).test_client()

        response = client.post(
            "/v1/telemetry/events", json=[_event(f"session-{index}") for index in range(3)]
        )

        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.get_json()["error"]["code"], "payload_too_large")

    def test_reading_an_ingestion_endpoint_returns_405(self):
        response = self.client.get("/v1/telemetry/events")

        self.assertEqual(response.status_code, 405)
        self.assertEqual(response.get_json()["error"]["code"], "method_not_allowed")

    def test_fault_header_is_ignored_when_load_test_faults_are_disabled(self):
        response = self.client.post(
            "/v1/telemetry/events",
            json=_event("session-1"),
            headers={"X-View-Show-Test-Fault": "queue-full"},
        )

        self.assertEqual(response.status_code, 202)


class IngestionResilienceEndpointTests(unittest.TestCase):
    TOKEN = "token-local-de-resiliencia"

    def setUp(self):
        self.client = create_app(
            {
                "TESTING": True,
                "LOAD_TEST_FAULTS_ENABLED": True,
                "LOAD_TEST_FAULT_TOKEN": self.TOKEN,
                "LOAD_TEST_TIMEOUT_DELAY_MS": 0,
            }
        ).test_client()

    def post_with_fault(self, fault: str, *, token: str | None = None):
        return self.client.post(
            "/v1/telemetry/events",
            json=_event("session-fault"),
            headers={
                "X-View-Show-Test-Fault": fault,
                "X-View-Show-Test-Token": token or self.TOKEN,
            },
        )

    def test_queue_full_returns_429_without_persisting_and_then_recovers(self):
        failure = self.post_with_fault("queue-full")

        self.assertEqual(failure.status_code, 429)
        self.assertEqual(failure.get_json()["error"]["code"], "queue_full")
        self.assertEqual(
            self.client.get("/v1/analytics/realtime/overview").get_json()["events"]["total"],
            0,
        )

        recovery = self.client.post("/v1/telemetry/events", json=_event("session-recovery"))
        self.assertEqual(recovery.status_code, 202)
        self.assertEqual(recovery.get_json()["accepted"], 1)

    def test_dependency_timeout_returns_504_without_persisting_and_then_recovers(self):
        failure = self.post_with_fault("timeout")

        self.assertEqual(failure.status_code, 504)
        self.assertEqual(failure.get_json()["error"]["code"], "dependency_timeout")
        self.assertEqual(
            self.client.get("/v1/analytics/realtime/overview").get_json()["events"]["total"],
            0,
        )

        recovery = self.client.post("/v1/telemetry/events", json=_event("session-recovery"))
        self.assertEqual(recovery.status_code, 202)

    def test_fault_injection_requires_the_configured_token(self):
        response = self.post_with_fault("queue-full", token="token-incorreto")

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["error"]["code"], "fault_injection_unauthorized")

    def test_unknown_fault_is_rejected(self):
        response = self.post_with_fault("disk-on-fire")

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"]["code"], "validation_error")

    def test_enabling_faults_without_token_fails_at_startup(self):
        with self.assertRaisesRegex(RuntimeError, "LOAD_TEST_FAULT_TOKEN é obrigatório"):
            create_app(
                {
                    "TESTING": True,
                    "LOAD_TEST_FAULTS_ENABLED": True,
                    "LOAD_TEST_FAULT_TOKEN": "",
                }
            )


class AnalyticsEndpointTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.seed()

    def test_every_analytics_endpoint_answers(self):
        paths = (
            "/v1/analytics/realtime/overview",
            "/v1/analytics/realtime/alerts",
            "/v1/analytics/qoe/metrics",
            "/v1/analytics/qoe/timeseries",
            "/v1/analytics/errors/summary",
            "/v1/analytics/errors/top",
            "/v1/analytics/errors/PLAYER_TIMEOUT/details",
            "/v1/analytics/breakdown/devices",
            "/v1/analytics/breakdown/network",
        )
        for path in paths:
            self.assertIn("window", self.get(path), path)

    def test_overview_reflects_the_ingested_telemetry(self):
        body = self.get("/v1/analytics/realtime/overview")

        self.assertEqual(body["events"]["total"], 2)
        self.assertEqual(body["errors"]["total"], 2)
        self.assertEqual(body["ccu"], 1)
        self.assertEqual(body["active_sessions"], 2)

    def test_qoe_metrics_expose_startup_rebuffer_and_bitrate(self):
        metrics = self.get("/v1/analytics/qoe/metrics")["metrics"]

        self.assertEqual(metrics["startup_time_ms"]["p95"], 1_800.0)
        self.assertEqual(metrics["average_bitrate_kbps"], 4_500.0)
        self.assertAlmostEqual(metrics["rebuffer"]["rate"], 3_000 / 243_000, places=4)

    def test_timeseries_respects_the_requested_interval(self):
        body = self.get("/v1/analytics/qoe/timeseries?window=1h&interval=10m")

        self.assertEqual(body["interval_seconds"], 600)
        self.assertEqual(len(body["points"]), 6)

    def test_errors_summary_reports_the_crash_free_rate(self):
        summary = self.get("/v1/analytics/errors/summary")["summary"]

        self.assertEqual(summary["total_errors"], 2)
        self.assertEqual(summary["crash_free_rate"], 0.0)
        self.assertEqual(summary["error_rate"], 1.0)

    def test_top_errors_are_ranked(self):
        body = self.get("/v1/analytics/errors/top")

        self.assertEqual(len(body["errors"]), 2)
        self.assertEqual(body["errors"][0]["occurrences"], 1)

    def test_error_details_include_breakdown_and_timeline(self):
        body = self.get("/v1/analytics/errors/PLAYER_TIMEOUT/details")

        self.assertEqual(body["occurrences"], 1)
        self.assertEqual(body["breakdown"]["modules"][0]["module"], "player")
        self.assertTrue(body["timeline"])

    def test_unknown_error_code_returns_404(self):
        body = self.get("/v1/analytics/errors/NAO_EXISTE/details", expected=404)

        self.assertEqual(body["error"]["code"], "not_found")

    def test_breakdown_accepts_a_dimension(self):
        body = self.get("/v1/analytics/breakdown/devices?dimension=os")

        self.assertEqual(body["dimension"], "os")
        self.assertEqual(body["breakdown"][0]["value"], "android")

    def test_unknown_dimension_returns_400(self):
        body = self.get("/v1/analytics/breakdown/network?dimension=cor", expected=400)

        self.assertEqual(body["error"]["code"], "validation_error")

    def test_invalid_window_returns_400(self):
        for path in (
            "/v1/analytics/realtime/overview?window=ontem",
            "/v1/analytics/realtime/overview?window=1h&from=2026-08-11T00:00:00Z",
            "/v1/analytics/errors/top?limit=0",
            "/v1/analytics/qoe/timeseries?window=7d&interval=1s",
        ):
            self.get(path, expected=400)


class RcaEndpointTests(ApiTestCase):
    def setUp(self):
        super().setUp()
        self.seed()

    def test_every_rca_endpoint_answers(self):
        for path in (
            "/v1/analytics/rca/modules-breakdown",
            "/v1/analytics/rca/topology-health",
            "/v1/analytics/rca/fingerprints",
            "/v1/analytics/rca/correlations",
        ):
            self.assertIn("window", self.get(path), path)

    def test_modules_breakdown_points_at_the_failing_modules(self):
        modules = self.get("/v1/analytics/rca/modules-breakdown")["modules"]

        self.assertEqual({entry["module"] for entry in modules}, {"player", "cdn"})

    def test_topology_health_is_derived_from_the_spans(self):
        body = self.get("/v1/analytics/rca/topology-health")

        self.assertEqual({node["service"] for node in body["services"]}, {"gateway", "cdn-edge"})
        self.assertEqual(body["dependencies"][0]["target"], "cdn-edge")
        self.assertEqual(body["status"], "critical")

    def test_fingerprint_details_are_reachable_from_the_listing(self):
        listing = self.get("/v1/analytics/rca/fingerprints")
        fingerprint = listing["fingerprints"][0]["fingerprint_id"]

        body = self.get(f"/v1/analytics/rca/fingerprints/{fingerprint}")

        self.assertEqual(body["fingerprint_id"], fingerprint)
        self.assertIn("impact_radius", body)

    def test_unknown_fingerprint_returns_404(self):
        self.get("/v1/analytics/rca/fingerprints/000000000000", expected=404)

    def test_trace_returns_the_waterfall(self):
        body = self.get(f"/v1/analytics/rca/traces/{TRACE_ID}")

        self.assertEqual(body["span_count"], 4)
        self.assertEqual(body["status"], "error")
        self.assertEqual(body["spans"][0]["depth"], 0)

    def test_unknown_trace_returns_404(self):
        self.get("/v1/analytics/rca/traces/trace-inexistente", expected=404)

    def test_correlations_accept_a_minimum_coefficient(self):
        body = self.get("/v1/analytics/rca/correlations?min_correlation=0.9")

        self.assertEqual(body["minimum_coefficient"], 0.9)
        self.assertIsInstance(body["correlations"], list)


class ErrorEnvelopeTests(ApiTestCase):
    def test_unknown_routes_answer_in_json(self):
        response = self.client.get("/v1/analytics/inexistente")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["error"]["code"], "not_found")


if __name__ == "__main__":
    unittest.main()
