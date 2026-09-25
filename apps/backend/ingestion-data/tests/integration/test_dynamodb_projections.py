"""Verify projection persistence and lookup through a DynamoDB boundary."""

from __future__ import annotations

import hashlib
import threading
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import boto3  # type: ignore[import-untyped]
import pytest
from moto import mock_aws

from adapters.dynamodb.codec import serialize_item
from adapters.dynamodb.manifests import DynamoManifestRepository
from adapters.dynamodb.projections import DynamoProjectionRepository
from domain.canonical_json import canonical_bytes
from ports import ArchiveDependency, ConditionalWriteError, IdempotencyConflict, Projection
from tests.fakes import valid_active_manifest

DAY = datetime(2026, 9, 8, tzinfo=UTC)
PARTITION = "year=2026/month=09/day=08"


def table() -> Any:
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


def freeze_projections(client: Any, dataset_version: str = "dsv_abc") -> None:
    client.put_item(
        TableName="hot",
        Item=serialize_item(
            {
                "pk": f"DATASET#{dataset_version}#INGESTION#PROJECTION_FENCE",
                "sk": "ACTIVE",
                "entityType": "ACTIVE_PROJECTION_FENCE",
                "datasetVersion": dataset_version,
            }
        ),
    )


class FenceRaceClient:
    def __init__(self, client: Any) -> None:
        self._client = client
        self._barrier = threading.Barrier(2)
        # Moto's in-memory table mutates a shared dictionary while applying a
        # transaction. Keep the two callers concurrent up to the fence, then
        # serialize only the emulator call so the test observes DynamoDB's
        # conditional-write outcome instead of an emulator data race.
        self._transaction_lock = threading.Lock()

    def get_item(self, **kwargs: object) -> Any:
        return self._client.get_item(**kwargs)

    def query(self, **kwargs: object) -> Any:
        return self._client.query(**kwargs)

    def transact_write_items(self, **kwargs: object) -> Any:
        actions = kwargs["TransactItems"]
        assert isinstance(actions, list)
        fence_action = any(
            (
                action.get("ConditionCheck", {}).get("Key", {}).get("pk", {}).get("S")
                == "DATASET#dsv_abc#INGESTION#PROJECTION_FENCE"
            )
            or (
                action.get("Put", {}).get("Item", {}).get("pk", {}).get("S")
                == "DATASET#dsv_abc#INGESTION#PROJECTION_FENCE"
            )
            for action in actions
            if isinstance(action, dict)
        )
        if fence_action:
            self._barrier.wait(timeout=5)
        with self._transaction_lock:
            return self._client.transact_write_items(**kwargs)


def projection(
    version: str,
    key: str = "OVERVIEW#GLOBAL",
    *,
    observed_through: datetime = DAY,
) -> Projection:
    common: dict[str, object] = {
        "projectionVersion": version,
        "formulaVersion": "1.0",
        "inputWatermarks": {
            "geo_hourly": observed_through,
            "live_qoe_hourly": observed_through,
        },
        "observedThrough": observed_through,
        "coverage": "complete",
        "qualityFlags": (),
    }
    specific: dict[str, object] = (
        {
            "incidents": (
                {
                    "incidentId": "inc_pnidg23fnrf2yaddm5ttipxc55",
                    "number": "INC001",
                    "openedAt": DAY,
                    "state": "open",
                    "priority": "P2",
                },
            )
        }
        if key == "INCIDENTS#ACTIVE"
        else {
            "metrics": {
                "sessions": 4,
                "errors": 1,
                "startupErrors": None,
                "botErrors": None,
                "humanErrors": None,
                "errorRate": Decimal("0.25"),
            }
        }
    )
    return Projection(
        "dsv_abc",
        "DAY#20260908",
        key,
        version,
        (
            ArchiveDependency("geo_hourly", PARTITION),
            ArchiveDependency("live_qoe_hourly", PARTITION),
        ),
        {**common, **specific},
    )


def overview_target(
    observed_through: datetime,
    sessions: int,
    *,
    dependencies: tuple[ArchiveDependency, ...] = (
        ArchiveDependency("geo_hourly", PARTITION),
        ArchiveDependency("live_qoe_hourly", PARTITION),
    ),
) -> Projection:
    return Projection(
        "dsv_abc",
        "DAY#20260908",
        "OVERVIEW#GLOBAL",
        "1.0",
        dependencies,
        {
            "projectionVersion": "1.0",
            "formulaVersion": "1.0",
            "inputWatermarks": {
                dependency.dataset: observed_through for dependency in dependencies
            },
            "observedThrough": observed_through,
            "coverage": "complete",
            "qualityFlags": (),
            "metrics": {
                "sessions": sessions,
                "errors": 1,
                "startupErrors": None,
                "botErrors": None,
                "humanErrors": None,
                "errorRate": Decimal(1) / Decimal(sessions),
            },
        },
    )


def active_set(
    priority: str | None,
    *,
    observed_through: datetime = DAY,
    partition: str = PARTITION,
) -> Projection:
    incidents: tuple[dict[str, object], ...] = ()
    if priority is not None:
        incidents = (
            {
                "incidentId": "inc_pnidg23fnrf2yaddm5ttipxc55",
                "number": "INC001",
                "openedAt": DAY,
                "state": "open",
                "priority": priority,
            },
        )
    return Projection(
        "dsv_abc",
        f"DAY#{observed_through:%Y%m%d}",
        "INCIDENTS#ACTIVE",
        "1.0",
        (ArchiveDependency("incidents", partition),),
        {
            "projectionVersion": "1.0",
            "formulaVersion": "1.0",
            "inputWatermarks": {"incidents": observed_through},
            "observedThrough": observed_through,
            "coverage": "complete",
            "qualityFlags": (),
            "incidents": incidents,
        },
    )


@pytest.mark.aws
@mock_aws
def test_projection_cas_is_durable_across_repository_restarts() -> None:
    client = table()
    first = DynamoProjectionRepository(client, "hot", clock=lambda: DAY)
    version_one = overview_target(DAY, 4)
    first.put(version_one, expected_projection_version=None, idempotency_key="p1")

    restarted = DynamoProjectionRepository(client, "hot", clock=lambda: DAY)
    restarted.put(version_one, expected_projection_version=None, idempotency_key="p1")
    with pytest.raises(IdempotencyConflict):
        restarted.put(
            overview_target(DAY, 5),
            expected_projection_version="1.0",
            expected_materialization_revision=version_one.materialization_revision,
            idempotency_key="p1",
        )

    version_two = overview_target(DAY, 5)
    restarted.put(
        version_two,
        expected_projection_version="1.0",
        expected_materialization_revision=version_one.materialization_revision,
        idempotency_key="p2",
    )
    with pytest.raises(ConditionalWriteError, match="expected"):
        restarted.put(
            overview_target(DAY, 6),
            expected_projection_version="1.0",
            expected_materialization_revision=version_one.materialization_revision,
            idempotency_key="stale",
        )

    response = client.query(
        TableName="hot",
        KeyConditionExpression="pk = :pk",
        ExpressionAttributeValues={":pk": {"S": "DATASET#dsv_abc#VIEW#OVERVIEW#GLOBAL#20260908"}},
    )
    assert response["Count"] == 3
    assert {item["sk"]["S"] for item in response["Items"]} == {
        "T#1788825600000",
        f"REVISION#{version_one.materialization_revision}",
        f"REVISION#{version_two.materialization_revision}",
    }
    versioned = next(item for item in response["Items"] if item["sk"]["S"] == "T#1788825600000")
    assert versioned["partition"]["S"] == PARTITION
    assert versioned["projectionPartitionKey"]["S"] == "DAY#20260908"


@pytest.mark.aws
@mock_aws
def test_active_projection_fence_rejects_direct_put_replay_and_refresh_without_mutation() -> None:
    client = table()
    repository = DynamoProjectionRepository(client, "hot", clock=lambda: DAY)
    original = overview_target(DAY, 4)
    freeze_projections(client)

    with pytest.raises(ConditionalWriteError, match="active"):
        repository.put(original, expected_projection_version=None, idempotency_key="active-direct")

    target_pk = "DATASET#dsv_abc#VIEW#OVERVIEW#GLOBAL#20260908"
    assert (
        client.query(
            TableName="hot",
            KeyConditionExpression="pk = :pk",
            ExpressionAttributeValues={":pk": {"S": target_pk}},
        )["Count"]
        == 0
    )

    client.delete_item(
        TableName="hot",
        Key={
            "pk": {"S": "DATASET#dsv_abc#INGESTION#PROJECTION_FENCE"},
            "sk": {"S": "ACTIVE"},
        },
    )
    repository.put(original, expected_projection_version=None, idempotency_key="before-active")
    freeze_projections(client)
    before = client.query(
        TableName="hot",
        KeyConditionExpression="pk = :pk",
        ExpressionAttributeValues={":pk": {"S": target_pk}},
    )["Items"]

    with pytest.raises(ConditionalWriteError, match="active"):
        repository.put(original, expected_projection_version=None, idempotency_key="before-active")
    with pytest.raises(ConditionalWriteError, match="active"):
        repository.put(
            original,
            expected_projection_version="1.0",
            expected_materialization_revision=original.materialization_revision,
            idempotency_key="active-noop",
        )
    with pytest.raises(ConditionalWriteError, match="active"):
        repository.put(
            overview_target(DAY, 5),
            expected_projection_version="1.0",
            expected_materialization_revision=original.materialization_revision,
            idempotency_key="active-refresh",
        )

    after = client.query(
        TableName="hot",
        KeyConditionExpression="pk = :pk",
        ExpressionAttributeValues={":pk": {"S": target_pk}},
    )["Items"]
    assert after == before


@pytest.mark.aws
@mock_aws
def test_projection_put_racing_activation_is_safe_and_never_mutates_afterward() -> None:
    client = table()
    candidate = valid_active_manifest(
        ("geo_hourly", "live_qoe_hourly"), "dsv_abc", source_watermark=DAY
    )
    manifests = DynamoManifestRepository(client, "hot", clock=lambda: DAY)
    manifests.put_candidate(candidate, expected_absent=True, idempotency_key="put-candidate")
    racing_client = FenceRaceClient(client)
    racing_manifests = DynamoManifestRepository(racing_client, "hot", clock=lambda: DAY)
    racing_projections = DynamoProjectionRepository(racing_client, "hot", clock=lambda: DAY)
    original = overview_target(DAY, 4)
    outcomes: list[object] = []

    def activate() -> None:
        try:
            outcomes.append(racing_manifests.activate(None, candidate, idempotency_key="activate"))
        except Exception as error:  # The assertions below validate the public outcome.
            outcomes.append(error)

    def put() -> None:
        try:
            racing_projections.put(
                original, expected_projection_version=None, idempotency_key="race-put"
            )
            outcomes.append(None)
        except Exception as error:  # The assertions below validate the public outcome.
            outcomes.append(error)

    activation_thread = threading.Thread(target=activate)
    put_thread = threading.Thread(target=put)
    activation_thread.start()
    put_thread.start()
    activation_thread.join(timeout=5)
    put_thread.join(timeout=5)

    assert not activation_thread.is_alive()
    assert not put_thread.is_alive()
    assert candidate in outcomes
    assert (
        sum(outcome is None for outcome in outcomes)
        + sum(isinstance(outcome, ConditionalWriteError) for outcome in outcomes)
        == 1
    )

    target_pk = "DATASET#dsv_abc#VIEW#OVERVIEW#GLOBAL#20260908"
    operational_sk = "T#1788825600000"
    target_digest = hashlib.sha256(canonical_bytes([target_pk, operational_sk])).hexdigest()
    tracked_pks = (
        target_pk,
        f"INGESTION#PROJECTION_HEAD#{target_digest}",
        "DATASET#dsv_abc#INGESTION#HOTPROJ#geo_hourly#20260908",
        "DATASET#dsv_abc#INGESTION#HOTPROJ#live_qoe_hourly#20260908",
    )

    def stored_items(pk: str) -> list[dict[str, object]]:
        return client.query(
            TableName="hot",
            KeyConditionExpression="pk = :pk",
            ExpressionAttributeValues={":pk": {"S": pk}},
        )["Items"]

    before = {pk: stored_items(pk) for pk in tracked_pks}
    current_exists = bool(before[target_pk])
    with pytest.raises(ConditionalWriteError, match="active"):
        DynamoProjectionRepository(client, "hot", clock=lambda: DAY).put(
            overview_target(DAY, 5),
            expected_projection_version="1.0" if current_exists else None,
            expected_materialization_revision=(
                original.materialization_revision if current_exists else None
            ),
            idempotency_key="after-active",
        )

    assert {pk: stored_items(pk) for pk in tracked_pks} == before


@pytest.mark.aws
@mock_aws
def test_same_contract_refresh_uses_materialization_revision_and_preserves_history() -> None:
    client = table()
    repository = DynamoProjectionRepository(client, "hot", clock=lambda: DAY)
    first = overview_target(DAY, 4)
    second = overview_target(DAY, 5)

    repository.put(first, expected_projection_version=None, idempotency_key="refresh-1")
    repository.put(
        second,
        expected_projection_version="1.0",
        expected_materialization_revision=first.materialization_revision,
        idempotency_key="refresh-2",
    )
    repository.put(
        second,
        expected_projection_version="1.0",
        expected_materialization_revision=second.materialization_revision,
        idempotency_key="same-content-new-key",
    )

    response = client.query(
        TableName="hot",
        KeyConditionExpression="pk = :pk",
        ExpressionAttributeValues={":pk": {"S": "DATASET#dsv_abc#VIEW#OVERVIEW#GLOBAL#20260908"}},
    )
    assert {item["sk"]["S"] for item in response["Items"]} == {
        "T#1788825600000",
        f"REVISION#{first.materialization_revision}",
        f"REVISION#{second.materialization_revision}",
    }


@pytest.mark.aws
@mock_aws
def test_active_view_can_refresh_the_same_operational_key_with_cas() -> None:
    client = table()
    repository = DynamoProjectionRepository(client, "hot", clock=lambda: DAY)
    first = projection("1.0", "INCIDENTS#ACTIVE")
    changed_incident = {**dict(first.payload["incidents"][0]), "state": "explained"}
    changed_payload = {**dict(first.payload), "incidents": (changed_incident,)}
    second = Projection(
        first.dataset_version,
        first.partition_key,
        first.key,
        first.projection_version,
        first.required_archives,
        changed_payload,
    )

    repository.put(first, expected_projection_version=None, idempotency_key="active-1")
    repository.put(
        second,
        expected_projection_version="1.0",
        expected_materialization_revision=first.materialization_revision,
        idempotency_key="active-2",
    )

    operational_key = "CURRENT"
    item = client.get_item(
        TableName="hot",
        Key={
            "pk": {"S": "DATASET#dsv_abc#VIEW#INCIDENTS#ACTIVE"},
            "sk": {"S": operational_key},
        },
    )["Item"]
    assert item["payload"]["M"]["incidents"]["L"][0]["M"]["state"] == {"S": "explained"}
    history = client.query(
        TableName="hot",
        KeyConditionExpression="pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues={
            ":pk": {"S": "DATASET#dsv_abc#VIEW#INCIDENTS#ACTIVE"},
            ":prefix": {"S": "REVISION#"},
        },
    )
    assert history["Count"] == 2


@pytest.mark.aws
@mock_aws
def test_seal_race_leaves_neither_projection_nor_any_hotproj_catalog() -> None:
    client = table()
    client.put_item(
        TableName="hot",
        Item=serialize_item(
            {
                "pk": "DATASET#dsv_abc#INGESTION#RETENTION#geo_hourly#20260908",
                "sk": "META",
                "entityType": "RETENTION_SET",
            }
        ),
    )

    with pytest.raises(ConditionalWriteError, match="sealed"):
        DynamoProjectionRepository(client, "hot", clock=lambda: DAY).put(
            projection("1.0"), expected_projection_version=None, idempotency_key="sealed"
        )

    assert (
        client.query(
            TableName="hot",
            KeyConditionExpression="pk = :pk",
            ExpressionAttributeValues={
                ":pk": {"S": "DATASET#dsv_abc#VIEW#OVERVIEW#GLOBAL#20260908"}
            },
        )["Count"]
        == 0
    )
    for dataset in ("geo_hourly", "live_qoe_hourly"):
        assert (
            client.query(
                TableName="hot",
                KeyConditionExpression="pk = :pk",
                ExpressionAttributeValues={
                    ":pk": {"S": f"DATASET#dsv_abc#INGESTION#HOTPROJ#{dataset}#20260908"}
                },
            )["Count"]
            == 0
        )


@pytest.mark.aws
@mock_aws
def test_active_incident_view_survives_without_a_historical_ttl_catalog() -> None:
    client = table()
    DynamoProjectionRepository(client, "hot", clock=lambda: DAY).put(
        projection("1.0", "INCIDENTS#ACTIVE"),
        expected_projection_version=None,
        idempotency_key="active",
    )

    assert client.get_item(
        TableName="hot",
        Key={
            "pk": {"S": "DATASET#dsv_abc#VIEW#INCIDENTS#ACTIVE"},
            "sk": {"S": "CURRENT"},
        },
    )["Item"]["entityType"] == {"S": "PROJECTION"}
    for dataset in ("geo_hourly", "live_qoe_hourly"):
        assert (
            client.query(
                TableName="hot",
                KeyConditionExpression="pk = :pk",
                ExpressionAttributeValues={
                    ":pk": {"S": f"DATASET#dsv_abc#INGESTION#HOTPROJ#{dataset}#20260908"}
                },
            )["Count"]
            == 0
        )


@pytest.mark.aws
@mock_aws
def test_non_head_operational_target_refreshes_with_its_own_cas() -> None:
    client = table()
    repository = DynamoProjectionRepository(client, "hot", clock=lambda: DAY)
    target_a = overview_target(DAY, 4)
    target_b = overview_target(DAY + timedelta(hours=1), 4)
    refreshed_a = overview_target(DAY, 5)

    repository.put(
        target_a,
        expected_projection_version=None,
        expected_materialization_revision=None,
        idempotency_key="target-a",
    )
    repository.put(
        target_b,
        expected_projection_version=None,
        expected_materialization_revision=None,
        idempotency_key="target-b",
    )
    repository.put(
        refreshed_a,
        expected_projection_version="1.0",
        expected_materialization_revision=target_a.materialization_revision,
        idempotency_key="target-a-refresh",
    )

    stored = client.get_item(
        TableName="hot",
        Key={
            "pk": {"S": "DATASET#dsv_abc#VIEW#OVERVIEW#GLOBAL#20260908"},
            "sk": {"S": "T#1788825600000"},
        },
    )["Item"]
    assert stored["materializationRevision"] == {"S": refreshed_a.materialization_revision}


@pytest.mark.aws
@mock_aws
def test_legacy_contract_version_and_explicit_revision_have_distinct_cas_domains() -> None:
    client = table()
    repository = DynamoProjectionRepository(client, "hot", clock=lambda: DAY)
    first = overview_target(DAY, 4)
    second = overview_target(DAY, 5)

    repository.put(first, expected_projection_version=None, idempotency_key="legacy-first")
    repository.put(
        second,
        expected_projection_version="1.0",
        expected_materialization_revision=first.materialization_revision,
        idempotency_key="legacy-refresh",
    )

    with pytest.raises(ValueError, match="projection.*version"):
        repository.put(
            overview_target(DAY, 6),
            expected_projection_version=second.materialization_revision,
            idempotency_key="wrong-domain",
        )
    with pytest.raises(ConditionalWriteError, match="revision"):
        repository.put(
            overview_target(DAY, 6),
            expected_projection_version="1.0",
            expected_materialization_revision=first.materialization_revision,
            idempotency_key="stale-revision",
        )


@pytest.mark.aws
@mock_aws
def test_same_content_with_new_token_persists_marker_and_reserves_the_token() -> None:
    client = table()
    repository = DynamoProjectionRepository(client, "hot", clock=lambda: DAY)
    first = overview_target(DAY, 4)

    repository.put(first, expected_projection_version=None, idempotency_key="content-first")
    repository.put(
        first,
        expected_projection_version="1.0",
        expected_materialization_revision=first.materialization_revision,
        idempotency_key="noop-token",
    )

    marker_pk = "INGESTION#IDEMPOTENCY#projection-put#" + hashlib.sha256(b"noop-token").hexdigest()
    assert client.get_item(
        TableName="hot",
        Key={"pk": {"S": marker_pk}, "sk": {"S": "META"}},
        ConsistentRead=True,
    )["Item"]["entityType"] == {"S": "IDEMPOTENCY_MARKER"}
    with pytest.raises(IdempotencyConflict):
        repository.put(
            overview_target(DAY, 5),
            expected_projection_version="1.0",
            expected_materialization_revision=first.materialization_revision,
            idempotency_key="noop-token",
        )


@pytest.mark.aws
@mock_aws
def test_active_snapshot_replaces_priority_and_then_removes_absent_incident() -> None:
    client = table()
    repository = DynamoProjectionRepository(client, "hot", clock=lambda: DAY)
    p2 = active_set("P2")
    p1 = active_set("P1")
    empty = active_set(None)

    repository.put(p2, expected_projection_version=None, idempotency_key="active-p2")
    repository.put(
        p1,
        expected_projection_version="1.0",
        expected_materialization_revision=p2.materialization_revision,
        idempotency_key="active-p1",
    )
    repository.put(
        empty,
        expected_projection_version="1.0",
        expected_materialization_revision=p1.materialization_revision,
        idempotency_key="active-empty",
    )

    response = client.query(
        TableName="hot",
        KeyConditionExpression="pk = :pk",
        ExpressionAttributeValues={":pk": {"S": "DATASET#dsv_abc#VIEW#INCIDENTS#ACTIVE"}},
    )
    operational = [item for item in response["Items"] if item["entityType"] == {"S": "PROJECTION"}]
    assert len(operational) == 1
    assert operational[0]["sk"] == {"S": "CURRENT"}
    assert operational[0]["payload"]["M"]["incidents"] == {"L": []}


@pytest.mark.aws
@mock_aws
def test_active_snapshot_rolls_to_next_day_despite_the_previous_archive_seal() -> None:
    client = table()
    repository = DynamoProjectionRepository(client, "hot", clock=lambda: DAY)
    day_nine = DAY + timedelta(days=1)
    partition_nine = "year=2026/month=09/day=09"
    first = active_set("P2")
    moved = active_set("P1", observed_through=day_nine, partition=partition_nine)
    empty = active_set(None, observed_through=day_nine, partition=partition_nine)
    repository.put(first, expected_projection_version=None, idempotency_key="rollover-8")
    client.put_item(
        TableName="hot",
        Item=serialize_item(
            {
                "pk": "DATASET#dsv_abc#INGESTION#RETENTION#incidents#20260908",
                "sk": "META",
                "entityType": "RETENTION_SET",
            }
        ),
    )

    repository.put(
        moved,
        expected_projection_version="1.0",
        expected_materialization_revision=first.materialization_revision,
        idempotency_key="rollover-9-priority",
    )
    repository.put(
        empty,
        expected_projection_version="1.0",
        expected_materialization_revision=moved.materialization_revision,
        idempotency_key="rollover-9-empty",
    )

    response = client.query(
        TableName="hot",
        KeyConditionExpression="pk = :pk",
        ExpressionAttributeValues={":pk": {"S": "DATASET#dsv_abc#VIEW#INCIDENTS#ACTIVE"}},
    )
    operational = [item for item in response["Items"] if item["entityType"] == {"S": "PROJECTION"}]
    assert len(operational) == 1
    assert operational[0]["sk"] == {"S": "CURRENT"}
    assert operational[0]["projectionPartitionKey"] == {"S": "DAY#20260909"}
    assert operational[0]["requiredArchives"] == {
        "L": [
            {
                "M": {
                    "dataset": {"S": "incidents"},
                    "partition": {"S": partition_nine},
                }
            }
        ]
    }
    assert operational[0]["payload"]["M"]["incidents"] == {"L": []}
    assert (
        sum(item["entityType"] == {"S": "PROJECTION_REVISION"} for item in response["Items"]) == 3
    )


@pytest.mark.aws
@pytest.mark.parametrize(
    "seal_previous_dependency",
    [False, True],
    ids=["new-sealed", "old-and-new-sealed"],
)
@mock_aws
def test_active_snapshot_rejects_a_sealed_new_dependency_without_any_write(
    seal_previous_dependency: bool,
) -> None:
    client = table()
    repository = DynamoProjectionRepository(client, "hot", clock=lambda: DAY)
    day_nine = DAY + timedelta(days=1)
    partition_nine = "year=2026/month=09/day=09"
    first = active_set("P2")
    moved = active_set("P1", observed_through=day_nine, partition=partition_nine)
    repository.put(first, expected_projection_version=None, idempotency_key="sealed-new-first")
    sealed_days = ["20260909"]
    if seal_previous_dependency:
        sealed_days.append("20260908")
    for sealed_day in sealed_days:
        client.put_item(
            TableName="hot",
            Item=serialize_item(
                {
                    "pk": (f"DATASET#dsv_abc#INGESTION#RETENTION#incidents#{sealed_day}"),
                    "sk": "META",
                    "entityType": "RETENTION_SET",
                }
            ),
        )
    marker_key = {
        "pk": {
            "S": "INGESTION#IDEMPOTENCY#projection-put#"
            + hashlib.sha256(b"sealed-new-rollover").hexdigest()
        },
        "sk": {"S": "META"},
    }

    with pytest.raises(ConditionalWriteError, match="sealed"):
        repository.put(
            moved,
            expected_projection_version="1.0",
            expected_materialization_revision=first.materialization_revision,
            idempotency_key="sealed-new-rollover",
        )

    response = client.query(
        TableName="hot",
        KeyConditionExpression="pk = :pk",
        ExpressionAttributeValues={":pk": {"S": "DATASET#dsv_abc#VIEW#INCIDENTS#ACTIVE"}},
    )
    assert response["Count"] == 2
    operational = next(
        item for item in response["Items"] if item["entityType"] == {"S": "PROJECTION"}
    )
    assert operational["projectionPartitionKey"] == {"S": "DAY#20260908"}
    assert operational["payload"]["M"]["incidents"]["L"][0]["M"]["priority"] == {"S": "P2"}
    assert client.get_item(TableName="hot", Key=marker_key, ConsistentRead=True).get("Item") is None


@pytest.mark.aws
@mock_aws
def test_retarget_checks_the_previous_dependency_seal_before_changing_anything() -> None:
    client = table()
    repository = DynamoProjectionRepository(client, "hot", clock=lambda: DAY)
    old_dependency = (ArchiveDependency("dataset-old", PARTITION),)
    new_dependency = (ArchiveDependency("dataset-new", PARTITION),)
    original = overview_target(DAY, 4, dependencies=old_dependency)
    retargeted = overview_target(DAY, 5, dependencies=new_dependency)
    repository.put(original, expected_projection_version=None, idempotency_key="old-target")
    client.put_item(
        TableName="hot",
        Item=serialize_item(
            {
                "pk": "DATASET#dsv_abc#INGESTION#RETENTION#dataset-old#20260908",
                "sk": "META",
                "entityType": "RETENTION_SET",
            }
        ),
    )

    with pytest.raises(ConditionalWriteError, match="sealed"):
        repository.put(
            retargeted,
            expected_projection_version="1.0",
            expected_materialization_revision=original.materialization_revision,
            idempotency_key="retarget",
        )

    stored = client.get_item(
        TableName="hot",
        Key={
            "pk": {"S": "DATASET#dsv_abc#VIEW#OVERVIEW#GLOBAL#20260908"},
            "sk": {"S": "T#1788825600000"},
        },
    )["Item"]
    assert stored["requiredArchives"] == {
        "L": [{"M": {"dataset": {"S": "dataset-old"}, "partition": {"S": PARTITION}}}]
    }
    new_catalog = client.query(
        TableName="hot",
        KeyConditionExpression="pk = :pk",
        ExpressionAttributeValues={
            ":pk": {"S": "DATASET#dsv_abc#INGESTION#HOTPROJ#dataset-new#20260908"}
        },
    )
    assert new_catalog["Count"] == 0


@pytest.mark.aws
@mock_aws
def test_retarget_reconciles_operational_pointer_but_preserves_revision_history() -> None:
    client = table()
    repository = DynamoProjectionRepository(client, "hot", clock=lambda: DAY)
    old_dependency = (ArchiveDependency("dataset-old", PARTITION),)
    new_dependency = (ArchiveDependency("dataset-new", PARTITION),)
    original = overview_target(DAY, 4, dependencies=old_dependency)
    retargeted = overview_target(DAY, 5, dependencies=new_dependency)
    repository.put(original, expected_projection_version=None, idempotency_key="move-old")
    repository.put(
        retargeted,
        expected_projection_version="1.0",
        expected_materialization_revision=original.materialization_revision,
        idempotency_key="move-new",
    )

    def catalog(dataset: str) -> dict[str, object]:
        response = client.query(
            TableName="hot",
            KeyConditionExpression="pk = :pk",
            ExpressionAttributeValues={
                ":pk": {"S": f"DATASET#dsv_abc#INGESTION#HOTPROJ#{dataset}#20260908"}
            },
        )
        assert response["Count"] == 1
        return response["Items"][0]

    old_targets = catalog("dataset-old")["targets"]["L"]
    new_targets = catalog("dataset-new")["targets"]["L"]
    assert [target["M"]["kind"]["S"] for target in old_targets] == ["REVISION"]
    assert [target["M"]["kind"]["S"] for target in new_targets] == [
        "OPERATIONAL",
        "REVISION",
    ]
    assert old_targets[0]["M"]["materializationRevision"] == {
        "S": original.materialization_revision
    }


@pytest.mark.aws
@mock_aws
def test_maximum_dependency_set_stays_within_one_hundred_atomic_actions() -> None:
    client = table()
    repository = DynamoProjectionRepository(client, "hot", clock=lambda: DAY)
    dependencies = tuple(
        ArchiveDependency(f"d{index:02d}" + "x" * 509, PARTITION) for index in range(47)
    )
    candidate = overview_target(DAY, 4, dependencies=dependencies)
    action_counts: list[int] = []
    request_sizes: list[int] = []

    def capture(**kwargs: object) -> None:
        import json

        params = kwargs.get("params")
        if isinstance(params, dict) and isinstance(params.get("body"), bytes):
            request = json.loads(params["body"])
            action_counts.append(len(request["TransactItems"]))
            request_sizes.append(len(params["body"]))

    client.meta.events.register("before-call.dynamodb.TransactWriteItems", capture)
    repository.put(
        candidate,
        expected_projection_version=None,
        expected_materialization_revision=None,
        idempotency_key="max-dependencies",
    )

    assert action_counts == [99]
    assert request_sizes[0] < 4 * 1024 * 1024 - 64 * 1024
