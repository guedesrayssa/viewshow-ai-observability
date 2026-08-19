"""Behavioral contracts for the logical BigQuery ingestion catalogue."""

import sys
from pathlib import Path

import nbformat
import pandas as pd
import pytest

from dump_explorer.contract import (
    REQUIRED_CONTRACT_COLUMNS,
    build_logical_contract,
    export_contract_csv,
    validate_physical_mapping,
)
from scripts import build_notebooks
from scripts.build_notebooks import build_notebook


def test_contract_keeps_unknown_bigquery_physical_names_uninvented():
    """Catches substituting Argus/MySQL names for evidence not supplied by Globo."""
    frame = build_logical_contract()

    assert set(frame["bigquery_table"]) == {"não fornecido"}
    assert set(frame["bigquery_column"]) == {"não fornecido"}
    assert set(frame["bigquery_partition_column"]) == {"não fornecido"}
    assert set(frame["bigquery_write_watermark"]) == {"não fornecido"}


def test_contract_documents_npaw_delay_and_service_now_ticket_open_time():
    """Catches using NPAW as real-time data or relabelling ticket open as incident onset."""
    frame = build_logical_contract()

    player_timestamp = frame.query(
        "logical_table == 'player_hourly' and logical_field == 'hour_ts'"
    ).iloc[0]
    incident_timestamp = frame.query(
        "logical_table == 'incidents' and logical_field == 'opened_at'"
    ).iloc[0]

    assert player_timestamp["known_delay"] == "~28h"
    assert player_timestamp["event_timestamp"] is True
    assert incident_timestamp["event_timestamp"] is True
    assert "ticket-open" in incident_timestamp["logical_type"]
    assert "incident-start" in incident_timestamp["logical_type"]


def test_contract_has_required_metadata_and_keeps_event_samples_separate():
    """Catches a frontend sample presented as confirmed BigQuery."""
    frame = build_logical_contract()

    assert list(frame.columns) == list(REQUIRED_CONTRACT_COLUMNS)
    assert frame[list(REQUIRED_CONTRACT_COLUMNS)].notna().all().all()
    assert set(frame["logical_type"]) >= {"timestamp", "string", "integer"}
    assert set(frame["storage_recommendation"]) <= {"hot+cold", "cold"}
    assert set(frame["sensitivity"]) <= {"aggregate", "operational", "restricted"}
    assert set(frame.loc[frame["logical_table"] == "frontend_events_sample", "source_system"]) == {
        "amostra frontend; origem BigQuery não comprovada"
    }
    assert "frontend_events_sample" not in set(
        frame.loc[
            frame["source_system"] != "amostra frontend; origem BigQuery não comprovada",
            "logical_table",
        ]
    )


def test_mapping_validation_reports_each_unresolved_physical_contract_dimension():
    """Catches silently accepting a future BigQuery mapping without its ingestion guarantees."""
    issues = validate_physical_mapping(build_logical_contract())

    codes = {issue.code for issue in issues}
    assert {
        "missing_bigquery_table",
        "missing_bigquery_column",
        "missing_partition_column",
        "missing_write_watermark",
        "unknown_update_semantics",
    } <= codes


def test_mapping_validation_detects_duplicate_logical_key_candidate():
    """Catches a non-unique natural-key field before it becomes an idempotency key."""
    frame = build_logical_contract()
    duplicate = frame.loc[
        (frame["logical_table"] == "player_hourly") & (frame["logical_field"] == "hour_ts")
    ]

    issues = validate_physical_mapping(pd.concat([frame, duplicate], ignore_index=True))

    assert any(
        issue.code == "non_unique_key_candidate"
        and issue.logical_table == "player_hourly"
        and issue.logical_field == "hour_ts"
        for issue in issues
    )


def test_contract_export_is_confined_to_analysis_outputs():
    """Catches accidental writes of a generated contract outside the repository output directory."""
    frame = build_logical_contract()
    allowed = Path(__file__).parents[1] / "outputs" / "test-contract.csv"
    disallowed = Path(__file__).parents[1] / "test-contract.csv"

    try:
        exported = export_contract_csv(frame, allowed)
        assert exported == allowed.resolve()
        assert exported.exists()
        with pytest.raises(ValueError, match="analysis/outputs"):
            export_contract_csv(frame, disallowed)
    finally:
        allowed.unlink(missing_ok=True)


def test_notebook_07_separates_sources_and_leaves_export_opt_in(tmp_path):
    """Catches a notebook that infers BigQuery provenance or writes an artifact on open."""
    path = tmp_path / "07_contrato_ingestao.ipynb"

    build_notebook("07", path)

    notebook = nbformat.read(path, as_version=4)
    source = "\n".join(cell.source for cell in notebook.cells)
    assert "build_logical_contract" in source
    assert "validate_physical_mapping" in source
    assert "amostra frontend; origem BigQuery não comprovada" in source
    assert "export_csv = False" in source
    assert "if export_csv:" in source
    assert "OUTPUTS_DIR /" in source
    assert "project/dataset/table" in source
    assert "late arrivals" in source
    assert "corrections/deletes" in source
    assert all(cell.get("outputs", []) == [] for cell in notebook.cells)


def test_notebook_cli_accepts_identifier_07(monkeypatch):
    """Catches generating notebook 07 in-process while leaving the documented CLI unusable."""
    captured = {}
    monkeypatch.setattr(
        build_notebooks,
        "build_notebook",
        lambda identifier: captured.setdefault("identifier", identifier),
    )
    monkeypatch.setattr(sys, "argv", ["build_notebooks.py", "07"])

    build_notebooks.main()

    assert captured == {"identifier": "07"}
