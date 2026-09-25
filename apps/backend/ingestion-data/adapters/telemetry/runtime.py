"""Instrumenta a execução completa de comandos batch e seus estados terminais.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from __future__ import annotations

import threading
import time
import uuid
from argparse import Namespace
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from enum import Enum
from typing import Protocol, cast

from contracts.registry import EXPECTED_ARGUS_V2_DATASETS
from domain.disk_budget import DiskUsageReason
from domain.run import RunStage
from ports import Logger, OutboxBacklog

type CommandHandler = Callable[[Namespace], object]
type MonotonicClock = Callable[[], float]
type UtcClock = Callable[[], datetime]

_COUNT_FIELDS: tuple[tuple[str, str], ...] = (
    ("records_read", "recordsRead"),
    ("records_written", "recordsWritten"),
    ("records_rejected", "recordsRejected"),
    ("records_unchanged", "recordsUnchanged"),
    ("row_count", "recordsRead"),
    ("completed", "batchesCompleted"),
    ("retryable", "batchesRetryable"),
    ("quarantined", "batchesQuarantined"),
)
_COUNT_METRICS = {
    "recordsRead": "RecordsRead",
    "recordsWritten": "RecordsWritten",
    "recordsRejected": "RecordsRejected",
    "recordsUnchanged": "RecordsUnchanged",
}


class _LoggerLike(Protocol):
    """Define o contrato mínimo de logger like usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def bind(self, **context: object) -> Logger:
        """Cria uma visão com a entrada associado ao contexto atual.

        Args:
            context: Contexto validado compartilhado durante o processamento.

        Returns:
            Valor ``Logger`` produzido pela operação após as validações.
        """
        ...

    def info(self, event: str, **fields: object) -> None:
        """Emite um evento informativo com contexto estruturado.

        Args:
            event: Evento de análise validado que será codificado ou publicado.
            fields: Entrada ``fields``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        ...

    def error(self, event: str, **fields: object) -> None:
        """Registra ou transforma uma falha sem expor dados sensíveis.

        Args:
            event: Evento de análise validado que será codificado ou publicado.
            fields: Entrada ``fields``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        ...


class _MetricsLike(Protocol):
    """Define o contrato mínimo de métricas like usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

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
        """
        ...

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
        ...

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
        ...


class _OutboxBacklogLike(Protocol):
    """Define o contrato mínimo de outbox backlog like usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def inspect_pending(self) -> OutboxBacklog:
        """Executa a etapa interna ``inspect_pending`` e devolve o resultado validado indicado
        pela assinatura.

        Returns:
            Valor ``OutboxBacklog`` produzido pela operação após as validações.
        """
        ...


def _has_methods(value: object, names: tuple[str, ...]) -> bool:
    """Informa se existe methods nas evidências disponíveis.

    Args:
        value: Valor não confiável que será validado ou convertido.
        names: Entrada ``names``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.
    """
    try:
        return all(callable(getattr(value, name, None)) for name in names)
    except BaseException:
        return False


def _attribute(value: object, name: str) -> object | None:
    """Executa a etapa interna ``attribute`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``object | None`` produzido pela operação após as validações.
    """
    try:
        return getattr(value, name, None)
    except BaseException:
        return None


def _text_attribute(value: object, name: str) -> str | None:
    """Executa a etapa interna ``text_attribute`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``str | None`` produzido pela operação após as validações.
    """
    candidate = _attribute(value, name)
    if isinstance(candidate, Enum):
        candidate = candidate.value
    return candidate if isinstance(candidate, str) and candidate else None


def _timestamp_attribute(value: object, name: str) -> str | None:
    """Executa a etapa interna ``timestamp_attribute`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``str | None`` produzido pela operação após as validações.
    """
    candidate = _attribute(value, name)
    if isinstance(candidate, datetime) and candidate.tzinfo is not None:
        return candidate.astimezone(UTC).isoformat().replace("+00:00", "Z")
    return candidate if isinstance(candidate, str) and candidate else None


def _counts(result: object) -> dict[str, int]:
    """Executa a etapa interna ``counts`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``dict[str, int]`` produzido pela operação após as validações.
    """
    counts: dict[str, int] = {}
    for attribute, field in _COUNT_FIELDS:
        value = _attribute(result, attribute)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            counts[field] = value

    sources = _attribute(result, "sources")
    if isinstance(sources, Mapping):
        for attribute, field in _COUNT_FIELDS:
            values = [_attribute(source, attribute) for source in sources.values()]
            if values and all(
                isinstance(value, int) and not isinstance(value, bool) and value >= 0
                for value in values
            ):
                counts[field] = sum(cast(int, value) for value in values)

    return counts


def _context(arguments: Namespace, result: object | None = None) -> dict[str, object]:
    """Executa a etapa interna ``context`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        arguments: Entrada ``arguments``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.
    """
    context: dict[str, object] = {}
    for attribute, field in (
        ("_runtime_dataset_version", "datasetVersion"),
        ("dataset_version", "datasetVersion"),
        ("dataset", "dataset"),
        ("batch_id", "batchId"),
    ):
        if field not in context and (value := _text_attribute(arguments, attribute)) is not None:
            context[field] = value
    for attribute, field in (
        ("_runtime_window_start", "windowStart"),
        ("start", "windowStart"),
        ("_runtime_window_end", "windowEnd"),
        ("end", "windowEnd"),
    ):
        value = _timestamp_attribute(arguments, attribute)
        if field not in context and value is not None:
            context[field] = value
    if result is None:
        return context
    for attribute, field in (
        ("dataset_version", "datasetVersion"),
        ("dataset", "dataset"),
        ("batch_id", "batchId"),
    ):
        if (value := _text_attribute(result, attribute)) is not None:
            context[field] = value
    context.update(_counts(result))
    return context


def _terminal_stage(result: object) -> str:
    """Executa a etapa interna ``terminal_stage`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    stage = _text_attribute(result, "stage")
    if stage in {member.value for member in RunStage}:
        return stage
    return "SUCCEEDED" if _attribute(result, "succeeded") is not False else "FAILED"


def safe_error_message(error: BaseException) -> str:
    """Produz erro mensagem em formato seguro para logs ou persistência.

    Args:
        error: Entrada ``error``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    try:
        return str(error) or type(error).__name__
    except BaseException:
        return type(error).__name__


def _result_error(result: object) -> tuple[str, str]:
    """Executa a etapa interna ``result_error`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``tuple[str, str]`` produzido pela operação após as validações.
    """
    code = _text_attribute(result, "error_code") or "CommandFailed"
    message = (
        _text_attribute(result, "error")
        or _text_attribute(result, "publication_error")
        or "command returned a failed result"
    )
    return code, message


def _metric_dimensions(
    *, command: str, status: str, source_mode: str | None, context: Mapping[str, object]
) -> dict[str, str]:
    """Executa a etapa interna ``metric_dimensions`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        command: Entrada ``command``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        status: Entrada ``status``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        source_mode: Entrada ``source_mode``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        context: Contexto validado compartilhado durante o processamento.

    Returns:
        Valor ``dict[str, str]`` produzido pela operação após as validações.
    """
    dimensions = {"command": command, "status": status}
    if source_mode in {"snapshot", "live"}:
        dimensions["source_mode"] = source_mode
    dataset = context.get("dataset")
    if isinstance(dataset, str) and dataset in EXPECTED_ARGUS_V2_DATASETS:
        dimensions["dataset"] = dataset
    return dimensions


def _safe_log(logger: _LoggerLike, level: str, event: str, fields: Mapping[str, object]) -> None:
    """Produz log em formato seguro para logs ou persistência.

    Args:
        logger: Porta de log estruturado usada para registrar eventos seguros.
        level: Entrada ``level``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        event: Evento de análise validado que será codificado ou publicado.
        fields: Entrada ``fields``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.
    """
    try:
        getattr(logger, level)(event, **fields)
    except BaseException:
        return


def _safe_increment(
    metrics: _MetricsLike, name: str, value: int, dimensions: Mapping[str, str]
) -> None:
    """Produz increment em formato seguro para logs ou persistência.

    Args:
        metrics: Porta de métricas que recebe observações de baixa cardinalidade.
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        value: Valor não confiável que será validado ou convertido.
        dimensions: Entrada ``dimensions``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.
    """
    try:
        metrics.increment(name, value, dimensions)
    except BaseException:
        return


def _safe_timing(
    metrics: _MetricsLike, name: str, value: float, dimensions: Mapping[str, str]
) -> None:
    """Produz timing em formato seguro para logs ou persistência.

    Args:
        metrics: Porta de métricas que recebe observações de baixa cardinalidade.
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        value: Valor não confiável que será validado ou convertido.
        dimensions: Entrada ``dimensions``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.
    """
    try:
        metrics.timing(name, value, dimensions)
    except BaseException:
        return


def _safe_gauge(
    metrics: _MetricsLike, name: str, value: float, dimensions: Mapping[str, str]
) -> None:
    """Produz gauge em formato seguro para logs ou persistência.

    Args:
        metrics: Porta de métricas que recebe observações de baixa cardinalidade.
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        value: Valor não confiável que será validado ou convertido.
        dimensions: Entrada ``dimensions``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.
    """
    try:
        metrics.gauge(name, value, dimensions)
    except BaseException:
        return


class BoundedDiskUsageReporter:
    """Emit current/peak disk gauges at a bounded cadence and threshold crossings."""

    def __init__(
        self,
        metrics: _MetricsLike,
        *,
        command: str,
        source_mode: str,
        monotonic: MonotonicClock = time.monotonic,
        interval_seconds: float = 60.0,
    ) -> None:
        if not isinstance(command, str) or not command:
            raise ValueError("command must be non-empty text")
        if not isinstance(source_mode, str) or not source_mode:
            raise ValueError("source_mode must be non-empty text")
        if not callable(monotonic):
            raise TypeError("monotonic must be callable")
        if (
            isinstance(interval_seconds, bool)
            or not isinstance(interval_seconds, int | float)
            or interval_seconds <= 0
        ):
            raise ValueError("interval_seconds must be positive")
        self._metrics = metrics
        self._dimensions = {"command": command, "source_mode": source_mode}
        self._monotonic = monotonic
        self._interval_seconds = float(interval_seconds)
        self._last_emitted_at: float | None = None
        self._has_emitted = False
        self._crossed_percentages: set[int] = set()
        self._lock = threading.Lock()

    def report_disk_usage(
        self,
        current_bytes: int,
        peak_bytes: int,
        budget_bytes: int,
        *,
        reason: DiskUsageReason,
    ) -> None:
        values = (current_bytes, peak_bytes, budget_bytes)
        if any(isinstance(value, bool) or not isinstance(value, int) for value in values):
            return
        if current_bytes < 0 or peak_bytes < current_bytes or budget_bytes <= 0:
            return
        if reason not in {"observe", "reserve", "heartbeat", "fatal"}:
            return
        try:
            observed_at = float(self._monotonic())
        except Exception:
            observed_at = None
        with self._lock:
            newly_crossed = {
                percentage
                for percentage in (80, 90)
                if peak_bytes * 100 >= budget_bytes * percentage
                and percentage not in self._crossed_percentages
            }
            due = (
                not self._has_emitted
                or observed_at is not None
                and (
                    self._last_emitted_at is None
                    or observed_at - self._last_emitted_at >= self._interval_seconds
                )
            )
            if not (due or newly_crossed or reason == "fatal"):
                return
            self._crossed_percentages.update(newly_crossed)
            self._has_emitted = True
            if observed_at is not None:
                self._last_emitted_at = observed_at
        _safe_gauge(
            self._metrics,
            "LocalDiskCurrentBytes",
            float(current_bytes),
            self._dimensions,
        )
        _safe_gauge(
            self._metrics,
            "LocalDiskPeakBytes",
            float(peak_bytes),
            self._dimensions,
        )


def _typed_metrics(
    result: object,
) -> tuple[int | None, Mapping[str, datetime], Mapping[str, datetime]]:
    """Executa a etapa interna ``typed_metrics`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``tuple[int | None, Mapping[str, datetime], Mapping[str, datetime]]`` produzido
        pela operação após as validações.
    """
    from application.backfill import RunResult
    from application.sync import SyncResult

    if isinstance(result, RunResult):
        return result.local_disk_usage.peak_bytes, {}, {}
    if isinstance(result, SyncResult):
        peak = result.local_disk_usage.peak_bytes if result.local_disk_usage is not None else None
        latest_observations = {
            dataset: source.latest_observed_at
            for dataset, source in result.sources.items()
            if dataset in EXPECTED_ARGUS_V2_DATASETS and source.latest_observed_at is not None
        }
        return peak, result.analysis_watermarks, latest_observations
    return None, {}, {}


def _observe_source_lag(
    metrics: _MetricsLike,
    observations: Mapping[str, datetime],
    clock: UtcClock,
) -> None:
    """Observa fonte lag sem alterar o resultado da operação decorada.

    Args:
        metrics: Porta de métricas que recebe observações de baixa cardinalidade.
        observations: Entrada ``observations``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.
        clock: Função injetável que fornece o instante atual para validação e testes.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.
    """
    try:
        now = clock()
        if (
            not isinstance(now, datetime)
            or now.tzinfo is None
            or now.utcoffset() != UTC.utcoffset(None)
        ):
            return
    except BaseException:
        return
    for dataset, observed_at in observations.items():
        try:
            if (
                dataset not in EXPECTED_ARGUS_V2_DATASETS
                or not isinstance(observed_at, datetime)
                or observed_at.tzinfo is None
                or observed_at.utcoffset() != UTC.utcoffset(None)
            ):
                continue
            lag = max(0.0, (now - observed_at).total_seconds())
        except BaseException:
            continue
        _safe_gauge(
            metrics,
            "SourceLagSeconds",
            lag,
            {"dataset": dataset, "source_mode": "live"},
        )


def _observe_incremental_export_lag(
    metrics: _MetricsLike,
    arguments: Namespace,
    status: str,
    clock: UtcClock,
) -> None:
    """Emite o atraso da janela exportada com a série exata usada pelo alarme."""
    if status != "SUCCEEDED":
        return
    dataset = _text_attribute(arguments, "dataset")
    window_end = _attribute(arguments, "_runtime_window_end")
    if dataset not in EXPECTED_ARGUS_V2_DATASETS or not isinstance(window_end, datetime):
        return
    try:
        now = clock()
        if (
            now.tzinfo is None
            or now.utcoffset() != UTC.utcoffset(None)
            or window_end.tzinfo is None
            or window_end.utcoffset() != UTC.utcoffset(None)
        ):
            return
        lag = max(0.0, (now - window_end).total_seconds())
    except BaseException:
        return
    _safe_gauge(
        metrics,
        "IncrementalBatchLagSeconds",
        lag,
        {
            "command": "export-incremental",
            "status": "SUCCEEDED",
            "dataset": dataset,
        },
    )


def _observe_outbox(
    metrics: _MetricsLike,
    inspector: object | None,
    clock: UtcClock,
) -> None:
    """Observa outbox sem alterar o resultado da operação decorada.

    Args:
        metrics: Porta de métricas que recebe observações de baixa cardinalidade.
        inspector: Entrada ``inspector``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        clock: Função injetável que fornece o instante atual para validação e testes.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.
    """
    if inspector is None or not _has_methods(inspector, ("inspect_pending",)):
        return
    try:
        observation = cast(_OutboxBacklogLike, inspector).inspect_pending()
        now = clock()
        if not isinstance(observation, OutboxBacklog):
            return
        if now.tzinfo is None or now.utcoffset() != UTC.utcoffset(None):
            return
        _safe_increment(metrics, "OutboxPendingCount", observation.pending_count, {})
        if observation.oldest_created_at is not None:
            age = max(0.0, (now - observation.oldest_created_at).total_seconds())
            _safe_gauge(metrics, "OutboxOldestAgeSeconds", age, {})
    except BaseException:
        return


def _elapsed_ms(clock: MonotonicClock, started: float | None) -> float | None:
    """Executa a etapa interna ``elapsed_ms`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        clock: Função injetável que fornece o instante atual para validação e testes.
        started: Entrada ``started``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``float | None`` produzido pela operação após as validações.
    """
    if started is None:
        return None
    try:
        return max(0.0, (clock() - started) * 1000.0)
    except BaseException:
        return None


def observe_command(
    command: str,
    source_mode: str | None,
    handler: CommandHandler,
    telemetry: object,
    *,
    outbox_backlog: object | None = None,
) -> CommandHandler:
    """Observa comando sem alterar o resultado da operação decorada.

    Args:
        command: Entrada ``command``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        source_mode: Entrada ``source_mode``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        handler: Entrada ``handler``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        telemetry: Entrada ``telemetry``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        outbox_backlog: Entrada ``outbox_backlog``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.

    Returns:
        Valor ``CommandHandler`` produzido pela operação após as validações.
    """
    if not isinstance(telemetry, Mapping):
        return handler
    logger_value = telemetry.get("logger")
    metrics_value = telemetry.get("metrics")
    if not _has_methods(logger_value, ("bind", "info", "error")) or not _has_methods(
        metrics_value, ("increment", "timing", "gauge")
    ):
        return handler
    logger = cast(_LoggerLike, logger_value)
    metrics = cast(_MetricsLike, metrics_value)
    clock_value = telemetry.get("monotonic", time.monotonic)
    clock = cast(MonotonicClock, clock_value) if callable(clock_value) else time.monotonic
    utc_clock_value = telemetry.get("clock", lambda: datetime.now(UTC))
    utc_clock = (
        cast(UtcClock, utc_clock_value) if callable(utc_clock_value) else lambda: datetime.now(UTC)
    )

    def observed(arguments: Namespace) -> object:
        """Executa a etapa interna ``observed`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            arguments: Entrada ``arguments``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        trace_id = f"trace-{uuid.uuid4().hex}"
        explicit_run_id = getattr(arguments, "run_id", None)
        run_id = (
            explicit_run_id
            if command == "backfill" and isinstance(explicit_run_id, str) and explicit_run_id
            else f"{command}-{uuid.uuid4().hex}"
        )
        arguments._runtime_run_id = run_id
        try:
            bound_logger = cast(
                _LoggerLike,
                logger.bind(traceId=trace_id, runId=run_id, command=command),
            )
        except BaseException:
            bound_logger = logger
        initial = _context(arguments)
        _safe_log(
            bound_logger,
            "info",
            "ingestion.run.started",
            {"stage": "STARTING", **initial},
        )
        try:
            started = clock()
        except BaseException:
            started = None

        try:
            result = handler(arguments)
        except (Exception, KeyboardInterrupt) as error:
            duration_ms = _elapsed_ms(clock, started)
            message = safe_error_message(error)
            failure = {
                **_context(arguments),
                "stage": _text_attribute(error, "stage") or "FAILED",
                "durationMs": duration_ms,
                "errorCode": _text_attribute(error, "error_code") or type(error).__name__,
                "message": message,
            }
            if (request_id := _text_attribute(error, "request_id")) is not None:
                failure["requestId"] = request_id
            if (cause_type := _text_attribute(error, "cause_type")) is not None:
                failure["causeType"] = cause_type
            _safe_log(bound_logger, "error", "ingestion.run.failed", failure)
            _safe_log(
                bound_logger,
                "info",
                "ingestion.run.finished",
                {**failure, "stage": "FAILED", "status": "FAILED"},
            )
            dimensions = _metric_dimensions(
                command=command,
                status="FAILED",
                source_mode=source_mode,
                context=failure,
            )
            _safe_increment(metrics, "Runs", 1, dimensions)
            if duration_ms is not None:
                _safe_timing(metrics, "RunDurationMs", duration_ms, dimensions)
            _observe_outbox(metrics, outbox_backlog, utc_clock)
            raise

        duration_ms = _elapsed_ms(clock, started)
        terminal = _terminal_stage(result)
        context = _context(arguments, result)
        finished = {
            **context,
            "stage": terminal,
            "status": terminal,
            "durationMs": duration_ms,
            "errorCode": None,
        }
        if terminal == "FAILED":
            error_code, message = _result_error(result)
            finished.update(errorCode=error_code, message=message)
            _safe_log(bound_logger, "error", "ingestion.run.failed", finished)
        elif terminal == "PARTIAL":
            _safe_log(bound_logger, "error", "ingestion.run.partial", finished)
        _safe_log(bound_logger, "info", "ingestion.run.finished", finished)
        dimensions = _metric_dimensions(
            command=command,
            status=terminal,
            source_mode=source_mode,
            context=context,
        )
        _safe_increment(metrics, "Runs", 1, dimensions)
        if duration_ms is not None:
            _safe_timing(metrics, "RunDurationMs", duration_ms, dimensions)
        for field, value in _counts(result).items():
            metric = _COUNT_METRICS.get(field)
            if metric is not None:
                _safe_increment(metrics, metric, value, dimensions)
        local_disk_peak, analysis_watermarks, latest_observations = _typed_metrics(result)
        if local_disk_peak is not None:
            _safe_gauge(metrics, "LocalDiskPeakBytes", float(local_disk_peak), dimensions)
        for event_type, watermark in analysis_watermarks.items():
            if event_type in {"ANOMALY_DETECTION", "QOE_FORECAST"}:
                _safe_gauge(
                    metrics,
                    "WatermarkEpochSeconds",
                    watermark.timestamp(),
                    {"command": command, "event_type": event_type},
                )
        if command == "sync" and source_mode == "live":
            _observe_source_lag(metrics, latest_observations, utc_clock)
        if command == "export-incremental":
            _observe_incremental_export_lag(metrics, arguments, terminal, utc_clock)
        _observe_outbox(metrics, outbox_backlog, utc_clock)
        return result

    observed.telemetry_observed = True  # type: ignore[attr-defined]
    return observed


__all__ = ["BoundedDiskUsageReporter", "observe_command", "safe_error_message"]
