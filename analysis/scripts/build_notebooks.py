"""Gera notebooks estáticos para exploração segura do dump Argus."""

import argparse
from pathlib import Path

from dump_explorer.notebook_builder import write_notebook


def build_notebook(identifier: str, path: Path | None = None) -> Path:
    """Gera o notebook identificado sem executar suas células."""
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


def main() -> None:
    """Lê o identificador solicitado e grava o notebook correspondente."""
    parser = argparse.ArgumentParser()
    parser.add_argument("identifier", choices=["00"])
    args = parser.parse_args()
    build_notebook(args.identifier)


if __name__ == "__main__":
    main()
