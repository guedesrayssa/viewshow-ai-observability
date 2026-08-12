"""Endpoints de análise de causa raiz (RCA)."""

from __future__ import annotations

from flask import Blueprint, jsonify

from app import container
from app.controllers.params import request_interval, request_limit, request_ratio, request_window
from app.services.rca import DEFAULT_MIN_CORRELATION

rca_bp = Blueprint("rca", __name__, url_prefix="/v1/analytics/rca")


@rca_bp.get("/modules-breakdown")
def modules_breakdown():
    """Aponta os módulos internos relacionados às falhas."""
    breakdown = container.rca_service().modules_breakdown(
        request_window(), limit=request_limit()
    )
    return jsonify(breakdown)


@rca_bp.get("/topology-health")
def topology_health():
    """Retorna a saúde da topologia e das dependências entre serviços."""
    return jsonify(container.rca_service().topology_health(request_window()))


@rca_bp.get("/fingerprints")
def fingerprints():
    """Lista padrões recorrentes de erros."""
    return jsonify(container.rca_service().fingerprints(request_window(), limit=request_limit()))


@rca_bp.get("/fingerprints/<string:fingerprint_id>")
def fingerprint_details(fingerprint_id: str):
    """Detalha os serviços afetados e o raio de impacto de um padrão."""
    return jsonify(container.rca_service().fingerprint_details(request_window(), fingerprint_id))


@rca_bp.get("/traces/<string:trace_id>")
def trace_details(trace_id: str):
    """Retorna a trilha ponta a ponta de uma requisição."""
    return jsonify(container.rca_service().trace(trace_id))


@rca_bp.get("/correlations")
def correlations():
    """Retorna correlações entre surtos de erros."""
    window = request_window()
    result = container.rca_service().correlations(
        window,
        interval=request_interval(window),
        minimum=request_ratio("min_correlation", DEFAULT_MIN_CORRELATION),
        limit=request_limit(),
    )
    return jsonify(result)
