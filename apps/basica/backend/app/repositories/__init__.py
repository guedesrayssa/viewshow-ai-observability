"""Acesso ao armazenamento dos registros de telemetria."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from app.repositories.base import TelemetryRepository
from app.repositories.memory import InMemoryTelemetryRepository

MEMORY_BACKEND = "memory"
DYNAMODB_BACKEND = "dynamodb"

__all__ = [
    "DYNAMODB_BACKEND",
    "MEMORY_BACKEND",
    "InMemoryTelemetryRepository",
    "TelemetryRepository",
    "create_repository",
]


def create_repository(config: Mapping[str, Any]) -> TelemetryRepository:
    """Constrói o repositório indicado por `TELEMETRY_BACKEND`.

    O import do backend DynamoDB é adiado para que a aplicação continue
    subindo em memória mesmo sem o `boto3` instalado.
    """
    backend = str(config.get("TELEMETRY_BACKEND", MEMORY_BACKEND)).strip().lower()

    if backend == MEMORY_BACKEND:
        return InMemoryTelemetryRepository(
            retention=config["TELEMETRY_RETENTION"],
            max_records=config["TELEMETRY_MAX_RECORDS"],
        )

    if backend == DYNAMODB_BACKEND:
        from app.repositories.dynamodb import DynamoDbTelemetryRepository

        return DynamoDbTelemetryRepository(
            table_name=config["DYNAMODB_TABLE"],
            region_name=config.get("DYNAMODB_REGION"),
            endpoint_url=config.get("DYNAMODB_ENDPOINT_URL"),
            retention=config["TELEMETRY_RETENTION"],
            bucket_seconds=config["DYNAMODB_BUCKET_SECONDS"],
            max_workers=config["DYNAMODB_MAX_QUERY_WORKERS"],
        )

    raise ValueError(
        f"`TELEMETRY_BACKEND` inválido: {backend!r}. "
        f"Use `{MEMORY_BACKEND}` ou `{DYNAMODB_BACKEND}`."
    )
