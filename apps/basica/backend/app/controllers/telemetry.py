from collections.abc import Iterable

from flask import Blueprint, current_app, jsonify, request

telemetry_bp = Blueprint("telemetry", __name__, url_prefix="/v1/telemetry")


def _items_from_payload() -> tuple[list[dict], str | None]:
    """Aceita um objeto JSON ou uma lista de objetos JSON."""
    payload = request.get_json(silent=True)

    if isinstance(payload, dict):
        return [payload], None
    if isinstance(payload, list) and all(isinstance(item, dict) for item in payload):
        return payload, None

    return [], "O corpo deve ser um objeto JSON ou uma lista de objetos JSON."


def _ingest(resource: str):
    items, error = _items_from_payload()
    if error:
        return jsonify({"error": error}), 400

    current_app.config["TELEMETRY_STORE"][resource].extend(items)
    return jsonify({"resource": resource, "accepted": len(items)}), 202


@telemetry_bp.post("/events")
def ingest_events():
    """Recebe eventos de reprodução em lote."""
    return _ingest("events")


@telemetry_bp.post("/errors")
def ingest_errors():
    """Recebe exceções e falhas em lote ou individualmente."""
    return _ingest("errors")


@telemetry_bp.post("/heartbeat")
def ingest_heartbeat():
    """Recebe sinais periódicos de presença das sessões ativas."""
    return _ingest("heartbeats")
