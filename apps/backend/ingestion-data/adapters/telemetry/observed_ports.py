"""Decora portas da aplicação com métricas sem alterar seus resultados ou falhas.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterable, Mapping
from datetime import UTC, datetime
from pathlib import Path

from domain.datasets import DatasetDescriptor
from domain.disk_budget import DiskBudget
from domain.models import CanonicalRecord, TimeWindow
from domain.run import RunProgress, RunStage, RunState, RunTransitionMetadata
from ports import (
    AthenaValidator,
    Cursor,
    EncodedPartition,
    MetricsPublisher,
    ParquetEncoder,
    QueryPlanEvidence,
    RestoreRequest,
    RestoreResult,
    RunRepository,
    SchemaObservation,
    SnapshotPreparer,
    SnapshotRestorer,
    SourcePage,
    SourceReader,
)

type MonotonicClock = Callable[[], float]
type UtcClock = Callable[[], datetime]


def _increment(
    metrics: MetricsPublisher, name: str, value: int, dimensions: Mapping[str, str]
) -> None:
    """Executa a etapa interna ``increment`` e valida seus efeitos antes de concluir.

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


def _gauge(
    metrics: MetricsPublisher, name: str, value: float, dimensions: Mapping[str, str]
) -> None:
    """Executa a etapa interna ``gauge`` e valida seus efeitos antes de concluir.

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


def _timing(
    metrics: MetricsPublisher, name: str, value: float, dimensions: Mapping[str, str]
) -> None:
    """Executa a etapa interna ``timing`` e valida seus efeitos antes de concluir.

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


class ObservedSourceReader(SourceReader):
    """Agrupa o estado e as operações de ``ObservedSourceReader`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        inner: SourceReader,
        metrics: MetricsPublisher,
        *,
        command: str,
        source_mode: str,
        clock: UtcClock = lambda: datetime.now(UTC),
        monotonic: MonotonicClock = time.monotonic,
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            inner: Entrada ``inner``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            metrics: Porta de métricas que recebe observações de baixa cardinalidade.
            command: Entrada ``command``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            source_mode: Entrada ``source_mode``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            clock: Função injetável que fornece o instante atual para validação e testes.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._inner = inner
        self._metrics = metrics
        self._command = command
        self._source_mode = source_mode
        self._clock = clock
        self._monotonic = monotonic

    def validate_schema(self, descriptor: DatasetDescriptor) -> SchemaObservation:
        """Valida esquema contra as invariantes deste módulo.

        Args:
            descriptor: Descritor físico e semântico do dataset processado.

        Returns:
            Valor ``SchemaObservation`` produzido pela operação após as validações.
        """
        observation = self._inner.validate_schema(descriptor)
        if not observation.is_compatible:
            _increment(
                self._metrics,
                "SchemaDrift",
                1,
                {"command": self._command, "source_mode": self._source_mode},
            )
        return observation

    def measure_coverage(self, descriptor: DatasetDescriptor):  # type: ignore[no-untyped-def]
        """Mede cobertura e devolve evidências explícitas da observação.

        Args:
            descriptor: Descritor físico e semântico do dataset processado.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        observation = self._inner.measure_coverage(descriptor)
        dimensions = {"dataset": descriptor.table, "source_mode": self._source_mode}
        if (
            observation.coverage_numerator is not None
            and observation.coverage_denominator is not None
            and (self._source_mode != "live" or observation.latest_observed_at is not None)
        ):
            _gauge(
                self._metrics,
                "CoverageRatio",
                observation.coverage_numerator / observation.coverage_denominator,
                {**dimensions, "coverage_status": observation.status.value},
            )
        if observation.latest_observed_at is not None:
            try:
                lag = max(
                    0.0,
                    (
                        self._clock().astimezone(UTC) - observation.latest_observed_at
                    ).total_seconds(),
                )
            except BaseException:
                pass
            else:
                _gauge(self._metrics, "SourceLagSeconds", lag, dimensions)
        if observation.verified_through is not None:
            _gauge(
                self._metrics,
                "WatermarkEpochSeconds",
                observation.verified_through.timestamp(),
                dimensions,
            )
        return observation

    def read_page(
        self,
        descriptor: DatasetDescriptor,
        window: TimeWindow | None,
        after: Cursor | None,
        limit: int,
    ) -> SourcePage:
        """Lê página sem ampliar o escopo solicitado.

        Args:
            descriptor: Descritor físico e semântico do dataset processado.
            window: Janela temporal UTC, fechada no início e aberta no fim.
            after: Cursor da última linha consumida; ``None`` inicia a paginação.
            limit: Quantidade máxima de itens que a operação pode processar.

        Returns:
            Valor ``SourcePage`` produzido pela operação após as validações.
        """
        try:
            started = self._monotonic()
        except BaseException:
            started = None
        page: SourcePage | None = None
        try:
            page = self._inner.read_page(descriptor, window, after, limit)
            return page
        finally:
            elapsed = _elapsed_ms(self._monotonic, started)
            dimensions = {
                "command": self._command,
                "source_mode": self._source_mode,
                "dataset": descriptor.table,
            }
            if elapsed is not None:
                _timing(self._metrics, "MySqlPageDurationMs", elapsed, dimensions)
            if page is not None:
                _increment(self._metrics, "MySqlPageRows", len(page.rows), dimensions)


class ObservedSnapshotQueryPreparer(SnapshotPreparer):
    """Observa o preflight de índices de cursor sem alterar seus resultados ou falhas."""

    def __init__(
        self,
        inner: SnapshotPreparer,
        metrics: MetricsPublisher,
        *,
        command: str,
        monotonic: MonotonicClock = time.monotonic,
    ) -> None:
        self._inner = inner
        self._metrics = metrics
        self._command = command
        self._monotonic = monotonic

    def prepare(
        self, descriptors: tuple[DatasetDescriptor, ...]
    ) -> tuple[QueryPlanEvidence, ...]:
        try:
            started = self._monotonic()
        except BaseException:
            started = None
        dimensions = {"command": self._command, "source_mode": "snapshot"}
        try:
            evidence = self._inner.prepare(descriptors)
        except BaseException:
            elapsed = _elapsed_ms(self._monotonic, started)
            if elapsed is not None:
                _timing(self._metrics, "MySqlPreflightDurationMs", elapsed, dimensions)
            _increment(self._metrics, "MySqlPreflightFailures", 1, dimensions)
            raise
        elapsed = _elapsed_ms(self._monotonic, started)
        if elapsed is not None:
            if evidence:
                _timing(self._metrics, "MySqlCursorIndexDurationMs", elapsed, dimensions)
            _timing(self._metrics, "MySqlPreflightDurationMs", elapsed, dimensions)
        return evidence


class ObservedSnapshotRestorer(SnapshotRestorer):
    """Agrupa o estado e as operações de ``ObservedSnapshotRestorer`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        inner: SnapshotRestorer,
        metrics: MetricsPublisher,
        *,
        command: str,
        monotonic: MonotonicClock = time.monotonic,
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            inner: Entrada ``inner``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            metrics: Porta de métricas que recebe observações de baixa cardinalidade.
            command: Entrada ``command``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            monotonic: Entrada ``monotonic``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._inner = inner
        self._metrics = metrics
        self._command = command
        self._monotonic = monotonic

    def restore(self, request: RestoreRequest, *, idempotency_key: str) -> RestoreResult:
        """Restaura o recurso e confirma sua identidade antes de concluir.

        Args:
            request: Objeto de entrada já estruturado para o caso de uso.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``RestoreResult`` produzido pela operação após as validações.
        """
        try:
            started = self._monotonic()
        except BaseException:
            started = None
        status = "SUCCEEDED"
        try:
            return self._inner.restore(request, idempotency_key=idempotency_key)
        except BaseException:
            status = "FAILED"
            raise
        finally:
            duration_ms = _elapsed_ms(self._monotonic, started)
            if duration_ms is not None:
                _timing(
                    self._metrics,
                    "RestoreDurationMs",
                    duration_ms,
                    {
                        "command": self._command,
                        "source_mode": "snapshot",
                        "status": status,
                    },
                )


class ObservedRunRepository(RunRepository):
    """Agrupa o estado e as operações de ``ObservedRunRepository`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(self, inner: RunRepository, metrics: MetricsPublisher, *, command: str) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            inner: Entrada ``inner``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            metrics: Porta de métricas que recebe observações de baixa cardinalidade.
            command: Entrada ``command``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._inner = inner
        self._metrics = metrics
        self._command = command

    def get_run_progress(self, run_id: str) -> RunProgress | None:
        return self._inner.get_run_progress(run_id)

    def get_run(self, run_id: str) -> RunState | None:
        """Obtém execução a partir da fonte configurada.

        Args:
            run_id: Identificador não secreto e estável da execução.

        Returns:
            Valor ``RunState | None`` produzido pela operação após as validações.
        """
        return self._inner.get_run(run_id)

    def create(self, state: RunState, *, idempotency_key: str) -> RunState:
        """Cria o recurso somente quando suas pré-condições são satisfeitas.

        Args:
            state: Estado imutável que será validado ou persistido.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``RunState`` produzido pela operação após as validações.
        """
        return self._inner.create(state, idempotency_key=idempotency_key)

    def transition(
        self,
        run_id: str,
        target: RunStage,
        *,
        expected_stage: RunStage,
        metadata: RunTransitionMetadata | None = None,
        mark_candidate_active: bool = False,
        idempotency_key: str,
    ) -> RunState:
        """Aplica uma transição usando o estado previamente observado como proteção.

        Args:
            run_id: Identificador não secreto e estável da execução.
            target: Estado ou destino solicitado para a operação.
            expected_stage: Valor esperado usado para detectar concorrência ou divergência de
            estado.
            metadata: Metadados associados ao registro ou à transição.
            mark_candidate_active: Entrada ``mark_candidate_active``; a forma aceita é definida
            pela anotação de tipo e validada antes do uso.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``RunState`` produzido pela operação após as validações.
        """
        state = self._inner.transition(
            run_id,
            target,
            expected_stage=expected_stage,
            metadata=metadata,
            mark_candidate_active=mark_candidate_active,
            idempotency_key=idempotency_key,
        )
        dimensions = {"command": self._command, "stage": expected_stage.value}
        if metadata is not None:
            _timing(self._metrics, "StageDurationMs", float(metadata.duration_ms), dimensions)
        if target in {RunStage.FAILED, RunStage.PARTIAL}:
            _increment(self._metrics, "StageFailures", 1, dimensions)
        return state

    def append_error(
        self,
        run_id: str,
        sequence: int,
        message: str,
        *,
        expected_stage: RunStage,
        idempotency_key: str,
    ) -> None:
        """Executa a etapa interna ``append_error`` e valida seus efeitos antes de concluir.

        Args:
            run_id: Identificador não secreto e estável da execução.
            sequence: Entrada ``sequence``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            message: Entrada ``message``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            expected_stage: Valor esperado usado para detectar concorrência ou divergência de
            estado.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        return self._inner.append_error(
            run_id,
            sequence,
            message,
            expected_stage=expected_stage,
            idempotency_key=idempotency_key,
        )


class ObservedAthenaValidator(AthenaValidator):
    """Agrupa o estado e as operações de ``ObservedAthenaValidator`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(self, inner: AthenaValidator, metrics: MetricsPublisher, *, command: str) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            inner: Entrada ``inner``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            metrics: Porta de métricas que recebe observações de baixa cardinalidade.
            command: Entrada ``command``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._inner = inner
        self._metrics = metrics
        self._command = command

    def validate_partition(
        self,
        table: str,
        dataset_version: str,
        partition: str,
        expected_row_count: int,
        *,
        aggregate_digest: str,
    ) -> int:
        """Valida partição contra as invariantes deste módulo.

        Args:
            table: Nome da tabela previamente autorizado pelo contrato.
            dataset_version: Identificador imutável da versão do dataset.
            partition: Identificador canônico da partição física ou lógica.
            expected_row_count: Valor esperado usado para detectar concorrência ou divergência
            de estado.

        Returns:
            Valor ``int`` produzido pela operação após as validações.
        """
        try:
            return self._inner.validate_partition(
                table,
                dataset_version,
                partition,
                expected_row_count,
                aggregate_digest=aggregate_digest,
            )
        except BaseException:
            _increment(self._metrics, "AthenaFailures", 1, {"command": self._command})
            raise

    def validate_legacy_partition(
        self,
        table: str,
        dataset_version: str,
        partition: str,
        expected_row_count: int,
    ) -> int:
        """Observe the explicitly named metadata-v1 validation path."""
        try:
            return self._inner.validate_legacy_partition(
                table, dataset_version, partition, expected_row_count
            )
        except BaseException:
            _increment(self._metrics, "AthenaFailures", 1, {"command": self._command})
            raise


class ObservedParquetEncoder(ParquetEncoder):
    """Agrupa o estado e as operações de ``ObservedParquetEncoder`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(self, inner: ParquetEncoder, metrics: MetricsPublisher, *, command: str) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            inner: Entrada ``inner``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            metrics: Porta de métricas que recebe observações de baixa cardinalidade.
            command: Entrada ``command``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._inner = inner
        self._metrics = metrics
        self._command = command

    def write_partition(
        self,
        records: Iterable[CanonicalRecord],
        descriptor: DatasetDescriptor,
        path: Path,
        *,
        dataset_version: str,
        expected_absent: bool,
        idempotency_key: str,
        disk_budget: DiskBudget | None = None,
    ) -> EncodedPartition:
        """Grava partição e devolve a evidência produzida pela operação.

        Args:
            records: Registros canônicos consumidos pela operação.
            descriptor: Descritor físico e semântico do dataset processado.
            path: Caminho local do artefato lido ou produzido.
            dataset_version: Identificador imutável da versão do dataset.
            expected_absent: Indica se a operação exige que o recurso ainda não exista.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.
            disk_budget: Entrada ``disk_budget``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.

        Returns:
            Valor ``EncodedPartition`` produzido pela operação após as validações.
        """
        try:
            return self._inner.write_partition(
                records,
                descriptor,
                path,
                dataset_version=dataset_version,
                expected_absent=expected_absent,
                idempotency_key=idempotency_key,
                disk_budget=disk_budget,
            )
        except BaseException:
            _increment(
                self._metrics,
                "ArchiveFailures",
                1,
                {"command": self._command, "component": "PARQUET"},
            )
            raise


__all__ = [
    "ObservedAthenaValidator",
    "ObservedParquetEncoder",
    "ObservedRunRepository",
    "ObservedSnapshotQueryPreparer",
    "ObservedSnapshotRestorer",
    "ObservedSourceReader",
]
