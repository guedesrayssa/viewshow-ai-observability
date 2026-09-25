"""Executa sincronização incremental com isolamento de falhas por fonte.

Papel no fluxo:
    No fluxo da aplicação, este módulo coordena regras do domínio por meio das interfaces de
    ``ports`` e não depende diretamente de SDKs ou formatos de infraestrutura.

Garantias e limites:
    A ordem das operações preserva idempotência, reconciliação e retomada segura quando uma
    execução é interrompida.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from types import MappingProxyType

from application.archive_partition import archive_partition_key
from application.bucket_evidence import BucketEvidence
from application.lease_guard import LeaseGuard
from application.publish_outbox import OutboxPublisher
from contracts.argus.v2.normalizers import NormalizationContext, normalize_row
from contracts.registry import DatasetRegistry
from domain.analysis import DEFAULT_FORECAST_MODEL, ForecastModel, canonical_utc_text
from domain.archive import candidate_manifest_pipeline
from domain.disk_budget import (
    DEFAULT_INGESTION_DISK_BUDGET_BYTES,
    MAX_INGESTION_DISK_BUDGET_BYTES,
    DiskBudget,
    DiskUsage,
    FreeBytes,
)
from domain.identity import canonical_dataset_version, dataset_version, sha256_id
from domain.models import CanonicalRecord, TimeWindow
from domain.persisted_error import PersistedError
from domain.run import RunPipeline, RunStage
from domain.snapshot_provenance import parse_snapshot_extracted_on
from ports import (
    CandidateManifest,
    CheckpointRepository,
    Cursor,
    HotRecordSink,
    LeaseRepository,
    ManifestRepository,
    OutboxEvent,
    SourceReader,
    WindowCommitRepository,
)


def _analysis_source(event_type: str) -> str:
    """Monta o identificador da fonte de análise.

    Args:
        event_type: Entrada ``event_type``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return f"analysis:{event_type}"


def _analysis_window(request: SyncRequest, event_type: str) -> TimeWindow | None:
    """Executa a etapa interna ``analysis_window`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        request: Objeto de entrada já estruturado para o caso de uso.
        event_type: Entrada ``event_type``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``TimeWindow | None`` produzido pela operação após as validações.
    """
    if event_type == "ANOMALY_DETECTION":
        return request.window
    if int(request.window.end.timestamp()) % 3600 != 0:
        return None
    return TimeWindow(
        request.window.end - timedelta(hours=1),
        request.window.end,
        3600,
    )


def _source_window(request: SyncRequest, grain_seconds: int | None) -> TimeWindow | None:
    """Executa a etapa interna ``source_window`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        request: Objeto de entrada já estruturado para o caso de uso.
        grain_seconds: Duração ou prazo expresso em segundos.

    Returns:
        Valor ``TimeWindow | None`` produzido pela operação após as validações.
    """
    requested_seconds = int((request.window.end - request.window.start).total_seconds())
    if grain_seconds is None or grain_seconds <= requested_seconds:
        return request.window
    if int(request.window.end.timestamp()) % grain_seconds != 0:
        return None
    return TimeWindow(
        request.window.end - timedelta(seconds=grain_seconds),
        request.window.end,
        grain_seconds,
    )


class ActiveManifestError(RuntimeError):
    """Indica que ``ActiveManifestError`` impediu a operação de continuar com segurança."""


def validate_active_manifest_identity(
    manifest: CandidateManifest | None,
    *,
    registry: DatasetRegistry,
) -> CandidateManifest:
    """Validate ACTIVE against the registry and its persisted representation contract."""
    if manifest is None:
        raise ActiveManifestError("ACTIVE manifest is required for live sync")
    try:
        pipeline = candidate_manifest_pipeline(manifest)
    except (TypeError, ValueError) as error:
        raise ActiveManifestError("ACTIVE manifest is invalid") from error
    snapshot = registry.snapshot
    identity_values = (
        snapshot.get("sourceSystem"),
        manifest.metadata.get("dumpChecksumSha256"),
        snapshot.get("physicalContractVersion"),
        snapshot.get("canonicalSchemaVersion"),
    )
    if not all(isinstance(value, str) and value for value in identity_values):
        raise ActiveManifestError("live registry contract identity is invalid")
    source_system, dump_checksum, physical_version, canonical_version = (
        str(value) for value in identity_values
    )
    version_factory = (
        canonical_dataset_version if pipeline is RunPipeline.CANONICAL_V2 else dataset_version
    )
    expected_version = version_factory(
        source_system,
        dump_checksum,
        physical_version,
        canonical_version,
    )
    metadata = manifest.metadata
    raw_intervals = metadata["availableIntervals"]
    if not isinstance(raw_intervals, Mapping) or frozenset(raw_intervals) != frozenset(
        registry.names()
    ):
        raise ActiveManifestError("ACTIVE manifest datasets do not match the live sync registry")
    if (
        manifest.dataset_version != expected_version
        or metadata["dumpChecksumSha256"] != dump_checksum
        or metadata["physicalContractVersion"] != physical_version
        or metadata["canonicalSchemaVersion"] != canonical_version
    ):
        raise ActiveManifestError(
            "ACTIVE manifest contract identity does not match the live registry"
        )
    return manifest


def active_manifest_source_watermarks(
    manifest: CandidateManifest | None,
    *,
    registry: DatasetRegistry,
    source_dataset_names: tuple[str, ...],
) -> Mapping[str, datetime]:
    """Executa a etapa interna ``active_manifest_source_watermarks`` e devolve o resultado
    validado indicado pela assinatura.

    Args:
        manifest: Entrada ``manifest``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        registry: Entrada ``registry``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        source_dataset_names: Entrada ``source_dataset_names``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.

    Returns:
        Valor ``Mapping[str, datetime]`` produzido pela operação após as validações.

    Raises:
        ActiveManifestError: Se a operação não puder preservar as invariantes descritas.
    """
    manifest = validate_active_manifest_identity(manifest, registry=registry)
    expected = frozenset(registry.names())
    if len(expected) != len(registry.names()) or not set(source_dataset_names) <= expected:
        raise ActiveManifestError("ACTIVE manifest datasets do not match the live sync registry")
    metadata = manifest.metadata
    raw_watermarks = metadata["watermarks"]
    raw_hot_from = metadata["hotFrom"]
    if not isinstance(raw_watermarks, Mapping) or not isinstance(raw_hot_from, Mapping):
        raise ActiveManifestError("ACTIVE manifest source baseline is invalid")
    if set(raw_watermarks) != expected or set(raw_hot_from) != expected:
        raise ActiveManifestError("ACTIVE manifest datasets do not match the live sync registry")
    watermarks: dict[str, datetime] = {}
    snapshot_baseline: datetime | None = None
    for dataset in source_dataset_names:
        raw = raw_watermarks[dataset]
        if raw is None:
            if raw_hot_from[dataset] is not None:
                raise ActiveManifestError("ACTIVE manifest source baseline is invalid")
            if snapshot_baseline is None:
                raw_extracted_on = metadata.get("snapshotExtractedOn")
                try:
                    extracted_on = parse_snapshot_extracted_on(raw_extracted_on)
                except ValueError as error:
                    raise ActiveManifestError(
                        "ACTIVE manifest snapshotExtractedOn is invalid"
                    ) from error
                snapshot_baseline = datetime(
                    extracted_on.year,
                    extracted_on.month,
                    extracted_on.day,
                    tzinfo=UTC,
                )
            watermarks[dataset] = snapshot_baseline
            continue
        if not isinstance(raw, str):
            raise ActiveManifestError("ACTIVE manifest source watermark is invalid")
        try:
            value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError as error:
            raise ActiveManifestError("ACTIVE manifest source watermark is invalid") from error
        if value.tzinfo is None or value.utcoffset() != timedelta(0):
            raise ActiveManifestError("ACTIVE manifest source watermark is invalid")
        watermarks[dataset] = value.astimezone(UTC)
    return MappingProxyType(watermarks)


def _text(value: object, field: str) -> str:
    """Executa a etapa interna ``text`` e devolve o resultado validado indicado pela assinatura.

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


def _observed_at(record: CanonicalRecord) -> datetime:
    """Executa a etapa interna ``observed_at`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        record: Registro canônico consumido pela operação.

    Returns:
        Valor ``datetime`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if record.observed_at is None:
        raise ValueError("sync records must expose an observation timestamp")
    return record.observed_at


def _record_start(record: CanonicalRecord) -> datetime:
    """Obtém ou registra start como evidência da execução atual.

    Args:
        record: Registro canônico consumido pela operação.

    Returns:
        Valor ``datetime`` produzido pela operação após as validações.
    """
    if record.window is not None:
        return record.window.start
    return _observed_at(record)


@dataclass(frozen=True, slots=True)
class SyncRequest:
    """Representa os dados de ``SyncRequest`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        run_id: Identificador não secreto e estável da execução.
        dataset_version: Identificador imutável da versão do dataset.
        window: Janela temporal UTC, fechada no início e aberta no fim.
        dataset_names: Entrada ``dataset_names``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        page_size: Entrada ``page_size``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        analysis_watermarks: Entrada ``analysis_watermarks``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        source_watermarks: Entrada ``source_watermarks``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        lease_ttl_seconds: Duração ou prazo expresso em segundos.
    """

    run_id: str
    dataset_version: str
    window: TimeWindow
    dataset_names: tuple[str, ...]
    page_size: int = 500
    analysis_watermarks: Mapping[str, datetime] = MappingProxyType({})
    source_watermarks: Mapping[str, datetime] = MappingProxyType({})
    lease_ttl_seconds: int = 300

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        _text(self.run_id, "run_id")
        _text(self.dataset_version, "dataset_version")
        if not isinstance(self.window, TimeWindow):
            raise TypeError("window must be a TimeWindow")
        if not self.dataset_names or any(
            not isinstance(name, str) or not name for name in self.dataset_names
        ):
            raise ValueError("dataset_names must contain non-empty dataset names")
        if len(set(self.dataset_names)) != len(self.dataset_names):
            raise ValueError("dataset_names must not contain duplicates")
        if isinstance(self.page_size, bool) or not isinstance(self.page_size, int):
            raise TypeError("page_size must be an integer")
        if self.page_size <= 0:
            raise ValueError("page_size must be positive")
        prior = dict(self.analysis_watermarks)
        if not set(prior) <= {"ANOMALY_DETECTION", "QOE_FORECAST"}:
            raise ValueError("analysis_watermarks contains unsupported event types")
        if any(
            not isinstance(name, str)
            or not name
            or not isinstance(value, datetime)
            or value.tzinfo is None
            or value.utcoffset() != timedelta(0)
            for name, value in prior.items()
        ):
            raise ValueError("analysis_watermarks must contain aware UTC datetimes")
        object.__setattr__(self, "dataset_names", tuple(self.dataset_names))
        object.__setattr__(self, "analysis_watermarks", MappingProxyType(prior))
        source_prior = dict(self.source_watermarks)
        if any(
            not isinstance(name, str)
            or not name
            or not isinstance(value, datetime)
            or value.tzinfo is None
            or value.utcoffset() != timedelta(0)
            for name, value in source_prior.items()
        ):
            raise ValueError("source_watermarks must contain named aware UTC datetimes")
        if isinstance(self.lease_ttl_seconds, bool) or not isinstance(self.lease_ttl_seconds, int):
            raise TypeError("lease_ttl_seconds must be an integer")
        if self.lease_ttl_seconds <= 0:
            raise ValueError("lease_ttl_seconds must be positive")
        object.__setattr__(self, "source_watermarks", MappingProxyType(source_prior))


@dataclass(frozen=True, slots=True)
class SyncSourceResult:
    """Representa os dados de ``SyncSourceResult`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        dataset: Nome do dataset permitido pelo registro de contratos.
        succeeded: Entrada ``succeeded``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        records_written: Entrada ``records_written``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        records_unchanged: Entrada ``records_unchanged``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        watermark: Entrada ``watermark``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        error: Entrada ``error``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        latest_observed_at: Instante UTC com fuso horário usado pela regra temporal.
    """

    dataset: str
    succeeded: bool
    records_written: int
    records_unchanged: int
    watermark: datetime | None
    error: str | None = None
    latest_observed_at: datetime | None = None

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        _text(self.dataset, "dataset")
        if type(self.succeeded) is not bool:
            raise TypeError("succeeded must be a boolean")
        for field in ("records_written", "records_unchanged"):
            value = getattr(self, field)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{field} must be a non-negative integer")
        if self.watermark is not None and (
            not isinstance(self.watermark, datetime)
            or self.watermark.tzinfo is None
            or self.watermark.utcoffset() != timedelta(0)
        ):
            raise ValueError("watermark must be an aware UTC datetime or None")
        if self.latest_observed_at is not None and (
            not isinstance(self.latest_observed_at, datetime)
            or self.latest_observed_at.tzinfo is None
            or self.latest_observed_at.utcoffset() != timedelta(0)
        ):
            raise ValueError("latest_observed_at must be an aware UTC datetime or None")
        if self.succeeded == (self.error is not None):
            raise ValueError("source success and error evidence are inconsistent")
        if self.error is not None and not self.error:
            raise ValueError("error must be non-empty when present")


@dataclass(frozen=True, slots=True)
class SyncResult:
    """Representa os dados de ``SyncResult`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        sources: Entrada ``sources``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        analysis_watermarks: Entrada ``analysis_watermarks``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        new_analysis_events: Entrada ``new_analysis_events``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        publication_error: Entrada ``publication_error``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        stage: Entrada ``stage``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        local_disk_usage: Entrada ``local_disk_usage``; a forma aceita é definida pela anotação
        de tipo e validada antes do uso.
    """

    sources: Mapping[str, SyncSourceResult]
    analysis_watermarks: Mapping[str, datetime]
    new_analysis_events: int
    publication_error: str | None = None
    stage: RunStage = RunStage.SUCCEEDED
    local_disk_usage: DiskUsage | None = None

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        sources = dict(self.sources)
        if any(not isinstance(value, SyncSourceResult) for value in sources.values()):
            raise TypeError("sources must contain only SyncSourceResult values")
        if any(key != value.dataset for key, value in sources.items()):
            raise ValueError("source result keys must match datasets")
        watermarks = dict(self.analysis_watermarks)
        if any(
            not isinstance(value, datetime)
            or value.tzinfo is None
            or value.utcoffset() != timedelta(0)
            for value in watermarks.values()
        ):
            raise ValueError("analysis watermarks must be aware UTC datetimes")
        if (
            isinstance(self.new_analysis_events, bool)
            or not isinstance(self.new_analysis_events, int)
            or self.new_analysis_events < 0
        ):
            raise ValueError("new_analysis_events must be a non-negative integer")
        if self.publication_error is not None and (
            not isinstance(self.publication_error, str) or not self.publication_error
        ):
            raise ValueError("publication_error must be non-empty text or None")
        if self.stage not in {
            RunStage.SUCCEEDED,
            RunStage.PARTIAL,
            RunStage.SKIPPED_LOCKED,
            RunStage.SKIPPED_DISABLED,
        }:
            raise ValueError("sync result stage is invalid")
        if self.stage is RunStage.SKIPPED_LOCKED and (sources or watermarks):
            raise ValueError("a locked sync result cannot report processing progress")
        if self.stage is RunStage.SKIPPED_DISABLED and (sources or self.new_analysis_events):
            raise ValueError("a disabled sync result cannot report processing progress")
        if self.local_disk_usage is not None and not isinstance(self.local_disk_usage, DiskUsage):
            raise TypeError("local_disk_usage must be DiskUsage or None")
        object.__setattr__(self, "sources", MappingProxyType(sources))
        object.__setattr__(self, "analysis_watermarks", MappingProxyType(watermarks))

    @property
    def succeeded(self) -> bool:
        """Verifica a condição associada a succeeded.

        Returns:
            Valor ``bool`` produzido pela operação após as validações.
        """
        return self.stage is RunStage.SUCCEEDED and (
            all(item.succeeded for item in self.sources.values()) and self.publication_error is None
        )


@dataclass(slots=True)
class _SyncProgress:
    """Representa os dados de ``_SyncProgress`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        written: Entrada ``written``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        unchanged: Entrada ``unchanged``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        watermark: Entrada ``watermark``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        latest_observed_at: Instante UTC com fuso horário usado pela regra temporal.
    """

    written: int = 0
    unchanged: int = 0
    watermark: datetime | None = None
    latest_observed_at: datetime | None = None

    def record(self, records: tuple[CanonicalRecord, ...], written: int, unchanged: int) -> None:
        """Obtém ou registra a entrada como evidência da execução atual.

        Args:
            records: Registros canônicos consumidos pela operação.
            written: Entrada ``written``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            unchanged: Entrada ``unchanged``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self.written += written
        self.unchanged += unchanged
        observed = max(_observed_at(record) for record in records)
        self.latest_observed_at = (
            observed if self.latest_observed_at is None else max(self.latest_observed_at, observed)
        )


class Sync:
    """Agrupa o estado e as operações de ``Sync`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        *,
        registry: DatasetRegistry,
        reader_factory: Callable[[], SourceReader],
        hot_sink: HotRecordSink,
        checkpoints: CheckpointRepository,
        window_commits: WindowCommitRepository,
        outbox_publisher: OutboxPublisher,
        leases: LeaseRepository,
        manifests: ManifestRepository,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        normalization_context: Callable[[SourceReader], NormalizationContext] | None = None,
        analysis_dependencies: Mapping[str, tuple[str, ...]] | None = None,
        disk_budget_bytes: int = DEFAULT_INGESTION_DISK_BUDGET_BYTES,
        disk_free_bytes: FreeBytes | None = None,
        forecast_model: ForecastModel = DEFAULT_FORECAST_MODEL,
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            registry: Entrada ``registry``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            reader_factory: Fábrica injetada que cria a dependência somente quando necessária.
            hot_sink: Destino injetado que recebe os valores validados.
            checkpoints: Entrada ``checkpoints``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            window_commits: Entrada ``window_commits``; a forma aceita é definida pela anotação
            de tipo e validada antes do uso.
            outbox_publisher: Publicador injetado que envia dados e confirma o destino.
            leases: Entrada ``leases``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            manifests: Entrada ``manifests``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            clock: Função injetável que fornece o instante atual para validação e testes.
            normalization_context: Entrada ``normalization_context``; a forma aceita é definida
            pela anotação de tipo e validada antes do uso.
            analysis_dependencies: Entrada ``analysis_dependencies``; a forma aceita é definida
            pela anotação de tipo e validada antes do uso.
            disk_budget_bytes: Quantidade de bytes usada como tamanho ou limite.
            disk_free_bytes: Quantidade de bytes usada como tamanho ou limite.
            forecast_model: Identidade do modelo declarada nos eventos ``QOE_FORECAST``.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        self._registry = registry
        self._forecast_model = forecast_model
        self._reader_factory = reader_factory
        self._hot_sink = hot_sink
        self._checkpoints = checkpoints
        self._window_commits = window_commits
        self._outbox_publisher = outbox_publisher
        self._leases = leases
        if not isinstance(manifests, ManifestRepository):
            raise TypeError("manifests must implement ManifestRepository")
        self._manifests = manifests
        self._clock = clock
        if isinstance(disk_budget_bytes, bool) or not isinstance(disk_budget_bytes, int):
            raise TypeError("disk_budget_bytes must be an integer")
        if not 0 < disk_budget_bytes <= MAX_INGESTION_DISK_BUDGET_BYTES:
            raise ValueError(
                f"disk_budget_bytes must be between 1 and {MAX_INGESTION_DISK_BUDGET_BYTES}"
            )
        if disk_free_bytes is not None and not callable(disk_free_bytes):
            raise TypeError("disk_free_bytes must be callable or None")
        self._disk_budget_bytes = disk_budget_bytes
        self._disk_free_bytes = disk_free_bytes
        self._normalization_context = normalization_context or (
            lambda _reader: NormalizationContext()
        )
        dependencies = analysis_dependencies or {
            "ANOMALY_DETECTION": ("signal_bucket", "live_active_15min"),
            "QOE_FORECAST": ("live_qoe_hourly",),
        }
        if set(dependencies) != {
            "ANOMALY_DETECTION",
            "QOE_FORECAST",
        }:
            raise ValueError("analysis_dependencies must declare the two supported event types")
        known = set(registry.names())
        if any(not values or not set(values) <= known for values in dependencies.values()):
            raise ValueError("analysis dependencies must be non-empty allowlisted datasets")
        if any(len(values) != len(set(values)) for values in dependencies.values()):
            raise ValueError("analysis dependencies must not contain duplicates")
        self._analysis_dependencies = MappingProxyType(
            {name: tuple(values) for name, values in dependencies.items()}
        )
        self._evidence_horizon_seconds = max(
            900 if event_type == "ANOMALY_DETECTION" else 3600
            for event_type in self._analysis_dependencies
        )

    def _hydrate_active_source_watermarks(self, request: SyncRequest) -> SyncRequest:
        """Preenche ativo fonte watermarks a partir do estado durável disponível.

        Args:
            request: Objeto de entrada já estruturado para o caso de uso.

        Returns:
            Valor ``SyncRequest`` produzido pela operação após as validações.

        Raises:
            ActiveManifestError: Se a operação não puder preservar as invariantes descritas.
        """
        active = self._manifests.get_active()
        manifest_watermarks = active_manifest_source_watermarks(
            active,
            registry=self._registry,
            source_dataset_names=request.dataset_names,
        )
        assert active is not None
        if active.dataset_version != request.dataset_version:
            raise ActiveManifestError("sync dataset_version does not match ACTIVE manifest")
        source_watermarks = dict(request.source_watermarks)
        for dataset in request.dataset_names:
            committed = self._window_commits.get_watermark(
                request.dataset_version, f"source:{dataset}"
            )
            if committed is not None:
                source_watermarks[dataset] = committed
            elif dataset in manifest_watermarks:
                source_watermarks[dataset] = manifest_watermarks[dataset]
        return replace(request, source_watermarks=source_watermarks)

    def _drain_pending(self, limit: int, *, maximum_batches: int = 100) -> None:
        """Consome pendente até o fim sem manter todo o conteúdo em memória.

        Args:
            limit: Quantidade máxima de itens que a operação pode processar.
            maximum_batches: Entrada ``maximum_batches``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        for _batch in range(maximum_batches):
            if self._outbox_publisher.publish_pending(limit).attempted < limit:
                return

    def _adopt_legacy_analysis_watermarks(
        self, request: SyncRequest, watermarks: dict[str, datetime]
    ) -> None:
        """Adota legacy análise watermarks legado somente quando compatível com o contrato
        atual.

        Args:
            request: Objeto de entrada já estruturado para o caso de uso.
            watermarks: Entrada ``watermarks``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        legacy_source = "analysis:ANOMALY_DETECTION+QOE_FORECAST"
        legacy = self._window_commits.get_watermark(request.dataset_version, legacy_source)
        if legacy is None:
            return
        for event_type in self._analysis_dependencies:
            source = _analysis_source(event_type)
            if self._window_commits.get_watermark(request.dataset_version, source) is not None:
                continue
            event = self._event(request.dataset_version, event_type, legacy, self._forecast_model)
            if self._window_commits.get_outbox_event(event.event_id) != event:
                continue
            self._window_commits.commit_watermark_and_outboxes(
                request.dataset_version,
                source,
                legacy,
                (),
                expected_watermark=None,
                idempotency_key=(
                    f"adopt-legacy-analysis:{request.dataset_version}:{source}:"
                    f"{int(legacy.timestamp() * 1000)}"
                ),
            )
            previous = watermarks.get(event_type)
            if previous is None or legacy > previous:
                watermarks[event_type] = legacy

    @staticmethod
    def _event(
        dataset_version: str,
        event_type: str,
        watermark: datetime,
        forecast_model: ForecastModel = DEFAULT_FORECAST_MODEL,
    ) -> OutboxEvent:
        """Executa a etapa interna ``event`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            event_type: Entrada ``event_type``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.
            watermark: Entrada ``watermark``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            forecast_model: Identidade do modelo declarada em eventos ``QOE_FORECAST``.

        Returns:
            Valor ``OutboxEvent`` produzido pela operação após as validações.
        """
        grain = 900 if event_type == "ANOMALY_DETECTION" else 3600
        identity = {
            "datasetVersion": dataset_version,
            "eventType": event_type,
            "windowEnd": watermark,
        }
        payload: dict[str, object] = {
            "window": {
                "start": canonical_utc_text(watermark - timedelta(seconds=grain), "start"),
                "end": canonical_utc_text(watermark, "end"),
                "grainSeconds": grain,
            },
            "scope": {"kind": "global", "dimensions": {}},
            "inputWatermark": canonical_utc_text(watermark, "watermark"),
        }
        if event_type == "QOE_FORECAST":
            payload.update(
                {
                    "model": forecast_model.payload(),
                    "targetWindow": {
                        "start": canonical_utc_text(watermark, "target.start"),
                        "end": canonical_utc_text(watermark + timedelta(hours=1), "target.end"),
                    },
                }
            )
        return OutboxEvent(
            sha256_id("evt_", identity),
            dataset_version,
            event_type,
            sha256_id("ana_", identity),
            watermark,
            payload,
        )

    def _sync_source(
        self,
        request: SyncRequest,
        reader: SourceReader,
        context: NormalizationContext,
        dataset: str,
        progress: _SyncProgress,
        lease: LeaseGuard,
        bucket_evidence: BucketEvidence,
    ) -> SyncSourceResult:
        """Monta o identificador da fonte de sync.

        Args:
            request: Objeto de entrada já estruturado para o caso de uso.
            reader: Entrada ``reader``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            context: Contexto validado compartilhado durante o processamento.
            dataset: Nome do dataset permitido pelo registro de contratos.
            progress: Entrada ``progress``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            lease: Entrada ``lease``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            bucket_evidence: Entrada ``bucket_evidence``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.

        Returns:
            Valor ``SyncSourceResult`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        descriptor = self._registry.require(dataset)
        source_window = _source_window(request, descriptor.grain_seconds)
        if source_window is None:
            return SyncSourceResult(dataset, True, 0, 0, None)
        lease.checkpoint()
        schema = reader.validate_schema(descriptor)
        if not schema.is_compatible:
            raise ValueError("physical source schema is incompatible")
        durable_watermark = self._window_commits.get_watermark(
            request.dataset_version, f"source:{dataset}"
        )
        baseline_watermark = durable_watermark or request.source_watermarks.get(dataset)
        after: Cursor | None = None
        page_number = 0
        while True:
            lease.checkpoint()
            page = reader.read_page(descriptor, source_window, after, request.page_size)
            if not page.rows:
                break
            records = tuple(normalize_row(descriptor, row, context) for row in page.rows)
            if any(
                _record_start(record) < source_window.start
                or _record_start(record) >= source_window.end
                for record in records
            ):
                raise ValueError("source record is outside the requested sync window")
            bucket_evidence.add(dataset, records)
            grouped: dict[str, list[CanonicalRecord]] = {}
            for record in records:
                partition = archive_partition_key(
                    record,
                    descriptor,
                    snapshot_date=source_window.end.date(),
                )
                grouped.setdefault(partition, []).append(record)
            for partition, values in sorted(grouped.items()):
                lease.checkpoint()
                result = self._hot_sink.write(
                    tuple(values),
                    request.dataset_version,
                    partition,
                    idempotency_key=(f"sync:{request.run_id}:{dataset}:{page_number}:{partition}"),
                )
                if result.written + result.unchanged != len(values):
                    raise ValueError(
                        "hot write reconciliation does not account for every accepted record"
                    )
                progress.record(tuple(values), result.written, result.unchanged)
                lease.checkpoint()
            if page.next_cursor is None or page.next_cursor == after:
                raise ValueError("source page cursor did not advance")
            after = page.next_cursor
            page_number += 1
        completion_watermark = source_window.end
        if baseline_watermark is None or completion_watermark > baseline_watermark:
            lease.checkpoint()
            self._window_commits.commit_watermark_and_outboxes(
                request.dataset_version,
                f"source:{dataset}",
                completion_watermark,
                (),
                expected_watermark=durable_watermark,
                idempotency_key=(
                    f"sync-source-window:{request.dataset_version}:{dataset}:"
                    f"{int(completion_watermark.timestamp() * 1000)}"
                ),
                bucket_evidence=bucket_evidence.snapshot(
                    dataset, horizon_seconds=self._evidence_horizon_seconds
                ),
            )
            lease.checkpoint()
        progress.watermark = (
            baseline_watermark
            if baseline_watermark is not None and baseline_watermark >= completion_watermark
            else completion_watermark
        )
        return SyncSourceResult(
            dataset,
            True,
            progress.written,
            progress.unchanged,
            progress.watermark,
            latest_observed_at=progress.latest_observed_at,
        )

    def execute(self, request: SyncRequest) -> SyncResult:
        """Executa o caso de uso implementado por ``Sync``.

        Args:
            request: Objeto de entrada já estruturado para o caso de uso.

        Returns:
            Valor ``SyncResult`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        if not isinstance(request, SyncRequest):
            raise TypeError("request must be a SyncRequest")
        request = self._hydrate_active_source_watermarks(request)
        descriptors = tuple(self._registry.require(name) for name in request.dataset_names)
        del descriptors
        source = str(self._registry.snapshot["sourceSystem"])
        lease = LeaseGuard(
            self._leases,
            ("SYNC_GLOBAL", source),
            f"sync-{request.run_id}",
            request.lease_ttl_seconds,
            self._clock,
        )
        if not lease.try_acquire():
            return SyncResult({}, {}, 0, stage=RunStage.SKIPPED_LOCKED)
        bucket_directory: TemporaryDirectory[str] | None = None
        bucket_evidence: BucketEvidence | None = None
        bucket_budget: DiskBudget | None = None
        try:
            lease.checkpoint()
            reader = self._reader_factory()
            context = self._normalization_context(reader)
            if not isinstance(context, NormalizationContext):
                raise TypeError("normalization_context must return NormalizationContext")
            bucket_directory = TemporaryDirectory(prefix="ingestion-sync-buckets-")
            bucket_root = Path(bucket_directory.name)
            bucket_budget = DiskBudget(
                bucket_root,
                self._disk_budget_bytes,
                free_bytes=self._disk_free_bytes,
            )
            bucket_budget.preflight("sync bucket evidence", required_bytes=32 * 1024)
            bucket_evidence = BucketEvidence(
                bucket_root,
                disk_budget=bucket_budget,
            )
            analysis_datasets = {
                dataset
                for dependencies in self._analysis_dependencies.values()
                for dataset in dependencies
            }
            for dataset in analysis_datasets:
                bucket_evidence.restore(
                    self._window_commits.get_bucket_evidence(
                        request.dataset_version, f"source:{dataset}"
                    )
                )
            sources: dict[str, SyncSourceResult] = {}
            for dataset in request.dataset_names:
                progress = _SyncProgress()
                try:
                    sources[dataset] = self._sync_source(
                        request,
                        reader,
                        context,
                        dataset,
                        progress,
                        lease,
                        bucket_evidence,
                    )
                except Exception as error:
                    sources[dataset] = SyncSourceResult(
                        dataset,
                        False,
                        progress.written,
                        progress.unchanged,
                        progress.watermark,
                        PersistedError.from_untrusted(str(error) or type(error).__name__).message,
                        progress.latest_observed_at,
                    )

            analysis_watermarks = dict(request.analysis_watermarks)
            for event_type in self._analysis_dependencies:
                durable_analysis = self._window_commits.get_watermark(
                    request.dataset_version, _analysis_source(event_type)
                )
                previous = analysis_watermarks.get(event_type)
                if durable_analysis is not None and (
                    previous is None or durable_analysis > previous
                ):
                    analysis_watermarks[event_type] = durable_analysis
            self._adopt_legacy_analysis_watermarks(request, analysis_watermarks)
            new_events = 0
            publication_error: str | None = None
            lease.checkpoint()
            self._drain_pending(request.page_size)
            lease.checkpoint()
            advancing: list[tuple[str, datetime, OutboxEvent | None]] = []
            for event_type, dependencies in self._analysis_dependencies.items():
                completed = tuple(sources[name] for name in dependencies if name in sources)
                if not completed or any(not item.succeeded for item in completed):
                    continue
                evaluation_window = _analysis_window(request, event_type)
                if evaluation_window is None:
                    continue
                grain = 900 if event_type == "ANOMALY_DETECTION" else 3600
                completed_window = bucket_evidence.requested_complete_window(
                    dependencies,
                    evaluation_window,
                    grain,
                )
                watermark = evaluation_window.end
                previous = analysis_watermarks.get(event_type)
                if previous is not None and watermark <= previous:
                    continue
                event = (
                    self._event(
                        request.dataset_version, event_type, watermark, self._forecast_model
                    )
                    if completed_window is not None and completed_window.end == watermark
                    else None
                )
                advancing.append((event_type, watermark, event))
            for event_type, watermark, event in sorted(advancing):
                previous = analysis_watermarks.get(event_type)
                if previous is not None and watermark <= previous:
                    continue
                lease.checkpoint()
                self._window_commits.commit_watermark_and_outboxes(
                    request.dataset_version,
                    _analysis_source(event_type),
                    watermark,
                    (event,) if event is not None else (),
                    expected_watermark=previous,
                    idempotency_key=(
                        f"sync-window:{request.dataset_version}:{_analysis_source(event_type)}:"
                        f"{int(watermark.timestamp() * 1000)}"
                    ),
                )
                analysis_watermarks[event_type] = watermark
                if event is not None:
                    new_events += 1
                lease.checkpoint()
            self._drain_pending(request.page_size)
            lease.fence()
            stage = (
                RunStage.SUCCEEDED
                if all(item.succeeded for item in sources.values())
                else RunStage.PARTIAL
            )
            return SyncResult(
                sources,
                analysis_watermarks,
                new_events,
                publication_error,
                stage,
                bucket_budget.observe(),
            )
        except Exception as error:
            publication_error = PersistedError.from_untrusted(
                str(error) or type(error).__name__
            ).message
            return SyncResult(
                locals().get("sources", {}),
                locals().get("analysis_watermarks", dict(request.analysis_watermarks)),
                locals().get("new_events", 0),
                publication_error,
                RunStage.PARTIAL,
                bucket_budget.observe() if bucket_budget is not None else None,
            )
        finally:
            if bucket_evidence is not None:
                bucket_evidence.close()
            if bucket_directory is not None:
                bucket_directory.cleanup()
            lease.close()


__all__ = [
    "Sync",
    "SyncRequest",
    "SyncResult",
    "SyncSourceResult",
]
