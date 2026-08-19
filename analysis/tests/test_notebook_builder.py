import nbformat

from dump_explorer.notebook_builder import write_notebook
from scripts.build_notebooks import build_notebook


def test_write_notebook_is_deterministic_and_clears_execution_state(tmp_path):
    path = tmp_path / "catalog.ipynb"
    sections = [("markdown", "## Catálogo"), ("code", "print('sem output')")]

    returned = write_notebook(path, "Catálogo Argus", sections)
    first_bytes = path.read_bytes()
    write_notebook(path, "Catálogo Argus", sections)
    notebook = nbformat.read(path, as_version=4)

    assert returned == path
    assert path.read_bytes() == first_bytes
    assert notebook.nbformat == 4
    assert notebook.metadata.kernelspec.name == "python3"
    assert notebook.cells[0].source == "# Catálogo Argus"
    assert notebook.cells[2].execution_count is None
    assert notebook.cells[2].outputs == []


def test_build_notebook_00_includes_catalog_and_safety_context(tmp_path):
    path = tmp_path / "00_catalogo_dataset.ipynb"

    build_notebook("00", path)

    notebook = nbformat.read(path, as_version=4)
    source = "\n".join(cell.source for cell in notebook.cells)

    assert "BigQuery" in source
    assert "load_settings" in source
    assert "load_table_catalog" in source
    assert "compare_expected_tables" in source
    assert "estimativa do MySQL" in source
    assert "não são computadas" in source
    assert all(cell.get("outputs", []) == [] for cell in notebook.cells)
