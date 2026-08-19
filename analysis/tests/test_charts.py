import pandas as pd

from dump_explorer.charts import coverage_heatmap, empty_figure, volume_bar


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
