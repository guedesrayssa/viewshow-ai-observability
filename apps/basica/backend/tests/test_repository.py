"""Testes do repositório em memória de telemetria."""

from __future__ import annotations

import unittest
from datetime import timedelta

from app.repositories import InMemoryTelemetryRepository
from tests.factories import at, event
from tests.repository_contract import TelemetryRepositoryContract


class InMemoryRepositoryContractTests(TelemetryRepositoryContract, unittest.TestCase):
    def make_repository(self) -> InMemoryTelemetryRepository:
        return InMemoryTelemetryRepository()


class InMemoryRepositoryTests(unittest.TestCase):
    """Comportamentos específicos do armazenamento em memória."""

    def test_retention_drops_records_older_than_the_newest_one(self):
        store = InMemoryTelemetryRepository(retention=timedelta(minutes=10))

        store.add_events([event(minutes=0), event(minutes=5)])
        store.add_events([event(minutes=20)])

        self.assertEqual([record.occurred_at for record in store.events()], [at(20)])

    def test_max_records_keeps_the_most_recent(self):
        store = InMemoryTelemetryRepository(max_records=2)

        store.add_events([event(minutes=1), event(minutes=2), event(minutes=3)])

        self.assertEqual([record.occurred_at for record in store.events()], [at(2), at(3)])

    def test_trace_index_forgets_records_dropped_by_retention(self):
        store = InMemoryTelemetryRepository(retention=timedelta(minutes=10))
        store.add_events([event(minutes=0, trace_id="trace-antigo")])

        store.add_events([event(minutes=30, trace_id="trace-novo")])

        self.assertEqual(store.records_for_trace("trace-antigo"), ([], []))
        self.assertEqual(len(store.records_for_trace("trace-novo")[0]), 1)
        self.assertEqual(store.stats()["traces"], 1)

    def test_trace_index_forgets_records_that_arrive_already_expired(self):
        store = InMemoryTelemetryRepository(retention=timedelta(minutes=10))
        store.add_events([event(minutes=30, trace_id="trace-novo")])

        store.add_events([event(minutes=0, trace_id="trace-atrasado")])

        self.assertEqual(store.records_for_trace("trace-atrasado"), ([], []))
        self.assertEqual(store.stats()["traces"], 1)


if __name__ == "__main__":
    unittest.main()
