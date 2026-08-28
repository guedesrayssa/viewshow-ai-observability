import pandas as pd
import pytest

import dump_explorer.qos as qos
from dump_explorer.qos import (
    load_apollo,
    load_prometheus,
    load_rpaas,
    load_tsuru_events,
)


@pytest.fixture
def window():
    return 1_000, 10_000


def test_apollo_rpm_uses_each_rows_actual_window_duration(monkeypatch, window):
    """Catches treating Apollo request counts as a rate for a fixed-size window."""
    captured = {}

    def fake_read_frame(engine, statement, params=None, **kwargs):
        captured["sql"] = str(statement)
        captured["params"] = params
        return pd.DataFrame(
            {
                "timestamp_ms": [1_000, 2_000],
                "operation_name": ["HomeQuery", "HomeQuery"],
                "request_count": [30.0, 30.0],
                "error_count": [3.0, 3.0],
                "rpm": [30.0, 15.0],
                "error_rate": [0.1, 0.1],
                "p50_ms": [10.0, 11.0],
                "p90_ms": [20.0, 21.0],
                "p99_ms": [30.0, 31.0],
            }
        )

    monkeypatch.setattr(qos, "read_frame", fake_read_frame)
    start, end = window

    frame = load_apollo(object(), ["HomeQuery"], start, end)

    rpm = frame.loc[frame["metric"] == "rpm", "value"].tolist()
    assert rpm == [30.0, 15.0]
    assert captured["params"]["start"] == start
    assert captured["params"]["end"] == end
    assert "NULLIF(end_ts - start_ts, 0)" in captured["sql"]


def test_rpaas_keeps_sampled_counts_and_exposes_rates(monkeypatch, window):
    """Catches presenting 1%-sampled RPaaS counts as exact traffic instead of rates."""
    monkeypatch.setattr(
        qos,
        "read_frame",
        lambda *args, **kwargs: pd.DataFrame(
            {
                "timestamp_ms": [1_000],
                "region": ["br1"],
                "vhost": ["playback.video.globo.com"],
                "requests_total": [100],
                "requests_2xx": [90],
                "requests_3xx": [2],
                "requests_4xx": [3],
                "requests_5xx": [5],
                "p50_ms": [10.0],
                "p90_ms": [20.0],
                "p95_ms": [30.0],
                "p99_ms": [40.0],
                "requests_2xx_rate": [0.9],
                "requests_3xx_rate": [0.02],
                "requests_4xx_rate": [0.03],
                "requests_5xx_rate": [0.05],
            }
        ),
    )
    start, end = window

    frame = load_rpaas(object(), ["br1"], ["playback.video.globo.com"], start, end)

    sampled_total = frame.loc[frame["metric"] == "requests_total_sampled", "value"].iloc[0]
    five_xx_rate = frame.loc[frame["metric"] == "requests_5xx_rate", "value"].iloc[0]
    playback = frame.loc[frame["metric"] == "requests_4xx_rate", "playback_signal"].iloc[0]
    assert sampled_total == 100
    assert five_xx_rate == 0.05
    assert bool(playback) is True


def test_prometheus_requires_section_and_caps_selected_series(monkeypatch, window):
    """Catches broad prom_point scans or a Prometheus selection above 20 series."""
    start, end = window
    with pytest.raises(ValueError, match="section"):
        load_prometheus(object(), "", [], start, end)
    with pytest.raises(ValueError, match="20"):
        load_prometheus(object(), "CPU", [], start, end, limit_series=21)

    captured = {}

    def fake_read_frame(engine, statement, params=None, **kwargs):
        captured["sql"] = str(statement)
        captured["params"] = params
        captured["max_rows"] = kwargs["max_rows"]
        return pd.DataFrame(
            {
                "timestamp_ms": [1_000],
                "series_id": [7],
                "entity": ["api"],
                "metric": ["CPU"],
                "value": [0.4],
                "labels": ['{"service":"api"}'],
            }
        )

    monkeypatch.setattr(qos, "read_frame", fake_read_frame)

    frame = load_prometheus(object(), "CPU", ["api"], start, end, limit_series=20)

    assert frame.loc[0, "labels"] == {"service": "api"}
    assert bool(frame.loc[0, "labels_parse_error"]) is False
    assert captured["params"]["section"] == "CPU"
    assert captured["params"]["limit_series"] == 20
    assert captured["max_rows"] == 100_000
    assert "q.section = :section" in captured["sql"]
    assert "p.epoch_ms >= :start" in captured["sql"]
    assert "p.epoch_ms < :end" in captured["sql"]
    assert "LIMIT :limit_series" in captured["sql"]


def test_tsuru_autoscale_run_is_rule_reapplication_not_demand_scaling(monkeypatch, window):
    """Catches the false causal claim that autoscale.run means demand-driven scaling."""
    monkeypatch.setattr(
        qos,
        "read_frame",
        lambda *args, **kwargs: pd.DataFrame(
            {
                "timestamp_ms": [1_000],
                "uniqueid": ["event-1"],
                "target_type": ["app"],
                "target_value": ["api"],
                "kind": ["autoscale.run"],
                "end_time_ms": [2_000],
                "duration_ms": [1_000],
            }
        ),
    )
    start, end = window

    frame = load_tsuru_events(object(), ["api"], start, end)

    assert frame.loc[0, "event_label"] == "rule_reapplication"
    assert frame.loc[0, "owner"] is None
    assert frame.loc[0, "error"] is None
