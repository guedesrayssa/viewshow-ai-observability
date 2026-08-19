"""Gera notebooks estáticos para exploração segura do dump Argus."""

import argparse
from pathlib import Path

from dump_explorer.notebook_builder import write_notebook


def build_notebook(identifier: str, path: Path | None = None) -> Path:
    """Gera o notebook identificado sem executar suas células."""
    if identifier == "02":
        return _build_normalized_signals_notebook(path)
    if identifier == "01":
        return _build_quality_notebook(path)
    if identifier != "00":
        raise ValueError(f"Notebook não suportado: {identifier}")

    target = path or Path(__file__).parents[1] / "notebooks" / "00_catalogo_dataset.ipynb"
    return write_notebook(
        target,
        "Catálogo do dataset Argus",
        [
            (
                "markdown",
                """## Escopo da exploração

Este notebook explora o dump MySQL local do Argus. Ele não consulta BigQuery:
o dump é uma fotografia local e pode diferir da fonte analítica em cobertura e
atualização.""",
            ),
            (
                "code",
                """from dump_explorer.catalog import (
    EXPECTED_TABLES,
    compare_expected_tables,
    load_column_catalog,
    load_table_catalog,
)
from dump_explorer.charts import volume_bar
from dump_explorer.config import load_settings
from dump_explorer.database import create_db_engine

settings = load_settings()
engine = create_db_engine(settings)""",
            ),
            (
                "markdown",
                "## Catálogos disponíveis\n\nAs estimativas abaixo vêm dos metadados do MySQL.",
            ),
            (
                "code",
                """table_catalog = load_table_catalog(engine)
column_catalog = load_column_catalog(engine)

display(table_catalog)
display(column_catalog)""",
            ),
            (
                "markdown",
                "## Cobertura documentada\n\nCompare o dump com a lista esperada pelo laboratório.",
            ),
            (
                "code",
                """table_coverage = compare_expected_tables(
    actual=table_catalog["table_name"].tolist(),
    expected=EXPECTED_TABLES,
)
display(table_coverage)""",
            ),
            (
                "markdown",
                """## Volume por tabela

O gráfico está marcado como **estimativa do MySQL**. Contagens exatas não são computadas
para tabelas grandes, para preservar o dump e evitar consultas caras.""",
            ),
            ("code", "volume_bar(table_catalog).show()"),
        ],
    )


def _build_quality_notebook(path: Path | None = None) -> Path:
    """Gera o notebook de cobertura, cadência e saúde dos coletores."""
    target = path or Path(__file__).parents[1] / "notebooks" / "01_cobertura_qualidade.ipynb"
    return write_notebook(
        target,
        "Cobertura e qualidade do dump Argus",
        [
            (
                "markdown",
                """## Escopo e fuso horário

Os timestamps apresentados por este notebook estão em **UTC**. O BRT
(`America/Sao_Paulo`) deve ser aplicado apenas na visualização, nunca como
interpretação implícita dos dados de origem.""",
            ),
            (
                "code",
                """from dump_explorer.charts import (
    cadence_histogram,
    collector_timeline,
    coverage_heatmap,
    missingness_bar,
)
from dump_explorer.config import load_settings
from dump_explorer.database import create_db_engine
from dump_explorer.quality import (
    load_collector_health,
    load_missingness,
    load_series_cadence,
    load_source_coverage,
    load_source_daily_coverage,
    load_table_coverage,
)

settings = load_settings()
engine = create_db_engine(settings)""",
            ),
            (
                "markdown",
                "## 1. coverage by table\n\n"
                "Tabelas grandes usam estimativas; não há COUNT completo nelas.",
            ),
            (
                "code",
                "table_coverage = load_table_coverage(engine)\ndisplay(table_coverage)",
            ),
            (
                "markdown",
                "## 2. Cobertura por signal_bucket.source\n\n"
                "As épocas em milissegundos são convertidas para UTC.",
            ),
            (
                "code",
                "source_coverage = load_source_coverage(engine)\ndisplay(source_coverage)",
            ),
            (
                "markdown",
                "## 3. source x day heatmap\n\n"
                "Escolha uma janela finita em UTC para não executar varredura ampla.",
            ),
            (
                "code",
                """heatmap_start_ms = 0  # substitua por início UTC em epoch ms
heatmap_end_ms = 86_400_000  # substitua por fim UTC em epoch ms
source_day = load_source_daily_coverage(engine, heatmap_start_ms, heatmap_end_ms)
coverage_heatmap(source_day, x="day", y="source", value="rows").show()""",
            ),
            (
                "markdown",
                "## 4. Cadência para uma série selecionada\n\n"
                "A série usa source, entity, metric e [start, end).",
            ),
            (
                "code",
                """series_source = "newrelic"
series_entity = "service-name"
series_metric = "error_rate_pct"
series_start_ms = 0  # substitua por início UTC em epoch ms
series_end_ms = 86_400_000  # substitua por fim UTC em epoch ms
cadence = load_series_cadence(
    engine, series_source, series_entity, series_metric, series_start_ms, series_end_ms
)
cadence_histogram(cadence).show()""",
            ),
            (
                "markdown",
                "## 5. Resumo de nulos e desconhecidos\n\n"
                "Zero medido, nulo e ausência de bucket são estados distintos.",
            ),
            (
                "code",
                """small_table = "signal_bucket"
small_columns = ["source", "entity", "metric"]
missingness = load_missingness(engine, small_table, small_columns)
display(missingness)
missingness_bar(missingness).show()""",
            ),
            (
                "markdown",
                "## 6. Execuções dos coletores\n\nExecuções `incomplete` não têm `finished_at`.",
            ),
            (
                "code",
                """collector_health = load_collector_health(engine
)
display(collector_health)
collector_timeline(collector_health).show()""",
            ),
            (
                "markdown",
                """## 7. Watermark e chegadas tardias

NPAW apresenta aproximadamente **28 horas** de atraso estrutural. Portanto,
o watermark deve preservar uma janela de releitura para chegadas tardias. A
ausência de tickets não é um rótulo negativo confiável: pode refletir falta de
abertura, coleta ou cobertura, e não ausência do incidente.""",
            ),
        ],
    )


def _build_normalized_signals_notebook(path: Path | None = None) -> Path:
    """Gera o notebook de exploração das identidades normalizadas de sinais."""
    target = path or Path(__file__).parents[1] / "notebooks" / "02_sinais_normalizados.ipynb"
    return write_notebook(
        target,
        "Sinais normalizados do dump Argus",
        [
            (
                "markdown",
                """## Identidade natural e escopo

Uma métrica isolada não identifica uma série: `error_rate`, por exemplo, pode
existir em várias origens e entidades. Toda leitura usa a identidade completa
**source, entity, metric** e uma janela explícita `[start, end)` em UTC.""",
            ),
            (
                "code",
                """import plotly.graph_objects as go
from IPython.display import display
from ipywidgets import Dropdown, Output

from dump_explorer.charts import (
    METRIC_DIRECTION,
    correlation_heatmap,
    metric_timeline,
    source_metric_heatmap,
)
from dump_explorer.config import load_settings
from dump_explorer.database import create_db_engine
from dump_explorer.signals import (
    list_series,
    load_correlation_frame,
    load_metric_series,
    load_source_distribution,
)

settings = load_settings()
engine = create_db_engine(settings)
start_ms = 0  # substitua por início UTC em epoch ms
end_ms = 86_400_000  # substitua por fim UTC em epoch ms""",
            ),
            (
                "markdown",
                "## 1. Distribuição por source, entity e metric\n\n"
                "A janela é obrigatória e limitada; o notebook não faz varredura temporal "
                "implícita.",
            ),
            (
                "code",
                """source_distribution = load_source_distribution(engine, start_ms, end_ms)
display(source_distribution)

selected_source = source_distribution.iloc[0]["source"] if not source_distribution.empty else None
series_catalog = (
    list_series(engine, selected_source, start_ms, end_ms) if selected_source is not None else None
)
if series_catalog is not None:
    display(series_catalog)
    source_metric_heatmap(series_catalog).show()""",
            ),
            (
                "markdown",
                "## 2. Seletor interativo de série\n\n"
                "A seleção sempre preserva source, entity e metric; ela não escolhe apenas a "
                "métrica.",
            ),
            (
                "code",
                """series_options = [] if series_catalog is None else [
    (f"{row.source} | {row.entity} | {row.metric}", (row.source, row.entity, row.metric))
    for row in series_catalog.itertuples(index=False)
]
series_selector = Dropdown(options=series_options, description="Série:")
series_output = Output()
display(series_selector, series_output)

def render_selected_series(change=None):
    if series_selector.value is None:
        return
    source, entity, metric = series_selector.value
    selected_series = load_metric_series(engine, source, entity, metric, start_ms, end_ms)
    with series_output:
        series_output.clear_output(wait=True)
        metric_timeline(selected_series, metric=metric).show()
        display(selected_series.head())
    return selected_series

series_selector.observe(render_selected_series, names="value")
selected_series = render_selected_series()""",
            ),
            (
                "markdown",
                "## 3. Volume em 15 minutos e distribuição de valores\n\n"
                "O agrupamento abaixo conta observações por 15 minutos explicitamente; "
                "os valores da série não são reamostrados.",
            ),
            (
                "code",
                """if selected_series is not None:
    volume_15min = (
        selected_series.assign(bucket_15min=selected_series["timestamp"].dt.floor("15min"))
        .groupby("bucket_15min", as_index=False)
        .size()
    )
    go.Figure(go.Bar(x=volume_15min["bucket_15min"], y=volume_15min["size"])).update_layout(
        title="Volume de observações por 15 minutos", xaxis_title="UTC", yaxis_title="Observações"
    ).show()
    go.Figure(go.Histogram(x=selected_series["value"])).update_layout(
        title="Distribuição dos valores observados", xaxis_title="Valor", yaxis_title="Frequência"
    ).show()""",
            ),
            (
                "markdown",
                "## 4. Direção de degradação\n\n`METRIC_DIRECTION` apenas explica a direction "
                "da degradação: os valores armazenados nunca são invertidos. Métricas "
                "desconhecidas são `context_dependent`.",
            ),
            ("code", "display(METRIC_DIRECTION)"),
            (
                "markdown",
                "## 5. Correlação de séries selecionadas explicitamente\n\nEscolha até 20 "
                "identidades completas. Lacunas permanecem ausentes: a correlação não "
                "preenche valores faltantes com zero.",
            ),
            (
                "code",
                """correlation_keys = [
    # ("newrelic", "service-name", "error_rate_pct"),
    # ("prometheus", "service-name", "latency_p95"),
]
correlation_frame = load_correlation_frame(engine, correlation_keys, start_ms, end_ms)
display(correlation_frame)
correlation_heatmap(correlation_frame).show()""",
            ),
        ],
    )


def main() -> None:
    """Lê o identificador solicitado e grava o notebook correspondente."""
    parser = argparse.ArgumentParser()
    parser.add_argument("identifier", choices=["00", "01", "02"])
    args = parser.parse_args()
    build_notebook(args.identifier)


if __name__ == "__main__":
    main()
