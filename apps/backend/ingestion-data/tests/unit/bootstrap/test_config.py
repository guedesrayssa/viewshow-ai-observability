"""Verify validated runtime configuration and command-specific requirements."""

from __future__ import annotations

import hashlib
from argparse import Namespace
from collections.abc import Callable
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

import pytest

import bootstrap.container as container
from adapters.archive.parquet import PyArrowParquetEncoder
from application.ingest_incremental import IngestIncrementalResult
from bootstrap.config import ConfigurationError, Settings
from bootstrap.container import _dataset_version, build_container
from contracts.registry import DatasetRegistry
from domain.analysis import DEFAULT_FORECAST_MODEL, ForecastModel
from domain.disk_budget import FARGATE_EPHEMERAL_STORAGE_BYTES
from domain.identity import canonical_dataset_version
from domain.models import TimeWindow
from domain.run import RunPipeline, RunStage
from ports import ArchiveObject, CandidateManifest, ConditionalWriteError
from tests.fakes import (
    FakeArchivePartitionRepository,
    FakeCanonicalSetStore,
    FakeLiveSyncConfiguration,
    FakeManifestRepository,
    FakeMetricsPublisher,
    FakeProjectionRepository,
    valid_active_manifest,
)
from tests.unit.application.test_read_canonical_set import (
    PARTITION,
    _archive,
    _canonical_set,
    _record,
)

SNAPSHOT_ENV = {
    "ARGUS_SOURCE_MODE": "snapshot",
    "SNAPSHOT_BUCKET": "view-show-snapshots",
    "SNAPSHOT_OBJECT_KEY": "argus/argus_dump.sql.gz",
    "SNAPSHOT_OBJECT_VERSION_ID": "3LgW4",
    "SNAPSHOT_SHA256": "a" * 64,
    "SNAPSHOT_EXTRACTED_ON": "2026-08-31",
}

IMPORT_ENV = {
    "OPERATIONAL_TABLE_NAME": "imports-table",
    "ARCHIVE_BUCKET": "archive-test",
    "ARCHIVE_BUCKET_OWNER": "123456789012",
    "MYSQL_HOST": "localhost",
    "MYSQL_USER": "root",
    "MYSQL_PASSWORD": "test",
    "MYSQL_DATABASE": "argus",
    "GLUE_DATABASE": "argus",
    "ATHENA_WORKGROUP": "primary",
    "ATHENA_OUTPUT_LOCATION": "s3://archive-test/results/",
    "ANALYSIS_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/123456789012/analysis",
    "ARCHIVE_WORKDIR": "/tmp/ingestion",
    "ACTIVATE_CANDIDATE": "true",
}

REBUILD_ENV = {
    "OPERATIONAL_TABLE_NAME": "view-show-operacional",
    "ARCHIVE_BUCKET": "archive-test",
    "ARCHIVE_BUCKET_OWNER": "123456789012",
}


def test_event_correlation_window_defaults_to_five_hours_and_accepts_smaller_values() -> None:
    assert Settings.from_env({}).event_correlation_window_seconds == 18_000
    assert (
        Settings.from_env(
            {"ARGUS_EVENT_CORRELATION_WINDOW_SECONDS": "3600"}
        ).event_correlation_window_seconds
        == 3_600
    )


@pytest.mark.parametrize("raw", ["0", "-1", "1.5", "five", "18001"])
def test_event_correlation_window_rejects_invalid_or_over_limit_values(raw: str) -> None:
    with pytest.raises(ConfigurationError, match="ARGUS_EVENT_CORRELATION_WINDOW_SECONDS"):
        Settings.from_env({"ARGUS_EVENT_CORRELATION_WINDOW_SECONDS": raw})


def test_ingest_incremental_requires_bucket_queue_and_operational_table() -> None:
    """An incomplete batch route must be rejected before any AWS client can be built."""
    settings = Settings.from_env(
        {
            "OPERATIONAL_TABLE_NAME": "ingestion-state",
            "INCREMENTAL_BATCH_BUCKET": "incremental-batches",
            "INCREMENTAL_BATCH_EXPECTED_BUCKET_OWNER": "123456789012",
            "ANALYSIS_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/123/analysis",
        }
    )

    with pytest.raises(ConfigurationError, match="INCREMENTAL_BATCH_QUEUE_URL"):
        settings.require_for_command("ingest-incremental")


def test_ingest_incremental_requires_analysis_queue_before_client_resolution() -> None:
    """The outbox publisher must not defer its required SQS URL until factory execution."""
    settings = Settings.from_env(
        {
            "OPERATIONAL_TABLE_NAME": "ingestion-state",
            "INCREMENTAL_BATCH_BUCKET": "incremental-batches",
            "INCREMENTAL_BATCH_EXPECTED_BUCKET_OWNER": "123456789012",
            "INCREMENTAL_BATCH_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/123/incremental.fifo",
        }
    )

    with pytest.raises(ConfigurationError, match="ANALYSIS_QUEUE_URL"):
        settings.require_for_command("ingest-incremental")


def test_incremental_batch_prefix_is_fixed_even_when_settings_are_replaced() -> None:
    """The configuration must not grow a second prefix that can diverge from the raw adapter."""
    settings = Settings.from_env({})

    assert settings.incremental_batch_prefix == "raw/argus/incremental/"
    with pytest.raises(ConfigurationError, match="INCREMENTAL_BATCH_PREFIX"):
        replace(settings, incremental_batch_prefix="raw/other/")


def test_ingest_incremental_chunks_default_and_requested_limits_for_sqs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SQS receives no request above its API maximum even when the operator requests 20 or 100."""
    import application.ingest_incremental as incremental

    calls: list[int] = []

    class StrictSqsBoundedDrain:
        def __init__(self, **_dependencies: object) -> None:
            pass

        def drain(self, limit: int) -> IngestIncrementalResult:
            assert 1 <= limit <= 10
            calls.append(limit)
            return IngestIncrementalResult(completed=limit)

    monkeypatch.setattr(incremental, "IngestIncremental", StrictSqsBoundedDrain)
    settings = Settings.from_env(
        {
            "OPERATIONAL_TABLE_NAME": "ingestion-state",
            "INCREMENTAL_BATCH_BUCKET": "incremental-batches",
            "INCREMENTAL_BATCH_EXPECTED_BUCKET_OWNER": "123456789012",
            "INCREMENTAL_BATCH_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/123/incremental.fifo",
            "ANALYSIS_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/123/analysis",
            "INCREMENTAL_INGEST_LIMIT": "100",
        },
        command="ingest-incremental",
    )
    dependencies = {
        "registry": object(),
        "manifests": FakeManifestRepository(),
        "incremental_batch_store": object(),
        "incremental_batch_queue": object(),
        "incremental_batch_repository": object(),
        "hot_sink": object(),
        "outbox": object(),
        "queue": object(),
        "control": object(),
        "telemetry": {"metrics": FakeMetricsPublisher()},
    }
    handler = container._ingest_incremental_handler(settings, dependencies)

    assert handler(Namespace(limit=None)) == IngestIncrementalResult(completed=100)
    assert calls == [10] * 10
    calls.clear()
    assert handler(Namespace(limit=20)) == IngestIncrementalResult(completed=20)
    assert calls == [10, 10]


def test_incremental_commands_reject_the_golden_set_operational_table() -> None:
    """A batch command must not gain access to the curated golden-set table."""
    settings = Settings.from_env(
        {
            "OPERATIONAL_TABLE_NAME": "view-show-golden-set",
            "INCREMENTAL_BATCH_BUCKET": "incremental-batches",
            "INCREMENTAL_BATCH_EXPECTED_BUCKET_OWNER": "123456789012",
            "INCREMENTAL_BATCH_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/123/incremental.fifo",
            "ANALYSIS_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/123/analysis",
        }
    )

    with pytest.raises(ConfigurationError, match="golden set"):
        settings.require_for_command("ingest-incremental")


def test_ingest_incremental_never_resolves_the_live_export_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A future MySQL dependency in ingestion would violate the batch-only boundary."""
    settings = Settings.from_env(
        {
            "OPERATIONAL_TABLE_NAME": "ingestion-state",
            "INCREMENTAL_BATCH_BUCKET": "incremental-batches",
            "INCREMENTAL_BATCH_EXPECTED_BUCKET_OWNER": "123456789012",
            "INCREMENTAL_BATCH_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/123/incremental.fifo",
            "ANALYSIS_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/123/analysis",
        },
        command="ingest-incremental",
    )
    built: list[str] = []

    def selected_factory(name: str) -> Callable[[], object]:
        def create() -> object:
            built.append(name)
            return object()

        return create

    def forbidden_live_export_source() -> object:
        raise AssertionError("ingest-incremental must not construct a live MySQL export source")

    monkeypatch.setattr(container, "_ingest_incremental_handler", lambda *_: lambda _: None)
    capabilities = container._capabilities("ingest-incremental", no_write=False)
    runtime = build_container(
        settings,
        factories={
            **{name: selected_factory(name) for name in capabilities},
            "incremental_export_source": forbidden_live_export_source,
        },
    ).resolve("ingest-incremental")

    assert runtime.command == "ingest-incremental"
    assert built == list(capabilities)


def test_import_requires_infrastructure_without_initial_snapshot_identity():
    settings = Settings.from_env(
        {
            **IMPORT_ENV,
            "IMPORT_PIPELINE_VERSION": "canonical-v2",
            "IMPORT_HOT_MATERIALIZATION_ENABLED": "false",
        },
        command="import-dump",
    )
    assert settings.snapshot_sha256 is None
    assert settings.snapshot_object_version_id is None
    assert settings.archive_bucket_owner == "123456789012"
    assert settings.import_pipeline_version is RunPipeline.CANONICAL_V2
    assert settings.import_hot_materialization_enabled is False
    for field in (
        "OPERATIONAL_TABLE_NAME",
        "ARCHIVE_BUCKET",
        "ARCHIVE_BUCKET_OWNER",
        "MYSQL_HOST",
        "MYSQL_USER",
        "MYSQL_PASSWORD",
        "MYSQL_DATABASE",
        "GLUE_DATABASE",
        "ATHENA_WORKGROUP",
        "ATHENA_OUTPUT_LOCATION",
        "ANALYSIS_QUEUE_URL",
    ):
        with pytest.raises(ConfigurationError, match=field):
            Settings.from_env(
                {
                    **{key: value for key, value in IMPORT_ENV.items() if key != field},
                    "IMPORT_PIPELINE_VERSION": "canonical-v2",
                    "IMPORT_HOT_MATERIALIZATION_ENABLED": "false",
                },
                command="import-dump",
            )


def test_import_pipeline_is_closed_and_canonical_never_materializes_hot_inline(tmp_path) -> None:
    with pytest.raises(ConfigurationError, match="IMPORT_PIPELINE_VERSION"):
        Settings.from_env(
            {**IMPORT_ENV, "IMPORT_PIPELINE_VERSION": "future-v3"},
            command="import-dump",
        )

    with pytest.raises(ConfigurationError, match="IMPORT_HOT_MATERIALIZATION_ENABLED"):
        Settings.from_env(
            {
                **IMPORT_ENV,
                "ARCHIVE_WORKDIR": str(tmp_path / "unused-workdir"),
                "IMPORT_PIPELINE_VERSION": "canonical-v2",
                "IMPORT_HOT_MATERIALIZATION_ENABLED": "true",
            },
            command="import-dump",
        )
    assert not (tmp_path / "unused-workdir").exists()


def test_legacy_import_normalizes_canonical_rollout_flag_before_work_starts() -> None:
    settings = Settings.from_env(
        {
            **IMPORT_ENV,
            "IMPORT_PIPELINE_VERSION": "legacy-v1",
            "IMPORT_HOT_MATERIALIZATION_ENABLED": "false",
        },
        command="import-dump",
    )

    assert settings.import_pipeline_version is RunPipeline.LEGACY_V1
    assert settings.import_hot_materialization_enabled is True


def test_administrative_configuration_defaults_to_legacy_without_hot_materialization() -> None:
    settings = Settings.from_env({})

    assert settings.import_pipeline_version is RunPipeline.LEGACY_V1
    assert settings.import_hot_materialization_enabled is False


def test_snapshot_commands_default_to_sixty_four_gibibytes_without_raising_other_limits() -> None:
    backfill = Settings.from_env(
        {**IMPORT_ENV, **SNAPSHOT_ENV},
        command="backfill",
    )
    import_dump = Settings.from_env(IMPORT_ENV, command="import-dump")
    administrative = Settings.from_env({})

    assert backfill.ingestion_disk_budget_bytes == 64 * 1024**3
    assert import_dump.ingestion_disk_budget_bytes == 64 * 1024**3
    assert administrative.ingestion_disk_budget_bytes == 8 * 1024**3


def test_import_rejects_invalid_bucket_owner():
    with pytest.raises(ConfigurationError, match="ARCHIVE_BUCKET_OWNER"):
        Settings.from_env({**IMPORT_ENV, "ARCHIVE_BUCKET_OWNER": "bad"}, command="import-dump")


def test_backfill_requires_archive_owner_for_the_canonical_reader() -> None:
    values = {**IMPORT_ENV, **SNAPSHOT_ENV}
    values.pop("ARCHIVE_BUCKET_OWNER")

    with pytest.raises(ConfigurationError, match="ARCHIVE_BUCKET_OWNER"):
        Settings.from_env(values, command="backfill")


@pytest.mark.parametrize("missing", ("ARCHIVE_BUCKET", "ARCHIVE_BUCKET_OWNER"))
def test_rebuild_requires_archive_coordinates_for_marker_lookup(missing: str) -> None:
    values = {
        "OPERATIONAL_TABLE_NAME": "view-show-operacional",
        "ARCHIVE_BUCKET": "archive-test",
        "ARCHIVE_BUCKET_OWNER": "123456789012",
    }
    values.pop(missing)

    with pytest.raises(ConfigurationError, match=missing):
        Settings.from_env(values, command="rebuild-projections")


def test_snapshot_retry_callback_emits_import_retry_with_safe_dimensions() -> None:
    from adapters.sources.mysql_retry import MySqlRetryEvent, RetryingMySqlSourceReader

    settings = Settings.from_env({**IMPORT_ENV, **SNAPSHOT_ENV}, command="backfill")
    reader = container._default_factories(settings)["snapshot_reader"]()
    assert isinstance(reader, RetryingMySqlSourceReader)
    assert reader._on_retry is not None
    metrics = FakeMetricsPublisher()
    token = container._mysql_retry_telemetry.set((metrics, "import-dump"))
    try:
        reader._on_retry(MySqlRetryEvent("page", "signal_bucket", 2013, 1, 0.25))
    finally:
        container._mysql_retry_telemetry.reset(token)

    assert metrics.measurements == (
        (
            "increment",
            "MySqlRetries",
            1,
            {"command": "import-dump", "source_mode": "snapshot", "dataset": "signal_bucket"},
        ),
    )


@pytest.mark.parametrize(
    ("pipeline", "configured_hot", "expected_hot"),
    (
        (RunPipeline.CANONICAL_V2, False, False),
        (RunPipeline.LEGACY_V1, False, True),
    ),
)
def test_import_container_injects_reserved_policy_and_disables_environment_activation(
    tmp_path,
    monkeypatch,
    pipeline: RunPipeline,
    configured_hot: bool,
    expected_hot: bool,
):
    import bootstrap.container as container
    from tests.unit.application.test_import_dump import (
        IMPORT_ID,
        RUN_ID,
        SNAPSHOT,
        Downloader,
        Jobs,
        Promoter,
        result,
    )

    settings = Settings.from_env(
        {
            **IMPORT_ENV,
            "ARCHIVE_WORKDIR": str(tmp_path),
            "IMPORT_PIPELINE_VERSION": pipeline.value,
            "IMPORT_HOT_MATERIALIZATION_ENABLED": str(configured_hot).lower(),
        },
        command="import-dump",
    )
    jobs, events = Jobs(), []
    jobs.job = replace(jobs.job, pipeline_version=pipeline)
    downloader = Downloader(jobs, events)
    seen = []
    telemetry_commands = []

    def backfill(promoted_settings, dependencies, *, telemetry_command="backfill"):
        assert not downloader.path.exists()
        assert events == ["download", "promote"]
        assert promoted_settings.snapshot_bucket == SNAPSHOT.bucket
        assert promoted_settings.snapshot_object_key == SNAPSHOT.key
        assert promoted_settings.snapshot_object_version_id == SNAPSHOT.version_id
        assert promoted_settings.snapshot_sha256 == SNAPSHOT.sha256
        assert promoted_settings.snapshot_extracted_on == SNAPSHOT.snapshot_extracted_on
        assert promoted_settings.activate_candidate is False
        assert promoted_settings.import_pipeline_version is pipeline
        assert promoted_settings.import_hot_materialization_enabled is expected_hot
        assert promoted_settings.source_mode == "snapshot"
        assert "runs" in dependencies
        telemetry_commands.append(telemetry_command)

        def handle(arguments):
            seen.append(arguments.run_id)
            return result()

        return handle

    monkeypatch.setattr(container, "_backfill_handler", backfill)
    factories = {
        name: lambda: object() for name in container._capabilities("backfill", no_write=False)
    }
    factories.update(
        {
            "import_jobs": lambda: jobs,
            "staging_downloader": lambda: downloader,
            "snapshot_promoter": lambda: Promoter(events),
        }
    )
    runtime = build_container(settings, factories=factories).resolve("import-dump")
    actual = runtime.handler(Namespace(import_id=IMPORT_ID))
    assert actual.dataset_version == "dsv_" + "b" * 64
    assert seen == [RUN_ID]
    assert telemetry_commands == ["import-dump"]
    assert jobs.released and jobs.job.state == "READY"
    assert settings.snapshot_sha256 is None and settings.activate_candidate is True


# O sha do dump é evidência OPERACIONAL, não contrato: cada execução declara
# qual dump restaurou. Os testes declaram do mesmo jeito que o operador declara.
DUMP_SHA256 = "c1d86081679d66c392b63710bda4517b047f029c5403ad1502d731ab5ac126ea"


def _settings(monkeypatch: pytest.MonkeyPatch, **overrides: str) -> Settings:
    for name in (
        "AWS_REGION",
        "INGESTION_ENVIRONMENT",
        "ARGUS_SOURCE_MODE",
        "SYNC_MAX_CATCHUP_WINDOWS",
        "SYNC_FINALIZATION_DELAY_SECONDS",
        "SNAPSHOT_BUCKET",
        "SNAPSHOT_OBJECT_KEY",
        "SNAPSHOT_OBJECT_VERSION_ID",
        "SNAPSHOT_SHA256",
        "SNAPSHOT_EXTRACTED_ON",
        "MYSQL_HOST",
        "MYSQL_PORT",
        "MYSQL_USER",
        "MYSQL_PASSWORD",
        "MYSQL_DATABASE",
        "MYSQL_READ_TIMEOUT_SECONDS",
        "MYSQL_WRITE_TIMEOUT_SECONDS",
        "MYSQL_DDL_TIMEOUT_SECONDS",
        "MYSQL_QUERY_MAX_ATTEMPTS",
        "MYSQL_QUERY_RETRY_BASE_MS",
        "MYSQL_QUERY_RETRY_MAX_MS",
        "MYSQL_SNAPSHOT_PREPARE_ENABLED",
        "LIVE_MYSQL_HOST",
        "LIVE_MYSQL_PORT",
        "LIVE_MYSQL_USER",
        "LIVE_MYSQL_PASSWORD",
        "LIVE_MYSQL_DATABASE",
        "OPERATIONAL_TABLE_NAME",
        "ARCHIVE_BUCKET",
        "GLUE_DATABASE",
        "ATHENA_WORKGROUP",
        "ATHENA_OUTPUT_LOCATION",
        "ANALYSIS_QUEUE_URL",
        "LOG_SERVICE_NAME",
        "METRICS_NAMESPACE",
    ):
        monkeypatch.delenv(name, raising=False)
    for name, value in {**SNAPSHOT_ENV, **overrides}.items():
        monkeypatch.setenv(name, value)
    return Settings.from_env()


def _active_manifest(
    registry: DatasetRegistry,
    *,
    empty_interval_datasets: tuple[str, ...] = (),
    pipeline: RunPipeline = RunPipeline.LEGACY_V1,
) -> CandidateManifest:
    snapshot = registry.snapshot
    version = (
        canonical_dataset_version(
            str(snapshot["sourceSystem"]),
            DUMP_SHA256,
            str(snapshot["physicalContractVersion"]),
            str(snapshot["canonicalSchemaVersion"]),
        )
        if pipeline is RunPipeline.CANONICAL_V2
        else _dataset_version(registry, DUMP_SHA256)
    )
    return valid_active_manifest(
        registry.names(),
        version,
        source_watermark=datetime(2026, 9, 1, 9, tzinfo=UTC),
        physical_contract_version=str(snapshot["physicalContractVersion"]),
        canonical_schema_version=str(snapshot["canonicalSchemaVersion"]),
        dump_checksum_sha256=DUMP_SHA256,
        empty_interval_datasets=empty_interval_datasets,
        pipeline=pipeline,
    )


def test_snapshot_requires_versioned_object_and_checksum(monkeypatch: pytest.MonkeyPatch) -> None:
    values = dict(SNAPSHOT_ENV)
    values.pop("SNAPSHOT_OBJECT_VERSION_ID")
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("SNAPSHOT_OBJECT_VERSION_ID", raising=False)

    with pytest.raises(ConfigurationError, match="SNAPSHOT_OBJECT_VERSION_ID"):
        Settings.from_env()


def test_snapshot_requires_a_canonical_operational_extraction_date(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    values = dict(SNAPSHOT_ENV)
    values.pop("SNAPSHOT_EXTRACTED_ON")

    with pytest.raises(ConfigurationError, match="SNAPSHOT_EXTRACTED_ON"):
        Settings.from_env(values)

    with pytest.raises(ConfigurationError, match="SNAPSHOT_EXTRACTED_ON"):
        Settings.from_env({**SNAPSHOT_ENV, "SNAPSHOT_EXTRACTED_ON": "20260831"})


def test_snapshot_rejects_null_version_identifier(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ConfigurationError, match="SNAPSHOT_OBJECT_VERSION_ID"):
        _settings(monkeypatch, SNAPSHOT_OBJECT_VERSION_ID="null")


def test_snapshot_key_rejects_url_instead_of_object_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(ConfigurationError, match="SNAPSHOT_OBJECT_KEY"):
        _settings(monkeypatch, SNAPSHOT_OBJECT_KEY="s3://bucket/argus_dump.sql.gz")


def test_athena_output_requires_a_canonical_bucket_prefix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(ConfigurationError, match="ATHENA_OUTPUT_LOCATION"):
        _settings(monkeypatch, ATHENA_OUTPUT_LOCATION="s3:///results/")


def test_live_requires_json_secret_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ARGUS_SOURCE_MODE", "live")
    for name in (
        "LIVE_MYSQL_HOST",
        "LIVE_MYSQL_PORT",
        "LIVE_MYSQL_USER",
        "LIVE_MYSQL_PASSWORD",
        "LIVE_MYSQL_DATABASE",
    ):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(ConfigurationError, match="LIVE_MYSQL_HOST"):
        Settings.from_env()


def test_settings_parse_safe_defaults_and_never_repr_secrets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(
        monkeypatch,
        MYSQL_PASSWORD="snapshot-sentinel",
        LIVE_MYSQL_PASSWORD="live-sentinel",
    )

    assert settings.aws_region == "us-east-1"
    assert settings.metrics_namespace == "view-show/Ingestion"
    assert settings.log_service_name == "view-show-ingestion"
    assert settings.page_size == 500
    assert settings.mysql_read_timeout_seconds == 300
    assert settings.mysql_write_timeout_seconds == 300
    assert settings.mysql_ddl_timeout_seconds == 1_800
    assert settings.mysql_query_max_attempts == 4
    assert settings.mysql_query_retry_base_ms == 250
    assert settings.mysql_query_retry_max_ms == 4_000
    assert settings.mysql_snapshot_prepare_enabled is False
    assert settings.sync_max_catchup_windows == 96
    assert settings.sync_finalization_delay_seconds == 900
    assert settings.activate_candidate is False
    assert settings.ingestion_disk_budget_bytes < FARGATE_EPHEMERAL_STORAGE_BYTES
    assert "snapshot-sentinel" not in repr(settings)
    assert "live-sentinel" not in repr(settings)


@pytest.mark.parametrize(
    ("name", "value"),
    (
        ("MYSQL_READ_TIMEOUT_SECONDS", "0"),
        ("MYSQL_READ_TIMEOUT_SECONDS", "-1"),
        ("MYSQL_READ_TIMEOUT_SECONDS", "invalid"),
        ("MYSQL_WRITE_TIMEOUT_SECONDS", "0"),
        ("MYSQL_WRITE_TIMEOUT_SECONDS", "-1"),
        ("MYSQL_WRITE_TIMEOUT_SECONDS", "invalid"),
        ("MYSQL_DDL_TIMEOUT_SECONDS", "0"),
        ("MYSQL_DDL_TIMEOUT_SECONDS", "-1"),
        ("MYSQL_DDL_TIMEOUT_SECONDS", "invalid"),
        ("MYSQL_QUERY_MAX_ATTEMPTS", "0"),
        ("MYSQL_QUERY_MAX_ATTEMPTS", "-1"),
        ("MYSQL_QUERY_MAX_ATTEMPTS", "invalid"),
        ("MYSQL_QUERY_RETRY_BASE_MS", "0"),
        ("MYSQL_QUERY_RETRY_BASE_MS", "-1"),
        ("MYSQL_QUERY_RETRY_BASE_MS", "invalid"),
        ("MYSQL_QUERY_RETRY_MAX_MS", "0"),
        ("MYSQL_QUERY_RETRY_MAX_MS", "-1"),
        ("MYSQL_QUERY_RETRY_MAX_MS", "invalid"),
    ),
)
def test_mysql_snapshot_policy_rejects_non_positive_or_non_integer_values(
    monkeypatch: pytest.MonkeyPatch, name: str, value: str
) -> None:
    with pytest.raises(ConfigurationError, match=name):
        _settings(monkeypatch, **{name: value})


def test_mysql_snapshot_policy_rejects_an_inverted_retry_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(ConfigurationError, match="MYSQL_QUERY_RETRY_BASE_MS"):
        _settings(
            monkeypatch,
            MYSQL_QUERY_RETRY_BASE_MS="401",
            MYSQL_QUERY_RETRY_MAX_MS="400",
        )


@pytest.mark.parametrize("value", ("0", "-1", "not-a-number"))
def test_sync_catchup_window_limit_must_be_a_positive_integer(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    with pytest.raises(ConfigurationError, match="SYNC_MAX_CATCHUP_WINDOWS"):
        _settings(monkeypatch, SYNC_MAX_CATCHUP_WINDOWS=value)


@pytest.mark.parametrize("value", ("0", "899", "901", "not-a-number"))
def test_sync_finalization_delay_must_be_aligned_and_at_least_one_window(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    with pytest.raises(ConfigurationError, match="SYNC_FINALIZATION_DELAY_SECONDS"):
        _settings(monkeypatch, SYNC_FINALIZATION_DELAY_SECONDS=value)


def test_sync_finalization_delay_accepts_aligned_margin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(monkeypatch, SYNC_FINALIZATION_DELAY_SECONDS="1800")

    assert settings.sync_finalization_delay_seconds == 1800


def test_settings_without_source_can_serve_commands_that_do_not_read_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in SNAPSHOT_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("OPERATIONAL_TABLE_NAME", "view-show-operacional")
    monkeypatch.setenv("ARCHIVE_BUCKET", "archive-test")
    monkeypatch.setenv("ARCHIVE_BUCKET_OWNER", "123456789012")

    settings = Settings.from_env()

    settings.require_for_command("rebuild-projections")
    with pytest.raises(ConfigurationError, match="ARGUS_SOURCE_MODE"):
        settings.require_for_command("reprocess")


def test_publish_parsing_ignores_present_but_unused_snapshot_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in SNAPSHOT_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ARGUS_SOURCE_MODE", "snapshot")
    monkeypatch.setenv("OPERATIONAL_TABLE_NAME", "view-show-operacional")
    monkeypatch.setenv("ANALYSIS_QUEUE_URL", "https://sqs.us-east-1.amazonaws.com/123/analysis")

    settings = Settings.from_env(command="publish-outbox")

    assert settings.source_mode == "snapshot"


def test_validate_no_write_is_snapshot_metadata_only(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in SNAPSHOT_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ARGUS_SOURCE_MODE", "live")
    monkeypatch.setenv("LIVE_MYSQL_HOST", "db.internal")
    monkeypatch.setenv("LIVE_MYSQL_PORT", "3306")
    monkeypatch.setenv("LIVE_MYSQL_USER", "argus")
    monkeypatch.setenv("LIVE_MYSQL_PASSWORD", "secret")
    monkeypatch.setenv("LIVE_MYSQL_DATABASE", "argus")

    settings = Settings.from_env()
    with pytest.raises(ConfigurationError, match="snapshot"):
        settings.require_for_command("validate", no_write=True)


@pytest.mark.parametrize("value", ["yes", "1", "TRUE ", ""])
def test_boolean_values_are_strict(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    with pytest.raises(ConfigurationError, match="ACTIVATE_CANDIDATE"):
        _settings(monkeypatch, ACTIVATE_CANDIDATE=value)


def test_validate_no_write_does_not_construct_mysql_or_sinks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(monkeypatch)
    built: list[str] = []

    def factory(name: str) -> Callable[[], object]:
        def create() -> object:
            built.append(name)
            return object()

        return create

    container = build_container(
        settings,
        factories={
            name: factory(name)
            for name in (
                "registry",
                "snapshot_verifier",
                "snapshot_restorer",
                "snapshot_reader",
                "live_reader",
                "dynamodb",
                "archive",
                "catalog",
                "queue",
                "telemetry",
            )
        },
    )

    runtime = container.resolve("validate", no_write=True)

    assert runtime.settings is settings
    assert set(runtime.dependencies) == {"registry", "snapshot_verifier", "telemetry"}
    assert built == ["registry", "snapshot_verifier", "telemetry"]


def test_validate_with_write_requires_mysql_before_any_factory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(monkeypatch)
    built: list[str] = []
    container = build_container(settings, factories={"registry": lambda: built.append("registry")})

    with pytest.raises(ConfigurationError, match="MYSQL_HOST"):
        container.resolve("validate")
    assert built == []


def test_publish_outbox_is_lazy_and_memoizes_only_dynamo_queue_and_telemetry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(
        monkeypatch,
        OPERATIONAL_TABLE_NAME="view-show-operacional",
        ANALYSIS_QUEUE_URL="https://sqs.us-east-1.amazonaws.com/123/analysis",
    )
    built: list[str] = []

    def factory(name: str) -> Callable[[], object]:
        def create() -> object:
            built.append(name)
            return object()

        return create

    container = build_container(
        settings,
        factories={
            name: factory(name)
            for name in (
                "registry",
                "snapshot_restorer",
                "snapshot_reader",
                "live_reader",
                "control",
                "hot_sink",
                "manifests",
                "projections",
                "archive_partitions",
                "hot_expiration",
                "outbox",
                "archive_store",
                "parquet",
                "glue",
                "athena",
                "queue",
                "telemetry",
            )
        },
    )

    first = container.resolve("publish-outbox")
    second = container.resolve("publish-outbox")

    assert set(first.dependencies) == {"outbox", "queue", "telemetry"}
    assert first.dependencies == second.dependencies
    assert built == ["outbox", "queue", "telemetry"]


def test_publish_runtime_handler_calls_the_outbox_application_adapter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(
        monkeypatch,
        OPERATIONAL_TABLE_NAME="view-show-operacional",
        ANALYSIS_QUEUE_URL="https://sqs.us-east-1.amazonaws.com/123/analysis",
    )
    published: list[int] = []

    class Outbox:
        def list_pending(self, limit: int) -> tuple[object, ...]:
            published.append(limit)
            return ()

        def mark_published(self, *args: object, **kwargs: object) -> None:
            raise AssertionError("empty outbox must not acknowledge")

    class Queue:
        def publish(self, *args: object, **kwargs: object) -> object:
            raise AssertionError("empty outbox must not publish")

    runtime = build_container(
        settings,
        factories={
            "outbox": Outbox,
            "queue": Queue,
            "telemetry": object,
        },
    ).resolve("publish-outbox")

    result = runtime.handler(Namespace(command="publish-outbox", limit=7))

    assert callable(runtime.handler)
    assert result.attempted == 0
    assert published == [7]


def test_publish_runtime_uses_configured_limit_when_cli_does_not_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(
        monkeypatch,
        OPERATIONAL_TABLE_NAME="view-show-operacional",
        ANALYSIS_QUEUE_URL="https://sqs.us-east-1.amazonaws.com/123/analysis",
        OUTBOX_PUBLISH_LIMIT="23",
    )
    limits: list[int] = []

    class Outbox:
        def list_pending(self, limit: int) -> tuple[object, ...]:
            limits.append(limit)
            return ()

        def mark_published(self, *args: object, **kwargs: object) -> None:
            raise AssertionError("empty outbox must not acknowledge")

    runtime = build_container(
        settings,
        factories={"outbox": Outbox, "queue": object, "telemetry": object},
    ).resolve("publish-outbox")

    runtime.handler(Namespace(command="publish-outbox", limit=None))

    assert limits == [23]


def test_rebuild_resolves_manifest_and_projection_repositories_with_telemetry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(monkeypatch, **REBUILD_ENV)
    built: list[str] = []

    def factory(name: str) -> Callable[[], object]:
        def create() -> object:
            built.append(name)
            return DatasetRegistry.load_argus_v2() if name == "registry" else object()

        return create

    runtime = build_container(
        settings,
        factories={
            name: factory(name)
            for name in container._capabilities("rebuild-projections", no_write=False)
        },
    ).resolve("rebuild-projections")

    assert set(runtime.dependencies) == set(
        container._capabilities("rebuild-projections", no_write=False)
    )
    assert built == list(container._capabilities("rebuild-projections", no_write=False))


def test_backfill_runtime_resolves_the_canonical_set_store(
    tmp_path: Path,
) -> None:
    settings = Settings.from_env(
        {**IMPORT_ENV, **SNAPSHOT_ENV, "ARCHIVE_WORKDIR": str(tmp_path)},
        command="backfill",
    )
    capabilities = container._capabilities("backfill", no_write=False)
    factories = {name: object for name in capabilities}
    factories["registry"] = DatasetRegistry.load_argus_v2
    runtime = build_container(
        settings,
        factories=factories,
    ).resolve("backfill")

    assert "canonical_sets" in runtime.dependencies


def test_rebuild_runtime_reads_the_canonical_marker_instead_of_hot_facts(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    registry = DatasetRegistry.load_argus_v2()
    descriptor = registry.require("app_error")
    encoded = PyArrowParquetEncoder().write_partition(
        (_record(),),
        descriptor,
        tmp_path / "published.parquet",
        dataset_version="dsv_canonical",
        expected_absent=True,
        idempotency_key="runtime-canonical-object",
    )
    marker = _canonical_set(
        row_count=encoded.row_count,
        byte_count=encoded.byte_size,
        object_sha=encoded.sha256,
    )
    evidence = next(item for item in marker.datasets if item.dataset == "app_error").partitions[0]

    class LocalArchiveObjects:
        def download(
            self,
            key: str,
            destination: Path,
            *,
            expected_sha256: str,
            expected_size: int,
        ) -> ArchiveObject:
            assert key == evidence.objects[0].object_key
            digest = hashlib.sha256()
            size = 0
            with encoded.path.open("rb") as source, destination.open("xb") as target:
                while chunk := source.read(64 * 1024):
                    digest.update(chunk)
                    size += len(chunk)
                    target.write(chunk)
            assert (digest.hexdigest(), size) == (expected_sha256, expected_size)
            return ArchiveObject(key, expected_sha256, expected_size)

    class NoHotFacts(FakeProjectionRepository):
        def iter_input_batches(self, *_args, **_kwargs):  # type: ignore[no-untyped-def]
            raise AssertionError("the canonical runtime must not query hot facts")

    canonical_sets = FakeCanonicalSetStore()
    canonical_sets.values[marker.dataset_version] = marker
    archive_partitions = FakeArchivePartitionRepository()
    archive = _archive(marker)
    archive_partitions.partitions[(archive.dataset_version, archive.dataset, archive.partition)] = (
        archive
    )
    projections = NoHotFacts()
    settings = _settings(
        monkeypatch,
        OPERATIONAL_TABLE_NAME="view-show-operacional",
        ARCHIVE_BUCKET="archive-test",
        ARCHIVE_BUCKET_OWNER="123456789012",
        ARCHIVE_WORKDIR=str(tmp_path / "rebuild"),
    )
    runtime = build_container(
        settings,
        factories={
            "registry": lambda: registry,
            "manifests": FakeManifestRepository,
            "projections": lambda: projections,
            "archive_partitions": lambda: archive_partitions,
            "archive_store": LocalArchiveObjects,
            "canonical_sets": lambda: canonical_sets,
            "telemetry": object,
        },
    ).resolve("rebuild-projections")

    result = runtime.handler(
        Namespace(
            command="rebuild-projections",
            dataset_version=marker.dataset_version,
            partition_keys=[f"DATASET#{marker.dataset_version}#FACT#TS#app_error#20260901"],
            archive_partitions=[f"app_error={PARTITION}"],
        )
    )

    assert result.catalog_item_counts == {("app_error", PARTITION): 2}
    assert projections.backend.projections


def test_rebuild_handler_adapts_cli_partition_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from application.rebuild_projections import RebuildProjections

    settings = _settings(monkeypatch, **REBUILD_ENV)
    requests: list[object] = []

    def execute(_self: object, request: object) -> str:
        requests.append(request)
        return "rebuilt"

    monkeypatch.setattr(RebuildProjections, "execute", execute)
    runtime = build_container(
        settings,
        factories={
            "registry": DatasetRegistry.load_argus_v2,
            "manifests": object,
            "projections": object,
            "archive_partitions": object,
            "archive_store": object,
            "canonical_sets": object,
            "telemetry": object,
        },
    ).resolve("rebuild-projections")

    result = runtime.handler(
        Namespace(
            command="rebuild-projections",
            dataset_version="dsv_test",
            partition_keys=["DATASET#dsv_test#FACT#TS#signal_bucket#20260909"],
            archive_partitions=["signal_bucket=year=2026/month=09/day=09"],
        )
    )

    assert result == "rebuilt"
    assert requests[0].archive_partitions == {"signal_bucket": "year=2026/month=09/day=09"}


def test_rebuild_handler_rejects_an_active_dataset_before_projection_input_reads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = DatasetRegistry.load_argus_v2()
    active = _active_manifest(registry)

    class NoReads(FakeProjectionRepository):
        def iter_input_batches(self, dataset_version, partition_keys):  # type: ignore[no-untyped-def]
            del dataset_version, partition_keys
            raise AssertionError("ACTIVE rebuild must not query projection inputs")

    projections = NoReads()
    runtime = build_container(
        _settings(monkeypatch, **REBUILD_ENV),
        factories={
            "registry": lambda: registry,
            "manifests": lambda: FakeManifestRepository(active),
            "projections": lambda: projections,
            "archive_partitions": object,
            "archive_store": object,
            "canonical_sets": FakeCanonicalSetStore,
            "telemetry": object,
        },
    ).resolve("rebuild-projections")

    with pytest.raises(ConditionalWriteError, match="active"):
        runtime.handler(
            Namespace(
                command="rebuild-projections",
                dataset_version=active.dataset_version,
                partition_keys=[f"DATASET#{active.dataset_version}#FACT#TS#signal_bucket#20260909"],
                archive_partitions=["signal_bucket=year=2026/month=09/day=09"],
            )
        )

    assert projections.projections == {}


@pytest.mark.parametrize("pipeline", tuple(RunPipeline))
def test_sync_handler_builds_a_non_empty_allowlisted_request_for_active_representation(
    monkeypatch: pytest.MonkeyPatch,
    pipeline: RunPipeline,
) -> None:
    from application.sync_catchup import SyncCatchup
    from contracts.registry import DatasetRegistry
    from tests.fakes import FakeWindowCommitRepository

    settings = _settings(
        monkeypatch,
        ARGUS_SOURCE_MODE="live",
        LIVE_MYSQL_HOST="db.internal",
        LIVE_MYSQL_PORT="3306",
        LIVE_MYSQL_USER="argus",
        LIVE_MYSQL_PASSWORD="secret",
        LIVE_MYSQL_DATABASE="argus",
        OPERATIONAL_TABLE_NAME="view-show-operacional",
        ANALYSIS_QUEUE_URL="https://sqs.us-east-1.amazonaws.com/123/analysis",
    )
    requests: list[object] = []

    def execute(_self: object, request: object) -> str:
        requests.append(request)
        return "synced"

    monkeypatch.setattr(SyncCatchup, "execute", execute)
    registry = DatasetRegistry.load_argus_v2()
    active = _active_manifest(registry, pipeline=pipeline)
    runtime = build_container(
        settings,
        factories={
            "registry": lambda: registry,
            "live_sync_configuration": lambda: FakeLiveSyncConfiguration(True),
            "live_reader": object,
            "hot_sink": object,
            "control": object,
            "outbox": FakeWindowCommitRepository,
            "manifests": lambda: FakeManifestRepository(active),
            "queue": object,
            "telemetry": object,
        },
    ).resolve("sync")

    assert runtime.handler(Namespace(command="sync")) == "synced"
    expected = tuple(
        descriptor.table for descriptor in registry if descriptor.supports_live_window_sync
    )
    assert requests[0].dataset_names == expected
    assert requests[0].source_grain_seconds == {
        descriptor.table: descriptor.grain_seconds
        for descriptor in registry
        if descriptor.supports_live_window_sync
    }
    assert requests[0].dataset_version == active.dataset_version
    assert "signal_meta" not in requests[0].dataset_names
    assert "live_event_sde" not in requests[0].dataset_names


def test_sync_handler_rejects_missing_active_before_constructing_live_reader(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from contracts.registry import DatasetRegistry
    from tests.fakes import FakeManifestRepository, FakeWindowCommitRepository

    settings = _settings(
        monkeypatch,
        ARGUS_SOURCE_MODE="live",
        LIVE_MYSQL_HOST="db.internal",
        LIVE_MYSQL_PORT="3306",
        LIVE_MYSQL_USER="argus",
        LIVE_MYSQL_PASSWORD="secret",
        LIVE_MYSQL_DATABASE="argus",
        OPERATIONAL_TABLE_NAME="view-show-operacional",
        ANALYSIS_QUEUE_URL="https://sqs.us-east-1.amazonaws.com/123/analysis",
    )
    built: list[str] = []
    registry = DatasetRegistry.load_argus_v2()
    runtime = build_container(
        settings,
        factories={
            "registry": lambda: registry,
            "live_sync_configuration": lambda: FakeLiveSyncConfiguration(True),
            "live_reader": lambda: built.append("live_reader"),
            "hot_sink": object,
            "control": object,
            "outbox": FakeWindowCommitRepository,
            "queue": object,
            "telemetry": object,
            "manifests": FakeManifestRepository,
        },
    ).resolve("sync")

    assert built == []
    with pytest.raises(RuntimeError, match="ACTIVE"):
        runtime.handler(Namespace(command="sync"))
    assert built == []


@pytest.mark.parametrize("response", [{}, {"Item": {"enabled": {"S": "true"}}}, None])
def test_sync_runtime_checks_dynamo_before_reader_or_lease(monkeypatch, response) -> None:
    from adapters.dynamodb import DynamoControlProtocolError, DynamoLiveSyncConfiguration
    from contracts.registry import DatasetRegistry
    from tests.fakes import FakeLeaseRepository, FakeWindowCommitRepository

    class Client:
        calls = 0

        def get_item(self, **kwargs):
            self.calls += 1
            if response is None:
                raise RuntimeError("DynamoDB unavailable")
            return response

    class Leases(FakeLeaseRepository):
        def acquire(self, *args, **kwargs):
            raise AssertionError("disabled runtime must not acquire work")

    def forbidden() -> object:
        raise AssertionError("disabled runtime must not construct live reader")

    settings = _settings(
        monkeypatch,
        ARGUS_SOURCE_MODE="live",
        LIVE_MYSQL_HOST="db.internal",
        LIVE_MYSQL_PORT="3306",
        LIVE_MYSQL_USER="argus",
        LIVE_MYSQL_PASSWORD="secret",
        LIVE_MYSQL_DATABASE="argus",
        OPERATIONAL_TABLE_NAME="operational",
        ANALYSIS_QUEUE_URL="https://sqs.us-east-1.amazonaws.com/123/analysis",
    )
    registry = DatasetRegistry.load_argus_v2()
    client = Client()
    runtime = build_container(
        settings,
        factories={
            "registry": lambda: registry,
            "live_sync_configuration": lambda: DynamoLiveSyncConfiguration(client, "operational"),
            "live_reader": forbidden,
            "hot_sink": object,
            "control": Leases,
            "outbox": FakeWindowCommitRepository,
            "manifests": lambda: FakeManifestRepository(_active_manifest(registry)),
            "queue": object,
            "telemetry": object,
        },
    ).resolve("sync")

    if response == {}:
        result = runtime.handler(Namespace(command="sync"))
        assert result.stage is RunStage.SKIPPED_DISABLED
        assert result.sources == {}
        assert result.new_analysis_events == 0
    else:
        with pytest.raises(DynamoControlProtocolError):
            runtime.handler(Namespace(command="sync"))
    assert client.calls == 1


def test_sync_handler_uses_the_last_finalizable_fifteen_minute_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from application.sync_catchup import SyncCatchup
    from bootstrap import container
    from contracts.registry import DatasetRegistry
    from domain.models import TimeWindow
    from tests.fakes import FakeWindowCommitRepository

    settings = _settings(
        monkeypatch,
        ARGUS_SOURCE_MODE="live",
        LIVE_MYSQL_HOST="db.internal",
        LIVE_MYSQL_PORT="3306",
        LIVE_MYSQL_USER="argus",
        LIVE_MYSQL_PASSWORD="secret",
        LIVE_MYSQL_DATABASE="argus",
        OPERATIONAL_TABLE_NAME="view-show-operacional",
        ANALYSIS_QUEUE_URL="https://sqs.us-east-1.amazonaws.com/123/analysis",
    )
    requests: list[object] = []

    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):  # type: ignore[no-untyped-def]
            return cls(2026, 9, 1, 10, 7, 42, tzinfo=UTC)

    def execute(_self: object, request: object) -> str:
        requests.append(request)
        return "synced"

    monkeypatch.setattr(SyncCatchup, "execute", execute)
    monkeypatch.setattr(container, "datetime", FixedDatetime)
    registry = DatasetRegistry.load_argus_v2()
    runtime = build_container(
        settings,
        factories={
            "registry": lambda: registry,
            "live_sync_configuration": lambda: FakeLiveSyncConfiguration(True),
            "live_reader": object,
            "hot_sink": object,
            "control": object,
            "outbox": FakeWindowCommitRepository,
            "manifests": lambda: FakeManifestRepository(_active_manifest(registry)),
            "queue": object,
            "telemetry": object,
        },
    ).resolve("sync")

    assert runtime.handler(Namespace(command="sync")) == "synced"
    assert requests[0].latest_window == TimeWindow(
        datetime(2026, 9, 1, 9, 30, tzinfo=UTC),
        datetime(2026, 9, 1, 9, 45, tzinfo=UTC),
        900,
    )


def test_sync_handler_catches_up_from_the_active_manifest_source_watermarks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from application.sync import Sync, SyncResult, SyncSourceResult
    from bootstrap import container
    from bootstrap.container import _dataset_version
    from contracts.registry import DatasetRegistry
    from tests.fakes import FakeWindowCommitRepository

    settings = _settings(
        monkeypatch,
        ARGUS_SOURCE_MODE="live",
        LIVE_MYSQL_HOST="db.internal",
        LIVE_MYSQL_PORT="3306",
        LIVE_MYSQL_USER="argus",
        LIVE_MYSQL_PASSWORD="secret",
        LIVE_MYSQL_DATABASE="argus",
        OPERATIONAL_TABLE_NAME="view-show-operacional",
        ANALYSIS_QUEUE_URL="https://sqs.us-east-1.amazonaws.com/123/analysis",
    )
    registry = DatasetRegistry.load_argus_v2()
    version = _dataset_version(registry, DUMP_SHA256)
    outbox = FakeWindowCommitRepository()
    outbox.watermarks[(version, "analysis:ANOMALY_DETECTION")] = datetime(2026, 9, 1, 9, tzinfo=UTC)
    outbox.watermarks[(version, "analysis:QOE_FORECAST")] = datetime(2026, 9, 1, 9, tzinfo=UTC)
    requests: list[object] = []

    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):  # type: ignore[no-untyped-def]
            return cls(2026, 9, 1, 10, 7, 42, tzinfo=UTC)

    def execute(_self: object, request: object) -> SyncResult:
        assert hasattr(request, "dataset_names")
        assert hasattr(request, "window")
        requests.append(request)
        return SyncResult(
            {
                dataset: SyncSourceResult(dataset, True, 0, 0, request.window.end)
                for dataset in request.dataset_names
            },
            {},
            0,
        )

    monkeypatch.setattr(Sync, "execute", execute)
    monkeypatch.setattr(container, "datetime", FixedDatetime)
    runtime = build_container(
        settings,
        factories={
            "registry": lambda: registry,
            "live_sync_configuration": lambda: FakeLiveSyncConfiguration(True),
            "live_reader": object,
            "hot_sink": object,
            "control": object,
            "outbox": lambda: outbox,
            "manifests": lambda: FakeManifestRepository(_active_manifest(registry)),
            "queue": object,
            "telemetry": object,
        },
    ).resolve("sync")

    result = runtime.handler(Namespace(command="sync"))

    assert requests[0].source_watermarks == {
        descriptor.table: datetime(2026, 9, 1, 9, tzinfo=UTC)
        for descriptor in registry
        if descriptor.supports_live_window_sync
    }
    assert [request.window for request in requests] == [
        TimeWindow(
            datetime(2026, 9, 1, 9, tzinfo=UTC),
            datetime(2026, 9, 1, 9, 15, tzinfo=UTC),
            900,
        ),
        TimeWindow(
            datetime(2026, 9, 1, 9, 15, tzinfo=UTC),
            datetime(2026, 9, 1, 9, 30, tzinfo=UTC),
            900,
        ),
        TimeWindow(
            datetime(2026, 9, 1, 9, 30, tzinfo=UTC),
            datetime(2026, 9, 1, 9, 45, tzinfo=UTC),
            900,
        ),
    ]
    assert result.stage is RunStage.SUCCEEDED


def test_sync_handler_continues_capped_catchup_from_snapshot_day_for_empty_manifest_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from application.sync import Sync, SyncResult, SyncSourceResult
    from bootstrap import container
    from contracts.registry import DatasetRegistry
    from tests.fakes import FakeWindowCommitRepository

    settings = _settings(
        monkeypatch,
        ARGUS_SOURCE_MODE="live",
        LIVE_MYSQL_HOST="db.internal",
        LIVE_MYSQL_PORT="3306",
        LIVE_MYSQL_USER="argus",
        LIVE_MYSQL_PASSWORD="secret",
        LIVE_MYSQL_DATABASE="argus",
        OPERATIONAL_TABLE_NAME="view-show-operacional",
        ANALYSIS_QUEUE_URL="https://sqs.us-east-1.amazonaws.com/123/analysis",
        SYNC_MAX_CATCHUP_WINDOWS="2",
    )
    registry = DatasetRegistry.load_argus_v2()
    version = _dataset_version(registry, DUMP_SHA256)
    snapshot_day = datetime(2026, 9, 1, tzinfo=UTC)
    outbox = FakeWindowCommitRepository()
    outbox.watermarks[(version, "analysis:ANOMALY_DETECTION")] = snapshot_day
    outbox.watermarks[(version, "analysis:QOE_FORECAST")] = snapshot_day
    requests: list[object] = []

    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):  # type: ignore[no-untyped-def]
            return cls(2026, 9, 1, 10, 7, 42, tzinfo=UTC)

    def execute(_self: object, request: object) -> SyncResult:
        assert hasattr(request, "dataset_names")
        assert hasattr(request, "window")
        requests.append(request)
        outbox.watermarks[(version, "source:signal_bucket")] = request.window.end
        outbox.watermarks[(version, "analysis:ANOMALY_DETECTION")] = request.window.end
        return SyncResult(
            {
                dataset: SyncSourceResult(dataset, True, 0, 0, request.window.end)
                for dataset in request.dataset_names
            },
            {"ANOMALY_DETECTION": request.window.end},
            0,
        )

    monkeypatch.setattr(Sync, "execute", execute)
    monkeypatch.setattr(container, "datetime", FixedDatetime)
    runtime = build_container(
        settings,
        factories={
            "registry": lambda: registry,
            "live_sync_configuration": lambda: FakeLiveSyncConfiguration(True),
            "live_reader": object,
            "hot_sink": object,
            "control": object,
            "outbox": lambda: outbox,
            "manifests": lambda: FakeManifestRepository(
                _active_manifest(registry, empty_interval_datasets=("signal_bucket",))
            ),
            "queue": object,
            "telemetry": object,
        },
    ).resolve("sync")

    first = runtime.handler(Namespace(command="sync"))
    second = runtime.handler(Namespace(command="sync"))

    assert [request.window for request in requests] == [
        TimeWindow(snapshot_day, snapshot_day.replace(minute=15), 900),
        TimeWindow(snapshot_day.replace(minute=15), snapshot_day.replace(minute=30), 900),
        TimeWindow(snapshot_day.replace(minute=30), snapshot_day.replace(minute=45), 900),
        TimeWindow(snapshot_day.replace(minute=45), snapshot_day.replace(hour=1), 900),
    ]
    assert first.stage is RunStage.PARTIAL
    assert second.stage is RunStage.PARTIAL


def test_sync_handler_defers_recent_window_until_finalization_margin_has_elapsed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from application.sync import Sync, SyncResult, SyncSourceResult
    from bootstrap import container
    from bootstrap.container import _dataset_version
    from contracts.registry import DatasetRegistry
    from tests.fakes import FakeWindowCommitRepository

    settings = _settings(
        monkeypatch,
        ARGUS_SOURCE_MODE="live",
        LIVE_MYSQL_HOST="db.internal",
        LIVE_MYSQL_PORT="3306",
        LIVE_MYSQL_USER="argus",
        LIVE_MYSQL_PASSWORD="secret",
        LIVE_MYSQL_DATABASE="argus",
        OPERATIONAL_TABLE_NAME="view-show-operacional",
        ANALYSIS_QUEUE_URL="https://sqs.us-east-1.amazonaws.com/123/analysis",
    )
    registry = DatasetRegistry.load_argus_v2()
    version = _dataset_version(registry, DUMP_SHA256)
    outbox = FakeWindowCommitRepository()
    finalized = datetime(2026, 9, 1, 9, 45, tzinfo=UTC)
    for descriptor in registry:
        if descriptor.supports_live_window_sync:
            outbox.watermarks[(version, f"source:{descriptor.table}")] = finalized
    outbox.watermarks[(version, "analysis:ANOMALY_DETECTION")] = finalized
    outbox.watermarks[(version, "analysis:QOE_FORECAST")] = datetime(2026, 9, 1, 9, tzinfo=UTC)
    requests: list[object] = []

    class FixedDatetime(datetime):
        instant = datetime(2026, 9, 1, 10, 7, 42, tzinfo=UTC)

        @classmethod
        def now(cls, tz=None):  # type: ignore[no-untyped-def]
            return cls.instant

    def execute(_self: object, request: object) -> SyncResult:
        assert hasattr(request, "dataset_names")
        assert hasattr(request, "window")
        requests.append(request)
        return SyncResult(
            {
                dataset: SyncSourceResult(dataset, True, 0, 0, request.window.end)
                for dataset in request.dataset_names
            },
            {"ANOMALY_DETECTION": request.window.end},
            0,
        )

    monkeypatch.setattr(Sync, "execute", execute)
    monkeypatch.setattr(container, "datetime", FixedDatetime)
    runtime = build_container(
        settings,
        factories={
            "registry": lambda: registry,
            "live_sync_configuration": lambda: FakeLiveSyncConfiguration(True),
            "live_reader": object,
            "hot_sink": object,
            "control": object,
            "outbox": lambda: outbox,
            "manifests": lambda: FakeManifestRepository(_active_manifest(registry)),
            "queue": object,
            "telemetry": object,
        },
    ).resolve("sync")

    before_margin = runtime.handler(Namespace(command="sync-before-margin"))

    assert before_margin.sources == {}
    assert before_margin.analysis_watermarks == {
        "ANOMALY_DETECTION": finalized,
        "QOE_FORECAST": datetime(2026, 9, 1, 9, tzinfo=UTC),
    }
    assert requests == []

    FixedDatetime.instant = datetime(2026, 9, 1, 10, 15, tzinfo=UTC)
    result = runtime.handler(Namespace(command="sync-after-margin"))

    assert [request.window for request in requests] == [
        TimeWindow(
            datetime(2026, 9, 1, 9, 45, tzinfo=UTC),
            datetime(2026, 9, 1, 10, tzinfo=UTC),
            900,
        )
    ]
    assert result.stage is RunStage.SUCCEEDED


def test_sync_handler_hydrates_only_the_matching_durable_analysis_watermark(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from application.sync_catchup import SyncCatchup
    from bootstrap.container import _dataset_version
    from contracts.registry import DatasetRegistry
    from tests.fakes import FakeWindowCommitRepository

    settings = _settings(
        monkeypatch,
        ARGUS_SOURCE_MODE="live",
        LIVE_MYSQL_HOST="db.internal",
        LIVE_MYSQL_PORT="3306",
        LIVE_MYSQL_USER="argus",
        LIVE_MYSQL_PASSWORD="secret",
        LIVE_MYSQL_DATABASE="argus",
        OPERATIONAL_TABLE_NAME="view-show-operacional",
        ANALYSIS_QUEUE_URL="https://sqs.us-east-1.amazonaws.com/123/analysis",
    )
    registry = DatasetRegistry.load_argus_v2()
    version = _dataset_version(registry, DUMP_SHA256)
    durable = datetime(2026, 9, 1, 1, tzinfo=UTC)
    outbox = FakeWindowCommitRepository()
    outbox.watermarks[(version, "source:signal_bucket")] = durable
    outbox.watermarks[(version, "analysis:ANOMALY_DETECTION")] = durable
    requests: list[object] = []

    def execute(_self: object, request: object) -> str:
        requests.append(request)
        return "synced"

    monkeypatch.setattr(SyncCatchup, "execute", execute)
    runtime = build_container(
        settings,
        factories={
            "registry": lambda: registry,
            "live_sync_configuration": lambda: FakeLiveSyncConfiguration(True),
            "live_reader": object,
            "hot_sink": object,
            "control": object,
            "outbox": lambda: outbox,
            "manifests": lambda: FakeManifestRepository(_active_manifest(registry)),
            "queue": object,
            "telemetry": object,
        },
    ).resolve("sync")

    assert runtime.handler(Namespace(command="sync")) == "synced"
    assert requests[0].source_watermarks["signal_bucket"] == durable
    assert set(requests[0].source_watermarks) == {
        descriptor.table for descriptor in registry if descriptor.supports_live_window_sync
    }
    assert requests[0].analysis_watermarks == {"ANOMALY_DETECTION": durable}


@pytest.mark.parametrize(
    "golden_set_table",
    ("view-show-golden-set", "monitoracao-golden-set"),
)
def test_command_contracts_fail_before_any_factory_is_built(
    monkeypatch: pytest.MonkeyPatch, golden_set_table: str
) -> None:
    settings = _settings(monkeypatch, OPERATIONAL_TABLE_NAME=golden_set_table)
    built: list[str] = []
    container = build_container(
        settings,
        factories={"projections": lambda: built.append("projections")},
    )

    with pytest.raises(ConfigurationError, match="OPERATIONAL_TABLE_NAME"):
        container.resolve("rebuild-projections")
    assert built == []


def test_backfill_rejects_unwritable_workdir_without_creating_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    target = tmp_path / "not-created" / "ingestion"
    monkeypatch.setattr("bootstrap.config.os.access", lambda _path, _mode: False)

    with pytest.raises(ConfigurationError, match="ARCHIVE_WORKDIR"):
        _settings(monkeypatch, ARCHIVE_WORKDIR=str(target))
    assert not target.exists()


@pytest.mark.parametrize("value", ["0", "-1", str(129 * 1024**3)])
def test_disk_budget_requires_a_positive_value_below_fargate_limit(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    with pytest.raises(ConfigurationError, match="INGESTION_DISK_BUDGET_BYTES"):
        _settings(monkeypatch, INGESTION_DISK_BUDGET_BYTES=value)


def test_log_service_name_accepts_the_value_injected_by_terraform(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(monkeypatch, LOG_SERVICE_NAME="view-show-ingestion")

    assert settings.log_service_name == "view-show-ingestion"


@pytest.mark.parametrize("value", ("g05-s3-ingestion", "view-show-api", "", " view-show-ingestion"))
def test_log_service_name_rejects_any_name_outside_the_observability_contract(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    with pytest.raises(ConfigurationError, match="LOG_SERVICE_NAME"):
        _settings(monkeypatch, LOG_SERVICE_NAME=value)


@pytest.mark.parametrize(
    "value",
    (
        "ViewShow/Ingestion",
        "Ingestion",
        "outro-namespace/Ingestion",
        "view-show",
        "x" * 300,
        "view-show/Ingestion com espaco",
    ),
)
def test_metrics_namespace_rejects_anything_the_alarms_do_not_observe(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    with pytest.raises(ConfigurationError, match="METRICS_NAMESPACE"):
        _settings(monkeypatch, METRICS_NAMESPACE=value)


def test_metrics_namespace_accepts_the_value_injected_by_terraform(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(monkeypatch, METRICS_NAMESPACE="view-show/Ingestion")

    assert settings.metrics_namespace == "view-show/Ingestion"


def test_analysis_worker_settings_default_to_no_facts_and_the_trainer_model_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(monkeypatch, **REBUILD_ENV)

    assert settings.analysis_fact_catalog_location is None
    assert settings.analysis_forecast_model == DEFAULT_FORECAST_MODEL


def test_analysis_worker_settings_accept_a_catalog_and_the_model_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings(
        monkeypatch,
        **REBUILD_ENV,
        ANALYSIS_FACT_CATALOG_LOCATION="s3://bucket-ingestao/analysis/catalogs/abc.json",
        ANALYSIS_FORECAST_MODEL_NAME="qoe-random-forest",
        ANALYSIS_FORECAST_MODEL_VERSION="2026.09.2",
    )

    assert settings.analysis_fact_catalog_location == (
        "s3://bucket-ingestao/analysis/catalogs/abc.json"
    )
    assert settings.analysis_forecast_model == ForecastModel("qoe-random-forest", "2026.09.2")


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"ANALYSIS_FORECAST_MODEL_NAME": "modelo"}, "set together"),
        ({"ANALYSIS_FORECAST_MODEL_VERSION": "1"}, "set together"),
        (
            {"ANALYSIS_FORECAST_MODEL_NAME": "com espaço", "ANALYSIS_FORECAST_MODEL_VERSION": "1"},
            "identity is invalid",
        ),
        ({"ANALYSIS_FACT_CATALOG_LOCATION": "relativo/catalogo.json"}, "absolute path"),
        ({"ANALYSIS_FACT_CATALOG_LOCATION": "s3://bucket-ingestao"}, "object key"),
    ],
)
def test_analysis_worker_settings_reject_invalid_values(
    monkeypatch: pytest.MonkeyPatch, overrides: dict[str, str], message: str
) -> None:
    with pytest.raises(ConfigurationError, match=message):
        _settings(monkeypatch, **REBUILD_ENV, **overrides)


@pytest.mark.parametrize("configured", [False, True])
def test_projection_commands_resolve_the_fact_sink_only_with_a_catalog(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, configured: bool
) -> None:
    extra = {"ANALYSIS_FACT_CATALOG_LOCATION": "/catalogo.json"} if configured else {}
    rebuild = _settings(monkeypatch, **REBUILD_ENV, **extra)
    backfill = Settings.from_env(
        {**IMPORT_ENV, **SNAPSHOT_ENV, "ARCHIVE_WORKDIR": str(tmp_path), **extra},
        command="backfill",
    )
    for command, settings in (("rebuild-projections", rebuild), ("backfill", backfill)):
        factories = {name: object for name in container._capabilities(command, no_write=False)}
        factories["registry"] = DatasetRegistry.load_argus_v2
        factories["analysis_facts"] = object

        runtime = build_container(settings, factories=factories).resolve(command)

        assert ("analysis_facts" in runtime.dependencies) is configured, command


def test_analysis_worker_settings_treat_empty_values_as_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """O Terraform sempre declara estas variáveis; vazio significa desligado, não erro."""
    settings = _settings(
        monkeypatch,
        **REBUILD_ENV,
        ANALYSIS_FACT_CATALOG_LOCATION="",
        ANALYSIS_FORECAST_MODEL_NAME="",
        ANALYSIS_FORECAST_MODEL_VERSION="",
    )

    assert settings.analysis_fact_catalog_location is None
    assert settings.analysis_forecast_model == DEFAULT_FORECAST_MODEL


def test_analysis_worker_settings_still_reject_blank_whitespace_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(ConfigurationError, match="ANALYSIS_FACT_CATALOG_LOCATION"):
        _settings(monkeypatch, **REBUILD_ENV, ANALYSIS_FACT_CATALOG_LOCATION="  ")


@pytest.mark.parametrize(
    ("command", "environment"),
    [
        ("import-dump", IMPORT_ENV),
        ("backfill", {**IMPORT_ENV, **SNAPSHOT_ENV}),
    ],
)
def test_ecs_tasks_start_when_terraform_declares_the_analysis_variables_empty(
    command: str, environment: dict[str, str]
) -> None:
    """Reproduz a falha de partida do backfill e da importação em stacks sem o worker."""
    declared_by_terraform = {
        **environment,
        "ANALYSIS_FACT_CATALOG_LOCATION": "",
    }

    settings = Settings.from_env(declared_by_terraform, command=command)

    assert settings.analysis_fact_catalog_location is None
    assert settings.analysis_forecast_model == DEFAULT_FORECAST_MODEL
