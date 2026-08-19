"""Geração determinística de notebooks de exploração."""

from collections.abc import Sequence
from pathlib import Path
from typing import Literal

import nbformat

Section = tuple[Literal["markdown", "code"], str]


def write_notebook(path: Path, title: str, sections: Sequence[Section]) -> Path:
    """Escreve um notebook Python 3 sem execuções ou saídas persistidas."""
    cells = [nbformat.v4.new_markdown_cell(f"# {title}", id="cell-0")]
    for index, (kind, source) in enumerate(sections, start=1):
        if kind == "markdown":
            cell = nbformat.v4.new_markdown_cell(source, id=f"cell-{index}")
        elif kind == "code":
            cell = nbformat.v4.new_code_cell(
                source,
                execution_count=None,
                outputs=[],
                id=f"cell-{index}",
            )
        else:
            raise ValueError(f"Tipo de seção inválido: {kind}")
        cells.append(cell)

    notebook = nbformat.v4.new_notebook(
        cells=cells,
        metadata={
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3",
            },
            "language_info": {"name": "python"},
        },
    )
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    nbformat.write(notebook, target, version=4)
    return target
