"""Expõe a fachada independente de observabilidade do worker.

Papel no fluxo:
    Este módulo oferece uma fachada independente para instrumentação do worker, sem incorporar
    regras de ingestão ou alterar o resultado dos casos de uso.

Garantias e limites:
    Falhas de telemetria devem permanecer isoladas do processamento de dados, e valores
    sensíveis não podem aparecer em logs, métricas ou traces.
"""

from .observability import IngestionTelemetry, RunState, TelemetryConfig
from .facts import SeriesIdentity, build_fact, canonical_series_identity, series_id

__all__ = ["IngestionTelemetry", "RunState", "TelemetryConfig", "SeriesIdentity",
           "build_fact", "canonical_series_identity", "series_id"]
