"""Verify ingestion runs transition only through valid lifecycle stages."""

import pytest

from domain.run import RunPipeline, RunStage, RunState, allowed_transitions


def test_legacy_pipeline_remains_the_default_and_preserves_its_graph() -> None:
    run = RunState.start("run_1", "dsv_1")

    assert run.pipeline is RunPipeline.LEGACY_V1
    for stage in (
        RunStage.RESTORING,
        RunStage.VALIDATING,
        RunStage.INGESTING,
        RunStage.PROJECTING,
        RunStage.ARCHIVING,
        RunStage.ACTIVATING,
        RunStage.PUBLISHING,
        RunStage.SUCCEEDED,
    ):
        run = run.transition(stage)


def test_canonical_pipeline_accepts_only_canonical_first_graph() -> None:
    run = RunState.start("run_1", "dsv_1", pipeline=RunPipeline.CANONICAL_V2)
    for stage in (
        RunStage.RESTORING,
        RunStage.VALIDATING,
        RunStage.EXTRACTING,
        RunStage.ARCHIVING,
        RunStage.PROJECTING,
        RunStage.MATERIALIZING_HOT,
        RunStage.FINALIZING_CANDIDATE,
        RunStage.PUBLISHING,
        RunStage.SUCCEEDED,
    ):
        run = run.transition(stage)

    assert run.pipeline is RunPipeline.CANONICAL_V2
    assert RunStage.INGESTING not in allowed_transitions(
        RunPipeline.CANONICAL_V2, RunStage.VALIDATING
    )
    with pytest.raises(ValueError, match="EXTRACTING"):
        RunState.at(RunStage.VALIDATING, pipeline=RunPipeline.CANONICAL_V2).transition(
            RunStage.INGESTING
        )


@pytest.mark.parametrize(
    ("pipeline", "stage"),
    (
        (RunPipeline.CANONICAL_V2, RunStage.INGESTING),
        (RunPipeline.CANONICAL_V2, RunStage.ACTIVATING),
        (RunPipeline.LEGACY_V1, RunStage.EXTRACTING),
        (RunPipeline.LEGACY_V1, RunStage.MATERIALIZING_HOT),
        (RunPipeline.LEGACY_V1, RunStage.FINALIZING_CANDIDATE),
    ),
)
def test_run_state_rejects_stage_outside_its_pipeline_graph(
    pipeline: RunPipeline, stage: RunStage
) -> None:
    with pytest.raises(ValueError, match="is not valid for pipeline"):
        RunState.at(stage, pipeline=pipeline)


def test_run_cannot_activate_before_archive() -> None:
    run = RunState.start("run_1", "dsv_1")
    for stage in (RunStage.RESTORING, RunStage.VALIDATING, RunStage.INGESTING, RunStage.PROJECTING):
        run = run.transition(stage)
    with pytest.raises(ValueError, match="ARCHIVING"):
        run.transition(RunStage.ACTIVATING)


def test_publishing_failure_is_partial_without_rollback() -> None:
    run = RunState.at(RunStage.PUBLISHING, active_dataset_version="dsv_1")
    partial = run.transition(RunStage.PARTIAL)
    assert partial.active_dataset_version == "dsv_1"
    assert partial.stage is RunStage.PARTIAL


def test_full_run_graph_reaches_success() -> None:
    run = RunState("run_1", "dsv_1", RunStage.STARTING, "dsv_old")
    for stage in (
        RunStage.RESTORING,
        RunStage.VALIDATING,
        RunStage.INGESTING,
        RunStage.PROJECTING,
        RunStage.ARCHIVING,
        RunStage.ACTIVATING,
    ):
        run = run.transition(stage)
    assert run.active_dataset_version == "dsv_old"

    run = run.transition(RunStage.PUBLISHING, mark_candidate_active=True)
    assert run.active_dataset_version == "dsv_1"
    run = run.transition(RunStage.SUCCEEDED)
    assert run.stage is RunStage.SUCCEEDED
    assert run.active_dataset_version == "dsv_1"


def test_publishing_without_confirmed_activation_preserves_the_previous_pointer() -> None:
    run = RunState.at(
        RunStage.ACTIVATING,
        dataset_version="dsv_candidate",
        active_dataset_version="dsv_old",
    )

    publishing = run.transition(RunStage.PUBLISHING)

    assert publishing.active_dataset_version == "dsv_old"


def test_terminal_state_cannot_be_changed() -> None:
    with pytest.raises(ValueError, match="terminal"):
        RunState.start("run_1", "dsv_1").transition(RunStage.FAILED).transition(RunStage.STARTING)


def test_disabled_stage_is_terminal() -> None:
    with pytest.raises(ValueError, match="terminal"):
        RunState.at(RunStage.SKIPPED_DISABLED).transition(RunStage.STARTING)


@pytest.mark.parametrize(
    ("run_id", "dataset_version"),
    ((None, "dsv_1"), (1, "dsv_1"), ("", "dsv_1"), ("run_1", None), ("run_1", 1), ("run_1", "")),
)
def test_run_state_rejects_non_string_or_empty_identity(
    run_id: object, dataset_version: object
) -> None:
    with pytest.raises((TypeError, ValueError)):
        RunState(run_id, dataset_version, RunStage.STARTING)  # type: ignore[arg-type]


@pytest.mark.parametrize("active_dataset_version", ("", 1, None))
def test_run_state_active_version_is_none_or_non_empty_string(
    active_dataset_version: object,
) -> None:
    if active_dataset_version is None:
        RunState("run_1", "dsv_1", RunStage.STARTING, active_dataset_version)
    else:
        with pytest.raises((TypeError, ValueError)):
            RunState("run_1", "dsv_1", RunStage.STARTING, active_dataset_version)  # type: ignore[arg-type]


def test_run_state_at_does_not_mask_explicit_empty_version() -> None:
    with pytest.raises(ValueError, match="dataset_version"):
        RunState.at(RunStage.STARTING, dataset_version="")

    with pytest.raises(ValueError, match="active_dataset_version"):
        RunState.at(RunStage.STARTING, active_dataset_version="")
