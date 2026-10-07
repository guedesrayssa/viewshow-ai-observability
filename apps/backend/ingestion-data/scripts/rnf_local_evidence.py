"""Measured local RNF experiments using production normalizers and persistence adapters.

DynamoDB Local and MySQL are real processes; this does not model ECS, SQS,
projection, archive, or production service latency. No AWS credentials are used.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import resource
import sys
import threading
import time
from dataclasses import asdict
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import boto3
import pymysql

from adapters.dynamodb.codec import encode_hot_record
from adapters.dynamodb.hot_records import DynamoHotRecordSink
from adapters.sources.mysql_reader import MySqlConnectionSettings, MySqlSourceReader
from adapters.sources.mysql_retry import (
    MySqlQueryRetriesExhausted,
    MySqlRetryPolicy,
    RetryingMySqlSourceReader,
)
from contracts.argus.v2.normalizers import normalize_row
from contracts.registry import DatasetRegistry

BUCKETS = (0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, math.inf)


def utc() -> str:
    return datetime.now(UTC).isoformat()


class Measurements:
    def __init__(self, output: Path) -> None:
        self.output = output
        self.lock = threading.Lock()
        self.offered = self.written = self.failures = self.backlog = 0
        self.durations: list[float] = []
        self.phase = "normal"

    def exposition(self) -> str:
        with self.lock:
            lines = [
                f"rnf_records_offered_total {self.offered}",
                f"rnf_records_written_total {self.written}",
                f"rnf_failures_total {self.failures}",
                f"rnf_backlog_events {self.backlog}",
                f"rnf_batch_duration_seconds_count {len(self.durations)}",
                f"rnf_batch_duration_seconds_sum {sum(self.durations)}",
            ]
            for bucket in BUCKETS:
                name = "+Inf" if math.isinf(bucket) else str(bucket)
                lines.append(
                    f'rnf_batch_duration_seconds_bucket{{le="{name}"}} '
                    f"{sum(d <= bucket for d in self.durations)}"
                )
        usage = resource.getrusage(resource.RUSAGE_SELF)
        lines.append(f"rnf_process_cpu_seconds_total {usage.ru_utime + usage.ru_stime}")
        return "\n".join(lines) + "\n"

    def start(self, port: int) -> ThreadingHTTPServer:
        measurements = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                if self.path != "/metrics":
                    self.send_error(404)
                    return
                body = measurements.exposition().encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; version=0.0.4")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args: object) -> None:
                pass

        server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server


def timeout_experiment(output: Path) -> dict:
    """Block an actual MySQL table, exhaust bounded socket retries, then recover."""
    registry = DatasetRegistry.load_argus_v2()
    descriptor = registry.require("signal_bucket")
    settings = MySqlConnectionSettings(
        "127.0.0.1", 33077, "ingestion", "ingestion-test-only", "argus", read_timeout_seconds=1
    )
    events = []
    inner = MySqlSourceReader(registry, settings)
    reader = RetryingMySqlSourceReader(
        inner,
        MySqlRetryPolicy(2, 10, 10),
        random_value=lambda: 1.0,
        on_retry=lambda event: events.append(asdict(event)),
    )
    baseline = reader.read_page(descriptor, None, None, 10)
    locker = pymysql.connect(
        host="127.0.0.1",
        port=33077,
        user="root",
        password="root-test-only",
        database="argus",
        autocommit=True,
    )
    report = {
        "startedAt": utc(),
        "baselineRows": len(baseline.rows),
        "readTimeoutSeconds": 1,
        "maxAttempts": 2,
        "injection": "LOCK TABLES signal_bucket WRITE on a separate real connection",
    }
    try:
        with locker.cursor() as cursor:
            cursor.execute("LOCK TABLES signal_bucket WRITE")
        started = time.monotonic()
        try:
            reader.read_page(descriptor, None, None, 10)
        except MySqlQueryRetriesExhausted as error:
            report.update(
                {
                    "failureType": type(error).__name__,
                    "mysqlCode": error.mysql_code,
                    "attempts": error.attempts,
                    "timedOut": error.timed_out,
                    "failureSeconds": time.monotonic() - started,
                }
            )
        else:
            raise AssertionError("The blocked real dependency did not time out")
    finally:
        with locker.cursor() as cursor:
            cursor.execute("UNLOCK TABLES")
        locker.close()
    started = time.monotonic()
    recovered = reader.read_page(descriptor, None, None, 10)
    report.update(
        {
            "recoverySeconds": time.monotonic() - started,
            "recoveryRows": len(recovered.rows),
            "sameRowsAfterRecovery": recovered.rows == baseline.rows,
            "retryEvents": events,
            "finishedAt": utc(),
            "scope": "production MySQL reader and retry wrapper; not the full ECS run state",
        }
    )
    report["passed"] = (
        report.get("timedOut") is True
        and report["sameRowsAfterRecovery"]
        and report["attempts"] == 2
    )
    (output / "timeout-mysql.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def stream_experiment(args: argparse.Namespace, output: Path) -> dict:
    client = boto3.client(
        "dynamodb",
        region_name="us-east-1",
        endpoint_url=args.dynamodb_endpoint,
        aws_access_key_id="local",
        aws_secret_access_key="local",
    )
    table = "rnf-stream-" + datetime.now(UTC).strftime("%Y%m%d%H%M%S")
    client.create_table(
        TableName=table,
        KeySchema=[
            {"AttributeName": "pk", "KeyType": "HASH"},
            {"AttributeName": "sk", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[{"AttributeName": n, "AttributeType": "S"} for n in ("pk", "sk")],
        BillingMode="PAY_PER_REQUEST",
    )
    sink = DynamoHotRecordSink(client, table)
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")
    version = "dsv_" + hashlib.sha256(table.encode()).hexdigest()
    partition = "year=2026/month=10/day=06"
    stamp = int(datetime(2026, 10, 6, 0, 0, tzinfo=UTC).timestamp() * 1000)
    m = Measurements(output)
    server = m.start(args.metrics_port)
    started_at = utc()
    began = time.monotonic()
    expected_keys = set()
    first_batch = None
    cpu_started = time.process_time()
    total = round(args.minutes * 10000)
    schedule = args.batch_size / (10000 / 60)
    samples = []
    for batch_index, offset in enumerate(range(0, total, args.batch_size)):
        due = began + batch_index * schedule
        time.sleep(max(0, due - time.monotonic()))
        rows = tuple(
            {
                "bts": stamp,
                "source": "rnf-local",
                "entity": f"event-{index:08d}",
                "metric": "latency",
                "value": float(index),
            }
            for index in range(offset, min(offset + args.batch_size, total))
        )
        records = tuple(normalize_row(descriptor, row) for row in rows)
        if first_batch is None:
            first_batch = records
        for record in records:
            encoded = encode_hot_record(record, version, partition)
            expected_keys.add((encoded["pk"], encoded["sk"]))
        with m.lock:
            m.offered += len(records)
            m.backlog = m.offered - m.written
        begin_batch = time.monotonic()
        try:
            result = sink.write(
                records, version, partition, idempotency_key=f"{table}:{batch_index}"
            )
            if result.written != len(records) or result.unchanged != 0:
                raise AssertionError("Fresh events were not persisted exactly once")
        except Exception:
            with m.lock:
                m.failures += 1
            raise
        elapsed = time.monotonic() - begin_batch
        with m.lock:
            m.written += result.written
            m.backlog = m.offered - m.written
            m.durations.append(elapsed)
        sample = {
            "timestamp": utc(),
            "elapsedSeconds": time.monotonic() - began,
            "offered": m.offered,
            "written": m.written,
            "batchSeconds": elapsed,
            "scheduleLagSeconds": max(0, begin_batch - due),
        }
        samples.append(sample)
        (output / "stream-progress.json").write_text(json.dumps(sample) + "\n")
        print(json.dumps(sample), flush=True)
    # Keep the measurement interval at the exact configured nominal duration.
    time.sleep(max(0, began + args.minutes * 60 - time.monotonic()))
    duration = time.monotonic() - began
    finished_at = utc()
    # Read committed facts independently of the sink's reported counters; paginate the scan.
    observed_keys = set()
    for fact_partition in sorted({pk for pk, _sk in expected_keys}):
        request = {
            "TableName": table,
            "ConsistentRead": True,
            "KeyConditionExpression": "pk = :pk",
            "ExpressionAttributeValues": {":pk": {"S": fact_partition}},
            "ProjectionExpression": "pk, sk",
            "Limit": 1000,
        }
        while True:
            page = client.query(**request)
            observed_keys.update((item["pk"]["S"], item["sk"]["S"]) for item in page["Items"])
            if "LastEvaluatedKey" not in page:
                break
            request["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    replay = sink.write(
        first_batch, version, partition, idempotency_key=f"{table}:independent-replay"
    )
    report = {
        "scope": (
            "production normalize_row + DynamoHotRecordSink on DynamoDB Local; "
            "excludes ECS, SQS, projection, archive and public API"
        ),
        "startedAt": started_at,
        "finishedAt": finished_at,
        "durationSeconds": duration,
        "targetEventsPerMinute": 10000,
        "offered": m.offered,
        "written": m.written,
        "independentFactCount": len(observed_keys),
        "missing": len(expected_keys - observed_keys),
        "unexpected": len(observed_keys - expected_keys),
        "uniqueExpected": len(expected_keys),
        "maxScheduleLagSeconds": max(s["scheduleLagSeconds"] for s in samples),
        "processCpuSeconds": time.process_time() - cpu_started,
        "table": table,
        "batchSize": args.batch_size,
        "latencyP95Seconds": sorted(m.durations)[math.ceil(0.95 * len(m.durations)) - 1],
        "replay": {"written": replay.written, "unchanged": replay.unchanged},
    }
    report["capacityPassed"] = (
        duration <= args.minutes * 60 + schedule and report["maxScheduleLagSeconds"] <= schedule
    )
    report["integrityPassed"] = (
        report["missing"] == report["unexpected"] == 0
        and len(observed_keys) == total
        and replay.written == 0
        and replay.unchanged == len(first_batch)
    )
    report["passed"] = report["capacityPassed"] and report["integrityPassed"]
    (output / "stream-summary.json").write_text(json.dumps(report, indent=2) + "\n")
    (output / "stream-samples.json").write_text(json.dumps(samples, indent=2) + "\n")
    (output / "stream-final.prom").write_text(m.exposition())
    time.sleep(args.linger_seconds)
    server.shutdown()
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scenario", choices=["timeout", "stream"])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--minutes", type=float, default=15)
    parser.add_argument("--batch-size", type=int, default=1000)
    parser.add_argument("--dynamodb-endpoint", default="http://127.0.0.1:18003")
    parser.add_argument("--metrics-port", type=int, default=19101)
    parser.add_argument("--linger-seconds", type=int, default=60)
    args = parser.parse_args()
    if args.minutes <= 0 or not 1 <= args.batch_size <= 10000:
        parser.error("positive duration and batch-size 1..10000 required")
    if not args.dynamodb_endpoint.startswith("http://127.0.0.1:"):
        parser.error("DynamoDB endpoint must be local loopback")
    args.output.mkdir(parents=True, exist_ok=True)
    report = (
        timeout_experiment(args.output)
        if args.scenario == "timeout"
        else stream_experiment(args, args.output)
    )
    print(json.dumps(report), flush=True)
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
