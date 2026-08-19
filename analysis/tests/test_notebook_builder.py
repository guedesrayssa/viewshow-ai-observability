import nbformat

from dump_explorer.notebook_builder import write_notebook
from scripts.build_notebooks import build_all_notebooks, build_notebook


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


def test_build_notebook_01_includes_quality_sections_and_limits(tmp_path):
    path = tmp_path / "01_cobertura_qualidade.ipynb"

    build_notebook("01", path)

    notebook = nbformat.read(path, as_version=4)
    source = "\n".join(cell.source for cell in notebook.cells)

    assert "coverage by table" in source
    assert "signal_bucket.source" in source
    assert "source x day" in source
    assert "Cadência" in source
    assert "nulos" in source
    assert "incomplete" in source
    assert "28 horas" in source
    assert "ausência de tickets" in source
    assert "watermark" in source
    assert all(cell.get("outputs", []) == [] for cell in notebook.cells)


def test_build_notebook_02_includes_normalized_series_and_explicit_correlation(tmp_path):
    """Catches omitting natural identity, selector, or the no-zero-fill correlation warning."""
    path = tmp_path / "02_sinais_normalizados.ipynb"

    build_notebook("02", path)

    notebook = nbformat.read(path, as_version=4)
    source = "\n".join(cell.source for cell in notebook.cells)

    assert "source, entity, metric" in source
    assert "Dropdown" in source
    assert "15 minutos" in source
    assert "direction" in source
    assert "correlation" in source
    assert "zero" in source
    assert all(cell.get("outputs", []) == [] for cell in notebook.cells)


def test_build_notebook_03_includes_qos_sources_and_semantic_warnings(tmp_path):
    """Catches omitting a QoS source or treating cgroup/sampled RPaaS data as literal facts."""
    path = tmp_path / "03_infraestrutura_qos.ipynb"

    build_notebook("03", path)

    notebook = nbformat.read(path, as_version=4)
    source = "\n".join(cell.source for cell in notebook.cells)

    assert "load_newrelic" in source
    assert "load_apollo" in source
    assert "load_rpaas" in source
    assert "load_cloudarmor" in source
    assert "load_prometheus" in source
    assert "load_tsuru_events" in source
    assert "cgroup" in source
    assert "1%" in source
    assert "autoscale.run" in source
    assert "event_overlay_timeline" in source
    assert all(cell.get("outputs", []) == [] for cell in notebook.cells)


def test_build_notebook_04_includes_qoe_aggregates_and_npaw_delay(tmp_path):
    """Catches omitting QoE dimensions, live semantics, or the known 28-hour delayed coverage."""
    path = tmp_path / "04_experiencia_qoe.ipynb"

    build_notebook("04", path)

    notebook = nbformat.read(path, as_version=4)
    source = "\n".join(cell.source for cell in notebook.cells)

    assert "load_player_qoe" in source
    assert "load_device_qoe" in source
    assert "load_geo_qoe" in source
    assert "load_live_qoe" in source
    assert "load_live_active" in source
    assert "load_error_categories" in source
    assert "28 horas" in source
    assert "concorrentes" in source
    assert "ratio" in source
    assert "segundos" in source
    assert "milissegundos" in source
    assert "Sem dados" not in source
    assert all(cell.get("outputs", []) == [] for cell in notebook.cells)


def test_build_notebook_06_includes_epg_audience_qoe_and_missing_telemetry_context(tmp_path):
    """Catches a notebook that hides feed identity, Globo approximation, or absent QoE."""
    path = tmp_path / "06_eventos_ao_vivo.ipynb"

    build_notebook("06", path)

    notebook = nbformat.read(path, as_version=4)
    source = "\n".join(cell.source for cell in notebook.cells)

    assert "load_live_events" in source
    assert "load_event_audience" in source
    assert "build_event_comparison" in source
    assert "event_audience_timeline" in source
    assert "event_impact_scatter" in source
    assert "event_key" in source
    assert "tid" in source
    assert "15 minutos" in source
    assert "national_family_approximation" in source
    assert "telemetry_available" in source
    assert all(cell.get("outputs", []) == [] for cell in notebook.cells)


def test_build_all_notebooks_writes_each_expected_notebook(tmp_path):
    written = build_all_notebooks(tmp_path)

    assert [path.name for path in written] == [
        "00_catalogo_dataset.ipynb",
        "01_cobertura_qualidade.ipynb",
        "02_sinais_normalizados.ipynb",
        "03_infraestrutura_qos.ipynb",
        "04_experiencia_qoe.ipynb",
        "05_incidentes_rca.ipynb",
        "06_eventos_ao_vivo.ipynb",
        "07_contrato_ingestao.ipynb",
    ]
    assert all(path.is_file() for path in written)
