"""AWS boundary checks for worker CAS updates and atomic terminal lock release."""

import importlib
from copy import deepcopy

import pytest
from boto3.dynamodb.types import TypeDeserializer, TypeSerializer
from botocore.exceptions import ClientError

from domain.import_job import ImportJobValidationError, ImportState, ImportStateConflict
from tests.unit.domain.test_import_job import fixture

SERIALIZER = TypeSerializer()
DESERIALIZER = TypeDeserializer()
IMPORT_ID = "imp_01K59Z5XE00000000000000000"


def wire(item: dict) -> dict:
    return {name: SERIALIZER.serialize(value) for name, value in item.items()}


def values(command: dict) -> dict:
    return {
        name: DESERIALIZER.deserialize(value)
        for name, value in command["ExpressionAttributeValues"].items()
    }


class Client:
    def __init__(self, before=None, after=None, error=None):
        self.before = fixture() if before is None else before
        self.after = after
        self.error = error
        self.calls = []
        self.written = False

    def get_item(self, **kwargs):
        self.calls.append(("get", kwargs))
        item = self.after if self.written else self.before
        return {"Item": wire(item)} if item else {}

    def update_item(self, **kwargs):
        self.calls.append(("update", kwargs))
        if self.error:
            raise self.error
        self.written = True
        return {"Attributes": wire(self.after)} if self.after else {}

    def transact_write_items(self, **kwargs):
        self.calls.append(("transaction", kwargs))
        if self.error:
            raise self.error
        self.written = True
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}


def repository(client):
    try:
        module = importlib.import_module("adapters.dynamodb.import_jobs")
    except ModuleNotFoundError:
        pytest.fail("The DynamoDB worker import repository is missing")
    return module.DynamoImportJobRepository(client, "imports-table")


def test_get_uses_consistent_read_and_validates_identity() -> None:
    client = Client()
    job = repository(client).get(IMPORT_ID)
    assert job.version == 4
    assert client.calls == [
        (
            "get",
            {
                "TableName": "imports-table",
                "ConsistentRead": True,
                "Key": {"pk": {"S": "IMPORTS"}, "sk": {"S": f"IMPORT#{IMPORT_ID}"}},
            },
        )
    ]
    assert repository(Client(before={})).get(IMPORT_ID) is None
    with pytest.raises(ImportJobValidationError):
        repository(client).get("malformed")


def test_progress_conditions_processing_and_version_without_a_state_transition():
    before = {**fixture(), "state": "PROCESSING"}
    progress = {
        "kind": "stage",
        "stage": "INGESTING",
        "recordsRead": 10,
        "recordsWritten": 9,
        "recordsRejected": 1,
    }
    after = {**before, "progress": progress, "progressRunStage": "INGESTING", "version": 5}
    client = Client(before=before, after=after)
    actual = repository(client).update_progress(
        IMPORT_ID, 4, {"progress": progress, "progressRunStage": "INGESTING"}
    )
    assert actual.state == ImportState.PROCESSING and actual.version == 5
    command = next(command for kind, command in client.calls if kind == "update")
    assert values(command)[":expectedState"] == "PROCESSING"
    assert values(command)[":expectedVersion"] == 4
    assert actual.progress_run_stage == "INGESTING"
    assert "progressRunStage" in command["ExpressionAttributeNames"].values()
    with pytest.raises(ImportStateConflict):
        repository(Client()).update_progress(IMPORT_ID, 4, {"progress": progress})
    with pytest.raises(ImportStateConflict):
        repository(Client(before=before)).update_progress(IMPORT_ID, 3, {"progress": progress})
    with pytest.raises(ImportJobValidationError):
        repository(Client(before=before)).update_progress(IMPORT_ID, 4, {"taskArn": "bad"})


def test_transition_conditions_state_version_and_returns_confirmed_record() -> None:
    after = {**fixture(), "state": "VALIDATING", "version": 5}
    client = Client(after=after)
    job = repository(client).transition(
        IMPORT_ID, ImportState.UPLOADED, 4, ImportState.VALIDATING, {}
    )
    assert job.state is ImportState.VALIDATING and job.version == 5
    command = next(command for kind, command in client.calls if kind == "update")
    assert command["ReturnValues"] == "ALL_NEW"
    assert command["ConditionExpression"] == (
        "attribute_exists(pk) AND #state = :expectedState AND #version = :expectedVersion"
    )
    assert command["ExpressionAttributeNames"]["#state"] == "state"
    assert command["ExpressionAttributeNames"]["#version"] == "version"
    assert values(command)[":expectedState"] == "UPLOADED"
    assert values(command)[":expectedVersion"] == 4
    assert values(command)[":nextVersion"] == 5
    assert values(command)[":nextState"] == "VALIDATING"


@pytest.mark.parametrize(
    "field",
    [
        "pk",
        "sk",
        "importId",
        "requestedBy",
        "author",
        "state",
        "version",
        "createdAt",
        "bucket",
        "key",
        "pipelineVersion",
        "unknown",
    ],
)
def test_rejects_identity_or_arbitrary_patch_without_writing(field: str) -> None:
    client = Client()
    with pytest.raises(ImportJobValidationError):
        repository(client).transition(
            IMPORT_ID, ImportState.UPLOADED, 4, ImportState.VALIDATING, {field: "overwrite"}
        )
    assert all(kind == "get" for kind, _ in client.calls)


@pytest.mark.parametrize("state", [ImportState.READY, ImportState.FAILED, ImportState.UPLOADED])
def test_transition_cannot_skip_or_bypass_terminal_transaction(state) -> None:
    client = Client()
    with pytest.raises(ImportStateConflict):
        repository(client).transition(IMPORT_ID, ImportState.UPLOADED, 4, state, {})
    assert all(kind == "get" for kind, _ in client.calls)


def test_stale_version_never_writes() -> None:
    client = Client()
    with pytest.raises(ImportStateConflict):
        repository(client).transition(
            IMPORT_ID, ImportState.UPLOADED, 3, ImportState.VALIDATING, {}
        )
    assert all(kind == "get" for kind, _ in client.calls)


def test_finish_atomic_update_and_owner_checked_delete() -> None:
    before = {**fixture(), "state": "PROCESSING"}
    after = {**before, "state": "READY", "version": 5}
    client = Client(before=before, after=after)
    job = repository(client).finish(IMPORT_ID, 4, ImportState.READY, {})
    assert job.state is ImportState.READY and job.version == 5
    transaction = next(command for kind, command in client.calls if kind == "transaction")
    assert len(transaction["TransactItems"]) == 2
    update = transaction["TransactItems"][0]["Update"]
    delete = transaction["TransactItems"][1]["Delete"]
    assert "#state = :expectedState" in update["ConditionExpression"]
    assert "#version = :expectedVersion" in update["ConditionExpression"]
    assert values(update)[":expectedState"] == "PROCESSING"
    assert values(update)[":nextState"] == "READY"
    assert "ReturnValues" not in update
    assert delete["Key"] == {"pk": {"S": "CONTROL#IMPORT"}, "sk": {"S": "ACTIVE"}}
    assert delete["ConditionExpression"] == "#importId = :importId"
    assert delete["ExpressionAttributeNames"] == {"#importId": "importId"}
    assert values(delete)[":importId"] == IMPORT_ID
    assert client.calls[-1][0] == "get" and client.calls[-1][1]["ConsistentRead"] is True


@pytest.mark.parametrize("before_state", list(ImportState))
def test_failed_allowed_only_from_nonterminal(before_state) -> None:
    before = {**fixture(), "state": before_state.value}
    after = {**before, "state": "FAILED", "version": 5}
    client = Client(before=before, after=after)
    if before_state in (ImportState.READY, ImportState.FAILED):
        with pytest.raises(ImportStateConflict):
            repository(client).finish(IMPORT_ID, 4, ImportState.FAILED, {})
    else:
        assert repository(client).finish(IMPORT_ID, 4, ImportState.FAILED, {}).version == 5


def test_ready_cannot_finish_uploaded() -> None:
    with pytest.raises(ImportStateConflict):
        repository(Client()).finish(IMPORT_ID, 4, ImportState.READY, {})


def test_error_patch_is_sanitized_before_persistence() -> None:
    error = {
        "code": "MYSQL_CONNECTION_LOST",
        "message": "trace s3://private-bucket/private-key",
        "requestId": "req_import_01K59Z5XE00000000000000000",
        "stage": "INGESTING",
        "retryable": True,
        "attempt": 4,
        "maxAttempts": 4,
    }
    after = {
        **fixture(),
        "state": "FAILED",
        "version": 5,
        "error": {
            **error,
            "message": "A conexão com o MySQL foi perdida após as tentativas de reconexão.",
        },
    }
    client = Client(after=after)
    repository(client).finish(IMPORT_ID, 4, ImportState.FAILED, {"error": error})
    transaction = next(command for kind, command in client.calls if kind == "transaction")
    assert "private-bucket" not in str(transaction)
    assert "private-key" not in str(transaction)
    persisted = values(transaction["TransactItems"][0]["Update"])
    assert {
        **error,
        "message": "A conexão com o MySQL foi perdida após as tentativas de reconexão.",
    } in persisted.values()


@pytest.mark.parametrize("transaction", [False, True])
def test_conditional_conflicts_are_deterministic(transaction: bool) -> None:
    error = ClientError(
        {
            "Error": {
                "Code": "TransactionCanceledException"
                if transaction
                else "ConditionalCheckFailedException",
                "Message": "secret",
            },
            "CancellationReasons": [{"Code": "ConditionalCheckFailed"}, {"Code": "None"}],
        },
        "write",
    )
    repo = repository(Client(error=error))
    with pytest.raises(ImportStateConflict, match="Import state conflict"):
        if transaction:
            repo.finish(IMPORT_ID, 4, ImportState.FAILED, {})
        else:
            repo.transition(IMPORT_ID, ImportState.UPLOADED, 4, ImportState.VALIDATING, {})


def test_missing_or_wrong_write_confirmation_is_not_success() -> None:
    module = importlib.import_module("adapters.dynamodb.import_jobs")
    for after in ({}, deepcopy(fixture())):
        with pytest.raises(module.ImportJobRepositoryError):
            repository(Client(after=after)).transition(
                IMPORT_ID, ImportState.UPLOADED, 4, ImportState.VALIDATING, {}
            )
        with pytest.raises(module.ImportJobRepositoryError):
            repository(Client(after=after)).finish(IMPORT_ID, 4, ImportState.FAILED, {})


@pytest.mark.parametrize(
    "patch",
    [
        {"progress": {"kind": "bytes", "completedBytes": 10, "totalBytes": 9}},
        {"updatedAt": "2026-09-17T10:00:00"},
        {"physicalVersion": 123},
        {"error": {"code": "UNKNOWN", "message": "secret"}},
    ],
)
def test_malformed_patch_is_rejected_before_write(patch) -> None:
    client = Client()
    with pytest.raises(ImportJobValidationError):
        repository(client).transition(
            IMPORT_ID, ImportState.UPLOADED, 4, ImportState.VALIDATING, patch
        )
    assert all(kind == "get" for kind, _ in client.calls)


@pytest.mark.parametrize("version", [True, -1, 2**53 - 1, 1.5])
def test_invalid_expected_version_cannot_issue_write(version) -> None:
    client = Client()
    with pytest.raises(ImportJobValidationError):
        repository(client).transition(
            IMPORT_ID, ImportState.UPLOADED, version, ImportState.VALIDATING, {}
        )
    assert client.calls == []


def test_infrastructure_cancellation_is_not_a_state_conflict() -> None:
    module = importlib.import_module("adapters.dynamodb.import_jobs")
    error = ClientError(
        {
            "Error": {"Code": "TransactionCanceledException", "Message": "secret"},
            "CancellationReasons": [
                {"Code": "ConditionalCheckFailed"},
                {"Code": "ThrottlingError"},
            ],
        },
        "write",
    )
    with pytest.raises(module.ImportJobRepositoryError, match="not confirmed") as failure:
        repository(Client(error=error)).finish(IMPORT_ID, 4, ImportState.FAILED, {})
    assert "secret" not in str(failure.value)


@pytest.mark.parametrize(
    "code",
    [
        "ProvisionedThroughputExceededException",
        "RequestLimitExceeded",
        "ThrottlingException",
    ],
)
def test_throttling_is_exposed_as_a_typed_retryable_store_failure(code: str) -> None:
    module = importlib.import_module("adapters.dynamodb.import_jobs")
    error = ClientError({"Error": {"Code": code, "Message": "secret"}}, "write")

    with pytest.raises(module.DynamoDbThrottled) as failure:
        repository(Client(error=error)).transition(
            IMPORT_ID, ImportState.UPLOADED, 4, ImportState.VALIDATING, {}
        )

    assert "secret" not in str(failure.value)


@pytest.mark.parametrize(
    "missing", ["completionRequestedAt", "completionUploadGeneration", "physicalVersion"]
)
@pytest.mark.parametrize(
    "state,next_state",
    [
        (ImportState.UPLOADED, ImportState.VALIDATING),
        (ImportState.VALIDATING, ImportState.PROCESSING),
        (ImportState.PROCESSING, ImportState.READY),
        (ImportState.READY, ImportState.FAILED),
    ],
)
def test_incomplete_stored_record_never_writes(missing, state, next_state) -> None:
    before = {**fixture(), "state": state.value}
    if missing == "physicalVersion":
        before[missing] = None
    else:
        before.pop(missing)
    client = Client(before=before, after={**before, "state": next_state.value, "version": 5})
    with pytest.raises(ImportJobValidationError):
        repo = repository(client)
        if next_state in (ImportState.READY, ImportState.FAILED):
            repo.finish(IMPORT_ID, 4, next_state, {})
        else:
            repo.transition(IMPORT_ID, state, 4, next_state, {})
    assert all(kind == "get" for kind, _ in client.calls)


@pytest.mark.parametrize("terminal", [False, True])
def test_patch_cannot_remove_required_physical_version(terminal: bool) -> None:
    before = {**fixture(), "state": "PROCESSING" if terminal else "UPLOADED"}
    client = Client(
        before=before,
        after={
            **before,
            "physicalVersion": None,
            "state": "READY" if terminal else "VALIDATING",
            "version": 5,
        },
    )
    with pytest.raises(ImportJobValidationError):
        repo = repository(client)
        if terminal:
            repo.finish(IMPORT_ID, 4, ImportState.READY, {"physicalVersion": None})
        else:
            repo.transition(
                IMPORT_ID,
                ImportState.UPLOADED,
                4,
                ImportState.VALIDATING,
                {"physicalVersion": None},
            )
    assert all(kind == "get" for kind, _ in client.calls)
