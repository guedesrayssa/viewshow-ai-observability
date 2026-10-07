"""Verify reprocessing runtime configuration enforces source contract requirements."""

from __future__ import annotations

from argparse import Namespace
from collections.abc import Callable
from datetime import UTC, datetime

import pytest

import bootstrap.cli as cli
from bootstrap.config import ConfigurationError, Settings
from bootstrap.container import build_container
from contracts.registry import DatasetRegistry
from domain.identity import canonical_dataset_version, dataset_version
from domain.run import RunPipeline, RunStage
from tests.fakes import (
    FakeHotRecordSink,
    FakeIngestionBackend,
    FakeLeaseRepository,
    FakeLiveSyncConfiguration,
    FakeLogger,
    FakeManifestRepository,
    FakeMetricsPublisher,
    FakeSourceReader,
    valid_active_manifest,
)


@pytest.mark.parametrize("response", [{}, {"Item": {"enabled": {"S": "true"}}}, None])
def test_reprocess_runtime_checks_dynamo_before_resolving_dependencies(response) -> None:
    from adapters.dynamodb import DynamoControlProtocolError, DynamoLiveSyncConfiguration

    class Client:
        calls = 0

        def get_item(self, **kwargs):
            self.calls += 1
            if response is None:
                raise RuntimeError("DynamoDB unavailable")
            return response

    def forbidden() -> object:
        raise AssertionError("disabled runtime must not resolve effectful dependencies")

    client = Client()
    runtime = build_container(
        Settings.from_env(_live_environment(), command="reprocess"),
        factories={
            "registry": DatasetRegistry.load_argus_v2,
            "live_sync_configuration": lambda: DynamoLiveSyncConfiguration(client, "operational"),
            "live_reader": forbidden,
            "hot_sink": forbidden,
            "control": forbidden,
            "telemetry": object,
        },
    ).resolve("reprocess")
    arguments = Namespace(
        command="reprocess",
        dataset="unknown",
        start="2026-09-01T00:00:00Z",
        end="2026-09-01T00:15:00Z",
    )
    if response == {}:
        result = runtime.handler(arguments)
        assert result.stage is RunStage.SKIPPED_DISABLED
        assert (result.records_read, result.records_written, result.records_unchanged) == (0, 0, 0)
    else:
        with pytest.raises(DynamoControlProtocolError):
            runtime.handler(arguments)
    assert client.calls == 1


def _live_environment() -> dict[str, str]:
    return {
        "ARGUS_SOURCE_MODE": "live",
        "LIVE_MYSQL_HOST": "argus.internal",
        "LIVE_MYSQL_PORT": "3306",
        "LIVE_MYSQL_USER": "argus-reader",
        "LIVE_MYSQL_PASSWORD": "live-secret-sentinel",
        "LIVE_MYSQL_DATABASE": "argus",
        "OPERATIONAL_TABLE_NAME": "view-show-operacional",
    }


def _snapshot_environment() -> dict[str, str]:
    return {
        "ARGUS_SOURCE_MODE": "snapshot",
        "SNAPSHOT_BUCKET": "view-show-snapshots",
        "SNAPSHOT_OBJECT_KEY": "argus/dump.sql.gz",
        "SNAPSHOT_OBJECT_VERSION_ID": "version-1",
        "SNAPSHOT_SHA256": "a" * 64,
        "SNAPSHOT_EXTRACTED_ON": "2026-09-01",
        "MYSQL_HOST": "127.0.0.1",
        "MYSQL_USER": "snapshot-reader",
        "MYSQL_PASSWORD": "snapshot-secret-sentinel",
        "MYSQL_DATABASE": "argus",
        "OPERATIONAL_TABLE_NAME": "view-show-operacional",
    }


@pytest.mark.parametrize(
    ("environment", "expected_message"),
    (({"ARGUS_SOURCE_MODE": "snapshot"}, "reprocess requires ARGUS_SOURCE_MODE=live"),),
    ids=("snapshot",),
)
def test_cli_rejects_non_live_reprocess_before_runtime_construction(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    environment: dict[str, str],
    expected_message: str,
) -> None:
    for name in set(_snapshot_environment()) | set(_live_environment()):
        monkeypatch.delenv(name, raising=False)
    for name, value in environment.items():
        monkeypatch.setenv(name, value)

    def forbidden_container(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("configuration must fail before runtime construction")

    monkeypatch.setattr(cli, "build_container", forbidden_container)

    exit_code = cli.main(
        [
            "reprocess",
            "--dataset",
            "signal_bucket",
            "--start",
            "2026-09-01T00:00:00Z",
            "--end",
            "2026-09-01T00:15:00Z",
        ]
    )

    captured = capsys.readouterr()
    assert exit_code == cli.CONFIGURATION_FAILURE
    assert expected_message in captured.err
    assert "secret-sentinel" not in captured.err


@pytest.mark.parametrize("dataset", ("signal_meta", "live_event_sde"))
def test_reprocess_runtime_keeps_live_reader_lazy_for_snapshot_date_dataset(
    dataset: str,
) -> None:
    settings = Settings.from_env(_live_environment(), command="reprocess")
    built: list[str] = []

    def forbidden_factory(name: str) -> Callable[[], object]:
        def create() -> object:
            built.append(name)
            raise AssertionError(f"{name} must remain lazy for an ineligible dataset")

        return create

    runtime = build_container(
        settings,
        factories={
            "registry": DatasetRegistry.load_argus_v2,
            "live_sync_configuration": lambda: FakeLiveSyncConfiguration(True),
            "live_reader": forbidden_factory("live_reader"),
            "hot_sink": forbidden_factory("hot_sink"),
            "control": forbidden_factory("control"),
            "telemetry": object,
        },
    ).resolve("reprocess")

    assert built == []
    with pytest.raises(ValueError, match="bounded live-window reprocess"):
        runtime.handler(
            Namespace(
                command="reprocess",
                dataset=dataset,
                start="2026-09-01T00:00:00Z",
                end="2026-09-01T00:15:00Z",
            )
        )
    assert built == []


def test_reprocess_runtime_constructs_effectful_dependencies_only_for_eligible_live_dataset() -> (
    None
):
    settings = Settings.from_env(_live_environment(), command="reprocess")
    registry = DatasetRegistry.load_argus_v2()
    snapshot = registry.snapshot
    version = dataset_version(
        str(snapshot["sourceSystem"]),
        "a" * 64,
        str(snapshot["physicalContractVersion"]),
        str(snapshot["canonicalSchemaVersion"]),
    )
    active = valid_active_manifest(
        registry.names(),
        version,
        source_watermark=datetime(2026, 9, 1, tzinfo=UTC),
        physical_contract_version=str(snapshot["physicalContractVersion"]),
        canonical_schema_version=str(snapshot["canonicalSchemaVersion"]),
    )
    built: list[str] = []
    metrics = FakeMetricsPublisher()
    telemetry = {"logger": FakeLogger(), "metrics": metrics}

    def factory(name: str, value: object) -> Callable[[], object]:
        def create() -> object:
            built.append(name)
            return value

        return create

    runtime = build_container(
        settings,
        factories={
            "registry": lambda: registry,
            "live_sync_configuration": lambda: FakeLiveSyncConfiguration(True),
            "manifests": factory("manifests", FakeManifestRepository(active)),
            "live_reader": factory("live_reader", FakeSourceReader({"signal_bucket": ()})),
            "hot_sink": factory("hot_sink", FakeHotRecordSink()),
            "control": factory("control", FakeLeaseRepository()),
            "telemetry": lambda: telemetry,
        },
    ).resolve("reprocess")

    assert built == []
    result = runtime.handler(
        Namespace(
            command="reprocess",
            dataset="signal_bucket",
            start="2026-09-01T00:00:00Z",
            end="2026-09-01T00:15:00Z",
        )
    )

    assert result.stage is RunStage.SUCCEEDED
    assert built == ["manifests", "hot_sink", "control", "live_reader"]
    assert any(
        name == "Runs"
        and dimensions
        == {
            "command": "reprocess",
            "dataset": "signal_bucket",
            "source_mode": "live",
            "status": "SUCCEEDED",
        }
        for _kind, name, _value, dimensions in metrics.measurements
    )


@pytest.mark.parametrize("pipeline", tuple(RunPipeline))
def test_reprocess_runtime_writes_only_to_the_active_dataset_representation(
    pipeline: RunPipeline,
) -> None:
    settings = Settings.from_env(_live_environment(), command="reprocess")
    registry = DatasetRegistry.load_argus_v2()
    snapshot = registry.snapshot
    checksum = "a" * 64
    version_factory = (
        canonical_dataset_version if pipeline is RunPipeline.CANONICAL_V2 else dataset_version
    )
    version = version_factory(
        str(snapshot["sourceSystem"]),
        checksum,
        str(snapshot["physicalContractVersion"]),
        str(snapshot["canonicalSchemaVersion"]),
    )
    active = valid_active_manifest(
        registry.names(),
        version,
        source_watermark=datetime(2026, 9, 1, tzinfo=UTC),
        physical_contract_version=str(snapshot["physicalContractVersion"]),
        canonical_schema_version=str(snapshot["canonicalSchemaVersion"]),
        dump_checksum_sha256=checksum,
        pipeline=pipeline,
    )
    backend = FakeIngestionBackend()
    hot_sink = FakeHotRecordSink(backend)
    reader = FakeSourceReader(
        {
            "signal_bucket": (
                {
                    "bts": int(datetime(2026, 9, 1, tzinfo=UTC).timestamp() * 1000),
                    "source": "probe",
                    "entity": "edge-1",
                    "metric": "latency",
                    "value": 12.5,
                },
            )
        }
    )
    runtime = build_container(
        settings,
        factories={
            "registry": lambda: registry,
            "live_sync_configuration": lambda: FakeLiveSyncConfiguration(True),
            "live_reader": lambda: reader,
            "hot_sink": lambda: hot_sink,
            "control": FakeLeaseRepository,
            "manifests": lambda: FakeManifestRepository(active),
            "telemetry": object,
        },
    ).resolve("reprocess")

    result = runtime.handler(
        Namespace(
            command="reprocess",
            dataset="signal_bucket",
            start="2026-09-01T00:00:00Z",
            end="2026-09-01T00:15:00Z",
        )
    )

    assert result.stage is RunStage.SUCCEEDED
    assert {key[0] for key in backend.fact_records} == {version}


def test_reprocess_settings_reject_snapshot_mode_without_requiring_snapshot_mysql() -> None:
    with pytest.raises(ConfigurationError, match="reprocess requires ARGUS_SOURCE_MODE=live"):
        Settings.from_env({"ARGUS_SOURCE_MODE": "snapshot"}, command="reprocess")
