"""Aggregate completed investigations without treating valid JSON as causal accuracy."""
import argparse
import json
import random
import statistics
from pathlib import Path

from benchmark import instant, save


def summarize(directory):
    plan = json.loads((directory / "plan.json").read_text())
    dataset = json.loads((directory / "dataset.json").read_text())
    cases = {c["id"]: c for c in dataset["cases"]}
    results = [json.loads((directory / (p["id"] + ".json")).read_text()) for p in plan if (directory / (p["id"] + ".json")).exists()]
    groups = {}
    for variant in ("A", "B"):
        selected = [r for r in results if r["variant"] == variant]
        times = [r["elapsed_ms"] / 1000 for r in selected]
        groups[variant] = {"completed": len(selected), "ready": sum(r["status"] == "ready" for r in selected),
            "failed": sum(r["status"] == "failed" for r in selected),
            "pending": sum(r["status"] == "pending" for r in selected),
            "budget_exceeded": sum(r["status"] == "budget_exceeded" for r in selected),
            "mean_seconds": statistics.mean(times) if times else None,
            "median_seconds": statistics.median(times) if times else None,
            "total_output_tokens": sum(r["output_tokens"] for r in selected),
            "total_llm_calls": sum(len(r["llm_trace"]) for r in selected),
            "total_tools": sum(len(r["tool_trace"]) for r in selected),
            "total_prompt_tokens_reported": sum(c.get("response", {}).get("prompt_eval_count", 0) for r in selected for c in r["llm_trace"] if c.get("response")),
            "tool_errors": sum(t["response"]["availability"] == "error" for r in selected for t in r["tool_trace"]),
            "investigations_with_native_tool_calls": sum(any(c.get("response", {}).get("message", {}).get("tool_calls") for c in r["llm_trace"] if c.get("response")) for r in selected)}
    save(directory / "summary.json", {"planned": len(plan), "completed": len(results), "groups": groups,
        "accuracy": None, "note": "Structural and operational measures only; human evidence review pending."})
    random.Random(11092026).shuffle(results)
    packets, key = [], []
    for i, r in enumerate(results):
        identifier = f"review-{i + 1:03}"
        key.append({"review_id": identifier, "run_id": r["run_id"], "variant": r["variant"]})
        case = cases[r["case_id"]]
        packets.append({"review_id": identifier, "case_id": r["case_id"], "signal": case["signal"],
            "diagnosis": r["diagnosis"], "status": r["status"],
            "evidence_available_before_cutoff": [row for row in case["records"] if instant(row.get("available_at", row["timestamp"])) <= instant(case["cutoff"]) and instant(row["timestamp"]) <= instant(case["cutoff"])],
            "evidence_returned_to_model": [t["response"] for t in r["tool_trace"]],
            "ratings_0_to_2": {"factual_support": None, "contradictions": None, "uncertainty": None, "useful_next_step": None},
            "unsupported_claims": [], "reviewer": None, "comments": None})
    # Never replace a reviewer-edited packet: regenerate only when no prior packet exists.
    packet_path = directory / "review-packets.json"
    if not packet_path.exists():
        save(packet_path, packets)
        save(directory / "review-key.json", key)
    lines = ["# Comparação operacional A/B", "", f"Execuções concluídas: {len(results)}/{len(plan)}.", "",
        "Resultados estruturais não medem acerto causal. O conjunto e os sinais utilizados estão no manifesto e no dataset congelado. A revisão humana permanece pendente.", "",
        "| Protótipo | Execuções | Saída válida | Falhas | Limite excedido | Média (s) | Mediana (s) | Chamadas LLM | Tokens gerados |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for variant, g in groups.items():
        mean = f'{g["mean_seconds"]:.2f}' if g["mean_seconds"] is not None else "—"
        median = f'{g["median_seconds"]:.2f}' if g["median_seconds"] is not None else "—"
        lines.append(f'| {variant} | {g["completed"]} | {g["ready"]} | {g["failed"]} | {g["budget_exceeded"]} | {mean} | {median} | {g["total_llm_calls"]} | {g["total_output_tokens"]} |')
    lines += ["", "- [Manifesto](manifest.json): parâmetros, hashes e identidade do modelo.",
              "- [Resumo completo](summary.json): consumo e uso real de ferramentas.",
              "- [Fichas de revisão](review-packets.json): sem identificação explícita de A/B; ainda sem notas humanas.",
              "- A chave de identificação fica em `review-key.json`, separada das fichas.",
              "- Os arquivos individuais preservam requisições, respostas e consultas. Falhas não são descartadas.",
              "- A forma das evidências pode sugerir o protótipo; ocultar a etiqueta não garante cegamento perfeito."]
    (directory / "README.md").write_text("\n".join(lines) + "\n")
    print(json.dumps(groups, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    summarize(parser.parse_args().directory)
