#!/usr/bin/env python3
"""Aprova explicitamente um bundle já avaliado, preservando a origem da decisão."""
import argparse, hashlib, json
from datetime import datetime, timezone
from pathlib import Path
p=argparse.ArgumentParser(); p.add_argument("--input",type=Path,required=True); p.add_argument("--output",type=Path,required=True)
p.add_argument("--expected-sha256",required=True); p.add_argument("--reference",required=True); a=p.parse_args()
raw=a.input.read_bytes(); actual=hashlib.sha256(raw).hexdigest()
if actual != a.expected_sha256: raise SystemExit(f"hash divergente: {actual}")
data=json.loads(raw); data["approved"]=True; data["approval"]={"reference":a.reference,"sourceSha256":actual,"approvedAt":datetime.now(timezone.utc).isoformat()}
a.output.write_text(json.dumps(data,separators=(",",":")),encoding="utf-8")
print(hashlib.sha256(a.output.read_bytes()).hexdigest())
