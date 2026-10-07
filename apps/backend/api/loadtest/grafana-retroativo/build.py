"""Prepare Grafana playback from preserved measurements, without running load."""
import hashlib
import json
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
ASSETS = ROOT / "assets/testes-carga"
OUTPUT = ASSETS / "2026-10-07-revisao"
SERIES = {}
PROVENANCE = []


def source(relative):
    path = ASSETS / relative
    PROVENANCE.append({"path": str(path.relative_to(ROOT)),
                       "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    return json.loads(path.read_text())


def epoch(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def record(name, unit, origin, transform, values, labels=None):
    # Never interpolate, pad gaps or manufacture samples of zero.
    SERIES[name] = {"unit": unit, "origin": origin, "transformation": transform,
                    "metric": {"__name__": name, **(labels or {})},
                    "values": sorted([[float(t), str(float(v))] for t, v in values])}


def panel(index, title, names, unit, x, y, width=12, points=False, kind="timeseries"):
    return {"id": index, "title": title, "type": kind,
            "datasource": {"type": "prometheus", "uid": "rnf-retro"},
            "gridPos": {"x": x, "y": y, "w": width, "h": 9},
            "targets": [{"refId": chr(65+i), "expr": name,
                         "legendFormat": "{{stage}}" if "stage_" in name else name.replace("rnf_retro_", ""),
                         "range": True} for i, name in enumerate(names)],
            "fieldConfig": {"defaults": {"unit": unit, "min": 0,
                "custom": {"showPoints": "always" if points else "auto",
                           "lineWidth": 0 if points else 2, "pointSize": 8,
                           "spanNulls": False}}, "overrides": []},
            "options": {"legend": {"displayMode": "list", "placement": "bottom"},
                        "tooltip": {"mode": "multi"},
                        "reduceOptions": {"calcs": ["lastNotNull"], "values": False}}}


def dashboard(uid, title, start, end, panels, description):
    body = {"uid": uid, "title": title, "description": description,
            "schemaVersion": 39, "version": 1, "timezone": "utc", "refresh": "",
            "tags": ["rnf", "retrospectivo", "dados-preservados"],
            "time": {"from": start, "to": end}, "panels": panels}
    target = HERE / "provisioning/dashboards" / f"{uid}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(body, indent=2, ensure_ascii=False)+"\n")


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    prefix = "2026-10-06-fechamento-aws/eks-native/observability-load137-final"
    api = []
    for i, (name, title, unit) in enumerate([
        ("api_p95_seconds", "Latência API EKS p95 (s)", "s"),
        ("api_requests_per_second", "Throughput servido pela API (req/s)", "reqps"),
        ("api_5xx_per_second", "Erros vistos pela API (5xx/s)", "suffix:erros/s"),
        ("api_cpu_core_percent", "CPU agregada — % de um núcleo", "percent"),
    ], 1):
        relative = f"{prefix}/prometheus-panel-{i}.json"
        raw = source(relative)
        if len(raw["data"]["result"]) != 1:
            raise ValueError("Expected one preserved aggregate series")
        metric = f"rnf_retro_{name}"
        record(metric, unit, relative, "identity: already computed PromQL: "+raw["query"],
               raw["data"]["result"][0]["values"])
        api.append(panel(i, title, [metric], unit, ((i-1) % 2)*12, ((i-1)//2)*9))
    dashboard("rnf-retro-api", "API EKS — carga real, leitura retrospectiva",
              raw["start"], raw["end"], api,
              "Frames Prometheus preservados de API-137. CPU corrigida: percentual de um núcleo, soma dos containers; pode exceder 100%. Throughput é o servidor coletado, não a taxa oferecida pelo k6.")

    relative = "2026-10-04-ingestao/etapas-cg05-150000.json"
    stages = source(relative)
    durations, rates = [], []
    stage_seconds = {}
    for row in stages:
        if row["stage"] not in ("INGESTING", "PROJECTING", "ARCHIVING"):
            continue
        duration = row["StageDurationMs"] / 1000
        stage_seconds[row["stage"]] = duration
        stem = row["stage"].lower()
        name = f"rnf_retro_stage_seconds_{stem}"
        record(name, "s", relative, "StageDurationMs / 1000; sample at emitted bucket", [(epoch(row["t"]), duration)], {"stage": row["stage"]})
        durations.append(name)
        name = f"rnf_retro_stage_events_per_minute_{stem}"
        record(name, "events/min", relative, "150000 * 60 / StageDurationSeconds; stage average, not instantaneous throughput", [(epoch(row["t"]), 150000*60/duration)], {"stage": row["stage"]})
        rates.append(name)
    k6_relative = "2026-10-04-ingestao/resumo-ingestao-cg05-150000.json"
    k6 = source(k6_relative)
    count = k6["metrics"]["ingestion_records_written"]["values"]["count"]
    if count != 150000:
        raise ValueError("Stage-rate normalization requires the preserved 150000 record count")
    k6_seconds = k6["metrics"]["ingestion_processing_seconds"]["values"]["max"]
    seconds = sum(stage_seconds.values())
    performance = {"sourcePaths": ["2026-10-04-ingestao/etapas-cg05-150000.json", k6_relative],
                   "scope": "one completed ECS run, concentrated 150000-event mass; not EKS timing",
                   "recordsWritten": count, "stageSeconds": stage_seconds,
                   "stageEventsPerMinute": {stage: count*60/duration for stage, duration in stage_seconds.items()},
                   "formula": "sequential rate = 1 / sum(1 / stage rate); equivalent to count*60/sum(stageSeconds)",
                   "stageSequenceSeconds": seconds, "stageSequenceEventsPerMinute": count*60/seconds,
                   "k6ProcessingSeconds": k6_seconds, "k6EventsPerMinute": count*60/k6_seconds,
                   "additionalObservedSeconds": k6_seconds-seconds,
                   "ingestingAndProjectingSeconds": stage_seconds["INGESTING"]+stage_seconds["PROJECTING"]}
    (OUTPUT / "performance-analysis.json").write_text(json.dumps(performance, indent=2, ensure_ascii=False)+"\n")
    relative = "2026-10-04-ingestao/cloudwatch-recursos-cg05-150000.json"
    resources = source(relative)
    for key, name in [("cpu", "ingestion_cpu_reserved_percent"), ("mem", "ingestion_memory_reserved_percent")]:
        record(f"rnf_retro_{name}", "percent", relative, "identity: preserved 100 * utilized / reserved at each matching timestamp",
               [(epoch(t), v) for t, v in resources["series"][key]["pct"].items()])
    dashboard("rnf-retro-ingestao", "Ingestão ECS — 150 mil eventos, etapas sequenciais",
              "2026-10-04T19:46:30Z", "2026-10-04T20:24:31Z", [
                  panel(1, "Duração por etapa — amostra de fim, não p95", durations, "suffix:s", 0, 0, points=True),
                  panel(2, "Vazão média por etapa (eventos/min)", rates, "suffix:eventos/min", 12, 0, points=True),
                  panel(3, "CPU / reserva da task de 2 vCPUs (%)", ["rnf_retro_ingestion_cpu_reserved_percent"], "percent", 0, 9),
                  panel(4, "Memória / reserva de 8 GiB (%)", ["rnf_retro_ingestion_memory_reserved_percent"], "percent", 12, 9),
              ], "Dados CloudWatch preservados. Etapas são pontos agregados, sem interpolação de taxa. Rejeitados=0 é agregado do k6; não existe série completa de erros/s do worker.")

    relative = "2026-10-05-ingestao/sqs-rs01-3lotes.json"
    queue = source(relative)
    for row in queue["MetricDataResults"]:
        record("rnf_retro_"+row["Id"], "s" if "idade" in row["Id"] else "count", relative,
               "identity: preserve CloudWatch bucket value, convert timestamp to UTC; no rate or interpolation",
               [(epoch(t), v) for t, v in zip(row["Timestamps"], row["Values"], strict=True)])
    dashboard("rnf-retro-fila", "Fila SQS — RS-01, três lotes e recuperação",
              "2026-10-06T02:30:00Z", "2026-10-06T03:05:00Z", [
                  panel(1, "Lotes visíveis / em processamento", ["rnf_retro_fila_visiveis", "rnf_retro_fila_em_processamento"], "short", 0, 0),
                  panel(2, "Idade da mensagem mais antiga (s)", ["rnf_retro_fila_idade_mais_antiga"], "suffix:s", 12, 0),
                  panel(3, "Recebimentos / confirmações por bucket", ["rnf_retro_fila_recebidas", "rnf_retro_fila_removidas"], "short", 0, 9),
                  panel(4, "Mensagens na DLQ", ["rnf_retro_dlq_visiveis"], "short", 12, 9),
              ], "Cada mensagem representa lote de 150 mil eventos. SQS aproximado, amostras preservadas por minuto. DLQ zero observado, não valor preenchido.")
    (HERE / "series.json").write_text(json.dumps(SERIES, indent=2, ensure_ascii=False)+"\n")
    provenance = {"kind": "retrospective visualization, no new load test", "sources": PROVENANCE,
                  "series": {name: {k: v for k, v in body.items() if k != "values"} | {"samples": len(body["values"])} for name, body in SERIES.items()}}
    (OUTPUT / "provenance.json").write_text(json.dumps(provenance, indent=2, ensure_ascii=False)+"\n")
    print(json.dumps({"series": len(SERIES), "sources": len(PROVENANCE), "output": str(OUTPUT)}))


if __name__ == "__main__":
    main()
