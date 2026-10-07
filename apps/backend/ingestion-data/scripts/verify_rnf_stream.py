"""Independently verify a completed paced workload in its durable local table.

Read bounded pages, compare every persisted canonical field to deterministic
input, check the complete identity universe, and replay with a fresh marker.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import boto3
from boto3.dynamodb.types import TypeDeserializer

from adapters.dynamodb.codec import encode_hot_record
from adapters.dynamodb.hot_records import DynamoHotRecordSink
from contracts.argus.v2.normalizers import normalize_row
from contracts.registry import DatasetRegistry


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--table", required=True)
    parser.add_argument("--execution-log", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    samples = []
    for line in args.execution_log.read_text().splitlines():
        if line.startswith("{"):
            d = json.loads(line)
            if "elapsedSeconds" in d and "offered" in d:
                samples.append(d)
    assert len(samples) == 150 and samples[-1]["written"] == 150000
    version = "dsv_" + hashlib.sha256(args.table.encode()).hexdigest()
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")
    timestamp = int(datetime(2026, 10, 6, tzinfo=UTC).timestamp() * 1000)

    def source(index: int):
        return normalize_row(
            descriptor,
            {
                "bts": timestamp,
                "source": "rnf-local",
                "entity": f"event-{index:08d}",
                "metric": "latency",
                "value": float(index),
            },
        )

    partition = "year=2026/month=10/day=06"
    first = encode_hot_record(source(0), version, partition)
    client = boto3.client(
        "dynamodb",
        region_name="us-east-1",
        endpoint_url="http://127.0.0.1:18003",
        aws_access_key_id="local",
        aws_secret_access_key="local",
    )
    request = {
        "TableName": args.table,
        "KeyConditionExpression": "pk = :pk",
        "ExpressionAttributeValues": {":pk": {"S": first["pk"]}},
        "ConsistentRead": True,
        "Limit": 1000,
    }
    deserialize = TypeDeserializer()
    seen = set()
    mismatches = duplicates = pages = 0
    began = time.monotonic()
    while True:
        page = client.query(**request)
        pages += 1
        for raw in page["Items"]:
            actual = {name: deserialize.deserialize(value) for name, value in raw.items()}
            natural = {pair["name"]: pair["value"] for pair in actual["naturalKey"]}
            index = int(str(natural["entity"]).removeprefix("event-"))
            expected = encode_hot_record(source(index), version, partition)
            mismatches += int(any(actual.get(name) != value for name, value in expected.items()))
            duplicates += int(index in seen)
            seen.add(index)
        if "LastEvaluatedKey" not in page:
            break
        request["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        print(
            json.dumps({"verified": len(seen), "pages": pages, "fieldMismatches": mismatches}),
            flush=True,
        )
    verification_seconds = time.monotonic() - began
    replay = DynamoHotRecordSink(client, args.table).write(
        tuple(source(i) for i in range(1000)),
        version,
        partition,
        idempotency_key=f"{args.table}:verification-recovery-replay",
    )
    start = datetime.fromisoformat(samples[0]["timestamp"]) - timedelta(
        seconds=samples[0]["elapsedSeconds"]
    )
    expected_indices = set(range(150000))
    last = samples[-1]
    report = {
        "scope": (
            "production normalization and writer on persistent DynamoDB Local; "
            "excludes ECS, SQS, projection, archive and public API"
        ),
        "startedAtApproximate": start.isoformat(),
        "configuredWindowSeconds": 900,
        "nominalWindowEnd": (start + timedelta(seconds=900)).isoformat(),
        "lastPersistedAt": last["timestamp"],
        "lastPersistedElapsedSeconds": last["elapsedSeconds"],
        "offered": last["offered"],
        "writtenReported": last["written"],
        "independentCount": len(seen),
        "missing": len(expected_indices - seen),
        "unexpected": len(seen - expected_indices),
        "duplicates": duplicates,
        "canonicalFieldMismatches": mismatches,
        "batchLatencyP95Seconds": sorted(s["batchSeconds"] for s in samples)[
            math.ceil(0.95 * len(samples)) - 1
        ],
        "maxProducerScheduleLagSeconds": max(s["scheduleLagSeconds"] for s in samples),
        "verificationSeconds": verification_seconds,
        "verificationPages": pages,
        "verificationMethod": (
            "strongly consistent Query with Limit=1000; all canonical fields "
            "compared to deterministic input, including payloadHash"
        ),
        "replay": {"written": replay.written, "unchanged": replay.unchanged},
        "table": args.table,
        "verifiedAt": datetime.now(UTC).isoformat(),
        "verificationRecovery": (
            "Unbounded verification query exceeded the emulator JVM heap; persisted "
            "data was retained and verified with bounded pages. No ingestion replay "
            "was required."
        ),
    }
    report["passed"] = (
        report["missing"]
        == report["unexpected"]
        == report["duplicates"]
        == report["canonicalFieldMismatches"]
        == 0
        and len(seen) == 150000
        and last["elapsedSeconds"] <= 900
        and report["maxProducerScheduleLagSeconds"] < 6
        and replay.written == 0
        and replay.unchanged == 1000
    )
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    args.output.with_name("stream-samples.json").write_text(json.dumps(samples, indent=2) + "\n")
    print(json.dumps(report), flush=True)
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
