"""Verify outbox publication through an SQS-compatible integration boundary."""

from __future__ import annotations

import json
from datetime import UTC, datetime

import boto3  # type: ignore[import-untyped]
import pytest
from moto import mock_aws

from adapters.dynamodb.outbox import DynamoOutboxRepository
from adapters.messaging.sqs import SqsAnalysisRequestPublisher, analysis_envelope
from domain.models import TimeWindow


@pytest.mark.aws
@mock_aws
def test_standard_queue_receives_the_exact_canonical_envelope() -> None:
    client = boto3.client("sqs", region_name="us-east-1")
    queue_url = client.create_queue(QueueName="analysis")["QueueUrl"]
    end = datetime(2026, 9, 9, 12, tzinfo=UTC)
    event = DynamoOutboxRepository.build_event(
        "dsv_a",
        "ANOMALY_DETECTION",
        TimeWindow.from_epoch_ms(1788954300000, 1788955200000),
        created_at=end.replace(second=1),
    )

    receipt = SqsAnalysisRequestPublisher(client, queue_url).publish(
        event, idempotency_key=event.idempotency_key
    )

    response = client.receive_message(QueueUrl=queue_url, MaxNumberOfMessages=1)
    body = response["Messages"][0]["Body"]
    assert receipt.message_id == response["Messages"][0]["MessageId"]
    assert json.loads(body) == analysis_envelope(event)
    assert body.encode("utf-8") == json.dumps(
        json.loads(body), ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
