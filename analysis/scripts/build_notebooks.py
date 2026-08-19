"""Gera notebooks estáticos para exploração segura do dump Argus."""

import argparse
from pathlib import Path

from dump_explorer.notebook_builder import write_notebook


def build_notebook(identifier: str, path: Path | None = None) -> Path:
    """Gera o notebook identificado sem executar suas células."""
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


def main() -> None:
    """Lê o identificador solicitado e grava o notebook correspondente."""
    parser = argparse.ArgumentParser()
    parser.add_argument("identifier", choices=["00", "01"])
    args = parser.parse_args()
    build_notebook(args.identifier)


if __name__ == "__main__":
    main()
