import unittest

from app import create_app


class EndpointControllerTests(unittest.TestCase):
    def setUp(self):
        self.client = create_app({"TESTING": True}).test_client()

    def test_telemetry_endpoints_accept_json(self):
        for path in ("/v1/telemetry/events", "/v1/telemetry/errors", "/v1/telemetry/heartbeat"):
            response = self.client.post(path, json={"session_id": "session-1"})
            self.assertEqual(response.status_code, 202)

    def test_analytics_endpoints_are_available(self):
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
            self.assertEqual(self.client.get(path).status_code, 200, path)

    def test_rca_endpoints_are_available(self):
        paths = (
            "/v1/analytics/rca/modules-breakdown",
            "/v1/analytics/rca/topology-health",
            "/v1/analytics/rca/fingerprints",
            "/v1/analytics/rca/fingerprints/fp-1",
            "/v1/analytics/rca/traces/trace-1",
            "/v1/analytics/rca/correlations",
        )
        for path in paths:
            self.assertEqual(self.client.get(path).status_code, 200, path)


if __name__ == "__main__":
    unittest.main()
