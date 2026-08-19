"""Behavioral contracts for bounded, aggregate-only QoE exploration."""

import pandas as pd
import pytest

import dump_explorer.qoe as qoe
from dump_explorer.charts import category_stack, geo_heatmap, impact_scatter, qoe_timeline
from dump_explorer.qoe import (
    add_error_rate,
    annotate_unknown_dimensions,
    load_device_qoe,
    load_error_categories,
    load_geo_qoe,
    load_live_active,
    load_live_qoe,
    load_player_qoe,
)


@pytest.fixture
def window():
    return 1_000, 10_000


def test_error_rate_is_null_when_sessions_are_zero():
    """Catches presenting an undefined zero-session rate as a measured zero."""
    frame = add_error_rate(pd.DataFrame({"sessions": [0, 20], "errors": [0, 3]}))

    assert pd.isna(frame.loc[0, "error_rate_pct"])
    assert frame.loc[1, "error_rate_pct"] == 15.0


def test_unknown_player_is_marked_as_explicit_missing_dimension():
    """Catches collapsing NPAW's known unknown dimension into an ordinary player."""
    frame = annotate_unknown_dimensions(pd.DataFrame({"player": ["(desconhecido)", "web"]}))

    assert frame["dimension_missing"].tolist() == [True, False]


def test_player_loader_uses_a_half_open_hourly_window_and_does_not_return_individual_ids(
    monkeypatch, window
):
    """Catches an inclusive end bound or an accidental drill-down to restricted identifiers."""
    captured = {}

    def fake_read_frame(engine, statement, params=None, **kwargs):
        captured["sql"] = str(statement)
        captured["params"] = params
        return pd.DataFrame({"player": ["(desconhecido)"], "sessions": [10], "errors": [2]})

    monkeypatch.setattr(qoe, "read_frame", fake_read_frame)

    frame = load_player_qoe(object(), *window)

    assert frame.loc[0, "error_rate_pct"] == 20.0
    assert bool(frame.loc[0, "dimension_missing"]) is True
    assert captured["params"] == {"start": 1_000, "end": 10_000}
    assert "hour_ts >= :start" in captured["sql"]
    assert "hour_ts < :end" in captured["sql"]
    assert "session_id" not in captured["sql"].lower()
    assert "user_id" not in captured["sql"].lower()


def test_device_loader_applies_minimum_sessions_in_sql_not_after_ranking(monkeypatch, window):
    """Catches loading high-cardinality raw devices before applying the documented threshold."""
    captured = {}

    def fake_read_frame(engine, statement, params=None, **kwargs):
        captured["sql"] = str(statement)
        captured["params"] = params
        return pd.DataFrame({"device": ["Samsung|TV"], "sessions": [30], "errors": [3]})

    monkeypatch.setattr(qoe, "read_frame", fake_read_frame)

    frame = load_device_qoe(object(), *window, min_sessions=30)

    assert frame.loc[0, "error_rate_pct"] == 10.0
    assert captured["params"]["min_sessions"] == 30
    assert "HAVING SUM(sessions) >= :min_sessions" in captured["sql"]
    assert "hour_ts >= :start" in captured["sql"]
    assert "hour_ts < :end" in captured["sql"]


def test_geo_loader_returns_aggregate_state_and_isp_without_map_dependency(monkeypatch, window):
    """Catches geo analysis returning raw events or requiring an external basemap."""
    monkeypatch.setattr(
        qoe,
        "read_frame",
        lambda *args, **kwargs: pd.DataFrame(
            {"state_province": ["SP"], "isp": ["Vivo"], "sessions": [50], "errors": [5]}
        ),
    )

    frame = load_geo_qoe(object(), *window)
    figure = geo_heatmap(frame)

    assert frame.loc[0, "error_rate_pct"] == 10.0
    assert figure.data[0].type == "heatmap"
    assert not hasattr(figure.data[0], "geojson")


def test_live_qoe_preserves_ratio_seconds_and_milliseconds_and_requires_selected_signals(
    monkeypatch, window
):
    """Catches mixing QoE units or reading every live channel without an explicit selection."""
    with pytest.raises(ValueError, match="signals"):
        load_live_qoe(object(), [], *window)

    monkeypatch.setattr(
        qoe,
        "read_frame",
        lambda *args, **kwargs: pd.DataFrame(
            {
                "timestamp_ms": [1_000],
                "sinal": ["pfc1"],
                "sessions": [10],
                "errors": [1],
                "startup_errors": [1],
                "latency_ms_avg": [120.0],
                "latency_ms_p50": [100.0],
                "latency_ms_p95": [180.0],
                "bufferratio_avg": [0.12],
                "jointime_s_avg": [2.5],
                "dropped_frames_avg": [3.0],
                "stalls_avg": [0.5],
            }
        ),
    )

    frame = load_live_qoe(object(), ["pfc1"], *window)

    assert frame.loc[0, "error_rate_pct"] == 10.0
    assert frame.loc[0, "bufferratio_unit"] == "ratio"
    assert frame.loc[0, "jointime_unit"] == "s"
    assert frame.loc[0, "latency_unit"] == "ms"


def test_live_active_labels_sessions_as_concurrent_not_cumulative(monkeypatch, window):
    """Catches summing 15-minute active sessions as if they were new joins."""
    monkeypatch.setattr(
        qoe,
        "read_frame",
        lambda *args, **kwargs: pd.DataFrame(
            {
                "timestamp_ms": [1_000],
                "sinal": ["pfc1"],
                "active_sessions": [80],
                "active_with_error": [4],
                "joins_in_bucket": [9],
                "latency_ms_p50": [100.0],
                "latency_ms_p95": [180.0],
                "bufferratio_avg": [0.1],
                "jointime_s_avg": [2.0],
                "dropped_frames_avg": [1.0],
            }
        ),
    )

    frame = load_live_active(object(), ["pfc1"], *window)

    assert frame.loc[0, "active_sessions_semantic"] == "concurrent"
    assert frame.loc[0, "joins_in_bucket_semantic"] == "new_entries"


def test_error_categories_keep_live_and_vod_separate_and_preserve_invalid_json(monkeypatch, window):
    """Catches combining live/VOD categories or throwing away malformed top_names evidence."""
    captured = {}

    def fake_read_frame(engine, statement, params=None, **kwargs):
        captured["sql"] = str(statement)
        captured["params"] = params
        return pd.DataFrame(
            {
                "timestamp_ms": [1_000],
                "kind": ["live"],
                "category": ["entrega"],
                "errors": [6],
                "top_names": ["not json"],
            }
        )

    monkeypatch.setattr(qoe, "read_frame", fake_read_frame)

    frame = load_error_categories(object(), "live", *window)

    assert frame.loc[0, "top_names"] == "not json"
    assert bool(frame.loc[0, "top_names_parse_error"]) is True
    assert frame.loc[0, "top_names_parsed"] == "not json"
    assert captured["params"]["kind"] == "live"
    assert "hour_ts >= :start" in captured["sql"]
    assert "hour_ts < :end" in captured["sql"]
    with pytest.raises(ValueError, match="live ou vod"):
        load_error_categories(object(), "all", *window)


def test_qoe_figures_keep_impact_axes_category_kind_and_empty_states_explicit():
    """Catches a chart that hides volume, mixes content kinds, or invents values for empty data."""
    impact = impact_scatter(
        pd.DataFrame({"player": ["web"], "sessions": [20], "errors": [2], "error_rate_pct": [10.0]})
    )
    categories = category_stack(
        pd.DataFrame(
            {
                "timestamp": [pd.Timestamp("2026-01-01", tz="UTC")],
                "kind": ["live"],
                "category": ["entrega"],
                "errors": [2],
            }
        )
    )
    timeline = qoe_timeline(pd.DataFrame(columns=["timestamp", "sinal", "active_sessions"]))

    assert list(impact.data[0].x) == [20]
    assert list(impact.data[0].y) == [10.0]
    assert list(impact.data[0].marker.size) == [2]
    assert categories.data[0].name == "live | entrega"
    assert "Sem dados" in timeline.layout.annotations[0].text
