"""Verifica o contrato de fatos entre a ingestão e o catálogo piloto do worker de análise."""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest

from domain.analysis_facts import (
    AnalysisFactCatalog,
    SeriesIdentity,
    build_fact,
    facts_from_records,
    series_id,
)
from tests.analysis_fact_support import (
    DATASET_VERSION,
    DELIVERY,
    FROZEN_FACT,
    PILOT_CATALOG,
    QOE_1H,
    QOE_15M,
    channel_records,
    live_active_row,
    normalized,
    pilot_scopes,
    signal_row,
)


@pytest.fixture(scope="module")
def catalog() -> AnalysisFactCatalog:
    return AnalysisFactCatalog.from_json(PILOT_CATALOG.read_bytes())


def test_pilot_catalog_series_ids_are_reproduced_by_the_ingestion_identity_rule() -> None:
    """Cada ``seriesId`` do catálogo é o hash da identidade que a ingestão calcula."""
    checked = 0
    for scope in pilot_scopes():
        channel = scope["entity"]
        expected = {
            (dataset, metric): series_id(
                SeriesIdentity(dataset, "argus", channel, metric, {"channel": channel})
            )
            for dataset, metrics in (
                ("live_active_15min", QOE_15M),
                ("live_qoe_hourly", QOE_1H),
                *((source, (alias,)) for source, alias in DELIVERY.items()),
            )
            for metric in metrics
        }
        declared = {entry["seriesId"] for entry in scope["series"]}
        assert declared == set(expected.values()), scope["id"]
        checked += len(declared)
    assert checked == 150


def test_ingested_records_produce_exactly_the_series_ids_of_the_pilot_catalog(
    catalog: AnalysisFactCatalog,
) -> None:
    """O que a ingestão grava por canal coincide com o que o catálogo pede ao worker."""
    for scope in pilot_scopes():
        facts = facts_from_records(channel_records(scope["entity"]), DATASET_VERSION, catalog)
        assert {fact["seriesId"] for fact in facts} == {e["seriesId"] for e in scope["series"]}
        by_series = {entry["seriesId"]: entry for entry in scope["series"]}
        for fact in facts:
            entry = by_series[str(fact["seriesId"])]
            metric = fact["payload"]["metric"]  # type: ignore[index]
            assert (metric["name"], metric["unit"]) == (entry["metric"], entry["unit"])
            assert fact["grainSeconds"] == entry["grainSeconds"]
            assert fact["datasetVersion"] == DATASET_VERSION


def test_fact_items_follow_the_frozen_worker_fixture_shape(catalog: AnalysisFactCatalog) -> None:
    frozen = json.loads(FROZEN_FACT.read_text())
    facts = facts_from_records(channel_records(pilot_scopes()[0]["entity"]), "dsv_x", catalog)
    for fact in facts:
        assert set(frozen) <= set(fact)
        assert fact["itemType"] == frozen["itemType"]
        assert str(fact["pk"]).startswith("DATASET#dsv_x#FACT#TS#ts_")
        assert str(fact["pk"]).endswith("#20260906")
        assert str(fact["sk"]).startswith("T#")
        assert str(fact["sk"]).endswith("#" + str(fact["recordId"]))
        assert len(str(fact["observedAt"])) == len(frozen["observedAt"])
        assert set(fact["payload"]["metric"]) == set(frozen["payload"]["metric"])  # type: ignore[index]


def test_sort_key_carries_the_bucket_start_in_epoch_milliseconds(
    catalog: AnalysisFactCatalog,
) -> None:
    facts = facts_from_records(channel_records(pilot_scopes()[0]["entity"]), "dsv_x", catalog)
    for fact in facts:
        observed_ms = int(datetime.fromisoformat(str(fact["observedAt"])).timestamp() * 1000)
        assert str(fact["sk"]).split("#")[1] == str(observed_ms)


def test_records_outside_the_catalog_are_ignored(catalog: AnalysisFactCatalog) -> None:
    channel = pilot_scopes()[0]["entity"]
    noise = [
        normalized("live_active_15min", live_active_row("canal-fora-do-piloto")),
        normalized("signal_bucket", signal_row("cdn_live_errors", "canal-fora-do-piloto")),
        normalized("signal_bucket", signal_row("cdn_live_errors", channel, metric="rpm")),
        normalized("signal_bucket", signal_row("fonte-desconhecida", channel)),
    ]
    assert facts_from_records(noise, DATASET_VERSION, catalog) == ()
    # Métricas do dataset que o catálogo não lista não viram fatos.
    facts = facts_from_records(channel_records(channel), DATASET_VERSION, catalog)
    assert len(facts) == 15
    assert "latency_ms_avg" not in {f["payload"]["metric"]["name"] for f in facts}  # type: ignore[index]


def test_null_measure_is_kept_as_a_null_value(catalog: AnalysisFactCatalog) -> None:
    channel = pilot_scopes()[0]["entity"]
    row = {**live_active_row(channel), "latency_ms_p50": None}
    facts = facts_from_records([normalized("live_active_15min", row)], DATASET_VERSION, catalog)
    values = {f["payload"]["metric"]["name"]: f["payload"]["metric"]["value"] for f in facts}  # type: ignore[index]
    assert values["latency_ms_p50"] is None
    assert values["latency_ms_p95"] == Decimal("480.25")
    assert values["active_sessions"] == 120


def test_repeated_records_are_deduplicated_and_conflicts_are_rejected(
    catalog: AnalysisFactCatalog,
) -> None:
    channel = pilot_scopes()[0]["entity"]
    record = normalized("live_active_15min", live_active_row(channel))
    once = facts_from_records([record], DATASET_VERSION, catalog)
    assert facts_from_records([record, record], DATASET_VERSION, catalog) == once
    conflicting = normalized(
        "live_active_15min", {**live_active_row(channel), "active_sessions": 7}
    )
    with pytest.raises(ValueError, match="conflicting payload"):
        facts_from_records([record, conflicting], DATASET_VERSION, catalog)


def test_records_are_rejected_when_their_grain_differs_from_the_catalog(
    catalog: AnalysisFactCatalog,
) -> None:
    channel = pilot_scopes()[0]["entity"]
    record = normalized("live_active_15min", live_active_row(channel))
    assert record.window is not None
    wrong_grain = replace(record, window=replace(record.window, grain_seconds=3600))
    with pytest.raises(ValueError, match="grain differs"):
        facts_from_records([wrong_grain], DATASET_VERSION, catalog)
    with pytest.raises(ValueError, match="bucket window"):
        facts_from_records([replace(record, window=None)], DATASET_VERSION, catalog)


def test_build_fact_is_deterministic_and_validates_its_inputs() -> None:
    identity = SeriesIdentity("live_qoe_hourly", "argus", "globo-rj", "sessions", {"channel": "x"})
    arguments: dict[str, Any] = {
        "dataset_version": "d",
        "identity": identity,
        "observed_at": datetime(2026, 9, 6, 14, tzinfo=UTC),
        "grain_seconds": 3600,
        "unit": "count",
        "value": Decimal("3"),
    }
    assert build_fact(**arguments) == build_fact(**arguments)
    for override, message in (
        ({"observed_at": datetime(2026, 9, 6, 14, 30, tzinfo=UTC)}, "aligned"),
        ({"observed_at": datetime(2026, 9, 6, 14)}, "UTC"),
        ({"grain_seconds": 60}, "metadata"),
        ({"value": Decimal("NaN")}, "finite"),
        ({"value": float("inf")}, "finite"),
        ({"value": True}, "finite"),
        ({"value": "12"}, "finite"),
    ):
        with pytest.raises(ValueError, match=message):
            build_fact(**{**arguments, **override})


@pytest.mark.parametrize(
    "document",
    [
        "not json",
        "{}",
        "[]",
        '[{"entity": "a"}]',
        '[{"series": []}]',
        '[{"entity": "a", "series": [{"seriesId": "ts_x", "metric": "m", "unit": "u",'
        ' "grainSeconds": 900}]}]',
        '[{"entity": "a", "series": [{"seriesId": "ts_' + "a" * 64 + '", "metric": "m",'
        ' "unit": "u", "grainSeconds": 60}]}]',
    ],
)
def test_catalog_rejects_documents_that_do_not_follow_the_worker_format(document: str) -> None:
    with pytest.raises(ValueError):
        AnalysisFactCatalog.from_json(document)


def test_catalog_rejects_conflicting_definitions_for_the_same_series() -> None:
    identifier = "ts_" + "b" * 64
    series = {"seriesId": identifier, "metric": "m", "unit": "count", "grainSeconds": 900}
    conflicting = {**series, "unit": "ms"}
    document = json.dumps(
        [{"entity": "a", "series": [series]}, {"entity": "b", "series": [conflicting]}]
    )
    with pytest.raises(ValueError, match="conflicting definitions"):
        AnalysisFactCatalog.from_json(document)
