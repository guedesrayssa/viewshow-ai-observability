import pandas as pd
import pytest

import dump_explorer.signals as signals
from dump_explorer.signals import (
    list_series,
    load_correlation_frame,
    load_metric_series,
    load_source_distribution,
    parse_signal_tags,
)


@pytest.fixture
def window():
    return 1_000, 2_000


def test_signal_point_requires_full_identity_and_window():
    """Catches an expensive raw-point read without its natural identity."""
    with pytest.raises(ValueError, match="source, entity, metric, start e end"):
        load_metric_series(object(), "newrelic", None, None, None, None, table="signal_point")


def test_unknown_signal_table_is_rejected(window):
    """Catches selecting an arbitrary table name into query SQL."""
    start, end = window
    with pytest.raises(ValueError, match=r"signal_bucket.*signal_point"):
        load_metric_series(object(), "x", "y", "z", start, end, table="other")


def test_non_json_signal_tags_are_preserved_and_marked():
    """Catches losing an observation solely because its tag is malformed JSON."""
    parsed, failed = parse_signal_tags("live")

    assert parsed == "live"
    assert failed is True


def test_source_distribution_uses_half_open_window_with_bound_parameters(monkeypatch, window):
    """Catches a broad source aggregation or SQL interpolation of its time window."""
    captured = {}

    def fake_read_frame(engine, statement, params=None, **kwargs):
        captured["sql"] = str(statement)
        captured["params"] = params
        return pd.DataFrame({"source": ["newrelic"], "rows": [3]})

    monkeypatch.setattr(signals, "read_frame", fake_read_frame)
    start, end = window

    frame = load_source_distribution(object(), start, end)

    assert frame.to_dict("records") == [{"source": "newrelic", "rows": 3}]
    assert captured["params"] == {"start": start, "end": end}
    assert "bts >= :start" in captured["sql"]
    assert "bts < :end" in captured["sql"]


def test_list_series_bounds_source_and_caps_its_result_limit(monkeypatch, window):
    """Catches source injection, an unbounded series listing, or a limit over 500."""
    captured = {}

    def fake_read_frame(engine, statement, params=None, **kwargs):
        captured["sql"] = str(statement)
        captured["params"] = params
        return pd.DataFrame({"source": ["nr"], "entity": ["api"], "metric": ["p95"], "rows": [4]})

    monkeypatch.setattr(signals, "read_frame", fake_read_frame)
    start, end = window

    frame = list_series(object(), "nr'; DROP TABLE signal_bucket; --", start, end, limit=500)

    assert frame.to_dict("records") == [
        {"source": "nr", "entity": "api", "metric": "p95", "rows": 4}
    ]
    assert captured["params"] == {
        "source": "nr'; DROP TABLE signal_bucket; --",
        "start": start,
        "end": end,
        "limit": 500,
    }
    assert "DROP TABLE" not in captured["sql"]
    assert "ORDER BY rows DESC" in captured["sql"]

    with pytest.raises(ValueError, match="500"):
        list_series(object(), "nr", start, end, limit=501)


def test_metric_series_uses_full_identity_and_normalizes_bucket_timestamps(monkeypatch, window):
    """Catches partial identities or treating epoch milliseconds as naive datetimes."""
    captured = {}

    def fake_read_frame(engine, statement, params=None, **kwargs):
        captured["sql"] = str(statement)
        captured["params"] = params
        return pd.DataFrame({"timestamp_ms": [1_000], "value": [2.5]})

    monkeypatch.setattr(signals, "read_frame", fake_read_frame)
    start, end = window

    frame = load_metric_series(object(), "newrelic", "api", "latency_p95", start, end)

    assert captured["params"] == {
        "source": "newrelic",
        "entity": "api",
        "metric": "latency_p95",
        "start": start,
        "end": end,
    }
    assert "bts AS timestamp_ms" in captured["sql"]
    assert "source = :source" in captured["sql"]
    assert "entity = :entity" in captured["sql"]
    assert "metric = :metric" in captured["sql"]
    assert frame.loc[0, "timestamp"] == pd.Timestamp("1970-01-01T00:00:01Z")


def test_signal_point_tags_are_parsed_without_dropping_malformed_values(monkeypatch, window):
    """Catches raw-point tag loss and conflating malformed tags with valid JSON."""
    monkeypatch.setattr(
        signals,
        "read_frame",
        lambda *args, **kwargs: pd.DataFrame(
            {
                "timestamp_ms": [1_000, 1_500],
                "value": [1.0, 2.0],
                "tags": ['{"region":"br"}', "live"],
            }
        ),
    )
    start, end = window

    frame = load_metric_series(
        object(), "nr", "api", "error_rate", start, end, table="signal_point"
    )

    assert frame["tags"].tolist() == [{"region": "br"}, "live"]
    assert frame["tags_parse_error"].tolist() == [False, True]


def test_correlation_outer_joins_independent_series_without_zero_fill(monkeypatch, window):
    """Catches implicit resampling or replacing absent observations with zero."""
    frames = {
        ("nr", "api", "latency_p95"): pd.DataFrame(
            {
                "timestamp": pd.to_datetime([1_000, 2_000], unit="ms", utc=True),
                "value": [10.0, 20.0],
            }
        ),
        ("prom", "api", "errors"): pd.DataFrame(
            {"timestamp": pd.to_datetime([2_000, 3_000], unit="ms", utc=True), "value": [1.0, 3.0]}
        ),
    }
    monkeypatch.setattr(
        signals,
        "load_metric_series",
        lambda engine, source, entity, metric, start, end: frames[(source, entity, metric)],
    )
    start, end = window

    frame = load_correlation_frame(object(), list(frames), start, end)

    assert frame.columns.tolist() == ["timestamp", "nr|api|latency_p95", "prom|api|errors"]
    expected_timestamps = pd.to_datetime([1_000, 2_000, 3_000], unit="ms", utc=True).tolist()
    assert frame["timestamp"].tolist() == expected_timestamps
    assert pd.isna(frame.loc[0, "prom|api|errors"])
    assert pd.isna(frame.loc[2, "nr|api|latency_p95"])


def test_correlation_rejects_more_than_twenty_explicit_series(window):
    """Catches a correlation request that can exceed the bounded exploration scope."""
    start, end = window
    keys = [("source", f"entity-{index}", "metric") for index in range(21)]

    with pytest.raises(ValueError, match="20"):
        load_correlation_frame(object(), keys, start, end)
