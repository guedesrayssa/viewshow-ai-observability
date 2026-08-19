"""Smoke tests for the smallest isolated MySQL notebook fixture."""

import os
from pathlib import Path

import nbformat
import pytest
from nbclient import NotebookClient

from scripts.load_test_fixture import load_test_fixture

ANALYSIS_DIR = Path(__file__).resolve().parents[2]
NOTEBOOKS = ANALYSIS_DIR / "notebooks"
FIXTURE_SETUP_COMMAND = (
    "rtk docker compose up -d mysql\n"
    "rtk python scripts/load_test_fixture.py\n"
    "ARGUS_TEST_DATABASE_URL=mysql+pymysql://root:change-root-me@127.0.0.1:3307/argus_test"
    "?charset=utf8mb4 "
    "\\\n"
    "  rtk python -m pytest tests/integration/test_notebooks.py -v"
)


@pytest.fixture
def mysql_fixture_url():
    """Recreate only the explicitly configured local test schema."""
    database_url = os.environ.get("ARGUS_TEST_DATABASE_URL")
    if not database_url:
        pytest.skip(f"Configure the fixture first:\n{FIXTURE_SETUP_COMMAND}")
    load_test_fixture(database_url)
    return database_url


@pytest.mark.integration
def test_catalog_and_quality_notebooks_execute(mysql_fixture_url, monkeypatch):
    monkeypatch.setenv("ARGUS_DATABASE_URL", mysql_fixture_url)
    for name in ["00_catalogo_dataset.ipynb", "01_cobertura_qualidade.ipynb"]:
        notebook = nbformat.read(NOTEBOOKS / name, as_version=4)
        client = NotebookClient(notebook, timeout=120, kernel_name="python3")
        client.execute()
