"""Repository-level safety and reproducibility tests for generated notebooks."""

from pathlib import Path

import nbformat

from scripts.build_notebooks import build_notebook

ANALYSIS_DIR = Path(__file__).resolve().parents[1]
NOTEBOOKS = ANALYSIS_DIR / "notebooks"
EXPECTED_NOTEBOOKS = tuple(
    f"{number:02d}_{name}.ipynb"
    for number, name in enumerate(
        (
            "catalogo_dataset",
            "cobertura_qualidade",
            "sinais_normalizados",
            "infraestrutura_qos",
            "experiencia_qoe",
            "incidentes_rca",
            "eventos_ao_vivo",
            "contrato_ingestao",
        )
    )
)
FORBIDDEN_MARKERS = ("password=", "@", "cpf", "cnpj", "session id", "user id")


def test_versioned_notebooks_are_clean_complete_and_free_of_identifier_markers():
    for name in EXPECTED_NOTEBOOKS:
        path = NOTEBOOKS / name
        assert path.is_file()
        notebook = nbformat.read(path, as_version=4)
        assert notebook.cells[0].cell_type == "markdown"
        assert notebook.cells[0].source.startswith("# ")
        assert any(cell.cell_type == "code" for cell in notebook.cells)
        assert all(cell.get("execution_count") is None for cell in notebook.cells)
        assert all(cell.get("outputs", []) == [] for cell in notebook.cells)
        source = "\n".join(cell.source for cell in notebook.cells).lower()
        assert not any(marker in source for marker in FORBIDDEN_MARKERS)


def test_all_generated_notebooks_are_byte_stable(tmp_path):
    first = {}
    for number, name in enumerate(EXPECTED_NOTEBOOKS):
        target = tmp_path / name
        build_notebook(f"{number:02d}", target)
        first[target.name] = target.read_bytes()

    for number, name in enumerate(EXPECTED_NOTEBOOKS):
        target = tmp_path / name
        build_notebook(f"{number:02d}", target)
        assert target.read_bytes() == first[target.name]
