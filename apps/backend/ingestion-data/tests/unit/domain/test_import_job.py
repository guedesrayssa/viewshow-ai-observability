"""Frozen TypeScript document and strict Python decoding contract."""

import importlib
import json
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import pytest

FIXTURE = Path(__file__).parents[2] / "fixtures/import_job_typescript.json"
CIVIL_DATE_CASES = json.loads(
    (Path(__file__).parents[4] / "api/contracts/fixtures/civil-date-cases.json").read_text()
)


def fixture() -> dict:
    return json.loads(FIXTURE.read_text())


def domain():
    try:
        return importlib.import_module("domain.import_job")
    except ModuleNotFoundError:
        pytest.fail("The Python import job contract is missing")


def test_decodes_all_typescript_fields_and_boto3_numbers() -> None:
    module = domain()
    item = json.loads(FIXTURE.read_text(), parse_int=Decimal)
    job = module.ImportJob.from_item(item)
    assert job.import_id == "imp_01K59Z5XE00000000000000000"
    assert job.state is module.ImportState.UPLOADED
    assert job.version == 4 and type(job.version) is int
    assert job.created_at == datetime(2026, 9, 17, 10, tzinfo=UTC)
    assert job.upload_expires_at == datetime(2026, 9, 18, 10, tzinfo=UTC)
    assert job.completion_upload_generation == 1
    assert job.part_size_bytes == 16777216
    assert job.expected_part_count == 1
    assert job.physical_version == "s3-version-1"
    assert job.pipeline_version.value == "canonical-v2"
    assert job.to_item() == fixture()


def test_missing_pipeline_version_decodes_as_legacy_without_rewriting_the_record() -> None:
    module = domain()
    item = fixture()
    item.pop("pipelineVersion")

    job = module.ImportJob.from_item(item)

    assert job.pipeline_version is module.RunPipeline.LEGACY_V1
    assert "pipelineVersion" not in job.to_item()


def test_rejects_unknown_pipeline_version() -> None:
    with pytest.raises(domain().ImportJobValidationError, match="pipeline"):
        domain().ImportJob.from_item({**fixture(), "pipelineVersion": "future-v3"})


def test_accepts_optional_partition_and_unit_progress_as_one_valid_group() -> None:
    progress = {
        "kind": "stage",
        "stage": "ARCHIVING",
        "recordsRead": 10,
        "recordsWritten": 10,
        "recordsRejected": 0,
        "substage": "UPLOADING",
        "currentPartition": "snapshot_date=2026-09-17",
        "unitsCompleted": 2,
        "unitsTotal": 3,
        "unitLabel": "partições",
    }

    assert domain().ImportJob.from_item({**fixture(), "progress": progress}).progress == progress


@pytest.mark.parametrize(
    "patch",
    [
        {"unitsCompleted": 1},
        {"unitsCompleted": -1, "unitsTotal": 1, "unitLabel": "partições"},
        {"unitsCompleted": 2, "unitsTotal": 1, "unitLabel": "partições"},
        {"substage": None},
        {"currentPartition": None},
    ],
)
def test_rejects_incomplete_or_invalid_unit_progress(patch: dict[str, object]) -> None:
    progress = {
        "kind": "stage",
        "stage": "ARCHIVING",
        "recordsRead": 0,
        "recordsWritten": 0,
        "recordsRejected": 0,
        **patch,
    }
    with pytest.raises(domain().ImportJobValidationError):
        domain().ImportJob.from_item({**fixture(), "progress": progress})


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("state", "DONE"),
        ("state", None),
        ("importId", "imp_bad"),
        ("version", True),
        ("version", Decimal("1.1")),
        ("version", 2**53),
        ("version", Decimal("NaN")),
        ("sizeBytes", 0),
        ("createdAt", "2026-09-17T10:00:00"),
        ("createdAt", "yesterday"),
        ("snapshotExtractedOn", "2026-02-30"),
        ("partSizeBytes", -1),
        ("expectedPartCount", 2),
        ("uploadGeneration", 0),
        ("completionUploadGeneration", 2),
        ("physicalVersion", 42),
        ("author", {"id": "wrong", "name": None, "email": None}),
        ("progress", {"kind": "bytes", "completedBytes": 10, "totalBytes": 9}),
        (
            "progress",
            {
                "kind": "stage",
                "stage": "read",
                "recordsRead": -1,
                "recordsWritten": 0,
                "recordsRejected": 0,
            },
        ),
        ("progress", {"kind": "other"}),
        ("candidateVersion", "bad"),
        ("error", {"code": "INTERNAL_ERROR", "message": "safe", "stack": "secret"}),
        ("unexpected", "value"),
        ("pk", "WRONG"),
    ],
)
def test_rejects_malformed_critical_fields(field: str, value: object) -> None:
    module = domain()
    with pytest.raises(module.ImportJobValidationError):
        module.ImportJob.from_item({**fixture(), field: value})


@pytest.mark.parametrize("value", CIVIL_DATE_CASES["valid"])
def test_accepts_shared_typescript_civil_dates(value: str) -> None:
    job = domain().ImportJob.from_item({**fixture(), "snapshotExtractedOn": value})
    assert job.snapshot_extracted_on.isoformat() == value


@pytest.mark.parametrize("value", CIVIL_DATE_CASES["invalid"])
def test_rejects_shared_typescript_civil_dates(value: str) -> None:
    with pytest.raises(domain().ImportJobValidationError):
        domain().ImportJob.from_item({**fixture(), "snapshotExtractedOn": value})


def test_all_state_pairs_match_typescript() -> None:
    module = domain()
    edges = {
        ("PREPARING", "UPLOADING"),
        ("PREPARING", "FAILED"),
        ("UPLOADING", "UPLOADED"),
        ("UPLOADING", "FAILED"),
        ("UPLOADED", "VALIDATING"),
        ("UPLOADED", "FAILED"),
        ("VALIDATING", "PROCESSING"),
        ("VALIDATING", "FAILED"),
        ("PROCESSING", "READY"),
        ("PROCESSING", "FAILED"),
    }
    for before in module.ImportState:
        for after in module.ImportState:
            if (before.value, after.value) in edges:
                module.assert_import_transition(before, after)
            else:
                with pytest.raises(module.ImportStateConflict):
                    module.assert_import_transition(before, after)


def test_optional_fields_and_offset_dates_are_unambiguous() -> None:
    module = domain()
    item = fixture()
    for field in (
        "partSizeBytes",
        "expectedPartCount",
        "uploadGeneration",
        "uploadExpiresAt",
        "completionRequestedAt",
        "completionUploadGeneration",
    ):
        item.pop(field)
    item["createdAt"] = "2026-09-17T07:00:00.000-03:00"
    job = module.ImportJob.from_item(item)
    assert job.created_at == datetime(2026, 9, 17, 10, tzinfo=UTC)
    assert job.part_size_bytes is None


def test_error_message_is_safe_for_public_persistence() -> None:
    module = domain()
    item = fixture()
    item["error"] = {
        "code": "INTERNAL_ERROR",
        "message": "stack s3://private/key",
        "requestId": "req_import_01K59Z5XE00000000000000000",
    }
    job = module.ImportJob.from_item(item)
    assert job.error == {
        "code": "INTERNAL_ERROR",
        "message": "Não foi possível concluir a importação.",
        "requestId": "req_import_01K59Z5XE00000000000000000",
        "stage": None,
        "retryable": False,
        "attempt": 1,
        "maxAttempts": None,
    }


def test_normalizes_legacy_error_to_additive_public_defaults() -> None:
    item = fixture()
    item["error"] = {
        "code": "INTERNAL_ERROR",
        "message": "legacy detail",
        "requestId": "req_import_01K59Z5XE00000000000000000",
    }

    assert domain().ImportJob.from_item(item).error == {
        "code": "INTERNAL_ERROR",
        "message": "Não foi possível concluir a importação.",
        "requestId": "req_import_01K59Z5XE00000000000000000",
        "stage": None,
        "retryable": False,
        "attempt": 1,
        "maxAttempts": None,
    }


def test_preserves_valid_actionable_failure_metadata() -> None:
    item = fixture()
    item["error"] = {
        "code": "MYSQL_QUERY_TIMEOUT",
        "message": "untrusted SQL SELECT secret",
        "requestId": "req_import_01K59Z5XE00000000000000000",
        "stage": "INGESTING",
        "retryable": True,
        "attempt": 4,
        "maxAttempts": 4,
    }

    error = domain().ImportJob.from_item(item).error
    assert error == {
        "code": "MYSQL_QUERY_TIMEOUT",
        "message": "A consulta ao MySQL excedeu o tempo limite após novas tentativas.",
        "requestId": "req_import_01K59Z5XE00000000000000000",
        "stage": "INGESTING",
        "retryable": True,
        "attempt": 4,
        "maxAttempts": 4,
    }
    assert "SELECT" not in str(error)


@pytest.mark.parametrize(
    "code",
    [
        "ARCHIVE_PUBLICATION_FAILED",
        "DYNAMODB_THROTTLED",
        "DISK_PRESSURE",
        "CHECKSUM_MISMATCH",
        "SOURCE_SCHEMA_INVALID",
        "DATA_RECONCILIATION_FAILED",
    ],
)
def test_accepts_canonical_public_failure_codes_with_safe_messages(code: str) -> None:
    item = fixture()
    item["error"] = {
        "code": code,
        "message": "s3://private-bucket/private-key",
        "requestId": "req_import_01K59Z5XE00000000000000000",
        "stage": "ARCHIVING",
        "retryable": code in {"ARCHIVE_PUBLICATION_FAILED", "DYNAMODB_THROTTLED", "DISK_PRESSURE"},
        "attempt": 1,
        "maxAttempts": None,
    }

    error = domain().ImportJob.from_item(item).error

    assert error is not None and error["code"] == code
    assert "private" not in str(error)


def test_failed_preparation_keeps_empty_object_key() -> None:
    item = fixture()
    item.update(state="FAILED", key="", uploadId=None)
    assert domain().ImportJob.from_item(item).key == ""


TIMESTAMPS = json.loads((FIXTURE.parent / "import_timestamps.json").read_text())


@pytest.mark.parametrize(
    "field", ["createdAt", "updatedAt", "uploadExpiresAt", "completionRequestedAt"]
)
@pytest.mark.parametrize("value", TIMESTAMPS["invalid"])
def test_rejects_noncanonical_timestamp(field: str, value: str) -> None:
    with pytest.raises(domain().ImportJobValidationError):
        domain().ImportJob.from_item({**fixture(), field: value})


@pytest.mark.parametrize("value", TIMESTAMPS["valid"])
def test_normalizes_millisecond_timestamp_without_loss(value: dict) -> None:
    job = domain().ImportJob.from_item({**fixture(), "createdAt": value["input"]})
    assert job.to_item()["createdAt"] == value["utc"]


def test_rejects_datetime_objects_with_submillisecond_precision() -> None:
    value = datetime(2026, 9, 17, 10, 0, 0, 123456, tzinfo=UTC)
    with pytest.raises(domain().ImportJobValidationError):
        domain().ImportJob.from_item({**fixture(), "createdAt": value})


@pytest.mark.parametrize("missing", ["completionRequestedAt", "completionUploadGeneration"])
def test_completion_requires_both_fields(missing: str) -> None:
    item = fixture()
    item.pop(missing)
    with pytest.raises(domain().ImportJobValidationError):
        domain().ImportJob.from_item(item)


@pytest.mark.parametrize("state", ["UPLOADED", "VALIDATING", "PROCESSING", "READY"])
@pytest.mark.parametrize("physical", [None, "", " "])
def test_uploaded_states_require_physical_version(state: str, physical: object) -> None:
    with pytest.raises(domain().ImportJobValidationError):
        domain().ImportJob.from_item({**fixture(), "state": state, "physicalVersion": physical})


@pytest.mark.parametrize("state", ["PREPARING", "UPLOADING", "FAILED"])
def test_preupload_or_failed_can_have_no_physical_version(state: str) -> None:
    item = {**fixture(), "state": state, "physicalVersion": None}
    item.pop("completionRequestedAt")
    item.pop("completionUploadGeneration")
    assert domain().ImportJob.from_item(item).physical_version is None
