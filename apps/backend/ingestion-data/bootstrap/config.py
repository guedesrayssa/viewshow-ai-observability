"""Carrega e valida a configuração imutável utilizada por cada comando.

Papel no fluxo:
    Este módulo fica na borda de inicialização: interpreta configuração, seleciona capacidades e
    conecta os casos de uso aos adaptadores concretos.

Garantias e limites:
    Importar o módulo não deve iniciar conexões nem executar efeitos; recursos são criados
    somente para o comando solicitado.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

from domain.analysis import DEFAULT_FORECAST_MODEL, ForecastModel
from domain.disk_budget import (
    DEFAULT_INGESTION_DISK_BUDGET_BYTES,
    MAX_INGESTION_DISK_BUDGET_BYTES,
    SNAPSHOT_INGESTION_DISK_BUDGET_BYTES,
)
from domain.run import RunPipeline
from domain.snapshot_provenance import parse_snapshot_extracted_on
from domain.telemetry_identity import (
    METRICS_NAMESPACE,
    METRICS_NAMESPACE_PREFIX,
    SERVICE_NAME,
)

COMMANDS = frozenset(
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
SOURCE_COMMANDS = frozenset({"validate", "backfill", "sync", "reprocess"})
SOURCE_MODES = frozenset({"snapshot", "live"})
ENVIRONMENTS = frozenset({"local", "learner-lab", "production"})
LOG_LEVELS = frozenset({"debug", "info", "warn", "error", "fatal"})
DEFAULT_METRICS_NAMESPACE = METRICS_NAMESPACE
DEFAULT_SERVICE_NAME = SERVICE_NAME
INCREMENTAL_BATCH_PREFIX = "raw/argus/incremental/"

_REGION = re.compile(r"^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_BUCKET = re.compile(r"^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$")
_IP_ADDRESS = re.compile(r"^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$")
_GLUE_IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]{0,254}$")
# Prefixo derivado do deployment_namespace: é o que apps/fullstack/ingestion-variables.tf
# já exige dos overrides, e é o que os alarmes de CloudWatch observam.
_METRICS_NAMESPACE = re.compile(
    rf"^{re.escape(METRICS_NAMESPACE_PREFIX)}/[A-Za-z0-9._#:/-]{{1,246}}$"
)
_ATHENA_WORKGROUP = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


class ConfigurationError(ValueError):
    """Indica que ``ConfigurationError`` impediu a operação de continuar com segurança."""


def _optional_text(environment: Mapping[str, str], name: str) -> str | None:
    """Converte texto quando presente e preserva a ausência como ``None``.

    Args:
        environment: Mapeamento de variáveis de ambiente disponível para validação.
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``str | None`` produzido pela operação após as validações.

    Raises:
        ConfigurationError: Se a operação não puder preservar as invariantes descritas.
    """
    if name not in environment:
        return None
    value = environment[name]
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise ConfigurationError(f"{name} must be non-empty text without surrounding whitespace")
    return value


def _strict_bool(environment: Mapping[str, str], name: str, default: bool) -> bool:
    """Verifica a condição associada a strict bool.

    Args:
        environment: Mapeamento de variáveis de ambiente disponível para validação.
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        default: Entrada ``default``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.

    Raises:
        ConfigurationError: Se a operação não puder preservar as invariantes descritas.
    """
    raw = environment.get(name)
    if raw is None:
        return default
    if raw == "true":
        return True
    if raw == "false":
        return False
    raise ConfigurationError(f"{name} must be exactly 'true' or 'false'")


def _integer(
    environment: Mapping[str, str],
    name: str,
    default: int,
    *,
    maximum: int | None = None,
) -> int:
    """Executa a etapa interna ``integer`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        environment: Mapeamento de variáveis de ambiente disponível para validação.
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        default: Entrada ``default``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        maximum: Entrada ``maximum``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``int`` produzido pela operação após as validações.

    Raises:
        ConfigurationError: Se a operação não puder preservar as invariantes descritas.
    """
    raw = environment.get(name)
    if raw is None:
        return default
    if not isinstance(raw, str) or re.fullmatch(r"[1-9][0-9]*", raw) is None:
        raise ConfigurationError(f"{name} must be a positive base-10 integer")
    value = int(raw)
    if maximum is not None and value > maximum:
        raise ConfigurationError(f"{name} must be between 1 and {maximum}")
    return value


def _sync_finalization_delay_seconds(environment: Mapping[str, str]) -> int:
    """Executa a etapa interna ``sync_finalization_delay_seconds`` e devolve o resultado
    validado indicado pela assinatura.

    Args:
        environment: Mapeamento de variáveis de ambiente disponível para validação.

    Returns:
        Valor ``int`` produzido pela operação após as validações.

    Raises:
        ConfigurationError: Se a operação não puder preservar as invariantes descritas.
    """
    value = _integer(environment, "SYNC_FINALIZATION_DELAY_SECONDS", 900)
    if value < 900 or value % 900 != 0:
        raise ConfigurationError(
            "SYNC_FINALIZATION_DELAY_SECONDS must be at least 900 and a multiple of 900"
        )
    return value


def _optional_integer(
    environment: Mapping[str, str], name: str, *, maximum: int | None = None
) -> int | None:
    """Converte inteiro quando presente e preserva a ausência como ``None``.

    Args:
        environment: Mapeamento de variáveis de ambiente disponível para validação.
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        maximum: Entrada ``maximum``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``int | None`` produzido pela operação após as validações.
    """
    if name not in environment:
        return None
    return _integer(environment, name, 1, maximum=maximum)


def _bucket(value: str, name: str) -> str:
    """Executa a etapa interna ``bucket`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ConfigurationError: Se a operação não puder preservar as invariantes descritas.
    """
    if (
        _BUCKET.fullmatch(value) is None
        or ".." in value
        or _IP_ADDRESS.fullmatch(value) is not None
        or value.startswith(("xn--", "sthree-", "amzn-s3-demo-"))
        or value.endswith(("-s3alias", "--ol-s3", ".mrap", "--x-s3", "--table-s3"))
    ):
        raise ConfigurationError(f"{name} must be a canonical S3 bucket name")
    return value


def _queue_url(value: str) -> str:
    """Executa a etapa interna ``queue_url`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ConfigurationError: Se a operação não puder preservar as invariantes descritas.
    """
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path in {"", "/"}
        or parsed.query
        or parsed.fragment
        or any(character.isspace() for character in value)
    ):
        raise ConfigurationError(
            "ANALYSIS_QUEUE_URL must be an HTTPS URL without credentials, query, or fragment"
        )
    return value


def _optional_text_or_empty(environment: Mapping[str, str], name: str) -> str | None:
    """Lê uma variável opcional tratando a string vazia como ausente.

    O Terraform declara estas variáveis sempre, com valor vazio quando o recurso está desligado
    ("vazio desliga"), então uma variável presente e vazia não pode derrubar a inicialização.
    Qualquer outro valor continua passando pela validação estrita de ``_optional_text``.

    Args:
        environment: Variáveis de ambiente já normalizadas.
        name: Nome da variável opcional.

    Returns:
        O texto validado, ou ``None`` quando a variável está ausente ou vazia.

    Raises:
        ConfigurationError: Se o valor não estiver vazio e violar ``_optional_text``.
    """
    if environment.get(name) == "":
        return None
    return _optional_text(environment, name)


def _analysis_fact_catalog_location(value: str) -> str:
    """Valida a localização do catálogo de séries que a ingestão materializa para o worker.

    Args:
        value: ``s3://bucket/chave`` ou caminho absoluto do JSON do catálogo.

    Returns:
        A própria localização, quando válida.

    Raises:
        ConfigurationError: Se a localização não for uma URI S3 nem um caminho absoluto.
    """
    if value.startswith("s3://"):
        bucket, _, key = value[len("s3://") :].partition("/")
        _bucket(bucket, "ANALYSIS_FACT_CATALOG_LOCATION")
        if not key or any(character.isspace() for character in key):
            raise ConfigurationError("ANALYSIS_FACT_CATALOG_LOCATION must name an S3 object key")
        return value
    if not Path(value).is_absolute():
        raise ConfigurationError(
            "ANALYSIS_FACT_CATALOG_LOCATION must be an s3:// URI or an absolute path"
        )
    return value


def _forecast_model(values: Mapping[str, str]) -> ForecastModel:
    """Lê a identidade do modelo de previsão declarada nos eventos ``QOE_FORECAST``.

    Args:
        values: Variáveis de ambiente já normalizadas.

    Returns:
        A identidade configurada ou a padrão quando nenhuma das duas variáveis existir.

    Raises:
        ConfigurationError: Se só uma das variáveis existir ou o valor for inválido.
    """
    name = _optional_text_or_empty(values, "ANALYSIS_FORECAST_MODEL_NAME")
    version = _optional_text_or_empty(values, "ANALYSIS_FORECAST_MODEL_VERSION")
    if name is None and version is None:
        return DEFAULT_FORECAST_MODEL
    if name is None or version is None:
        raise ConfigurationError(
            "ANALYSIS_FORECAST_MODEL_NAME and ANALYSIS_FORECAST_MODEL_VERSION must be set together"
        )
    try:
        return ForecastModel(name, version)
    except ValueError as error:
        raise ConfigurationError(f"forecast model identity is invalid: {error}") from error


def _incremental_queue_url(value: str) -> str:
    """Validates the dedicated FIFO queue used only for immutable batch references."""
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or not parsed.path.endswith(".fifo")
        or parsed.query
        or parsed.fragment
        or any(character.isspace() for character in value)
    ):
        raise ConfigurationError(
            "INCREMENTAL_BATCH_QUEUE_URL must be an HTTPS SQS FIFO URL without credentials, "
            "query, or fragment"
        )
    return value


def _snapshot_key(value: str) -> str:
    """Monta a chave de snapshot a partir de componentes validados.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ConfigurationError: Se a operação não puder preservar as invariantes descritas.
    """
    if (
        value.startswith("/")
        or "://" in value
        or "\\" in value
        or len(value.encode("utf-8")) > 1_024
        or any(ord(character) < 32 for character in value)
    ):
        raise ConfigurationError("SNAPSHOT_OBJECT_KEY must be an S3 object key, not a URL")
    return value


def _athena_output_location(value: str) -> str:
    """Executa a etapa interna ``athena_output_location`` e devolve o resultado validado
    indicado pela assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ConfigurationError: Se a operação não puder preservar as invariantes descritas.
    """
    parsed = urlsplit(value)
    if (
        parsed.scheme != "s3"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path in {"", "/"}
        or not parsed.path.endswith("/")
        or parsed.query
        or parsed.fragment
    ):
        raise ConfigurationError(
            "ATHENA_OUTPUT_LOCATION must be a canonical S3 bucket prefix ending in slash"
        )
    _bucket(parsed.netloc, "ATHENA_OUTPUT_LOCATION")
    return value


def _writable_workdir(path: Path) -> Path:
    """Executa a etapa interna ``writable_workdir`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        path: Caminho local do artefato lido ou produzido.

    Returns:
        Valor ``Path`` produzido pela operação após as validações.

    Raises:
        ConfigurationError: Se a operação não puder preservar as invariantes descritas.
    """
    probe = path
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    if not probe.is_dir() or not os.access(probe, os.W_OK | os.X_OK):
        raise ConfigurationError(
            "ARCHIVE_WORKDIR must be a directory beneath a writable existing parent"
        )
    return path


@dataclass(frozen=True, slots=True)
class Settings:
    """Representa os dados de ``Settings`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        environment: Mapeamento de variáveis de ambiente disponível para validação.
        aws_region: Entrada ``aws_region``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        source_mode: Entrada ``source_mode``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        live_sync_enabled: Gate de implantação usado somente pela exportação incremental.
        operational_table_name: Nome validado do recurso, campo ou operação correspondente.
        metrics_namespace: Entrada ``metrics_namespace``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        log_level: Entrada ``log_level``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        log_service_name: Nome validado do recurso, campo ou operação correspondente.
        run_ttl_seconds: Duração ou prazo expresso em segundos.
        page_size: Entrada ``page_size``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        sync_max_catchup_windows: Entrada ``sync_max_catchup_windows``; a forma aceita é
        definida pela anotação de tipo e validada antes do uso.
        sync_finalization_delay_seconds: Duração ou prazo expresso em segundos.
        lease_ttl_seconds: Duração ou prazo expresso em segundos.
        outbox_publish_limit: Quantidade máxima de itens permitida nesta operação.
        activate_candidate: Entrada ``activate_candidate``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        archive_workdir: Diretório de trabalho pertencente à execução atual.
        ingestion_disk_budget_bytes: Quantidade de bytes usada como tamanho ou limite.
        snapshot_bucket: Entrada ``snapshot_bucket``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        snapshot_object_key: Chave usada para identificar, consultar ou persistir o recurso.
        snapshot_object_version_id: Identificador estável da entidade ou operação
        correspondente.
        snapshot_sha256: Entrada ``snapshot_sha256``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        snapshot_extracted_on: Entrada ``snapshot_extracted_on``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        mysql_host: Entrada ``mysql_host``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        mysql_port: Entrada ``mysql_port``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        mysql_user: Entrada ``mysql_user``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        mysql_password: Entrada ``mysql_password``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        mysql_database: Entrada ``mysql_database``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        mysql_connect_timeout_seconds: Duração ou prazo expresso em segundos.
        live_mysql_host: Entrada ``live_mysql_host``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        live_mysql_port: Entrada ``live_mysql_port``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        live_mysql_user: Entrada ``live_mysql_user``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        live_mysql_password: Entrada ``live_mysql_password``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        live_mysql_database: Entrada ``live_mysql_database``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        archive_bucket: Entrada ``archive_bucket``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        glue_database: Entrada ``glue_database``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        athena_workgroup: Entrada ``athena_workgroup``; a forma aceita é definida pela anotação
        de tipo e validada antes do uso.
        athena_output_location: Entrada ``athena_output_location``; a forma aceita é definida
        pela anotação de tipo e validada antes do uso.
        analysis_queue_url: URL validada do serviço ou recurso externo.
        analysis_fact_catalog_location: Catálogo de séries do worker; quando definido, a
        ingestão grava os fatos dessas séries junto das projeções.
        analysis_forecast_model: Identidade do modelo declarada nos eventos ``QOE_FORECAST``.
    """

    environment: str
    aws_region: str
    source_mode: str | None
    live_sync_enabled: bool
    operational_table_name: str | None
    metrics_namespace: str
    log_level: str
    log_service_name: str
    run_ttl_seconds: int
    page_size: int
    sync_max_catchup_windows: int
    sync_finalization_delay_seconds: int
    lease_ttl_seconds: int
    outbox_publish_limit: int
    activate_candidate: bool
    archive_workdir: Path
    ingestion_disk_budget_bytes: int
    snapshot_bucket: str | None
    snapshot_object_key: str | None
    snapshot_object_version_id: str | None
    snapshot_sha256: str | None
    snapshot_extracted_on: date | None
    mysql_host: str | None
    mysql_port: int
    mysql_user: str | None
    mysql_password: str | None = field(repr=False)
    import_pipeline_version: RunPipeline = RunPipeline.LEGACY_V1
    import_hot_materialization_enabled: bool = False
    mysql_database: str | None = None
    mysql_connect_timeout_seconds: int = 10
    mysql_read_timeout_seconds: int = 300
    mysql_write_timeout_seconds: int = 300
    mysql_ddl_timeout_seconds: int = 1_800
    mysql_query_max_attempts: int = 4
    mysql_query_retry_base_ms: int = 250
    mysql_query_retry_max_ms: int = 4_000
    mysql_snapshot_prepare_enabled: bool = False
    live_mysql_host: str | None = None
    live_mysql_port: int | None = None
    live_mysql_user: str | None = None
    live_mysql_password: str | None = field(default=None, repr=False)
    live_mysql_database: str | None = None
    archive_bucket: str | None = None
    archive_bucket_owner: str | None = None
    glue_database: str | None = None
    athena_workgroup: str | None = None
    athena_output_location: str | None = None
    analysis_queue_url: str | None = None
    analysis_fact_catalog_location: str | None = None
    analysis_forecast_model: ForecastModel = DEFAULT_FORECAST_MODEL
    incremental_batch_bucket: str | None = None
    incremental_batch_queue_url: str | None = None
    incremental_batch_expected_bucket_owner: str | None = None
    incremental_batch_prefix: str = INCREMENTAL_BATCH_PREFIX
    incremental_ingest_limit: int = 100
    event_correlation_window_seconds: int = 18_000

    def __post_init__(self) -> None:
        """Rejects a divergent prefix because the immutable raw adapter owns this fixed layout."""
        if self.incremental_batch_prefix != INCREMENTAL_BATCH_PREFIX:
            raise ConfigurationError("INCREMENTAL_BATCH_PREFIX is fixed by the raw batch contract")

    @classmethod
    def from_env(
        cls,
        environ: Mapping[str, str] | None = None,
        *,
        command: str | None = None,
        no_write: bool = False,
    ) -> Settings:
        """Cria a instância a partir de env previamente validado.

        Args:
            environ: Entrada ``environ``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            command: Entrada ``command``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            no_write: Entrada ``no_write``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Settings`` produzido pela operação após as validações.

        Raises:
            ConfigurationError: Se a operação não puder preservar as invariantes descritas.
        """
        values = os.environ if environ is None else environ
        if command is not None and command not in COMMANDS:
            raise ConfigurationError(f"unsupported command: {command}")
        if no_write and command != "validate":
            raise ConfigurationError("--no-write is supported only by validate")

        runtime_environment = values.get("INGESTION_ENVIRONMENT", "local")
        if runtime_environment not in ENVIRONMENTS:
            raise ConfigurationError(
                "INGESTION_ENVIRONMENT must be local, learner-lab, or production"
            )
        region = _optional_text(values, "AWS_REGION")
        if region is None:
            if runtime_environment == "production":
                raise ConfigurationError("AWS_REGION is required in production")
            region = "us-east-1"
        if _REGION.fullmatch(region) is None:
            raise ConfigurationError("AWS_REGION must be a valid AWS region")

        source_mode = _optional_text(values, "ARGUS_SOURCE_MODE")
        if source_mode is not None and source_mode not in SOURCE_MODES:
            raise ConfigurationError("ARGUS_SOURCE_MODE must be snapshot or live")
        live_sync_enabled = _strict_bool(values, "LIVE_SYNC_ENABLED", False)
        raw_import_pipeline = values.get("IMPORT_PIPELINE_VERSION", RunPipeline.LEGACY_V1.value)
        try:
            import_pipeline_version = RunPipeline(raw_import_pipeline)
        except (TypeError, ValueError):
            raise ConfigurationError(
                "IMPORT_PIPELINE_VERSION must be legacy-v1 or canonical-v2"
            ) from None
        import_hot_materialization_enabled = _strict_bool(
            values, "IMPORT_HOT_MATERIALIZATION_ENABLED", False
        )
        if command == "import-dump" and import_pipeline_version is RunPipeline.LEGACY_V1:
            import_hot_materialization_enabled = True

        namespace = values.get("METRICS_NAMESPACE", DEFAULT_METRICS_NAMESPACE)
        if not isinstance(namespace, str) or _METRICS_NAMESPACE.fullmatch(namespace) is None:
            raise ConfigurationError(
                f"METRICS_NAMESPACE must live under {METRICS_NAMESPACE_PREFIX}/ "
                "and stay within the 255 character CloudWatch limit"
            )
        level = values.get("LOG_LEVEL", "info")
        if level not in LOG_LEVELS:
            raise ConfigurationError("LOG_LEVEL must be debug, info, warn, error, or fatal")
        service = values.get("LOG_SERVICE_NAME", DEFAULT_SERVICE_NAME)
        if service != DEFAULT_SERVICE_NAME:
            raise ConfigurationError(f"LOG_SERVICE_NAME must be {DEFAULT_SERVICE_NAME}")

        workdir_raw = values.get("ARCHIVE_WORKDIR", "/tmp/ingestion")
        workdir = Path(workdir_raw)
        if not workdir.is_absolute():
            raise ConfigurationError("ARCHIVE_WORKDIR must be an absolute path")
        _writable_workdir(workdir)

        snapshot_bucket = _optional_text(values, "SNAPSHOT_BUCKET")
        if snapshot_bucket is not None:
            _bucket(snapshot_bucket, "SNAPSHOT_BUCKET")
        archive_bucket = _optional_text(values, "ARCHIVE_BUCKET")
        if archive_bucket is not None:
            _bucket(archive_bucket, "ARCHIVE_BUCKET")
        archive_bucket_owner = _optional_text(values, "ARCHIVE_BUCKET_OWNER")
        if (
            archive_bucket_owner is not None
            and re.fullmatch(r"[0-9]{12}", archive_bucket_owner) is None
        ):
            raise ConfigurationError("ARCHIVE_BUCKET_OWNER must be a 12 digit account identifier")
        snapshot_sha = _optional_text(values, "SNAPSHOT_SHA256")
        if snapshot_sha is not None and _SHA256.fullmatch(snapshot_sha) is None:
            raise ConfigurationError("SNAPSHOT_SHA256 must be 64 lowercase hexadecimal characters")
        snapshot_version = _optional_text(values, "SNAPSHOT_OBJECT_VERSION_ID")
        if snapshot_version is not None and snapshot_version.lower() == "null":
            raise ConfigurationError("SNAPSHOT_OBJECT_VERSION_ID must identify a concrete version")
        snapshot_extracted_on: date | None = None
        if (raw_extracted_on := _optional_text(values, "SNAPSHOT_EXTRACTED_ON")) is not None:
            try:
                snapshot_extracted_on = parse_snapshot_extracted_on(
                    raw_extracted_on, "SNAPSHOT_EXTRACTED_ON"
                )
            except ValueError as error:
                raise ConfigurationError(str(error)) from error

        glue_database = _optional_text(values, "GLUE_DATABASE")
        if glue_database is not None and _GLUE_IDENTIFIER.fullmatch(glue_database) is None:
            raise ConfigurationError("GLUE_DATABASE must be a safe identifier")
        workgroup = _optional_text(values, "ATHENA_WORKGROUP")
        if workgroup is not None and _ATHENA_WORKGROUP.fullmatch(workgroup) is None:
            raise ConfigurationError("ATHENA_WORKGROUP must be a safe workgroup name")
        output_location = _optional_text(values, "ATHENA_OUTPUT_LOCATION")
        if output_location is not None:
            _athena_output_location(output_location)
        queue_url = _optional_text(values, "ANALYSIS_QUEUE_URL")
        if queue_url is not None:
            _queue_url(queue_url)
        fact_catalog = _optional_text_or_empty(values, "ANALYSIS_FACT_CATALOG_LOCATION")
        if fact_catalog is not None:
            _analysis_fact_catalog_location(fact_catalog)
        incremental_bucket = _optional_text(values, "INCREMENTAL_BATCH_BUCKET")
        if incremental_bucket is not None:
            _bucket(incremental_bucket, "INCREMENTAL_BATCH_BUCKET")
        incremental_owner = _optional_text(values, "INCREMENTAL_BATCH_EXPECTED_BUCKET_OWNER")
        if incremental_owner is not None and re.fullmatch(r"[0-9]{12}", incremental_owner) is None:
            raise ConfigurationError(
                "INCREMENTAL_BATCH_EXPECTED_BUCKET_OWNER must be a 12 digit account identifier"
            )
        incremental_queue = _optional_text(values, "INCREMENTAL_BATCH_QUEUE_URL")
        if incremental_queue is not None:
            _incremental_queue_url(incremental_queue)

        settings = cls(
            environment=runtime_environment,
            aws_region=region,
            source_mode=source_mode,
            live_sync_enabled=live_sync_enabled,
            operational_table_name=_optional_text(values, "OPERATIONAL_TABLE_NAME"),
            metrics_namespace=namespace,
            log_level=level,
            log_service_name=service,
            run_ttl_seconds=_integer(values, "RUN_TTL_SECONDS", 7_776_000),
            page_size=_integer(values, "PAGE_SIZE", 500, maximum=10_000),
            sync_max_catchup_windows=_integer(values, "SYNC_MAX_CATCHUP_WINDOWS", 96),
            sync_finalization_delay_seconds=_sync_finalization_delay_seconds(values),
            lease_ttl_seconds=_integer(values, "LEASE_TTL_SECONDS", 300),
            outbox_publish_limit=_integer(values, "OUTBOX_PUBLISH_LIMIT", 100),
            activate_candidate=_strict_bool(values, "ACTIVATE_CANDIDATE", False),
            archive_workdir=workdir,
            ingestion_disk_budget_bytes=_integer(
                values,
                "INGESTION_DISK_BUDGET_BYTES",
                (
                    SNAPSHOT_INGESTION_DISK_BUDGET_BYTES
                    if command in {"backfill", "import-dump"}
                    else DEFAULT_INGESTION_DISK_BUDGET_BYTES
                ),
                maximum=MAX_INGESTION_DISK_BUDGET_BYTES,
            ),
            snapshot_bucket=snapshot_bucket,
            snapshot_object_key=(
                _snapshot_key(snapshot_key)
                if (snapshot_key := _optional_text(values, "SNAPSHOT_OBJECT_KEY")) is not None
                else None
            ),
            snapshot_object_version_id=snapshot_version,
            snapshot_sha256=snapshot_sha,
            snapshot_extracted_on=snapshot_extracted_on,
            mysql_host=_optional_text(values, "MYSQL_HOST"),
            mysql_port=_integer(values, "MYSQL_PORT", 3306, maximum=65_535),
            mysql_user=_optional_text(values, "MYSQL_USER"),
            mysql_password=_optional_text(values, "MYSQL_PASSWORD"),
            import_pipeline_version=import_pipeline_version,
            import_hot_materialization_enabled=import_hot_materialization_enabled,
            mysql_database=_optional_text(values, "MYSQL_DATABASE"),
            mysql_connect_timeout_seconds=_integer(values, "MYSQL_CONNECT_TIMEOUT_SECONDS", 10),
            mysql_read_timeout_seconds=_integer(
                values, "MYSQL_READ_TIMEOUT_SECONDS", 300, maximum=3_600
            ),
            mysql_write_timeout_seconds=_integer(
                values, "MYSQL_WRITE_TIMEOUT_SECONDS", 300, maximum=3_600
            ),
            mysql_ddl_timeout_seconds=_integer(
                values, "MYSQL_DDL_TIMEOUT_SECONDS", 1_800, maximum=7_200
            ),
            mysql_query_max_attempts=_integer(values, "MYSQL_QUERY_MAX_ATTEMPTS", 4, maximum=8),
            mysql_query_retry_base_ms=_integer(values, "MYSQL_QUERY_RETRY_BASE_MS", 250),
            mysql_query_retry_max_ms=_integer(values, "MYSQL_QUERY_RETRY_MAX_MS", 4_000),
            mysql_snapshot_prepare_enabled=_strict_bool(
                values, "MYSQL_SNAPSHOT_PREPARE_ENABLED", False
            ),
            live_mysql_host=_optional_text(values, "LIVE_MYSQL_HOST"),
            live_mysql_port=_optional_integer(values, "LIVE_MYSQL_PORT", maximum=65_535),
            live_mysql_user=_optional_text(values, "LIVE_MYSQL_USER"),
            live_mysql_password=_optional_text(values, "LIVE_MYSQL_PASSWORD"),
            live_mysql_database=_optional_text(values, "LIVE_MYSQL_DATABASE"),
            archive_bucket=archive_bucket,
            archive_bucket_owner=archive_bucket_owner,
            glue_database=glue_database,
            athena_workgroup=workgroup,
            athena_output_location=output_location,
            analysis_queue_url=queue_url,
            analysis_fact_catalog_location=fact_catalog,
            analysis_forecast_model=_forecast_model(values),
            incremental_batch_bucket=incremental_bucket,
            incremental_batch_queue_url=incremental_queue,
            incremental_batch_expected_bucket_owner=incremental_owner,
            incremental_ingest_limit=_integer(values, "INCREMENTAL_INGEST_LIMIT", 100),
            event_correlation_window_seconds=_integer(
                values,
                "ARGUS_EVENT_CORRELATION_WINDOW_SECONDS",
                18_000,
                maximum=18_000,
            ),
        )
        if settings.mysql_query_retry_base_ms > settings.mysql_query_retry_max_ms:
            raise ConfigurationError(
                "MYSQL_QUERY_RETRY_BASE_MS must not exceed MYSQL_QUERY_RETRY_MAX_MS"
            )
        if command is None and source_mode is not None:
            settings._require_selected_source()
        if command is not None:
            settings.require_for_command(command, no_write=no_write)
        return settings

    def _require(self, *names: str) -> None:
        """Valida e devolve a entrada, rejeitando entradas fora do contrato.

        Args:
            names: Entrada ``names``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ConfigurationError: Se a operação não puder preservar as invariantes descritas.
        """
        for name in names:
            if getattr(self, name) is None:
                raise ConfigurationError(f"{name.upper()} is required")

    def _require_selected_source(self, *, metadata_only: bool = False) -> None:
        """Valida e devolve selected fonte, rejeitando entradas fora do contrato.

        Args:
            metadata_only: Entrada ``metadata_only``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ConfigurationError: Se a operação não puder preservar as invariantes descritas.
        """
        if self.source_mode is None:
            raise ConfigurationError("ARGUS_SOURCE_MODE is required")
        if self.source_mode == "snapshot":
            self._require(
                "snapshot_bucket",
                "snapshot_object_key",
                "snapshot_object_version_id",
                "snapshot_sha256",
                "snapshot_extracted_on",
            )
            if not metadata_only:
                return
        elif self.source_mode == "live":
            self._require(
                "live_mysql_host",
                "live_mysql_port",
                "live_mysql_user",
                "live_mysql_password",
                "live_mysql_database",
            )

    def require_for_command(self, command: str, *, no_write: bool = False) -> None:
        """Valida e devolve for comando, rejeitando entradas fora do contrato.

        Args:
            command: Entrada ``command``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            no_write: Entrada ``no_write``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ConfigurationError: Se a operação não puder preservar as invariantes descritas.
        """
        if command not in COMMANDS:
            raise ConfigurationError(f"unsupported command: {command}")
        if no_write and command != "validate":
            raise ConfigurationError("--no-write is supported only by validate")
        if command == "reprocess" and self.source_mode != "live":
            raise ConfigurationError("reprocess requires ARGUS_SOURCE_MODE=live")
        if command in SOURCE_COMMANDS:
            self._require_selected_source(metadata_only=command == "validate" and no_write)
        if command == "validate" and self.source_mode != "snapshot":
            raise ConfigurationError("validate requires ARGUS_SOURCE_MODE=snapshot")
        if command == "backfill" and self.source_mode != "snapshot":
            raise ConfigurationError("backfill requires ARGUS_SOURCE_MODE=snapshot")
        if command == "import-dump":
            if self.source_mode not in (None, "snapshot"):
                raise ConfigurationError("import-dump requires snapshot source mode")
            self._require(
                "mysql_host",
                "mysql_user",
                "mysql_password",
                "mysql_database",
                "archive_bucket_owner",
            )
            if (
                self.import_pipeline_version is RunPipeline.CANONICAL_V2
                and self.import_hot_materialization_enabled
            ):
                raise ConfigurationError(
                    "IMPORT_HOT_MATERIALIZATION_ENABLED must be false for canonical-v2 import-dump"
                )
        if command == "sync" and self.source_mode != "live":
            raise ConfigurationError("sync requires ARGUS_SOURCE_MODE=live")
        if (command == "backfill" or (command == "validate" and not no_write)) and (
            self.source_mode == "snapshot"
        ):
            self._require("mysql_host", "mysql_user", "mysql_password", "mysql_database")
        if command in {
            "backfill",
            "import-dump",
            "sync",
            "reprocess",
            "rebuild-projections",
            "publish-outbox",
            "export-incremental",
            "ingest-incremental",
        }:
            self._require("operational_table_name")
            # A guarda é pelo SUFIXO porque o nome da tabela é derivado do
            # deployment_namespace (apps/fullstack/names.tf). Fixar o literal
            # antigo fazia a guarda barrar um nome que não existe mais e liberar
            # o único que existe. Sem policy IAM por recurso na stack, um valor
            # errado aqui escreve de verdade na tabela de curadoria.
            table = self.operational_table_name
            if table is not None and table.endswith("-golden-set"):
                raise ConfigurationError("OPERATIONAL_TABLE_NAME must not use a golden set table")
        if command == "backfill":
            self._require("archive_bucket_owner")
        if command == "rebuild-projections":
            self._require("archive_bucket", "archive_bucket_owner")
        if command in {"backfill", "import-dump"}:
            self._require(
                "archive_bucket",
                "glue_database",
                "athena_workgroup",
                "athena_output_location",
                "analysis_queue_url",
            )
        if command in {"sync", "publish-outbox", "ingest-incremental"}:
            self._require("analysis_queue_url")
        if command in {"export-incremental", "ingest-incremental"}:
            self._require(
                "operational_table_name",
                "incremental_batch_bucket",
                "incremental_batch_queue_url",
                "incremental_batch_expected_bucket_owner",
            )
        if command == "export-incremental":
            if self.source_mode != "live":
                raise ConfigurationError("export-incremental requires ARGUS_SOURCE_MODE=live")
            if not self.live_sync_enabled:
                raise ConfigurationError("export-incremental requires LIVE_SYNC_ENABLED=true")
            self._require(
                "live_mysql_host",
                "live_mysql_port",
                "live_mysql_user",
                "live_mysql_password",
                "live_mysql_database",
            )


__all__ = [
    "COMMANDS",
    "DEFAULT_METRICS_NAMESPACE",
    "DEFAULT_SERVICE_NAME",
    "INCREMENTAL_BATCH_PREFIX",
    "ConfigurationError",
    "Settings",
]
