"""Count facts of one synthetic candidate independently of worker progress.

Uses a local restored synthetic snapshot only to identify physical partitions;
queries the explicitly checked AWS account with strongly consistent COUNT pages.
No writes or candidate activation are performed.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import UTC, date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import boto3

from adapters.dynamodb.codec import encode_hot_record
from adapters.sources.mysql_reader import MySqlConnectionSettings, MySqlSourceReader
from application.archive_partition import archive_partition_key
from contracts.argus.v2.normalizers import normalize_row
from contracts.registry import DatasetRegistry
from domain.identity import dataset_version


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-account", required=True)
    parser.add_argument("--table", default="view-show-iac-operacional")
    args = parser.parse_args()
    account = boto3.client("sts", region_name="us-east-1").get_caller_identity()["Account"]
    if account != args.expected_account:
        raise SystemExit("AWS account mismatch")
    manifest = json.loads(args.manifest.read_text())
    if manifest.get("rowsPerWindow") != 150000 or manifest["rowCount"] > 750000:
        raise SystemExit("This verifier requires the declared concentrated single-day layout")
    registry = DatasetRegistry.load_argus_v2()
    version = dataset_version(
        str(registry.snapshot["sourceSystem"]),
        manifest["sha256"],
        str(registry.snapshot["physicalContractVersion"]),
        str(registry.snapshot["canonicalSchemaVersion"]),
    )
    reader = MySqlSourceReader(
        registry,
        MySqlConnectionSettings("127.0.0.1", 33077, "ingestion", "ingestion-test-only", "argus"),
    )
    context = reader.build_normalization_context()
    client = boto3.client("dynamodb", region_name="us-east-1")
    results = []
    began = time.monotonic()
    for descriptor in registry:
        expected = manifest["tableCounts"][descriptor.table]
        # The generator puts all synthetic signal rows on one day; small datasets
        # are read completely, covering every fixture partition.
        rows = reader.read_page(descriptor, None, None, min(expected, 1000)).rows
        keys = set()
        for row in rows:
            record = normalize_row(descriptor, row, context)
            partition = archive_partition_key(
                record,
                descriptor,
                snapshot_date=date.fromisoformat(manifest["snapshotExtractedOn"]),
            )
            keys.add(encode_hot_record(record, version, partition)["pk"])
        observed = requests = 0
        for key in sorted(keys):
            request = {
                "TableName": args.table,
                "KeyConditionExpression": "pk = :pk",
                "ExpressionAttributeValues": {":pk": {"S": key}},
                "Select": "COUNT",
                "Limit": 1000,
                "ConsistentRead": True,
            }
            while True:
                response = client.query(**request)
                observed += response["Count"]
                requests += 1
                if "LastEvaluatedKey" not in response:
                    break
                request["ExclusiveStartKey"] = response["LastEvaluatedKey"]
        item = {
            "dataset": descriptor.table,
            "expected": expected,
            "observed": observed,
            "partitions": sorted(keys),
            "requests": requests,
            "passed": expected == observed,
        }
        results.append(item)
        print(json.dumps(item), flush=True)
    report = {
        "account": account,
        "region": "us-east-1",
        "candidateVersionDerivedFromSnapshot": version,
        "table": args.table,
        "dumpSha256": manifest["sha256"],
        "expectedTotal": manifest["rowCount"],
        "observedTotal": sum(r["observed"] for r in results),
        "datasets": results,
        "durationSeconds": time.monotonic() - began,
        "verifiedAt": datetime.now(UTC).isoformat(),
        "scope": (
            "all 23 hot fact datasets; excludes projection/archive completion; "
            "limited to the synthetic generator single-day layout for the large "
            "signal dataset"
        ),
    }
    report["passed"] = (
        all(r["passed"] for r in results) and report["observedTotal"] == manifest["rowCount"]
    )
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
