#!/usr/bin/env python3
"""Export replay episodes as a blind human-review worksheet."""
import argparse
import csv
import json
from pathlib import Path

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--replay", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    replay = json.loads(args.replay.read_text())
    rows = []
    for scope in replay["scopes"]:
        for index, episode in enumerate(scope["detection"]["episodeDetails"], 1):
            rows.append({
                "review_id": f"REV-{len(rows) + 1:03d}",
                "scope_id": scope["scopeId"],
                "start": episode["start"],
                "end": episode["end"],
                "buckets": episode["buckets"],
                "peak_relative_margin": round(episode["peakRelativeMargin"], 6),
                "trigger_metrics": ";".join(episode["triggerMetrics"]),
                "delivery_increases": ";".join(episode["deliveryIncreases"]),
                "peak_evidence_json": json.dumps(episode["peakFacts"], ensure_ascii=False, separators=(",", ":")),
                "is_relevant": "",
                "probable_layer": "",
                "evidence_sufficient": "",
                "notes": "",
            })
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps({"episodes": len(rows), "output": str(args.output)}))

if __name__ == "__main__":
    main()
