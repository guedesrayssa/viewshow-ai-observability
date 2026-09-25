"""Verify the ingestion Dockerfile builds a secure production image."""

import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

SERVICE_ROOT = Path(__file__).parents[2]
DOCKERFILE = SERVICE_ROOT / "Dockerfile"
DOCKERIGNORE = SERVICE_ROOT / ".dockerignore"
SEMANTIC_SMOKE = SERVICE_ROOT.parents[2] / "scripts" / "ci" / "ingestion-container-smoke.py"


def test_dockerfile_is_batch_non_root_and_immutable() -> None:
    source = DOCKERFILE.read_text(encoding="utf-8")

    assert (
        "python:3.12.11-slim-bookworm@"
        "sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7" in source
    )
    assert "default-mysql-client=1.1.0" in source
    assert "useradd --create-home --uid 10001 ingestion" in source
    assert "--require-hashes -r requirements.txt" in source
    assert "ENV ARCHIVE_WORKDIR=/tmp/ingestion" in source
    assert "USER ingestion" in source
    assert 'ENTRYPOINT ["python", "-m", "bootstrap"]' in source
    assert "EXPOSE" not in source


def test_docker_context_excludes_local_environments_and_build_artifacts() -> None:
    patterns = set(DOCKERIGNORE.read_text(encoding="utf-8").splitlines())

    assert {
        ".venv*",
        ".mypy_cache*",
        ".pytest_cache*",
        ".ruff_cache*",
        "**/__pycache__",
        ".coverage*",
        "htmlcov",
        "build",
        "dist",
        "*.egg-info",
    } <= patterns


def test_semantic_container_smoke_exercises_record_spool(tmp_path: Path) -> None:
    assert SEMANTIC_SMOKE.is_file()
    completed = subprocess.run(
        [sys.executable, os.fspath(SEMANTIC_SMOKE)],
        cwd=SERVICE_ROOT,
        env={
            **os.environ,
            "ARCHIVE_WORKDIR": os.fspath(tmp_path),
            "INGESTION_SMOKE_EXPECT_UID": str(os.getuid()),
            "INGESTION_SMOKE_EXPECT_WORKDIR": os.fspath(tmp_path),
            "PYTHONPATH": os.fspath(SERVICE_ROOT),
        },
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == "record-spool-create-cleanup-ok"
    assert not (tmp_path / ".spool" / "container-smoke").exists()


@pytest.mark.skipif(shutil.which("docker") is None, reason="Docker is unavailable")
def test_linux_amd64_image_writes_and_cleans_spool_with_read_only_rootfs(
    request: pytest.FixtureRequest,
) -> None:
    tag = f"data-ingestion-service:pytest-{uuid.uuid4().hex}"

    def remove_test_image() -> None:
        subprocess.run(
            ["docker", "image", "rm", "--force", tag],
            check=False,
            capture_output=True,
        )

    request.addfinalizer(remove_test_image)
    subprocess.run(
        ["docker", "build", "--platform", "linux/amd64", "--tag", tag, "."],
        cwd=SERVICE_ROOT,
        check=True,
    )
    inspected = subprocess.run(
        ["docker", "image", "inspect", tag],
        check=True,
        capture_output=True,
        text=True,
    )
    image = json.loads(inspected.stdout)[0]

    assert image["Architecture"] == "amd64"
    assert image["Config"]["User"] == "ingestion"
    assert image["Config"]["Entrypoint"] == ["python", "-m", "bootstrap"]
    assert image["Config"].get("ExposedPorts") is None

    smoke = SEMANTIC_SMOKE.read_text(encoding="utf-8")
    completed = subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,mode=1777",
            "--network",
            "none",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--env",
            "INGESTION_SMOKE_EXPECT_UID=10001",
            "--env",
            "INGESTION_SMOKE_EXPECT_WORKDIR=/tmp/ingestion",
            "--entrypoint",
            "python",
            tag,
            "-c",
            smoke,
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == "record-spool-create-cleanup-ok"
