"""Configuração da aplicação.

Os valores ficam concentrados aqui para que limiares de alerta, limites de
ingestão e janelas padrão possam ser ajustados sem alterar os serviços.
"""

from __future__ import annotations

import os
from datetime import timedelta
from typing import ClassVar


class Config:
    """Valores padrão da API de telemetria."""

    # Origens autorizadas a consumir a API pelo navegador, separadas por
    # vírgula. `*` libera todas, o que serve para o desenvolvimento local; em
    # produção, aponte para a URL do site estático no S3.
    CORS_ORIGINS = os.getenv("CORS_ORIGINS", "*")

    # Ingestão
    MAX_BATCH_SIZE = 500
    TELEMETRY_RETENTION = timedelta(hours=24)

    # Armazenamento: `memory` (desenvolvimento e testes) ou `dynamodb`.
    TELEMETRY_BACKEND = os.getenv("TELEMETRY_BACKEND", "memory")

    # Teto de registros do backend em memória.
    TELEMETRY_MAX_RECORDS = 200_000

    # DynamoDB. A região e as credenciais seguem a cadeia padrão da AWS
    # (variáveis de ambiente, perfil ou role da instância).
    DYNAMODB_TABLE = os.getenv("DYNAMODB_TABLE", "telemetry")
    DYNAMODB_REGION = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")
    # Apontado para o DynamoDB Local durante o desenvolvimento.
    DYNAMODB_ENDPOINT_URL = os.getenv("DYNAMODB_ENDPOINT_URL")
    # Tamanho da faixa de tempo de cada partição. Buckets menores espalham
    # melhor a escrita; maiores reduzem o número de consultas por janela.
    DYNAMODB_BUCKET_SECONDS = int(os.getenv("DYNAMODB_BUCKET_SECONDS", "3600"))
    DYNAMODB_MAX_QUERY_WORKERS = int(os.getenv("DYNAMODB_MAX_QUERY_WORKERS", "8"))

    # Janelas de consulta
    DEFAULT_WINDOW = timedelta(minutes=15)
    MAX_WINDOW = timedelta(days=30)
    MAX_TIMESERIES_BUCKETS = 500
    DEFAULT_LIMIT = 20
    MAX_LIMIT = 200

    # Presença: tempo máximo desde o último heartbeat para a sessão contar no CCU.
    HEARTBEAT_TTL = timedelta(minutes=2)

    # Limiares usados por /v1/analytics/realtime/alerts.
    #
    # `ClassVar` marca o dicionário como atributo da classe, e não como campo de
    # instância. `app.config.from_object` copia a referência, não o conteúdo:
    # sem a marcação, qualquer escrita em `app.config["ALERT_THRESHOLDS"]`
    # alteraria este dicionário e vazaria para todas as aplicações criadas
    # depois, inclusive entre um teste e o seguinte.
    ALERT_THRESHOLDS: ClassVar[dict[str, float]] = {
        "error_rate_warning": 0.02,
        "error_rate_critical": 0.05,
        "rebuffer_rate_warning": 0.01,
        "rebuffer_rate_critical": 0.03,
        "crash_free_warning": 0.995,
        "crash_free_critical": 0.99,
        "startup_p95_warning_ms": 4_000.0,
        "startup_p95_critical_ms": 8_000.0,
        "spike_multiplier": 3.0,
        "spike_min_occurrences": 5,
        "min_samples": 20,
    }
