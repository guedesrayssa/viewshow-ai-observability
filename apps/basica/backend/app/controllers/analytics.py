"""Endpoints analíticos do dashboard: tempo real, QoE, erros e segmentações."""

from __future__ import annotations

from flask import Blueprint, jsonify

from app import container
from app.controllers.params import request_choice, request_interval, request_limit, request_window
from app.services.breakdown import DEVICE_DIMENSIONS, NETWORK_DIMENSIONS

analytics_bp = Blueprint("analytics", __name__, url_prefix="/v1/analytics")


@analytics_bp.get("/realtime/overview")
def realtime_overview():
    """Retorna CCU, volume de eventos e taxa de erros."""
    return jsonify(container.realtime_service().overview(request_window()))


@analytics_bp.get("/realtime/alerts")
def realtime_alerts():
    """Lista alertas e anomalias ativos."""
    window = request_window()
    alerts = container.realtime_service().alerts(window, interval=request_interval(window))
    return jsonify(alerts)


@analytics_bp.get("/qoe/metrics")
def qoe_metrics():
    """Retorna VST, rebuffer rate e bitrate médio."""
    return jsonify(container.qoe_service().metrics(request_window()))


@analytics_bp.get("/qoe/timeseries")
def qoe_timeseries():
    """Retorna a série temporal de métricas de QoE."""
    window = request_window()
    return jsonify(container.qoe_service().timeseries(window, request_interval(window)))


@analytics_bp.get("/errors/summary")
def errors_summary():
    """Resume erros e a taxa de sessões sem falhas."""
    return jsonify(container.error_analytics_service().summary(request_window()))


@analytics_bp.get("/errors/top")
def top_errors():
    """Lista os códigos de erro mais frequentes."""
    return jsonify(container.error_analytics_service().top(request_window(), limit=request_limit()))


@analytics_bp.get("/errors/<string:error_code>/details")
def error_details(error_code: str):
    """Detalha ocorrências e impacto de um código de erro."""
    window = request_window()
    details = container.error_analytics_service().details(
        window,
        error_code,
        interval=request_interval(window),
        limit=request_limit(),
    )
    return jsonify(details)


@analytics_bp.get("/breakdown/devices")
def devices_breakdown():
    """Segmenta métricas por dispositivo, SO e versão do app."""
    breakdown = container.breakdown_service().devices(
        request_window(),
        dimension=request_choice("dimension", DEVICE_DIMENSIONS, default="model"),
        limit=request_limit(),
    )
    return jsonify(breakdown)


@analytics_bp.get("/breakdown/network")
def network_breakdown():
    """Segmenta métricas por ISP, CDN e tipo de conexão."""
    breakdown = container.breakdown_service().network(
        request_window(),
        dimension=request_choice("dimension", NETWORK_DIMENSIONS, default="cdn"),
        limit=request_limit(),
    )
    return jsonify(breakdown)
