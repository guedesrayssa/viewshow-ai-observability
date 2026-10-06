"""Verify the incremental batch keys against the operational table key schema."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import boto3  # type: ignore[import-untyped]
import pytest
from moto import mock_aws

from adapters.dynamodb.incremental_batches import DynamoIncrementalBatchRepository
from domain.incremental_batches import (
    BatchState,
    IncrementalBatchManifest,
    IncrementalBatchReference,
    PhysicalColumn,
    incremental_batch_id,
)
from domain.models import TimeWindow

# Key schema of aws_dynamodb_table.operacional (apps/fullstack/dynamodb.tf).
HASH_KEY = "pk"
RANGE_KEY = "sk"
TABLE = "view-show-iac-operacional"
IAC_TABLE = Path(__file__).resolve().parents[5] / "fullstack" / "dynamodb.tf"
WINDOW = TimeWindow(
    datetime(2026, 9, 17, 10, tzinfo=UTC),
    datetime(2026, 9, 17, 10, 15, tzinfo=UTC),
    900,
)
BATCH_ID = incremental_batch_id("ARGUS", "signal_bucket", WINDOW, 0, "1.0")
MANIFEST_KEY = (
    "raw/argus/incremental/dataset=signal_bucket/"
    "window_start=20260917T100000000Z/"
    f"batch_id={BATCH_ID}/manifest.json"
)


def _table() -> Any:
    client = boto3.client("dynamodb", region_name="us-east-1")
    client.create_table(
        TableName=TABLE,
        KeySchema=[
            {"AttributeName": HASH_KEY, "KeyType": "HASH"},
            {"AttributeName": RANGE_KEY, "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": HASH_KEY, "AttributeType": "S"},
            {"AttributeName": RANGE_KEY, "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    return client


def _manifest() -> IncrementalBatchManifest:
    return IncrementalBatchManifest(
        batch_id=BATCH_ID,
        source_system="ARGUS",
        source_dataset="signal_bucket",
        window=WINDOW,
        revision=0,
        data_key=MANIFEST_KEY.removesuffix("manifest.json") + "data.parquet",
        data_version_id="data-version-1",
        data_size_bytes=123,
        data_sha256="a" * 64,
        schema_fingerprint="b" * 64,
        columns=(PhysicalColumn("sinal", "VARCHAR(64)", False, 1),),
        extra_columns=(),
        row_count=1,
        exporter_version="1.0",
    )


def _reference() -> IncrementalBatchReference:
    return IncrementalBatchReference("bucket-name", MANIFEST_KEY, "manifest-version-1")


def _repository(client: Any) -> DynamoIncrementalBatchRepository:
    return DynamoIncrementalBatchRepository(
        client,
        TABLE,
        clock=lambda: datetime(2026, 9, 17, 10, 16, tzinfo=UTC),
    )


def test_expected_key_schema_matches_the_operational_table_in_the_iac() -> None:
    if not IAC_TABLE.is_file():
        pytest.skip("apps/fullstack/dynamodb.tf is not available in this checkout")
    resource = re.search(
        r'resource "aws_dynamodb_table" "operacional" \{(.*?)\n\}',
        IAC_TABLE.read_text(encoding="utf-8"),
        re.DOTALL,
    )
    assert resource is not None
    hash_key = re.search(r'^  hash_key\s*=\s*"([^"]+)"', resource.group(1), re.MULTILINE)
    range_key = re.search(r'^  range_key\s*=\s*"([^"]+)"', resource.group(1), re.MULTILINE)

    assert hash_key is not None and hash_key.group(1) == HASH_KEY
    assert range_key is not None and range_key.group(1) == RANGE_KEY


@pytest.mark.aws
@mock_aws
def test_claim_writes_the_item_under_the_table_key_schema() -> None:
    client = _table()

    claimed = _repository(client).claim(_manifest(), _reference())

    stored = client.get_item(
        TableName=TABLE,
        Key={HASH_KEY: {"S": f"BATCH#{BATCH_ID}"}, RANGE_KEY: {"S": "META"}},
        ConsistentRead=True,
    )["Item"]
    assert claimed.state is BatchState.RECEIVED
    assert stored["batchId"] == {"S": BATCH_ID}
    assert "PK" not in stored and "SK" not in stored


@pytest.mark.aws
@mock_aws
def test_batch_lifecycle_runs_against_the_table_key_schema() -> None:
    client = _table()
    adapter = _repository(client)

    received = adapter.claim(_manifest(), _reference())
    replay = adapter.claim(_manifest(), _reference())
    validating = adapter.transition(
        BATCH_ID, BatchState.RECEIVED, received.version, BatchState.VALIDATING
    )
    ingesting = adapter.transition(
        BATCH_ID, BatchState.VALIDATING, validating.version, BatchState.INGESTING
    )
    committing = adapter.transition(
        BATCH_ID, BatchState.INGESTING, ingesting.version, BatchState.COMMITTING
    )
    completed = adapter.finish(
        BATCH_ID,
        BatchState.COMMITTING,
        committing.version,
        BatchState.COMPLETED,
        counts={"written": 1},
    )

    assert replay == received
    assert completed.state is BatchState.COMPLETED
    assert adapter.claim(_manifest(), _reference()).state is BatchState.COMPLETED
    assert client.scan(TableName=TABLE)["Count"] == 1
