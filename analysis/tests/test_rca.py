"""Safety contracts for incident and RCA exploration."""

import nbformat
import pandas as pd
import pytest

import dump_explorer.rca as rca
from dump_explorer.charts import attribution_stack, incident_timeline, provenance_bar
from dump_explorer.rca import (
    ArtifactFormatError,
    build_incident_window,
    load_dashboard_artifact,
    load_error_attribution,
    load_incidents,
    load_labels,
)
from scripts.build_notebooks import build_notebook


@pytest.fixture
def window():
    return 1_000, 10_000


def test_incident_scope_is_an_allowlist_and_opened_at_stays_ticket_open_time(monkeypatch, window):
    """Catches querying a neighbouring team's tickets or relabeling ticket opening as onset."""
    captured = {}

    def fake_read_frame(engine, statement, params=None, **kwargs):
        captured["sql"] = str(statement)
        captured["params"] = params
        return pd.DataFrame(
            {
                "opened_at_ms": [1_000],
                "resolved_at_ms": [2_000],
                "closed_at_ms": [3_000],
                "priority": ["P2"],
                "priority_value": ["2"],
                "state": ["resolved"],
                "state_value": ["6"],
                "assignment_group": ["video"],
                "business_service": ["playback"],
                "cmdb_ci": ["api"],
                "external_impact": ["true"],
                "change_or_deploy": ["false"],
            }
        )

    monkeypatch.setattr(rca, "read_frame", fake_read_frame)

    incidents = load_incidents(object(), *window)

    assert "FROM `incidents`" in captured["sql"]
    assert "incidents_platform" not in captured["sql"]
    assert captured["params"] == {"start": 1_000, "end": 10_000, "row_limit": 100_000}
    assert incidents.loc[0, "opened_at"] == pd.Timestamp(1_000, unit="ms", tz="UTC")
    assert incidents.loc[0, "opened_at_label"] == "ticket-open time (not incident-start)"
    assert incidents.loc[0, "opened_at_uncertainty_minutes"] == 40
    assert incidents.loc[0, "duration_ms"] == 1_000
    assert "sys_id" not in captured["sql"].lower()
    assert "number" not in captured["sql"].lower()
    assert "short_description" not in captured["sql"].lower()

    load_incidents(object(), *window, scope="platform")
    assert "FROM `incidents_platform`" in captured["sql"]
    with pytest.raises(ValueError, match="scope"):
        load_incidents(object(), *window, scope="all")


def test_labels_default_to_confirmed_provenances_and_keep_detector_rows_circular(monkeypatch):
    """Catches evaluating against labels created by the same detector being evaluated."""
    captured = {}

    def fake_read_frame(engine, statement, params=None, **kwargs):
        captured["sql"] = str(statement)
        captured["params"] = params
        return pd.DataFrame(
            {
                "tier": [1],
                "kind": ["incident"],
                "ts_start_ms": [1_000],
                "ts_end_ms": [2_000],
                "severity": ["P1"],
                "region": ["BR"],
                "services": ['["playback"]'],
                "metrics_cited": ['{"errors": 9}'],
                "provenance": ["rca-confirmed"],
            }
        )

    monkeypatch.setattr(rca, "read_frame", fake_read_frame)

    confirmed = load_labels(object())

    assert captured["params"] == {
        "provenance_0": "rca-confirmed",
        "provenance_1": "team-confirmed",
        "row_limit": 100_000,
    }
    assert "description" not in captured["sql"].lower()
    assert confirmed.loc[0, "services"] == ["playback"]
    assert confirmed.loc[0, "metrics_cited"] == {"errors": 9}
    assert bool(confirmed.loc[0, "circular"]) is False

    detector = load_labels(object(), provenances=["detector-derived"])
    assert detector.loc[0, "provenance"] == "rca-confirmed"

    monkeypatch.setattr(
        rca,
        "read_frame",
        lambda *args, **kwargs: pd.DataFrame(
            {
                "tier": [2],
                "kind": ["incident"],
                "ts_start_ms": [1_000],
                "ts_end_ms": [None],
                "severity": [None],
                "region": [None],
                "services": ["not-json"],
                "metrics_cited": ["[]"],
                "provenance": ["detector-derived"],
            }
        ),
    )
    display = load_labels(object(), provenances=["detector-derived"])

    assert display.loc[0, "services"] == "not-json"
    assert bool(display.loc[0, "services_parse_error"]) is True
    assert bool(display.loc[0, "metrics_cited_parse_error"]) is False
    assert bool(display.loc[0, "circular"]) is True
    assert bool(display.loc[0, "evaluation_eligible"]) is False


def test_rca_charts_only_use_structured_safe_hover_fields():
    """Catches accidentally exposing null or sanitized free text in hover payloads."""
    incidents = pd.DataFrame(
        {
            "opened_at": [pd.Timestamp("2026-01-01T00:00:00Z")],
            "priority": ["P2"],
            "state": ["resolved"],
            "duration_ms": [60_000],
            "short_description": [None],
            "cause": [None],
            "close_notes": [None],
        }
    )
    deploys = pd.DataFrame(
        {
            "timestamp": [pd.Timestamp("2026-01-01T00:15:00Z")],
            "entity": ["api"],
            "event_label": ["deploy"],
            "owner": [None],
            "error": [None],
        }
    )
    attribution = pd.DataFrame(
        {
            "timestamp": [pd.Timestamp("2026-01-01T00:30:00Z")],
            "tier": ["edge_isp"],
            "errors": [3],
            "sinal": ["pfc1"],
            "error_name": [None],
        }
    )
    labels = pd.DataFrame({"provenance": ["detector-derived"], "circular": [True]})

    timeline = incident_timeline(incidents, deploys, attribution)
    provenance = provenance_bar(labels)
    stack = attribution_stack(attribution)
    hover_payload = str(timeline.to_plotly_json()) + str(stack.to_plotly_json())

    assert "short_description" not in hover_payload
    assert "close_notes" not in hover_payload
    assert "error_name" not in hover_payload
    assert provenance.data[0].name == "circular"


def test_attribution_is_bounded_by_window_and_optional_signal_allowlist(monkeypatch, window):
    """Catches an unbounded error-attribution read or a raw identifier drill-down."""
    captured = {}

    def fake_read_frame(engine, statement, params=None, **kwargs):
        captured["sql"] = str(statement)
        captured["params"] = params
        captured["max_rows"] = kwargs["max_rows"]
        return pd.DataFrame(
            {
                "timestamp_ms": [1_000],
                "sinal": ["pfc1"],
                "cdn": ["cdn-a"],
                "tier": ["edge_isp"],
                "http_code": ["500"],
                "errors": [3],
            }
        )

    monkeypatch.setattr(rca, "read_frame", fake_read_frame)

    attribution = load_error_attribution(object(), *window, signals=["pfc1"])

    assert attribution.loc[0, "timestamp"] == pd.Timestamp(1_000, unit="ms", tz="UTC")
    assert captured["params"] == {
        "start": 1_000,
        "end": 10_000,
        "row_limit": 100_000,
        "signal_0": "pfc1",
    }
    assert captured["max_rows"] == 100_000
    assert "hour_ts >= :start" in captured["sql"]
    assert "hour_ts < :end" in captured["sql"]
    assert "LIMIT :row_limit" in captured["sql"]
    assert "error_name" not in captured["sql"].lower()
    assert "session_id" not in captured["sql"].lower()


def test_incident_window_uses_existing_loaders_and_whitelisted_offsets(monkeypatch):
    """Catches inventing a SQL interval or duplicating loaders for incident context."""
    calls = {}
    incident = pd.Series({"opened_at": pd.Timestamp("2026-01-01T12:00:00Z")})

    def fake_attribution(engine, start, end, signals=None):
        calls["attribution"] = (start, end, signals)
        return pd.DataFrame(columns=["timestamp", "tier", "errors"])

    def fake_deploys(engine, targets, start, end):
        calls["deploys"] = (targets, start, end)
        return pd.DataFrame(columns=["timestamp", "entity", "event_label"])

    monkeypatch.setattr(rca, "load_error_attribution", fake_attribution)
    monkeypatch.setattr(rca, "load_tsuru_events", fake_deploys)
    monkeypatch.setattr(
        rca, "load_labels", lambda engine: pd.DataFrame(columns=["ts_start", "ts_end"])
    )

    result = build_incident_window(object(), incident, before="30m", after="2h")

    assert result.incident.equals(incident)
    assert calls["attribution"] == (1_767_267_000_000, 1_767_276_000_000, None)
    assert calls["deploys"] == ([], 1_767_267_000_000, 1_767_276_000_000)
    with pytest.raises(ValueError, match="before"):
        build_incident_window(object(), incident, before="45m")


def test_dashboard_artifact_requires_an_explicit_name_and_json_mapping(monkeypatch):
    """Catches fuzzy artifact lookup or accepting a malformed dashboard payload as evidence."""
    captured = {}

    def fake_read_frame(engine, statement, params=None, **kwargs):
        captured["sql"] = str(statement)
        captured["params"] = params
        captured["max_rows"] = kwargs["max_rows"]
        return pd.DataFrame({"payload": ['{"incident_id":"abc","score":7}']})

    monkeypatch.setattr(rca, "read_frame", fake_read_frame)

    artifact = load_dashboard_artifact(object(), "incidents")

    assert artifact == {"incident_id": "abc", "score": 7}
    assert captured["params"] == {"name": "incidents"}
    assert captured["max_rows"] == 1
    assert "WHERE name = :name" in captured["sql"]
    assert "LIKE" not in captured["sql"].upper()

    monkeypatch.setattr(
        rca, "read_frame", lambda *args, **kwargs: pd.DataFrame({"payload": ["[]"]})
    )
    with pytest.raises(ArtifactFormatError, match="incidents"):
        load_dashboard_artifact(object(), "incidents")
    with pytest.raises(ArtifactFormatError, match="artefato inválido"):
        load_dashboard_artifact(object(), "")


def test_notebook_05_states_ticket_limits_and_uses_only_safe_rca_interfaces(tmp_path):
    """Catches a notebook that treats ticket absence as a negative label or exposes raw RCA text."""
    path = tmp_path / "05_incidentes_rca.ipynb"

    build_notebook("05", path)

    notebook = nbformat.read(path, as_version=4)
    source = "\n".join(cell.source for cell in notebook.cells)
    assert "load_incidents" in source
    assert "build_incident_window" in source
    assert "ticket-open" in source
    assert "40 minutos" in source
    assert "ausência de ticket não é" in source
    assert "detector-derived" in source
    assert "opcional" in source
    assert "short_description" not in source
    assert all(cell.get("outputs", []) == [] for cell in notebook.cells)
