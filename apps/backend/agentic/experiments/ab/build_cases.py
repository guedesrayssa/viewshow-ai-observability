"""Select 12 real, non-overlapping QoE windows without using incident narratives as inputs."""
import argparse
import json
import sqlite3
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from benchmark import digest, save

HOUR = 3600000


def iso(ts):
    return datetime.fromtimestamp(ts / 1000, timezone.utc).isoformat().replace("+00:00", "Z")


def build(source, output):
    db = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    groups = defaultdict(list)
    for row in db.execute("SELECT * FROM qoe ORDER BY hour_ts,sinal"):
        groups[(row["sinal"], row["hour_ts"] // (6 * HOUR))].append(dict(row))
    candidates = defaultdict(list)
    complete = {}
    for (channel, block), rows in groups.items():
        if len(rows) != 6 or [r["hour_ts"] for r in rows] != [block * 6 * HOUR + i * HOUR for i in range(6)]:
            continue
        if any(r["bufferratio_avg"] is None or r["sessions"] is None or r["sessions"] < 20 for r in rows):
            continue
        if statistics.median(r["sessions"] for r in rows) < 100:
            continue
        complete[(channel, block)] = rows
        reference = statistics.mean(r["bufferratio_avg"] for r in rows[:3])
        current = statistics.mean(r["bufferratio_avg"] for r in rows[3:])
        delta = current - reference
        relative = delta / max(abs(reference), .1)
        category = "increase" if relative >= 1 and delta > .5 else "decrease" if relative <= -.5 and delta < -.5 else "stable" if abs(relative) <= .1 and abs(delta) < .2 else None
        if category:
            candidates[category].append({"channel": channel, "block": block, "reference": reference,
                "current": current, "delta": delta, "relative_change": relative,
                "sessions_median": statistics.median(r["sessions"] for r in rows)})
    for category in candidates:
        candidates[category].sort(key=lambda c: (-c["sessions_median"] if category == "stable" else -abs(c["delta"]), c["block"], c["channel"]))
    selected = []
    days = set()
    channel_counts = defaultdict(int)
    for _ in range(4):
        for category in ("increase", "decrease", "stable"):
            for candidate in candidates[category]:
                day = candidate["block"] // 4
                peers = [(statistics.median(r["sessions"] for r in rows), channel) for (channel, block), rows in complete.items() if block == candidate["block"] and channel != candidate["channel"]]
                if day not in days and channel_counts[candidate["channel"]] < 3 and peers:
                    selected.append({**candidate, "category": category, "comparison_channel": max(peers)[1]})
                    days.add(day)
                    channel_counts[candidate["channel"]] += 1
                    break
            else:
                raise ValueError(f"Insufficient non-overlapping windows for {category}; candidates: { {k:len(v) for k,v in candidates.items()} }")
    units = {"bufferratio_avg": "source ratio; scale unverified, do not convert to percent", "sessions": "sessions/hour",
        "errors": "error events/hour", "startup_errors": "startup error events/hour",
        "latency_ms_avg": "ms", "jointime_s_avg": "seconds", "stalls_avg": "stalls/session",
        "errors_per_session": "error events/session, not probability"}
    cases = []
    for i, chosen in enumerate(selected, 1):
        start = chosen["block"] * 6 * HOUR
        cutoff = start + 6 * HOUR
        records = []
        for channel in (chosen["channel"], chosen["comparison_channel"]):
            for row in complete[(channel, chosen["block"])]:
                values = {k: row.get(k) for k in units}
                values["errors_per_session"] = row["errors"] / row["sessions"] if row["sessions"] else None
                for metric, value in values.items():
                    key = {"table": "live_qoe_hourly", "hour_ts": row["hour_ts"], "sinal": channel, "metric": metric}
                    records.append({"id": "obs:" + digest(key)[:16], "timestamp": iso(row["hour_ts"]),
                        "available_at": iso(row["hour_ts"] + HOUR), "metric": metric,
                        "scope": "sinal:" + channel, "value": value, "unit": units[metric],
                        "source": "live_qoe_hourly", "source_key": key})
        cases.append({"id": f"real-{i:02}", "synthetic": False, "cutoff": iso(cutoff),
            "signal": {"metric": "bufferratio_avg", "scope": "sinal:" + chosen["channel"],
                "trigger": "EXPLORATORY_WINDOW_COMPARISON", "method": "Fixed descriptive mean comparison, not the trained detector or forecaster",
                "reference_mean": chosen["reference"], "current_mean": chosen["current"],
                "delta": chosen["delta"], "unit": units["bufferratio_avg"],
                "instruction": "Investigate observed behavior; no verified incident or known root cause is supplied."},
            "reference_window": {"start": iso(start), "end": iso(start + 3 * HOUR), "expected_points": 3},
            "current_window": {"start": iso(start + 3 * HOUR), "end": iso(cutoff), "expected_points": 3},
            "records": records})
    extraction = json.loads(source.with_suffix(".manifest.json").read_text())
    output.mkdir(parents=True, exist_ok=True)
    save(output / "real-cases.json", {"kind": "real-qoe-exploratory-replay-no-causal-labels", "source_sha256": extraction["source_sha256"], "cases": cases})
    save(output / "selection.json", {"selected": selected, "candidate_counts": {k: len(v) for k, v in candidates.items()},
        "extraction": extraction, "limitations": [
            "Selected for contrast, not an estimate of incident prevalence or an independent causal test set.",
            "Four increases, four decreases, four near-stable windows; thresholds select scenarios, not calibrated anomalies.",
            "One case per UTC date; three-hour reference followed by three-hour current window, two channels per case.",
            "A high-volume comparison channel is not a confirmed healthy control.",
            "Average of hourly averages is descriptive, not a session-weighted population estimate.",
            "Hour-end availability assumed; original arrival times and retrospective revisions unavailable.",
            "No incident narratives or future observations sent to the model.",
            "No prediction model is run in this investigation comparison.",
            "Buffer ratio kept in original scale; no percentage conversion."]})
    print(json.dumps({"cases": len(cases), "records": sum(len(c["records"]) for c in cases), "selected": selected}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    build(args.source, args.output)
