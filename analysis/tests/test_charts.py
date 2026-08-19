import pandas as pd

from dump_explorer.charts import (
    cadence_histogram,
    collector_timeline,
    coverage_heatmap,
    empty_figure,
    missingness_bar,
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
