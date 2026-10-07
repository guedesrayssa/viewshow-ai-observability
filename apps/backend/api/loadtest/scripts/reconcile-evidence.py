"""Reconcile published k6 tables with immutable summaries, including failed checks.

--check fails when Markdown differs from the source-derived table. --write updates
only the delimited tables; evidence JSON is never rewritten. --output saves the
numeric provenance report. This is document validation, not a new load test.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
BEGIN = '<!-- BEGIN K6 RECONCILIATION -->'
END = '<!-- END K6 RECONCILIATION -->'
SOURCES = {
    'Sprint 4 / ECS / Nível 2': 'assets/testes-funcionais/2026-09-21/resumo-nivel2.json',
    'Sprint 4 / ECS / Nível 3': 'assets/testes-funcionais/2026-09-21/resumo-nivel3.json',
    'Sprint 5 / EKS / API-137': 'assets/testes-carga/2026-10-06-fechamento-aws/eks-native/api-load-137/resumo-front-api-load.json',
}


def number(value: float, precision: int = 0) -> str:
    """Return a Brazilian-format number, rounding only for display."""
    return f'{value:,.{precision}f}'.translate(str.maketrans({',': '.', '.': ','}))


def summaries() -> list[dict]:
    """Read each summary and reject inconsistent global/group check counters."""
    rows = []
    for label, source in SOURCES.items():
        body = (ROOT / source).read_bytes()
        data = json.loads(body)
        metrics = data['metrics']
        checks = metrics['checks']['values']
        groups = []
        pending = [data['root_group']]
        while pending:
            group = pending.pop()
            groups.extend(group.get('checks', []))
            pending.extend(group.get('groups', []))
        passes, fails = checks['passes'], checks['fails']
        if sum(c['passes'] for c in groups) != passes or sum(c['fails'] for c in groups) != fails:
            raise ValueError(f'{label}: global and individual checks disagree')
        if abs(checks['rate'] - passes / (passes + fails)) > 1e-10:
            raise ValueError(f'{label}: global check rate disagrees with counters')
        rows.append({
            'label': label, 'source': source,
            'sha256': hashlib.sha256(body).hexdigest(),
            'requests': metrics['http_reqs']['values']['count'],
            'checksPassed': passes, 'checksFailed': fails, 'checksRate': checks['rate'],
            'httpFailureRate': metrics['http_req_failed']['values']['rate'],
            'p95AllMs': metrics['http_req_duration']['values']['p(95)'],
            'p95Http200Ms': metrics.get('http_req_duration{status:200}', {}).get('values', {}).get('p(95)'),
            'droppedIterations': metrics['dropped_iterations']['values']['count'],
            'failedChecks': [{'name': c['name'], 'passes': c['passes'], 'fails': c['fails']} for c in groups if c['fails']],
        })
    return rows


def table(rows: list[dict], document: Path) -> str:
    """Render a source-derived table with links relative to its destination."""
    import os
    lines = [BEGIN,
             '| Ambiente / rodada | Requisições HTTP | Checks aprovados / total | Checks falhos | Falha HTTP | p95 geral / HTTP 200 (ms) | Chegadas descartadas |',
             '| --- | ---: | ---: | ---: | ---: | --- | ---: |']
    for row in rows:
        source = os.path.relpath(ROOT / row['source'], document.parent)
        successful = 'não exportado' if row['p95Http200Ms'] is None else number(row['p95Http200Ms'], 2)
        lines.append(f"| [{row['label']}]({source}) | {number(row['requests'])} | {number(row['checksPassed'])}/{number(row['checksPassed'] + row['checksFailed'])} ({number(100 * row['checksRate'], 2)}%) | {number(row['checksFailed'])} | {number(100 * row['httpFailureRate'], 2)}% | {number(row['p95AllMs'], 2)} / {successful} | {number(row['droppedIterations'])} |")
    lines.append(END)
    return '\n'.join(lines)


def reconcile(document: Path, rows: list[dict], write: bool) -> bool:
    """Compare or replace one explicitly delimited table, preserving surrounding text."""
    text = document.read_text()
    if text.count(BEGIN) != 1 or text.count(END) != 1:
        raise ValueError(f'{document}: exactly one reconciliation block is required')
    before, rest = text.split(BEGIN)
    _, after = rest.split(END)
    expected = before + table(rows, document) + after
    if write:
        document.write_text(expected)
    return text == expected or write


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--write', action='store_true')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    rows = summaries()
    documents = [ROOT / 'artefatos/testes-carga-finais.md', ROOT / 'artefatos/apoio/revisao-feedback-sprint4.md']
    results = [reconcile(document, rows[-1:] if document.name == "testes-carga-finais.md" else rows, args.write) for document in documents]
    report = {'scope': 'existing evidence; no new load execution', 'rows': rows, 'documentsMatch': all(results)}
    if args.output:
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({'sourcesChecked': len(rows), 'documentsMatch': all(results)}))
    raise SystemExit(0 if all(results) else 1)


if __name__ == '__main__':
    main()
