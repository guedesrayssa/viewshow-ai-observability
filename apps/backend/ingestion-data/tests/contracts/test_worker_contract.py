"""Congela o que a ingestão grava e publica para o worker de análise.

Os arquivos em ``apps/backend/agentic/contracts/fixtures`` são gerados pelo código de ingestão e
lidos pelos testes do worker (TypeScript): se a ingestão mudar a chave, o formato do fato ou o
corpo dos eventos, este teste falha até que os arquivos sejam regenerados e o worker os aceite.

Para regenerar depois de uma mudança deliberada::

    UPDATE_CONTRACT_FIXTURES=1 python -m pytest tests/contracts/test_worker_contract.py
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from adapters.analysis_catalog import load_fact_catalog
from adapters.dynamodb.codec import serialize_item
from adapters.dynamodb.outbox import build_analysis_event
from application.backfill import Backfill
from application.sync import Sync
from domain.analysis import DEFAULT_FORECAST_MODEL, ForecastModel, analysis_message_body
from domain.analysis_facts import facts_from_records
from domain.models import TimeWindow
from tests.analysis_fact_support import (
    AGENTIC,
    DATASET_VERSION,
    PILOT_CATALOG,
    channel_records,
    pilot_scopes,
)

FIXTURES = AGENTIC / "contracts" / "fixtures"
FACTS_FIXTURE = FIXTURES / "ingestion-facts.v1.json"
EVENTS_FIXTURE = FIXTURES / "ingestion-events.v1.json"
WATERMARK = datetime(2026, 9, 6, 15, tzinfo=UTC)
PRODUCED_AT = datetime(2026, 9, 6, 15, 1, 12, tzinfo=UTC)
# Identidade do bundle usado nos testes do worker; o evento precisa carregá-la para ser aceito.
WORKER_MODEL = ForecastModel("qoe-random-forest", "candidate")


def _assert_matches_fixture(path: Path, produced: dict[str, Any]) -> None:
    if os.environ.get("UPDATE_CONTRACT_FIXTURES") == "1":
        path.write_text(json.dumps(produced, indent=2, ensure_ascii=False) + "\n")
    assert path.exists(), f"{path.name} is missing; run with UPDATE_CONTRACT_FIXTURES=1"
    assert json.loads(path.read_text()) == produced, (
        f"{path.name} is stale; run with UPDATE_CONTRACT_FIXTURES=1 and rerun the worker tests"
    )


def _fact_items() -> dict[str, Any]:
    scope = pilot_scopes()[0]
    catalog = load_fact_catalog(str(PILOT_CATALOG))
    facts = facts_from_records(channel_records(scope["entity"]), DATASET_VERSION, catalog)
    return {
        "datasetVersion": DATASET_VERSION,
        "scopeId": scope["id"],
        "items": [serialize_item(fact) for fact in facts],
    }


def _events() -> dict[str, Any]:
    windows = {
        "ANOMALY_DETECTION": TimeWindow(WATERMARK - timedelta(minutes=15), WATERMARK, 900),
        "QOE_FORECAST": TimeWindow(WATERMARK - timedelta(hours=1), WATERMARK, 3600),
    }
    events = {
        kind: json.loads(
            analysis_message_body(
                build_analysis_event(
                    DATASET_VERSION,
                    kind,
                    window,
                    created_at=PRODUCED_AT,
                    forecast_model=WORKER_MODEL,
                )
            )
        )
        for kind, window in windows.items()
    }
    return {"forecastModel": WORKER_MODEL.payload(), "events": events}


def test_ingestion_facts_match_the_fixture_the_worker_reads() -> None:
    _assert_matches_fixture(FACTS_FIXTURE, _fact_items())


def test_ingestion_events_match_the_fixture_the_worker_parses() -> None:
    _assert_matches_fixture(EVENTS_FIXTURE, _events())


def test_forecast_events_declare_the_configured_model_and_default_to_the_trainer_name() -> None:
    forecast = _events()["events"]["QOE_FORECAST"]
    assert forecast["payload"]["model"] == WORKER_MODEL.payload()
    assert "model" not in _events()["events"]["ANOMALY_DETECTION"]["payload"]
    assert DEFAULT_FORECAST_MODEL.name == "qoe-random-forest"


@pytest.mark.parametrize("kind", ["ANOMALY_DETECTION", "QOE_FORECAST"])
def test_every_event_builder_produces_the_same_payload(kind: str) -> None:
    """Outbox, sync e backfill constroem eventos por caminhos distintos; o corpo é único."""
    grain = 900 if kind == "ANOMALY_DETECTION" else 3600
    window = TimeWindow(WATERMARK - timedelta(seconds=grain), WATERMARK, grain)
    reference = build_analysis_event(
        DATASET_VERSION, kind, window, created_at=PRODUCED_AT, forecast_model=WORKER_MODEL
    )
    from_sync = Sync._event(DATASET_VERSION, kind, WATERMARK, WORKER_MODEL)
    from_backfill = Backfill._analysis_event(DATASET_VERSION, kind, WATERMARK, grain, WORKER_MODEL)

    for other in (from_sync, from_backfill):
        assert other.payload == reference.payload
        assert other.event_id == reference.event_id
        assert other.idempotency_key == reference.idempotency_key
        assert (
            json.loads(analysis_message_body(other))["payload"]
            == json.loads(analysis_message_body(reference))["payload"]
        )


def test_forecast_model_identity_is_validated() -> None:
    assert ForecastModel("qoe-random-forest", "2026.09.1").payload() == {
        "name": "qoe-random-forest",
        "version": "2026.09.1",
    }
    for name, version in (("", "1"), ("modelo com espaço", "1"), ("m", ""), ("m", "v" * 65)):
        with pytest.raises(ValueError, match="forecast model"):
            ForecastModel(name, version)
