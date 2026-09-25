"""Verify ingestion CLI parsing and command dispatch behavior."""

import json
from argparse import Namespace
from types import SimpleNamespace

import pytest

import bootstrap.cli as cli
from application.reprocess import ReprocessResult
from application.sync import SyncResult
from bootstrap.cli import build_parser, main
from bootstrap.config import ConfigurationError
from domain.run import RunStage


def test_cli_exposes_only_batch_commands() -> None:
    parser = build_parser()
    choices = parser._subparsers._group_actions[0].choices
    assert tuple(choices) == (
        "validate",
        "backfill",
        "import-dump",
        "sync",
        "reprocess",
        "rebuild-projections",
        "publish-outbox",
        "export-incremental",
        "ingest-incremental",
    )


def test_import_dump_requires_a_valid_import_id_and_forbids_activation():
    identifier = "imp_01K59Z5XE00000000000000000"
    arguments = build_parser().parse_args(["import-dump", "--import-id", identifier])
    assert arguments.import_id == identifier
    for tail in (
        [],
        ["--import-id", "../bad"],
        ["--import-id", identifier, "--activate"],
        ["--import-id", identifier, "--run-id", "override"],
    ):
        with pytest.raises(SystemExit):
            build_parser().parse_args(["import-dump", *tail])


def test_validate_exposes_explicit_no_write_flag() -> None:
    arguments = build_parser().parse_args(["validate", "--no-write"])

    assert arguments.no_write is True


def test_incremental_commands_are_explicit_and_batch_only() -> None:
    """Removing either batch command or its bounded limit must fail this contract."""
    parser = build_parser()

    assert parser.parse_args(["export-incremental"]).command == "export-incremental"
    parsed = parser.parse_args(["ingest-incremental", "--limit", "20"])
    assert parsed.command == "ingest-incremental"
    assert parsed.limit == 20


def test_backfill_accepts_only_a_bounded_explicit_run_id() -> None:
    arguments = build_parser().parse_args(["backfill", "--run-id", "backfill-abc_123"])
    assert arguments.run_id == "backfill-abc_123"

    for value in ("", " run", "run#1", "a" * 129):
        with pytest.raises(SystemExit):
            build_parser().parse_args(["backfill", "--run-id", value])

    with pytest.raises(SystemExit):
        build_parser().parse_args(["sync", "--run-id", "backfill-abc"])


def test_rebuild_accepts_explicit_persisted_partition_evidence() -> None:
    arguments = build_parser().parse_args(
        [
            "rebuild-projections",
            "--dataset-version",
            "dsv_test",
            "--partition-key",
            "DATASET#dsv_test#FACT#TS#signal_bucket#20260909",
            "--archive-partition",
            "signal_bucket=year=2026/month=09/day=09",
        ]
    )

    assert arguments.partition_keys == ["DATASET#dsv_test#FACT#TS#signal_bucket#20260909"]
    assert arguments.archive_partitions == ["signal_bucket=year=2026/month=09/day=09"]


def test_publish_limit_rejects_non_positive_values_before_runtime_resolution() -> None:
    with pytest.raises(SystemExit) as raised:
        build_parser().parse_args(["publish-outbox", "--limit", "0"])

    assert raised.value.code == 2


@pytest.mark.parametrize(
    "argv",
    [
        ["MYSQL_PASSWORD=invalid-command-secret"],
        ["validate", "--unknown=MYSQL_PASSWORD=unknown-flag-secret"],
        [
            "reprocess",
            "--dataset",
            "MYSQL_PASSWORD=missing-argument-secret",
            "--start",
            "2026-09-09T12:00:00Z",
        ],
    ],
    ids=("invalid-command", "unknown-flag", "missing-argument"),
)
def test_parser_errors_are_one_redacted_json_line(
    argv: list[str], capsys: pytest.CaptureFixture[str]
) -> None:
    with pytest.raises(SystemExit) as raised:
        build_parser().parse_args(argv)

    captured = capsys.readouterr()
    lines = captured.err.splitlines()
    assert raised.value.code == 2
    assert captured.out == ""
    assert len(lines) == 1
    assert "secret" not in captured.err
    record = json.loads(lines[0])
    assert record["event"] == "ingestion.command.invalid"
    assert record["errorCode"] == "ArgumentError"
    assert record["message"] == "invalid command arguments"


def test_parser_help_preserves_standard_success_output(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as raised:
        build_parser().parse_args(["--help"])

    captured = capsys.readouterr()
    assert raised.value.code == 0
    assert captured.err == ""
    assert captured.out.startswith("usage: data-ingestion")
    assert "publish-outbox" in captured.out


def test_cli_resolves_only_selected_handler_and_preserves_success_exit_code() -> None:
    resolved: list[str] = []
    handled: list[str] = []

    def factory(command: str):  # type: ignore[no-untyped-def]
        resolved.append(command)

        def handler(arguments: Namespace) -> None:
            handled.append(arguments.command)

        return handler

    assert main(["publish-outbox", "--limit", "7"], handler_factory=factory) == 0
    assert resolved == ["publish-outbox"]
    assert handled == ["publish-outbox"]


@pytest.mark.parametrize("stage", [RunStage.PARTIAL, RunStage.FAILED])
def test_cli_returns_operational_failure_for_failed_or_partial_result(stage: RunStage) -> None:
    def factory(_command: str):  # type: ignore[no-untyped-def]
        return lambda _arguments: SimpleNamespace(stage=stage)

    assert main(["backfill", "--run-id", "backfill-test"], handler_factory=factory) == 1


@pytest.mark.parametrize("stage", [RunStage.SKIPPED_DISABLED, RunStage.SKIPPED_LOCKED])
@pytest.mark.parametrize("command", ["sync", "reprocess"])
def test_cli_returns_success_for_terminal_skips_from_real_results(
    command: str, stage: RunStage
) -> None:
    result = (
        SyncResult({}, {}, 0, stage=stage)
        if command == "sync"
        else ReprocessResult("signal_bucket", 0, 0, 0, stage=stage)
    )
    argv = [command]
    if command == "reprocess":
        argv.extend(
            [
                "--dataset",
                "signal_bucket",
                "--start",
                "2026-09-01T00:00:00Z",
                "--end",
                "2026-09-01T00:15:00Z",
            ]
        )

    assert main(argv, handler_factory=lambda _command: lambda _arguments: result) == 0


def test_cli_sanitizes_handler_failures_and_uses_stable_exit_code(capsys) -> None:
    def factory(_command: str):  # type: ignore[no-untyped-def]
        def fail(_arguments: Namespace) -> None:
            raise RuntimeError("MYSQL_PWD=not-for-logs")

        return fail

    assert main(["validate"], handler_factory=factory) == 1
    captured = capsys.readouterr()
    record = json.loads(captured.err)
    assert captured.out == ""
    assert "not-for-logs" not in captured.err
    assert record["event"] == "ingestion.run.failed"
    assert record["errorCode"] == "RuntimeError"


def test_cli_reports_missing_runtime_composition_as_configuration_failure(capsys) -> None:
    assert main(["validate"], handler_factory=None) == 2
    assert "configuration" in capsys.readouterr().err.lower()


def test_cli_emits_redacted_json_when_configuration_fails_before_runtime(capsys) -> None:
    sentinel = "cli-secret-sentinel"

    def factory(_command: str):  # type: ignore[no-untyped-def]
        def fail(_arguments: Namespace) -> None:
            raise ConfigurationError(f"MYSQL_PASSWORD={sentinel}")

        return fail

    assert main(["validate"], handler_factory=factory) == 2
    captured = capsys.readouterr()
    record = json.loads(captured.err)
    assert captured.out == ""
    assert sentinel not in captured.err
    assert record["event"] == "ingestion.run.failed"
    assert record["command"] == "validate"
    assert record["errorCode"] == "ConfigurationError"
    assert record["message"] == "MYSQL_PASSWORD=[REDACTED]"


def test_cli_defensively_renders_an_exception_with_broken_string_conversion(capsys) -> None:
    class BrokenStringError(RuntimeError):
        def __str__(self) -> str:
            raise SystemExit("must not escape")

    def factory(_command: str):  # type: ignore[no-untyped-def]
        def fail(_arguments: Namespace) -> None:
            raise BrokenStringError()

        return fail

    assert main(["validate"], handler_factory=factory) == 1
    record = json.loads(capsys.readouterr().err)
    assert record["errorCode"] == "BrokenStringError"
    assert record["message"] == "BrokenStringError"


def test_cli_builds_default_runtime_for_only_the_selected_command(monkeypatch) -> None:
    calls: list[object] = []
    settings = object()

    class Runtime:
        handler = staticmethod(lambda arguments: calls.append(("handled", arguments.command)))

    class Container:
        def resolve(self, command: str, *, no_write: bool = False) -> Runtime:
            calls.append(("resolved", command, no_write))
            return Runtime()

    def from_env(*, command: str, no_write: bool = False) -> object:
        calls.append(("settings", command, no_write))
        return settings

    monkeypatch.setattr(cli.Settings, "from_env", staticmethod(from_env))

    def container_for(value: object) -> Container | None:
        return Container() if value is settings else None

    monkeypatch.setattr(cli, "build_container", container_for)

    assert main(["validate", "--no-write"]) == 0
    assert calls == [
        ("settings", "validate", True),
        ("resolved", "validate", True),
        ("handled", "validate"),
    ]
