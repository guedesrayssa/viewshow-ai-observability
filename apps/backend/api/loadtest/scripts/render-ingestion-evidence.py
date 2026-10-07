"""Renderiza gráficos retrospectivos a partir dos JSON versionados, sem consultar a AWS.

Os gráficos preservam datas, fontes e unidades das medições. Agregados do k6
não são apresentados como séries temporais nem como capturas de Grafana.
Requer matplotlib; execute este arquivo a partir de qualquer diretório.
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as dates
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[5]
EVIDENCE = ROOT / "assets/testes-carga"


def read(relative: str) -> dict | list:
    """Carrega um bruto versionado relativo ao diretório de evidências."""
    return json.loads((EVIDENCE / relative).read_text(encoding="utf-8"))


def instant(value: str) -> datetime:
    """Converte timestamps com fuso para UTC; timestamps EMF sem fuso são UTC."""
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)


def percent_series(document: dict, metric: str) -> list[tuple[datetime, float]]:
    """Calcula utilizado/reservado apenas onde existem as duas amostras."""
    series = document["series"]
    if isinstance(series[metric].get("utilizado"), dict):
        used, reserved = series[metric]["utilizado"], series[metric]["reservado"]
    else:
        used, reserved = series[metric], series[metric + "res"]
    return sorted(
        (instant(t), 100 * value / reserved[t])
        for t, value in used.items()
        if t in reserved and reserved[t] > 0
    )


def save(fig, output: Path, name: str, footer: str) -> None:
    """Exporta uma imagem com proveniência visível e margem para os eixos."""
    fig.text(0.02, 0.015, footer, fontsize=9, color="#526072")
    fig.tight_layout(rect=(0, 0.06, 1, 0.95))
    fig.savefig(output / name, dpi=160, facecolor="white")
    plt.close(fig)


def control_plane(output: Path) -> None:
    """Compara agregados do cliente e a CPU do componente indicado por rodada."""
    names = ["cg01", "cg04", "rs06"]
    summaries = [read(f"2026-09-30-ingestao/resumo-ingestao-{n}.json") for n in names]
    resources = [read(f"2026-09-30-ingestao/cloudwatch-recursos-{n}.json")
                 if n == "cg01" else read(f"2026-09-30-ingestao/cloudwatch-recursos-api-{n}.json")
                 for n in names]
    metrics = [j["metrics"] for j in summaries]
    latency = [m["http_req_duration"]["values"]["p(95)"] for m in metrics]
    throughput = [m["http_reqs"]["values"]["rate"] for m in metrics]
    failures = [m["http_req_failed"]["values"]["passes"] * m["http_reqs"]["values"]["rate"] /
                m["http_reqs"]["values"]["count"] for m in metrics]
    cpu = [max(v for _, v in percent_series(j, "cpu")) for j in resources]
    fig, axes = plt.subplots(2, 2, figsize=(12, 7))
    fig.suptitle("Ingestão — indicadores medidos em 30/09/2026", fontsize=16)
    panels = [(latency, "Latência p95 do cliente", "ms"),
              (throughput, "Throughput HTTP médio", "req/s"),
              (failures, "Falhas HTTP médias (inclui 503)", "falhas/s"),
              (cpu, "CPU máxima na janela de cada teste", "% utilizado/reservado")]
    for ax, (values, title, unit) in zip(axes.flat, panels):
        bars = ax.bar([n.upper() for n in names], values, color=["#1864ab", "#e67700", "#2b8a3e"])
        ax.set(title=title, ylabel=unit)
        ax.set_ylim(0, max(values) * 1.25 or 1)
        ax.bar_label(bars, labels=[f"{v:.3f}" if v < 1 else f"{v:.1f}" for v in values], padding=3)
        ax.grid(axis="y", alpha=0.2)
    save(fig, output, "indicadores-controle.png",
         "Fonte: resumos k6 e Container Insights versionados. HTTP inclui PUT S3 no CG-01.\n"
         "CPU: worker import-dump no CG-01; API no CG-04/RS-06. Agregados por rodada, não série temporal.")


def worker(output: Path) -> None:
    """Mostra duração das etapas e séries reais de CPU e memória do CG-05."""
    fig, axes = plt.subplots(1, 3, figsize=(15, 5))
    fig.suptitle("CG-05 — pipeline, CPU e memória em 04/10/2026", fontsize=16)
    stages = ["INGESTING", "PROJECTING", "ARCHIVING"]
    colors = ["#1864ab", "#e67700"]
    for index, volume in enumerate((150000, 300000)):
        items = read(f"2026-10-04-ingestao/etapas-cg05-{volume}.json")
        durations = {s: sum(i["StageDurationMs"] for i in items if i["stage"] == s) / 60000 for s in stages}
        offset = -0.19 if index == 0 else 0.19
        axes[0].bar([p + offset for p in range(3)], list(durations.values()), width=0.38,
                    color=colors[index], label=f"{volume:,} eventos")
        document = read(f"2026-10-04-ingestao/cloudwatch-recursos-cg05-{volume}.json")
        origin = instant(document["inicio"])
        for ax, metric in zip(axes[1:], ("cpu", "mem")):
            points = percent_series(document, metric)
            ax.plot([(t - origin).total_seconds() / 60 for t, _ in points], [v for _, v in points],
                    color=colors[index], label=f"{volume:,} eventos")
            ax.set(xlabel="Minutos desde o início da rodada", ylabel="% utilizado/reservado")
    axes[0].set(xticks=range(3), xticklabels=stages, ylabel="Minutos", title="Duração por etapa")
    axes[1].set_title("CPU da task (2 vCPU)")
    axes[1].set_ylim(0, 100)
    axes[2].set_title("Memória da task (8 GiB)")
    for ax in axes:
        ax.legend(fontsize=8)
        ax.grid(alpha=0.2)
    save(fig, output, "recursos-cg05.png",
         "Fonte: etapas-cg05-*.json e cloudwatch-recursos-cg05-*.json. As rodadas têm origens temporais distintas.\n"
         "CPU próxima de 50% equivale a cerca de uma das duas vCPU; ausência de amostra não é preenchida com zero.")


def queue(output: Path) -> None:
    """Reproduz a profundidade e idade da FIFO no RS-01 de quatro lotes."""
    document = read("2026-10-05-ingestao/sqs-rs01-4lotes.json")
    fig, axes = plt.subplots(2, 1, figsize=(12, 7), sharex=True)
    fig.suptitle("RS-01 — quatro lotes de 150.000 eventos em 06/10/2026 (UTC)", fontsize=15)
    wanted = {"fila_visiveis": (axes[0], "Visíveis", 1),
              "fila_em_processamento": (axes[0], "Em processamento", 1),
              "dlq_visiveis": (axes[0], "DLQ", 1),
              "fila_idade_mais_antiga": (axes[1], "Idade da mensagem mais antiga", 60)}
    for metric in document["MetricDataResults"]:
        if metric["Id"] not in wanted:
            continue
        ax, label, divisor = wanted[metric["Id"]]
        pairs = sorted((instant(t), v / divisor) for t, v in zip(metric["Timestamps"], metric["Values"]))
        if pairs:
            ax.step([t for t, _ in pairs], [v for _, v in pairs], where="post", label=label)
    axes[0].set_ylabel("Mensagens")
    axes[1].set(ylabel="Idade (min)", xlabel="Horário UTC")
    axes[1].xaxis.set_major_formatter(dates.DateFormatter("%H:%M", tz=UTC))
    for ax in axes:
        ax.axvline(instant("2026-10-06T04:07:32Z"), linestyle="--", color="#526072", label="Agenda ligada")
        ax.legend(fontsize=8)
        ax.grid(alpha=0.2)
    save(fig, output, "fila-rs01-4lotes.png",
         "Fonte: sqs-rs01-4lotes.json, CloudWatch AWS/SQS (amostras por minuto).\n"
         "A idade segue a semântica da métrica SQS; a conclusão dos quatro lotes é comprovada pelos logs e contagens.")


def main() -> None:
    """Gera as três figuras preservando todos os brutos originais."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=EVIDENCE / "2026-10-06-revisao-ingestao")
    output = parser.parse_args().output_dir
    output.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update({"font.family": "DejaVu Sans", "axes.spines.top": False, "axes.spines.right": False})
    control_plane(output)
    worker(output)
    queue(output)
    print(f"3 gráficos gerados em {output}")


if __name__ == "__main__":
    main()
