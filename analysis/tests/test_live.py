"""Behavioral contracts for the bounded live-event exploration."""

import pandas as pd

import dump_explorer.live as live
from dump_explorer.charts import event_audience_timeline, event_impact_scatter
from dump_explorer.live import (
    build_event_comparison,
    distinct_event_count,
    load_event_audience,
    load_live_events,
    signal_pattern_for_slug,
)


def test_distinct_feeds_are_not_collapsed_by_start_time():
    """Catches treating simultaneous feed rows as one event before the confrontation key is used."""
    events = pd.DataFrame(
        {"tid": [994, 995], "start_ts": [1, 1], "event_key": ["a", "b"]}
    )

    assert distinct_event_count(events) == 2


def test_globo_slug_maps_to_family_with_explicit_approximation_flag():
    """Catches presenting a Globo-family prefix match as a precise channel mapping."""
    mapping = signal_pattern_for_slug("globo")

    assert mapping.pattern == "globo%"
    assert mapping.approximate is True


def test_live_events_preserve_feed_and_full_epg_slot_with_an_overlap_window(monkeypatch):
    """Catches selecting only event starts or dropping the EPG feed identity."""
    captured = {}

    def fake_read_frame(engine, statement, params=None, **kwargs):
        captured["sql"] = str(statement)
        captured["params"] = params
        return pd.DataFrame(
            {
                "event_key": ["final"],
                "tid": [994],
                "slug": ["sportv"],
                "start_ts": [1_000],
                "end_ts": [2_000],
            }
        )

    monkeypatch.setattr(live, "read_frame", fake_read_frame)

    events = load_live_events(object(), 1_500, 2_500)

    assert events.to_dict("records") == [
        {"event_key": "final", "tid": 994, "slug": "sportv", "start_ts": 1_000, "end_ts": 2_000}
    ]
    assert captured["params"] == {"start": 1_500, "end": 2_500}
    assert "start_ts < :end" in captured["sql"]
    assert "end_ts > :start" in captured["sql"]


def test_event_audience_aggregates_globo_family_per_15_minute_bucket(monkeypatch):
    """Catches choosing one Globo feed or averaging QoE without audience weights."""
    captured = {}

    def fake_read_frame(engine, statement, params=None, **kwargs):
        captured["sql"] = str(statement)
        captured["params"] = params
        return pd.DataFrame(
            {
                "event_key": ["final"],
                "tid": [994],
                "slug": ["globo"],
                "start_ts": [1_000],
                "end_ts": [2_000],
                "mapping_scope": ["national_family_approximation"],
                "timestamp_ms": [1_500],
                "active_sessions": [120],
                "active_with_error": [12],
                "bufferratio_avg": [0.15],
                "jointime_s_avg": [3.0],
            }
        )

    monkeypatch.setattr(live, "read_frame", fake_read_frame)

    timeline = load_event_audience(object(), "final", padding_minutes=60)

    assert timeline.loc[0, "telemetry_available"] == True  # noqa: E712
    assert timeline.loc[0, "mapping_scope"] == "national_family_approximation"
    assert timeline.loc[0, "active_sessions"] == 120
    assert timeline.loc[0, "active_with_error"] == 12
    assert timeline.loc[0, "error_rate_pct"] == 10.0
    assert captured["params"] == {
        "event_key": "final",
        "padding_ms": 3_600_000,
        "globo_pattern": "globo%",
    }
    assert "live_active_15min" in captured["sql"]
    assert "LIKE :globo_pattern" in captured["sql"]
    assert "SUM(a.active_sessions)" in captured["sql"]
    assert "NULLIF(SUM(a.active_sessions), 0)" in captured["sql"]
    assert "a.bucket_ts >= e.start_ts - :padding_ms" in captured["sql"]
    assert "a.bucket_ts < e.end_ts + :padding_ms" in captured["sql"]


def test_event_audience_keeps_epg_rows_without_telemetry(monkeypatch):
    """Catches turning a future or delayed EPG slot into a telemetry incident by dropping it."""
    monkeypatch.setattr(
        live,
        "read_frame",
        lambda *args, **kwargs: pd.DataFrame(
            {
                "event_key": ["future-final"],
                "tid": [995],
                "slug": ["sportv"],
                "start_ts": [3_000],
                "end_ts": [4_000],
                "mapping_scope": ["exact_signal"],
                "timestamp_ms": [None],
                "active_sessions": [None],
                "active_with_error": [None],
                "bufferratio_avg": [None],
                "jointime_s_avg": [None],
            }
        ),
    )

    timeline = load_event_audience(object(), "future-final")

    assert timeline.loc[0, "telemetry_available"] == False  # noqa: E712
    assert pd.isna(timeline.loc[0, "active_sessions"])
    assert timeline.loc[0, "mapping_scope"] == "exact_signal"


def test_event_comparison_excludes_padded_buckets_from_event_kpis(monkeypatch):
    """Catches pre/post-event context inflating an event's audience or QoE KPIs."""
    timeline = pd.DataFrame(
        {
            "event_key": ["final", "final", "final"],
            "tid": [994, 994, 994],
            "slug": ["sportv", "sportv", "sportv"],
            "start_ts": [1_000, 1_000, 1_000],
            "end_ts": [2_000, 2_000, 2_000],
            "timestamp_ms": [900, 1_500, 2_100],
            "active_sessions": [900, 120, 900],
            "active_with_error": [450, 12, 450],
            "bufferratio_avg": [0.9, 0.15, 0.9],
            "jointime_s_avg": [9.0, 3.0, 9.0],
            "telemetry_available": [True, True, True],
            "mapping_scope": ["exact_signal", "exact_signal", "exact_signal"],
        }
    )
    monkeypatch.setattr(live, "load_event_audience", lambda engine, key: timeline)

    comparison = build_event_comparison(object(), ["final"])

    assert comparison.loc[0, "peak_audience"] == 120
    assert comparison.loc[0, "peak_active_with_error"] == 12
    assert comparison.loc[0, "error_rate_pct"] == 10.0
    assert comparison.loc[0, "bufferratio_avg"] == 0.15
    assert comparison.loc[0, "jointime_s_avg"] == 3.0


def test_event_comparison_and_charts_preserve_missing_telemetry_as_unavailable(monkeypatch):
    """Catches excluding an EPG confrontation from comparison or graphing invented QoE values."""
    timelines = {
        "final": pd.DataFrame(
            {
                "event_key": ["final"],
                "tid": [994],
                "slug": ["globo"],
                "start_ts": [1_000],
                "end_ts": [2_000],
                "timestamp_ms": [1_500],
                "timestamp": [pd.Timestamp("1970-01-01 00:00:01.500", tz="UTC")],
                "active_sessions": [120],
                "active_with_error": [12],
                "bufferratio_avg": [0.15],
                "jointime_s_avg": [3.0],
                "telemetry_available": [True],
                "mapping_scope": ["national_family_approximation"],
            }
        ),
        "future-final": pd.DataFrame(
            {
                "event_key": ["future-final"],
                "tid": [995],
                "slug": ["sportv"],
                "start_ts": [3_000],
                "end_ts": [4_000],
                "timestamp_ms": [None],
                "timestamp": [pd.NaT],
                "active_sessions": [None],
                "active_with_error": [None],
                "bufferratio_avg": [None],
                "jointime_s_avg": [None],
                "telemetry_available": [False],
                "mapping_scope": ["exact_signal"],
            }
        ),
    }
    monkeypatch.setattr(live, "load_event_audience", lambda engine, key: timelines[key])

    comparison = build_event_comparison(object(), ["final", "future-final"])
    timeline_figure = event_audience_timeline(timelines["final"])
    impact_figure = event_impact_scatter(comparison)

    assert comparison[["event_key", "tid", "telemetry_available"]].to_dict("records") == [
        {"event_key": "final", "tid": 994, "telemetry_available": True},
        {"event_key": "future-final", "tid": 995, "telemetry_available": False},
    ]
    assert comparison.loc[0, "peak_audience"] == 120
    assert comparison.loc[0, "error_rate_pct"] == 10.0
    assert pd.isna(comparison.loc[1, "peak_audience"])
    assert list(timeline_figure.data[0].y) == [120]
    assert list(impact_figure.data[0].x) == [120]
    assert len(impact_figure.layout.annotations) == 1
    assert "EPG" in impact_figure.layout.annotations[0].text
