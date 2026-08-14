"""Contrato comum a todas as implementações de `TelemetryRepository`.

Os mesmos testes rodam contra o backend em memória e contra o DynamoDB: é o que
garante que trocar o armazenamento não muda o comportamento visto pelos
serviços. Cada suíte concreta só precisa fornecer `make_repository()`.
"""

from __future__ import annotations

from app.domain.time_window import TimeWindow
from tests.factories import at, device, error, event, heartbeat, network, span


class TelemetryRepositoryContract:
    """Comportamentos exigidos de qualquer repositório de telemetria.

    A suíte concreta precisa definir `make_repository()`, devolvendo um
    repositório vazio. O método é deliberadamente ausente aqui para que a
    ordem de resolução das bases nunca esconda a implementação real.
    """

    def setUp(self):
        super().setUp()
        self.store = self.make_repository()

    def test_records_come_back_ordered_by_time(self):
        self.store.add_events([event(minutes=30), event(minutes=5), event(minutes=10)])

        moments = [record.occurred_at for record in self.store.events()]

        self.assertEqual(moments, [at(5), at(10), at(30)])

    def test_window_boundaries_are_inclusive(self):
        self.store.add_events(
            [event(minutes=0), event(minutes=5), event(minutes=10), event(minutes=15)]
        )

        selected = self.store.events(TimeWindow(at(5), at(10)))

        self.assertEqual([record.occurred_at for record in selected], [at(5), at(10)])

    def test_window_excludes_records_outside_it(self):
        self.store.add_errors([error(minutes=1), error(minutes=90)])

        selected = self.store.errors(TimeWindow(at(0), at(60)))

        self.assertEqual([record.occurred_at for record in selected], [at(1)])

    def test_collections_do_not_leak_into_each_other(self):
        self.store.add_events([event(minutes=1)])
        self.store.add_errors([error(minutes=1)])
        self.store.add_heartbeats([heartbeat(minutes=1), heartbeat(minutes=2)])

        self.assertEqual(len(self.store.events()), 1)
        self.assertEqual(len(self.store.errors()), 1)
        self.assertEqual(len(self.store.heartbeats()), 2)

    def test_reading_an_empty_collection_returns_an_empty_list(self):
        self.assertEqual(self.store.events(TimeWindow(at(0), at(10))), [])
        self.assertEqual(self.store.errors(), [])

    def test_event_survives_a_full_round_trip(self):
        original = event(
            "session-7",
            minutes=3,
            event_type="playback_start",
            content_id="filme-42",
            trace_id="trace-1",
            startup_time_ms=1837.5,
            rebuffer_duration_ms=1250.25,
            rebuffer_count=3,
            playback_duration_ms=123456.0,
            bitrate_kbps=4821.75,
            device=device(model="tv-box-b", os="tizen", os_version="7.0", app_version="3.1.4"),
            network=network(isp="isp-beta", cdn="cdn-2", connection_type="ethernet"),
            spans=(span("s1", "gateway", minutes=3, duration_ms=311.5),),
        )
        self.store.add_events([original])

        self.assertEqual(self.store.events()[0], original)

    def test_error_survives_a_full_round_trip(self):
        original = error(
            "session-8",
            "CDN_5XX",
            minutes=4,
            message="upstream 503 after 3500 ms",
            module="cdn",
            service="playback-api",
            fatal=True,
            content_id="filme-42",
            trace_id="trace-2",
            device=device(model="phone-c"),
            network=network(cdn="cdn-3"),
            spans=(
                span("s1", "gateway", trace_id="trace-2", minutes=4, duration_ms=90.5),
                span(
                    "s2",
                    "cdn-edge",
                    trace_id="trace-2",
                    minutes=4,
                    duration_ms=42.0,
                    status="error",
                    parent_span_id="s1",
                ),
            ),
        )
        self.store.add_errors([original])

        stored = self.store.errors()[0]
        self.assertEqual(stored, original)
        self.assertEqual(stored.fingerprint, original.fingerprint)

    def test_heartbeat_survives_a_full_round_trip(self):
        original = heartbeat("session-9", minutes=2, content_id="filme-7")
        self.store.add_heartbeats([original])

        self.assertEqual(self.store.heartbeats()[0], original)

    def test_records_for_trace_isolates_each_trace(self):
        self.store.add_events(
            [event(minutes=1, trace_id="trace-1"), event(minutes=2, trace_id="trace-2")]
        )
        self.store.add_errors([error(minutes=3, trace_id="trace-1")])

        events, errors = self.store.records_for_trace("trace-1")

        self.assertEqual([record.occurred_at for record in events], [at(1)])
        self.assertEqual([record.occurred_at for record in errors], [at(3)])

    def test_records_for_an_unknown_trace_are_empty(self):
        self.store.add_events([event(minutes=1, trace_id="trace-1")])

        self.assertEqual(self.store.records_for_trace("trace-9"), ([], []))

    def test_records_without_a_trace_never_appear_in_the_trace_lookup(self):
        self.store.add_events([event(minutes=1)])
        self.store.add_heartbeats([heartbeat(minutes=1)])

        self.assertEqual(self.store.records_for_trace("trace-1"), ([], []))

    def test_spans_are_collected_from_events_and_errors_in_order(self):
        self.store.add_events(
            [event(minutes=1, trace_id="trace-1", spans=(span("s2", "cdn", minutes=2),))]
        )
        self.store.add_errors(
            [error(minutes=1, trace_id="trace-1", spans=(span("s1", "gateway", minutes=1),))]
        )

        self.assertEqual([item.span_id for item in self.store.spans()], ["s1", "s2"])

    def test_stats_count_each_collection(self):
        self.store.add_events([event(minutes=1), event(minutes=2)])
        self.store.add_errors([error(minutes=1)])

        stats = self.store.stats()

        self.assertEqual(stats["events"], 2)
        self.assertEqual(stats["errors"], 1)
        self.assertEqual(stats["heartbeats"], 0)

    def test_clear_removes_every_record(self):
        self.store.add_events([event(minutes=1, trace_id="trace-1")])
        self.store.add_errors([error(minutes=1)])
        self.store.add_heartbeats([heartbeat(minutes=1)])

        self.store.clear()

        self.assertEqual(self.store.events(), [])
        self.assertEqual(self.store.errors(), [])
        self.assertEqual(self.store.heartbeats(), [])
        self.assertEqual(self.store.records_for_trace("trace-1"), ([], []))

    def test_a_large_batch_is_written_whole(self):
        # Acima do limite de 25 itens por lote do DynamoDB, para exercitar o
        # fatiamento e o reenvio de pendências.
        self.store.add_events([event(f"session-{index}", minutes=index) for index in range(60)])

        self.assertEqual(len(self.store.events()), 60)
