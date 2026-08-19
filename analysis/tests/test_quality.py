import pandas as pd
import pytest

import dump_explorer.quality as quality
from dump_explorer.quality import (
    TABLE_TIME_COLUMNS,
    load_collector_health,
    load_missingness,
    load_series_cadence,
    load_source_coverage,
    load_source_daily_coverage,
    load_table_coverage,
)


def test_coverage_uses_each_tables_documented_timestamp():
    """Catches an accidental timestamp-column substitution per table."""
    assert TABLE_TIME_COLUMNS["signal_bucket"] == "bts"
    assert TABLE_TIME_COLUMNS["prom_point"] == "epoch_ms"
    assert TABLE_TIME_COLUMNS["live_active_15min"] == "bucket_ts"


def test_cadence_requires_a_bounded_window():
    """Catches unbounded cadence reads over the signal bucket history."""
    with pytest.raises(ValueError, match=r"start.*end"):
        load_series_cadence(object(), "newrelic", "svc", "error_rate_pct", None, None)


def test_table_coverage_uses_exact_counts_only_for_non_heavy_allowlisted_tables(monkeypatch):
    """Catches exact COUNT scans of the heavy point tables or input identifiers in SQL."""
    queries = []

    def fake_read_frame(engine, statement, **kwargs):
        sql = str(statement)
        queries.append(sql)
        if "information_schema.tables" in sql:
            return pd.DataFrame({"estimated_rows": [700]})
        return pd.DataFrame(
            {"rows_count": [4], "first_ts": [1000], "last_ts": [2000]}
        )

    monkeypatch.setattr(quality, "read_frame", fake_read_frame)

    frame = load_table_coverage(
        object(), tables=["signal_bucket", "prom_point", "not_a_table"]
    )

    assert frame.to_dict("records") == [
        {
            "table_name": "signal_bucket",
            "rows": 4,
            "first_ts": 1000,
            "last_ts": 2000,
            "count_kind": "exact",
        },
        {
            "table_name": "prom_point",
            "rows": 700,
            "first_ts": 1000,
            "last_ts": 2000,
            "count_kind": "estimate",
        },
    ]
    assert any("COUNT(*)" in query and "signal_bucket" in query for query in queries)
    assert not any("COUNT(*)" in query and "prom_point" in query for query in queries)
    assert not any("not_a_table" in query for query in queries)


def test_source_coverage_converts_signal_bucket_epochs_to_utc(monkeypatch):
    """Catches treating signal_bucket milliseconds as a local or naive timestamp."""
    captured = {}

    def fake_read_frame(engine, statement, **kwargs):
        captured["sql"] = str(statement)
        return pd.DataFrame(
            {"source": ["newrelic"], "rows": [2], "first_ts": [0], "last_ts": [3_600_000]}
        )

    monkeypatch.setattr(quality, "read_frame", fake_read_frame)

    frame = load_source_coverage(object())

    assert frame.loc[0, "first_ts"] == pd.Timestamp("1970-01-01T00:00:00Z")
    assert frame.loc[0, "last_ts"] == pd.Timestamp("1970-01-01T01:00:00Z")
    assert "signal_bucket" in captured["sql"]
    assert "GROUP BY source" in captured["sql"]


def test_source_daily_coverage_requires_bounds_and_groups_utc_days(monkeypatch):
    """Catches a broad daily scan or grouping signal buckets in the session timezone."""
    with pytest.raises(ValueError, match=r"start.*end"):
        load_source_daily_coverage(object(), None, None)

    captured = {}

    def fake_read_frame(engine, statement, params=None, **kwargs):
        captured["sql"] = str(statement)
        captured["params"] = params
        return pd.DataFrame({"source": ["newrelic"], "day_epoch_ms": [0], "rows": [2]})

    monkeypatch.setattr(quality, "read_frame", fake_read_frame)

    frame = load_source_daily_coverage(object(), 0, 86_400_000)

    assert captured["params"] == {"start": 0, "end": 86_400_000}
    assert "FLOOR(bts / 86400000)" in captured["sql"]
    assert frame.loc[0, "day"] == pd.Timestamp("1970-01-01T00:00:00Z")


def test_cadence_filters_full_identity_with_bound_parameters(monkeypatch):
    """Catches an unparameterized or partially filtered signal series query."""
    captured = {}

    def fake_read_frame(engine, statement, params=None, **kwargs):
        captured["sql"] = str(statement)
        captured["params"] = params
        return pd.DataFrame({"bts": [1000], "previous_bts": [None]})

    monkeypatch.setattr(quality, "read_frame", fake_read_frame)

    frame = load_series_cadence(
        object(), "newrelic", "svc", "error_rate_pct", 1000, 2000
    )

    assert captured["params"] == {
        "source": "newrelic",
        "entity": "svc",
        "metric": "error_rate_pct",
        "start": 1000,
        "end": 2000,
    }
    assert "LAG(bts) OVER (ORDER BY bts)" in captured["sql"]
    assert "bts >= :start" in captured["sql"]
    assert "bts < :end" in captured["sql"]
    assert frame.loc[0, "bts"] == pd.Timestamp("1970-01-01T00:00:01Z")
    assert pd.isna(frame.loc[0, "cadence_s"])


def test_missingness_uses_validated_catalog_columns_and_only_aggregate_counts(monkeypatch):
    """Catches raw-value reads or SQL made from an unvalidated column name."""
    captured = {}

    def fake_columns(engine):
        return pd.DataFrame(
            {
                "table_name": ["signal_bucket", "signal_bucket"],
                "column_name": ["source", "value"],
            }
        )

    def fake_read_frame(engine, statement, **kwargs):
        captured["sql"] = str(statement)
        return pd.DataFrame({"row_count": [10], "source_null_count": [1], "value_null_count": [0]})

    monkeypatch.setattr(quality, "load_column_catalog", fake_columns)
    monkeypatch.setattr(quality, "read_frame", fake_read_frame)

    frame = load_missingness(object(), "signal_bucket", ["source", "missing", "value"])

    assert frame.to_dict("records") == [
        {
            "table_name": "signal_bucket",
            "column_name": "source",
            "null_count": 1,
            "row_count": 10,
            "null_pct": 10.0,
        },
        {
            "table_name": "signal_bucket",
            "column_name": "value",
            "null_count": 0,
            "row_count": 10,
            "null_pct": 0.0,
        },
    ]
    assert "source_null_count" in captured["sql"]
    assert "missing" not in captured["sql"]
    assert "SELECT source" not in captured["sql"]


def test_missingness_accepts_a_small_table_only_when_the_catalog_allows_it(monkeypatch):
    """Catches rejecting a catalogued small table solely because it lacks a time mapping."""
    monkeypatch.setattr(
        quality,
        "load_column_catalog",
        lambda engine: pd.DataFrame(
            {"table_name": ["apollo_run"], "column_name": ["events_written"]}
        ),
    )
    monkeypatch.setattr(
        quality,
        "read_frame",
        lambda engine, statement, **kwargs: pd.DataFrame(
            {"row_count": [2], "events_written_null_count": [1]}
        ),
    )

    frame = load_missingness(object(), "apollo_run", ["events_written"])

    assert frame.loc[0, "null_pct"] == 50.0


@pytest.mark.parametrize("table_name", ["signal_point", "prom_point"])
def test_missingness_rejects_heavy_tables_before_any_count_query(monkeypatch, table_name):
    """Catches a full-table null COUNT against either heavy point table."""
    monkeypatch.setattr(
        quality,
        "load_column_catalog",
        lambda engine: pd.DataFrame(
            {"table_name": [table_name], "column_name": ["value"]}
        ),
    )
    monkeypatch.setattr(
        quality,
        "read_frame",
        lambda *args, **kwargs: pytest.fail("a tabela pesada não deve ser consultada"),
    )

    with pytest.raises(ValueError, match="pesada"):
        load_missingness(object(), table_name, ["value"])


def test_collector_health_normalizes_real_write_columns_and_legacy_iso_utc(monkeypatch):
    """Catches treating ISO collector times as epochs or losing a zero write count."""
    write_columns = {
        "apollo_run": "events_written",
        "nr_run": "metrics_written",
        "prom_run": "samples_written",
        "rpaas_run": "buckets_written",
        "ca_run": "checks_written",
    }

    monkeypatch.setattr(
        quality,
        "load_column_catalog",
        lambda engine: pd.DataFrame(
            [
                {"table_name": table, "column_name": column}
                for table, write_column in write_columns.items()
                for column in ("started_at", "finished_at", write_column)
            ]
        ),
    )

    def fake_read_frame(engine, statement, **kwargs):
        table = next(name for name in write_columns if f"`{name}`" in str(statement))
        return pd.DataFrame(
            {
                "started_at": ["2026-08-19T09:00:00+00:00"],
                "finished_at": [None if table == "nr_run" else "2026-08-19T09:00:03+00:00"],
                "rows_written": [0 if table == "apollo_run" else 7],
            }
        )

    monkeypatch.setattr(quality, "read_frame", fake_read_frame)

    frame = load_collector_health(object())

    assert frame.columns.tolist() == [
        "collector",
        "started_at",
        "finished_at",
        "duration_s",
        "rows_written",
        "status",
    ]
    assert frame.loc[0, "started_at"] == pd.Timestamp("2026-08-19T09:00:00Z")
    assert frame.loc[0, "rows_written"] == 0
    assert frame.loc[0, "status"] == "complete"
    incomplete = frame.loc[frame["collector"] == "nr", :].iloc[0]
    assert incomplete["status"] == "incomplete"
    assert pd.isna(incomplete["duration_s"])


def test_collector_health_uses_the_explicit_write_count_for_each_table(monkeypatch):
    """Catches choosing a generic catalog field before a collector's real write count."""
    write_columns = {
        "apollo_run": "events_written",
        "nr_run": "metrics_written",
        "prom_run": "samples_written",
        "rpaas_run": "buckets_written",
        "ca_run": "checks_written",
    }
    monkeypatch.setattr(
        quality,
        "load_column_catalog",
        lambda engine: pd.DataFrame(
            [
                {"table_name": table, "column_name": column}
                for table, write_column in write_columns.items()
                for column in ("started_at", "finished_at", "rows_written", write_column)
            ]
        ),
    )
    queries = []

    def fake_read_frame(engine, statement, **kwargs):
        queries.append(str(statement))
        return pd.DataFrame(columns=["started_at", "finished_at", "rows_written"])

    monkeypatch.setattr(quality, "read_frame", fake_read_frame)

    load_collector_health(object())

    for table, write_column in write_columns.items():
        query = next(query for query in queries if f"`{table}`" in query)
        assert f"`{write_column}` AS rows_written" in query


def test_collector_health_rejects_a_collector_missing_its_mapped_write_count(monkeypatch):
    """Catches silently falling back to another write-like column when the real one is absent."""
    monkeypatch.setattr(
        quality,
        "load_column_catalog",
        lambda engine: pd.DataFrame(
            {
                "table_name": ["apollo_run", "apollo_run", "apollo_run"],
                "column_name": ["started_at", "finished_at", "rows_written"],
            }
        ),
    )
    monkeypatch.setattr(
        quality,
        "read_frame",
        lambda *args, **kwargs: pytest.fail("não deve consultar sem o campo mapeado"),
    )

    with pytest.raises(ValueError, match="events_written"):
        load_collector_health(object())
