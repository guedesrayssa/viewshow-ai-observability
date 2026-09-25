"""Verify CI pipeline commands and configuration protect ingestion delivery."""

from __future__ import annotations

import re
import shlex
import subprocess
import sys
from pathlib import Path

import yaml

SERVICE_ROOT = Path(__file__).parents[2]
REPOSITORY_ROOT = SERVICE_ROOT.parents[2]
PIPELINE = (REPOSITORY_ROOT / ".gitlab-ci.yml").read_text(encoding="utf-8")
PIPELINE_CONFIG = yaml.safe_load(PIPELINE)
PUBLISHER = (REPOSITORY_ROOT / "scripts/ci/publish-ingestion-image.sh").read_text(encoding="utf-8")
SMOKE = (REPOSITORY_ROOT / "scripts/ci/smoke-ingestion-container.sh").read_text(encoding="utf-8")


def _job(name: str) -> str:
    expression = rf"^{re.escape(name)}:\n(?P<body>.*?)(?=^\S[^\n]*:\n|\Z)"
    match = re.search(expression, PIPELINE, re.M | re.S)
    assert match is not None, f"missing job {name}"
    return match.group("body")


def _collected_mysql_nodes(pytest_command: str) -> set[str]:
    arguments = shlex.split(pytest_command)
    assert arguments[:3] == ["python", "-m", "pytest"]
    selection = [argument for argument in arguments[3:] if not argument.startswith("--junitxml=")]
    completed = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", *selection],
        cwd=SERVICE_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return {line for line in completed.stdout.splitlines() if "::" in line}


def test_ingestion_jobs_validate_merge_requests_and_publish_only_immutable_digest() -> None:
    validate = _job("validate_ingestion")
    mysql = _job("validate_ingestion_mysql")
    container = _job("validate_ingestion_container")
    publish = _job("publish_ingestion_image")

    for job in (validate, mysql, container):
        assert 'CI_PIPELINE_SOURCE == "merge_request_event"' in job
        assert 'CI_MERGE_REQUEST_TARGET_BRANCH_NAME == "develop"' in job
        assert 'CI_PIPELINE_SOURCE == "push"' in job
        assert 'CI_COMMIT_BRANCH == "develop"' in job
        assert "environment:" not in job
        assert "aws " not in job
    assert 'CI_PIPELINE_SOURCE == "push"' in publish
    assert 'CI_COMMIT_BRANCH == "develop"' in publish
    assert "merge_request_event" not in publish
    assert "ingestion-image.env" in publish
    assert "INGESTION_IMAGE_DIGEST" in publish
    assert "@${INGESTION_IMAGE_DIGEST}" in publish


def test_semantic_smoke_change_triggers_ingestion_validation_jobs() -> None:
    semantic_smoke = "scripts/ci/ingestion-container-smoke.py"
    for job_name in ("validate_ingestion", "validate_ingestion_container"):
        job = PIPELINE_CONFIG[job_name]
        assert isinstance(job, dict)
        rules = job["rules"]
        assert isinstance(rules, list)
        assert all(
            isinstance(rule, dict)
            and isinstance(rule.get("changes"), list)
            and semantic_smoke in rule["changes"]
            for rule in rules
        )


def test_develop_push_cannot_publish_before_mysql_and_container_gates() -> None:
    assert isinstance(PIPELINE_CONFIG, dict)
    required_gates = {
        "validate_ingestion",
        "validate_ingestion_mysql",
        "validate_ingestion_container",
    }
    for job_name in required_gates:
        job = PIPELINE_CONFIG[job_name]
        assert isinstance(job, dict)
        rules = job["rules"]
        assert isinstance(rules, list)
        assert any(
            isinstance(rule, dict)
            and rule.get("if") == '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "develop"'
            for rule in rules
        )

    publish = PIPELINE_CONFIG["publish_ingestion_image"]
    assert isinstance(publish, dict)
    needs = publish["needs"]
    assert isinstance(needs, list)
    required_need_jobs = {
        need["job"]
        for need in needs
        if isinstance(need, dict)
        and need.get("artifacts") is False
        and isinstance(need.get("job"), str)
    }
    assert required_gates <= required_need_jobs
    assert publish.get("dependencies") == []


def test_mysql_gate_collects_every_mysql_integration_test() -> None:
    mysql_job = PIPELINE_CONFIG["validate_ingestion_mysql"]
    assert isinstance(mysql_job, dict)
    commands = mysql_job["script"]
    assert isinstance(commands, list)
    pytest_command = next(
        command
        for command in commands
        if isinstance(command, str) and command.startswith("python -m pytest")
    )

    selected = _collected_mysql_nodes(pytest_command)
    expected = _collected_mysql_nodes("python -m pytest -m mysql tests/integration")

    assert expected
    assert selected == expected


def test_ci_and_ingestion_scripts_never_invoke_operational_mutations() -> None:
    prohibited = (
        "upload_snapshot.py",
        "run_task.py",
        "s3 cp",
        "s3 sync",
        "s3api put-object",
        "put-secret-value",
        "secretsmanager put-secret-value",
        "ecs run-task",
        "terraform apply",
        "terraform destroy",
        "terraform import",
        "scheduler update-schedule",
        "scheduler create-schedule",
        "export-incremental",
        "ingest-incremental",
    )
    inspected = "\n".join((PIPELINE, PUBLISHER, SMOKE)).lower()

    for command in prohibited:
        assert command not in inspected


def test_ingestion_publisher_outputs_only_a_digest_dotenv_and_smoke_is_batch_hardened() -> None:
    assert 'readonly expected_repository="view-show-ingestion"' in PUBLISHER
    assert "publish-backend-image.sh" not in PUBLISHER
    assert "PUBLISH_IMAGE_TARGET" not in PUBLISHER
    assert "printf 'INGESTION_IMAGE_DIGEST=%s\\n'" in PUBLISHER
    assert "BACKEND_IMAGE_DIGEST" not in PUBLISHER
    assert "--read-only" in SMOKE
    assert "--network" in SMOKE
    assert "none" in SMOKE
    assert "--cap-drop" in SMOKE
    assert "no-new-privileges" in SMOKE
    assert "ingestion-container-smoke.py" in SMOKE
    assert "EXPOSE" not in SMOKE
