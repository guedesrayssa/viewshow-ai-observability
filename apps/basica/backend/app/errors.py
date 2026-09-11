"""Erros de API e os handlers que os traduzem para respostas JSON."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from flask import Flask, jsonify
from werkzeug.exceptions import HTTPException


class ApiError(Exception):
    """Erro previsto da API, com código estável e status HTTP associado."""

    status_code = 500
    code = "internal_error"

    def __init__(self, message: str, *, details: Sequence[Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = list(details or [])

    def as_dict(self) -> dict[str, Any]:
        return {"error": {"code": self.code, "message": self.message, "details": self.details}}


class ValidationError(ApiError):
    """Requisição malformada: corpo ou parâmetros de consulta inválidos."""

    status_code = 400
    code = "validation_error"


class UnprocessablePayloadError(ApiError):
    """Corpo bem formado, mas sem nenhum item aproveitável."""

    status_code = 422
    code = "unprocessable_payload"


class PayloadTooLargeError(ApiError):
    """Lote acima do limite aceito pela ingestão."""

    status_code = 413
    code = "payload_too_large"


class FaultInjectionUnauthorizedError(ApiError):
    """Tentativa sem autorização de acionar uma falha de teste."""

    status_code = 403
    code = "fault_injection_unauthorized"


class QueueFullError(ApiError):
    """A fila simulada recusou o evento para aplicar backpressure."""

    status_code = 429
    code = "queue_full"


class DependencyTimeoutError(ApiError):
    """Uma dependência simulada excedeu seu orçamento de tempo."""

    status_code = 504
    code = "dependency_timeout"


class ResourceNotFoundError(ApiError):
    """Recurso inexistente na janela consultada."""

    status_code = 404
    code = "not_found"


def register_error_handlers(app: Flask) -> None:
    """Garante que toda falha da API seja devolvida no mesmo envelope JSON."""

    @app.errorhandler(ApiError)
    def handle_api_error(error: ApiError):
        return jsonify(error.as_dict()), error.status_code

    @app.errorhandler(HTTPException)
    def handle_http_exception(error: HTTPException):
        body = {
            "error": {
                "code": (error.name or "http_error").lower().replace(" ", "_"),
                "message": error.description or "",
                "details": [],
            }
        }
        return jsonify(body), error.code or 500

    @app.errorhandler(Exception)
    def handle_unexpected_error(error: Exception):
        app.logger.exception("Erro não tratado ao processar a requisição", exc_info=error)
        body = {
            "error": {
                "code": "internal_error",
                "message": "Erro interno ao processar a requisição.",
                "details": [],
            }
        }
        return jsonify(body), 500
