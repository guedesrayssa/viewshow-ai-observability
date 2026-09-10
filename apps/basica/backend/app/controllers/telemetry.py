"""Endpoints de ingestão de telemetria."""

from __future__ import annotations

from http import HTTPStatus

from flask import Blueprint, current_app, jsonify, request

from app import container
from app.fault_injection import maybe_inject_ingestion_fault

telemetry_bp = Blueprint("telemetry", __name__, url_prefix="/v1/telemetry")


@telemetry_bp.post("/events")
def ingest_events():
    """Recebe eventos de reprodução, individualmente ou em lote."""
    maybe_inject_ingestion_fault(request.headers, current_app.config)
    result = container.ingestion_service().ingest_events(request.get_json(silent=True))
    return jsonify(result.as_dict()), HTTPStatus.ACCEPTED


@telemetry_bp.post("/errors")
def ingest_errors():
    """Recebe exceções e falhas da aplicação."""
    result = container.ingestion_service().ingest_errors(request.get_json(silent=True))
    return jsonify(result.as_dict()), HTTPStatus.ACCEPTED


@telemetry_bp.post("/heartbeat")
def ingest_heartbeat():
    """Registra presença de sessões ativas para cálculo de CCU."""
    result = container.ingestion_service().ingest_heartbeats(request.get_json(silent=True))
    return jsonify(result.as_dict()), HTTPStatus.ACCEPTED
