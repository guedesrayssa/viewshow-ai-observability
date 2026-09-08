"""Falhas controladas usadas somente nos testes de carga e resiliência.

O mecanismo é opt-in, exige um token e só atua na rota de eventos que o teste
exercita. Em produção, com ``LOAD_TEST_FAULTS_ENABLED=0`` (padrão), os headers
são ignorados e não acrescentam um caminho de falha ao tráfego normal.
"""

from __future__ import annotations

import hmac
import time
from collections.abc import Mapping
from typing import Any

from app.errors import (
    DependencyTimeoutError,
    FaultInjectionUnauthorizedError,
    QueueFullError,
    ValidationError,
)

FAULT_HEADER = "X-View-Show-Test-Fault"
TOKEN_HEADER = "X-View-Show-Test-Token"
QUEUE_FULL = "queue-full"
TIMEOUT = "timeout"
SUPPORTED_FAULTS = frozenset({QUEUE_FULL, TIMEOUT})


def maybe_inject_ingestion_fault(headers: Mapping[str, str], config: Mapping[str, Any]) -> None:
    """Interrompe a ingestão com uma falha previsível quando autorizada."""

    fault = headers.get(FAULT_HEADER)
    if not fault or not config["LOAD_TEST_FAULTS_ENABLED"]:
        return

    supplied_token = headers.get(TOKEN_HEADER, "")
    expected_token = str(config["LOAD_TEST_FAULT_TOKEN"])
    if not supplied_token or not hmac.compare_digest(supplied_token, expected_token):
        raise FaultInjectionUnauthorizedError("Token de injeção de falha inválido ou ausente.")

    if fault not in SUPPORTED_FAULTS:
        raise ValidationError(
            f"Falha de teste desconhecida: {fault}. Use queue-full ou timeout."
        )

    if fault == QUEUE_FULL:
        raise QueueFullError(
            "Fila de ingestão simulada sem capacidade; tente novamente após aplicar backoff."
        )

    time.sleep(config["LOAD_TEST_TIMEOUT_DELAY_MS"] / 1_000)
    raise DependencyTimeoutError(
        "Dependência de persistência simulada excedeu o tempo limite da ingestão."
    )
