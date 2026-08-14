"""Testes do serviço de análise de causa raiz."""

from __future__ import annotations

import unittest
from datetime import timedelta

from app.domain.fingerprint import fingerprint_for, normalize_message
from app.errors import ResourceNotFoundError
from app.services.rca import RcaService
from tests.factories import error, event, repository, span, window


def _trace_error(**overrides):
    """Erro com um trace de duas pontas: gateway chamando a borda da CDN."""
    spans = (
        span("span-gateway", "gateway", duration_ms=300, operation="GET /play"),
        span(
            "span-cdn",
            "cdn-edge",
            seconds=0.1,
            duration_ms=150,
            status="error",
            parent_span_id="span-gateway",
            operation="GET /segment",
        ),
    )
    return error(trace_id="trace-1", spans=spans, **overrides)


class FingerprintTests(unittest.TestCase):
    def test_normalization_removes_identifiers_and_numbers(self):
        normalized = normalize_message("Timeout after 3500 ms on 'segment-42' (0xFF)")

        self.assertEqual(normalized, "timeout after <num> ms on <str> (<hex>)")

    def test_messages_differing_only_by_values_share_a_fingerprint(self):
        first = error(message="Timeout after 3500 ms")
        second = error(message="Timeout after 900 ms")

        self.assertEqual(first.fingerprint, second.fingerprint)

    def test_different_codes_produce_different_fingerprints(self):
        first = error(error_code="PLAYER_TIMEOUT", message="falhou")
        second = error(error_code="CDN_5XX", message="falhou")

        self.assertNotEqual(first.fingerprint, second.fingerprint)

    def test_fingerprint_is_derived_once_when_the_error_is_created(self):
        occurrence = error(error_code="CDN_5XX", module="cdn", message="upstream 503")

        self.assertEqual(occurrence.fingerprint, fingerprint_for("CDN_5XX", "cdn", "upstream 503"))


class ModulesBreakdownTests(unittest.TestCase):
    def test_modules_are_ranked_with_their_top_codes(self):
        service = RcaService(
            repository(
                errors=[
                    error(minutes=1, module="player", error_code="PLAYER_TIMEOUT"),
                    error(minutes=2, module="player", error_code="PLAYER_TIMEOUT"),
                    error(minutes=3, module="drm", error_code="DRM_LICENSE"),
                ]
            )
        )

        modules = service.modules_breakdown(window())["modules"]

        self.assertEqual([entry["module"] for entry in modules], ["player", "drm"])
        self.assertAlmostEqual(modules[0]["share"], 2 / 3, places=3)
        self.assertEqual(modules[0]["top_error_codes"][0]["error_code"], "PLAYER_TIMEOUT")


class TopologyHealthTests(unittest.TestCase):
    def setUp(self):
        self.service = RcaService(repository(errors=[_trace_error()]))

    def test_services_are_scored_by_their_error_rate(self):
        topology = self.service.topology_health(window())
        by_service = {node["service"]: node for node in topology["services"]}

        self.assertEqual(by_service["gateway"]["status"], "healthy")
        self.assertEqual(by_service["cdn-edge"]["status"], "critical")
        self.assertEqual(by_service["cdn-edge"]["latency_ms"]["p95"], 150.0)
        self.assertEqual(topology["status"], "critical")

    def test_dependencies_follow_the_parent_span(self):
        dependencies = self.service.topology_health(window())["dependencies"]

        self.assertEqual(len(dependencies), 1)
        self.assertEqual(dependencies[0]["source"], "gateway")
        self.assertEqual(dependencies[0]["target"], "cdn-edge")
        self.assertEqual(dependencies[0]["errors"], 1)

    def test_spans_of_different_traces_are_not_linked(self):
        # `span_id` só é único dentro de um trace: dois traces podem reusar o
        # mesmo identificador sem que isso crie uma dependência entre serviços.
        outro = error(
            minutes=5,
            trace_id="trace-2",
            spans=(
                span("span-gateway", "mobile-api", trace_id="trace-2", minutes=5),
                span(
                    "span-cdn",
                    "cdn-edge",
                    trace_id="trace-2",
                    minutes=5,
                    parent_span_id="span-gateway",
                ),
            ),
        )
        service = RcaService(repository(errors=[_trace_error(), outro]))

        dependencies = service.topology_health(window())["dependencies"]
        edges = {(edge["source"], edge["target"]) for edge in dependencies}

        self.assertEqual(edges, {("gateway", "cdn-edge"), ("mobile-api", "cdn-edge")})

    def test_topology_without_spans_is_empty_and_healthy(self):
        topology = RcaService(repository()).topology_health(window())

        self.assertEqual(topology["services"], [])
        self.assertEqual(topology["status"], "healthy")


class FingerprintQueryTests(unittest.TestCase):
    def setUp(self):
        self.store = repository(
            errors=[
                error("session-1", minutes=1, message="Timeout after 3500 ms"),
                error("session-2", minutes=2, message="Timeout after 120 ms"),
                error("session-3", minutes=3, error_code="DRM_LICENSE", message="licença expirada"),
            ]
        )
        self.service = RcaService(self.store)

    def test_recurring_patterns_are_grouped(self):
        result = self.service.fingerprints(window())

        self.assertEqual(result["total_fingerprints"], 2)
        self.assertEqual(result["fingerprints"][0]["occurrences"], 2)
        self.assertEqual(result["fingerprints"][0]["affected_sessions"], 2)
        self.assertEqual(result["fingerprints"][0]["pattern"], "timeout after <num> ms")

    def test_details_describe_the_impact_radius(self):
        fingerprint = self.service.fingerprints(window())["fingerprints"][0]["fingerprint_id"]

        details = self.service.fingerprint_details(window(), fingerprint)

        self.assertEqual(details["fingerprint_id"], fingerprint)
        self.assertEqual(details["impact_radius"]["sessions"], 2)
        self.assertAlmostEqual(details["impact_radius"]["share_of_errors"], 2 / 3, places=3)
        self.assertEqual(details["affected_services"][0]["service"], "playback-api")

    def test_unknown_fingerprint_is_not_found(self):
        with self.assertRaises(ResourceNotFoundError):
            self.service.fingerprint_details(window(), "0000deadbeef")


class TraceTests(unittest.TestCase):
    def setUp(self):
        self.service = RcaService(
            repository(
                events=[event(minutes=0, trace_id="trace-2")],
                errors=[_trace_error(session_id="session-1")],
            )
        )

    def test_waterfall_exposes_offsets_and_depth(self):
        trace = self.service.trace("trace-1")

        self.assertEqual(trace["status"], "error")
        self.assertEqual(trace["duration_ms"], 300.0)
        self.assertEqual(trace["sessions"], ["session-1"])
        self.assertEqual(
            [(span["span_id"], span["offset_ms"], span["depth"]) for span in trace["spans"]],
            [("span-gateway", 0.0, 0), ("span-cdn", 100.0, 1)],
        )

    def test_errors_of_the_trace_are_listed(self):
        trace = self.service.trace("trace-1")

        self.assertEqual(len(trace["errors"]), 1)
        self.assertEqual(trace["errors"][0]["error_code"], "PLAYER_TIMEOUT")

    def test_trace_without_spans_is_still_returned(self):
        trace = self.service.trace("trace-2")

        self.assertEqual(trace["span_count"], 0)
        self.assertEqual(trace["status"], "ok")

    def test_unknown_trace_is_not_found(self):
        with self.assertRaises(ResourceNotFoundError):
            self.service.trace("trace-inexistente")


class CorrelationTests(unittest.TestCase):
    def _correlations(self, errors, **options):
        service = RcaService(repository(errors=errors))
        return service.correlations(
            window(0, 60), interval=timedelta(minutes=10), limit=50, **options
        )

    def test_codes_that_spike_together_are_correlated(self):
        errors = []
        for minute in (1, 2, 3, 51, 52, 53):
            errors.append(error(minutes=minute, error_code="CDN_5XX", module="cdn"))
            errors.append(error(minutes=minute, error_code="PLAYER_TIMEOUT", module="player"))

        result = self._correlations(errors)
        pair = next(
            item
            for item in result["correlations"]
            if {item["source"]["value"], item["target"]["value"]} == {"CDN_5XX", "PLAYER_TIMEOUT"}
            and item["source"]["dimension"] == "error_code"
        )

        self.assertEqual(pair["coefficient"], 1.0)
        self.assertEqual(pair["strength"], "strong")
        self.assertEqual(result["buckets"], 6)

    def test_uncorrelated_series_are_left_out(self):
        errors = [error(minutes=minute, error_code="CDN_5XX", module="cdn") for minute in (1, 2, 3)]
        errors += [
            error(minutes=minute, error_code="DRM_LICENSE", module="drm") for minute in (31, 41, 51)
        ]

        result = self._correlations(errors)
        codes = [
            {item["source"]["value"], item["target"]["value"]} for item in result["correlations"]
        ]

        self.assertNotIn({"CDN_5XX", "DRM_LICENSE"}, codes)

    def test_series_below_the_minimum_volume_are_ignored(self):
        errors = [
            error(minutes=1, error_code="CDN_5XX"),
            error(minutes=2, error_code="DRM_LICENSE"),
        ]

        self.assertEqual(self._correlations(errors)["correlations"], [])


if __name__ == "__main__":
    unittest.main()
