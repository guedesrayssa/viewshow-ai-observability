"""Verifica a gravação em lote dos fatos que o worker de análise consulta."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import boto3  # type: ignore[import-untyped]
import pytest
from moto import mock_aws

from adapters.analysis_catalog import load_fact_catalog
from adapters.dynamodb.analysis_facts import DynamoAnalysisFactSink, UnprocessedFactsExhausted
from adapters.dynamodb.codec import serialize_item
from domain.analysis_facts import AnalysisFactCatalog, facts_from_records
from tests.analysis_fact_support import (
    BUCKET_15M,
    DATASET_VERSION,
    PILOT_CATALOG,
    channel_records,
    live_active_row,
    normalized,
    pilot_scopes,
)

TABLE = "operacional"


class RecordingClient:
    """Cliente falso que registra os lotes e devolve respostas programadas."""

    def __init__(self, unprocessed_responses: list[Mapping[str, object]] | None = None) -> None:
        self.calls: list[Mapping[str, Any]] = []
        self._responses = list(unprocessed_responses or [])

    def batch_write_item(self, **kwargs: object) -> Mapping[str, object]:
        self.calls.append(kwargs)  # type: ignore[arg-type]
        return self._responses.pop(0) if self._responses else {}


@pytest.fixture(scope="module")
def catalog() -> AnalysisFactCatalog:
    return load_fact_catalog(str(PILOT_CATALOG))


def many_records(count: int) -> list[Any]:
    """Um bucket de 15 minutos por registro, cada um com os oito fatos do dataset ativo."""
    channel = pilot_scopes()[0]["entity"]
    return [
        normalized("live_active_15min", live_active_row(channel, BUCKET_15M - index * 900_000))
        for index in range(count)
    ]


def sink_for(client: object, catalog: AnalysisFactCatalog, **kwargs: Any) -> DynamoAnalysisFactSink:
    return DynamoAnalysisFactSink(
        client,  # type: ignore[arg-type]
        TABLE,
        catalog,
        sleep=lambda _seconds: None,
        jitter=lambda: 0.0,
        **kwargs,
    )


def test_facts_are_written_in_batches_of_at_most_25_items(catalog: AnalysisFactCatalog) -> None:
    client = RecordingClient()
    written = sink_for(client, catalog).write(many_records(8), DATASET_VERSION)

    assert written == 64
    sizes = [len(call["RequestItems"][TABLE]) for call in client.calls]
    assert sizes == [25, 25, 14]
    assert all(
        "PutRequest" in request for call in client.calls for request in call["RequestItems"][TABLE]
    )


def test_unprocessed_items_are_retried_with_backoff(catalog: AnalysisFactCatalog) -> None:
    first = RecordingClient()
    sink_for(first, catalog).write(many_records(1), DATASET_VERSION)
    leftover = first.calls[0]["RequestItems"][TABLE][:2]

    delays: list[float] = []
    client = RecordingClient([{"UnprocessedItems": {TABLE: leftover}}])
    sink = DynamoAnalysisFactSink(
        client,  # type: ignore[arg-type]
        TABLE,
        catalog,
        sleep=delays.append,
        jitter=lambda: 0.0,
        base_backoff_seconds=0.1,
    )
    assert sink.write(many_records(1), DATASET_VERSION) == 8

    assert [len(call["RequestItems"][TABLE]) for call in client.calls] == [8, 2]
    assert client.calls[1]["RequestItems"][TABLE] == leftover
    assert delays == [pytest.approx(0.05)]


def test_persistently_unprocessed_items_fail_instead_of_being_lost(
    catalog: AnalysisFactCatalog,
) -> None:
    always = {"UnprocessedItems": {TABLE: [{"PutRequest": {"Item": {}}}]}}
    client = RecordingClient([always] * 3)

    with pytest.raises(UnprocessedFactsExhausted):
        sink_for(client, catalog, max_attempts=3).write(many_records(1), DATASET_VERSION)
    assert len(client.calls) == 3


def test_records_without_catalog_series_do_not_call_dynamodb(catalog: AnalysisFactCatalog) -> None:
    client = RecordingClient()
    record = normalized("live_active_15min", live_active_row("canal-fora-do-piloto"))

    assert sink_for(client, catalog).write([record], DATASET_VERSION) == 0
    assert client.calls == []


def test_sink_rejects_invalid_configuration(catalog: AnalysisFactCatalog) -> None:
    for kwargs in ({"max_attempts": 0}, {"max_attempts": 11}, {"base_backoff_seconds": -1}):
        with pytest.raises(ValueError):
            DynamoAnalysisFactSink(RecordingClient(), TABLE, catalog, **kwargs)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        DynamoAnalysisFactSink(RecordingClient(), "", catalog)  # type: ignore[arg-type]


@mock_aws
def test_round_trip_through_dynamodb_is_idempotent_and_queryable_by_the_worker_key(
    catalog: AnalysisFactCatalog,
) -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    client.create_table(
        TableName=TABLE,
        AttributeDefinitions=[
            {"AttributeName": "pk", "AttributeType": "S"},
            {"AttributeName": "sk", "AttributeType": "S"},
        ],
        KeySchema=[
            {"AttributeName": "pk", "KeyType": "HASH"},
            {"AttributeName": "sk", "KeyType": "RANGE"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    records = channel_records(pilot_scopes()[0]["entity"])
    sink = DynamoAnalysisFactSink(client, TABLE, catalog)

    assert sink.write(records, DATASET_VERSION) == 15
    assert sink.write(records, DATASET_VERSION) == 15

    expected = facts_from_records(records, DATASET_VERSION, catalog)
    assert client.scan(TableName=TABLE)["Count"] == len(expected) == 15
    for fact in expected:
        response = client.query(
            TableName=TABLE,
            KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues={":pk": {"S": str(fact["pk"])}, ":prefix": {"S": "T#"}},
            ConsistentRead=True,
        )
        assert response["Items"] == [serialize_item(fact)]
