"""A identidade de telemetria tem um dono único, porque a cadeia exige igualdade exata."""

from __future__ import annotations

import inspect

import pytest

from domain.telemetry_identity import (
    METRICS_NAMESPACE,
    METRICS_NAMESPACE_PREFIX,
    SERVICE_NAME,
)


def test_service_name_is_the_name_the_deployment_namespace_derives() -> None:
    assert SERVICE_NAME == "view-show-ingestion"


def test_metrics_namespace_lives_under_the_deployment_namespace_prefix() -> None:
    assert METRICS_NAMESPACE == "view-show/Ingestion"
    assert METRICS_NAMESPACE.startswith(f"{METRICS_NAMESPACE_PREFIX}/")


def test_every_telemetry_default_resolves_to_this_single_source() -> None:
    from adapters.telemetry.cloudwatch_metrics import DEFAULT_NAMESPACE
    from adapters.telemetry.json_logging import JsonLogger
    from bootstrap.config import DEFAULT_METRICS_NAMESPACE, DEFAULT_SERVICE_NAME

    logger_default = inspect.signature(JsonLogger.__init__).parameters["service_name"].default

    assert DEFAULT_SERVICE_NAME == SERVICE_NAME
    assert logger_default == SERVICE_NAME
    assert DEFAULT_METRICS_NAMESPACE == METRICS_NAMESPACE
    assert DEFAULT_NAMESPACE == METRICS_NAMESPACE


@pytest.mark.parametrize(
    "legacy",
    ("g05-s3-ingestion", "ViewShow/Ingestion", "monitoracao-operacional"),
)
def test_no_telemetry_constant_carries_a_pre_isolation_name(legacy: str) -> None:
    assert legacy not in {SERVICE_NAME, METRICS_NAMESPACE, METRICS_NAMESPACE_PREFIX}
