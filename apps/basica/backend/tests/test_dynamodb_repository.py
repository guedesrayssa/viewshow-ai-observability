"""Testes do repositório DynamoDB.

O contrato roda contra a emulação do `moto`, com o mesmo esquema de tabela que
vai para a AWS. Os testes seguintes cobrem o que é específico do DynamoDB:
formato das chaves, TTL, consultas que cruzam buckets, paginação e o reenvio de
itens não processados.
"""

from __future__ import annotations

import unittest
from datetime import timedelta
from unittest import mock

from app.domain.time_window import TimeWindow
from tests.factories import at, error, event, heartbeat
from tests.repository_contract import TelemetryRepositoryContract

try:
    import boto3
    from moto import mock_aws

    from app.repositories.dynamodb import (
        _MAX_WRITE_ATTEMPTS,
        TRACE_INDEX,
        DynamoDbTelemetryRepository,
        create_table,
    )

    DEPENDENCIES_AVAILABLE = True
except ImportError:  # pragma: no cover - ambiente sem as dependências de dev
    DEPENDENCIES_AVAILABLE = False

REQUIRES_AWS_MOCK = unittest.skipUnless(
    DEPENDENCIES_AVAILABLE, "requer boto3 e moto (pip install -r requirements-dev.txt)"
)

TABLE = "telemetry-test"
REGION = "us-east-1"
FAKE_CREDENTIALS = {
    "AWS_ACCESS_KEY_ID": "testing",
    "AWS_SECRET_ACCESS_KEY": "testing",
    "AWS_SESSION_TOKEN": "testing",
    "AWS_DEFAULT_REGION": REGION,
}


class DynamoDbTestCase(unittest.TestCase):
    """Sobe uma tabela emulada antes de cada teste."""

    bucket_seconds = 3_600
    retention = timedelta(hours=24)

    def setUp(self):
        credentials = mock.patch.dict("os.environ", FAKE_CREDENTIALS)
        credentials.start()
        self.addCleanup(credentials.stop)

        self.aws = mock_aws()
        self.aws.start()
        self.addCleanup(self.aws.stop)

        self.client = boto3.client("dynamodb", region_name=REGION)
        create_table(self.client, TABLE)
        super().setUp()

    def make_repository(self) -> DynamoDbTelemetryRepository:
        return DynamoDbTelemetryRepository(
            table_name=TABLE,
            client=self.client,
            retention=self.retention,
            bucket_seconds=self.bucket_seconds,
        )

    def raw_items(self) -> list[dict]:
        return self.client.scan(TableName=TABLE)["Items"]


@REQUIRES_AWS_MOCK
class DynamoDbRepositoryContractTests(TelemetryRepositoryContract, DynamoDbTestCase):
    """O mesmo contrato exigido do backend em memória."""


@REQUIRES_AWS_MOCK
class DynamoDbTableCreationTests(DynamoDbTestCase):
    def test_table_has_the_trace_index_and_ttl(self):
        description = self.client.describe_table(TableName=TABLE)["Table"]
        indexes = {index["IndexName"] for index in description["GlobalSecondaryIndexes"]}
        ttl = self.client.describe_time_to_live(TableName=TABLE)["TimeToLiveDescription"]

        self.assertEqual(indexes, {TRACE_INDEX})
        self.assertEqual(ttl["TimeToLiveStatus"], "ENABLED")
        self.assertEqual(ttl["AttributeName"], "expires_at")

    def test_creating_an_existing_table_is_a_no_op(self):
        self.assertFalse(create_table(self.client, TABLE))


@REQUIRES_AWS_MOCK
class DynamoDbItemLayoutTests(DynamoDbTestCase):
    def test_keys_group_records_by_type_and_time_bucket(self):
        self.make_repository().add_events([event(minutes=5)])

        item = self.raw_items()[0]

        self.assertEqual(item["pk"]["S"], "EVENT#2026-08-11T12:00:00Z")
        self.assertTrue(item["sk"]["S"].startswith("2026-08-11T12:05:00.000000Z#"))
        self.assertEqual(item["record_type"]["S"], "EVENT")

    def test_expiry_follows_the_configured_retention(self):
        self.make_repository().add_events([event(minutes=0)])

        expires_at = int(self.raw_items()[0]["expires_at"]["N"])

        self.assertEqual(expires_at, int((at(0) + self.retention).timestamp()))

    def test_records_without_a_trace_stay_out_of_the_sparse_index(self):
        store = self.make_repository()
        store.add_events([event(minutes=1)])
        store.add_heartbeats([heartbeat(minutes=1)])

        with_trace = [item for item in self.raw_items() if "trace_id" in item]
        indexed = self.client.scan(TableName=TABLE, IndexName=TRACE_INDEX)["Items"]

        self.assertEqual(with_trace, [])
        self.assertEqual(indexed, [])


@REQUIRES_AWS_MOCK
class DynamoDbTimeQueryTests(DynamoDbTestCase):
    bucket_seconds = 60  # buckets curtos para forçar consultas em vários deles

    def test_window_spanning_many_buckets_returns_everything_in_order(self):
        store = self.make_repository()
        store.add_events([event(minutes=minute) for minute in range(10)])

        selected = store.events(TimeWindow(at(2), at(7)))

        self.assertEqual(
            [record.occurred_at for record in selected], [at(minute) for minute in range(2, 8)]
        )

    def test_sub_second_records_are_ordered_chronologically(self):
        # A chave de ordenação precisa ter largura fixa: sem microssegundos
        # sempre presentes, `12:00:00.5Z` viria antes de `12:00:00Z`.
        store = self.make_repository()
        store.add_events(
            [
                event("session-meio", seconds=0.5),
                event("session-inicio", seconds=0),
                event("session-fim", seconds=0.9),
            ]
        )

        sessions = [record.session_id for record in store.events()]

        self.assertEqual(sessions, ["session-inicio", "session-meio", "session-fim"])

    def test_window_bound_respects_fractions_of_a_second(self):
        store = self.make_repository()
        store.add_events([event("antes", seconds=0.1), event("depois", seconds=0.9)])

        selected = store.events(TimeWindow(at(0), at(seconds=0.5)))

        self.assertEqual([record.session_id for record in selected], ["antes"])

    def test_errors_and_events_of_the_same_trace_are_found_together(self):
        store = self.make_repository()
        store.add_events([event(minutes=1, trace_id="trace-1")])
        store.add_errors([error(minutes=90, trace_id="trace-1")])

        events, errors = store.records_for_trace("trace-1")

        # O índice ignora a janela: o erro está a mais de um bucket de distância.
        self.assertEqual(len(events), 1)
        self.assertEqual(len(errors), 1)


class _StubClient:
    """Cliente mínimo para exercitar paginação e reenvio de lotes."""

    def __init__(self, query_pages=None, unprocessed_rounds=0):
        self.query_pages = list(query_pages or [])
        self.unprocessed_rounds = unprocessed_rounds
        self.query_requests: list[dict] = []
        self.write_calls = 0

    def query(self, **request):
        self.query_requests.append(request)
        return self.query_pages[len(self.query_requests) - 1]

    def batch_write_item(self, RequestItems):  # noqa: N803 - assinatura do boto3
        self.write_calls += 1
        if self.write_calls <= self.unprocessed_rounds:
            table, requests = next(iter(RequestItems.items()))
            return {"UnprocessedItems": {table: requests[:1]}}
        return {"UnprocessedItems": {}}


@REQUIRES_AWS_MOCK
class DynamoDbPaginationTests(unittest.TestCase):
    def _item(self, session_id: str) -> dict:
        return {
            "record_type": {"S": "EVENT"},
            "session_id": {"S": session_id},
            "event_type": {"S": "playback"},
            "occurred_at": {"S": "2026-08-11T12:00:00Z"},
        }

    def test_every_page_is_read(self):
        client = _StubClient(
            query_pages=[
                {"Items": [self._item("s1")], "LastEvaluatedKey": {"pk": {"S": "EVENT#x"}}},
                {"Items": [self._item("s2")]},
            ]
        )
        store = DynamoDbTelemetryRepository(table_name=TABLE, client=client)

        events, _ = store.records_for_trace("trace-1")

        self.assertEqual([record.session_id for record in events], ["s1", "s2"])
        self.assertEqual(len(client.query_requests), 2)
        self.assertIn("ExclusiveStartKey", client.query_requests[1])


@REQUIRES_AWS_MOCK
class DynamoDbBatchWriteTests(unittest.TestCase):
    def test_unprocessed_items_are_sent_again(self):
        client = _StubClient(unprocessed_rounds=2)
        store = DynamoDbTelemetryRepository(table_name=TABLE, client=client)

        with mock.patch("app.repositories.dynamodb.time.sleep"):
            written = store.add_events([event(minutes=1), event(minutes=2)])

        self.assertEqual(written, 2)
        self.assertEqual(client.write_calls, 3)

    def test_giving_up_after_repeated_rejections_is_explicit(self):
        client = _StubClient(unprocessed_rounds=_MAX_WRITE_ATTEMPTS + 1)
        store = DynamoDbTelemetryRepository(table_name=TABLE, client=client)

        with mock.patch("app.repositories.dynamodb.time.sleep"):
            with self.assertRaises(RuntimeError):
                store.add_events([event(minutes=1)])

    def test_batches_respect_the_25_item_limit(self):
        client = _StubClient()
        store = DynamoDbTelemetryRepository(table_name=TABLE, client=client)

        store.add_events([event(f"session-{index}", minutes=index) for index in range(60)])

        self.assertEqual(client.write_calls, 3)


@REQUIRES_AWS_MOCK
class DynamoDbApplicationTests(DynamoDbTestCase):
    """A API completa servida a partir do DynamoDB, sem tocar em memória."""

    def setUp(self):
        super().setUp()
        from app import create_app

        self.client_http = create_app(
            {
                "TESTING": True,
                "TELEMETRY_BACKEND": "dynamodb",
                "DYNAMODB_TABLE": TABLE,
                "DYNAMODB_REGION": REGION,
            }
        ).test_client()

    def test_ingested_telemetry_feeds_the_dashboard(self):
        ingestion = self.client_http.post(
            "/v1/telemetry/errors",
            json={
                "session_id": "session-1",
                "error_code": "CDN_5XX",
                "message": "upstream 503 after 3500 ms",
                "module": "cdn",
                "trace_id": "trace-http",
                "fatal": True,
                "spans": [
                    {"span_id": "a", "service": "gateway", "duration_ms": 300},
                    {
                        "span_id": "b",
                        "parent_span_id": "a",
                        "service": "cdn-edge",
                        "duration_ms": 150,
                        "status": "error",
                    },
                ],
            },
        )
        self.assertEqual(ingestion.status_code, 202)

        summary = self.client_http.get("/v1/analytics/errors/summary").get_json()
        topology = self.client_http.get("/v1/analytics/rca/topology-health").get_json()
        trace = self.client_http.get("/v1/analytics/rca/traces/trace-http").get_json()

        self.assertEqual(summary["summary"]["total_errors"], 1)
        self.assertEqual(topology["dependencies"][0]["target"], "cdn-edge")
        self.assertEqual(trace["span_count"], 2)
        self.assertEqual(trace["errors"][0]["error_code"], "CDN_5XX")

    def test_the_application_reads_and_writes_only_dynamodb(self):
        self.client_http.post("/v1/telemetry/heartbeat", json={"session_id": "session-1"})

        overview = self.client_http.get("/v1/analytics/realtime/overview").get_json()

        self.assertEqual(overview["ccu"], 1)
        self.assertEqual(len(self.raw_items()), 1)


if __name__ == "__main__":
    unittest.main()
