"""Orquestra o backfill completo de um snapshot ARGUS para uma nova versão do dataset.

O caso de uso restaura o dump, valida esquema e cobertura, normaliza cada tabela, persiste os
registros quentes, reconstrói projeções, publica partições históricas e envia os eventos da
outbox. Cada fase é registrada em :class:`domain.run.RunState`; assim, operadores conseguem
identificar até onde a execução avançou e uma repetição pode reutilizar efeitos já confirmados.

O módulo contém somente coordenação de aplicação. Acesso a MySQL, DynamoDB, S3, Glue, Athena e
mensageria acontece pelas interfaces de :mod:`ports`, recebidas por injeção de dependência.
A versão candidata só se torna ativa depois das validações e reconciliações obrigatórias; antes
disso, falhas deixam os dados invisíveis para consumidores. Leases, checkpoints e chaves de
idempotência protegem contra concorrência e retomadas após interrupção.

Este fluxo comprova consistência e proveniência dos registros, mas não escolhe políticas de
infraestrutura nem corrige dados inválidos da origem. Registros rejeitados, contagens e erros
sanitizados são preservados como evidência do resultado.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import sys
import threading
import time as monotonic_time
from collections.abc import Callable, Iterable, Iterator, Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from types import MappingProxyType
from typing import Protocol, cast

from application.archive_partition import (
    ArchivePartitionEncoder,
    ArchivePartitionPublisher,
    archive_partition_key,
)
from application.bucket_evidence import BucketEvidence
from application.publish_outbox import OutboxPublisher, PublishResult
from application.read_canonical_set import ArchiveRecords, CanonicalRecordSource
from application.rebuild_projections import ProjectionBuildResult, ProjectionService
from contracts.argus.v2.normalizers import NormalizationContext, normalize_row
from contracts.registry import DatasetRegistry
from domain.analysis import canonical_utc_text
from domain.archive import (
    canonical_archive_key,
    canonical_set_marker_key,
    canonical_staging_archive_key,
    legacy_canonical_archive_key,
    partition_date,
    validate_archive_partition,
)
from domain.canonical_json import canonical_bytes
from domain.canonical_set import (
    MAX_CANONICAL_OBJECT_BYTES,
    CanonicalDatasetEvidence,
    CanonicalObjectEvidence,
    CanonicalPartitionEvidence,
    CanonicalSet,
    canonical_set_aggregate_digest,
    canonical_set_to_document,
)
from domain.datasets import DatasetDescriptor
from domain.disk_budget import (
    DEFAULT_INGESTION_DISK_BUDGET_BYTES,
    MAX_INGESTION_DISK_BUDGET_BYTES,
    DiskBudget,
    DiskBudgetExceeded,
    DiskUsage,
    DiskUsageReporter,
    FreeBytes,
)
from domain.identity import canonical_dataset_version, dataset_version, sha256_id
from domain.models import CanonicalRecord, RecordType, TimeWindow
from domain.persisted_error import PersistedError
from domain.quality import CoverageStatus
from domain.run import (
    RunActivity,
    RunPipeline,
    RunStage,
    RunState,
    RunTransitionMetadata,
    materialize_hot_records_for,
)
from ports import (
    ArchiveObject,
    ArchivePartition,
    ArchiveState,
    CandidateManifest,
    CanonicalSetStore,
    CheckpointRepository,
    ConditionalWriteError,
    CoverageObservation,
    HotRecordSink,
    Lease,
    LeaseRepository,
    ManifestRepository,
    OutboxEvent,
    RestoreRequest,
    RunRepository,
    SchemaObservation,
    SnapshotChecksumMismatch,
    SnapshotPreparer,
    SnapshotRestorer,
    SourceReader,
    WindowCommitRepository,
)

type ReaderFactory = Callable[[], SourceReader]
type NormalizationContextFactory = Callable[[SourceReader], NormalizationContext]
type CanonicalRecordSourceFactory = Callable[[Path], CanonicalRecordSource]

_LOGGER = logging.getLogger(__name__)


class RunActivityReporter(Protocol):
    def report_activity(self, activity: RunActivity) -> None: ...


_REQUIRED_PROJECTION_FAMILIES = frozenset(
    {"overview", "incidents", "monitoring", "geography", "events", "evidence"}
)
_CANONICAL_OBJECT_ESTIMATED_BYTES = 384 * 1024 * 1024


def _analysis_source(event_type: str) -> str:
    """Monta o identificador da fonte de análise.

    Args:
        event_type: Entrada ``event_type``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return f"analysis:{event_type}"


_HOT_FAMILY = {
    RecordType.SIGNAL_OBSERVATION: "FACT#TS",
    RecordType.DIMENSIONAL_METRIC_AGGREGATE: "FACT#TS",
    RecordType.APPLICATION_ERROR_AGGREGATE: "FACT#TS",
    RecordType.SHADOW_OBSERVATION: "FACT#TS",
    RecordType.INCIDENT: "INCIDENT#TS",
    RecordType.LIVE_EVENT_CONTEXT: "CONTEXT#TS",
    RecordType.FINDING_STATUS_TRANSITION: "CONTEXT#TS",
    RecordType.UPSTREAM_SOURCE_HEALTH: "INGESTION#SOURCE",
    RecordType.UPSTREAM_COLLECTOR_RUN: "INGESTION#SOURCE",
}


def _require_text(value: object, field: str) -> str:
    """Valida e devolve texto, rejeitando entradas fora do contrato.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    if not value:
        raise ValueError(f"{field} must not be empty")
    return value


def _require_positive_int(value: object, field: str, *, maximum: int | None = None) -> int:
    """Valida e devolve positivo inteiro, rejeitando entradas fora do contrato.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.
        maximum: Entrada ``maximum``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``int`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field} must be an integer")
    if value <= 0 or (maximum is not None and value > maximum):
        suffix = f" between 1 and {maximum}" if maximum is not None else " positive"
        raise ValueError(f"{field} must be{suffix}")
    return value


def _utc_text(value: datetime) -> str:
    """Converte utc para sua representação textual canônica.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _record_watermark(record: CanonicalRecord, *, fallback: datetime | None = None) -> datetime:
    """Obtém ou registra marca d'água como evidência da execução atual.

    Args:
        record: Registro canônico consumido pela operação.
        fallback: Entrada ``fallback``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``datetime`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if record.window is not None:
        return record.window.end
    if record.observed_at is None and fallback is not None:
        return fallback
    if record.observed_at is None:
        raise ValueError("normalized records must expose an observation watermark")
    return record.observed_at


@dataclass(frozen=True, slots=True)
class BackfillRequest:
    """Reúne os limites e as evidências necessários para iniciar um backfill.

    A instância é imutável e validada na criação. Ela identifica o dump esperado, a data lógica
    do snapshot, o diretório temporário e os limites usados durante toda a execução.

    Attributes:
        run_id: Identificador não secreto e estável da execução.
        restore_request: Localização, tamanho e SHA-256 esperados do snapshot.
        snapshot_extracted_on: Data em que o conteúdo foi extraído da origem.
        archive_workdir: Diretório pertencente à execução para arquivos temporários.
        disk_budget_bytes: Máximo de bytes que a ingestão pode ocupar localmente.
        disk_free_bytes: Função opcional que consulta o espaço livre disponível.
        page_size: Quantidade máxima de linhas solicitada por página.
        lease_ttl_seconds: Duração de cada renovação do lease exclusivo da fonte.
        outbox_limit: Quantidade máxima de eventos enviada por lote.
        activate: Se verdadeiro, ativa a candidata após todas as reconciliações.
    """

    run_id: str
    restore_request: RestoreRequest
    snapshot_extracted_on: date
    archive_workdir: Path
    disk_budget_bytes: int = DEFAULT_INGESTION_DISK_BUDGET_BYTES
    disk_free_bytes: FreeBytes | None = field(default=None, repr=False, compare=False)
    page_size: int = 500
    lease_ttl_seconds: int = 300
    outbox_limit: int = 100
    activate: bool = True
    pipeline: RunPipeline = RunPipeline.LEGACY_V1
    materialize_hot_records: bool = True

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        _require_text(self.run_id, "run_id")
        if not isinstance(self.restore_request, RestoreRequest):
            raise TypeError("restore_request must be a RestoreRequest")
        if type(self.snapshot_extracted_on) is not date:
            raise TypeError("snapshot_extracted_on must be a date")
        if not isinstance(self.archive_workdir, Path):
            raise TypeError("archive_workdir must be a Path")
        _require_positive_int(
            self.disk_budget_bytes,
            "disk_budget_bytes",
            maximum=MAX_INGESTION_DISK_BUDGET_BYTES,
        )
        if self.disk_free_bytes is not None and not callable(self.disk_free_bytes):
            raise TypeError("disk_free_bytes must be callable or None")
        _require_positive_int(self.page_size, "page_size")
        _require_positive_int(self.lease_ttl_seconds, "lease_ttl_seconds")
        _require_positive_int(self.outbox_limit, "outbox_limit")
        if type(self.activate) is not bool:
            raise TypeError("activate must be a boolean")
        if not isinstance(self.pipeline, RunPipeline):
            raise TypeError("pipeline must be a RunPipeline")
        if type(self.materialize_hot_records) is not bool:
            raise TypeError("materialize_hot_records must be a boolean")
        if self.pipeline is RunPipeline.CANONICAL_V2 and self.materialize_hot_records:
            raise ValueError("canonical-v2 cannot materialize hot records")


@dataclass(frozen=True, slots=True)
class DatasetRunResult:
    """Resume as contagens reconciliadas do processamento de um dataset.

    Toda linha lida precisa ser aceita ou rejeitada; todo registro aceito precisa ser gravado ou
    reconhecido como já existente.

    Attributes:
        dataset: Nome do dataset permitido pelo registro de contratos.
        records_read: Total de linhas lidas da origem.
        records_accepted: Linhas convertidas para o modelo canônico.
        records_rejected: Linhas recusadas durante validação ou normalização.
        records_written: Registros novos efetivamente persistidos.
        records_unchanged: Registros idênticos já presentes no destino.
    """

    dataset: str
    records_read: int
    records_accepted: int
    records_rejected: int
    records_written: int
    records_unchanged: int

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        _require_text(self.dataset, "dataset")
        values = (
            self.records_read,
            self.records_accepted,
            self.records_rejected,
            self.records_written,
            self.records_unchanged,
        )
        if any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in values
        ):
            raise ValueError("dataset counters must be non-negative integers")
        if self.records_accepted + self.records_rejected != self.records_read:
            raise ValueError("accepted plus rejected must equal read")
        if self.records_written + self.records_unchanged != self.records_accepted:
            raise ValueError("written plus unchanged must equal accepted")


@dataclass(frozen=True, slots=True)
class ArchiveBuildResult:
    """Evidence returned only after a complete canonical generation is committed."""

    canonical_set: CanonicalSet
    new_objects: int
    written_records: int
    unchanged_records: int

    def __post_init__(self) -> None:
        if not isinstance(self.canonical_set, CanonicalSet):
            raise TypeError("canonical_set must be a CanonicalSet")
        for field_name in ("new_objects", "written_records", "unchanged_records"):
            value = getattr(self, field_name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{field_name} must be a non-negative integer")


@dataclass(frozen=True, slots=True)
class RunResult:
    """Expõe o estado terminal e as evidências consolidadas de um backfill.

    Somente execuções ``SUCCEEDED`` ou ``PARTIAL`` produzem este valor. As contagens globais
    reconciliam com os resultados individuais e a versão ativa permanece explícita.

    Attributes:
        run_id: Identificador não secreto e estável da execução.
        dataset_version: Identificador imutável da versão do dataset.
        stage: Entrada ``stage``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        active_dataset_version: Versão imutável usada para identidade e compatibilidade.
        records_read: Entrada ``records_read``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.
        records_accepted: Entrada ``records_accepted``; a forma aceita é definida pela anotação
        de tipo e validada antes do uso.
        records_rejected: Entrada ``records_rejected``; a forma aceita é definida pela anotação
        de tipo e validada antes do uso.
        records_written: Entrada ``records_written``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        records_unchanged: Entrada ``records_unchanged``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        new_archive_objects: Entrada ``new_archive_objects``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        new_analysis_events: Entrada ``new_analysis_events``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        datasets: Entrada ``datasets``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        local_disk_usage: Entrada ``local_disk_usage``; a forma aceita é definida pela anotação
        de tipo e validada antes do uso.
    """

    run_id: str
    dataset_version: str
    stage: RunStage
    active_dataset_version: str | None
    records_read: int
    records_accepted: int
    records_rejected: int
    records_written: int
    records_unchanged: int
    new_archive_objects: int
    new_analysis_events: int
    datasets: Mapping[str, DatasetRunResult]
    local_disk_usage: DiskUsage

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        _require_text(self.run_id, "run_id")
        _require_text(self.dataset_version, "dataset_version")
        if self.stage not in {RunStage.SUCCEEDED, RunStage.PARTIAL}:
            raise ValueError("RunResult requires a successful or partial terminal stage")
        if self.active_dataset_version is not None:
            _require_text(self.active_dataset_version, "active_dataset_version")
        values = (
            self.records_read,
            self.records_accepted,
            self.records_rejected,
            self.records_written,
            self.records_unchanged,
            self.new_archive_objects,
            self.new_analysis_events,
        )
        if any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in values
        ):
            raise ValueError("run counters must be non-negative integers")
        if self.records_accepted + self.records_rejected != self.records_read:
            raise ValueError("run accepted plus rejected must equal read")
        if self.records_written + self.records_unchanged != self.records_accepted:
            raise ValueError("run written plus unchanged must equal accepted")
        frozen = dict(self.datasets)
        if any(not isinstance(value, DatasetRunResult) for value in frozen.values()):
            raise TypeError("datasets must contain only DatasetRunResult values")
        if any(key != value.dataset for key, value in frozen.items()):
            raise ValueError("dataset result keys must match their dataset")
        if not isinstance(self.local_disk_usage, DiskUsage):
            raise TypeError("local_disk_usage must be DiskUsage")
        object.__setattr__(self, "datasets", MappingProxyType(frozen))


class BackfillFailed(RuntimeError):
    """Indica que ``BackfillFailed`` impediu a operação de continuar com segurança."""

    def __init__(self, stage: RunStage, message: str) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            stage: Entrada ``stage``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            message: Entrada ``message``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self.stage = stage
        self.persisted_message = PersistedError.from_untrusted(message).message
        super().__init__(self.persisted_message)


class BackfillValidationError(RuntimeError):
    """Indica que ``BackfillValidationError`` impediu a operação de continuar com segurança."""


class SourceSchemaInvalid(BackfillValidationError):
    """The source schema or required coverage is incompatible with the import contract."""


class DataReconciliationError(BackfillValidationError):
    """Counts, partition identity, or immutable evidence disagree."""


@dataclass(slots=True)
class _IngestionState:
    """Representa os dados de ``_IngestionState`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        results: Entrada ``results``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        records: Registros canônicos consumidos pela operação.
        current_read: Valor atualmente observado, usado como base da validação ou transição.
        current_accepted: Valor atualmente observado, usado como base da validação ou transição.
        current_rejected: Valor atualmente observado, usado como base da validação ou transição.
        current_written: Valor atualmente observado, usado como base da validação ou transição.
        current_unchanged: Valor atualmente observado, usado como base da validação ou
        transição.
    """

    results: dict[str, DatasetRunResult]
    records: _RecordSpool
    current_read: int = 0
    current_accepted: int = 0
    current_rejected: int = 0
    current_written: int = 0
    current_unchanged: int = 0

    @property
    def read(self) -> int:
        """Lê e devolve o conteúdo solicitado pela interface desta instância.

        Returns:
            Valor ``int`` produzido pela operação após as validações.
        """
        return sum(item.records_read for item in self.results.values()) + self.current_read

    @property
    def accepted(self) -> int:
        """Devolve a quantidade acumulada de registros aceitos.

        Returns:
            Valor ``int`` produzido pela operação após as validações.
        """
        return sum(item.records_accepted for item in self.results.values()) + self.current_accepted

    @property
    def rejected(self) -> int:
        """Devolve a quantidade acumulada de registros rejeitados.

        Returns:
            Valor ``int`` produzido pela operação após as validações.
        """
        return sum(item.records_rejected for item in self.results.values()) + self.current_rejected

    @property
    def written(self) -> int:
        """Devolve a quantidade acumulada de registros efetivamente gravados.

        Returns:
            Valor ``int`` produzido pela operação após as validações.
        """
        return sum(item.records_written for item in self.results.values()) + self.current_written

    @property
    def unchanged(self) -> int:
        """Devolve a quantidade acumulada de registros que já estavam persistidos.

        Returns:
            Valor ``int`` produzido pela operação após as validações.
        """
        return (
            sum(item.records_unchanged for item in self.results.values()) + self.current_unchanged
        )

    def complete_dataset(self, result: DatasetRunResult) -> None:
        """Conclui dataset e devolve a evidência final da operação.

        Args:
            result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self.results[result.dataset] = result
        self.current_read = 0
        self.current_accepted = 0
        self.current_rejected = 0
        self.current_written = 0
        self.current_unchanged = 0


class _RunActivityTracker:
    """Keeps a thread-safe, public-safe snapshot for progress polling."""

    def __init__(
        self,
        reporter: RunActivityReporter | None,
        stage: RunStage,
        started_at: datetime,
        datasets_total: int,
    ) -> None:
        self._reporter = reporter
        self._lock = threading.Lock()
        self._stage = stage
        self._stage_started_at = started_at
        self._datasets_total = datasets_total
        self._datasets_completed = 0
        self._current_dataset: str | None = None
        self._records_read = 0
        self._records_written = 0
        self._records_rejected = 0
        self._records_total: int | None = None
        self._substage: str | None = None
        self._units_completed: int | None = None
        self._units_total: int | None = None
        self._unit_label: str | None = None

    def _activity(self, observed_at: datetime) -> RunActivity:
        return RunActivity(
            stage=self._stage,
            stage_started_at=self._stage_started_at,
            observed_at=max(observed_at, self._stage_started_at),
            records_read=self._records_read,
            records_written=self._records_written,
            records_rejected=self._records_rejected,
            records_total=self._records_total,
            current_dataset=self._current_dataset,
            datasets_completed=self._datasets_completed,
            datasets_total=self._datasets_total,
            substage=self._substage,
            units_completed=self._units_completed,
            units_total=self._units_total,
            unit_label=self._unit_label,
        )

    def _publish(self, observed_at: datetime) -> None:
        if self._reporter is None:
            return
        with self._lock:
            activity = self._activity(observed_at)
        try:
            self._reporter.report_activity(activity)
        except Exception:
            # Telemetry is best-effort and must never abort durable ingestion work.
            return

    def begin(
        self,
        stage: RunStage,
        started_at: datetime,
        ingestion: _IngestionState,
        *,
        substage: str | None = None,
        units_completed: int | None = None,
        units_total: int | None = None,
        unit_label: str | None = None,
    ) -> None:
        with self._lock:
            self._stage = stage
            self._stage_started_at = started_at
            self._current_dataset = None
            self._datasets_completed = min(len(ingestion.results), self._datasets_total)
            self._records_read = ingestion.read
            self._records_written = ingestion.written
            self._records_rejected = ingestion.rejected
            self._substage = substage
            self._units_completed = units_completed
            self._units_total = units_total
            self._unit_label = unit_label
            if stage in {RunStage.STARTING, RunStage.RESTORING, RunStage.VALIDATING}:
                self._records_total = None
        self._publish(started_at)

    def advance(
        self,
        observed_at: datetime,
        ingestion: _IngestionState,
        *,
        current_dataset: str | None,
        datasets_completed: int,
        records_total: int | None,
    ) -> None:
        with self._lock:
            self._current_dataset = current_dataset
            self._datasets_completed = datasets_completed
            self._records_read = ingestion.read
            self._records_written = ingestion.written
            self._records_rejected = ingestion.rejected
            self._records_total = records_total
        self._publish(observed_at)

    def heartbeat(self, observed_at: datetime) -> None:
        self._publish(observed_at)


@dataclass(slots=True)
class _RecordEvidence:
    """Representa os dados de ``_RecordEvidence`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        count: Entrada ``count``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        first: Entrada ``first``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        last: Entrada ``last``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        flags: Entrada ``flags``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
    """

    count: int = 0
    first: datetime | None = None
    last: datetime | None = None
    flags: set[str] | None = None


def _thaw(value: object) -> object:
    """Executa a etapa interna ``thaw`` e devolve o resultado validado indicado pela assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``object`` produzido pela operação após as validações.
    """
    if isinstance(value, Mapping):
        return {key: _thaw(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return tuple(_thaw(item) for item in value)
    return value


def _spool_value(record: CanonicalRecord) -> dict[str, object]:
    """Produz o valor de spool usado pela etapa seguinte.

    Args:
        record: Registro canônico consumido pela operação.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.
    """
    return {
        "schema_version": record.schema_version,
        "record_type": record.record_type.value,
        "source_system": record.source_system,
        "source_dataset": record.source_dataset,
        "natural_key": _thaw(record.natural_key),
        "observed_at": record.observed_at,
        "window": (
            {
                "start": record.window.start,
                "end": record.window.end,
                "grain_seconds": record.window.grain_seconds,
            }
            if record.window is not None
            else None
        ),
        "dimensions": _thaw(record.dimensions),
        "measures": _thaw(record.measures),
        "quality": _thaw(record.quality),
        "quality_flags": record.quality_flags,
    }


def _restore_spool_value(value: object) -> object:
    """Restaura spool valor e confirma sua identidade antes de concluir.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``object`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if isinstance(value, list):
        return tuple(_restore_spool_value(item) for item in value)
    if not isinstance(value, Mapping):
        return value
    if set(value) == {"$decimal"} and isinstance(value["$decimal"], str):
        return Decimal(value["$decimal"])
    if set(value) == {"$datetime"} and isinstance(value["$datetime"], str):
        restored = datetime.fromisoformat(value["$datetime"].replace("Z", "+00:00"))
        if restored.utcoffset() != timedelta(0):
            raise ValueError("record spool datetime must be UTC")
        return restored.astimezone(UTC)
    return {key: _restore_spool_value(item) for key, item in value.items()}


def _record_from_spool(value: object) -> CanonicalRecord:
    """Obtém ou registra from spool como evidência da execução atual.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    if not isinstance(value, Mapping) or set(value) != {
        "schema_version",
        "record_type",
        "source_system",
        "source_dataset",
        "natural_key",
        "observed_at",
        "window",
        "dimensions",
        "measures",
        "quality",
        "quality_flags",
    }:
        raise TypeError("record spool contains an invalid record")
    restored = _restore_spool_value(value)
    assert isinstance(restored, Mapping)
    raw_window = restored["window"]
    window = None
    if raw_window is not None:
        if not isinstance(raw_window, Mapping) or set(raw_window) != {
            "start",
            "end",
            "grain_seconds",
        }:
            raise TypeError("record spool contains an invalid window")
        window = TimeWindow(
            raw_window["start"],
            raw_window["end"],
            raw_window["grain_seconds"],
        )
    return CanonicalRecord(
        schema_version=restored["schema_version"],
        record_type=RecordType(restored["record_type"]),
        source_system=restored["source_system"],
        source_dataset=restored["source_dataset"],
        natural_key=restored["natural_key"],
        observed_at=restored["observed_at"],
        window=window,
        dimensions=restored["dimensions"],
        measures=restored["measures"],
        quality=restored["quality"],
        quality_flags=restored["quality_flags"],
    )


def _manifest_evidence(value: object) -> object:
    """Executa a etapa interna ``manifest_evidence`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``object`` produzido pela operação após as validações.
    """
    if isinstance(value, Mapping):
        return {
            key: _manifest_evidence(item) for key, item in value.items() if key != "validatedAt"
        }
    if isinstance(value, tuple | list):
        return tuple(_manifest_evidence(item) for item in value)
    return value


def _same_candidate_evidence(left: CandidateManifest, right: CandidateManifest) -> bool:
    """Compara as evidências e informa se candidato evidência é equivalente.

    Args:
        left: Entrada ``left``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        right: Entrada ``right``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.
    """
    left_metadata = dict(left.metadata)
    right_metadata = dict(right.metadata)
    # hotFrom é um cursor de retenção relativo ao relógio, não a identidade da origem/arquivo.
    left_metadata.pop("hotFrom", None)
    right_metadata.pop("hotFrom", None)
    return left.dataset_version == right.dataset_version and canonical_bytes(
        _manifest_evidence(left_metadata)
    ) == canonical_bytes(_manifest_evidence(right_metadata))


class _RecordSpool:
    """Agrupa o estado e as operações de ``_RecordSpool`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        root: Path,
        snapshot_date: date,
        disk_budget: DiskBudget | None = None,
        *,
        workspace_root: Path | None = None,
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            root: Entrada ``root``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            snapshot_date: Data civil usada para particionamento ou proveniência.
            disk_budget: Entrada ``disk_budget``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            workspace_root: Entrada ``workspace_root``; a forma aceita é definida pela anotação
            de tipo e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        if disk_budget is not None and not isinstance(disk_budget, DiskBudget):
            raise TypeError("disk_budget must be DiskBudget or None")
        self._root = root
        self._workspace_root = workspace_root or root
        self._snapshot_date = snapshot_date
        self._disk_budget = disk_budget or DiskBudget(
            self._workspace_root, DEFAULT_INGESTION_DISK_BUDGET_BYTES
        )
        self._paths: dict[tuple[str, str], Path] = {}
        self._evidence: dict[tuple[str, str], _RecordEvidence] = {}
        self.cleanup()
        self._bucket_evidence = BucketEvidence(root, disk_budget=self._disk_budget)

    def _path(self, dataset: str, partition: str) -> Path:
        """Executa a etapa interna ``path`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            dataset: Nome do dataset permitido pelo registro de contratos.
            partition: Identificador canônico da partição física ou lógica.

        Returns:
            Valor ``Path`` produzido pela operação após as validações.
        """
        key = (dataset, partition)
        path = self._paths.get(key)
        if path is None:
            token = sha256_id("spool_", {"dataset": dataset, "partition": partition})
            path = self._root / f"{token}.jsonl"
            self._paths[key] = path
        return path

    def append(
        self,
        dataset: str,
        partition: str,
        records: tuple[CanonicalRecord, ...],
    ) -> None:
        """Acrescenta a entrada validada preservando a ordem de processamento.

        Args:
            dataset: Nome do dataset permitido pelo registro de contratos.
            partition: Identificador canônico da partição física ou lógica.
            records: Registros canônicos consumidos pela operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not records:
            return
        if any(record.source_dataset != dataset for record in records):
            raise ValueError("spooled records must belong to their dataset")
        self._disk_budget.reserve(
            len(canonical_bytes(tuple(_spool_value(record) for record in records))) + 1,
            "JSONL record spool",
        )
        self._root.mkdir(parents=True, exist_ok=True)
        with self._path(dataset, partition).open("ab") as stream:
            stream.write(canonical_bytes(tuple(_spool_value(record) for record in records)))
            stream.write(b"\n")
        self._disk_budget.observe()
        self.observe(dataset, partition, records)

    def observe(
        self,
        dataset: str,
        partition: str,
        records: tuple[CanonicalRecord, ...],
    ) -> None:
        """Retain lightweight manifest evidence without recreating the JSONL spool."""
        if any(record.source_dataset != dataset for record in records):
            raise ValueError("observed records must belong to their dataset")
        self._bucket_evidence.add(dataset, records, partition=partition)
        evidence = self._evidence.setdefault((dataset, partition), _RecordEvidence(flags=set()))
        for record in records:
            start = (
                record.window.start
                if record.window is not None
                else record.observed_at
                or datetime.combine(self._snapshot_date, time.min, tzinfo=UTC)
            )
            end = _record_watermark(record, fallback=start)
            evidence.count += 1
            evidence.first = start if evidence.first is None else min(evidence.first, start)
            evidence.last = end if evidence.last is None else max(evidence.last, end)
            assert evidence.flags is not None
            evidence.flags.update(record.quality_flags)

    def release_records(self) -> None:
        """Release local normalized records before canonical S3 projection reads."""
        self._bucket_evidence.close()
        for path in tuple(self._paths.values()):
            path.unlink(missing_ok=True)
        self._paths.clear()
        self._evidence.clear()
        self._bucket_evidence = BucketEvidence(self._root, disk_budget=self._disk_budget)

    def clear_dataset(self, dataset: str) -> None:
        """Executa a etapa interna ``clear_dataset`` e valida seus efeitos antes de concluir.

        Args:
            dataset: Nome do dataset permitido pelo registro de contratos.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        for key, path in tuple(self._paths.items()):
            if key[0] == dataset:
                path.unlink(missing_ok=True)
                del self._paths[key]
        for key in tuple(self._evidence):
            if key[0] == dataset:
                del self._evidence[key]
        self._bucket_evidence.clear_dataset(dataset)

    def iter_batches(self, key: tuple[str, str]) -> Iterator[tuple[CanonicalRecord, ...]]:
        """Produz batches de forma incremental e com memória limitada.

        Args:
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Iterador que produz os itens válidos à medida que são processados.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        path = self._paths[key]
        with path.open("r", encoding="utf-8") as stream:
            for line in stream:
                chunk = json.loads(line)
                if not isinstance(chunk, list):
                    raise TypeError("record spool contains an invalid chunk")
                yield tuple(_record_from_spool(record) for record in chunk)

    def iter_records(self, key: tuple[str, str]) -> Iterator[CanonicalRecord]:
        """Produz registros de forma incremental e com memória limitada.

        Args:
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Iterador que produz os itens válidos à medida que são processados.
        """
        for batch in self.iter_batches(key):
            yield from batch

    def keys(self) -> tuple[tuple[str, str], ...]:
        """Executa a etapa interna ``keys`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``tuple[tuple[str, str], ...]`` produzido pela operação após as validações.
        """
        return tuple(sorted(self._paths))

    def reserve_records(
        self,
        dataset: str,
        grouped: Mapping[str, tuple[CanonicalRecord, ...]],
    ) -> None:
        """Reserva espaço para registros antes de iniciar a alocação.

        Args:
            dataset: Nome do dataset permitido pelo registro de contratos.
            grouped: Entrada ``grouped``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(dataset, str) or not dataset:
            raise ValueError("dataset must be non-empty text")
        required = sum(
            len(canonical_bytes(tuple(_spool_value(record) for record in records))) + 1
            for records in grouped.values()
        ) + sum(len(records) * 4_096 for records in grouped.values())
        self._disk_budget.reserve(required, "normalized record materialization")

    def archive_path(self, candidate: str, dataset: str, safe_partition: str) -> Path:
        """Monta o caminho de arquivo histórico sem permitir escapar do diretório autorizado.

        Args:
            candidate: Manifesto candidato que poderá se tornar ativo.
            dataset: Nome do dataset permitido pelo registro de contratos.
            safe_partition: Entrada ``safe_partition``; a forma aceita é definida pela anotação
            de tipo e validada antes do uso.

        Returns:
            Valor ``Path`` produzido pela operação após as validações.
        """
        return (
            self._workspace_root / "partitions" / candidate / dataset / f"{safe_partition}.parquet"
        )

    @property
    def disk_budget(self) -> DiskBudget:
        """Executa a etapa interna ``disk_budget`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``DiskBudget`` produzido pela operação após as validações.
        """
        return self._disk_budget

    def disk_usage(self) -> DiskUsage:
        """Executa a etapa interna ``disk_usage`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``DiskUsage`` produzido pela operação após as validações.
        """
        return self._disk_budget.observe()

    def day_batches(
        self,
    ) -> Iterator[Mapping[tuple[str, str], tuple[CanonicalRecord, ...]]]:
        """Executa a etapa interna ``day_batches`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Iterador que produz os itens válidos à medida que são processados.
        """
        days: dict[date, list[tuple[str, str]]] = {}
        for key in self.keys():
            days.setdefault(partition_date(key[1]), []).append(key)
        for day in sorted(days):
            for key in sorted(days[day]):
                for batch in self.iter_batches(key):
                    yield MappingProxyType({key: batch})

    def dataset_count(self, dataset: str) -> int:
        """Executa a etapa interna ``dataset_count`` e devolve o resultado validado indicado
        pela assinatura.

        Args:
            dataset: Nome do dataset permitido pelo registro de contratos.

        Returns:
            Valor ``int`` produzido pela operação após as validações.
        """
        return sum(
            evidence.count
            for (evidence_dataset, _partition), evidence in self._evidence.items()
            if evidence_dataset == dataset
        )

    def partition_count(self, key: tuple[str, str]) -> int:
        """Executa a etapa interna ``partition_count`` e devolve o resultado validado indicado
        pela assinatura.

        Args:
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Valor ``int`` produzido pela operação após as validações.
        """
        evidence = self._evidence.get(key)
        return evidence.count if evidence is not None else 0

    def dataset_evidence(
        self, descriptor: DatasetDescriptor
    ) -> tuple[list[dict[str, str]], str | None, tuple[str, ...]]:
        """Executa a etapa interna ``dataset_evidence`` e devolve o resultado validado indicado
        pela assinatura.

        Args:
            descriptor: Descritor físico e semântico do dataset processado.

        Returns:
            Valor ``tuple[list[dict[str, str]], str | None, tuple[str, ...]]`` produzido pela
            operação após as validações.
        """
        dataset = descriptor.table
        available, last, interval_flags = self._bucket_evidence.intervals(dataset)
        flags = tuple(
            sorted(
                {
                    flag
                    for (evidence_dataset, _partition), item in self._evidence.items()
                    if evidence_dataset == dataset
                    for flag in (item.flags or ())
                }
                | set(interval_flags)
            )
        )
        return (
            available,
            last,
            flags,
        )

    def common_complete_window(
        self, datasets: tuple[str, ...], grain_seconds: int
    ) -> TimeWindow | None:
        """Executa a etapa interna ``common_complete_window`` e devolve o resultado validado
        indicado pela assinatura.

        Args:
            datasets: Entrada ``datasets``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            grain_seconds: Duração ou prazo expresso em segundos.

        Returns:
            Valor ``TimeWindow | None`` produzido pela operação após as validações.
        """
        return self._bucket_evidence.common_complete_window(datasets, grain_seconds)

    def cleanup(self) -> None:
        """Remove recursos temporários pertencentes à execução atual.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        evidence = getattr(self, "_bucket_evidence", None)
        if evidence is not None:
            evidence.close()
        if self._workspace_root.exists():
            shutil.rmtree(self._workspace_root)
        try:
            self._workspace_root.parent.rmdir()
        except OSError:
            pass
        self._paths.clear()
        self._evidence.clear()


class _LeaseHeartbeat:
    """Agrupa o estado e as operações de ``_LeaseHeartbeat`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        repository: LeaseRepository,
        lease: Lease,
        ttl_seconds: int,
        clock: Callable[[], datetime],
        run_id: str,
        on_renew: Callable[[datetime], None] | None = None,
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            repository: Porta de persistência usada pelo caso de uso.
            lease: Entrada ``lease``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            ttl_seconds: Duração do lease ou da retenção, expressa em segundos.
            clock: Função injetável que fornece o instante atual para validação e testes.
            run_id: Identificador não secreto e estável da execução.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._repository = repository
        self._lease = lease
        self._ttl_seconds = ttl_seconds
        self._clock = clock
        self._run_id = run_id
        self._on_renew = on_renew
        self._interval = max(0.05, min(float(ttl_seconds) / 3, 30.0))
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._error: Exception | None = None
        self._sequence = 0
        self._thread = threading.Thread(
            target=self._run,
            name=f"lease-heartbeat-{run_id}",
            daemon=True,
        )
        self._started = False

    def start(self) -> None:
        """Inicia o processamento ou recurso gerenciado pela instância.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._thread.start()
        self._started = True

    def _renew(self) -> None:
        """Renova a entrada sem permitir redução do prazo já persistido.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        with self._lock:
            if self._error is not None:
                raise self._error
            now = self._clock()
            self._sequence += 1
            try:
                self._lease = self._repository.renew(
                    self._lease.source,
                    self._lease.owner,
                    now,
                    self._ttl_seconds,
                    expected_expires_at=self._lease.expires_at,
                    idempotency_key=(f"lease-renew:{self._run_id}:{self._sequence}"),
                )
                if self._on_renew is not None:
                    self._on_renew(now)
            except Exception as error:
                self._error = error
                raise

    def _run(self) -> None:
        """Executa a etapa interna ``run`` e valida seus efeitos antes de concluir.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        while not self._stop.wait(self._interval):
            try:
                self._renew()
            except Exception:
                return

    def checkpoint(self) -> None:
        """Renova e verifica o lease antes de continuar o processamento.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._renew()

    def fence(self) -> None:
        """Confirma que o lease ainda pertence à execução antes do efeito final.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self.stop()
        self._renew()

    def stop(self, timeout_seconds: float = 1.0) -> None:
        """Solicita a interrupção segura do processamento gerenciado.

        Args:
            timeout_seconds: Duração ou prazo expresso em segundos.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TimeoutError: Se a operação externa ultrapassar o tempo limite configurado.
        """
        self._stop.set()
        if self._started:
            self._thread.join(timeout_seconds)
            if self._thread.is_alive():
                raise TimeoutError("lease heartbeat did not stop before the cleanup deadline")
            self._started = False


@dataclass(slots=True)
class _StageTimer:
    """Representa os dados de ``_StageTimer`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        clock: Função injetável que fornece o instante atual para validação e testes.
        started_at: Instante UTC com fuso horário usado pela regra temporal.
        recorded_read: Entrada ``recorded_read``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        recorded_written: Entrada ``recorded_written``; a forma aceita é definida pela anotação
        de tipo e validada antes do uso.
        recorded_rejected: Entrada ``recorded_rejected``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        pending: Entrada ``pending``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
    """

    clock: Callable[[], datetime]
    started_at: datetime
    recorded_read: int = 0
    recorded_written: int = 0
    recorded_rejected: int = 0
    pending: dict[
        tuple[RunStage, RunStage],
        tuple[RunTransitionMetadata, tuple[int, int, int]],
    ] = field(default_factory=dict)

    def prepare(
        self,
        source: RunStage,
        target: RunStage,
        ingestion: _IngestionState,
        error: str | None,
        *,
        substage: str | None = None,
        units_completed: int | None = None,
        units_total: int | None = None,
        unit_label: str | None = None,
    ) -> RunTransitionMetadata:
        """Prepara a entrada e valida suas pré-condições antes dos efeitos externos.

        Args:
            source: Identificador da fonte de dados processada.
            target: Estado ou destino solicitado para a operação.
            ingestion: Entrada ``ingestion``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            error: Entrada ``error``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Valor ``RunTransitionMetadata`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        key = (source, target)
        existing = self.pending.get(key)
        if existing is not None:
            return existing[0]
        finished_at = self.clock()
        elapsed = finished_at - self.started_at
        if elapsed < timedelta(0):
            raise ValueError("clock moved backwards while measuring a run stage")
        totals = (ingestion.read, ingestion.written, ingestion.rejected)
        recorded = (self.recorded_read, self.recorded_written, self.recorded_rejected)
        deltas = tuple(total - previous for total, previous in zip(totals, recorded, strict=True))
        if any(value < 0 for value in deltas):
            raise ValueError("ingestion counters moved backwards while measuring a run stage")
        metadata = RunTransitionMetadata(
            finished_at,
            duration_ms=int(elapsed.total_seconds() * 1000),
            records_read=deltas[0],
            records_written=deltas[1],
            records_rejected=deltas[2],
            error=error,
            substage=substage,
            units_completed=units_completed,
            units_total=units_total,
            unit_label=unit_label,
        )
        self.pending[key] = (metadata, totals)
        return metadata

    def commit(self, source: RunStage, target: RunStage) -> None:
        """Confirma a entrada atomicamente usando as evidências esperadas.

        Args:
            source: Identificador da fonte de dados processada.
            target: Estado ou destino solicitado para a operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        metadata, totals = self.pending.pop((source, target))
        self.started_at = metadata.transitioned_at
        self.recorded_read, self.recorded_written, self.recorded_rejected = totals


class Backfill:
    """Coordena as fases do backfill sem conhecer implementações de infraestrutura.

    Todas as dependências com efeitos externos são portas injetadas no construtor. A classe
    mantém a máquina de estados, renova o lease durante operações longas e só avança depois de
    persistir evidências suficientes para uma retomada segura.
    """

    def __init__(
        self,
        *,
        registry: DatasetRegistry,
        restorer: SnapshotRestorer,
        reader_factory: ReaderFactory,
        hot_sink: HotRecordSink,
        checkpoints: CheckpointRepository,
        leases: LeaseRepository,
        runs: RunRepository,
        manifests: ManifestRepository,
        projections: ProjectionService,
        archive_encoder: ArchivePartitionEncoder,
        archive_publisher: ArchivePartitionPublisher,
        window_commits: WindowCommitRepository,
        outbox_publisher: OutboxPublisher,
        clock: Callable[[], datetime],
        normalization_context: NormalizationContextFactory | None = None,
        analysis_dependencies: Mapping[str, tuple[str, ...]] | None = None,
        activity_reporter: RunActivityReporter | None = None,
        disk_usage_reporter: DiskUsageReporter | None = None,
        snapshot_preparer: SnapshotPreparer | None = None,
        canonical_sets: CanonicalSetStore | None = None,
        canonical_source_factory: CanonicalRecordSourceFactory | None = None,
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            registry: Entrada ``registry``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            restorer: Entrada ``restorer``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            reader_factory: Fábrica injetada que cria a dependência somente quando necessária.
            hot_sink: Destino injetado que recebe os valores validados.
            checkpoints: Entrada ``checkpoints``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            leases: Entrada ``leases``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            runs: Entrada ``runs``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            manifests: Entrada ``manifests``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            projections: Entrada ``projections``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            archive_encoder: Codificador injetado que produz o formato de persistência.
            archive_publisher: Publicador injetado que envia dados e confirma o destino.
            window_commits: Entrada ``window_commits``; a forma aceita é definida pela anotação
            de tipo e validada antes do uso.
            outbox_publisher: Publicador injetado que envia dados e confirma o destino.
            clock: Função injetável que fornece o instante atual para validação e testes.
            normalization_context: Entrada ``normalization_context``; a forma aceita é definida
            pela anotação de tipo e validada antes do uso.
            analysis_dependencies: Entrada ``analysis_dependencies``; a forma aceita é definida
            pela anotação de tipo e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        self._registry = registry
        self._restorer = restorer
        self._reader_factory = reader_factory
        self._hot_sink = hot_sink
        self._checkpoints = checkpoints
        self._leases = leases
        self._runs = runs
        self._manifests = manifests
        self._projections = projections
        self._archive_encoder = archive_encoder
        self._archive_publisher = archive_publisher
        self._window_commits = window_commits
        self._outbox_publisher = outbox_publisher
        self._clock = clock
        self._activity_reporter = activity_reporter
        self._disk_usage_reporter = disk_usage_reporter
        self._snapshot_preparer = snapshot_preparer
        self._canonical_sets = canonical_sets
        self._canonical_source_factory = canonical_source_factory
        self._activity: _RunActivityTracker | None = None
        self._normalization_context = normalization_context or (
            lambda _reader: NormalizationContext()
        )
        dependencies = analysis_dependencies or {
            "ANOMALY_DETECTION": ("signal_bucket", "live_active_15min"),
            "QOE_FORECAST": ("live_qoe_hourly",),
        }
        if set(dependencies) != {"ANOMALY_DETECTION", "QOE_FORECAST"}:
            raise ValueError("analysis_dependencies must declare the two supported event types")
        known = set(registry.names())
        if any(not values or not set(values) <= known for values in dependencies.values()):
            raise ValueError("analysis dependencies must be non-empty allowlisted datasets")
        if any(len(values) != len(set(values)) for values in dependencies.values()):
            raise ValueError("analysis dependencies must not contain duplicates")
        self._analysis_dependencies = MappingProxyType(
            {key: tuple(values) for key, values in dependencies.items()}
        )

    def _now(self) -> datetime:
        """Executa a etapa interna ``now`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``datetime`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        value = self._clock()
        if (
            not isinstance(value, datetime)
            or value.tzinfo is None
            or value.utcoffset() != timedelta(0)
        ):
            raise ValueError("clock must return an aware UTC datetime")
        return value.astimezone(UTC)

    def _transition(
        self,
        state: RunState,
        target: RunStage,
        ingestion: _IngestionState,
        timer: _StageTimer,
        *,
        error: str | None = None,
        mark_candidate_active: bool = False,
        substage: str | None = None,
        units_completed: int | None = None,
        units_total: int | None = None,
        unit_label: str | None = None,
    ) -> RunState:
        """Executa a etapa interna ``transition`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            state: Estado imutável que será validado ou persistido.
            target: Estado ou destino solicitado para a operação.
            ingestion: Entrada ``ingestion``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            timer: Entrada ``timer``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            error: Entrada ``error``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            mark_candidate_active: Entrada ``mark_candidate_active``; a forma aceita é definida
            pela anotação de tipo e validada antes do uso.

        Returns:
            Valor ``RunState`` produzido pela operação após as validações.
        """
        sanitized = PersistedError.from_untrusted(error).message if error is not None else None
        metadata = timer.prepare(
            state.stage,
            target,
            ingestion,
            sanitized,
            substage=substage,
            units_completed=units_completed,
            units_total=units_total,
            unit_label=unit_label,
        )
        try:
            transitioned = self._runs.transition(
                state.run_id,
                target,
                expected_stage=state.stage,
                metadata=metadata,
                mark_candidate_active=mark_candidate_active,
                idempotency_key=f"run-transition:{state.run_id}:{state.stage}:{target}",
            )
        except Exception:
            durable = self._runs.get_run(state.run_id)
            if durable is None or durable.stage is not target:
                raise
            expected_active = (
                state.dataset_version if mark_candidate_active else state.active_dataset_version
            )
            if durable.active_dataset_version != expected_active:
                raise
            transitioned = durable
        timer.commit(state.stage, target)
        if self._activity is not None:
            self._activity.begin(
                target,
                metadata.transitioned_at,
                ingestion,
                substage=substage,
                units_completed=units_completed,
                units_total=units_total,
                unit_label=unit_label,
            )
        return transitioned

    def _validate_source(
        self, reader: SourceReader, ingestion: _IngestionState
    ) -> tuple[dict[str, SchemaObservation], dict[str, CoverageObservation]]:
        """Valida fonte contra as invariantes deste módulo.

        Args:
            reader: Entrada ``reader``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``tuple[dict[str, SchemaObservation], dict[str, CoverageObservation]]``
            produzido pela operação após as validações.

        Raises:
            BackfillValidationError: Se a operação não puder preservar as invariantes descritas.
        """
        schemas: dict[str, SchemaObservation] = {}
        coverage: dict[str, CoverageObservation] = {}
        for index, descriptor in enumerate(self._registry):
            if self._activity is not None:
                self._activity.advance(
                    self._now(),
                    ingestion,
                    current_dataset=descriptor.table,
                    datasets_completed=index,
                    records_total=None,
                )
            schema = reader.validate_schema(descriptor)
            if not schema.is_compatible:
                raise SourceSchemaInvalid(f"physical schema for {descriptor.table} is incompatible")
            observed = reader.measure_coverage(descriptor)
            if "backfill" in descriptor.required_modes and (
                observed.status is CoverageStatus.UNAVAILABLE or observed.row_count == 0
            ):
                raise SourceSchemaInvalid(
                    f"required backfill coverage for {descriptor.table} is unavailable"
                )
            schemas[descriptor.table] = schema
            coverage[descriptor.table] = observed
        if self._activity is not None:
            self._activity.advance(
                self._now(),
                ingestion,
                current_dataset=None,
                datasets_completed=len(coverage),
                records_total=sum(item.row_count for item in coverage.values()),
            )
        return schemas, coverage

    @staticmethod
    def _normalize_record(
        descriptor: DatasetDescriptor,
        row: Mapping[str, object],
        context: NormalizationContext,
        snapshot_date: date,
    ) -> CanonicalRecord:
        """Normaliza registro para o modelo canônico da ingestão.

        Args:
            descriptor: Descritor físico e semântico do dataset processado.
            row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            context: Contexto validado compartilhado durante o processamento.
            snapshot_date: Data civil usada para particionamento ou proveniência.

        Returns:
            Valor ``CanonicalRecord`` produzido pela operação após as validações.

        Raises:
            BackfillValidationError: Se a operação não puder preservar as invariantes descritas.
        """
        record = normalize_row(descriptor, row, context)
        if record.observed_at is not None:
            return record
        if descriptor.archive_partition["strategy"] != "snapshot_date":
            raise BackfillValidationError(
                "event-time records must expose their contracted observation timestamp"
            )
        return replace(
            record,
            observed_at=datetime.combine(snapshot_date, time.min, tzinfo=UTC),
        )

    @staticmethod
    def _group_records(
        records: tuple[CanonicalRecord, ...],
        descriptor: DatasetDescriptor,
        snapshot_date: date,
    ) -> dict[str, tuple[CanonicalRecord, ...]]:
        """Agrupa registros por sua identidade canônica.

        Args:
            records: Registros canônicos consumidos pela operação.
            descriptor: Descritor físico e semântico do dataset processado.
            snapshot_date: Data civil usada para particionamento ou proveniência.

        Returns:
            Valor ``dict[str, tuple[CanonicalRecord, ...]]`` produzido pela operação após as
            validações.
        """
        grouped: dict[str, list[CanonicalRecord]] = {}
        for record in records:
            partition = archive_partition_key(record, descriptor, snapshot_date=snapshot_date)
            grouped.setdefault(partition, []).append(record)
        return {key: tuple(values) for key, values in grouped.items()}

    def _restore_persisted(
        self,
        candidate: str,
        descriptor: DatasetDescriptor,
        coverage: CoverageObservation,
        spool: _RecordSpool,
        snapshot_date: date,
        stored_candidate: CandidateManifest | None,
    ) -> None:
        """Restaura persisted e confirma sua identidade antes de concluir.

        Args:
            candidate: Manifesto candidato que poderá se tornar ativo.
            descriptor: Descritor físico e semântico do dataset processado.
            coverage: Entrada ``coverage``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            spool: Entrada ``spool``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            snapshot_date: Data civil usada para particionamento ou proveniência.
            stored_candidate: Entrada ``stored_candidate``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            BackfillValidationError: Se a operação não puder preservar as invariantes descritas.
        """
        days: list[date] = []
        if descriptor.archive_partition["strategy"] == "snapshot_date":
            days.append(snapshot_date)
        elif coverage.observed_window is not None:
            current = coverage.observed_window.start.date()
            final = (coverage.observed_window.end - timedelta(microseconds=1)).date()
            while current <= final:
                days.append(current)
                current += timedelta(days=1)
        else:
            metadata = stored_candidate.metadata if stored_candidate is not None else {}
            all_intervals = metadata.get("availableIntervals")
            raw_intervals = (
                all_intervals.get(descriptor.table) if isinstance(all_intervals, Mapping) else None
            )
            if not isinstance(raw_intervals, tuple | list) or not raw_intervals:
                raise BackfillValidationError(
                    "resumed event-time ingestion requires a durable coverage boundary"
                )
            for raw in raw_intervals:
                if not isinstance(raw, Mapping):
                    raise BackfillValidationError("candidate coverage intervals are invalid")
                try:
                    start = datetime.fromisoformat(str(raw["start"]).replace("Z", "+00:00"))
                    end = datetime.fromisoformat(str(raw["end"]).replace("Z", "+00:00"))
                except (KeyError, ValueError) as error:
                    raise BackfillValidationError(
                        "candidate coverage intervals are invalid"
                    ) from error
                current = start.date()
                final = (end - timedelta(microseconds=1)).date()
                while current <= final:
                    if current not in days:
                        days.append(current)
                    current += timedelta(days=1)
        family = _HOT_FAMILY[descriptor.record_type]
        for day in days:
            hot_partition = f"DATASET#{candidate}#{family}#{descriptor.table}#{day:%Y%m%d}"
            for records in self._projections.repository.iter_input_batches(
                candidate, (hot_partition,)
            ):
                if any(record.source_dataset != descriptor.table for record in records):
                    raise BackfillValidationError(
                        "persisted projection input differs from the requested dataset"
                    )
                for partition, values in self._group_records(
                    records, descriptor, snapshot_date
                ).items():
                    if partition_date(partition) != day:
                        raise BackfillValidationError(
                            "persisted projection input differs from the requested day"
                        )
                    spool.append(descriptor.table, partition, values)

    def _ingest(
        self,
        reader: SourceReader,
        context: NormalizationContext,
        request: BackfillRequest,
        candidate: str,
        snapshot_date: date,
        replay: bool,
        ingestion: _IngestionState,
        coverage: Mapping[str, CoverageObservation],
        stored_candidate: CandidateManifest | None,
    ) -> _IngestionState:
        """Ingere a entrada preservando paginação, reconciliação e idempotência.

        Args:
            reader: Entrada ``reader``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            context: Contexto validado compartilhado durante o processamento.
            request: Objeto de entrada já estruturado para o caso de uso.
            candidate: Manifesto candidato que poderá se tornar ativo.
            snapshot_date: Data civil usada para particionamento ou proveniência.
            replay: Entrada ``replay``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            ingestion: Entrada ``ingestion``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            coverage: Entrada ``coverage``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            stored_candidate: Entrada ``stored_candidate``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.

        Returns:
            Valor ``_IngestionState`` produzido pela operação após as validações.

        Raises:
            BackfillValidationError: Se a operação não puder preservar as invariantes descritas.
        """
        materialized = ingestion.records
        records_total = sum(item.row_count for item in coverage.values())
        for dataset_index, descriptor in enumerate(self._registry):
            if self._activity is not None:
                self._activity.advance(
                    self._now(),
                    ingestion,
                    current_dataset=descriptor.table,
                    datasets_completed=dataset_index,
                    records_total=records_total,
                )
            checkpoint = self._checkpoints.get(candidate, descriptor.table)
            resuming = checkpoint is not None and not replay
            after = None if replay else checkpoint
            page_number = 0
            read = accepted = rejected = written = unchanged = 0
            while True:
                page = reader.read_page(descriptor, None, after, request.page_size)
                if not page.rows:
                    break
                read += len(page.rows)
                ingestion.current_read = read
                try:
                    records = tuple(
                        self._normalize_record(descriptor, row, context, snapshot_date)
                        for row in page.rows
                    )
                except Exception:
                    rejected += len(page.rows)
                    ingestion.current_rejected = rejected
                    raise
                accepted += len(records)
                ingestion.current_accepted = accepted
                grouped = self._group_records(records, descriptor, snapshot_date)
                materialized.reserve_records(descriptor.table, grouped)
                for partition, partition_records in sorted(grouped.items()):
                    outcome = self._hot_sink.write(
                        partition_records,
                        candidate,
                        partition,
                        idempotency_key=(
                            f"hot:{request.run_id}:{descriptor.table}:{page_number}:{partition}"
                        ),
                    )
                    if outcome.written + outcome.unchanged != len(partition_records):
                        raise BackfillValidationError(
                            "hot write reconciliation does not account for every accepted record"
                        )
                    written += outcome.written
                    unchanged += outcome.unchanged
                    ingestion.current_written = written
                    ingestion.current_unchanged = unchanged
                    materialized.append(
                        descriptor.table,
                        partition,
                        partition_records,
                    )
                if page.next_cursor is None or page.next_cursor == after:
                    raise BackfillValidationError("source page cursor did not advance")
                if not replay:
                    checkpoint = self._checkpoints.advance(
                        candidate,
                        descriptor.table,
                        page.next_cursor,
                        expected_cursor=checkpoint,
                        idempotency_key=(
                            f"checkpoint:{candidate}:{descriptor.table}:{page_number}:"
                            f"{sha256_id('cur_', page.next_cursor)}"
                        ),
                    )
                after = page.next_cursor
                page_number += 1
                if self._activity is not None:
                    self._activity.advance(
                        self._now(),
                        ingestion,
                        current_dataset=descriptor.table,
                        datasets_completed=dataset_index,
                        records_total=records_total,
                    )
            ingestion.complete_dataset(
                DatasetRunResult(
                    descriptor.table,
                    read,
                    accepted,
                    rejected,
                    written,
                    unchanged,
                )
            )
            if resuming:
                materialized.clear_dataset(descriptor.table)
                self._restore_persisted(
                    candidate,
                    descriptor,
                    coverage[descriptor.table],
                    materialized,
                    snapshot_date,
                    stored_candidate,
                )
            if self._activity is not None:
                self._activity.advance(
                    self._now(),
                    ingestion,
                    current_dataset=None,
                    datasets_completed=dataset_index + 1,
                    records_total=records_total,
                )
        return ingestion

    def _extract_to_spool(
        self,
        reader: SourceReader,
        context: NormalizationContext,
        request: BackfillRequest,
        candidate: str,
        snapshot_date: date,
        ingestion: _IngestionState,
        coverage: Mapping[str, CoverageObservation],
    ) -> _IngestionState:
        """Extract canonical-v2 from the source without any durable sink or cursor advance."""

        del candidate
        materialized = ingestion.records
        records_total = sum(item.row_count for item in coverage.values())
        for dataset_index, descriptor in enumerate(self._registry):
            if self._activity is not None:
                self._activity.advance(
                    self._now(),
                    ingestion,
                    current_dataset=descriptor.table,
                    datasets_completed=dataset_index,
                    records_total=records_total,
                )
            after = None
            read = accepted = rejected = 0
            while True:
                page = reader.read_page(descriptor, None, after, request.page_size)
                if not page.rows:
                    break
                read += len(page.rows)
                ingestion.current_read = read
                try:
                    records = tuple(
                        self._normalize_record(descriptor, row, context, snapshot_date)
                        for row in page.rows
                    )
                except Exception:
                    rejected += len(page.rows)
                    ingestion.current_rejected = rejected
                    raise
                accepted += len(records)
                ingestion.current_accepted = accepted
                grouped = self._group_records(records, descriptor, snapshot_date)
                materialized.reserve_records(descriptor.table, grouped)
                for partition, partition_records in sorted(grouped.items()):
                    materialized.append(descriptor.table, partition, partition_records)
                if page.next_cursor is None or page.next_cursor == after:
                    raise BackfillValidationError("source page cursor did not advance")
                after = page.next_cursor
                if self._activity is not None:
                    self._activity.advance(
                        self._now(),
                        ingestion,
                        current_dataset=descriptor.table,
                        datasets_completed=dataset_index,
                        records_total=records_total,
                    )
            ingestion.complete_dataset(
                DatasetRunResult(
                    descriptor.table,
                    read,
                    accepted,
                    rejected,
                    0,
                    accepted,
                )
            )
            if self._activity is not None:
                self._activity.advance(
                    self._now(),
                    ingestion,
                    current_dataset=None,
                    datasets_completed=dataset_index + 1,
                    records_total=records_total,
                )
        return ingestion

    def _project_canonical(
        self,
        workspace_root: Path,
        canonical_set: CanonicalSet,
        ingestion: _IngestionState,
    ) -> ProjectionBuildResult:
        """Drop extracted records and build projections only from committed archive objects."""
        if self._canonical_source_factory is None:
            raise BackfillValidationError(
                "canonical record source is required for canonical-v2 projections"
            )
        ingestion.records.release_records()
        source = self._canonical_source_factory(workspace_root)

        def batches() -> Iterator[ArchiveRecords]:
            for batch in source.iter_batches(canonical_set):
                for (dataset, partition), records in batch.items():
                    ingestion.records.observe(dataset, partition, records)
                yield batch

        return self._projections.materialize_record_batches(
            canonical_set.dataset_version,
            batches(),
            retain_projections=False,
        )

    @staticmethod
    def _canonical_manifest_inputs(
        canonical_set: CanonicalSet,
    ) -> tuple[dict[str, SchemaObservation], dict[str, CoverageObservation]]:
        schemas = {
            dataset.dataset: SchemaObservation(dataset.schema_fingerprint, True)
            for dataset in canonical_set.datasets
        }
        try:
            coverage = {
                dataset.dataset: CoverageObservation(
                    CoverageStatus(dataset.coverage.lower()),
                    dataset.source_row_count,
                    None,
                )
                for dataset in canonical_set.datasets
            }
        except ValueError as error:
            raise DataReconciliationError(
                "canonical marker contains unsupported coverage evidence"
            ) from error
        return schemas, coverage

    @staticmethod
    def _canonical_object_batches(
        records: Iterable[CanonicalRecord],
    ) -> Iterator[tuple[CanonicalRecord, ...]]:
        """Split by estimated serialized bytes, never by a fixed number of rows."""

        batch: list[CanonicalRecord] = []
        estimated_bytes = 0
        for record in records:
            record_bytes = len(canonical_bytes(_spool_value(record))) * 2 + 4_096
            if batch and estimated_bytes + record_bytes > _CANONICAL_OBJECT_ESTIMATED_BYTES:
                yield tuple(batch)
                batch = []
                estimated_bytes = 0
            batch.append(record)
            estimated_bytes += record_bytes
        if batch:
            yield tuple(batch)

    def _encode_canonical_objects(
        self,
        request: BackfillRequest,
        candidate: str,
        ingestion: _IngestionState,
        descriptor: DatasetDescriptor,
        partition: str,
        *,
        stage: bool,
    ) -> tuple[tuple[CanonicalObjectEvidence, ...], tuple[ArchiveObject, ...]]:
        """Encode one logical partition, optionally staging each bounded object."""

        identity = (descriptor.table, partition)
        logical_objects: list[CanonicalObjectEvidence] = []
        staged_objects: list[ArchiveObject] = []
        safe_partition = partition.replace("/", "_").replace("=", "-")
        source_batches = iter(
            self._canonical_object_batches(ingestion.records.iter_records(identity))
        )
        pending_splits: list[tuple[CanonicalRecord, ...]] = []
        ordinal = 0
        encode_attempt = 0
        while True:
            if pending_splits:
                records = pending_splits.pop()
            else:
                try:
                    records = next(source_batches)
                except StopIteration:
                    break
            attempt = encode_attempt
            encode_attempt += 1
            path = ingestion.records.archive_path(
                candidate,
                descriptor.table,
                f"{safe_partition}-encode-{attempt:05d}",
            )
            encoded = self._archive_encoder.encode(
                records,
                descriptor,
                path,
                dataset_version=candidate,
                idempotency_key=(
                    f"encode-v2:{request.run_id}:{candidate}:{descriptor.table}:"
                    f"{partition}:{attempt:05d}"
                ),
                disk_budget=ingestion.records.disk_budget,
            )
            expected_schema_fingerprint = self._archive_publisher.schema_fingerprint(descriptor)
            if (
                encoded.dataset != descriptor.table
                or encoded.dataset_version != candidate
                or encoded.schema_version != "1.0"
                or encoded.schema_fingerprint != expected_schema_fingerprint
            ):
                encoded.path.unlink(missing_ok=True)
                raise DataReconciliationError(
                    "Parquet identity differs from canonical dataset evidence"
                )
            if encoded.row_count != len(records):
                encoded.path.unlink(missing_ok=True)
                raise DataReconciliationError(
                    "Parquet row count differs from normalized canonical records"
                )
            if encoded.byte_size > MAX_CANONICAL_OBJECT_BYTES:
                encoded.path.unlink(missing_ok=True)
                if len(records) == 1:
                    raise DataReconciliationError(
                        "one canonical record exceeds the 512 MiB object limit"
                    )
                midpoint = len(records) // 2
                pending_splits.append(records[midpoint:])
                pending_splits.append(records[:midpoint])
                continue
            if stage:
                staging_key = canonical_staging_archive_key(
                    candidate,
                    descriptor.table,
                    partition,
                    encoded.sha256,
                    ordinal=ordinal,
                )
                try:
                    staged = self._archive_publisher.object_store.stage(
                        encoded,
                        staging_key,
                        expected_absent=True,
                        idempotency_key=(
                            f"stage-v2:{candidate}:{descriptor.table}:{partition}:"
                            f"{ordinal:05d}:{encoded.sha256}"
                        ),
                    )
                except ConditionalWriteError as error:
                    raise DataReconciliationError(
                        "staged canonical object conflicts with immutable evidence"
                    ) from error
                confirmed = self._archive_publisher.object_store.head(staging_key)
                if confirmed != staged:
                    raise DataReconciliationError(
                        "staged canonical object HEAD differs from encoded evidence"
                    )
                staged_objects.append(staged)
            encoded.path.unlink(missing_ok=True)
            logical_objects.append(
                CanonicalObjectEvidence(
                    "",
                    encoded.row_count,
                    encoded.byte_size,
                    encoded.sha256,
                )
            )
            ordinal += 1
        row_count = ingestion.records.partition_count(identity)
        if sum(item.row_count for item in logical_objects) != row_count:
            raise DataReconciliationError(
                "canonical object row counts differ from normalized partition"
            )
        return tuple(logical_objects), tuple(staged_objects)

    def _archive_canonical(
        self,
        request: BackfillRequest,
        candidate: str,
        snapshot_date: date,
        ingestion: _IngestionState,
        coverage: Mapping[str, CoverageObservation],
    ) -> ArchiveBuildResult:
        """Stage all objects, derive the generation, publish every partition, then commit."""

        if self._canonical_sets is None:
            raise BackfillValidationError("canonical set store is required for canonical-v2")
        descriptors = {item.table: item for item in self._registry}
        logical_partitions: dict[str, list[CanonicalPartitionEvidence]] = {
            name: [] for name in self._registry.names()
        }
        staged_partitions: dict[tuple[str, str], tuple[ArchiveObject, ...]] = {}
        current_partitions = {
            (dataset_name, partition): self._archive_publisher.preflight_existing_canonical(
                candidate, dataset_name, partition
            )
            for dataset_name, partition in ingestion.records.keys()
        }
        for dataset_name, partition in ingestion.records.keys():
            identity = (dataset_name, partition)
            descriptor = descriptors[dataset_name]
            current_partition = current_partitions[identity]
            logical_objects, staged_objects = self._encode_canonical_objects(
                request,
                candidate,
                ingestion,
                descriptor,
                partition,
                stage=(
                    current_partition is None
                    or current_partition.state is not ArchiveState.AVAILABLE
                ),
            )
            staged_partitions[identity] = staged_objects
            row_count = ingestion.records.partition_count(identity)
            logical_partitions[dataset_name].append(
                CanonicalPartitionEvidence(dataset_name, partition, row_count, logical_objects)
            )

        logical_datasets = tuple(
            CanonicalDatasetEvidence(
                descriptor.table,
                ingestion.results[descriptor.table].records_read,
                ingestion.results[descriptor.table].records_accepted,
                ingestion.results[descriptor.table].records_rejected,
                self._archive_publisher.schema_fingerprint(descriptor),
                coverage[descriptor.table].status.value.upper(),
                tuple(logical_partitions[descriptor.table]),
            )
            for descriptor in self._registry
        )
        total_source = sum(item.source_row_count for item in logical_datasets)
        total_accepted = sum(item.accepted_row_count for item in logical_datasets)
        total_rejected = sum(item.rejected_row_count for item in logical_datasets)
        contract_version = str(self._registry.snapshot["physicalContractVersion"])
        aggregate_digest = canonical_set_aggregate_digest(
            schema_version="1.0",
            dataset_version=candidate,
            source_sha256=request.restore_request.expected_sha256,
            contract_version=contract_version,
            snapshot_extracted_on=snapshot_date,
            datasets=logical_datasets,
            total_source_rows=total_source,
            total_accepted_rows=total_accepted,
            total_rejected_rows=total_rejected,
        )
        finalized_datasets = tuple(
            replace(
                dataset,
                partitions=tuple(
                    replace(
                        partition,
                        objects=tuple(
                            replace(
                                item,
                                object_key=canonical_archive_key(
                                    candidate,
                                    partition.dataset,
                                    partition.partition,
                                    item.sha256,
                                    aggregate_digest=aggregate_digest,
                                    ordinal=ordinal,
                                ),
                            )
                            for ordinal, item in enumerate(partition.objects)
                        ),
                    )
                    for partition in dataset.partitions
                ),
            )
            for dataset in logical_datasets
        )
        canonical_set = CanonicalSet(
            "1.0",
            candidate,
            request.restore_request.expected_sha256,
            contract_version,
            snapshot_date,
            aggregate_digest,
            finalized_datasets,
            total_source,
            total_accepted,
            total_rejected,
        )

        new_objects = written_records = unchanged_records = 0
        dataset_written = {name: 0 for name in self._registry.names()}
        dataset_unchanged = {name: 0 for name in self._registry.names()}
        archives: dict[tuple[str, str], ArchivePartition] = {}
        existing_partitions: dict[tuple[str, str], ArchivePartition | None] = {}
        for dataset_evidence in canonical_set.datasets:
            descriptor = descriptors[dataset_evidence.dataset]
            for partition_evidence in dataset_evidence.partitions:
                identity = (dataset_evidence.dataset, partition_evidence.partition)
                day = partition_date(partition_evidence.partition)
                start = datetime.combine(day, time.min, tzinfo=UTC)
                counts = {
                    "accepted": partition_evidence.row_count,
                    "rejected": 0,
                    "persisted": partition_evidence.row_count,
                }
                archive = ArchivePartition(
                    candidate,
                    dataset_evidence.dataset,
                    partition_evidence.partition,
                    ArchiveState.STAGING,
                    {
                        "interval": {
                            "start": _utc_text(start),
                            "end": _utc_text(start + timedelta(days=1)),
                        },
                        "counts": counts,
                        "objects": tuple(
                            {
                                "objectKey": item.object_key,
                                "rowCount": item.row_count,
                                "byteCount": item.byte_count,
                                "sha256": item.sha256,
                            }
                            for item in partition_evidence.objects
                        ),
                        "aggregateDigest": aggregate_digest,
                        "reconciliation": {"state": "PENDING"},
                        "expirationEligible": False,
                        "hotItemCount": 0,
                        "catalogGeneration": 1,
                        "catalogDigest": None,
                    },
                )
                archives[identity] = archive
                existing = self._archive_publisher.preflight_canonical(descriptor, archive)
                existing_partitions[identity] = existing
                if existing is None or existing.state is not ArchiveState.AVAILABLE:
                    new_objects += sum(
                        self._archive_publisher.object_store.head(item.object_key) is None
                        for item in partition_evidence.objects
                    )

        for dataset_evidence in canonical_set.datasets:
            descriptor = descriptors[dataset_evidence.dataset]
            for partition_evidence in dataset_evidence.partitions:
                identity = (dataset_evidence.dataset, partition_evidence.partition)
                existing = existing_partitions[identity]
                was_available = existing is not None and existing.state is ArchiveState.AVAILABLE
                staged_objects = staged_partitions[identity]
                if was_available and staged_objects:
                    raise DataReconciliationError(
                        "available canonical partition must not be staged again"
                    )
                try:
                    self._archive_publisher.publish_canonical(
                        staged_objects,
                        descriptor,
                        archives[identity],
                        idempotency_key=(
                            f"archive-v2:{candidate}:{dataset_evidence.dataset}:"
                            f"{partition_evidence.partition}"
                        ),
                    )
                except ConditionalWriteError as error:
                    raise DataReconciliationError(
                        "canonical partition conflicts with immutable publication evidence"
                    ) from error
                if was_available:
                    unchanged_records += partition_evidence.row_count
                    dataset_unchanged[dataset_evidence.dataset] += partition_evidence.row_count
                else:
                    written_records += partition_evidence.row_count
                    dataset_written[dataset_evidence.dataset] += partition_evidence.row_count

        try:
            committed = self._canonical_sets.commit(
                canonical_set,
                idempotency_key=f"canonical-set:{candidate}:{aggregate_digest}",
            )
        except ConditionalWriteError as error:
            raise DataReconciliationError(
                "canonical marker conflicts with immutable publication evidence"
            ) from error
        if committed != canonical_set:
            raise DataReconciliationError("canonical set commit differs from publication evidence")
        for dataset_name, current in tuple(ingestion.results.items()):
            ingestion.results[dataset_name] = replace(
                current,
                records_written=dataset_written[dataset_name],
                records_unchanged=dataset_unchanged[dataset_name],
            )
        return ArchiveBuildResult(
            canonical_set,
            new_objects,
            written_records,
            unchanged_records,
        )

    def _reconcile_canonical_set(
        self,
        value: CanonicalSet,
        request: BackfillRequest,
    ) -> None:
        """Prove marker, partition state, and every final object without listing storage."""

        if (
            value.source_sha256 != request.restore_request.expected_sha256
            or value.snapshot_extracted_on != request.snapshot_extracted_on
            or value.contract_version != str(self._registry.snapshot["physicalContractVersion"])
        ):
            raise DataReconciliationError("canonical marker differs from requested source")
        for dataset in value.datasets:
            persisted = self._archive_publisher.partitions.query(
                value.dataset_version, dataset.dataset
            )
            expected_identities = tuple(item.partition for item in dataset.partitions)
            if tuple(item.partition for item in persisted) != expected_identities:
                raise DataReconciliationError(
                    "archive partitions differ from canonical marker coverage"
                )
            for archive, evidence in zip(persisted, dataset.partitions, strict=True):
                validate_archive_partition(archive)
                raw_objects = archive.metadata.get("objects")
                if archive.state is not ArchiveState.AVAILABLE or not isinstance(
                    raw_objects, tuple
                ):
                    raise DataReconciliationError(
                        "canonical marker requires AVAILABLE archive partitions"
                    )
                expected_objects = tuple(
                    {
                        "objectKey": item.object_key,
                        "rowCount": item.row_count,
                        "byteCount": item.byte_count,
                        "sha256": item.sha256,
                    }
                    for item in evidence.objects
                )
                if (
                    archive.metadata.get("aggregateDigest") != value.aggregate_digest
                    or archive.metadata.get("catalogDigest") != value.aggregate_digest
                    or archive.metadata.get("counts")
                    != {
                        "accepted": evidence.row_count,
                        "rejected": 0,
                        "persisted": evidence.row_count,
                    }
                    or tuple(dict(cast(Mapping[str, object], item)) for item in raw_objects)
                    != expected_objects
                ):
                    raise DataReconciliationError(
                        "archive partition evidence differs from canonical marker"
                    )
                for item in evidence.objects:
                    observed = self._archive_publisher.object_store.head(item.object_key)
                    if observed is None or (observed.sha256, observed.size) != (
                        item.sha256,
                        item.byte_count,
                    ):
                        raise DataReconciliationError(
                            "canonical object HEAD differs from marker evidence"
                        )

    @staticmethod
    def _load_canonical_counts(value: CanonicalSet, ingestion: _IngestionState) -> None:
        for dataset in value.datasets:
            ingestion.complete_dataset(
                DatasetRunResult(
                    dataset.dataset,
                    dataset.source_row_count,
                    dataset.accepted_row_count,
                    dataset.rejected_row_count,
                    0,
                    dataset.accepted_row_count,
                )
            )

    def _archive(
        self,
        request: BackfillRequest,
        candidate: str,
        snapshot_date: date,
        ingestion: _IngestionState,
        projection_result: ProjectionBuildResult,
    ) -> tuple[int, dict[str, int]]:
        """Executa a etapa interna ``archive`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            request: Objeto de entrada já estruturado para o caso de uso.
            candidate: Manifesto candidato que poderá se tornar ativo.
            snapshot_date: Data civil usada para particionamento ou proveniência.
            ingestion: Entrada ``ingestion``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            projection_result: Entrada ``projection_result``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.

        Returns:
            Valor ``tuple[int, dict[str, int]]`` produzido pela operação após as validações.
        """
        new_objects = 0
        partition_counts: dict[str, int] = {name: 0 for name in self._registry.names()}
        descriptor_by_name = {item.table: item for item in self._registry}
        for dataset, partition in ingestion.records.keys():
            key = (dataset, partition)
            descriptor = descriptor_by_name[dataset]
            safe_partition = partition.replace("/", "_").replace("=", "-")
            path = ingestion.records.archive_path(candidate, dataset, safe_partition)
            encoded = self._archive_encoder.encode(
                ingestion.records.iter_records(key),
                descriptor,
                path,
                dataset_version=candidate,
                idempotency_key=f"encode:{candidate}:{dataset}:{partition}",
                disk_budget=ingestion.records.disk_budget,
            )
            canonical_key = legacy_canonical_archive_key(
                candidate, dataset, partition, encoded.sha256
            )
            if self._archive_publisher.object_store.head(canonical_key) is None:
                new_objects += 1
            day = partition_date(partition)
            start = datetime.combine(day, time.min, tzinfo=UTC)
            end = start + timedelta(days=1)
            persisted = ingestion.records.partition_count(key)
            counts = {"accepted": persisted, "rejected": 0, "persisted": persisted}
            archive = ArchivePartition(
                candidate,
                dataset,
                partition,
                ArchiveState.STAGING,
                {
                    "interval": {"start": _utc_text(start), "end": _utc_text(end)},
                    "counts": counts,
                    "s3Uri": f"s3://{self._archive_publisher.bucket}/{canonical_key}",
                    "sha256": encoded.sha256,
                    "reconciliation": {"state": "PENDING"},
                    "expirationEligible": False,
                    "hotItemCount": persisted,
                    "projectionItemCount": projection_result.catalog_item_counts.get(
                        (dataset, partition), 0
                    ),
                    "catalogGeneration": 1,
                    "catalogDigest": None,
                },
            )
            self._archive_publisher.publish(
                encoded,
                descriptor,
                archive,
                run_id=f"archive-{candidate}",
                idempotency_key=f"archive:{candidate}:{dataset}:{partition}",
            )
            partition_counts[dataset] += 1
        return new_objects, partition_counts

    def _manifest(
        self,
        candidate: str,
        schemas: Mapping[str, SchemaObservation],
        coverage: Mapping[str, CoverageObservation],
        ingestion: _IngestionState,
        partition_counts: Mapping[str, int],
        projection_result: ProjectionBuildResult,
        snapshot_date: date,
        hot_reference: datetime,
        dump_sha256: str,
        pipeline: RunPipeline,
        canonical_set: CanonicalSet | None = None,
    ) -> CandidateManifest:
        """Executa a etapa interna ``manifest`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            candidate: Manifesto candidato que poderá se tornar ativo.
            schemas: Entrada ``schemas``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            coverage: Entrada ``coverage``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            ingestion: Entrada ``ingestion``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            partition_counts: Entrada ``partition_counts``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.
            projection_result: Entrada ``projection_result``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.
            snapshot_date: Data civil usada para particionamento ou proveniência.
            hot_reference: Entrada ``hot_reference``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            dump_sha256: Entrada ``dump_sha256``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.

        Returns:
            Valor ``CandidateManifest`` produzido pela operação após as validações.

        Raises:
            BackfillValidationError: Se a operação não puder preservar as invariantes descritas.
        """
        names = self._registry.names()
        intervals: dict[str, object] = {}
        hot_from: dict[str, object] = {}
        watermarks: dict[str, object] = {}
        coverage_values: dict[str, str] = {}
        flags: dict[str, tuple[str, ...]] = {}
        for name in names:
            descriptor = self._registry.require(name)
            available, watermark, quality_flags = ingestion.records.dataset_evidence(descriptor)
            observed_coverage = coverage[name].status.value.upper()
            intervals[name] = available
            coverage_values[name] = (
                "PARTIAL"
                if "SPARSE_INTERVALS_COMPACTED" in quality_flags
                else observed_coverage
            )
            flags[name] = quality_flags
            if available:
                hot_days = descriptor.retention["hotDays"]
                if not isinstance(hot_days, int):
                    raise BackfillValidationError("dataset hot retention must be explicit")
                retention_cutoff = hot_reference - timedelta(days=hot_days)
                intersecting = next(
                    (
                        (
                            datetime.fromisoformat(item["start"].replace("Z", "+00:00")),
                            datetime.fromisoformat(item["end"].replace("Z", "+00:00")),
                        )
                        for item in available
                        if datetime.fromisoformat(item["end"].replace("Z", "+00:00"))
                        > retention_cutoff
                    ),
                    None,
                )
                if intersecting is None:
                    hot_from[name] = available[-1]["end"]
                else:
                    hot_from[name] = _utc_text(max(intersecting[0], retention_cutoff))
                watermarks[name] = watermark
            else:
                hot_from[name] = None
                watermarks[name] = None
        validation_time = _utc_text(self._now())
        projection_names = tuple(sorted(projection_result.persisted_families))
        if set(projection_names) != _REQUIRED_PROJECTION_FAMILIES:
            missing = sorted(_REQUIRED_PROJECTION_FAMILIES - set(projection_names))
            raise BackfillValidationError(
                f"required projection families are missing: {', '.join(missing)}"
            )
        reconciliations = {
            name: {
                "accepted": ingestion.records.dataset_count(name),
                "rejected": 0,
                "persisted": ingestion.records.dataset_count(name),
            }
            for name in names
        }
        projection_counts: dict[str, dict[str, int]] = {name: {} for name in names}
        for (dataset, partition), count in projection_result.catalog_item_counts.items():
            try:
                dataset_counts = projection_counts[dataset]
            except KeyError as error:
                raise BackfillValidationError(
                    "projection catalog contains an unknown dataset"
                ) from error
            dataset_counts[partition] = count
        if any(len(projection_counts[name]) != partition_counts[name] for name in names):
            raise BackfillValidationError(
                "projection catalog cardinality differs from archived partitions"
            )
        parquet_datasets: dict[str, dict[str, object]] = {}
        for name in names:
            evidence: dict[str, object] = {
                "partitionCount": partition_counts[name],
                "catalogValidated": partition_counts[name] > 0,
            }
            if pipeline is RunPipeline.CANONICAL_V2:
                granular = [
                    {"partition": partition, "projectionItemCount": count}
                    for partition, count in sorted(projection_counts[name].items())
                ]
                evidence.update(
                    projectionItemCount=sum(projection_counts[name].values()),
                    projectionDigest=hashlib.sha256(canonical_bytes(granular)).hexdigest(),
                )
            else:
                evidence["partitions"] = {
                    partition: {"projectionItemCount": count}
                    for partition, count in sorted(projection_counts[name].items())
                }
            parquet_datasets[name] = evidence
        metadata: dict[str, object] = {
            "physicalContractVersion": str(self._registry.snapshot["physicalContractVersion"]),
            "canonicalSchemaVersion": str(self._registry.snapshot["canonicalSchemaVersion"]),
            "dumpChecksumSha256": dump_sha256,
            "snapshotExtractedOn": snapshot_date.isoformat(),
            "availableIntervals": intervals,
            "hotFrom": hot_from,
            "watermarks": watermarks,
            "s3Prefix": (
                f"s3://{self._archive_publisher.bucket}/canonical/schema_version=1.0/"
                f"dataset_version={candidate}/"
            ),
            "glueTables": {name: name for name in names},
            "descriptorVersions": {name: "2.0" for name in names},
            "formulaVersions": {name: "1.0" for name in projection_names},
            "projectionVersions": {name: "1.0" for name in projection_names},
            "coverage": coverage_values,
            "qualityFlags": flags,
            "validations": {
                "physicalSchemas": {
                    "state": "PASSED",
                    "validatedAt": validation_time,
                    "datasets": {
                        name: {
                            "fingerprint": schemas[name].fingerprint,
                            "compatible": schemas[name].is_compatible,
                        }
                        for name in names
                    },
                },
                "reconciliation": {
                    "state": "PASSED",
                    "validatedAt": validation_time,
                    "datasets": reconciliations,
                },
                "parquetCatalog": {
                    "state": "PASSED",
                    "validatedAt": validation_time,
                    "datasets": parquet_datasets,
                },
                "requiredProjections": {
                    "state": "PASSED",
                    "validatedAt": validation_time,
                    "projections": projection_names,
                },
                "coverageQuality": {
                    "state": "PASSED",
                    "validatedAt": validation_time,
                    "datasets": {
                        name: {
                            "coverage": coverage_values[name],
                            "qualityFlags": flags[name],
                        }
                        for name in names
                    },
                },
            },
        }
        if not materialize_hot_records_for(pipeline):
            metadata.update(hotMaterialization="SKIPPED", hotItemCount=0)
            if canonical_set is None:
                raise BackfillValidationError("canonical-v2 candidate requires a commit marker")
            if (
                canonical_set.dataset_version != candidate
                or canonical_set.source_sha256 != dump_sha256
                or tuple(item.dataset for item in canonical_set.datasets) != names
                or sum(len(item.partitions) for item in canonical_set.datasets)
                != sum(partition_counts.values())
            ):
                raise BackfillValidationError(
                    "canonical commit marker differs from candidate evidence"
                )
            marker_document = canonical_bytes(canonical_set_to_document(canonical_set))
            metadata["canonicalMarker"] = {
                "schemaVersion": canonical_set.schema_version,
                "objectKey": canonical_set_marker_key(candidate),
                "aggregateDigest": canonical_set.aggregate_digest,
                "documentSha256": hashlib.sha256(marker_document).hexdigest(),
                "datasetCount": len(canonical_set.datasets),
                "partitionCount": sum(len(item.partitions) for item in canonical_set.datasets),
                "objectCount": sum(
                    len(partition.objects)
                    for dataset in canonical_set.datasets
                    for partition in dataset.partitions
                ),
                "totalSourceRows": canonical_set.total_source_rows,
                "totalAcceptedRows": canonical_set.total_accepted_rows,
                "totalRejectedRows": canonical_set.total_rejected_rows,
            }
        elif canonical_set is not None:
            raise BackfillValidationError("legacy candidate cannot reference a canonical marker")
        return CandidateManifest(candidate, metadata)

    def _authorize_hot_expiration(self, candidate: str) -> None:
        """Autoriza quente expiração somente após validar as evidências exigidas.

        Args:
            candidate: Manifesto candidato que poderá se tornar ativo.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            BackfillValidationError: Se a operação não puder preservar as invariantes descritas.
        """
        for descriptor in self._registry:
            archives = self._archive_publisher.partitions.query(candidate, descriptor.table)
            for archive in archives:
                if archive.state is not ArchiveState.AVAILABLE:
                    raise BackfillValidationError(
                        "candidate archive must be AVAILABLE before TTL authorization"
                    )
                self._archive_publisher.authorize_expiration(
                    descriptor,
                    archive,
                    idempotency_key=(
                        f"archive-ttl:{candidate}:{archive.dataset}:{archive.partition}"
                    ),
                )

    def _analysis_events(
        self,
        candidate: str,
        coverage: Mapping[str, CoverageObservation],
        manifest: CandidateManifest,
        ingestion: _IngestionState,
    ) -> tuple[OutboxEvent, ...]:
        """Executa a etapa interna ``analysis_events`` e devolve o resultado validado indicado
        pela assinatura.

        Args:
            candidate: Manifesto candidato que poderá se tornar ativo.
            coverage: Entrada ``coverage``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            manifest: Entrada ``manifest``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            ingestion: Entrada ``ingestion``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``tuple[OutboxEvent, ...]`` produzido pela operação após as validações.
        """
        del manifest
        events: list[OutboxEvent] = []
        for event_type, grain in (("ANOMALY_DETECTION", 900), ("QOE_FORECAST", 3600)):
            dependencies = self._analysis_dependencies[event_type]
            if any(coverage[name].status is not CoverageStatus.COMPLETE for name in dependencies):
                continue
            window = ingestion.records.common_complete_window(dependencies, grain)
            if window is None:
                continue
            watermark = window.end
            # A execução comum prova que não há lacuna de dependência até esta marca d'água.
            # O evento consome apenas seu último bucket canônico, cuja duração precisa ser
            # exatamente igual à granularidade declarada.
            events.append(self._analysis_event(candidate, event_type, watermark, grain))
        return tuple(events)

    @staticmethod
    def _analysis_event(
        candidate: str,
        event_type: str,
        watermark: datetime,
        grain: int,
    ) -> OutboxEvent:
        """Executa a etapa interna ``analysis_event`` e devolve o resultado validado indicado
        pela assinatura.

        Args:
            candidate: Manifesto candidato que poderá se tornar ativo.
            event_type: Entrada ``event_type``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.
            watermark: Entrada ``watermark``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            grain: Entrada ``grain``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Valor ``OutboxEvent`` produzido pela operação após as validações.
        """
        start = watermark - timedelta(seconds=grain)
        identity = {
            "datasetVersion": candidate,
            "eventType": event_type,
            "windowEnd": watermark,
        }
        payload: dict[str, object] = {
            "window": {
                "start": canonical_utc_text(start, "window.start"),
                "end": canonical_utc_text(watermark, "window.end"),
                "grainSeconds": grain,
            },
            "scope": {"kind": "global", "dimensions": {}},
            "inputWatermark": canonical_utc_text(watermark, "watermark"),
        }
        if event_type == "QOE_FORECAST":
            payload.update(
                {
                    "model": {"name": "qoe-forecast", "version": "2026.09.1"},
                    "targetWindow": {
                        "start": canonical_utc_text(watermark, "target.start"),
                        "end": canonical_utc_text(watermark + timedelta(hours=1), "target.end"),
                    },
                }
            )
        return OutboxEvent(
            sha256_id("evt_", identity),
            candidate,
            event_type,
            sha256_id("ana_", identity),
            watermark,
            payload,
        )

    @staticmethod
    def _manifest_intervals(value: object) -> tuple[tuple[datetime, datetime], ...]:
        """Executa a etapa interna ``manifest_intervals`` e devolve o resultado validado
        indicado pela assinatura.

        Args:
            value: Valor não confiável que será validado ou convertido.

        Returns:
            Valor ``tuple[tuple[datetime, datetime], ...]`` produzido pela operação após as
            validações.

        Raises:
            BackfillValidationError: Se a operação não puder preservar as invariantes descritas.
        """
        if not isinstance(value, list | tuple):
            raise BackfillValidationError("active manifest lacks complete interval evidence")
        intervals: list[tuple[datetime, datetime]] = []
        for item in value:
            if not isinstance(item, Mapping):
                raise BackfillValidationError("active manifest interval evidence is invalid")
            raw_start = item.get("start")
            raw_end = item.get("end")
            if not isinstance(raw_start, str) or not isinstance(raw_end, str):
                raise BackfillValidationError("active manifest interval evidence is invalid")
            try:
                start = datetime.fromisoformat(raw_start.replace("Z", "+00:00"))
                end = datetime.fromisoformat(raw_end.replace("Z", "+00:00"))
            except ValueError:
                raise BackfillValidationError(
                    "active manifest interval evidence is invalid"
                ) from None
            if (
                start.tzinfo is None
                or end.tzinfo is None
                or start.utcoffset() != timedelta(0)
                or end.utcoffset() != timedelta(0)
                or start.microsecond % 1_000 != 0
                or end.microsecond % 1_000 != 0
                or end <= start
                or (intervals and start < intervals[-1][0])
            ):
                raise BackfillValidationError("active manifest interval evidence is invalid")
            if intervals and start <= intervals[-1][1]:
                previous_start, previous_end = intervals[-1]
                intervals[-1] = (previous_start, max(previous_end, end))
            else:
                intervals.append((start, end))
        if not intervals:
            raise BackfillValidationError("active manifest lacks complete interval evidence")
        return tuple(intervals)

    @classmethod
    def _manifest_complete_window(
        cls,
        manifest: CandidateManifest,
        datasets: tuple[str, ...],
        grain_seconds: int,
    ) -> TimeWindow | None:
        """Executa a etapa interna ``manifest_complete_window`` e devolve o resultado validado
        indicado pela assinatura.

        Args:
            manifest: Entrada ``manifest``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            datasets: Entrada ``datasets``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            grain_seconds: Duração ou prazo expresso em segundos.

        Returns:
            Valor ``TimeWindow | None`` produzido pela operação após as validações.

        Raises:
            BackfillValidationError: Se a operação não puder preservar as invariantes descritas.
        """
        coverage = manifest.metadata.get("coverage")
        available = manifest.metadata.get("availableIntervals")
        if not isinstance(coverage, Mapping) or not isinstance(available, Mapping):
            raise BackfillValidationError("active manifest lacks analysis evidence")
        intervals_by_dataset: dict[str, tuple[tuple[datetime, datetime], ...]] = {}
        for dataset in datasets:
            status = coverage.get(dataset)
            if not isinstance(status, str):
                raise BackfillValidationError("active manifest coverage evidence is invalid")
            if status != CoverageStatus.COMPLETE.value.upper():
                return None
            intervals = cls._manifest_intervals(available.get(dataset))
            intervals_by_dataset[dataset] = intervals
        start = max(intervals[0][0] for intervals in intervals_by_dataset.values())
        end = min(intervals[-1][1] for intervals in intervals_by_dataset.values())
        grain_ms = grain_seconds * 1_000
        start_ms = int(start.timestamp() * 1_000)
        end_ms = int(end.timestamp() * 1_000)
        if end <= start or start_ms % grain_ms != 0 or end_ms % grain_ms != 0:
            raise BackfillValidationError("active manifest interval evidence is not grain-aligned")
        for intervals in intervals_by_dataset.values():
            covered = start
            for interval_start, interval_end in intervals:
                if interval_end <= covered:
                    continue
                if interval_start > covered:
                    return None
                covered = max(covered, interval_end)
                if covered >= end:
                    break
            if covered < end:
                return None
        return TimeWindow(start, end, grain_seconds)

    def _analysis_events_from_active_manifest(
        self,
        candidate: str,
        manifest: CandidateManifest,
    ) -> tuple[OutboxEvent, ...]:
        """Executa a etapa interna ``analysis_events_from_active_manifest`` e devolve o
        resultado validado indicado pela assinatura.

        Args:
            candidate: Manifesto candidato que poderá se tornar ativo.
            manifest: Entrada ``manifest``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``tuple[OutboxEvent, ...]`` produzido pela operação após as validações.

        Raises:
            BackfillValidationError: Se a operação não puder preservar as invariantes descritas.
        """
        events: list[OutboxEvent] = []
        for event_type, grain in (("ANOMALY_DETECTION", 900), ("QOE_FORECAST", 3600)):
            dependencies = self._analysis_dependencies[event_type]
            if any(
                self._registry.require(dataset).grain_seconds != grain for dataset in dependencies
            ):
                raise BackfillValidationError(
                    "active manifest analysis dependencies have an incompatible grain"
                )
            window = self._manifest_complete_window(
                manifest,
                dependencies,
                grain,
            )
            if window is not None:
                events.append(self._analysis_event(candidate, event_type, window.end, grain))
        return tuple(events)

    def _drain_pending(self, limit: int, *, maximum_batches: int = 100) -> PublishResult:
        """Consome pendente até o fim sem manter todo o conteúdo em memória.

        Args:
            limit: Quantidade máxima de itens que a operação pode processar.
            maximum_batches: Entrada ``maximum_batches``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.

        Returns:
            Valor ``PublishResult`` produzido pela operação após as validações.
        """
        attempted = published = 0
        for _batch in range(maximum_batches):
            result = self._outbox_publisher.publish_pending(limit)
            attempted += result.attempted
            published += result.published
            if result.attempted < limit:
                return PublishResult(attempted, published)
        return PublishResult(attempted, published)

    def _publish_after_activation(
        self,
        request: BackfillRequest,
        candidate: str,
        state: RunState,
        ingestion: _IngestionState,
        timer: _StageTimer,
        heartbeat: _LeaseHeartbeat,
        *,
        candidate_is_active: bool,
        authorize_ttl: bool,
        events: tuple[OutboxEvent, ...],
        count_new_analysis_events: bool,
    ) -> tuple[RunState, int]:
        """Publica after activation preservando idempotência e validação de resposta.

        Args:
            request: Objeto de entrada já estruturado para o caso de uso.
            candidate: Manifesto candidato que poderá se tornar ativo.
            state: Estado imutável que será validado ou persistido.
            ingestion: Entrada ``ingestion``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            timer: Entrada ``timer``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            heartbeat: Entrada ``heartbeat``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            candidate_is_active: Entrada ``candidate_is_active``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.
            authorize_ttl: Entrada ``authorize_ttl``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            events: Entrada ``events``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            count_new_analysis_events: Entrada ``count_new_analysis_events``; a forma aceita é
            definida pela anotação de tipo e validada antes do uso.

        Returns:
            Valor ``tuple[RunState, int]`` produzido pela operação após as validações.
        """
        state = self._transition(
            state,
            RunStage.PUBLISHING,
            ingestion,
            timer,
            mark_candidate_active=candidate_is_active,
        )
        new_analysis_events = 0
        try:
            heartbeat.checkpoint()
            if authorize_ttl:
                self._authorize_hot_expiration(candidate)
                heartbeat.checkpoint()
            self._drain_pending(request.outbox_limit)
            heartbeat.checkpoint()
            if events:
                legacy_watermark = self._window_commits.get_watermark(
                    candidate, "analysis:ANOMALY_DETECTION+QOE_FORECAST"
                )
                for event in sorted(events, key=lambda item: item.event_type):
                    watermark = datetime.fromisoformat(
                        str(event.payload["inputWatermark"]).replace("Z", "+00:00")
                    )
                    analysis_source = _analysis_source(event.event_type)
                    committed_watermark = self._window_commits.get_watermark(
                        candidate, analysis_source
                    )
                    if committed_watermark is not None and watermark <= committed_watermark:
                        continue
                    if (
                        committed_watermark is None
                        and legacy_watermark == watermark
                        and self._window_commits.get_outbox_event(event.event_id) == event
                    ):
                        self._window_commits.commit_watermark_and_outboxes(
                            candidate,
                            analysis_source,
                            watermark,
                            (),
                            expected_watermark=None,
                            idempotency_key=(
                                f"adopt-legacy-analysis:{candidate}:{analysis_source}:"
                                f"{int(watermark.timestamp())}"
                            ),
                        )
                        continue
                    heartbeat.checkpoint()
                    self._window_commits.commit_watermark_and_outboxes(
                        candidate,
                        analysis_source,
                        watermark,
                        (event,),
                        expected_watermark=committed_watermark,
                        idempotency_key=(
                            f"analysis-window:{candidate}:{analysis_source}:"
                            f"{int(watermark.timestamp())}"
                        ),
                    )
                    if count_new_analysis_events:
                        new_analysis_events += 1
                    heartbeat.checkpoint()
            self._drain_pending(request.outbox_limit)
            heartbeat.checkpoint()
        except Exception as error:
            sanitized = PersistedError.from_untrusted(str(error) or type(error).__name__).message
            self._runs.append_error(
                request.run_id,
                1,
                sanitized,
                expected_stage=state.stage,
                idempotency_key=f"run-error:{request.run_id}:1",
            )
            return (
                self._transition(
                    state,
                    RunStage.PARTIAL,
                    ingestion,
                    timer,
                    error=sanitized,
                ),
                new_analysis_events,
            )

        heartbeat.fence()
        return (
            self._transition(state, RunStage.SUCCEEDED, ingestion, timer),
            new_analysis_events,
        )

    def _resume_active_candidate(
        self,
        request: BackfillRequest,
        candidate: str,
        active_manifest: CandidateManifest,
        state: RunState,
        ingestion: _IngestionState,
        timer: _StageTimer,
        heartbeat: _LeaseHeartbeat,
    ) -> tuple[RunState, int]:
        """Executa a etapa interna ``resume_active_candidate`` e devolve o resultado validado
        indicado pela assinatura.

        Args:
            request: Objeto de entrada já estruturado para o caso de uso.
            candidate: Manifesto candidato que poderá se tornar ativo.
            active_manifest: Entrada ``active_manifest``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.
            state: Estado imutável que será validado ou persistido.
            ingestion: Entrada ``ingestion``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            timer: Entrada ``timer``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            heartbeat: Entrada ``heartbeat``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``tuple[RunState, int]`` produzido pela operação após as validações.

        Raises:
            BackfillValidationError: Se a operação não puder preservar as invariantes descritas.
        """
        if active_manifest.dataset_version != candidate:
            raise BackfillValidationError("active manifest differs from the candidate")
        pre_publishing_stages = (
            RunStage.RESTORING,
            RunStage.VALIDATING,
            RunStage.INGESTING,
            RunStage.PROJECTING,
            RunStage.ARCHIVING,
            RunStage.ACTIVATING,
        )
        try:
            start = pre_publishing_stages.index(state.stage) + 1
        except ValueError:
            start = 0 if state.stage is RunStage.STARTING else len(pre_publishing_stages)
        for target in pre_publishing_stages[start:]:
            state = self._transition(state, target, ingestion, timer)
            heartbeat.checkpoint()
        try:
            events = self._analysis_events_from_active_manifest(candidate, active_manifest)
        except BackfillValidationError as error:
            sanitized = PersistedError.from_untrusted(str(error) or type(error).__name__).message
            state = self._transition(
                state,
                RunStage.PUBLISHING,
                ingestion,
                timer,
                mark_candidate_active=True,
            )
            self._runs.append_error(
                request.run_id,
                1,
                sanitized,
                expected_stage=state.stage,
                idempotency_key=f"run-error:{request.run_id}:1",
            )
            return (
                self._transition(
                    state,
                    RunStage.PARTIAL,
                    ingestion,
                    timer,
                    error=sanitized,
                ),
                0,
            )
        return self._publish_after_activation(
            request,
            candidate,
            state,
            ingestion,
            timer,
            heartbeat,
            candidate_is_active=True,
            authorize_ttl=request.activate,
            events=events,
            count_new_analysis_events=True,
        )

    def _result(
        self,
        request: BackfillRequest,
        candidate: str,
        state: RunState,
        ingestion: _IngestionState,
        new_archive_objects: int,
        new_analysis_events: int,
    ) -> RunResult:
        """Executa a etapa interna ``result`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            request: Objeto de entrada já estruturado para o caso de uso.
            candidate: Manifesto candidato que poderá se tornar ativo.
            state: Estado imutável que será validado ou persistido.
            ingestion: Entrada ``ingestion``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            new_archive_objects: Entrada ``new_archive_objects``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.
            new_analysis_events: Entrada ``new_analysis_events``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.

        Returns:
            Resultado terminal com versões, contagens reconciliadas e uso de disco local.
        """
        active = self._manifests.get_active()
        return RunResult(
            request.run_id,
            candidate,
            state.stage,
            active.dataset_version if active is not None else None,
            ingestion.read,
            ingestion.accepted,
            ingestion.rejected,
            ingestion.written,
            ingestion.unchanged,
            new_archive_objects,
            new_analysis_events,
            ingestion.results,
            ingestion.records.disk_usage(),
        )

    def execute(self, request: BackfillRequest) -> RunResult:
        """Executa todas as etapas do backfill e devolve somente após persistir um estado
        terminal.

        O fluxo restaura e valida o snapshot, lê cada dataset com paginação por chave, normaliza
        os registros, grava dados quentes, constrói projeções, publica o arquivo histórico,
        reconcilia as contagens e envia a outbox. Uma falha anterior à ativação mantém a
        candidata invisível; repetições usam as mesmas chaves de idempotência para retomar com
        segurança.

        Args:
            request: Objeto de entrada já estruturado para o caso de uso.

        Returns:
            Resultado terminal com versões, contagens reconciliadas e uso máximo de disco local.

        Raises:
            TypeError: Se a requisição ou uma dependência produzir um tipo inválido.
            BackfillValidationError: Se snapshot, esquema, cobertura ou contagens divergirem.
            BackfillFailed: Se uma fase falhar depois da criação da execução; informa a fase e
                uma mensagem segura para persistência.
        """
        if not isinstance(request, BackfillRequest):
            raise TypeError("request must be a BackfillRequest")
        snapshot = self._registry.snapshot
        # O sha vem da evidência operacional do snapshot, não do contrato: é o
        # dump que esta execução vai restaurar. O contrato garante a FORMA; a
        # identidade do dump vira linhagem, porque o dataset_version deriva dela.
        expected_checksum = request.restore_request.expected_sha256
        version_factory = (
            canonical_dataset_version
            if request.pipeline is RunPipeline.CANONICAL_V2
            else dataset_version
        )
        candidate = version_factory(
            str(snapshot["sourceSystem"]),
            expected_checksum,
            str(snapshot["physicalContractVersion"]),
            str(snapshot["canonicalSchemaVersion"]),
        )
        source = str(snapshot["sourceSystem"])
        snapshot_date = request.snapshot_extracted_on
        workspace_identity = {"version": candidate}
        if request.pipeline is RunPipeline.CANONICAL_V2:
            workspace_identity["runId"] = request.run_id
        workspace_root = (
            request.archive_workdir / ".spool" / sha256_id("workspace_", workspace_identity)
        )
        spool_root = workspace_root / "records"
        disk_budget = DiskBudget(
            workspace_root,
            request.disk_budget_bytes,
            free_bytes=request.disk_free_bytes,
            usage_reporter=self._disk_usage_reporter,
        )
        try:
            disk_budget.preflight("backfill workspace")
        except DiskBudgetExceeded as error:
            raise BackfillValidationError(str(error)) from error
        state = RunState.start(request.run_id, candidate, pipeline=request.pipeline)
        started_at = self._now()
        self._activity = _RunActivityTracker(
            self._activity_reporter,
            state.stage,
            started_at,
            len(self._registry.names()),
        )
        heartbeat: _LeaseHeartbeat | None = None
        spool: _RecordSpool | None = None
        ingestion: _IngestionState | None = None
        timer = _StageTimer(self._now, started_at)
        candidate_is_active = False
        run_created = False
        new_archive_objects = 0
        new_analysis_events = 0
        try:
            lease = self._leases.acquire(
                source,
                request.run_id,
                started_at,
                request.lease_ttl_seconds,
                idempotency_key=f"lease-acquire:{request.run_id}:{candidate}",
            )
        except Exception:
            disk_budget.report_fatal()
            raise
        try:
            state = self._runs.create(
                state,
                idempotency_key=f"run-create:{request.run_id}",
            )
            run_created = True

            def observe_heartbeat(observed_at: datetime) -> None:
                disk_budget.heartbeat()
                assert self._activity is not None
                self._activity.heartbeat(observed_at)

            heartbeat = _LeaseHeartbeat(
                self._leases,
                lease,
                request.lease_ttl_seconds,
                self._now,
                request.run_id,
                on_renew=observe_heartbeat,
            )
            heartbeat.start()
            spool = _RecordSpool(
                spool_root,
                snapshot_date,
                disk_budget,
                workspace_root=workspace_root,
            )
            ingestion = _IngestionState({}, spool)
            is_canonical = request.pipeline is RunPipeline.CANONICAL_V2
            if is_canonical:
                if self._canonical_sets is None:
                    raise BackfillValidationError(
                        "canonical set store is required for canonical-v2"
                    )
                committed = self._canonical_sets.get(candidate)
                if committed is not None:
                    self._reconcile_canonical_set(committed, request)
                    self._load_canonical_counts(committed, ingestion)
                    schemas, coverage = self._canonical_manifest_inputs(committed)
                    partition_counts = {
                        item.dataset: len(item.partitions) for item in committed.datasets
                    }
                    state = self._transition(state, RunStage.VALIDATING, ingestion, timer)
                    heartbeat.checkpoint()
                    state = self._transition(state, RunStage.EXTRACTING, ingestion, timer)
                    state = self._transition(state, RunStage.ARCHIVING, ingestion, timer)
                    stored = self._manifests.get_candidate(candidate)
                    state = self._transition(state, RunStage.PROJECTING, ingestion, timer)
                    projection_result = self._project_canonical(
                        workspace_root,
                        committed,
                        ingestion,
                    )
                    heartbeat.checkpoint()
                    state = self._transition(
                        state,
                        RunStage.MATERIALIZING_HOT,
                        ingestion,
                        timer,
                        substage="SKIPPED_BY_POLICY",
                        units_completed=0,
                        units_total=0,
                        unit_label="datasets",
                    )
                    state = self._transition(state, RunStage.FINALIZING_CANDIDATE, ingestion, timer)
                    generated = self._manifest(
                        candidate,
                        schemas,
                        coverage,
                        ingestion,
                        partition_counts,
                        projection_result,
                        snapshot_date,
                        self._now(),
                        request.restore_request.expected_sha256,
                        request.pipeline,
                        committed,
                    )
                    if stored is not None:
                        if not _same_candidate_evidence(stored, generated):
                            raise BackfillValidationError(
                                "stored candidate differs from canonical reconstruction"
                            )
                    else:
                        self._manifests.put_candidate(
                            generated,
                            expected_absent=True,
                            idempotency_key=f"manifest-candidate:{request.run_id}:{candidate}",
                        )
                    heartbeat.checkpoint()
                    state, new_analysis_events = self._publish_after_activation(
                        request,
                        candidate,
                        state,
                        ingestion,
                        timer,
                        heartbeat,
                        candidate_is_active=False,
                        authorize_ttl=False,
                        events=(),
                        count_new_analysis_events=False,
                    )
                    return self._result(
                        request,
                        candidate,
                        state,
                        ingestion,
                        0,
                        new_analysis_events,
                    )
            active_before = self._manifests.get_active()
            if (
                not is_canonical
                and active_before is not None
                and active_before.dataset_version == candidate
            ):
                state, new_analysis_events = self._resume_active_candidate(
                    request,
                    candidate,
                    active_before,
                    state,
                    ingestion,
                    timer,
                    heartbeat,
                )
                return self._result(
                    request,
                    candidate,
                    state,
                    ingestion,
                    new_archive_objects,
                    new_analysis_events,
                )
            state = self._transition(state, RunStage.RESTORING, ingestion, timer)
            heartbeat.checkpoint()
            restored = self._restorer.restore(
                request.restore_request,
                idempotency_key=f"restore:{candidate}",
            )
            if restored.compressed_sha256 != expected_checksum:
                raise SnapshotChecksumMismatch("restored checksum differs from the request")
            heartbeat.checkpoint()

            state = self._transition(state, RunStage.VALIDATING, ingestion, timer)
            heartbeat.checkpoint()
            if self._snapshot_preparer is not None:
                prepare_started = monotonic_time.monotonic()
                _LOGGER.info("snapshot cursor-index preparation started")
                evidence = self._snapshot_preparer.prepare(tuple(self._registry))
                _LOGGER.info(
                    "snapshot cursor-index preparation completed datasets=%d duration_ms=%d",
                    len(evidence),
                    int((monotonic_time.monotonic() - prepare_started) * 1_000),
                )
                heartbeat.checkpoint()
            reader = self._reader_factory()
            schemas, coverage = self._validate_source(reader, ingestion)
            context = self._normalization_context(reader)
            if not isinstance(context, NormalizationContext):
                raise TypeError("normalization_context must return NormalizationContext")
            heartbeat.checkpoint()

            active_before = self._manifests.get_active()
            if (
                not is_canonical
                and active_before is not None
                and active_before.dataset_version == candidate
            ):
                state, new_analysis_events = self._resume_active_candidate(
                    request,
                    candidate,
                    active_before,
                    state,
                    ingestion,
                    timer,
                    heartbeat,
                )
                return self._result(
                    request,
                    candidate,
                    state,
                    ingestion,
                    new_archive_objects,
                    new_analysis_events,
                )
            stored_candidate = self._manifests.get_candidate(candidate)
            replay = active_before is not None and active_before.dataset_version == candidate
            if is_canonical:
                state = self._transition(state, RunStage.EXTRACTING, ingestion, timer)
                heartbeat.checkpoint()
                ingestion = self._extract_to_spool(
                    reader,
                    context,
                    request,
                    candidate,
                    snapshot_date,
                    ingestion,
                    coverage,
                )
                for name, observed in coverage.items():
                    persisted = ingestion.records.dataset_count(name)
                    if persisted != observed.row_count:
                        raise DataReconciliationError(
                            f"coverage count for {name} differs from normalized records"
                        )
                heartbeat.checkpoint()
                state = self._transition(state, RunStage.ARCHIVING, ingestion, timer)
                heartbeat.checkpoint()
                archive_result = self._archive_canonical(
                    request,
                    candidate,
                    snapshot_date,
                    ingestion,
                    coverage,
                )
                schemas, coverage = self._canonical_manifest_inputs(archive_result.canonical_set)
                new_archive_objects = archive_result.new_objects
                partition_counts = {
                    item.dataset: len(item.partitions)
                    for item in archive_result.canonical_set.datasets
                }
                heartbeat.checkpoint()
                state = self._transition(state, RunStage.PROJECTING, ingestion, timer)
                heartbeat.checkpoint()
                projection_result = self._project_canonical(
                    workspace_root,
                    archive_result.canonical_set,
                    ingestion,
                )
                heartbeat.checkpoint()
                state = self._transition(
                    state,
                    RunStage.MATERIALIZING_HOT,
                    ingestion,
                    timer,
                    substage="SKIPPED_BY_POLICY",
                    units_completed=0,
                    units_total=0,
                    unit_label="datasets",
                )
                state = self._transition(state, RunStage.FINALIZING_CANDIDATE, ingestion, timer)
                heartbeat.checkpoint()
            else:
                state = self._transition(state, RunStage.INGESTING, ingestion, timer)
                heartbeat.checkpoint()
                ingestion = self._ingest(
                    reader,
                    context,
                    request,
                    candidate,
                    snapshot_date,
                    replay,
                    ingestion,
                    coverage,
                    stored_candidate,
                )
                for name, observed in coverage.items():
                    persisted = ingestion.records.dataset_count(name)
                    if persisted != observed.row_count:
                        raise BackfillValidationError(
                            f"coverage count for {name} differs from normalized records"
                        )
                heartbeat.checkpoint()
                state = self._transition(state, RunStage.PROJECTING, ingestion, timer)
                heartbeat.checkpoint()
                projection_result = self._projections.materialize_record_batches(
                    candidate,
                    ingestion.records.day_batches(),
                    retain_projections=False,
                )
                heartbeat.checkpoint()
                state = self._transition(state, RunStage.ARCHIVING, ingestion, timer)
                heartbeat.checkpoint()
                new_archive_objects, partition_counts = self._archive(
                    request,
                    candidate,
                    snapshot_date,
                    ingestion,
                    projection_result,
                )
                heartbeat.checkpoint()
                state = self._transition(state, RunStage.ACTIVATING, ingestion, timer)
                heartbeat.checkpoint()
            generated_manifest = self._manifest(
                candidate,
                schemas,
                coverage,
                ingestion,
                partition_counts,
                projection_result,
                snapshot_date,
                self._now(),
                request.restore_request.expected_sha256,
                request.pipeline,
                archive_result.canonical_set if is_canonical else None,
            )
            if stored_candidate is not None:
                if not _same_candidate_evidence(stored_candidate, generated_manifest):
                    raise BackfillValidationError(
                        "stored candidate differs from reconstructed dataset evidence"
                    )
                manifest = stored_candidate
            elif replay and active_before is not None:
                if not _same_candidate_evidence(active_before, generated_manifest):
                    raise BackfillValidationError(
                        "active manifest differs from reconstructed dataset evidence"
                    )
                manifest = active_before
            else:
                manifest = generated_manifest
                heartbeat.checkpoint()
                self._manifests.put_candidate(
                    manifest,
                    expected_absent=True,
                    idempotency_key=f"manifest-candidate:{request.run_id}:{candidate}",
                )
                heartbeat.checkpoint()
            if not is_canonical and request.activate and active_before != manifest:
                heartbeat.checkpoint()
                activated_manifest = self._manifests.activate(
                    active_before.dataset_version if active_before is not None else None,
                    manifest,
                    idempotency_key=f"manifest-activate:{request.run_id}:{candidate}",
                )
                heartbeat.checkpoint()
                active_after = self._manifests.get_active()
                if activated_manifest != manifest or active_after != manifest:
                    raise BackfillValidationError(
                        "manifest activation did not durably select the candidate"
                    )
            candidate_is_active = not is_canonical and (
                (active_before == manifest) or request.activate
            )
            authorize_ttl = not is_canonical and request.activate and candidate_is_active
            events = (
                self._analysis_events(candidate, coverage, manifest, ingestion)
                if candidate_is_active
                else ()
            )
            state, new_analysis_events = self._publish_after_activation(
                request,
                candidate,
                state,
                ingestion,
                timer,
                heartbeat,
                candidate_is_active=candidate_is_active,
                authorize_ttl=authorize_ttl,
                events=events,
                count_new_analysis_events=not replay and not is_canonical,
            )
            return self._result(
                request,
                candidate,
                state,
                ingestion,
                new_archive_objects,
                new_analysis_events,
            )
        except Exception as error:
            sanitized = PersistedError.from_untrusted(str(error) or type(error).__name__).message
            if not run_created:
                raise BackfillFailed(state.stage, sanitized) from error
            try:
                durable_state = self._runs.get_run(request.run_id)
            except Exception:
                durable_state = None
            if durable_state is not None and durable_state.stage in {
                RunStage.SUCCEEDED,
                RunStage.PARTIAL,
            }:
                if ingestion is None:
                    raise BackfillFailed(state.stage, sanitized) from error
                return self._result(
                    request,
                    candidate,
                    durable_state,
                    ingestion,
                    new_archive_objects,
                    new_analysis_events,
                )
            if ingestion is None:
                ingestion = _IngestionState(
                    {},
                    _RecordSpool(
                        workspace_root / "records",
                        snapshot_date,
                        DiskBudget(
                            workspace_root,
                            request.disk_budget_bytes,
                            free_bytes=request.disk_free_bytes,
                            usage_reporter=self._disk_usage_reporter,
                        ),
                        workspace_root=workspace_root,
                    ),
                )
                spool = ingestion.records
            active_now = self._manifests.get_active()
            candidate_is_active = candidate_is_active or (
                request.activate
                and active_now is not None
                and active_now.dataset_version == candidate
            )
            if candidate_is_active and state.stage is RunStage.ACTIVATING:
                try:
                    state = self._transition(
                        state,
                        RunStage.PUBLISHING,
                        ingestion,
                        timer,
                        mark_candidate_active=True,
                    )
                except Exception as repository_error:
                    raise BackfillFailed(
                        state.stage,
                        str(repository_error) or type(repository_error).__name__,
                    ) from repository_error
            if state.stage is RunStage.PUBLISHING:
                try:
                    self._runs.append_error(
                        request.run_id,
                        1,
                        sanitized,
                        expected_stage=state.stage,
                        idempotency_key=f"run-error:{request.run_id}:1",
                    )
                    state = self._transition(
                        state,
                        RunStage.PARTIAL,
                        ingestion,
                        timer,
                        error=sanitized,
                    )
                except Exception as repository_error:
                    raise BackfillFailed(
                        state.stage,
                        str(repository_error) or type(repository_error).__name__,
                    ) from repository_error
                return self._result(
                    request,
                    candidate,
                    state,
                    ingestion,
                    new_archive_objects,
                    new_analysis_events,
                )
            try:
                self._runs.append_error(
                    request.run_id,
                    1,
                    sanitized,
                    expected_stage=state.stage,
                    idempotency_key=f"run-error:{request.run_id}:1",
                )
                self._transition(
                    state,
                    RunStage.FAILED,
                    ingestion,
                    timer,
                    error=sanitized,
                )
            except Exception as repository_error:
                raise BackfillFailed(
                    state.stage,
                    str(repository_error) or type(repository_error).__name__,
                ) from repository_error
            raise BackfillFailed(state.stage, sanitized) from error
        finally:
            primary_failure = sys.exc_info()[0] is not None
            if primary_failure:
                disk_budget.report_fatal()
            cleanup_error: Exception | None = None
            if heartbeat is not None:
                try:
                    heartbeat.stop()
                except Exception as error:
                    cleanup_error = error
            self._activity = None
            if spool is not None:
                try:
                    spool.cleanup()
                except Exception as error:
                    cleanup_error = cleanup_error or error
            try:
                self._leases.release(
                    source,
                    request.run_id,
                    idempotency_key=f"lease-release:{request.run_id}:{candidate}",
                )
            except Exception:
                # A liberação é best-effort: disputas de posse/expiração nunca podem ocultar o
                # resultado do processamento nem uma BaseException de controle do processo.
                pass
            if not primary_failure and cleanup_error is not None:
                raise cleanup_error


__all__ = [
    "ArchiveBuildResult",
    "Backfill",
    "BackfillFailed",
    "BackfillRequest",
    "BackfillValidationError",
    "DatasetRunResult",
    "DataReconciliationError",
    "RunResult",
    "SourceSchemaInvalid",
]
