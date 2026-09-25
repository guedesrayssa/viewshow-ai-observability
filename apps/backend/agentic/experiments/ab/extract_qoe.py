"""Read only: extract live_qoe_hourly from a sanitized MySQL gzip dump, without executing SQL."""
import argparse
import gzip
import hashlib
import json
import re
import sqlite3
from pathlib import Path


def tuples(text):
    i = 0
    row = None
    while i < len(text):
        c = text[i]
        if c.isspace() or c in ",;":
            i += 1
        elif c == "(":
            row = []
            i += 1
        elif c == ")":
            if row is None:
                raise ValueError("Unexpected tuple end")
            yield row
            row = None
            i += 1
        elif c == "'":
            if row is None:
                raise ValueError("Unexpected string")
            i += 1
            value = []
            while i < len(text):
                c = text[i]
                if c == "\\":
                    i += 1
                    value.append({"n": "\n", "r": "\r", "t": "\t", "0": "\0"}.get(text[i], text[i]))
                elif c == "'":
                    if i + 1 < len(text) and text[i + 1] == "'":
                        value.append("'")
                        i += 1
                    else:
                        i += 1
                        break
                else:
                    value.append(c)
                i += 1
            else:
                raise ValueError("Unterminated string")
            row.append("".join(value))
        else:
            end = i
            while end < len(text) and text[end] not in ",);":
                end += 1
            token = text[i:end].strip()
            if row is None:
                raise ValueError("Unexpected value")
            row.append(None if token == "NULL" else float(token) if any(x in token for x in ".eE") else int(token))
            i = end
    if row is not None:
        raise ValueError("Unterminated tuple")


def extract(source, destination):
    if destination.exists():
        raise SystemExit("Refusing to overwrite an extraction")
    db = sqlite3.connect(destination)
    columns = []
    in_schema = False
    in_values = False
    insert_columns = []
    count = 0
    db.execute("CREATE TABLE qoe (hour_ts INTEGER, sinal TEXT, sessions REAL, errors REAL, startup_errors REAL, latency_ms_avg REAL, latency_ms_p50 REAL, latency_ms_p95 REAL, bufferratio_avg REAL, jointime_s_avg REAL, dropped_frames_avg REAL, stalls_avg REAL, PRIMARY KEY(hour_ts,sinal))")
    names = [r[1] for r in db.execute("PRAGMA table_info(qoe)")]
    # Reading to EOF also validates the gzip CRC and detects a truncated download.
    with gzip.open(source, "rt", encoding="utf-8") as stream:
        for line in stream:
            if line.startswith("CREATE TABLE `live_qoe_hourly`"):
                in_schema = True
                continue
            if in_schema:
                match = re.match(r"\s+`([^`]+)`", line)
                if match:
                    columns.append(match.group(1))
                if line.startswith(")"):
                    in_schema = False
            if line.startswith("INSERT INTO `live_qoe_hourly`"):
                if not set(names).issubset(columns):
                    raise ValueError(f"Missing required dump columns: {set(names) - set(columns)}")
                header, values = line.split(" VALUES", 1)
                explicit = re.search(r"\((.*)\)", header)
                insert_columns = re.findall(r"`([^`]+)`", explicit.group(1)) if explicit else columns
                if not set(names).issubset(insert_columns):
                    raise ValueError("INSERT missing required columns")
                in_values = True
            elif in_values:
                values = line
            else:
                continue
            if in_values and values.strip():
                rows = list(tuples(values))
                if any(len(r) != len(insert_columns) for r in rows):
                    raise ValueError("Unexpected row width")
                rows = [[r[insert_columns.index(name)] for name in names] for r in rows]
                db.executemany("INSERT INTO qoe VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", rows)
                count += len(rows)
                if count % 10000 < len(rows):
                    print(f"Extracted {count} QoE rows", flush=True)
                if values.rstrip().endswith(";"):
                    in_values = False
    db.commit()
    minimum, maximum, channels = db.execute("SELECT min(hour_ts),max(hour_ts),count(distinct sinal) FROM qoe").fetchone()
    stats = {"source": str(source), "rows": count, "min_timestamp_ms": minimum,
             "max_timestamp_ms": maximum, "channels": channels, "gzip_crc_verified": True,
             "dump_columns": columns, "extracted_columns": names}
    db.close()
    h = hashlib.sha256()
    with source.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    stats["source_sha256"] = h.hexdigest()
    destination.with_suffix(".manifest.json").write_text(json.dumps(stats, indent=2) + "\n")
    print(json.dumps(stats), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    extract(args.source, args.destination)
