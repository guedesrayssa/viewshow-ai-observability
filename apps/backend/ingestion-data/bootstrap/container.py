"""Monta sob demanda somente as dependências exigidas pelo comando selecionado.

Papel no fluxo:
    Este módulo fica na borda de inicialização: interpreta configuração, seleciona capacidades e
    conecta os casos de uso aos adaptadores concretos.

Garantias e limites:
    Importar o módulo não deve iniciar conexões nem executar efeitos; recursos são criados
    somente para o comando solicitado.
"""

from __future__ import annotations

import base64
import hashlib
import uuid
from argparse import Namespace
from collections.abc import Callable, Mapping
from contextvars import ContextVar
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from types import MappingProxyType
from typing import Any, Literal, Protocol, cast

from bootstrap.config import ConfigurationError, Settings
from domain.run import RunPipeline
from ports.analysis_facts import AnalysisFactSink

type Factory = Callable[[], object]
type CommandHandler = Callable[[Namespace], object]

_mysql_retry_telemetry: ContextVar[tuple[object, str] | None] = ContextVar(
    "mysql_retry_telemetry", default=None
)


def _observe_mysql_retry(event: object) -> None:
    context = _mysql_retry_telemetry.get()
    dataset = getattr(event, "dataset", None)
    if context is None or not isinstance(dataset, str):
        return
    metrics, command = context
    try:
        from ports import MetricsPublisher

        if isinstance(metrics, MetricsPublisher):
            metrics.increment(
                "MySqlRetries",
                1,
                {"command": command, "source_mode": "snapshot", "dataset": dataset},
            )
    except BaseException:
        return


class SnapshotHeadClient(Protocol):
    """Define o contrato mínimo de snapshot head cliente usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def head_object(self, **kwargs: object) -> Mapping[str, object]:
        """Executa a etapa interna ``head_object`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...


@dataclass(frozen=True, slots=True)
class CommandRuntime:
    """Representa os dados de ``CommandRuntime`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        command: Entrada ``command``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        settings: Entrada ``settings``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        dependencies: Entrada ``dependencies``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.
        handler: Entrada ``handler``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
    """

    command: str
    settings: Settings
    dependencies: Mapping[str, object]
    handler: CommandHandler

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        object.__setattr__(self, "dependencies", MappingProxyType(dict(self.dependencies)))


class RuntimeContainer:
    """Agrupa o estado e as operações de ``RuntimeContainer`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(self, settings: Settings, factories: Mapping[str, Factory]) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            settings: Entrada ``settings``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            factories: Entrada ``factories``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self.settings = settings
        self._factories = MappingProxyType(dict(factories))
        self._instances: dict[str, object] = {}

    def get(self, capability: str) -> object:
        """Obtém o valor atualmente persistido para a identidade informada.

        Args:
            capability: Entrada ``capability``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.

        Returns:
            Valor ``object`` produzido pela operação após as validações.

        Raises:
            ConfigurationError: Se a operação não puder preservar as invariantes descritas.
        """
        if capability not in self._instances:
            try:
                factory = self._factories[capability]
            except KeyError as error:
                raise ConfigurationError(
                    f"no factory is configured for capability {capability!r}"
                ) from error
            self._instances[capability] = factory()
        return self._instances[capability]

    def resolve(self, command: str, *, no_write: bool = False) -> CommandRuntime:
        """Resolve somente as dependências exigidas pelo comando selecionado.

        Args:
            command: Entrada ``command``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            no_write: Entrada ``no_write``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``CommandRuntime`` produzido pela operação após as validações.
        """
        self.settings.require_for_command(command, no_write=no_write)
        capabilities = _capabilities(command, no_write=no_write)
        if (
            self.settings.analysis_fact_catalog_location is not None
            and command in _ANALYSIS_FACT_COMMANDS
        ):
            capabilities = (*capabilities, "analysis_facts")
        dependencies = {capability: self.get(capability) for capability in capabilities}
        if command == "sync":
            dependencies["live_reader_factory"] = lambda: self.get("live_reader")
        if command == "reprocess":
            dependencies["live_reader_factory"] = lambda: self.get("live_reader")
            dependencies["hot_sink_factory"] = lambda: self.get("hot_sink")
            dependencies["control_factory"] = lambda: self.get("control")
            dependencies["manifest_repository_factory"] = lambda: self.get("manifests")
        handler = _build_handler(command, self.settings, dependencies, no_write=no_write)
        from adapters.telemetry import observe_command

        return CommandRuntime(
            command,
            self.settings,
            dependencies,
            observe_command(
                command,
                self.settings.source_mode,
                handler,
                dependencies["telemetry"],
                outbox_backlog=dependencies.get("outbox"),
            ),
        )


# Comandos que reconstroem projeções a partir do arquivo e, por isso, também gravam os fatos.
_ANALYSIS_FACT_COMMANDS = frozenset({"backfill", "import-dump", "rebuild-projections"})


def _capabilities(command: str, *, no_write: bool) -> tuple[str, ...]:
    """Executa a etapa interna ``capabilities`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        command: Entrada ``command``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        no_write: Entrada ``no_write``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``tuple[str, ...]`` produzido pela operação após as validações.

    Raises:
        ConfigurationError: Se a operação não puder preservar as invariantes descritas.
    """
    if command == "validate" and no_write:
        return ("registry", "snapshot_verifier", "telemetry")
    if command == "validate":
        return ("registry", "snapshot_restorer", "snapshot_reader", "telemetry")
    if command == "backfill":
        return (
            "registry",
            "snapshot_restorer",
            "snapshot_reader",
            "snapshot_preparer",
            "control",
            "hot_sink",
            "manifests",
            "projections",
            "archive_partitions",
            "hot_expiration",
            "outbox",
            "archive_store",
            "canonical_sets",
            "parquet",
            "glue",
            "athena",
            "queue",
            "telemetry",
        )
    if command == "import-dump":
        return (
            *_capabilities("backfill", no_write=False),
            "import_jobs",
            "staging_downloader",
            "snapshot_promoter",
        )
    if command == "sync":
        return (
            "registry",
            "live_sync_configuration",
            "hot_sink",
            "control",
            "outbox",
            "manifests",
            "queue",
            "telemetry",
        )
    if command == "reprocess":
        return ("registry", "live_sync_configuration", "telemetry")
    if command == "rebuild-projections":
        return (
            "registry",
            "manifests",
            "projections",
            "archive_partitions",
            "archive_store",
            "canonical_sets",
            "telemetry",
        )
    if command == "publish-outbox":
        return ("outbox", "queue", "telemetry")
    if command == "export-incremental":
        return (
            "registry",
            "manifests",
            "incremental_export_source",
            "raw_batch_codec",
            "incremental_batch_store",
            "incremental_batch_queue",
            "outbox",
            "control",
            "telemetry",
        )
    if command == "ingest-incremental":
        return (
            "registry",
            "manifests",
            "incremental_batch_store",
            "incremental_batch_queue",
            "incremental_batch_repository",
            "hot_sink",
            "outbox",
            "queue",
            "control",
            "telemetry",
        )
    raise ConfigurationError(f"unsupported command: {command}")


def _restore_request(settings: Settings) -> Any:
    """Restaura requisição e confirma sua identidade antes de concluir.

    Args:
        settings: Entrada ``settings``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``Any`` produzido pela operação após as validações.
    """
    from ports import RestoreRequest

    return RestoreRequest(
        cast(str, settings.snapshot_bucket),
        cast(str, settings.snapshot_object_key),
        cast(str, settings.snapshot_object_version_id),
        cast(str, settings.snapshot_sha256),
    )


def _dataset_version(registry: object, dump_sha256: str) -> str:
    """Executa a etapa interna ``dataset_version`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        registry: Entrada ``registry``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        dump_sha256: Entrada ``dump_sha256``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    from contracts.registry import DatasetRegistry
    from domain.identity import dataset_version

    # A FORMA vem do contrato; o sha do dump vem da evidência operacional desta
    # execução (SNAPSHOT_SHA256). Reprocessar exige declarar o mesmo dump que
    # produziu a versão ativa — é isso que amarra o reprocess ao dataset certo.
    approved = cast(DatasetRegistry, registry).snapshot
    value = dataset_version(
        str(approved["sourceSystem"]),
        dump_sha256,
        str(approved["physicalContractVersion"]),
        str(approved["canonicalSchemaVersion"]),
    )
    if not isinstance(value, str):
        raise TypeError("dataset_version must return text")
    return value


def _utc_argument(value: object, name: str) -> datetime:
    """Executa a etapa interna ``utc_argument`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``datetime`` produzido pela operação após as validações.

    Raises:
        ConfigurationError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(value, str) or not value:
        raise ConfigurationError(f"{name} must be a non-empty ISO-8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ConfigurationError(f"{name} must be a valid ISO-8601 timestamp") from error
    if parsed.tzinfo is None:
        raise ConfigurationError(f"{name} must include a UTC offset")
    return parsed.astimezone(UTC)


def _telemetry_metrics(dependencies: Mapping[str, object]) -> object | None:
    """Executa a etapa interna ``telemetry_metrics`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        dependencies: Entrada ``dependencies``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.

    Returns:
        Valor ``object | None`` produzido pela operação após as validações.
    """
    telemetry = dependencies.get("telemetry")
    return telemetry.get("metrics") if isinstance(telemetry, Mapping) else None


def _validate_handler(
    settings: Settings, dependencies: Mapping[str, object], *, no_write: bool
) -> CommandHandler:
    """Valida handler contra as invariantes deste módulo.

    Args:
        settings: Entrada ``settings``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        dependencies: Entrada ``dependencies``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.
        no_write: Entrada ``no_write``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``CommandHandler`` produzido pela operação após as validações.
    """
    from application.validate import Validate, ValidateRequest
    from contracts.registry import DatasetRegistry
    from ports import RestoreResult, SourceReader

    registry = cast(DatasetRegistry, dependencies["registry"])
    if no_write:
        verifier = cast(Callable[[object], RestoreResult], dependencies["snapshot_verifier"])
    else:
        restorer = dependencies["snapshot_restorer"]
        metrics = _telemetry_metrics(dependencies)
        if metrics is not None:
            from adapters.telemetry.observed_ports import ObservedSnapshotRestorer
            from ports import MetricsPublisher, SnapshotRestorer

            if isinstance(metrics, MetricsPublisher) and isinstance(restorer, SnapshotRestorer):
                restorer = ObservedSnapshotRestorer(
                    restorer,
                    metrics,
                    command="validate",
                )

        def verifier(request: object) -> RestoreResult:
            """Executa a etapa interna ``verifier`` e devolve o resultado validado indicado pela
            assinatura.

            Args:
                request: Objeto de entrada já estruturado para o caso de uso.

            Returns:
                Valor ``RestoreResult`` produzido pela operação após as validações.

            Raises:
                ConfigurationError: Se a operação não puder preservar as invariantes descritas.
            """
            restore = getattr(restorer, "restore", None)
            if not callable(restore):
                raise ConfigurationError("snapshot restorer does not implement restore")
            return cast(
                RestoreResult,
                restore(request, idempotency_key=f"validate:{settings.snapshot_object_version_id}"),
            )

    service = Validate(registry, verifier)

    def handle(_arguments: Namespace) -> object:
        """Converte os argumentos do comando em uma execução do caso de uso.

        Args:
            _arguments: Entrada ``_arguments``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.

        Returns:
            Valor ``object`` produzido pela operação após as validações.

        Raises:
            RuntimeError: Se a operação não puder produzir um resultado confiável.
        """
        result = service.execute(ValidateRequest(_restore_request(settings), {}))
        if not no_write:
            reader = cast(SourceReader, dependencies["snapshot_reader"])
            metrics = _telemetry_metrics(dependencies)
            if metrics is not None:
                from adapters.telemetry.observed_ports import ObservedSourceReader
                from ports import MetricsPublisher

                if isinstance(metrics, MetricsPublisher):
                    reader = ObservedSourceReader(
                        reader,
                        metrics,
                        command="validate",
                        source_mode="snapshot",
                    )
            incompatible = tuple(
                descriptor.table
                for descriptor in registry
                if not reader.validate_schema(descriptor).is_compatible
            )
            if incompatible:
                raise RuntimeError(
                    "snapshot schema is incompatible for: " + ", ".join(incompatible)
                )
        return result

    return handle


def _publish_handler(settings: Settings, dependencies: Mapping[str, object]) -> CommandHandler:
    """Publica handler preservando idempotência e validação de resposta.

    Args:
        settings: Entrada ``settings``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        dependencies: Entrada ``dependencies``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.

    Returns:
        Valor ``CommandHandler`` produzido pela operação após as validações.
    """
    from application.publish_outbox import OutboxPublisher
    from ports import AnalysisRequestPublisher, OutboxRepository

    service = OutboxPublisher(
        cast(OutboxRepository, dependencies["outbox"]),
        cast(AnalysisRequestPublisher, dependencies["queue"]),
    )

    def handle(arguments: Namespace) -> object:
        """Converte os argumentos do comando em uma execução do caso de uso.

        Args:
            arguments: Entrada ``arguments``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``object`` produzido pela operação após as validações.

        Raises:
            ConfigurationError: Se a operação não puder preservar as invariantes descritas.
        """
        limit = getattr(arguments, "limit", None)
        if limit is None:
            limit = settings.outbox_publish_limit
        if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
            raise ConfigurationError("publish-outbox --limit must be a positive integer")
        return service.publish_pending(limit)

    return handle


def _backfill_handler(
    settings: Settings,
    dependencies: Mapping[str, object],
    *,
    telemetry_command: Literal["backfill", "import-dump"] = "backfill",
) -> CommandHandler:
    """Executa a etapa interna ``backfill_handler`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        settings: Entrada ``settings``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        dependencies: Entrada ``dependencies``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.

    Returns:
        Valor ``CommandHandler`` produzido pela operação após as validações.
    """
    from adapters.archive.parquet import PyArrowParquetEncoder, schema_fingerprint_for_descriptor
    from application.archive_partition import ArchivePartitionEncoder, ArchivePartitionPublisher
    from application.backfill import Backfill, BackfillRequest
    from application.publish_outbox import OutboxPublisher
    from application.read_canonical_set import ReadCanonicalSet
    from application.rebuild_projections import ProjectionService
    from contracts.registry import DatasetRegistry
    from ports import (
        AnalysisRequestPublisher,
        ArchiveObjectStore,
        ArchivePartitionRepository,
        AthenaValidator,
        CanonicalSetStore,
        CheckpointRepository,
        GlueCatalog,
        HotExpirationRepository,
        HotRecordSink,
        LeaseRepository,
        ManifestRepository,
        OutboxRepository,
        ParquetEncoder,
        ProjectionRepository,
        RunRepository,
        SnapshotPreparer,
        SnapshotRestorer,
        SourceReader,
        WindowCommitRepository,
    )

    registry = cast(DatasetRegistry, dependencies["registry"])
    control = dependencies["control"]
    outbox = dependencies["outbox"]
    restorer = cast(SnapshotRestorer, dependencies["snapshot_restorer"])
    reader = cast(SourceReader, dependencies["snapshot_reader"])
    snapshot_preparer = cast(SnapshotPreparer | None, dependencies["snapshot_preparer"])
    runs = cast(RunRepository, dependencies.get("runs", control))
    parquet = cast(ParquetEncoder, dependencies["parquet"])
    athena = cast(AthenaValidator, dependencies["athena"])
    archive_store = cast(ArchiveObjectStore, dependencies["archive_store"])
    archive_partitions = cast(ArchivePartitionRepository, dependencies["archive_partitions"])
    metrics = _telemetry_metrics(dependencies)
    disk_usage_reporter = None
    if metrics is not None:
        from adapters.telemetry.observed_ports import (
            ObservedAthenaValidator,
            ObservedParquetEncoder,
            ObservedRunRepository,
            ObservedSnapshotQueryPreparer,
            ObservedSnapshotRestorer,
            ObservedSourceReader,
        )
        from adapters.telemetry.runtime import BoundedDiskUsageReporter
        from ports import MetricsPublisher

        if isinstance(metrics, MetricsPublisher):
            disk_usage_reporter = BoundedDiskUsageReporter(
                metrics,
                command=telemetry_command,
                source_mode="snapshot",
            )
            restorer = ObservedSnapshotRestorer(restorer, metrics, command=telemetry_command)
            reader = ObservedSourceReader(
                reader,
                metrics,
                command=telemetry_command,
                source_mode="snapshot",
            )
            if snapshot_preparer is not None:
                snapshot_preparer = ObservedSnapshotQueryPreparer(
                    snapshot_preparer, metrics, command=telemetry_command
                )
            runs = ObservedRunRepository(runs, metrics, command=telemetry_command)
            parquet = ObservedParquetEncoder(parquet, metrics, command=telemetry_command)
            athena = ObservedAthenaValidator(athena, metrics, command=telemetry_command)

    def clock() -> datetime:
        """Executa a etapa interna ``clock`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``datetime`` produzido pela operação após as validações.
        """
        return datetime.now(UTC)

    service = Backfill(
        forecast_model=settings.analysis_forecast_model,
        registry=registry,
        restorer=restorer,
        reader_factory=lambda: reader,
        hot_sink=cast(HotRecordSink, dependencies["hot_sink"]),
        checkpoints=cast(CheckpointRepository, control),
        leases=cast(LeaseRepository, control),
        runs=runs,
        manifests=cast(ManifestRepository, dependencies["manifests"]),
        projections=ProjectionService(
            cast(ProjectionRepository, dependencies["projections"]),
            event_correlation_window_seconds=settings.event_correlation_window_seconds,
            fact_sink=cast(AnalysisFactSink | None, dependencies.get("analysis_facts")),
        ),
        archive_encoder=ArchivePartitionEncoder(parquet),
        archive_publisher=ArchivePartitionPublisher(
            archive_store,
            cast(GlueCatalog, dependencies["glue"]),
            athena,
            archive_partitions,
            cast(HotExpirationRepository, dependencies["hot_expiration"]),
            cast(str, settings.archive_bucket),
            clock,
            schema_fingerprint_for_descriptor,
        ),
        window_commits=cast(WindowCommitRepository, outbox),
        outbox_publisher=OutboxPublisher(
            cast(OutboxRepository, outbox),
            cast(AnalysisRequestPublisher, dependencies["queue"]),
        ),
        clock=clock,
        activity_reporter=cast(Any, dependencies.get("activity_reporter")),
        disk_usage_reporter=disk_usage_reporter,
        snapshot_preparer=snapshot_preparer,
        canonical_sets=cast(CanonicalSetStore, dependencies["canonical_sets"]),
        canonical_source_factory=lambda workspace: ReadCanonicalSet(
            registry,
            archive_partitions,
            cast(Any, archive_store),
            PyArrowParquetEncoder(),
            workspace,
        ),
    )

    def handle(arguments: Namespace) -> object:
        """Converte os argumentos do comando em uma execução do caso de uso.

        Args:
            arguments: Entrada ``arguments``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        settings.archive_workdir.mkdir(parents=True, exist_ok=True)
        token = _mysql_retry_telemetry.set((metrics, telemetry_command))
        try:
            return service.execute(
                BackfillRequest(
                    run_id=_runtime_run_id(arguments, "run"),
                    restore_request=_restore_request(settings),
                    snapshot_extracted_on=cast(date, settings.snapshot_extracted_on),
                    archive_workdir=settings.archive_workdir,
                    disk_budget_bytes=settings.ingestion_disk_budget_bytes,
                    page_size=settings.page_size,
                    lease_ttl_seconds=settings.lease_ttl_seconds,
                    outbox_limit=settings.outbox_publish_limit,
                    activate=settings.activate_candidate,
                    pipeline=settings.import_pipeline_version,
                    materialize_hot_records=settings.import_hot_materialization_enabled,
                )
            )
        finally:
            _mysql_retry_telemetry.reset(token)

    return handle


def _import_dump_handler(settings: Settings, dependencies: Mapping[str, object]) -> CommandHandler:
    from adapters.telemetry.import_progress import ImportProgressRunRepository
    from application.backfill import RunResult
    from application.import_dump import ImportDump, import_run_id
    from ports import ImportJobRepository, RunRepository, SnapshotPromoter, StagingDownloader
    from scripts.upload_snapshot import SnapshotUploadResult

    jobs = cast(ImportJobRepository, dependencies["import_jobs"])

    class Runner:
        def run(
            self,
            snapshot: SnapshotUploadResult,
            *,
            import_id: str,
            snapshot_extracted_on: date,
            activate: Literal[False],
            pipeline: RunPipeline,
            materialize_hot_records: bool,
        ) -> RunResult:
            if activate is not False:
                raise ConfigurationError("import-dump cannot activate a candidate")
            if pipeline is not settings.import_pipeline_version:
                raise ConfigurationError(
                    "import-dump pipeline does not match persisted reservation"
                )
            expected_hot_materialization = pipeline is RunPipeline.LEGACY_V1
            if materialize_hot_records is not expected_hot_materialization:
                raise ConfigurationError(
                    "import-dump hot materialization policy does not match persisted pipeline"
                )
            promoted_settings = replace(
                settings,
                source_mode="snapshot",
                snapshot_bucket=snapshot.bucket,
                snapshot_object_key=snapshot.key,
                snapshot_object_version_id=snapshot.version_id,
                snapshot_sha256=snapshot.sha256,
                snapshot_extracted_on=snapshot_extracted_on,
                activate_candidate=False,
                import_hot_materialization_enabled=expected_hot_materialization,
            )
            promoted_settings.require_for_command("backfill")
            progress = ImportProgressRunRepository(
                cast(RunRepository, dependencies["control"]),
                jobs,
                import_id,
            )
            run_dependencies = {
                **dependencies,
                "runs": progress,
                "activity_reporter": progress,
            }
            handler = _backfill_handler(
                promoted_settings, run_dependencies, telemetry_command="import-dump"
            )
            return cast(RunResult, handler(Namespace(run_id=import_run_id(import_id))))

    service = ImportDump(
        jobs,
        cast(StagingDownloader, dependencies["staging_downloader"]),
        cast(SnapshotPromoter, dependencies["snapshot_promoter"]),
        Runner(),
        workdir=settings.archive_workdir,
        disk_budget_bytes=settings.ingestion_disk_budget_bytes,
    )

    def handle(arguments: Namespace) -> object:
        return service.execute(arguments.import_id)

    return handle


def _sync_handler(settings: Settings, dependencies: Mapping[str, object]) -> CommandHandler:
    """Executa a etapa interna ``sync_handler`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        settings: Entrada ``settings``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        dependencies: Entrada ``dependencies``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.

    Returns:
        Valor ``CommandHandler`` produzido pela operação após as validações.
    """
    from application.publish_outbox import OutboxPublisher
    from application.sync import Sync, active_manifest_source_watermarks
    from application.sync_catchup import SyncCatchup, SyncCatchupRequest
    from contracts.registry import DatasetRegistry
    from domain.models import TimeWindow
    from ports import (
        AnalysisRequestPublisher,
        CheckpointRepository,
        HotRecordSink,
        LeaseRepository,
        LiveSyncConfiguration,
        ManifestRepository,
        OutboxRepository,
        SourceReader,
        WindowCommitRepository,
    )

    registry = cast(DatasetRegistry, dependencies["registry"])
    control = dependencies["control"]
    outbox = dependencies["outbox"]
    manifests = cast(ManifestRepository, dependencies["manifests"])
    reader_factory = cast(Callable[[], SourceReader], dependencies["live_reader_factory"])
    metrics = _telemetry_metrics(dependencies)

    def observed_reader_factory() -> SourceReader:
        """Executa a etapa interna ``observed_reader_factory`` e devolve o resultado validado
        indicado pela assinatura.

        Returns:
            Valor ``SourceReader`` produzido pela operação após as validações.
        """
        reader = reader_factory()
        if metrics is not None:
            from adapters.telemetry.observed_ports import ObservedSourceReader
            from ports import MetricsPublisher

            if isinstance(metrics, MetricsPublisher):
                return ObservedSourceReader(
                    reader,
                    metrics,
                    command="sync",
                    source_mode="live",
                )
        return reader

    service = Sync(
        registry=registry,
        reader_factory=observed_reader_factory,
        hot_sink=cast(HotRecordSink, dependencies["hot_sink"]),
        checkpoints=cast(CheckpointRepository, control),
        window_commits=cast(WindowCommitRepository, outbox),
        outbox_publisher=OutboxPublisher(
            cast(OutboxRepository, outbox),
            cast(AnalysisRequestPublisher, dependencies["queue"]),
        ),
        leases=cast(LeaseRepository, control),
        manifests=manifests,
        disk_budget_bytes=settings.ingestion_disk_budget_bytes,
        forecast_model=settings.analysis_forecast_model,
    )
    catchup = SyncCatchup(
        service, cast(LiveSyncConfiguration, dependencies["live_sync_configuration"])
    )

    def handle(arguments: Namespace) -> object:
        """Converte os argumentos do comando em uma execução do caso de uso.

        Args:
            arguments: Entrada ``arguments``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        active = manifests.get_active()
        live_descriptors = tuple(
            descriptor for descriptor in registry if descriptor.supports_live_window_sync
        )
        datasets = tuple(descriptor.table for descriptor in live_descriptors)
        manifest_watermarks = active_manifest_source_watermarks(
            active,
            registry=registry,
            source_dataset_names=datasets,
        )
        assert active is not None
        now = datetime.now(UTC)
        finalizable_at = now - timedelta(seconds=settings.sync_finalization_delay_seconds)
        end = finalizable_at.replace(
            minute=(finalizable_at.minute // 15) * 15,
            second=0,
            microsecond=0,
        )
        window = TimeWindow(end - timedelta(minutes=15), end, 900)
        source_grain_seconds = {
            descriptor.table: descriptor.grain_seconds for descriptor in live_descriptors
        }
        dataset_version = active.dataset_version
        source_watermarks = {
            dataset: (committed if committed is not None else manifest_watermarks[dataset])
            for dataset in datasets
            if (
                committed := cast(WindowCommitRepository, outbox).get_watermark(
                    dataset_version, f"source:{dataset}"
                )
            )
            is not None
            or dataset in manifest_watermarks
        }
        analysis_watermarks = {
            event_type: watermark
            for event_type in ("ANOMALY_DETECTION", "QOE_FORECAST")
            if (
                watermark := cast(WindowCommitRepository, outbox).get_watermark(
                    dataset_version, f"analysis:{event_type}"
                )
            )
            is not None
        }
        arguments._runtime_dataset_version = dataset_version
        arguments._runtime_window_start = window.start
        arguments._runtime_window_end = window.end
        return catchup.execute(
            SyncCatchupRequest(
                run_id=_runtime_run_id(arguments, "sync"),
                dataset_version=dataset_version,
                latest_window=window,
                dataset_names=datasets,
                page_size=settings.page_size,
                source_watermarks=source_watermarks,
                analysis_watermarks=analysis_watermarks,
                lease_ttl_seconds=settings.lease_ttl_seconds,
                max_windows=settings.sync_max_catchup_windows,
                source_grain_seconds=source_grain_seconds,
            )
        )

    return handle


def _reprocess_handler(settings: Settings, dependencies: Mapping[str, object]) -> CommandHandler:
    """Executa a etapa interna ``reprocess_handler`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        settings: Entrada ``settings``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        dependencies: Entrada ``dependencies``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.

    Returns:
        Valor ``CommandHandler`` produzido pela operação após as validações.
    """
    from application.reprocess import Reprocess, ReprocessRequest
    from contracts.registry import DatasetRegistry
    from domain.models import TimeWindow
    from ports import (
        HotRecordSink,
        LeaseRepository,
        LiveSyncConfiguration,
        ManifestRepository,
        SourceReader,
    )

    registry = cast(DatasetRegistry, dependencies["registry"])
    reader_factory = cast(Callable[[], SourceReader], dependencies["live_reader_factory"])
    hot_sink_factory = cast(Callable[[], HotRecordSink], dependencies["hot_sink_factory"])
    control_factory = cast(Callable[[], LeaseRepository], dependencies["control_factory"])
    manifest_repository_factory = cast(
        Callable[[], ManifestRepository], dependencies["manifest_repository_factory"]
    )
    metrics = _telemetry_metrics(dependencies)

    def observed_reader_factory() -> SourceReader:
        """Executa a etapa interna ``observed_reader_factory`` e devolve o resultado validado
        indicado pela assinatura.

        Returns:
            Valor ``SourceReader`` produzido pela operação após as validações.
        """
        reader = reader_factory()
        if metrics is not None:
            from adapters.telemetry.observed_ports import ObservedSourceReader
            from ports import MetricsPublisher

            if isinstance(metrics, MetricsPublisher):
                return ObservedSourceReader(
                    reader,
                    metrics,
                    command="reprocess",
                    source_mode="live",
                )
        return reader

    def handle(arguments: Namespace) -> object:
        """Converte os argumentos do comando em uma execução do caso de uso.

        Args:
            arguments: Entrada ``arguments``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``object`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        start = _utc_argument(getattr(arguments, "start", None), "--start")
        end = _utc_argument(getattr(arguments, "end", None), "--end")
        dataset = cast(str, arguments.dataset)
        return Reprocess(
            registry=registry,
            reader_factory=observed_reader_factory,
            hot_sink=hot_sink_factory,
            leases=control_factory,
            manifests=manifest_repository_factory,
            dataset_version_observer=lambda version: setattr(
                arguments, "_runtime_dataset_version", version
            ),
            live_sync_configuration=cast(
                LiveSyncConfiguration, dependencies["live_sync_configuration"]
            ),
        ).execute(
            ReprocessRequest(
                run_id=_runtime_run_id(arguments, "reprocess"),
                dataset_version=None,
                dataset=dataset,
                window=TimeWindow(start, end, max(1, int((end - start).total_seconds()))),
                page_size=settings.page_size,
                lease_ttl_seconds=settings.lease_ttl_seconds,
            )
        )

    return handle


def _runtime_run_id(arguments: Namespace, prefix: str) -> str:
    """Calcula ou valida o identificador de runtime execução.

    Args:
        arguments: Entrada ``arguments``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        prefix: Entrada ``prefix``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    explicit = getattr(arguments, "run_id", None)
    if prefix == "run" and isinstance(explicit, str) and explicit:
        return explicit
    value = getattr(arguments, "_runtime_run_id", None)
    return value if isinstance(value, str) and value else f"{prefix}-{uuid.uuid4().hex}"


def _rebuild_handler(settings: Settings, dependencies: Mapping[str, object]) -> CommandHandler:
    """Executa a etapa interna ``rebuild_handler`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        settings: Configuração validada que fornece o workspace temporário do rebuild.
        dependencies: Entrada ``dependencies``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.

    Returns:
        Valor ``CommandHandler`` produzido pela operação após as validações.
    """
    from adapters.archive.parquet import PyArrowParquetEncoder
    from application.read_canonical_set import ReadCanonicalSet
    from application.rebuild_projections import (
        ProjectionService,
        RebuildProjections,
        RebuildProjectionsRequest,
    )
    from contracts.registry import DatasetRegistry
    from ports import (
        ArchivePartitionRepository,
        CanonicalSetStore,
        ManifestRepository,
        ProjectionRepository,
    )

    registry = cast(DatasetRegistry, dependencies["registry"])

    service = RebuildProjections(
        ProjectionService(
            cast(ProjectionRepository, dependencies["projections"]),
            event_correlation_window_seconds=settings.event_correlation_window_seconds,
            fact_sink=cast(AnalysisFactSink | None, dependencies.get("analysis_facts")),
        ),
        cast(ManifestRepository, dependencies["manifests"]),
        canonical_sets=cast(CanonicalSetStore, dependencies["canonical_sets"]),
        canonical_source=ReadCanonicalSet(
            registry,
            cast(ArchivePartitionRepository, dependencies["archive_partitions"]),
            cast(Any, dependencies["archive_store"]),
            PyArrowParquetEncoder(),
            settings.archive_workdir,
        ),
    )

    def handle(arguments: Namespace) -> object:
        """Converte os argumentos do comando em uma execução do caso de uso.

        Args:
            arguments: Entrada ``arguments``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``object`` produzido pela operação após as validações.

        Raises:
            ConfigurationError: Se a operação não puder preservar as invariantes descritas.
        """
        dataset_version = getattr(arguments, "dataset_version", None)
        partition_keys = getattr(arguments, "partition_keys", None)
        raw_partitions = getattr(arguments, "archive_partitions", None)
        if not isinstance(dataset_version, str) or not dataset_version:
            raise ConfigurationError("rebuild-projections requires --dataset-version")
        if not isinstance(partition_keys, list) or not partition_keys:
            raise ConfigurationError("rebuild-projections requires --partition-key")
        if not isinstance(raw_partitions, list) or not raw_partitions:
            raise ConfigurationError("rebuild-projections requires --archive-partition")
        archive_partitions: dict[str, str] = {}
        for value in raw_partitions:
            if not isinstance(value, str) or "=" not in value:
                raise ConfigurationError("--archive-partition must use DATASET=CANONICAL_PARTITION")
            dataset, partition = value.split("=", 1)
            if not dataset or not partition or dataset in archive_partitions:
                raise ConfigurationError(
                    "--archive-partition must uniquely map DATASET=CANONICAL_PARTITION"
                )
            archive_partitions[dataset] = partition
        request = RebuildProjectionsRequest(
            dataset_version,
            tuple(partition_keys),
            archive_partitions,
        )
        return service.execute(request)

    return handle


def _export_incremental_handler(
    settings: Settings, dependencies: Mapping[str, object]
) -> CommandHandler:
    """Exports the next closed signal bucket window through the live-only capability set."""
    from application.export_incremental import ExportIncremental, ExportIncrementalRequest
    from application.sync import active_manifest_source_watermarks
    from contracts.registry import DatasetRegistry
    from domain.incremental_batches import IncrementalBatchDefinition
    from domain.models import TimeWindow
    from ports import (
        IncrementalBatchObjectStore,
        IncrementalBatchQueue,
        IncrementalExportSource,
        LeaseRepository,
        ManifestRepository,
        RawBatchCodec,
        WindowCommitRepository,
    )

    registry = cast(DatasetRegistry, dependencies["registry"])
    manifests = cast(ManifestRepository, dependencies["manifests"])
    commits = cast(WindowCommitRepository, dependencies["outbox"])

    def clock() -> datetime:
        telemetry = dependencies.get("telemetry")
        configured = telemetry.get("clock") if isinstance(telemetry, Mapping) else None
        value = configured() if callable(configured) else datetime.now(UTC)
        if not isinstance(value, datetime) or value.tzinfo is None:
            raise ConfigurationError("incremental export clock must return an aware UTC datetime")
        return value.astimezone(UTC)

    service = ExportIncremental(
        registry,
        manifests,
        cast(IncrementalExportSource, dependencies["incremental_export_source"]),
        cast(RawBatchCodec, dependencies["raw_batch_codec"]),
        cast(IncrementalBatchObjectStore, dependencies["incremental_batch_store"]),
        cast(IncrementalBatchQueue, dependencies["incremental_batch_queue"]),
        commits,
        cast(LeaseRepository, dependencies["control"]),
        workdir=settings.archive_workdir,
        clock=clock,
    )

    def handle(_arguments: Namespace) -> object:
        descriptor = registry.require("signal_bucket")
        if descriptor.grain_seconds is None:
            raise ConfigurationError("signal_bucket requires a bounded incremental grain")
        active = manifests.get_active()
        watermarks = active_manifest_source_watermarks(
            active,
            registry=registry,
            source_dataset_names=(descriptor.table,),
        )
        if active is None:
            raise ConfigurationError("ACTIVE manifest is required for incremental export")
        baseline = watermarks[descriptor.table]
        committed = commits.get_watermark(active.dataset_version, f"export:{descriptor.table}")
        start = committed if committed is not None else baseline
        window = TimeWindow(
            start,
            start + timedelta(seconds=descriptor.grain_seconds),
            descriptor.grain_seconds,
        )
        now = clock()
        closed_boundary = now.replace(second=0, microsecond=0) - timedelta(
            minutes=now.minute % (descriptor.grain_seconds // 60)
        )
        if window.end > closed_boundary:
            raise RuntimeError("no fully closed incremental export window is eligible")
        definition = IncrementalBatchDefinition(
            str(registry.snapshot["sourceSystem"]), descriptor.table, window, 0, "1.0"
        )
        _arguments._runtime_dataset_version = active.dataset_version
        _arguments.dataset = descriptor.table
        _arguments._runtime_window_start = window.start
        _arguments._runtime_window_end = window.end
        settings.archive_workdir.mkdir(parents=True, exist_ok=True)
        return service.execute(
            ExportIncrementalRequest(
                active.dataset_version,
                definition,
                page_size=settings.page_size,
                lease_ttl_seconds=settings.lease_ttl_seconds,
            )
        )

    return handle


def _ingest_incremental_handler(
    settings: Settings, dependencies: Mapping[str, object]
) -> CommandHandler:
    """Drains immutable batch references without constructing a MySQL live reader."""
    from application.ingest_incremental import IngestIncremental, IngestIncrementalResult
    from application.publish_outbox import OutboxPublisher
    from application.sync import Sync
    from contracts.registry import DatasetRegistry
    from ports import (
        AnalysisRequestPublisher,
        CheckpointRepository,
        HotRecordSink,
        IncrementalBatchObjectStore,
        IncrementalBatchQueue,
        IncrementalBatchRepository,
        LeaseRepository,
        ManifestRepository,
        MetricsPublisher,
        OutboxRepository,
        SourceReader,
        WindowCommitRepository,
    )

    registry = cast(DatasetRegistry, dependencies["registry"])
    manifests = cast(ManifestRepository, dependencies["manifests"])
    control = dependencies["control"]
    outbox = dependencies["outbox"]
    metrics = _telemetry_metrics(dependencies)
    if not isinstance(metrics, MetricsPublisher):
        raise ConfigurationError("incremental ingestion telemetry metrics are not configured")

    def sync_factory(reader: SourceReader) -> Sync:
        return Sync(
            registry=registry,
            reader_factory=lambda: reader,
            hot_sink=cast(HotRecordSink, dependencies["hot_sink"]),
            checkpoints=cast(CheckpointRepository, control),
            window_commits=cast(WindowCommitRepository, outbox),
            outbox_publisher=OutboxPublisher(
                cast(OutboxRepository, outbox),
                cast(AnalysisRequestPublisher, dependencies["queue"]),
            ),
            leases=cast(LeaseRepository, control),
            manifests=manifests,
            disk_budget_bytes=settings.ingestion_disk_budget_bytes,
            forecast_model=settings.analysis_forecast_model,
        )

    service = IngestIncremental(
        registry=registry,
        manifests=manifests,
        store=cast(IncrementalBatchObjectStore, dependencies["incremental_batch_store"]),
        queue=cast(IncrementalBatchQueue, dependencies["incremental_batch_queue"]),
        batches=cast(IncrementalBatchRepository, dependencies["incremental_batch_repository"]),
        sync_factory=sync_factory,
        metrics=metrics,
        page_size=settings.page_size,
    )

    def handle(arguments: Namespace) -> object:
        limit = getattr(arguments, "limit", None)
        if limit is None:
            limit = settings.incremental_ingest_limit
        if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
            raise ConfigurationError("ingest-incremental --limit must be a positive integer")
        active = manifests.get_active()
        if active is not None:
            arguments._runtime_dataset_version = active.dataset_version
        total = IngestIncrementalResult()
        remaining = limit
        while remaining:
            chunk = min(10, remaining)
            result = service.drain(chunk)
            total += result
            processed = result.completed + result.retryable + result.quarantined
            if processed < chunk:
                break
            remaining -= processed
        return total

    return handle


def _build_handler(
    command: str,
    settings: Settings,
    dependencies: Mapping[str, object],
    *,
    no_write: bool,
) -> CommandHandler:
    """Constrói handler a partir das entradas validadas.

    Args:
        command: Entrada ``command``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        settings: Entrada ``settings``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        dependencies: Entrada ``dependencies``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.
        no_write: Entrada ``no_write``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``CommandHandler`` produzido pela operação após as validações.

    Raises:
        ConfigurationError: Se a operação não puder preservar as invariantes descritas.
    """
    if command == "validate":
        return _validate_handler(settings, dependencies, no_write=no_write)
    if command == "backfill":
        return _backfill_handler(settings, dependencies)
    if command == "import-dump":
        return _import_dump_handler(settings, dependencies)
    if command == "sync":
        return _sync_handler(settings, dependencies)
    if command == "reprocess":
        return _reprocess_handler(settings, dependencies)
    if command == "rebuild-projections":
        return _rebuild_handler(settings, dependencies)
    if command == "publish-outbox":
        return _publish_handler(settings, dependencies)
    if command == "export-incremental":
        return _export_incremental_handler(settings, dependencies)
    if command == "ingest-incremental":
        return _ingest_incremental_handler(settings, dependencies)
    raise ConfigurationError(f"unsupported command: {command}")


class _S3SnapshotVerifier:
    """Agrupa o estado e as operações de ``_S3SnapshotVerifier`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(self, client: SnapshotHeadClient) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            client: Cliente externo que executa a operação de infraestrutura.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._client = client

    def __call__(self, request: object) -> object:
        """Executa a instância como uma função com os argumentos fornecidos.

        Args:
            request: Objeto de entrada já estruturado para o caso de uso.

        Returns:
            Valor ``object`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            RuntimeError: Se a operação não puder produzir um resultado confiável.
        """
        from ports import RestoreRequest, RestoreResult

        if not isinstance(request, RestoreRequest):
            raise TypeError("request must be a RestoreRequest")
        response = self._client.head_object(
            Bucket=request.bucket,
            Key=request.key,
            VersionId=request.version_id,
            ChecksumMode="ENABLED",
        )
        if not isinstance(response, Mapping):
            raise RuntimeError("S3 snapshot HEAD response must be a mapping")
        checksum = response.get("ChecksumSHA256")
        checksum_type = response.get("ChecksumType")
        metadata = response.get("Metadata")
        size = response.get("ContentLength")
        version = response.get("VersionId")
        if not isinstance(metadata, Mapping) or not isinstance(metadata.get("sha256"), str):
            raise RuntimeError("S3 snapshot HEAD has no full SHA-256 metadata")
        try:
            full_digest = bytes.fromhex(metadata["sha256"])
        except ValueError as error:
            raise RuntimeError("S3 snapshot HEAD has an invalid full SHA-256 metadata") from error
        if full_digest.hex() != metadata["sha256"] or full_digest.hex() != request.expected_sha256:
            raise RuntimeError("S3 snapshot HEAD differs from immutable snapshot identity")
        if checksum_type != "COMPOSITE":
            if not isinstance(checksum, str):
                raise RuntimeError("S3 snapshot HEAD has no SHA-256 checksum")
            try:
                digest = base64.b64decode(checksum, validate=True)
            except (TypeError, ValueError) as error:
                raise RuntimeError("S3 snapshot HEAD has an invalid SHA-256 checksum") from error
            if len(digest) != hashlib.sha256().digest_size or digest != full_digest:
                raise RuntimeError("S3 snapshot HEAD has an invalid SHA-256 checksum")
        if version is not None and version != request.version_id:
            raise RuntimeError("S3 snapshot HEAD differs from immutable snapshot identity")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise RuntimeError("S3 snapshot HEAD has an invalid content length")
        return RestoreResult(full_digest.hex(), size)


def _default_factories(settings: Settings) -> Mapping[str, Factory]:
    """Executa a etapa interna ``default_factories`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        settings: Entrada ``settings``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``Mapping[str, Factory]`` produzido pela operação após as validações.
    """
    clients: dict[str, object] = {}
    components: dict[str, object] = {}

    def aws(service: str) -> Any:
        """Executa a etapa interna ``aws`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            service: Entrada ``service``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Any`` produzido pela operação após as validações.
        """
        if service not in clients:
            import boto3  # type: ignore[import-untyped]

            clients[service] = boto3.client(service, region_name=settings.aws_region)
        return clients[service]

    def registry() -> Any:
        """Executa a etapa interna ``registry`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``Any`` produzido pela operação após as validações.
        """
        from contracts.registry import DatasetRegistry

        if "registry" not in components:
            components["registry"] = DatasetRegistry.load_argus_v2()
        return components["registry"]

    def mysql(live: bool) -> Any:
        """Executa a etapa interna ``mysql`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            live: Entrada ``live``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Valor ``Any`` produzido pela operação após as validações.
        """
        from adapters.sources.mysql_reader import MySqlConnectionSettings

        if live:
            return MySqlConnectionSettings(
                host=cast(str, settings.live_mysql_host),
                port=cast(int, settings.live_mysql_port),
                user=cast(str, settings.live_mysql_user),
                password=cast(str, settings.live_mysql_password),
                database=cast(str, settings.live_mysql_database),
                connect_timeout_seconds=settings.mysql_connect_timeout_seconds,
            )
        return MySqlConnectionSettings(
            host=cast(str, settings.mysql_host),
            port=settings.mysql_port,
            user=cast(str, settings.mysql_user),
            password=cast(str, settings.mysql_password),
            database=cast(str, settings.mysql_database),
            connect_timeout_seconds=settings.mysql_connect_timeout_seconds,
            read_timeout_seconds=settings.mysql_read_timeout_seconds,
            write_timeout_seconds=settings.mysql_write_timeout_seconds,
            ddl_timeout_seconds=settings.mysql_ddl_timeout_seconds,
            query_max_attempts=settings.mysql_query_max_attempts,
            query_retry_base_ms=settings.mysql_query_retry_base_ms,
            query_retry_max_ms=settings.mysql_query_retry_max_ms,
        )

    def snapshot_reader() -> object:
        """Executa a etapa interna ``snapshot_reader`` e devolve o resultado validado indicado
        pela assinatura.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        from adapters.sources.mysql_reader import MySqlSourceReader
        from adapters.sources.mysql_retry import MySqlRetryPolicy, RetryingMySqlSourceReader

        mysql_settings = mysql(False)
        return RetryingMySqlSourceReader(
            MySqlSourceReader(
                registry(),
                mysql_settings,
                force_cursor_index=settings.mysql_snapshot_prepare_enabled,
            ),
            MySqlRetryPolicy(
                max_attempts=mysql_settings.query_max_attempts,
                base_delay_ms=mysql_settings.query_retry_base_ms,
                max_delay_ms=mysql_settings.query_retry_max_ms,
            ),
            on_retry=_observe_mysql_retry,
        )

    def snapshot_preparer() -> object:
        if not settings.mysql_snapshot_prepare_enabled:
            return None
        from adapters.sources.mysql_snapshot_preparer import MySqlSnapshotPreparer

        return MySqlSnapshotPreparer(registry(), mysql(False))

    def live_reader() -> object:
        """Executa a etapa interna ``live_reader`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        from adapters.sources.mysql_live import MySqlLiveReader

        return MySqlLiveReader(registry(), mysql(True))

    def incremental_export_source() -> object:
        from adapters.sources.mysql_incremental import MySqlIncrementalExportSource

        return MySqlIncrementalExportSource(registry(), mysql(True))

    def raw_batch_codec() -> object:
        from adapters.incremental.parquet import RawParquetCodec

        return RawParquetCodec()

    def incremental_batch_store() -> object:
        from adapters.incremental.s3_batches import S3IncrementalBatchStore

        return S3IncrementalBatchStore(
            aws("s3"),
            cast(str, settings.incremental_batch_bucket),
            expected_bucket_owner=cast(str, settings.incremental_batch_expected_bucket_owner),
            registry=registry(),
        )

    def incremental_batch_queue() -> object:
        from adapters.messaging.incremental_sqs import SqsIncrementalBatchQueue

        return SqsIncrementalBatchQueue(aws("sqs"), cast(str, settings.incremental_batch_queue_url))

    def incremental_batch_repository() -> object:
        from adapters.dynamodb.incremental_batches import DynamoIncrementalBatchRepository

        return DynamoIncrementalBatchRepository(
            aws("dynamodb"), cast(str, settings.operational_table_name)
        )

    def snapshot_restorer() -> object:
        """Executa a etapa interna ``snapshot_restorer`` e devolve o resultado validado indicado
        pela assinatura.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        from adapters.sources.mysql_snapshot import MySqlSnapshotRestorer

        return MySqlSnapshotRestorer(
            aws("s3"),
            mysql(False),
        )

    def control() -> object:
        """Executa a etapa interna ``control`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        from adapters.dynamodb.control import DynamoControlRepository

        return DynamoControlRepository(aws("dynamodb"), cast(str, settings.operational_table_name))

    def live_sync_configuration() -> object:
        """Cria o leitor da configuração dinâmica na tabela operacional."""
        from adapters.dynamodb.live_sync import DynamoLiveSyncConfiguration

        return DynamoLiveSyncConfiguration(
            aws("dynamodb"), cast(str, settings.operational_table_name)
        )

    def hot_sink() -> object:
        """Executa a etapa interna ``hot_sink`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        from adapters.dynamodb.hot_records import DynamoHotRecordSink

        return DynamoHotRecordSink(aws("dynamodb"), cast(str, settings.operational_table_name))

    def manifests() -> object:
        """Executa a etapa interna ``manifests`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        from adapters.dynamodb.manifests import DynamoManifestRepository

        return DynamoManifestRepository(aws("dynamodb"), cast(str, settings.operational_table_name))

    def outbox() -> object:
        """Executa a etapa interna ``outbox`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        from adapters.dynamodb.outbox import DynamoOutboxRepository

        return DynamoOutboxRepository(aws("dynamodb"), cast(str, settings.operational_table_name))

    def analysis_facts() -> object:
        """Cria o destino dos fatos de série a partir do catálogo configurado para o worker.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        from adapters.analysis_catalog import load_fact_catalog
        from adapters.dynamodb.analysis_facts import DynamoAnalysisFactSink

        catalog = load_fact_catalog(
            cast(str, settings.analysis_fact_catalog_location),
            s3_client=aws("s3"),
            expected_bucket_owner=settings.archive_bucket_owner,
        )
        return DynamoAnalysisFactSink(
            aws("dynamodb"), cast(str, settings.operational_table_name), catalog
        )

    def projections() -> object:
        """Executa a etapa interna ``projections`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        from adapters.dynamodb.projections import DynamoProjectionRepository

        return DynamoProjectionRepository(
            aws("dynamodb"), cast(str, settings.operational_table_name)
        )

    def archive_partitions() -> object:
        """Executa a etapa interna ``archive_partitions`` e devolve o resultado validado
        indicado pela assinatura.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        from adapters.dynamodb.archive_partitions import DynamoArchivePartitionRepository

        return DynamoArchivePartitionRepository(
            aws("dynamodb"), cast(str, settings.operational_table_name)
        )

    def hot_expiration() -> object:
        """Executa a etapa interna ``hot_expiration`` e devolve o resultado validado indicado
        pela assinatura.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        from adapters.dynamodb.archive_partitions import DynamoHotExpirationRepository

        return DynamoHotExpirationRepository(
            aws("dynamodb"), cast(str, settings.operational_table_name)
        )

    def archive_store() -> object:
        """Executa a etapa interna ``archive_store`` e devolve o resultado validado indicado
        pela assinatura.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        from adapters.archive.s3 import S3ArchiveStore

        return S3ArchiveStore(
            aws("s3"),
            cast(str, settings.archive_bucket),
            expected_bucket_owner=cast(str, settings.archive_bucket_owner),
        )

    def canonical_sets() -> object:
        """Create the immutable canonical-set marker repository."""
        from adapters.archive.s3_canonical_sets import S3CanonicalSetStore

        return S3CanonicalSetStore(
            aws("s3"),
            cast(str, settings.archive_bucket),
            expected_bucket_owner=cast(str, settings.archive_bucket_owner),
        )

    def parquet() -> object:
        """Executa a etapa interna ``parquet`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        from adapters.archive.parquet import PyArrowParquetEncoder

        return PyArrowParquetEncoder()

    def glue() -> object:
        """Executa a etapa interna ``glue`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        from adapters.archive.glue import AwsGlueCatalog

        return AwsGlueCatalog(aws("glue"), cast(str, settings.glue_database))

    def athena() -> object:
        """Executa a etapa interna ``athena`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        from adapters.archive.athena import AwsAthenaValidator

        return AwsAthenaValidator(
            aws("athena"),
            database=cast(str, settings.glue_database),
            workgroup=cast(str, settings.athena_workgroup),
            output_location=cast(str, settings.athena_output_location),
        )

    def queue() -> object:
        """Executa a etapa interna ``queue`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        from adapters.messaging.sqs import SqsAnalysisRequestPublisher

        return SqsAnalysisRequestPublisher(aws("sqs"), cast(str, settings.analysis_queue_url))

    def telemetry() -> object:
        """Executa a etapa interna ``telemetry`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        from adapters.telemetry import CloudWatchMetrics, JsonLogger

        return MappingProxyType(
            {
                "logger": JsonLogger(
                    environment=settings.environment,
                    service_name=settings.log_service_name,
                    level=settings.log_level,
                ),
                "metrics": CloudWatchMetrics(namespace=settings.metrics_namespace),
            }
        )

    def import_jobs() -> object:
        from adapters.dynamodb.import_jobs import DynamoImportJobRepository

        return DynamoImportJobRepository(
            aws("dynamodb"), cast(str, settings.operational_table_name)
        )

    def staging_downloader() -> object:
        from adapters.sources.staging_download import S3StagingDownloader

        return S3StagingDownloader(
            aws("s3"), expected_bucket_owner=cast(str, settings.archive_bucket_owner)
        )

    def snapshot_promoter() -> object:
        from pathlib import Path

        from scripts.upload_snapshot import SnapshotUploadResult, upload_snapshot

        class Promoter:
            def promote(self, path: Path, *, snapshot_extracted_on: date) -> SnapshotUploadResult:
                return upload_snapshot(
                    aws("s3"),
                    path,
                    bucket=cast(str, settings.archive_bucket),
                    expected_bucket_owner=cast(str, settings.archive_bucket_owner),
                    snapshot_extracted_on=snapshot_extracted_on,
                    staging_directory=settings.archive_workdir,
                )

        return Promoter()

    return MappingProxyType(
        {
            "registry": registry,
            "analysis_facts": analysis_facts,
            "import_jobs": import_jobs,
            "staging_downloader": staging_downloader,
            "snapshot_promoter": snapshot_promoter,
            "snapshot_verifier": lambda: _S3SnapshotVerifier(cast(SnapshotHeadClient, aws("s3"))),
            "snapshot_restorer": snapshot_restorer,
            "snapshot_reader": snapshot_reader,
            "snapshot_preparer": snapshot_preparer,
            "live_reader": live_reader,
            "incremental_export_source": incremental_export_source,
            "raw_batch_codec": raw_batch_codec,
            "incremental_batch_store": incremental_batch_store,
            "incremental_batch_queue": incremental_batch_queue,
            "incremental_batch_repository": incremental_batch_repository,
            "control": control,
            "live_sync_configuration": live_sync_configuration,
            "hot_sink": hot_sink,
            "manifests": manifests,
            "projections": projections,
            "archive_partitions": archive_partitions,
            "hot_expiration": hot_expiration,
            "outbox": outbox,
            "archive_store": archive_store,
            "canonical_sets": canonical_sets,
            "parquet": parquet,
            "glue": glue,
            "athena": athena,
            "queue": queue,
            "telemetry": telemetry,
        }
    )


def build_container(
    settings: Settings, *, factories: Mapping[str, Factory] | None = None
) -> RuntimeContainer:
    """Constrói container a partir das entradas validadas.

    Args:
        settings: Entrada ``settings``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        factories: Entrada ``factories``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``RuntimeContainer`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    if not isinstance(settings, Settings):
        raise TypeError("settings must be Settings")
    selected = _default_factories(settings) if factories is None else factories
    return RuntimeContainer(settings, selected)


__all__ = ["CommandRuntime", "Factory", "RuntimeContainer", "build_container"]
