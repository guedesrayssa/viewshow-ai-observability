"""Low-level boto3 worker repository with CAS and atomic terminal lock release."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Literal, Protocol

from boto3.dynamodb.types import TypeSerializer  # type: ignore[import-untyped]
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from adapters.dynamodb.client import (
    DynamoDbThrottled as _DynamoDbThrottled,
)
from adapters.dynamodb.client import (
    decode_get_item,
    raise_if_dynamodb_throttled,
    validate_transaction_response,
)
from domain.import_job import (
    MAX_SAFE_INTEGER,
    ImportJob,
    ImportJobValidationError,
    ImportState,
    ImportStateConflict,
    assert_import_transition,
    integer,
    validate_import_id,
)

DynamoDbThrottled = _DynamoDbThrottled
DynamoDBThrottled = _DynamoDbThrottled
_SERIALIZER = TypeSerializer()
_WORKER_PATCH_FIELDS = frozenset(
    {
        "updatedAt",
        "progress",
        "candidateVersion",
        "error",
        "taskArn",
        "physicalVersion",
        "progressRunStage",
    }
)


class ImportJobRepositoryError(RuntimeError):
    """The store did not confirm the requested operation; retry/reconcile externally."""


class ImportJobClient(Protocol):
    def get_item(self, **kwargs: object) -> Mapping[str, object]: ...
    def update_item(self, **kwargs: object) -> Mapping[str, object]: ...
    def transact_write_items(self, **kwargs: object) -> Mapping[str, object]: ...


def _serialize(item: Mapping[str, object]) -> dict[str, object]:
    return {name: _SERIALIZER.serialize(value) for name, value in item.items()}


def _key(import_id: str) -> dict[str, object]:
    return _serialize({"pk": "IMPORTS", "sk": f"IMPORT#{validate_import_id(import_id)}"})


def _raise_store_error(error: ClientError) -> None:
    response = error.response
    code = response.get("Error", {}).get("Code")
    if code == "ConditionalCheckFailedException":
        raise ImportStateConflict("Import state conflict") from None
    reasons = response.get("CancellationReasons", [])
    raise_if_dynamodb_throttled(error)
    if (
        code == "TransactionCanceledException"
        and isinstance(reasons, list)
        and reasons
        and all(
            isinstance(reason, dict) and reason.get("Code") in {"None", "ConditionalCheckFailed"}
            for reason in reasons
        )
        and any(reason.get("Code") == "ConditionalCheckFailed" for reason in reasons)
    ):
        raise ImportStateConflict("Import state conflict") from None
    raise ImportJobRepositoryError("Import store operation was not confirmed") from None


class DynamoImportJobRepository:
    """Uses a boto3 DynamoDB *client*, not a document/table resource."""

    def __init__(self, client: ImportJobClient, table_name: str) -> None:
        self._client = client
        self._table_name = table_name

    def get(self, import_id: str) -> ImportJob | None:
        key = _key(import_id)
        try:
            response = self._client.get_item(
                TableName=self._table_name,
                Key=key,
                ConsistentRead=True,
            )
        except ClientError as error:
            _raise_store_error(error)
            raise AssertionError("unreachable") from None
        item = decode_get_item(response)
        if item is None:
            return None
        job = ImportJob.from_item(item)
        if job.import_id != import_id:
            raise ImportJobRepositoryError("Import store returned a different identity")
        return job

    def _prepare(
        self,
        import_id: str,
        expected_version: int,
        next_state: ImportState,
        patch: Mapping[str, object],
        expected_state: ImportState | None = None,
        *,
        progress_only: bool = False,
    ) -> tuple[dict[str, object], ImportJob]:
        integer(expected_version, 0, MAX_SAFE_INTEGER - 1)
        if set(patch) - _WORKER_PATCH_FIELDS:
            raise ImportJobValidationError("Import patch contains forbidden fields")
        current = self.get(import_id)
        if (
            current is None
            or current.version != expected_version
            or (expected_state is not None and current.state != expected_state)
        ):
            raise ImportStateConflict("Import state conflict")
        if not progress_only:
            assert_import_transition(current.state, next_state)
        proposed = ImportJob.from_item(
            {
                **current.to_item(),
                **patch,
                "state": next_state.value,
                "version": expected_version + 1,
            }
        )
        canonical = proposed.to_item()
        names = {"#state": "state", "#version": "version"}
        values: dict[str, object] = {
            ":expectedState": current.state.value,
            ":expectedVersion": expected_version,
            ":nextState": next_state.value,
            ":nextVersion": expected_version + 1,
        }
        expressions = ["#state = :nextState", "#version = :nextVersion"]
        for index, name in enumerate(patch):
            names[f"#p{index}"] = name
            values[f":p{index}"] = canonical[name]
            expressions.append(f"#p{index} = :p{index}")
        return {
            "TableName": self._table_name,
            "Key": _key(import_id),
            "UpdateExpression": "SET " + ", ".join(expressions),
            "ConditionExpression": (
                "attribute_exists(pk) AND #state = :expectedState AND #version = :expectedVersion"
            ),
            "ExpressionAttributeNames": names,
            "ExpressionAttributeValues": _serialize(values),
        }, proposed

    @staticmethod
    def _confirm(actual: ImportJob | None, proposed: ImportJob) -> ImportJob:
        if actual is None or actual.to_item() != proposed.to_item():
            raise ImportJobRepositoryError("Import write confirmation did not match")
        return actual

    def transition(
        self,
        import_id: str,
        expected_state: ImportState,
        expected_version: int,
        next_state: ImportState,
        patch: Mapping[str, object],
    ) -> ImportJob:
        assert_import_transition(expected_state, next_state)
        if next_state in (ImportState.READY, ImportState.FAILED):
            raise ImportStateConflict("Import state conflict")
        command, proposed = self._prepare(
            import_id,
            expected_version,
            next_state,
            patch,
            expected_state,
        )
        try:
            response = self._client.update_item(**command, ReturnValues="ALL_NEW")
        except ClientError as error:
            _raise_store_error(error)
            raise AssertionError("unreachable") from None
        if "Attributes" not in response:
            raise ImportJobRepositoryError("Import write returned no record")
        item = decode_get_item({"Item": response["Attributes"]})
        return self._confirm(ImportJob.from_item(item) if item is not None else None, proposed)

    def finish(
        self,
        import_id: str,
        expected_version: int,
        state: Literal[ImportState.READY, ImportState.FAILED],
        patch: Mapping[str, object],
    ) -> ImportJob:
        if state not in (ImportState.READY, ImportState.FAILED):
            raise ImportStateConflict("Import state conflict")
        update, proposed = self._prepare(import_id, expected_version, state, patch)
        delete = {
            "TableName": self._table_name,
            "Key": _serialize({"pk": "CONTROL#IMPORT", "sk": "ACTIVE"}),
            "ConditionExpression": "#importId = :importId",
            "ExpressionAttributeNames": {"#importId": "importId"},
            "ExpressionAttributeValues": _serialize({":importId": import_id}),
        }
        try:
            response = self._client.transact_write_items(
                TransactItems=[{"Update": update}, {"Delete": delete}],
            )
        except ClientError as error:
            _raise_store_error(error)
            raise AssertionError("unreachable") from None
        validate_transaction_response(response)
        return self._confirm(self.get(import_id), proposed)

    def update_progress(
        self,
        import_id: str,
        expected_version: int,
        patch: Mapping[str, object],
    ) -> ImportJob:
        if not patch or set(patch) - {"updatedAt", "progress", "progressRunStage"}:
            raise ImportJobValidationError("Invalid import progress patch")
        command, proposed = self._prepare(
            import_id,
            expected_version,
            ImportState.PROCESSING,
            patch,
            ImportState.PROCESSING,
            progress_only=True,
        )
        try:
            response = self._client.update_item(**command, ReturnValues="ALL_NEW")
        except ClientError as error:
            _raise_store_error(error)
            raise AssertionError("unreachable") from None
        if "Attributes" not in response:
            raise ImportJobRepositoryError("Import write returned no record")
        item = decode_get_item({"Item": response["Attributes"]})
        return self._confirm(ImportJob.from_item(item) if item is not None else None, proposed)
