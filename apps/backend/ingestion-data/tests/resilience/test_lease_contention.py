"""Verify concurrent ingestion workers enforce exclusive processing leases."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import boto3  # type: ignore[import-untyped]
import pytest
from moto import mock_aws

from adapters.dynamodb.control import DynamoControlProtocolError, DynamoControlRepository
from domain.run import RunPipeline, RunStage, RunState, RunTransitionMetadata
from ports import ConditionalWriteError, IdempotencyConflict, LeaseBusy, LeaseOwnershipError

NOW = datetime(2026, 9, 8, 12, 0, 0, 123456, tzinfo=UTC)
RUN_TTL_SECONDS = 90 * 24 * 60 * 60


def _table() -> object:
    client = boto3.client("dynamodb", region_name="us-east-1")
    client.create_table(
        TableName="hot",
        KeySchema=[
            {"AttributeName": "pk", "KeyType": "HASH"},
            {"AttributeName": "sk", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "pk", "AttributeType": "S"},
            {"AttributeName": "sk", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    return client


@pytest.mark.aws
@mock_aws
def test_second_owner_cannot_take_live_lease_but_can_take_expired_item() -> None:
    client = _table()
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    repository.acquire("argus", "run_a", NOW, 300, idempotency_key="lease-a")

    with pytest.raises(LeaseBusy):
        repository.acquire(
            "argus",
            "run_b",
            NOW + timedelta(seconds=1),
            300,
            idempotency_key="lease-b-too-soon",
        )

    acquired = repository.acquire(
        "argus",
        "run_b",
        NOW + timedelta(seconds=300),
        60,
        idempotency_key="lease-b",
    )
    assert acquired.owner == "run_b"
    item = client.get_item(
        TableName="hot",
        Key={"pk": {"S": "INGESTION#SOURCE#argus"}, "sk": {"S": "LEASE"}},
        ConsistentRead=True,
    )["Item"]
    assert int(item["ttl"]["N"]) == int(acquired.expires_at.timestamp())


@pytest.mark.aws
@mock_aws
def test_renew_requires_owner_expected_expiry_live_lease_and_strict_extension() -> None:
    client = _table()
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    lease = repository.acquire("argus", "run_a", NOW, 300, idempotency_key="lease-a")

    with pytest.raises(LeaseOwnershipError):
        repository.renew(
            "argus",
            "run_b",
            NOW + timedelta(seconds=1),
            600,
            expected_expires_at=lease.expires_at,
            idempotency_key="renew-other",
        )
    with pytest.raises(ConditionalWriteError, match="strictly"):
        repository.renew(
            "argus",
            "run_a",
            NOW + timedelta(seconds=1),
            10,
            expected_expires_at=lease.expires_at,
            idempotency_key="renew-shorter",
        )

    renewed = repository.renew(
        "argus",
        "run_a",
        NOW + timedelta(seconds=1),
        600,
        expected_expires_at=lease.expires_at,
        idempotency_key="renew-a",
    )
    assert renewed.expires_at > lease.expires_at
    with pytest.raises(LeaseOwnershipError):
        repository.renew(
            "argus",
            "run_a",
            NOW + timedelta(seconds=2),
            900,
            expected_expires_at=lease.expires_at,
            idempotency_key="renew-stale",
        )


@pytest.mark.aws
@mock_aws
def test_lease_replays_survive_release_and_repository_restart() -> None:
    client = _table()
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    original = repository.acquire("argus", "run_a", NOW, 300, idempotency_key="lease-a")
    repository.release("argus", "run_a", idempotency_key="release-a")

    restarted = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    assert restarted.acquire("argus", "run_a", NOW, 300, idempotency_key="lease-a") == original
    restarted.release("argus", "run_a", idempotency_key="release-a")
    assert "Item" not in client.get_item(
        TableName="hot",
        Key={"pk": {"S": "INGESTION#SOURCE#argus"}, "sk": {"S": "LEASE"}},
        ConsistentRead=True,
    )
    with pytest.raises(IdempotencyConflict):
        restarted.acquire("argus", "another", NOW, 300, idempotency_key="lease-a")


@pytest.mark.aws
@mock_aws
def test_failed_lease_operation_does_not_reserve_idempotency() -> None:
    client = _table()
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    repository.acquire("argus", "run_a", NOW, 1, idempotency_key="lease-a")

    with pytest.raises(LeaseBusy):
        repository.acquire("argus", "run_b", NOW, 30, idempotency_key="retryable")

    acquired = repository.acquire(
        "argus",
        "run_b",
        NOW + timedelta(seconds=1),
        30,
        idempotency_key="retryable",
    )
    assert acquired.owner == "run_b"


@pytest.mark.aws
@mock_aws
def test_run_transitions_errors_ttl_keys_and_durable_replay() -> None:
    client = _table()
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    starting = RunState("run_a", "dsv_new", RunStage.STARTING, "dsv_old")
    repository.create(starting, idempotency_key="create-run")
    validating = repository.transition(
        "run_a",
        RunStage.VALIDATING,
        expected_stage=RunStage.STARTING,
        idempotency_key="to-validating",
    )
    assert validating.active_dataset_version == "dsv_old"
    repository.append_error(
        "run_a",
        1,
        "schema source unavailable",
        expected_stage=RunStage.VALIDATING,
        idempotency_key="error-1",
    )
    ingesting = repository.transition(
        "run_a",
        RunStage.INGESTING,
        expected_stage=RunStage.VALIDATING,
        idempotency_key="to-ingesting",
    )

    restarted = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    assert (
        restarted.transition(
            "run_a",
            RunStage.VALIDATING,
            expected_stage=RunStage.STARTING,
            idempotency_key="to-validating",
        )
        == validating
    )
    assert ingesting.stage is RunStage.INGESTING

    meta = client.get_item(
        TableName="hot",
        Key={"pk": {"S": "INGESTION#RUN#run_a"}, "sk": {"S": "META"}},
        ConsistentRead=True,
    )["Item"]
    error = client.get_item(
        TableName="hot",
        Key={"pk": {"S": "INGESTION#RUN#run_a"}, "sk": {"S": "ERROR#1"}},
        ConsistentRead=True,
    )["Item"]
    expected_ttl = int(NOW.timestamp()) + RUN_TTL_SECONDS
    assert int(meta["ttl"]["N"]) == expected_ttl
    assert int(error["ttl"]["N"]) == expected_ttl

    with pytest.raises(ConditionalWriteError):
        restarted.append_error(
            "run_a",
            2,
            "stale stage",
            expected_stage=RunStage.VALIDATING,
            idempotency_key="stale-error",
        )


@pytest.mark.aws
@mock_aws
def test_run_pipeline_round_trips_and_missing_field_remains_legacy() -> None:
    client = _table()
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    canonical = RunState.start("run_v2", "dsv_new", pipeline=RunPipeline.CANONICAL_V2)

    repository.create(canonical, idempotency_key="create-v2")

    assert repository.get_run("run_v2") == canonical
    item = client.get_item(
        TableName="hot",
        Key={"pk": {"S": "INGESTION#RUN#run_v2"}, "sk": {"S": "META"}},
        ConsistentRead=True,
    )["Item"]
    assert item["pipeline"]["S"] == "canonical-v2"
    del item["pipeline"]
    client.put_item(TableName="hot", Item=item)
    assert repository.get_run("run_v2").pipeline is RunPipeline.LEGACY_V1


@pytest.mark.aws
@mock_aws
def test_run_hydration_rejects_stage_outside_persisted_pipeline_graph() -> None:
    client = _table()
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    canonical = RunState.start("run_v2", "dsv_new", pipeline=RunPipeline.CANONICAL_V2)
    repository.create(canonical, idempotency_key="create-v2")
    item = client.get_item(
        TableName="hot",
        Key={"pk": {"S": "INGESTION#RUN#run_v2"}, "sk": {"S": "META"}},
        ConsistentRead=True,
    )["Item"]
    item["stage"] = {"S": "INGESTING"}
    client.put_item(TableName="hot", Item=item)

    with pytest.raises(DynamoControlProtocolError, match="run item is invalid"):
        repository.get_run("run_v2")


@pytest.mark.aws
@mock_aws
def test_activation_transition_sets_candidate_pointer_and_rejects_invalid_domain_jump() -> None:
    client = _table()
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    state = RunState("run_a", "dsv_new", RunStage.STARTING, "dsv_old")
    repository.create(state, idempotency_key="create-run")
    for target in (
        RunStage.RESTORING,
        RunStage.VALIDATING,
        RunStage.INGESTING,
        RunStage.PROJECTING,
        RunStage.ARCHIVING,
    ):
        state = repository.transition(
            "run_a",
            target,
            expected_stage=state.stage,
            idempotency_key=f"to-{target.value.lower()}",
        )

    activated = repository.transition(
        "run_a",
        RunStage.ACTIVATING,
        expected_stage=RunStage.ARCHIVING,
        idempotency_key="activate",
    )
    assert activated.active_dataset_version == "dsv_old"

    publishing = repository.transition(
        "run_a",
        RunStage.PUBLISHING,
        expected_stage=RunStage.ACTIVATING,
        mark_candidate_active=True,
        idempotency_key="publishing",
    )
    assert publishing.active_dataset_version == "dsv_new"

    with pytest.raises(ValueError, match="invalid transition"):
        repository.transition(
            "run_a",
            RunStage.RESTORING,
            expected_stage=RunStage.PUBLISHING,
            idempotency_key="invalid-jump",
        )


@pytest.mark.aws
@mock_aws
def test_persisted_errors_are_redacted_and_utf8_byte_bounded() -> None:
    client = _table()
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    repository.create(RunState.start("run_a", "dsv_new"), idempotency_key="create-run")

    secret_message = (
        "connection=mysql://admin:p4ss@db/argus password=hunter2 token: abc123 "
        'payload={"viewer":"private-source-row"}'
    )
    repository.append_error(
        "run_a",
        1,
        secret_message,
        expected_stage=RunStage.STARTING,
        idempotency_key="secret-error",
    )
    repository.append_error(
        "run_a",
        2,
        "é" * 300_000,
        expected_stage=RunStage.STARTING,
        idempotency_key="large-error",
    )
    repository.append_error(
        "run_a",
        3,
        'request failed {"password":"json-secret","api_key":"key-secret"} '
        "Authorization: Bearer bearer-secret aws_secret_access_key=aws-secret",
        expected_stage=RunStage.STARTING,
        idempotency_key="json-error",
    )
    repository.append_error(
        "run_a",
        4,
        "restore MYSQL_PWD='mysql-secret' AWS_SESSION_TOKEN = session-secret "
        "-----BEGIN PRIVATE KEY-----\npem-secret\n-----END PRIVATE KEY-----",
        expected_stage=RunStage.STARTING,
        idempotency_key="environment-error",
    )

    def persisted(sequence: int) -> str:
        item = client.get_item(
            TableName="hot",
            Key={
                "pk": {"S": "INGESTION#RUN#run_a"},
                "sk": {"S": f"ERROR#{sequence}"},
            },
            ConsistentRead=True,
        )["Item"]
        return item["message"]["S"]

    sanitized = persisted(1)
    bounded = persisted(2)
    json_sanitized = persisted(3)
    environment_sanitized = persisted(4)
    assert "p4ss" not in sanitized
    assert "hunter2" not in sanitized
    assert "abc123" not in sanitized
    assert "private-source-row" not in sanitized
    assert "REDACTED" in sanitized
    assert len(bounded.encode("utf-8")) <= 4096
    assert bounded.endswith("[truncated]")
    assert "json-secret" not in json_sanitized
    assert "key-secret" not in json_sanitized
    assert "bearer-secret" not in json_sanitized
    assert "aws-secret" not in json_sanitized
    assert "mysql-secret" not in environment_sanitized
    assert "session-secret" not in environment_sanitized
    assert "pem-secret" not in environment_sanitized
    assert "PRIVATE KEY" not in environment_sanitized
    meta = client.get_item(
        TableName="hot",
        Key={"pk": {"S": "INGESTION#RUN#run_a"}, "sk": {"S": "META"}},
        ConsistentRead=True,
    )["Item"]
    assert int(meta["errorCount"]["N"]) == 4


@pytest.mark.aws
@mock_aws
def test_error_idempotency_fingerprints_only_the_sanitized_value() -> None:
    client = _table()
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    repository.create(RunState.start("run_a", "dsv_new"), idempotency_key="create-run")
    repository.append_error(
        "run_a",
        1,
        "database failed password=first-secret",
        expected_stage=RunStage.STARTING,
        idempotency_key="same-sanitized-error",
    )

    restarted = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    restarted.append_error(
        "run_a",
        1,
        "database failed password=second-secret",
        expected_stage=RunStage.STARTING,
        idempotency_key="same-sanitized-error",
    )


@pytest.mark.aws
@pytest.mark.parametrize(
    "stage", tuple(stage for stage in RunStage if stage is not RunStage.STARTING)
)
@mock_aws
def test_create_accepts_only_starting_and_invalid_attempt_does_not_reserve_key(
    stage: RunStage,
) -> None:
    client = _table()
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    pipeline = (
        RunPipeline.CANONICAL_V2
        if stage
        in {
            RunStage.EXTRACTING,
            RunStage.MATERIALIZING_HOT,
            RunStage.FINALIZING_CANDIDATE,
        }
        else RunPipeline.LEGACY_V1
    )

    with pytest.raises(ValueError, match="STARTING"):
        repository.create(
            RunState("run_a", "dsv_new", stage, pipeline=pipeline),
            idempotency_key="create-run",
        )

    assert (
        repository.create(
            RunState.start("run_a", "dsv_new"),
            idempotency_key="create-run",
        ).stage
        is RunStage.STARTING
    )


@pytest.mark.aws
@mock_aws
def test_run_meta_and_append_only_transition_history_preserve_audit_totals() -> None:
    client = _table()
    repository = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    repository.create(RunState.start("run_a", "dsv_new"), idempotency_key="create-run")
    first_metadata = RunTransitionMetadata(
        transitioned_at=NOW + timedelta(seconds=10),
        duration_ms=250,
        records_read=10,
        records_written=8,
        records_rejected=2,
        error="validation failed password=private-value",
        substage="SKIPPED_BY_POLICY",
        units_completed=0,
        units_total=0,
        unit_label="datasets",
    )
    first = repository.transition(
        "run_a",
        RunStage.VALIDATING,
        expected_stage=RunStage.STARTING,
        metadata=first_metadata,
        idempotency_key="to-validating",
    )
    second = repository.transition(
        "run_a",
        RunStage.INGESTING,
        expected_stage=RunStage.VALIDATING,
        metadata=RunTransitionMetadata(
            transitioned_at=NOW + timedelta(seconds=20),
            duration_ms=50,
            records_read=3,
            records_written=3,
            records_rejected=0,
        ),
        idempotency_key="to-ingesting",
    )

    legacy_fingerprint = repository._fingerprint(  # type: ignore[attr-defined]
        {
            "runId": "run_a",
            "target": "INGESTING",
            "expectedStage": "VALIDATING",
            "metadata": {
                "transitionedAt": "2026-09-08T12:00:20.123456Z",
                "durationMs": 50,
                "recordsRead": 3,
                "recordsWritten": 3,
                "recordsRejected": 0,
                "error": None,
            },
            "markCandidateActive": False,
        }
    )
    client.update_item(
        TableName="hot",
        Key={
            "pk": {
                "S": repository._idempotency_pk(  # type: ignore[attr-defined]
                    "run-transition", "to-ingesting"
                )
            },
            "sk": {"S": "META"},
        },
        UpdateExpression="SET fingerprint = :fingerprint",
        ExpressionAttributeValues={":fingerprint": {"S": legacy_fingerprint}},
    )

    restarted = DynamoControlRepository(client, "hot", clock=lambda: NOW)
    assert (
        restarted.transition(
            "run_a",
            RunStage.VALIDATING,
            expected_stage=RunStage.STARTING,
            metadata=first_metadata,
            idempotency_key="to-validating",
        )
        == first
    )
    assert (
        restarted.transition(
            "run_a",
            RunStage.INGESTING,
            expected_stage=RunStage.VALIDATING,
            metadata=RunTransitionMetadata(
                transitioned_at=NOW + timedelta(seconds=20),
                duration_ms=50,
                records_read=3,
                records_written=3,
                records_rejected=0,
            ),
            idempotency_key="to-ingesting",
        )
        == second
    )

    meta = client.get_item(
        TableName="hot",
        Key={"pk": {"S": "INGESTION#RUN#run_a"}, "sk": {"S": "META"}},
        ConsistentRead=True,
    )["Item"]
    first_audit = client.get_item(
        TableName="hot",
        Key={"pk": {"S": "INGESTION#RUN#run_a"}, "sk": {"S": "TRANSITION#1"}},
        ConsistentRead=True,
    )["Item"]
    second_audit = client.get_item(
        TableName="hot",
        Key={"pk": {"S": "INGESTION#RUN#run_a"}, "sk": {"S": "TRANSITION#2"}},
        ConsistentRead=True,
    )["Item"]

    assert second.stage is RunStage.INGESTING
    assert meta["createdAt"]["S"] == "2026-09-08T12:00:00.123456Z"
    assert meta["updatedAt"]["S"] == "2026-09-08T12:00:20.123456Z"
    assert int(meta["transitionCount"]["N"]) == 2
    assert int(meta["totalDurationMs"]["N"]) == 300
    assert int(meta["recordsRead"]["N"]) == 13
    assert int(meta["recordsWritten"]["N"]) == 11
    assert int(meta["recordsRejected"]["N"]) == 2
    assert int(meta["errorCount"]["N"]) == 1
    assert first_audit["fromStage"]["S"] == "STARTING"
    assert first_audit["toStage"]["S"] == "VALIDATING"
    assert int(first_audit["durationMs"]["N"]) == 250
    assert int(first_audit["recordsRead"]["N"]) == 10
    assert "private-value" not in first_audit["error"]["S"]
    assert "REDACTED" in first_audit["error"]["S"]
    assert first_audit["substage"]["S"] == "SKIPPED_BY_POLICY"
    assert int(first_audit["unitsCompleted"]["N"]) == 0
    assert int(first_audit["unitsTotal"]["N"]) == 0
    assert first_audit["unitLabel"]["S"] == "datasets"
    assert second_audit["fromStage"]["S"] == "VALIDATING"
    assert second_audit["toStage"]["S"] == "INGESTING"
