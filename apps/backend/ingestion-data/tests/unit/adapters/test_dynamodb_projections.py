"""Verify DynamoDB persistence for ingestion projections and dependencies."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, cast

import pytest
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from adapters.dynamodb.client import DynamoControlProtocolError, DynamoDbThrottled
from adapters.dynamodb.codec import encode_hot_record, serialize_item
from adapters.dynamodb.projections import DynamoProjectionRepository
from domain.models import CanonicalRecord, RecordType, TimeWindow
from ports import ArchiveDependency, ConditionalWriteError, EventProjectionItem, Projection

DAY = datetime(2026, 9, 8, tzinfo=UTC)
PARTITION = "year=2026/month=09/day=08"


def canonical_record(dataset: str = "live_qoe_hourly") -> CanonicalRecord:
    return CanonicalRecord(
        "1.0",
        RecordType.DIMENSIONAL_METRIC_AGGREGATE,
        "argus",
        dataset,
        (("id", "one"),),
        DAY,
        TimeWindow(DAY, DAY + timedelta(hours=1), 3600),
        {"sinal": "canal"},
        {"sessions": 4, "errors": 1},
        {"coveragePolicy": "known_upstream_lag"},
        (),
    )


def projection(
    *,
    version: str = "1.0",
    key: str = "OVERVIEW#GLOBAL",
    observed_through: datetime = DAY,
    metric_value: Decimal = Decimal("0.25"),
    dependencies: tuple[ArchiveDependency, ...] = (
        ArchiveDependency("geo_hourly", PARTITION),
        ArchiveDependency("live_qoe_hourly", PARTITION),
    ),
) -> Projection:
    common: dict[str, object] = {
        "projectionVersion": version,
        "formulaVersion": "1.0",
        "inputWatermarks": {dependency.dataset: observed_through for dependency in dependencies},
        "observedThrough": observed_through,
        "coverage": "complete",
        "qualityFlags": (),
    }
    if key.startswith("OVERVIEW#"):
        specific: dict[str, object] = {
            "metrics": {
                "sessions": 4,
                "errors": 1,
                "startupErrors": None,
                "botErrors": None,
                "humanErrors": None,
                "errorRate": metric_value,
            }
        }
    elif key == "INCIDENTS#ACTIVE":
        specific = {
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
    elif key == "INCIDENTS#DAY":
        specific = {
            "incidentId": "inc_pnidg23fnrf2yaddm5ttipxc55",
            "number": "INC001",
            "openedAt": DAY,
            "state": "open",
            "priority": "P2",
            "resolvedAt": None,
            "closedAt": None,
        }
    elif key.startswith("MONITORING#"):
        specific = {
            "source": "prometheus",
            "observedAt": observed_through,
            "finishedAt": observed_through,
            "rowsProcessed": 4,
            "durationSeconds": Decimal("1.5"),
        }
    else:
        specific = {
            "dimensionId": "dim_state-sp-isp-a",
            "state": "SP",
            "isp": "ISP A",
            "sessions": 4,
            "errors": 1,
            "errorRate": metric_value,
            "metric": "error-rate",
        }
    return Projection(
        "dsv_abc",
        "DAY#20260908",
        key,
        version,
        dependencies,
        {**common, **specific},
    )


class PagingClient:
    def __init__(self, item: dict[str, object]) -> None:
        self.item = serialize_item(item)
        self.query_calls: list[dict[str, object]] = []
        self.transaction_calls: list[dict[str, object]] = []

    def get_item(self, **_kwargs: object) -> Mapping[str, object]:
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}

    def query(self, **kwargs: object) -> Mapping[str, object]:
        self.query_calls.append(dict(kwargs))
        if len(self.query_calls) == 1:
            return {
                "Items": [self.item],
                "Count": 1,
                "ScannedCount": 1,
                "LastEvaluatedKey": {"pk": self.item["pk"], "sk": self.item["sk"]},
                "ResponseMetadata": {"HTTPStatusCode": 200},
            }
        return {
            "Items": [],
            "Count": 0,
            "ScannedCount": 0,
            "ResponseMetadata": {"HTTPStatusCode": 200},
        }

    def transact_write_items(self, **kwargs: object) -> Mapping[str, object]:
        self.transaction_calls.append(dict(kwargs))
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}


def test_query_inputs_uses_only_consistent_paginated_query_and_exact_partition_key() -> None:
    source = canonical_record()
    encoded = encode_hot_record(source, "dsv_abc", PARTITION)
    client = PagingClient(encoded)
    repository = DynamoProjectionRepository(client, "hot")

    result = repository.query_inputs("dsv_abc", (str(encoded["pk"]),))

    assert result == (source,)
    assert len(client.query_calls) == 2
    assert all(call["ConsistentRead"] is True for call in client.query_calls)
    assert client.query_calls[0]["KeyConditionExpression"] == "pk = :pk"
    assert client.query_calls[1]["ExclusiveStartKey"] == {
        "pk": client.item["pk"],
        "sk": client.item["sk"],
    }
    assert not hasattr(client, "scan")


def test_iter_input_batches_yields_each_page_without_accumulating_the_query() -> None:
    source = canonical_record()
    encoded = encode_hot_record(source, "dsv_abc", PARTITION)
    client = PagingClient(encoded)
    batches = DynamoProjectionRepository(client, "hot").iter_input_batches(
        "dsv_abc", (str(encoded["pk"]),)
    )

    assert next(batches) == (source,)
    assert len(client.query_calls) == 1
    batches.close()


def test_query_inputs_rejects_regressive_cursor_cycle_with_bounded_state() -> None:
    source = canonical_record()
    encoded = encode_hot_record(source, "dsv_abc", PARTITION)

    class CyclingClient(PagingClient):
        def query(self, **kwargs: object) -> Mapping[str, object]:
            self.query_calls.append(dict(kwargs))
            response: dict[str, object] = {
                "Items": [],
                "Count": 0,
                "ScannedCount": 0,
                "ResponseMetadata": {"HTTPStatusCode": 200},
            }
            cursors = ("A", "B", "A")
            if len(self.query_calls) <= len(cursors):
                response["LastEvaluatedKey"] = {
                    "pk": self.item["pk"],
                    "sk": {"S": cursors[len(self.query_calls) - 1]},
                }
            return response

    client = CyclingClient(encoded)

    with pytest.raises(DynamoControlProtocolError, match="did not advance monotonically"):
        DynamoProjectionRepository(client, "hot").query_inputs("dsv_abc", (str(encoded["pk"]),))

    assert len(client.query_calls) == 3


def test_query_inputs_rejects_an_item_behind_the_page_input_cursor() -> None:
    source = canonical_record()
    encoded = encode_hot_record(source, "dsv_abc", PARTITION)

    class RegressiveItemClient(PagingClient):
        def query(self, **kwargs: object) -> Mapping[str, object]:
            self.query_calls.append(dict(kwargs))
            if len(self.query_calls) == 1:
                return {
                    "Items": [],
                    "Count": 0,
                    "ScannedCount": 0,
                    "LastEvaluatedKey": {
                        "pk": self.item["pk"],
                        "sk": {"S": "ZZZ"},
                    },
                    "ResponseMetadata": {"HTTPStatusCode": 200},
                }
            return {
                "Items": [self.item],
                "Count": 1,
                "ScannedCount": 1,
                "ResponseMetadata": {"HTTPStatusCode": 200},
            }

    client = RegressiveItemClient(encoded)

    with pytest.raises(DynamoControlProtocolError, match="behind the input cursor"):
        DynamoProjectionRepository(client, "hot").query_inputs("dsv_abc", (str(encoded["pk"]),))

    assert len(client.query_calls) == 2


def test_query_inputs_restores_canonical_datetime_measures() -> None:
    source = replace(
        canonical_record(),
        source_dataset="collector_run",
        record_type=RecordType.UPSTREAM_COLLECTOR_RUN,
        measures={"finished_at": DAY + timedelta(minutes=2), "rows_upserted": 4},
    )
    encoded = encode_hot_record(source, "dsv_abc", PARTITION)

    result = DynamoProjectionRepository(PagingClient(encoded), "hot").query_inputs(
        "dsv_abc", (str(encoded["pk"]),)
    )

    assert result == (source,)


def test_query_inputs_preserves_integral_decimal_measures_after_dynamodb_roundtrip() -> None:
    source = replace(
        canonical_record(),
        source_dataset="cdn_vod_shadow",
        record_type=RecordType.SHADOW_OBSERVATION,
        measures={
            "req2xx": Decimal("100.0"),
            "errors4xx": Decimal("2.0"),
            "errors5xx": Decimal("1.0"),
        },
    )
    encoded = encode_hot_record(source, "dsv_abc", PARTITION)

    result = DynamoProjectionRepository(PagingClient(encoded), "hot").query_inputs(
        "dsv_abc", (str(encoded["pk"]),)
    )

    assert result == (source,)
    assert tuple(
        type(result[0].measures[field]) for field in ("req2xx", "errors4xx", "errors5xx")
    ) == (Decimal, Decimal, Decimal)


def test_query_inputs_rejects_cross_version_and_malformed_responses() -> None:
    source = canonical_record()
    encoded = encode_hot_record(source, "dsv_other", PARTITION)
    client = PagingClient(encoded)
    repository = DynamoProjectionRepository(client, "hot")
    requested = str(encoded["pk"]).replace("dsv_other", "dsv_abc")

    with pytest.raises(DynamoControlProtocolError):
        repository.query_inputs("dsv_abc", (requested,))

    client = PagingClient(encode_hot_record(source, "dsv_abc", PARTITION))
    client.query = lambda **_kwargs: {"Items": [], "Count": 1}  # type: ignore[method-assign]
    with pytest.raises(DynamoControlProtocolError):
        DynamoProjectionRepository(client, "hot").query_inputs(
            "dsv_abc", (str(encode_hot_record(source, "dsv_abc", PARTITION)["pk"]),)
        )


def test_query_inputs_rejects_tampered_payload_hash() -> None:
    source = canonical_record()
    encoded = encode_hot_record(source, "dsv_abc", PARTITION)
    encoded["payloadHash"] = "ph_" + "0" * 64

    with pytest.raises(DynamoControlProtocolError, match="inconsistent"):
        DynamoProjectionRepository(PagingClient(encoded), "hot").query_inputs(
            "dsv_abc", (str(encoded["pk"]),)
        )


def test_put_writes_projection_all_hotproj_catalogs_and_seal_gates_atomically() -> None:
    client = PagingClient(encode_hot_record(canonical_record(), "dsv_abc", PARTITION))
    repository = DynamoProjectionRepository(client, "hot", clock=lambda: DAY)

    repository.put(projection(), expected_projection_version=None, idempotency_key="overview-1")

    assert len(client.transaction_calls) == 1
    actions = cast(list[dict[str, Any]], client.transaction_calls[0]["TransactItems"])
    assert len(actions) == 9
    serialized_puts = [action["Put"]["Item"] for action in actions if "Put" in action]
    entity_types = [item.get("entityType") for item in serialized_puts]
    assert {value["S"] for value in entity_types if isinstance(value, Mapping)} == {
        "PROJECTION",
        "PROJECTION_REVISION",
        "PROJECTION_HEAD",
        "HOT_PROJECTION_TARGET_SET",
        "IDEMPOTENCY_MARKER",
    }
    catalog_pks = {
        item["pk"]["S"]
        for item in serialized_puts
        if item.get("entityType") == {"S": "HOT_PROJECTION_TARGET_SET"}
    }
    assert catalog_pks == {
        "DATASET#dsv_abc#INGESTION#HOTPROJ#geo_hourly#20260908",
        "DATASET#dsv_abc#INGESTION#HOTPROJ#live_qoe_hourly#20260908",
    }
    fence_check = cast(dict[str, Any], actions[0]["ConditionCheck"])
    assert fence_check["Key"] == {
        "pk": {"S": "DATASET#dsv_abc#INGESTION#PROJECTION_FENCE"},
        "sk": {"S": "ACTIVE"},
    }
    seal_checks = [
        action["ConditionCheck"]
        for action in actions
        if "ConditionCheck" in action
        and str(action["ConditionCheck"]["Key"]["pk"]["S"]).startswith(
            "DATASET#dsv_abc#INGESTION#RETENTION#"
        )
    ]
    assert {check["Key"]["pk"]["S"] for check in seal_checks} == {
        "DATASET#dsv_abc#INGESTION#RETENTION#geo_hourly#20260908",
        "DATASET#dsv_abc#INGESTION#RETENTION#live_qoe_hourly#20260908",
    }
    assert all(check["ConditionExpression"] == "attribute_not_exists(pk)" for check in seal_checks)


def test_put_event_items_gates_activation_and_allows_only_identical_replay() -> None:
    client = PagingClient(encode_hot_record(canonical_record(), "dsv_abc", PARTITION))
    item = EventProjectionItem(
        "dsv_abc",
        "DATASET#dsv_abc#VIEW#EVENTS#DAY#20260908",
        "OCCURRED#1788825600000#EVENT#evt_known",
        "EVENT",
        {"eventId": "evt_known", "occurredAt": "2026-09-08T00:00:00.000Z"},
    )

    DynamoProjectionRepository(client, "hot").put_event_items((item,))

    assert "ReturnCancellationReasons" not in client.transaction_calls[0]
    actions = cast(list[dict[str, Any]], client.transaction_calls[0]["TransactItems"])
    assert len(actions) == 2
    assert actions[0]["ConditionCheck"]["Key"] == {
        "pk": {"S": "DATASET#dsv_abc#INGESTION#PROJECTION_FENCE"},
        "sk": {"S": "ACTIVE"},
    }
    put = actions[1]["Put"]
    assert put["Item"]["entityType"] == {"S": "EVENT"}
    assert put["Item"]["materializationRevision"]["S"] == item.materialization_revision
    assert put["ConditionExpression"] == (
        "attribute_not_exists(pk) OR materializationRevision = :revision"
    )


@pytest.mark.parametrize(
    ("position", "message"),
    [(0, "active"), (1, "divergent")],
)
def test_put_event_items_classifies_fence_and_content_conflicts(
    position: int, message: str
) -> None:
    reasons = [{"Code": "None"}, {"Code": "None"}]
    reasons[position] = {"Code": "ConditionalCheckFailed"}
    item = EventProjectionItem(
        "dsv_abc",
        "DATASET#dsv_abc#EVENT#evt_known",
        "CURRENT",
        "EVENT_LOOKUP",
        {"eventId": "evt_known"},
    )

    with pytest.raises(ConditionalWriteError, match=message):
        DynamoProjectionRepository(CancelingClient(reasons), "hot").put_event_items((item,))


def test_active_incident_view_is_version_isolated_and_not_ttl_cataloged() -> None:
    client = PagingClient(encode_hot_record(canonical_record(), "dsv_abc", PARTITION))
    repository = DynamoProjectionRepository(client, "hot", clock=lambda: DAY)

    repository.put(
        projection(key="INCIDENTS#ACTIVE"),
        expected_projection_version=None,
        idempotency_key="active-1",
    )

    actions = cast(list[dict[str, Any]], client.transaction_calls[0]["TransactItems"])
    projection_items = [
        action["Put"]["Item"]
        for action in actions
        if "Put" in action and action["Put"]["Item"].get("entityType") == {"S": "PROJECTION"}
    ]
    assert projection_items[0]["pk"]["S"] == "DATASET#dsv_abc#VIEW#INCIDENTS#ACTIVE"
    seal_checks = [action["ConditionCheck"] for action in actions if "ConditionCheck" in action]
    assert len(actions) == 7
    retention_seal_pks = {
        check["Key"]["pk"]["S"] for check in seal_checks if "RETENTION" in check["Key"]["pk"]["S"]
    }
    assert retention_seal_pks == {
        "DATASET#dsv_abc#INGESTION#RETENTION#geo_hourly#20260908",
        "DATASET#dsv_abc#INGESTION#RETENTION#live_qoe_hourly#20260908",
    }
    assert all(check["ConditionExpression"] == "attribute_not_exists(pk)" for check in seal_checks)
    assert not any(
        action.get("Put", {}).get("Item", {}).get("entityType")
        == {"S": "HOT_PROJECTION_TARGET_SET"}
        for action in actions
    )


@pytest.mark.parametrize(
    ("key", "expected_sk"),
    [
        ("OVERVIEW#GLOBAL", "T#1788825600000"),
        (
            "INCIDENTS#DAY",
            "OPENED#1788825600000#inc_pnidg23fnrf2yaddm5ttipxc55",
        ),
        (
            "INCIDENTS#ACTIVE",
            "CURRENT",
        ),
        ("MONITORING#prometheus", "T#1788825600000"),
        ("GEOGRAPHY#error-rate", "T#1788825600000#dim_state-sp-isp-a"),
    ],
)
def test_put_materializes_the_operational_sort_key(key: str, expected_sk: str) -> None:
    client = PagingClient(encode_hot_record(canonical_record(), "dsv_abc", PARTITION))

    DynamoProjectionRepository(client, "hot", clock=lambda: DAY).put(
        projection(key=key),
        expected_projection_version=None,
        idempotency_key=f"operational-{key}",
    )

    actions = cast(list[dict[str, Any]], client.transaction_calls[0]["TransactItems"])
    projected = next(
        action["Put"]["Item"]
        for action in actions
        if action.get("Put", {}).get("Item", {}).get("entityType") == {"S": "PROJECTION"}
    )
    assert projected["sk"]["S"] == expected_sk
    assert projected["projectionVersion"]["S"] == "1.0"
    assert projected["materializationRevision"]["S"].startswith("pmr_")


def test_put_rejects_materialization_revision_in_the_legacy_contract_keyword() -> None:
    client = PagingClient(encode_hot_record(canonical_record(), "dsv_abc", PARTITION))

    with pytest.raises(ValueError, match="projection contract version"):
        DynamoProjectionRepository(client, "hot", clock=lambda: DAY).put(
            projection(),
            expected_projection_version="pmr_" + "0" * 64,
            idempotency_key="wrong-cas-domain",
        )

    assert client.transaction_calls == []


def test_47_dependencies_fit_one_atomic_transaction_below_the_action_limit() -> None:
    dependencies = tuple(
        ArchiveDependency(f"dataset-{index:02d}", PARTITION) for index in range(47)
    )
    client = PagingClient(encode_hot_record(canonical_record(), "dsv_abc", PARTITION))

    DynamoProjectionRepository(client, "hot", clock=lambda: DAY).put(
        projection(dependencies=dependencies),
        expected_projection_version=None,
        idempotency_key="max-dependencies",
    )

    actions = cast(list[dict[str, Any]], client.transaction_calls[0]["TransactItems"])
    assert len(actions) == 99
    assert sum("ConditionCheck" in action for action in actions) == 48
    assert (
        sum(
            action.get("Put", {}).get("Item", {}).get("entityType")
            == {"S": "HOT_PROJECTION_TARGET_SET"}
            for action in actions
        )
        == 47
    )


def test_47_active_dependencies_fit_as_gates_plus_four_atomic_writes() -> None:
    dependencies = tuple(
        ArchiveDependency(f"dataset-{index:02d}", PARTITION) for index in range(47)
    )
    client = PagingClient(encode_hot_record(canonical_record(), "dsv_abc", PARTITION))

    DynamoProjectionRepository(client, "hot", clock=lambda: DAY).put(
        projection(key="INCIDENTS#ACTIVE", dependencies=dependencies),
        expected_projection_version=None,
        idempotency_key="max-active-dependencies",
    )

    actions = cast(list[dict[str, Any]], client.transaction_calls[0]["TransactItems"])
    assert len(actions) == 52
    assert sum("ConditionCheck" in action for action in actions) == 48
    assert not any(
        action.get("Put", {}).get("Item", {}).get("entityType")
        == {"S": "HOT_PROJECTION_TARGET_SET"}
        for action in actions
    )


class CancelingClient(PagingClient):
    def __init__(self, reasons: object) -> None:
        super().__init__(encode_hot_record(canonical_record(), "dsv_abc", PARTITION))
        self.reasons = reasons

    def transact_write_items(self, **kwargs: object) -> Mapping[str, object]:
        self.transaction_calls.append(dict(kwargs))
        raise ClientError(
            {
                "Error": {"Code": "TransactionCanceledException", "Message": "cancelled"},
                "CancellationReasons": self.reasons,
            },
            "TransactWriteItems",
        )


class ForgedPostCancellationMarkerClient(PagingClient):
    def __init__(self) -> None:
        super().__init__(encode_hot_record(canonical_record(), "dsv_abc", PARTITION))
        self.forged: dict[str, object] | None = None

    def get_item(self, **_kwargs: object) -> Mapping[str, object]:
        if self.forged is None:
            return {"ResponseMetadata": {"HTTPStatusCode": 200}}
        return {"Item": serialize_item(self.forged)}

    def transact_write_items(self, **kwargs: object) -> Mapping[str, object]:
        actions = cast(list[dict[str, Any]], kwargs["TransactItems"])
        marker = next(
            action["Put"]["Item"]
            for action in actions
            if action.get("Put", {}).get("Item", {}).get("entityType")
            == {"S": "IDEMPOTENCY_MARKER"}
        )
        self.forged = {
            "pk": marker["pk"]["S"],
            "sk": "META",
            "entityType": "FORGED",
            "fingerprint": marker["fingerprint"]["S"],
        }
        raise ClientError(
            {
                "Error": {"Code": "TransactionCanceledException", "Message": "cancelled"},
                "CancellationReasons": [{"Code": "None"} for _ in actions],
            },
            "TransactWriteItems",
        )


def test_post_cancellation_replay_rejects_a_forged_marker() -> None:
    with pytest.raises(DynamoControlProtocolError, match="marker"):
        DynamoProjectionRepository(
            ForgedPostCancellationMarkerClient(), "hot", clock=lambda: DAY
        ).put(projection(), expected_projection_version=None, idempotency_key="forged-marker")


def test_put_classifies_only_known_conditional_cancellation_positions() -> None:
    reasons: list[dict[str, str]] = [{"Code": "None"}, {"Code": "ConditionalCheckFailed"}] + [
        {"Code": "None"} for _ in range(7)
    ]
    with pytest.raises(ConditionalWriteError, match="sealed"):
        DynamoProjectionRepository(CancelingClient(reasons), "hot", clock=lambda: DAY).put(
            projection(), expected_projection_version=None, idempotency_key="sealed"
        )

    reasons[0] = {"Code": "ProvisionedThroughputExceeded"}
    with pytest.raises(ClientError):
        DynamoProjectionRepository(CancelingClient(reasons), "hot", clock=lambda: DAY).put(
            projection(), expected_projection_version=None, idempotency_key="transient"
        )


@pytest.mark.parametrize(
    "transient_code",
    ["TransactionConflict", "ProvisionedThroughputExceeded", "ThrottlingError"],
)
def test_active_put_preserves_a_transient_dependency_gate_cancellation(
    transient_code: str,
) -> None:
    reasons: list[dict[str, str]] = [{"Code": transient_code}] + [
        {"Code": "None"} for _ in range(6)
    ]
    client = CancelingClient(reasons)

    with pytest.raises(DynamoDbThrottled):
        DynamoProjectionRepository(client, "hot", clock=lambda: DAY).put(
            projection(key="INCIDENTS#ACTIVE"),
            expected_projection_version=None,
            idempotency_key="active-transient",
        )

    actions = cast(list[dict[str, Any]], client.transaction_calls[0]["TransactItems"])
    assert len(actions) == 7
