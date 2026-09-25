"""Validated cross-runtime import records; public errors never carry infrastructure details."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field, fields
from datetime import UTC, date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Literal, Protocol

from domain.run import RunPipeline, RunStage

MAX_SAFE_INTEGER = 2**53 - 1


class ImportJobValidationError(ValueError):
    """The stored record or requested patch violates the import contract."""


class ImportStateConflict(RuntimeError):
    """A concurrent change or invalid transition prevented the write."""


class ImportState(StrEnum):
    PREPARING = "PREPARING"
    UPLOADING = "UPLOADING"
    UPLOADED = "UPLOADED"
    VALIDATING = "VALIDATING"
    PROCESSING = "PROCESSING"
    READY = "READY"
    FAILED = "FAILED"


ALLOWED_TRANSITIONS: Mapping[ImportState, frozenset[ImportState]] = {
    ImportState.PREPARING: frozenset({ImportState.UPLOADING, ImportState.FAILED}),
    ImportState.UPLOADING: frozenset({ImportState.UPLOADED, ImportState.FAILED}),
    ImportState.UPLOADED: frozenset({ImportState.VALIDATING, ImportState.FAILED}),
    ImportState.VALIDATING: frozenset({ImportState.PROCESSING, ImportState.FAILED}),
    ImportState.PROCESSING: frozenset({ImportState.READY, ImportState.FAILED}),
    ImportState.READY: frozenset(),
    ImportState.FAILED: frozenset(),
}


def assert_import_transition(before: ImportState, after: ImportState) -> None:
    if after not in ALLOWED_TRANSITIONS.get(before, frozenset()):
        raise ImportStateConflict("Import state conflict")


def validate_import_id(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"imp_[0-7][0-9A-HJKMNP-TV-Z]{25}", value):
        raise ImportJobValidationError("Invalid import identifier")
    return value


def import_request_id(import_id: str) -> str:
    return "req_import_" + validate_import_id(import_id).removeprefix("imp_")


def integer(value: object, minimum: int = 0, maximum: int = MAX_SAFE_INTEGER) -> int:
    if isinstance(value, bool) or not isinstance(value, int | Decimal):
        raise ImportJobValidationError("Invalid import integer")
    if isinstance(value, Decimal) and (not value.is_finite() or value != value.to_integral_value()):
        raise ImportJobValidationError("Invalid import integer")
    if value < minimum or value > maximum:
        raise ImportJobValidationError("Invalid import integer")
    return int(value)


def _text(value: object, *, empty: bool = False, maximum: int = 4096) -> str:
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        raise ImportJobValidationError("Invalid import text")
    return value


def _nullable_text(value: object) -> str | None:
    return None if value is None else _text(value)


def _datetime(value: object) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)", value
    ):
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            raise ImportJobValidationError("Invalid import timestamp") from None
    else:
        raise ImportJobValidationError("Invalid import timestamp")
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ImportJobValidationError("Import timestamp requires an offset")
    normalized = parsed.astimezone(UTC)
    if normalized.microsecond % 1000:
        raise ImportJobValidationError("Import timestamp requires exact millisecond precision")
    return normalized


def _mapping(value: object, expected: set[str]) -> Mapping[str, object]:
    if not isinstance(value, Mapping) or set(value) != expected:
        raise ImportJobValidationError("Invalid import object fields")
    return value


def _progress(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping):
        raise ImportJobValidationError("Invalid import progress")
    kind = value.get("kind")
    if kind == "none":
        _mapping(value, {"kind"})
        return {"kind": "none"}
    if kind == "bytes":
        row = _mapping(value, {"kind", "completedBytes", "totalBytes"})
        total = integer(row["totalBytes"], 1)
        return {
            "kind": "bytes",
            "completedBytes": integer(row["completedBytes"], 0, total),
            "totalBytes": total,
        }
    if kind == "stage":
        counts = {"recordsRead", "recordsWritten", "recordsRejected"}
        base_fields = {"kind", "stage", *counts}
        detail_fields = {
            "stageStartedAt",
            "heartbeatAt",
            "recordsTotal",
            "currentDataset",
            "datasetsCompleted",
            "datasetsTotal",
        }
        optional_fields = {"substage", "currentPartition"}
        unit_fields = {"unitsCompleted", "unitsTotal", "unitLabel"}
        actual = set(value)
        if actual - base_fields - detail_fields - optional_fields - unit_fields:
            raise ImportJobValidationError("Invalid import progress fields")
        if not base_fields <= actual:
            raise ImportJobValidationError("Invalid import progress fields")
        detail_count = len(actual & detail_fields)
        if detail_count not in (0, len(detail_fields)):
            raise ImportJobValidationError("Invalid import progress fields")
        unit_count = len(actual & unit_fields)
        if unit_count not in (0, len(unit_fields)):
            raise ImportJobValidationError("Invalid import progress fields")
        row = value
        records_read = integer(row["recordsRead"])
        try:
            stage = RunStage(_text(row["stage"], maximum=128)).value
        except ValueError:
            raise ImportJobValidationError("Invalid import progress stage") from None
        progress: dict[str, object] = {
            "kind": "stage",
            "stage": stage,
            "recordsRead": records_read,
            "recordsWritten": integer(row["recordsWritten"]),
            "recordsRejected": integer(row["recordsRejected"]),
        }
        for name in optional_fields:
            if name in row:
                text = _text(row[name], maximum=128)
                progress[name] = text
        if unit_count:
            completed_units = integer(row["unitsCompleted"])
            total_units = integer(row["unitsTotal"])
            if completed_units > total_units:
                raise ImportJobValidationError("Import unit progress exceeds total")
            progress.update(
                unitsCompleted=completed_units,
                unitsTotal=total_units,
                unitLabel=_text(row["unitLabel"], maximum=128),
            )
        if detail_count:
            started = _datetime(row["stageStartedAt"])
            heartbeat = _datetime(row["heartbeatAt"])
            if heartbeat < started:
                raise ImportJobValidationError("Import heartbeat precedes stage start")
            completed = integer(row["datasetsCompleted"])
            total = integer(row["datasetsTotal"])
            if completed > total:
                raise ImportJobValidationError("Import dataset progress exceeds total")
            current_dataset = _nullable_text(row["currentDataset"])
            if current_dataset is not None and len(current_dataset) > 128:
                raise ImportJobValidationError("Invalid current dataset")
            records_total = None if row["recordsTotal"] is None else integer(row["recordsTotal"])
            if records_total is not None and records_read > records_total:
                raise ImportJobValidationError("Import record progress exceeds total")
            progress.update(
                stageStartedAt=started.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                heartbeatAt=heartbeat.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                recordsTotal=records_total,
                currentDataset=current_dataset,
                datasetsCompleted=completed,
                datasetsTotal=total,
            )
        return progress
    raise ImportJobValidationError("Unknown import progress kind")


_ERROR_CODES = frozenset(
    {
        "VALIDATION_ERROR",
        "UNAUTHENTICATED",
        "FORBIDDEN",
        "RESOURCE_NOT_FOUND",
        "CONFLICT",
        "REVIEW_VERSION_CONFLICT",
        "DIAGNOSIS_NOT_READY",
        "HYPOTHESIS_SUPERSEDED",
        "UNSUPPORTED_FILTER_COMBINATION",
        "RATE_LIMITED",
        "INTERNAL_ERROR",
        "DATA_UNAVAILABLE",
        "FEATURE_UNAVAILABLE",
        "UPSTREAM_TIMEOUT",
        "IMPORT_IN_PROGRESS",
        "IMPORT_NOT_OWNED",
        "IMPORT_STATE_CONFLICT",
        "IMPORT_NOT_FOUND",
        "UPLOAD_EXPIRED",
        "UPLOAD_PREPARATION_FAILED",
        "WORKER_STOPPED",
        "MYSQL_CONNECTION_LOST",
        "MYSQL_QUERY_TIMEOUT",
        "QUERY_PLAN_INVALID",
        "ARCHIVE_PUBLICATION_FAILED",
        "DYNAMODB_THROTTLED",
        "DISK_PRESSURE",
        "CHECKSUM_MISMATCH",
        "SOURCE_SCHEMA_INVALID",
        "DATA_RECONCILIATION_FAILED",
    }
)


PUBLIC_IMPORT_ERROR_MESSAGES: Mapping[str, str] = {
    "MYSQL_CONNECTION_LOST": ("A conexão com o MySQL foi perdida após as tentativas de reconexão."),
    "MYSQL_QUERY_TIMEOUT": ("A consulta ao MySQL excedeu o tempo limite após novas tentativas."),
    "QUERY_PLAN_INVALID": ("O plano de consulta do MySQL não permite uma importação segura."),
    "ARCHIVE_PUBLICATION_FAILED": (
        "Não foi possível publicar o arquivo canônico. Tente novamente."
    ),
    "DYNAMODB_THROTTLED": (
        "O armazenamento de controle está temporariamente sobrecarregado. Tente novamente."
    ),
    "DISK_PRESSURE": ("Não há espaço temporário suficiente para concluir a importação."),
    "CHECKSUM_MISMATCH": ("A integridade dos dados da importação não pôde ser confirmada."),
    "SOURCE_SCHEMA_INVALID": ("O esquema ou a cobertura da origem é incompatível."),
    "DATA_RECONCILIATION_FAILED": (
        "As evidências publicadas não reconciliam com os dados importados."
    ),
}


def safe_import_error(value: object) -> dict[str, object] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ImportJobValidationError("Invalid import error")
    legacy_fields = {"code", "message", "requestId"}
    current_fields = legacy_fields | {"stage", "retryable", "attempt", "maxAttempts"}
    if set(value) == legacy_fields:
        row = value
        stage = None
        retryable = False
        attempt = 1
        max_attempts = None
    elif set(value) == current_fields:
        row = value
        stage = _nullable_text(row["stage"])
        if stage is not None and len(stage) > 128:
            raise ImportJobValidationError("Invalid import error stage")
        if not isinstance(row["retryable"], bool):
            raise ImportJobValidationError("Invalid import retryable flag")
        retryable = row["retryable"]
        attempt = integer(row["attempt"], 1)
        max_attempts = None if row["maxAttempts"] is None else integer(row["maxAttempts"], 1)
        if max_attempts is not None and attempt > max_attempts:
            raise ImportJobValidationError("Import attempt exceeds maximum")
    else:
        raise ImportJobValidationError("Invalid import object fields")
    code = _text(row["code"])
    _text(row["message"], maximum=1000)
    if code not in _ERROR_CODES:
        raise ImportJobValidationError("Unknown import error code")
    # Never copy exception text, storage coordinates, or stack traces into public fields.
    request_id = _text(row["requestId"], maximum=128)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", request_id):
        raise ImportJobValidationError("Invalid import request identifier")
    return {
        "code": code,
        "message": PUBLIC_IMPORT_ERROR_MESSAGES.get(
            code, "Não foi possível concluir a importação."
        ),
        "requestId": request_id,
        "stage": stage,
        "retryable": retryable,
        "attempt": attempt,
        "maxAttempts": max_attempts,
    }


def _wire_name(name: str) -> str:
    first, *rest = name.split("_")
    return first + "".join(part.title() for part in rest)


_OPTIONAL = frozenset(
    {
        "partSizeBytes",
        "expectedPartCount",
        "uploadGeneration",
        "uploadExpiresAt",
        "completionRequestedAt",
        "completionUploadGeneration",
        "progressRunStage",
        "pipelineVersion",
    }
)


@dataclass(frozen=True, slots=True)
class ImportJob:
    import_id: str
    requested_by: str
    author: Mapping[str, object]
    file_name: str
    size_bytes: int
    snapshot_extracted_on: date
    created_at: datetime
    updated_at: datetime
    state: ImportState
    version: int
    progress: Mapping[str, object]
    candidate_version: str | None
    error: Mapping[str, object] | None
    bucket: str
    key: str
    upload_id: str | None
    task_arn: str | None
    physical_version: str | None
    part_size_bytes: int | None = None
    expected_part_count: int | None = None
    upload_generation: int | None = None
    upload_expires_at: datetime | None = None
    completion_requested_at: datetime | None = None
    completion_upload_generation: int | None = None
    progress_run_stage: str | None = None
    pipeline_version: RunPipeline = RunPipeline.LEGACY_V1
    _pipeline_version_persisted: bool = field(default=False, repr=False, compare=False)

    @classmethod
    def from_item(cls, item: Mapping[str, object]) -> ImportJob:
        expected = {
            _wire_name(field.name) for field in fields(cls) if not field.name.startswith("_")
        } | {"pk", "sk"}
        if set(item) - expected or expected - _OPTIONAL - set(item):
            raise ImportJobValidationError("Invalid import record fields")
        import_id = validate_import_id(item["importId"])
        if item["pk"] != "IMPORTS" or item["sk"] != f"IMPORT#{import_id}":
            raise ImportJobValidationError("Invalid import record key")
        requested_by = _text(item["requestedBy"], maximum=256)
        author = _mapping(item["author"], {"id", "name", "email"})
        if _text(author["id"], maximum=256) != requested_by:
            raise ImportJobValidationError("Invalid import author identity")
        name, email = _nullable_text(author["name"]), _nullable_text(author["email"])
        if (name is not None and len(name) > 256) or (
            email is not None
            and (len(email) > 320 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email))
        ):
            raise ImportJobValidationError("Invalid import author")
        try:
            state = ImportState(_text(item["state"]))
            snapshot = date.fromisoformat(_text(item["snapshotExtractedOn"]))
        except ValueError:
            raise ImportJobValidationError("Invalid import state or snapshot date") from None
        if snapshot.isoformat() != item["snapshotExtractedOn"]:
            raise ImportJobValidationError("Invalid import snapshot date")
        candidate = _nullable_text(item["candidateVersion"])
        if candidate is not None and not re.fullmatch(r"dsv_[0-9a-f]{64}", candidate):
            raise ImportJobValidationError("Invalid candidate version")
        size = integer(item["sizeBytes"], 1)
        part_size = integer(item["partSizeBytes"], 1) if "partSizeBytes" in item else None
        count = (
            integer(item["expectedPartCount"], 1, 10000) if "expectedPartCount" in item else None
        )
        if (
            part_size is not None
            and count is not None
            and count != (size + part_size - 1) // part_size
        ):
            raise ImportJobValidationError("Invalid upload geometry")
        generation = integer(item["uploadGeneration"], 1) if "uploadGeneration" in item else None
        if ("completionRequestedAt" in item) != ("completionUploadGeneration" in item):
            raise ImportJobValidationError("Incomplete import completion intent")
        completion = (
            integer(item["completionUploadGeneration"], 1)
            if "completionUploadGeneration" in item
            else None
        )
        if completion is not None and completion != generation:
            raise ImportJobValidationError("Invalid completion generation")
        physical_version = _nullable_text(item["physicalVersion"])
        if (
            state
            in (
                ImportState.UPLOADED,
                ImportState.VALIDATING,
                ImportState.PROCESSING,
                ImportState.READY,
            )
            and physical_version is None
        ):
            raise ImportJobValidationError("Uploaded import requires a physical version")
        progress_run_stage = None
        if "progressRunStage" in item:
            try:
                progress_run_stage = RunStage(_text(item["progressRunStage"])).value
            except ValueError:
                raise ImportJobValidationError("Invalid import progress checkpoint") from None
        try:
            pipeline = RunPipeline(
                _text(item["pipelineVersion"])
                if "pipelineVersion" in item
                else RunPipeline.LEGACY_V1.value
            )
        except ValueError:
            raise ImportJobValidationError("Invalid import pipeline version") from None
        return cls(
            import_id=import_id,
            requested_by=requested_by,
            author={"id": requested_by, "name": name, "email": email},
            file_name=_text(item["fileName"], maximum=255),
            size_bytes=size,
            snapshot_extracted_on=snapshot,
            created_at=_datetime(item["createdAt"]),
            updated_at=_datetime(item["updatedAt"]),
            state=state,
            version=integer(item["version"]),
            progress=_progress(item["progress"]),
            candidate_version=candidate,
            error=safe_import_error(item["error"]),
            bucket=_text(item["bucket"]),
            key=_text(item["key"], empty=state in (ImportState.PREPARING, ImportState.FAILED)),
            upload_id=_nullable_text(item["uploadId"]),
            task_arn=_nullable_text(item["taskArn"]),
            physical_version=physical_version,
            part_size_bytes=part_size,
            expected_part_count=count,
            upload_generation=generation,
            upload_expires_at=_datetime(item["uploadExpiresAt"])
            if "uploadExpiresAt" in item
            else None,
            completion_requested_at=(
                _datetime(item["completionRequestedAt"])
                if "completionRequestedAt" in item
                else None
            ),
            completion_upload_generation=completion,
            progress_run_stage=progress_run_stage,
            pipeline_version=pipeline,
            _pipeline_version_persisted="pipelineVersion" in item,
        )

    def to_item(self) -> dict[str, object]:
        item: dict[str, object] = {"pk": "IMPORTS", "sk": f"IMPORT#{self.import_id}"}
        for data_field in fields(self):
            if data_field.name.startswith("_"):
                continue
            name = _wire_name(data_field.name)
            value = getattr(self, data_field.name)
            if name == "pipelineVersion" and not self._pipeline_version_persisted:
                continue
            if name in _OPTIONAL and value is None:
                continue
            if isinstance(value, datetime):
                value = _datetime(value).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            elif isinstance(value, date):
                value = value.isoformat()
            elif isinstance(value, StrEnum):
                value = value.value
            elif isinstance(value, Mapping):
                value = dict(value)
            item[name] = value
        return item


class ImportJobRepository(Protocol):
    def get(self, import_id: str) -> ImportJob | None: ...

    def update_progress(
        self,
        import_id: str,
        expected_version: int,
        patch: Mapping[str, object],
    ) -> ImportJob: ...

    def transition(
        self,
        import_id: str,
        expected_state: ImportState,
        expected_version: int,
        next_state: ImportState,
        patch: Mapping[str, object],
    ) -> ImportJob: ...

    def finish(
        self,
        import_id: str,
        expected_version: int,
        state: Literal[ImportState.READY, ImportState.FAILED],
        patch: Mapping[str, object],
    ) -> ImportJob: ...
