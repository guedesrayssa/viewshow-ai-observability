"""Emite métricas no formato incorporado do CloudWatch com dimensões limitadas.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from __future__ import annotations

import json
import math
import sys
import time
from collections.abc import Mapping
from typing import TextIO

from contracts.registry import EXPECTED_ARGUS_V2_DATASETS
from domain.telemetry_identity import METRICS_NAMESPACE
from ports import MetricsPublisher

DEFAULT_NAMESPACE = METRICS_NAMESPACE
_METRICS: Mapping[str, str] = {
    "Runs": "Count",
    "RunDurationMs": "Milliseconds",
    "RecordsRead": "Count",
    "RecordsWritten": "Count",
    "RecordsUnchanged": "Count",
    "RecordsRejected": "Count",
    "SchemaDrift": "Count",
    "SourceLagSeconds": "Seconds",
    "CoverageRatio": "None",
    "WatermarkEpochSeconds": "Seconds",
    "OutboxPendingCount": "Count",
    "OutboxOldestAgeSeconds": "Seconds",
    "RestoreDurationMs": "Milliseconds",
    "AthenaFailures": "Count",
    "ArchiveFailures": "Count",
    "StageDurationMs": "Milliseconds",
    "StageFailures": "Count",
    "LocalDiskCurrentBytes": "Bytes",
    "LocalDiskPeakBytes": "Bytes",
    "IncrementalBatches": "Count",
    "IncrementalBatchLagSeconds": "Seconds",
    "IncrementalSchemaExtraColumns": "Count",
    "IncrementalBatchQuarantined": "Count",
    "MySqlPageDurationMs": "Milliseconds",
    "MySqlPageRows": "Count",
    "MySqlRetries": "Count",
    "MySqlCursorIndexDurationMs": "Milliseconds",
    "MySqlPreflightDurationMs": "Milliseconds",
    "MySqlPreflightFailures": "Count",
}
_COMMANDS = frozenset(
    {
        "validate",
        "backfill",
        "import-dump",
        "sync",
        "reprocess",
        "rebuild-projections",
        "publish-outbox",
        "export-incremental",
        "ingest-incremental",
    }
)
_STATUSES = frozenset(
    {
        "SUCCEEDED",
        "PARTIAL",
        "FAILED",
        "SKIPPED_LOCKED",
        "SKIPPED_DISABLED",
        "COMPLETED",
        "RETRYABLE_FAILED",
        "QUARANTINED",
    }
)
_SOURCE_MODES = frozenset({"snapshot", "live"})
_EVENT_TYPES = frozenset({"ANOMALY_DETECTION", "QOE_FORECAST"})
_COMPONENTS = frozenset({"PARQUET"})
_COVERAGE_STATUSES = frozenset({"complete", "partial", "unavailable"})
_STAGES = frozenset(
    {
        "STARTING",
        "RESTORING",
        "VALIDATING",
        "INGESTING",
        "PROJECTING",
        "ARCHIVING",
        "ACTIVATING",
        "PUBLISHING",
        "SUCCEEDED",
        "PARTIAL",
        "FAILED",
        "SKIPPED_LOCKED",
        "SKIPPED_DISABLED",
    }
)
_DIMENSION_VALUES: Mapping[str, frozenset[str] | tuple[str, ...]] = {
    "command": _COMMANDS,
    "status": _STATUSES,
    "stage": _STAGES,
    "dataset": EXPECTED_ARGUS_V2_DATASETS,
    "source_mode": _SOURCE_MODES,
    "event_type": _EVENT_TYPES,
    "component": _COMPONENTS,
    "coverage_status": _COVERAGE_STATUSES,
}


class CloudWatchMetrics(MetricsPublisher):
    """Agrupa o estado e as operações de ``CloudWatchMetrics`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(self, *, namespace: str = DEFAULT_NAMESPACE, stream: TextIO | None = None) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            namespace: Entrada ``namespace``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            stream: Fluxo binário ou textual consumido incrementalmente.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(namespace, str) or not namespace.strip():
            raise ValueError("namespace must be non-empty text")
        self._namespace = namespace
        self._stream = sys.stdout if stream is None else stream

    def increment(self, name: str, value: int, dimensions: Mapping[str, str]) -> None:
        """Incrementa um contador com dimensões de baixa cardinalidade.

        Args:
            name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            value: Valor não confiável que será validado ou convertido.
            dimensions: Entrada ``dimensions``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        if isinstance(value, bool) or not isinstance(value, int):
            raise TypeError("metric value must be numeric")
        self._emit(name, value, dimensions, expected_unit="Count")

    def gauge(self, name: str, value: float, dimensions: Mapping[str, str]) -> None:
        """Publica o valor atual de uma medida com dimensões controladas.

        Args:
            name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            value: Valor não confiável que será validado ou convertido.
            dimensions: Entrada ``dimensions``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._emit(name, value, dimensions)

    def timing(self, name: str, milliseconds: float, dimensions: Mapping[str, str]) -> None:
        """Publica a duração observada da operação em milissegundos.

        Args:
            name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            milliseconds: Entrada ``milliseconds``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            dimensions: Entrada ``dimensions``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._emit(name, milliseconds, dimensions, expected_unit="Milliseconds")

    def _emit(
        self,
        name: str,
        value: int | float,
        dimensions: Mapping[str, str],
        *,
        expected_unit: str | None = None,
    ) -> None:
        """Emite a entrada pelo canal de telemetria configurado.

        Args:
            name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            value: Valor não confiável que será validado ou convertido.
            dimensions: Entrada ``dimensions``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.
            expected_unit: Valor esperado usado para detectar concorrência ou divergência de
            estado.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        try:
            unit = _METRICS[name]
        except KeyError as error:
            raise ValueError("metric name is not allowlisted") from error
        if expected_unit is not None and unit != expected_unit:
            raise ValueError(f"metric {name} is not a {expected_unit} metric")
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise TypeError("metric value must be numeric")
        if not math.isfinite(value):
            raise ValueError("metric value must be finite")
        safe_dimensions: dict[str, str] = {}
        for key, dimension_value in dimensions.items():
            allowed = _DIMENSION_VALUES.get(key)
            if allowed is None:
                raise ValueError(f"dimension {key!r} is not allowlisted")
            if dimension_value not in allowed:
                raise ValueError(f"dimension {key!r} has a non-allowlisted value")
            safe_dimensions[key] = dimension_value
        names = sorted(safe_dimensions)
        document: dict[str, object] = {
            "_aws": {
                "Timestamp": time.time_ns() // 1_000_000,
                "CloudWatchMetrics": [
                    {
                        "Namespace": self._namespace,
                        "Dimensions": [names],
                        "Metrics": [{"Name": name, "Unit": unit}],
                    }
                ],
            },
            **{key: safe_dimensions[key] for key in names},
            name: value,
        }
        try:
            self._stream.write(
                json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n"
            )
            self._stream.flush()
        except Exception:
            # A telemetria é best-effort e nunca deve substituir o resultado da operação.
            return


EmfMetricsPublisher = CloudWatchMetrics

__all__ = ["CloudWatchMetrics", "DEFAULT_NAMESPACE", "EmfMetricsPublisher"]
