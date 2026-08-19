import pandas as pd

from dump_explorer.charts import (
    cadence_histogram,
    collector_timeline,
    correlation_heatmap,
    coverage_heatmap,
    empty_figure,
    metric_timeline,
    missingness_bar,
    source_metric_heatmap,
    volume_bar,
)


def test_empty_figure_explains_absent_data():
    figure = empty_figure("Sem dados para o período selecionado")

    assert figure.layout.annotations[0].text == "Sem dados para o período selecionado"


def test_volume_bar_returns_empty_state_for_empty_catalog():
    figure = volume_bar(pd.DataFrame(columns=["table_name", "estimated_rows"]))

    assert "Sem dados" in figure.layout.annotations[0].text


def test_volume_bar_renders_one_trace_for_catalog_volume():
    figure = volume_bar(
        pd.DataFrame({"table_name": ["signal_bucket"], "estimated_rows": [1200]})
    )

    assert len(figure.data) == 1
    assert figure.data[0].type == "bar"
    assert list(figure.data[0].y) == [1200]


def test_coverage_heatmap_renders_one_heatmap_trace():
    figure = coverage_heatmap(
        pd.DataFrame({"day": ["2026-08-06"], "region": ["br"], "coverage": [3]}),
        x="day",
        y="region",
        value="coverage",
    )

    assert len(figure.data) == 1
    assert figure.data[0].type == "heatmap"


def test_coverage_heatmap_keeps_missing_buckets_distinct_from_measured_zeroes():
    frame = pd.DataFrame(
        {
            "day": ["2026-08-06", "2026-08-07"],
            "source": ["newrelic", "newrelic"],
            "coverage": [0, 1],
        }
    )

    figure = coverage_heatmap(frame, x="day", y="source", value="coverage")

    assert figure.layout.plot_bgcolor != figure.data[0].colorscale[0][1]


def test_missingness_bar_has_bar_trace_and_explicit_null_percent_axis():
    figure = missingness_bar(pd.DataFrame({"column_name": ["status"], "null_pct": [2.5]}))

    assert figure.data[0].type == "bar"
    assert figure.layout.xaxis.title.text == "Coluna"
    assert figure.layout.yaxis.title.text == "Valores nulos (%)"


def test_cadence_histogram_has_histogram_trace_and_seconds_axis():
    figure = cadence_histogram(pd.DataFrame({"cadence_s": [60.0, 120.0]}))

    assert figure.data[0].type == "histogram"
    assert figure.layout.xaxis.title.text == "Cadência entre pontos (s)"
    assert figure.layout.yaxis.title.text == "Frequência"


def test_collector_timeline_has_scatter_trace_and_utc_start_axis():
    figure = collector_timeline(
        pd.DataFrame(
            {
                "collector": ["nr"],
                "started_at": [pd.Timestamp("2026-08-19T09:00:00Z")],
                "status": ["incomplete"],
            }
        )
    )

    assert figure.data[0].type == "scatter"
    assert figure.layout.xaxis.title.text == "Início da execução (UTC)"
    assert figure.layout.yaxis.title.text == "Coletor"


def test_metric_timeline_surfaces_lower_is_worse_without_inverting_values():
    """Catches hiding Apdex degradation direction or inverting its stored values."""
    figure = metric_timeline(
        pd.DataFrame(
            {"timestamp": pd.to_datetime([1_000, 2_000], unit="ms", utc=True), "value": [0.8, 0.6]}
        ),
        metric="apdex_score",
    )

    assert figure.data[0].type == "scatter"
    assert list(figure.data[0].y) == [0.8, 0.6]
    assert "lower_is_worse" in figure.layout.title.text


def test_source_metric_heatmap_renders_source_and_metric_distribution():
    """Catches replacing the source-by-metric distribution with a non-matrix chart."""
    figure = source_metric_heatmap(
        pd.DataFrame(
            {"source": ["nr", "prom"], "metric": ["errors", "errors"], "rows": [2, 3]}
        )
    )

    assert figure.data[0].type == "heatmap"
    assert list(figure.data[0].x) == ["errors"]
    assert list(figure.data[0].y) == ["nr", "prom"]


def test_correlation_heatmap_keeps_missing_observations_out_of_the_matrix():
    """Catches zero-filling before calculating correlations."""
    frame = pd.DataFrame(
        {
            "timestamp": pd.to_datetime([1_000, 2_000, 3_000], unit="ms", utc=True),
            "nr|api|p95": [10.0, 20.0, None],
            "prom|api|errors": [None, 1.0, 3.0],
        }
    )

    figure = correlation_heatmap(frame)

    assert figure.data[0].type == "heatmap"
    assert pd.isna(figure.data[0].z[0][1])
