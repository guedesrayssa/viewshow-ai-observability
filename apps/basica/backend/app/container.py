"""Composição das dependências da aplicação.

Os serviços não conhecem o Flask: é aqui que a configuração da aplicação vira
repositório, limiares e instâncias de serviço para os controllers.
"""

from __future__ import annotations

from flask import Flask, current_app

from app.repositories import TelemetryRepository, create_repository
from app.services.breakdown import BreakdownService
from app.services.error_analytics import ErrorAnalyticsService
from app.services.ingestion import TelemetryIngestionService
from app.services.qoe import QoeService
from app.services.rca import RcaService
from app.services.realtime import AlertThresholds, RealtimeService

_REPOSITORY_KEY = "telemetry_repository"
_THRESHOLDS_KEY = "alert_thresholds"


def init_app(app: Flask) -> None:
    """Monta o que é compartilhado por todas as requisições da aplicação.

    Os limiares são construídos aqui, e não a cada requisição, para que uma
    configuração inválida derrube a inicialização em vez de virar um erro 500
    na primeira consulta de alertas.
    """
    app.extensions[_REPOSITORY_KEY] = create_repository(app.config)
    app.extensions[_THRESHOLDS_KEY] = AlertThresholds(**app.config["ALERT_THRESHOLDS"])


def telemetry_repository() -> TelemetryRepository:
    return current_app.extensions[_REPOSITORY_KEY]


def ingestion_service() -> TelemetryIngestionService:
    return TelemetryIngestionService(
        telemetry_repository(),
        max_batch_size=current_app.config["MAX_BATCH_SIZE"],
    )


def qoe_service() -> QoeService:
    return QoeService(telemetry_repository())


def error_analytics_service() -> ErrorAnalyticsService:
    return ErrorAnalyticsService(telemetry_repository())


def breakdown_service() -> BreakdownService:
    return BreakdownService(telemetry_repository(), qoe_service())


def realtime_service() -> RealtimeService:
    return RealtimeService(
        telemetry_repository(),
        qoe_service(),
        error_analytics_service(),
        heartbeat_ttl=current_app.config["HEARTBEAT_TTL"],
        thresholds=current_app.extensions[_THRESHOLDS_KEY],
    )


def rca_service() -> RcaService:
    return RcaService(telemetry_repository())
