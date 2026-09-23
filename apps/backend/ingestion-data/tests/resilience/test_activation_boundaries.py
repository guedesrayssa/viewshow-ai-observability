"""Verify failed or partial backfills never cross candidate activation boundaries."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, cast

import boto3  # type: ignore[import-untyped]
import pytest
from boto3.dynamodb.types import TypeSerializer  # type: ignore[import-untyped]
from botocore.exceptions import ClientError  # type: ignore[import-untyped]
from moto import mock_aws

from adapters.dynamodb.client import DynamoDbThrottled
from adapters.dynamodb.codec import serialized_item_bytes
from adapters.dynamodb.manifests import DynamoManifestRepository
from application.activate_candidate import activate_candidate
from domain.archive import validate_candidate_manifest
from ports import (
    CandidateManifest,
    ConcurrentActivationError,
    ConditionalWriteError,
    IdempotencyConflict,
)

SERIALIZER = TypeSerializer()
NOW = datetime(2026, 9, 8, 12, 0, tzinfo=UTC)


def manifest(version: str, *, checksum: str = "a" * 64) -> CandidateManifest:
    return CandidateManifest(
        version,
        {
            "physicalContractVersion": "2.0",
            "canonicalSchemaVersion": "1.0",
            "dumpChecksumSha256": checksum,
            "snapshotExtractedOn": "2026-09-01",
            "availableIntervals": {
                "signal_bucket": (
                    {
                        "start": "2026-08-01T00:00:00Z",
                        "end": "2026-09-01T00:00:00Z",
                    },
                )
            },
            "hotFrom": {"signal_bucket": "2026-08-18T00:00:00Z"},
            "watermarks": {"signal_bucket": "2026-09-01T00:00:00Z"},
            "s3Prefix": f"s3://argus-canonical/{version}/",
            "glueTables": {"signal_bucket": "argus_signal_bucket"},
            "descriptorVersions": {"signal_bucket": "2.0"},
            "formulaVersions": {"overview": "1.0"},
            "projectionVersions": {"overview/day": "1.0"},
            "coverage": {"signal_bucket": "COMPLETE"},
            "qualityFlags": {"signal_bucket": ()},
            "validations": {
                "physicalSchemas": {
                    "state": "PASSED",
                    "validatedAt": "2026-09-08T12:00:00Z",
                    "datasets": {"signal_bucket": {"fingerprint": "d" * 64, "compatible": True}},
                },
                "reconciliation": {
                    "state": "PASSED",
                    "validatedAt": "2026-09-08T12:00:00Z",
                    "datasets": {"signal_bucket": {"accepted": 1, "rejected": 0, "persisted": 1}},
                },
                "parquetCatalog": {
                    "state": "PASSED",
                    "validatedAt": "2026-09-08T12:00:00Z",
                    "datasets": {"signal_bucket": {"partitionCount": 1, "catalogValidated": True}},
                },
                "requiredProjections": {
                    "state": "PASSED",
                    "validatedAt": "2026-09-08T12:00:00Z",
                    "projections": ("overview/day",),
                },
                "coverageQuality": {
                    "state": "PASSED",
                    "validatedAt": "2026-09-08T12:00:00Z",
                    "datasets": {"signal_bucket": {"coverage": "COMPLETE", "qualityFlags": ()}},
                },
            },
        },
    )


def canonical_manifest(version: str, *, partition_count: int = 10_417) -> CandidateManifest:
    legacy = manifest(version)
    metadata = dict(legacy.metadata)
    validations = {
        name: dict(cast(Mapping[str, object], value))
        for name, value in cast(Mapping[str, object], metadata["validations"]).items()
    }
    parquet = dict(validations["parquetCatalog"])
    parquet["datasets"] = {
        "signal_bucket": {
            "partitionCount": partition_count,
            "catalogValidated": True,
            "projectionItemCount": partition_count * 2,
            "projectionDigest": "e" * 64,
        }
    }
    validations["parquetCatalog"] = parquet
    metadata["validations"] = validations
    metadata["hotMaterialization"] = "SKIPPED"
    metadata["hotItemCount"] = 0
    metadata["canonicalMarker"] = {
        "schemaVersion": "1.0",
        "objectKey": (
            "canonical/schema_version=1.0/"
            f"dataset_version={version}/manifest.json"
        ),
        "aggregateDigest": "d" * 64,
        "documentSha256": "f" * 64,
        "datasetCount": 1,
        "partitionCount": partition_count,
        "objectCount": partition_count,
        "totalSourceRows": partition_count,
        "totalAcceptedRows": partition_count,
        "totalRejectedRows": 0,
    }
    reconciliation = dict(validations["reconciliation"])
    reconciliation["datasets"] = {
        "signal_bucket": {
            "accepted": partition_count,
            "rejected": 0,
            "persisted": partition_count,
        }
    }
    validations["reconciliation"] = reconciliation
    metadata["validations"] = validations
    return CandidateManifest(version, metadata)


def _mutable(value: object) -> object:
    if isinstance(value, Mapping):
        return {key: _mutable(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return tuple(_mutable(item) for item in value)
    return value


def _canonical_metadata(version: str = "dsv_closed_union") -> dict[str, object]:
    metadata = canonical_manifest(version, partition_count=1).metadata
    return cast(dict[str, object], _mutable(metadata))


def test_candidate_representation_union_rejects_compact_v2_without_top_level_evidence() -> None:
    metadata = _canonical_metadata()
    for field in ("hotMaterialization", "hotItemCount", "canonicalMarker"):
        del metadata[field]

    with pytest.raises(ValueError):
        validate_candidate_manifest(CandidateManifest("dsv_closed_union", metadata))


def test_candidate_representation_union_rejects_marker_with_legacy_parquet_shape() -> None:
    metadata = _canonical_metadata()
    validations = cast(dict[str, object], metadata["validations"])
    parquet = cast(dict[str, object], validations["parquetCatalog"])
    parquet["datasets"] = {
        "signal_bucket": {"partitionCount": 1, "catalogValidated": True}
    }

    with pytest.raises(ValueError):
        validate_candidate_manifest(CandidateManifest("dsv_closed_union", metadata))


def test_candidate_representation_union_rejects_partial_v2_fields_as_legacy() -> None:
    metadata = _canonical_metadata()
    del metadata["canonicalMarker"]
    validations = cast(dict[str, object], metadata["validations"])
    parquet = cast(dict[str, object], validations["parquetCatalog"])
    parquet["datasets"] = {
        "signal_bucket": {"partitionCount": 1, "catalogValidated": True}
    }

    with pytest.raises(ValueError):
        validate_candidate_manifest(CandidateManifest("dsv_closed_union", metadata))


def test_candidate_representation_union_rejects_extra_top_level_fields() -> None:
    metadata = _canonical_metadata()
    metadata["representation"] = "canonical-v2"

    with pytest.raises(ValueError):
        validate_candidate_manifest(CandidateManifest("dsv_closed_union", metadata))


def create_table(client: Any) -> None:
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


@mock_aws
def test_canonical_candidate_with_10417_partitions_round_trips_below_limit_and_activates() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    repository = DynamoManifestRepository(client, "hot", clock=lambda: NOW)
    candidate = canonical_manifest("dsv_canonical")

    repository.put_candidate(
        candidate,
        expected_absent=True,
        idempotency_key="put-canonical-10417",
    )

    assert repository.get_candidate(candidate.dataset_version) == candidate
    stored = client.get_item(
        TableName="hot",
        Key={
            "pk": {"S": "CANDIDATE#DATASET#dsv_canonical"},
            "sk": {"S": "MANIFEST"},
        },
        ConsistentRead=True,
    )["Item"]
    assert serialized_item_bytes(stored) < 200 * 1024

    activated = repository.activate(
        None,
        candidate,
        idempotency_key="activate-canonical-10417",
    )

    assert activated.metadata["canonicalMarker"] == candidate.metadata["canonicalMarker"]
    active = client.get_item(
        TableName="hot",
        Key={"pk": {"S": "CONTROL#DATASET"}, "sk": {"S": "ACTIVE"}},
        ConsistentRead=True,
    )["Item"]
    assert serialized_item_bytes(active) < 200 * 1024


@mock_aws
def test_candidate_is_invisible_until_conditional_activation_and_replays_after_restart() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    repository = DynamoManifestRepository(client, "hot", clock=lambda: NOW)
    old = manifest("dsv_old")
    new = manifest("dsv_new", checksum="b" * 64)
    repository.put_candidate(old, expected_absent=True, idempotency_key="put-old")
    repository.activate(None, old, idempotency_key="activate-old")

    repository.put_candidate(new, expected_absent=True, idempotency_key="put-new")
    assert client.get_item(
        TableName="hot",
        Key={
            "pk": {"S": "CANDIDATE#DATASET#dsv_new"},
            "sk": {"S": "MANIFEST"},
        },
        ConsistentRead=True,
    )["Item"]["candidateDatasetVersion"] == {"S": "dsv_new"}
    assert "Item" not in client.get_item(
        TableName="hot",
        Key={
            "pk": {"S": "CONTROL#DATASET"},
            "sk": {"S": "CANDIDATE#dsv_new"},
        },
        ConsistentRead=True,
    )
    assert repository.get_active() == old
    assert repository.get_candidate("dsv_new") == new
    assert repository.get_candidate("dsv_missing") is None
    assert (
        activate_candidate(
            repository,
            "dsv_old",
            new,
            idempotency_key="activate-new",
        )
        == new
    )

    restarted = DynamoManifestRepository(client, "hot", clock=lambda: NOW)
    assert restarted.activate("dsv_old", new, idempotency_key="activate-new") == new
    assert restarted.get_active() == new
    assert client.get_item(
        TableName="hot",
        Key={"pk": {"S": "CONTROL#DATASET"}, "sk": {"S": "ACTIVE"}},
        ConsistentRead=True,
    )["Item"]["activeDatasetVersion"] == {"S": "dsv_new"}


@mock_aws
def test_activation_persists_a_projection_immutability_fence_atomically() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    repository = DynamoManifestRepository(client, "hot", clock=lambda: NOW)
    candidate = manifest("dsv_frozen")
    repository.put_candidate(candidate, expected_absent=True, idempotency_key="put-frozen")

    assert repository.activate(None, candidate, idempotency_key="activate-frozen") == candidate

    assert client.get_item(
        TableName="hot",
        Key={
            "pk": {"S": "DATASET#dsv_frozen#INGESTION#PROJECTION_FENCE"},
            "sk": {"S": "ACTIVE"},
        },
        ConsistentRead=True,
    )["Item"] == {
        "pk": {"S": "DATASET#dsv_frozen#INGESTION#PROJECTION_FENCE"},
        "sk": {"S": "ACTIVE"},
        "entityType": {"S": "ACTIVE_PROJECTION_FENCE"},
        "datasetVersion": {"S": "dsv_frozen"},
    }


@mock_aws
def test_activation_replay_fails_closed_when_its_projection_fence_is_missing() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    repository = DynamoManifestRepository(client, "hot", clock=lambda: NOW)
    candidate = manifest("dsv_replay_fence")
    repository.put_candidate(candidate, expected_absent=True, idempotency_key="put-replay-fence")
    repository.activate(None, candidate, idempotency_key="activate-replay-fence")
    client.delete_item(
        TableName="hot",
        Key={
            "pk": {"S": "DATASET#dsv_replay_fence#INGESTION#PROJECTION_FENCE"},
            "sk": {"S": "ACTIVE"},
        },
    )

    with pytest.raises(RuntimeError, match="projection fence"):
        DynamoManifestRepository(client, "hot", clock=lambda: NOW).activate(
            None, candidate, idempotency_key="activate-replay-fence"
        )


@mock_aws
def test_activation_replay_returns_original_after_a_later_activation_and_conflict_fails() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    repository = DynamoManifestRepository(client, "hot", clock=lambda: NOW)
    old = manifest("dsv_old")
    first = manifest("dsv_first", checksum="b" * 64)
    later = manifest("dsv_later", checksum="c" * 64)
    for value in (old, first, later):
        repository.put_candidate(
            value,
            expected_absent=True,
            idempotency_key=f"put-{value.dataset_version}",
        )
    repository.activate(None, old, idempotency_key="activate-old")
    activated = repository.activate("dsv_old", first, idempotency_key="activate-first")
    repository.activate("dsv_first", later, idempotency_key="activate-later")

    restarted = DynamoManifestRepository(client, "hot", clock=lambda: NOW)
    assert restarted.activate("dsv_old", first, idempotency_key="activate-first") == activated
    assert restarted.get_active() == later
    with pytest.raises(IdempotencyConflict):
        restarted.activate("dsv_later", first, idempotency_key="activate-first")


@mock_aws
def test_activation_rejects_absent_or_divergent_candidate_without_reserving_key() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    repository = DynamoManifestRepository(client, "hot", clock=lambda: NOW)
    old = manifest("dsv_old")
    new = manifest("dsv_new", checksum="b" * 64)
    repository.put_candidate(old, expected_absent=True, idempotency_key="put-old")
    repository.activate(None, old, idempotency_key="activate-old")

    with pytest.raises(ConditionalWriteError, match="candidate"):
        repository.activate("dsv_old", new, idempotency_key="activate-new")
    repository.put_candidate(new, expected_absent=True, idempotency_key="put-new")
    assert repository.activate("dsv_old", new, idempotency_key="activate-new") == new

    divergent = manifest("dsv_new", checksum="c" * 64)
    with pytest.raises(ConditionalWriteError, match="candidate"):
        repository.activate("dsv_new", divergent, idempotency_key="divergent")


@mock_aws
def test_stale_activation_cas_never_changes_active_manifest() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    repository = DynamoManifestRepository(client, "hot", clock=lambda: NOW)
    old = manifest("dsv_old")
    new = manifest("dsv_new", checksum="b" * 64)
    repository.put_candidate(old, expected_absent=True, idempotency_key="put-old")
    repository.put_candidate(new, expected_absent=True, idempotency_key="put-new")
    repository.activate(None, old, idempotency_key="activate-old")

    with pytest.raises(ConcurrentActivationError):
        repository.activate(None, new, idempotency_key="stale-cas")
    assert repository.get_active() == old


def test_get_active_reads_only_the_active_control_key() -> None:
    class Client:
        def __init__(self) -> None:
            self.calls: list[dict[str, object]] = []

        def get_item(self, **kwargs: object) -> Mapping[str, object]:
            self.calls.append(dict(kwargs))
            return {"ResponseMetadata": {"HTTPStatusCode": 200}}

        def transact_write_items(self, **_kwargs: object) -> Mapping[str, object]:
            raise AssertionError("unexpected transaction")

    client = Client()
    repository = DynamoManifestRepository(client, "hot", clock=lambda: NOW)

    assert repository.get_active() is None
    assert client.calls == [
        {
            "TableName": "hot",
            "Key": {"pk": {"S": "CONTROL#DATASET"}, "sk": {"S": "ACTIVE"}},
            "ConsistentRead": True,
        }
    ]


def test_malformed_active_item_fails_closed_without_echoing_aws_content() -> None:
    secret = "secret-aws-content"

    class Client:
        def get_item(self, **_kwargs: object) -> Mapping[str, object]:
            return {
                "Item": {
                    "pk": SERIALIZER.serialize("CONTROL#DATASET"),
                    "sk": SERIALIZER.serialize("ACTIVE"),
                    "manifest": {"S": secret},
                }
            }

        def transact_write_items(self, **_kwargs: object) -> Mapping[str, object]:
            raise AssertionError("unexpected transaction")

    repository = DynamoManifestRepository(Client(), "hot", clock=lambda: NOW)
    with pytest.raises(RuntimeError) as captured:
        repository.get_active()
    assert secret not in str(captured.value)


@mock_aws
def test_incomplete_or_unreal_manifest_contract_is_rejected_before_storage() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    repository = DynamoManifestRepository(client, "hot", clock=lambda: NOW)
    incomplete = CandidateManifest("dsv_incomplete", {"canonicalSchemaVersion": "1.0"})
    with pytest.raises(ValueError, match="required contract"):
        repository.put_candidate(
            incomplete,
            expected_absent=True,
            idempotency_key="incomplete",
        )

    good = manifest("dsv_bad_interval")
    bad_metadata = dict(good.metadata)
    bad_metadata["availableIntervals"] = {
        "signal_bucket": ({"start": "2026-09-02T00:00:00Z", "end": "2026-09-01T00:00:00Z"},)
    }
    with pytest.raises(ValueError, match="half-open"):
        repository.put_candidate(
            CandidateManifest(good.dataset_version, bad_metadata),
            expected_absent=True,
            idempotency_key="bad-interval",
        )


@mock_aws
def test_failed_manifest_validation_cannot_cross_activation_boundary_or_reserve_key() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    repository = DynamoManifestRepository(client, "hot", clock=lambda: NOW)
    old = manifest("dsv_old")
    repository.put_candidate(old, expected_absent=True, idempotency_key="put-old")
    repository.activate(None, old, idempotency_key="activate-old")

    ready = manifest("dsv_new", checksum="b" * 64)
    failed_metadata = dict(ready.metadata)
    failed_validations = {
        name: dict(cast(Mapping[str, object], value))
        for name, value in cast(Mapping[str, object], ready.metadata["validations"]).items()
    }
    failed_validations["parquetCatalog"]["state"] = "FAILED"
    failed_metadata["validations"] = failed_validations
    failed = CandidateManifest(ready.dataset_version, failed_metadata)
    repository.put_candidate(failed, expected_absent=True, idempotency_key="put-failed")

    with pytest.raises(ConditionalWriteError, match="validation"):
        repository.activate("dsv_old", failed, idempotency_key="activate-new")

    repository.put_candidate(ready, expected_absent=False, idempotency_key="repair-candidate")
    assert repository.activate("dsv_old", ready, idempotency_key="activate-new") == ready


@mock_aws
def test_manifest_requires_exactly_the_five_closed_activation_categories() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    repository = DynamoManifestRepository(client, "hot", clock=lambda: NOW)
    value = manifest("dsv_bad_validations")
    metadata = dict(value.metadata)
    metadata["validations"] = {
        "anything": {"state": "PASSED", "validatedAt": "2026-09-08T12:00:00Z"}
    }

    with pytest.raises(ValueError, match="five activation categories"):
        repository.put_candidate(
            CandidateManifest(value.dataset_version, metadata),
            expected_absent=True,
            idempotency_key="arbitrary-validation",
        )


@mock_aws
def test_unavailable_dataset_preserves_zero_intervals_without_becoming_active() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    repository = DynamoManifestRepository(client, "hot", clock=lambda: NOW)
    old = manifest("dsv_old")
    repository.put_candidate(old, expected_absent=True, idempotency_key="put-old")
    repository.activate(None, old, idempotency_key="activate-old")
    unavailable = manifest("dsv_unavailable", checksum="b" * 64)
    metadata = dict(unavailable.metadata)
    metadata["availableIntervals"] = {"signal_bucket": ()}
    metadata["hotFrom"] = {"signal_bucket": None}
    metadata["watermarks"] = {"signal_bucket": None}
    metadata["coverage"] = {"signal_bucket": "UNAVAILABLE"}
    validations = {
        name: dict(cast(Mapping[str, object], value))
        for name, value in cast(Mapping[str, object], metadata["validations"]).items()
    }
    coverage_quality = dict(validations["coverageQuality"])
    coverage_quality["datasets"] = {
        "signal_bucket": {"coverage": "UNAVAILABLE", "qualityFlags": ()}
    }
    validations["coverageQuality"] = coverage_quality
    metadata["validations"] = validations
    candidate = CandidateManifest(unavailable.dataset_version, metadata)

    repository.put_candidate(candidate, expected_absent=True, idempotency_key="put-unavailable")
    with pytest.raises(ConditionalWriteError, match="validation"):
        repository.activate("dsv_old", candidate, idempotency_key="activate-unavailable")


@mock_aws
def test_activation_classifies_conditional_and_transient_cancellation_reasons() -> None:
    client = boto3.client("dynamodb", region_name="us-east-1")
    create_table(client)
    repository = DynamoManifestRepository(client, "hot", clock=lambda: NOW)
    old = manifest("dsv_old")
    new = manifest("dsv_new", checksum="b" * 64)
    later = manifest("dsv_later", checksum="c" * 64)
    for value in (old, new, later):
        repository.put_candidate(
            value,
            expected_absent=True,
            idempotency_key=f"put-{value.dataset_version}",
        )
    repository.activate(None, old, idempotency_key="activate-old")

    class CancelOnce:
        def __init__(self, reasons: list[dict[str, str]]) -> None:
            self.reasons = reasons

        def get_item(self, **kwargs: object) -> Mapping[str, object]:
            return cast(Mapping[str, object], client.get_item(**kwargs))

        def transact_write_items(self, **_kwargs: object) -> Mapping[str, object]:
            raise ClientError(
                {
                    "Error": {"Code": "TransactionCanceledException", "Message": "cancelled"},
                    "CancellationReasons": self.reasons,
                },
                "TransactWriteItems",
            )

    conditional = DynamoManifestRepository(
        CancelOnce(
            [
                {"Code": "None"},
                {"Code": "ConditionalCheckFailed"},
                {"Code": "None"},
                {"Code": "None"},
            ]
        ),
        "hot",
        clock=lambda: NOW,
    )
    with pytest.raises(ConcurrentActivationError):
        conditional.activate("dsv_old", new, idempotency_key="conditional-key")
    assert repository.activate("dsv_old", new, idempotency_key="conditional-key") == new

    transient = DynamoManifestRepository(
        CancelOnce(
            [
                {"Code": "TransactionConflict"},
                {"Code": "None"},
                {"Code": "None"},
                {"Code": "None"},
            ]
        ),
        "hot",
        clock=lambda: NOW,
    )
    with pytest.raises(DynamoDbThrottled):
        transient.activate("dsv_new", later, idempotency_key="transient-key")
    assert repository.activate("dsv_new", later, idempotency_key="transient-key") == later
