"""Verify the ingestion command-line interface exposes supported batch commands."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

SERVICE_ROOT = Path(__file__).parents[2]


def test_module_entrypoint_reports_only_batch_commands() -> None:
    completed = subprocess.run(
        [sys.executable, "-m", "bootstrap", "--help"],
        cwd=SERVICE_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0
    assert completed.stderr == ""
    assert (
        "{validate,backfill,import-dump,sync,reprocess,rebuild-projections,"
        "publish-outbox,export-incremental,ingest-incremental}" in completed.stdout
    )
    assert "serve" not in completed.stdout
    assert "http" not in completed.stdout.lower()
