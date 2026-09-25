"""Exercise archive publication against AWS services in a smoke environment."""

from __future__ import annotations

import os

import boto3  # type: ignore[import-untyped]
import pytest

pytestmark = [
    pytest.mark.aws,
    pytest.mark.skipif(
        os.getenv("RUN_AWS_TESTS") != "1",
        reason="set RUN_AWS_TESTS=1 to run read-only AWS archive smoke tests",
    ),
]


def _required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        pytest.skip(f"{name} is required for the read-only AWS archive smoke test")
    return value


def test_terraform_owned_archive_resources_are_reachable() -> None:
    """Only inspect existing Terraform-owned resources; never create or mutate AWS state."""
    region = os.getenv("AWS_REGION", "us-east-1")
    bucket = _required_env("ARCHIVE_BUCKET")
    database = _required_env("GLUE_DATABASE")
    workgroup = _required_env("ATHENA_WORKGROUP")

    boto3.client("s3", region_name=region).head_bucket(Bucket=bucket)
    boto3.client("glue", region_name=region).get_database(Name=database)
    boto3.client("athena", region_name=region).get_work_group(WorkGroup=workgroup)
