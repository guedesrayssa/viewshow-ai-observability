"""Testes dos serviços analíticos: QoE, erros, segmentação e tempo real."""

from __future__ import annotations

import unittest
from datetime import timedelta

from app.errors import ResourceNotFoundError, ValidationError
from app.services.breakdown import BreakdownService
from app.services.error_analytics import ErrorAnalyticsService
from app.services.qoe import QoeService
from app.services.realtime import AlertThresholds, RealtimeService
from tests.factories import (
    BASE_TIME,
    device,
    error,
    event,
    heartbeat,
    network,
    repository,
    window,
)


class QoeServiceTests(unittest.TestCase):
    def test_summarize_computes_rebuffer_rate_over_total_viewing_time(self):
        metrics = QoeService.summarize(
            [
                event(playback_duration_ms=60_000, rebuffer_duration_ms=6_000, rebuffer_count=1),
                event(playback_duration_ms=54_000, rebuffer_duration_ms=0),
            ]
        )

        self.assertAlmostEqual(metrics.rebuffer_rate, 6_000 / 120_000)
        self.assertEqual(metrics.rebuffer_count, 1)
        self.assertAlmostEqual(metrics.playback_hours, 114_000 / 3_600_000)

    def test_summarize_weights_bitrate_by_playback_duration(self):
        metrics = QoeService.summarize(
            [
                event(bitrate_kbps=1_000, playback_duration_ms=60_000),
                event(bitrate_kbps=4_000, playback_duration_ms=20_000),
            ]
        )

        self.assertAlmostEqual(metrics.average_bitrate_kbps, 1_750.0)

    def test_summarize_falls_back_to_a_simple_average_without_playback_time(self):
        metrics = QoeService.summarize(
            [
                event(bitrate_kbps=1_000, playback_duration_ms=0),
                event(bitrate_kbps=3_000, playback_duration_ms=0),
            ]
        )

        self.assertAlmostEqual(metrics.average_bitrate_kbps, 2_000.0)

    def test_summarize_reports_startup_percentiles(self):
        metrics = QoeService.summarize(
            [event(startup_time_ms=value) for value in (1_000, 2_000, 3_000, 4_000)]
            + [event(startup_time_ms=None)]
        )

        self.assertEqual(metrics.startup_samples, 4)
        self.assertEqual(metrics.startup_p50_ms, 2_500.0)
        self.assertEqual(metrics.startup_avg_ms, 2_500.0)

    def test_metrics_without_samples_are_null_instead_of_zero(self):
        service = QoeService(repository())

        metrics = service.metrics(window())["metrics"]

        self.assertEqual(metrics["events"], 0)
        self.assertIsNone(metrics["startup_time_ms"]["p95"])
        self.assertIsNone(metrics["average_bitrate_kbps"])
        self.assertIsNone(metrics["rebuffer"]["rate"])

    def test_timeseries_splits_the_window_into_points(self):
        service = QoeService(
            repository(events=[event(minutes=1), event(minutes=12), event(minutes=25)])
        )

        result = service.timeseries(window(0, 30), timedelta(minutes=10))

        self.assertEqual(result["interval_seconds"], 600)
        self.assertEqual([point["metrics"]["events"] for point in result["points"]], [1, 1, 1])


class ErrorAnalyticsServiceTests(unittest.TestCase):
    def setUp(self):
        self.store = repository(
            events=[event("session-1", minutes=1), event("session-2", minutes=2)],
            errors=[
                error("session-1", "PLAYER_TIMEOUT", minutes=1, fatal=True),
                error("session-1", "PLAYER_TIMEOUT", minutes=2),
                error("session-2", "CDN_5XX", minutes=3, module="cdn"),
            ],
            heartbeats=[heartbeat("session-3", minutes=1)],
        )
        self.service = ErrorAnalyticsService(self.store)

    def test_summary_counts_errors_and_sessions(self):
        summary = self.service.summarize(window())

        self.assertEqual(summary.total, 3)
        self.assertEqual(summary.fatal, 1)
        self.assertEqual(summary.unique_codes, 2)
        self.assertEqual(summary.affected_sessions, 2)
        self.assertEqual(summary.total_sessions, 3)
        self.assertAlmostEqual(summary.error_rate, 1.5)

    def test_crash_free_rate_considers_only_fatal_errors(self):
        summary = self.service.summarize(window())

        # Uma das três sessões observadas sofreu uma falha fatal.
        self.assertAlmostEqual(summary.crash_free_rate, 2 / 3)

    def test_rates_without_a_base_are_null_instead_of_zero(self):
        empty = ErrorAnalyticsService(repository()).summarize(window())

        self.assertIsNone(empty.crash_free_rate)
        self.assertIsNone(empty.error_rate)

    def test_error_rate_is_null_when_there_are_errors_but_no_events(self):
        # Cinco erros sem nenhuma reprodução não formam uma taxa de 0%.
        summary = ErrorAnalyticsService(repository(errors=[error(minutes=1)])).summarize(window())

        self.assertEqual(summary.total, 1)
        self.assertIsNone(summary.error_rate)

    def test_top_ranks_by_occurrences(self):
        ranking = self.service.top(window())["errors"]

        self.assertEqual([entry["error_code"] for entry in ranking], ["PLAYER_TIMEOUT", "CDN_5XX"])
        self.assertEqual(ranking[0]["occurrences"], 2)
        self.assertEqual(ranking[0]["affected_sessions"], 1)
        self.assertEqual(ranking[0]["fatal_occurrences"], 1)
        self.assertEqual(ranking[0]["top_module"], "player")
        self.assertAlmostEqual(ranking[0]["share"], 2 / 3, places=3)

    def test_top_honours_the_limit(self):
        self.assertEqual(len(self.service.top(window(), limit=1)["errors"]), 1)

    def test_details_describe_impact_and_timeline(self):
        details = self.service.details(
            window(0, 30), "player_timeout", interval=timedelta(minutes=10)
        )

        self.assertEqual(details["error_code"], "PLAYER_TIMEOUT")
        self.assertEqual(details["occurrences"], 2)
        self.assertEqual(details["affected_sessions"], 1)
        self.assertEqual(details["first_seen"], "2026-08-11T12:01:00Z")
        self.assertEqual(details["breakdown"]["modules"][0]["module"], "player")
        self.assertEqual(sum(point["occurrences"] for point in details["timeline"]), 2)

    def test_details_of_an_unknown_code_are_not_found(self):
        with self.assertRaises(ResourceNotFoundError):
            self.service.details(window(), "DESCONHECIDO", interval=timedelta(minutes=10))


class BreakdownServiceTests(unittest.TestCase):
    def setUp(self):
        self.store = repository(
            events=[
                event("session-1", minutes=1, device=device(model="tv-box-a")),
                event("session-2", minutes=2, device=device(model="tv-box-a")),
                event("session-3", minutes=3, device=device(model="phone-b")),
            ],
            errors=[
                error("session-1", minutes=1, device=device(model="tv-box-a")),
                error(
                    "session-4",
                    minutes=2,
                    device=device(model="phone-b"),
                    network=network(cdn="cdn-2"),
                ),
            ],
        )
        self.service = BreakdownService(self.store, QoeService(self.store))

    def test_devices_are_grouped_and_ordered_by_volume(self):
        groups = self.service.devices(window())["breakdown"]

        self.assertEqual([group["value"] for group in groups], ["tv-box-a", "phone-b"])
        self.assertEqual(groups[0]["events"], 2)
        self.assertEqual(groups[0]["errors"], 1)
        self.assertAlmostEqual(groups[0]["error_rate"], 0.5)
        self.assertAlmostEqual(groups[0]["traffic_share"], 2 / 3, places=3)

    def test_groups_without_events_still_appear(self):
        groups = self.service.network(window())["breakdown"]

        self.assertEqual({group["value"] for group in groups}, {"cdn-1", "cdn-2"})
        empty = next(group for group in groups if group["value"] == "cdn-2")
        self.assertEqual((empty["events"], empty["errors"]), (0, 1))
        self.assertIsNone(empty["error_rate"])

    def test_dimension_changes_the_grouping_key(self):
        groups = self.service.devices(window(), dimension="app_version")["breakdown"]

        self.assertEqual([group["value"] for group in groups], ["2.4.0"])

    def test_unknown_dimension_is_rejected(self):
        with self.assertRaises(ValidationError):
            self.service.devices(window(), dimension="cor")


class RealtimeServiceTests(unittest.TestCase):
    def _service(self, store, **thresholds):
        return RealtimeService(
            store,
            QoeService(store),
            ErrorAnalyticsService(store),
            heartbeat_ttl=timedelta(minutes=2),
            thresholds=AlertThresholds(min_samples=1, **thresholds),
            clock=lambda: BASE_TIME,
        )

    def test_ccu_counts_only_sessions_with_a_recent_heartbeat(self):
        store = repository(
            heartbeats=[
                heartbeat("session-1", minutes=1),
                heartbeat("session-2", minutes=9),
                heartbeat("session-2", minutes=10),
            ]
        )

        overview = self._service(store).overview(window(0, 10))

        self.assertEqual(overview["ccu"], 1)
        self.assertEqual(overview["active_sessions"], 2)

    def test_overview_reports_volume_and_error_rate(self):
        store = repository(
            events=[event(minutes=1), event(minutes=2)],
            errors=[error(minutes=3, fatal=True)],
        )

        overview = self._service(store).overview(window(0, 10))

        self.assertEqual(overview["events"]["total"], 2)
        self.assertEqual(
            overview["errors"], {"total": 1, "fatal": 1, "per_minute": 0.1, "rate": 0.5}
        )
        self.assertEqual(overview["generated_at"], "2026-08-11T12:00:00Z")

    def test_rate_per_minute_follows_the_real_window_length(self):
        store = repository(events=[event(minutes=0), event(minutes=0.25)])

        overview = self._service(store).overview(window(0, 0.5))

        # Dois eventos em trinta segundos são quatro por minuto, não dois.
        self.assertEqual(overview["events"]["per_minute"], 4.0)

    def test_alerts_flag_a_critical_error_rate(self):
        store = repository(events=[event(minutes=1)], errors=[error(minutes=1)])

        alerts = self._service(store).alerts(window(0, 30), interval=timedelta(minutes=10))
        by_id = {alert["id"]: alert for alert in alerts["alerts"]}

        self.assertEqual(by_id["error_rate"]["severity"], "critical")
        self.assertEqual(by_id["error_rate"]["value"], 1.0)

    def test_alerts_are_silent_on_a_healthy_platform(self):
        store = repository(events=[event(minutes=index) for index in range(10)])

        alerts = self._service(store).alerts(window(0, 30), interval=timedelta(minutes=10))

        self.assertEqual(alerts["alerts"], [])

    def test_alerts_detect_an_error_spike_in_the_last_interval(self):
        store = repository(
            events=[event(minutes=index) for index in range(30)],
            errors=[error(minutes=25 + index / 10, error_code="CDN_5XX") for index in range(6)],
        )

        alerts = self._service(store).alerts(window(0, 30), interval=timedelta(minutes=10))
        spikes = [alert for alert in alerts["alerts"] if alert["type"] == "anomaly"]

        self.assertEqual(len(spikes), 1)
        self.assertEqual(spikes[0]["scope"], "CDN_5XX")
        self.assertEqual(spikes[0]["value"], 6.0)

    def test_alerts_ignore_samples_below_the_minimum(self):
        store = repository(events=[event(minutes=1)], errors=[error(minutes=1)])
        service = RealtimeService(
            store,
            QoeService(store),
            ErrorAnalyticsService(store),
            thresholds=AlertThresholds(min_samples=50),
            clock=lambda: BASE_TIME,
        )

        alerts = service.alerts(window(0, 30), interval=timedelta(minutes=10))

        self.assertEqual(alerts["alerts"], [])


if __name__ == "__main__":
    unittest.main()
