"""Testes do serviço de ingestão de telemetria."""

from __future__ import annotations

import unittest

from app.errors import PayloadTooLargeError, UnprocessablePayloadError, ValidationError
from app.repositories import InMemoryTelemetryRepository
from app.services.ingestion import TelemetryIngestionService
from tests.factories import BASE_TIME, at


class IngestionServiceTests(unittest.TestCase):
    def setUp(self):
        self.repository = InMemoryTelemetryRepository()
        self.service = TelemetryIngestionService(
            self.repository, max_batch_size=3, clock=lambda: BASE_TIME
        )

    def test_accepts_a_single_object(self):
        result = self.service.ingest_events({"session_id": "session-1"})

        self.assertEqual((result.received, result.accepted), (1, 1))
        self.assertEqual(result.rejected, ())
        self.assertEqual(len(self.repository.events()), 1)

    def test_accepts_a_batch(self):
        result = self.service.ingest_heartbeats(
            [{"session_id": "session-1"}, {"session_id": "session-2"}]
        )

        self.assertEqual(result.accepted, 2)
        self.assertEqual(len(self.repository.heartbeats()), 2)

    def test_missing_timestamp_falls_back_to_the_ingestion_clock(self):
        self.service.ingest_events({"session_id": "session-1"})

        self.assertEqual(self.repository.events()[0].occurred_at, BASE_TIME)

    def test_parses_the_full_event_payload(self):
        self.service.ingest_events(
            {
                "session_id": "session-1",
                "event_type": "PLAYBACK_START",
                "timestamp": "2026-08-11T12:05:00Z",
                "content_id": "movie-42",
                "startup_time_ms": 1500,
                "rebuffer_duration_ms": 250,
                "rebuffer_count": 2,
                "playback_duration_ms": 120000,
                "bitrate_kbps": "5200",
                "device": {"model": "tv-box-a", "os": "android", "app_version": "2.4.0"},
                "network": {"isp": "isp-alpha", "cdn": "cdn-1", "connection_type": "wifi"},
            }
        )

        stored = self.repository.events()[0]
        self.assertEqual(stored.event_type, "playback_start")
        self.assertEqual(stored.occurred_at, at(5))
        self.assertEqual(stored.startup_time_ms, 1500.0)
        self.assertEqual(stored.rebuffer_count, 2)
        self.assertEqual(stored.bitrate_kbps, 5200.0)
        self.assertEqual(stored.device.model, "tv-box-a")
        self.assertEqual(stored.device.os_version, "unknown")
        self.assertEqual(stored.network.cdn, "cdn-1")

    def test_error_code_is_required_and_normalized(self):
        result = self.service.ingest_errors(
            [{"session_id": "session-1", "error_code": "player_timeout"}, {"session_id": "s2"}]
        )

        self.assertEqual(result.accepted, 1)
        self.assertEqual(self.repository.errors()[0].error_code, "PLAYER_TIMEOUT")
        self.assertEqual(result.rejected[0].index, 1)
        self.assertIn("error_code", result.rejected[0].reason)

    def test_partial_batch_keeps_the_valid_records(self):
        result = self.service.ingest_events(
            [{"session_id": "session-1"}, {"session_id": ""}, {"session_id": "session-3"}]
        )

        self.assertEqual((result.received, result.accepted), (3, 2))
        self.assertEqual([item.index for item in result.rejected], [1])
        self.assertEqual(len(self.repository.events()), 2)

    def test_batch_without_any_valid_record_is_unprocessable(self):
        with self.assertRaises(UnprocessablePayloadError) as raised:
            self.service.ingest_events([{"foo": "bar"}])

        self.assertEqual(raised.exception.status_code, 422)
        self.assertEqual(raised.exception.details[0]["index"], 0)
        self.assertEqual(len(self.repository.events()), 0)

    def test_rejects_bodies_that_are_not_json_objects(self):
        for payload in (None, "texto", 42, [1, 2]):
            with self.assertRaises(ValidationError):
                self.service.ingest_events(payload)

    def test_rejects_an_empty_batch(self):
        with self.assertRaises(ValidationError):
            self.service.ingest_events([])

    def test_rejects_batches_above_the_limit(self):
        with self.assertRaises(PayloadTooLargeError):
            self.service.ingest_events([{"session_id": f"session-{index}"} for index in range(4)])

    def test_rejects_fields_with_the_wrong_type(self):
        service = TelemetryIngestionService(self.repository, clock=lambda: BASE_TIME)

        result = service.ingest_events(
            [
                {"session_id": "session-1", "bitrate_kbps": "muito"},
                {"session_id": "session-2", "startup_time_ms": -10},
                {"session_id": "session-3", "device": "tv-box-a"},
                {"session_id": "session-4", "timestamp": "ontem"},
                {"session_id": "session-5", "rebuffer_count": 1.5},
                {"session_id": "session-6"},
            ]
        )

        self.assertEqual(result.accepted, 1)
        self.assertEqual([item.index for item in result.rejected], [0, 1, 2, 3, 4])

    def test_rejects_timestamps_far_in_the_future(self):
        # A retenção é medida a partir do registro mais recente: aceitar uma
        # data absurda no futuro expiraria toda a base já ingerida.
        self.service.ingest_events({"session_id": "session-1"})

        with self.assertRaises(UnprocessablePayloadError):
            self.service.ingest_events(
                {"session_id": "session-2", "timestamp": "2099-01-01T00:00:00Z"}
            )

        self.assertEqual(len(self.repository.events()), 1)

    def test_tolerates_small_clock_skew(self):
        self.service.ingest_events({"session_id": "session-1", "timestamp": "2026-08-11T12:01:00Z"})

        self.assertEqual(self.repository.events()[0].occurred_at, at(1))

    def test_boolean_is_not_accepted_as_a_number(self):
        with self.assertRaises(UnprocessablePayloadError):
            self.service.ingest_events([{"session_id": "session-1", "bitrate_kbps": True}])

    def test_spans_require_a_trace_id(self):
        with self.assertRaises(UnprocessablePayloadError):
            self.service.ingest_errors(
                [
                    {
                        "session_id": "session-1",
                        "error_code": "CDN_5XX",
                        "spans": [{"service": "cdn-edge"}],
                    }
                ]
            )

    def test_spans_are_stored_with_generated_identifiers(self):
        self.service.ingest_errors(
            {
                "session_id": "session-1",
                "error_code": "CDN_5XX",
                "trace_id": "trace-1",
                "spans": [
                    {"service": "gateway", "operation": "GET /play", "duration_ms": 120},
                    {"service": "cdn-edge", "status": "error", "duration_ms": 90},
                ],
            }
        )

        spans = self.repository.errors()[0].spans
        self.assertEqual([item.span_id for item in spans], ["trace-1-0", "trace-1-1"])
        self.assertTrue(spans[1].failed)

    def test_rejects_unknown_span_status(self):
        with self.assertRaises(UnprocessablePayloadError):
            self.service.ingest_errors(
                {
                    "session_id": "session-1",
                    "error_code": "CDN_5XX",
                    "trace_id": "trace-1",
                    "spans": [{"service": "cdn-edge", "status": "explodiu"}],
                }
            )


if __name__ == "__main__":
    unittest.main()
