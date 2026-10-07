"""Reproduce receive exhaustion with two FIFO groups and a busy global lease.

SQS uses moto and production adapters; source/state use existing test doubles.
"""

import json
import os
from datetime import UTC, datetime
from pathlib import Path

import boto3
from moto import mock_aws

from adapters.messaging.incremental_sqs import SqsIncrementalBatchQueue
from domain.incremental_batches import IncrementalBatchReference
from tests.unit.application.test_ingest_incremental import (
    HOURLY_WINDOW,
    _raw_row,
    ingest_service,
    manifest,
    rebuild_service,
)


@mock_aws
def test_two_valid_groups_can_reach_dlq_during_global_lease_contention() -> None:
    """The experiment passes when it reproduces the documented RNF03 failure."""
    sqs = boto3.client("sqs", region_name="us-east-1")
    dlq = sqs.create_queue(QueueName="rnf-dlq.fifo", Attributes={"FifoQueue": "true"})["QueueUrl"]
    arn = sqs.get_queue_attributes(QueueUrl=dlq, AttributeNames=["QueueArn"])["Attributes"][
        "QueueArn"
    ]
    url = sqs.create_queue(
        QueueName="rnf-groups.fifo",
        Attributes={
            "FifoQueue": "true",
            "VisibilityTimeout": "0",
            "RedrivePolicy": json.dumps({"deadLetterTargetArn": arn, "maxReceiveCount": 5}),
        },
    )["QueueUrl"]
    _, deps = ingest_service()
    queue = SqsIncrementalBatchQueue(sqs, url)
    deps.queue = queue
    batches = [
        manifest(deps.registry),
        manifest(deps.registry, dataset="live_qoe_hourly", window=HOURLY_WINDOW),
    ]
    for batch in batches:
        reference = IncrementalBatchReference(
            "incremental-bucket",
            f"raw/argus/incremental/dataset={batch.source_dataset}/window_start=20260901T000000000Z/batch_id={batch.batch_id}/manifest.json",
            "manifest-v1",
        )
        deps.store.seed(batch, reference, (_raw_row(batch.source_dataset, batch.window),))
        queue.send(reference, batch_id=batch.batch_id, dataset=batch.source_dataset)
    deps.leases.acquire(
        "SYNC_GLOBAL",
        "competing-worker",
        datetime.now(UTC),
        3600,
        idempotency_key="rnf-competing-worker",
    )
    service = rebuild_service(deps)
    results = []
    for _ in range(5):
        result = service.drain(2)
        results.append({"completed": result.completed, "retryable": result.retryable})
        assert result.completed == 0
        assert result.retryable == 2
    sqs.receive_message(QueueUrl=url, MaxNumberOfMessages=10, WaitTimeSeconds=0)
    messages = sqs.receive_message(QueueUrl=dlq, MaxNumberOfMessages=10, WaitTimeSeconds=0).get(
        "Messages", []
    )
    assert len(messages) == 2
    assert not deps.hot_sink.records
    report = {
        "scope": "moto SQS + production consumer/sync; existing fake source/state ports",
        "datasets": [b.source_dataset for b in batches],
        "visibilityTimeoutSeconds": 0,
        "maxReceiveCount": 5,
        "results": results,
        "dlqMessages": len(messages),
        "persistedRecords": 0,
        "riskReproduced": True,
        "scenarioVerdict": "REPROVADO",
        "interpretation": (
            "Valid messages consume receive attempts while SYNC_GLOBAL is occupied; "
            "visibility renewal on the first group does not protect the other group."
        ),
    }
    if os.environ.get("RNF_WRITE_EVIDENCE") == "1":
        output = (
            Path(__file__).resolve().parents[5]
            / "assets/testes-carga/2026-10-06-fechamento-local/multidataset-contention.json"
        )
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + "\n")
    deps.leases.release("SYNC_GLOBAL", "competing-worker", idempotency_key="rnf-release")
