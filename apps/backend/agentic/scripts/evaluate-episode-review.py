#!/usr/bin/env python3
"""Summarize completed human episode reviews without inventing missing labels."""
import argparse
import csv
import json
from collections import Counter, defaultdict
from pathlib import Path

YES_NO = {"yes", "no"}
LAYERS = {"cdn", "origin", "player", "traffic", "measurement", "unknown"}

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--review", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    with args.review.open(encoding="utf-8") as stream:
        rows = list(csv.DictReader(stream))
    invalid = []
    for row in rows:
        relevant, sufficient, layer = row["is_relevant"].strip().lower(), row["evidence_sufficient"].strip().lower(), row["probable_layer"].strip().lower()
        if relevant not in YES_NO or sufficient not in YES_NO or layer not in LAYERS:
            invalid.append(row["review_id"])
    if invalid:
        raise SystemExit(f"incomplete or invalid reviews ({len(invalid)}): {','.join(invalid[:10])}")
    totals = Counter(), defaultdict(Counter), Counter()
    overall, by_scope, layers = totals
    for row in rows:
        relevant = row["is_relevant"].strip().lower() == "yes"
        sufficient = row["evidence_sufficient"].strip().lower() == "yes"
        overall["reviewed"] += 1; overall["relevant"] += relevant; overall["evidence_sufficient"] += sufficient
        by_scope[row["scope_id"]]["reviewed"] += 1; by_scope[row["scope_id"]]["relevant"] += relevant
        layers[row["probable_layer"].strip().lower()] += 1
    reviewed = overall["reviewed"]
    result = {"schemaVersion": "episode-review-evaluation-v1", "reviewed": reviewed,
              "relevant": overall["relevant"], "relevanceRate": overall["relevant"] / reviewed,
              "evidenceSufficient": overall["evidence_sufficient"], "evidenceSufficiencyRate": overall["evidence_sufficient"] / reviewed,
              "layers": dict(layers),
              "byScope": {scope: {**counts, "relevanceRate": counts["relevant"] / counts["reviewed"]} for scope, counts in sorted(by_scope.items())}}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()
