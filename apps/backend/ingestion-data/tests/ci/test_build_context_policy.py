"""Enforce the production image build-context allowlist for ingestion."""

import json
import re
from pathlib import Path

import pathspec

SERVICE_ROOT = Path(__file__).parents[2]
TERRAFORM_INGESTION = SERVICE_ROOT.parents[1] / "fullstack" / "ingestion-ecs.tf"

ARTIFACT_PATHS = (
    "adapters/.git/config",
    "adapters/.gitignore",
    "adapters/__pycache__/client.cpython-312.pyc",
    "adapters/cache.pyc/data",
    "application/.pytest_cache/v/cache.json",
    "bootstrap/.env/data",
    "bootstrap/.env.local/data",
    "bootstrap/.coverage.worker",
    "bootstrap/.coverage.worker/data",
    "contracts/argus/v2/schema.log",
    "contracts/argus/v2/schema.log/data",
    "domain/state.sqlite",
    "domain/state.sqlite-wal",
    "domain/state.sqlite-backup",
    "domain/state.sqlite-wal/page",
    "ports/cache.db-shm",
    "ports/cache.db-backup",
    "ports/cache.db-backup/page",
    "adapters/.spool/window/part.parquet",
    "adapters/output.parquet/part",
    "scripts/tests/fixture.json",
    "scripts/requirements-dev.txt",
    "adapters/spool/window/chunk.json",
    "scripts/tmp/result.json",
    "scripts/temp/result.json",
    "scripts/.tmp/result.json",
    "scripts/.temp/result.json",
    "scripts/result.spool",
    "scripts/cache.spool/result.json",
    "scripts/result.temp",
    "scripts/cache.tmp/result.json",
    "scripts/cache.temp/result.json",
)

RUNTIME_PATHS = (
    "adapters/archive/parquet.py",
    "application/sync.py",
    "application/temporary.py",
    "contracts/argus/v2/descriptors/live_event.json",
    "contracts/argus/v2/db_schema.sql",
    "contracts/argus/v2/README.md",
    "domain/spooler.py",
    "domain/sqlite_codec.py",
    "scripts/run_task.py",
)


def _terraform_hash_exclusions() -> tuple[str, ...]:
    source = TERRAFORM_INGESTION.read_text(encoding="utf-8")
    block = re.search(
        r"ingestion_build_excluded_path_patterns\s*=\s*\[(.*?)\n\s*\]",
        source,
        flags=re.DOTALL,
    )
    assert block is not None, "Terraform hash exclusion policy not found"
    return tuple(
        json.loads(f'"{value}"') for value in re.findall(r'"((?:\\.|[^"\\])*)"', block.group(1))
    )


def test_hash_and_docker_context_agree_for_artifacts_and_runtime_files() -> None:
    hash_exclusions = _terraform_hash_exclusions()
    dockerignore = pathspec.PathSpec.from_lines(
        "gitignore",
        (SERVICE_ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines(),
    )

    for path in ARTIFACT_PATHS:
        hash_ignores = any(re.search(pattern, path) for pattern in hash_exclusions)
        docker_ignores = dockerignore.match_file(path)
        assert hash_ignores == docker_ignores, f"policies disagree for artifact {path}"
        assert hash_ignores, f"policies unexpectedly include artifact {path}"

    for path in RUNTIME_PATHS:
        hash_ignores = any(re.search(pattern, path) for pattern in hash_exclusions)
        docker_ignores = dockerignore.match_file(path)
        assert hash_ignores == docker_ignores, f"policies disagree for runtime file {path}"
        assert not hash_ignores, f"policies unexpectedly exclude runtime file {path}"
