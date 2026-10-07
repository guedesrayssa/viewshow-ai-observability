"""Audit local references, JSON validity and immutable hashes of RNF evidence.

This validates artifact consistency, not production capacity or an academic grade.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]


def audit() -> dict:
    documents = [ROOT / 'artefatos/testes-carga-finais.md',
                 ROOT / 'artefatos/apoio/testes-carga-inventario.md',
                 ROOT / 'apps/backend/api/loadtest/lab/README.md',
                 ROOT / 'apps/backend/api/loadtest/grafana-retroativo/README.md']
    evidence_directories = sorted(ROOT.glob('assets/testes-carga/2026-10-06-fechamento-*')) + [ROOT / 'assets/testes-carga/2026-10-07-revisao']
    for directory in evidence_directories:
        documents.extend(directory.glob('README.md'))
    problems = []
    links = 0
    implementation_files = 0
    for document in documents:
        for raw in re.findall(r'\]\(([^)]+)\)', document.read_text()):
            target = raw.split('#')[0]
            if not target or re.match(r'[a-z]+:', target):
                continue
            links += 1
            if not (document.parent / target).exists():
                problems.append({'file': str(document.relative_to(ROOT)), 'missing': target})
    main = (ROOT / "artefatos/testes-carga-finais.md").read_text()
    inventory = (ROOT / "artefatos/apoio/testes-carga-inventario.md").read_text()
    parent = 0
    subheading = 0
    for level, number, child in re.findall(r'^(##|###) (\d+)\.(?:(\d+) )?', main, re.MULTILINE):
        if level == '##':
            if int(number) != parent + 1:
                problems.append({'error': 'Section numbering out of order', 'section': number})
            parent, subheading = int(number), 0
        else:
            if int(number) != parent or int(child or 0) != subheading + 1:
                problems.append({'error': 'Subsection belongs to another section or is out of order', 'subsection': f'{number}.{child}'})
            subheading = int(child or 0)
    names = set(re.findall(r"apps/[A-Za-z0-9_./-]+(?:\.(?:mjs|js|py|tf|ya?ml|json|tftpl)|Dockerfile|\.dockerignore)(?![A-Za-z0-9_.])", main + inventory))
    for name in sorted(names):
        implementation_files += 1
        if not (ROOT / name).is_file():
            problems.append({"missingImplementationFile": name})
    hashes = []
    for directory in evidence_directories:
        for p in sorted(directory.rglob('*')):
            if not p.is_file() or p.name in ('artifact-audit.json', 'SHA256SUMS'):
                continue
            if p.suffix == '.json':
                try:
                    json.loads(p.read_text())
                except (UnicodeDecodeError, ValueError) as error:
                    problems.append({'file': str(p.relative_to(ROOT)), 'invalidJson': str(error)})
            body = p.read_bytes()
            if p.suffix == '.png' and not body.startswith(b'\x89PNG\r\n\x1a\n'):
                problems.append({'file': str(p.relative_to(ROOT)), 'error': 'Invalid PNG signature'})
            if re.search(rb'(?:AKIA|ASIA)[A-Z0-9]{16}', body):
                problems.append({'file': str(p.relative_to(ROOT)), 'error': 'AWS access key found'})
            hashes.append({'path': str(p.relative_to(ROOT)), 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()})
    dashboard = ROOT / 'apps/backend/api/loadtest/lab/provisioning/dashboards/rnf-local.json'
    panels = json.loads(dashboard.read_text())['panels']
    if len({panel['id'] for panel in panels}) != len(panels):
        problems.append({'error': 'Duplicate panel IDs'})
    for directory in evidence_directories:
        for p in directory.rglob('observability-validation.json'):
            d = json.loads(p.read_text())
            # Only accepted validations may claim successful visualization.
            for check in d['checks']:
                if check['passed'] and (check['samples'] == 0 or check['httpStatus'] != 200 or check['errors']):
                    problems.append({'error': 'False positive observability validation', 'file': str(p.relative_to(ROOT))})
    provenance_path = ROOT / 'assets/testes-carga/2026-10-07-revisao/provenance.json'
    if provenance_path.exists():
        for source in json.loads(provenance_path.read_text())['sources']:
            p = ROOT / source['path']
            if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != source['sha256']:
                problems.append({'error': 'Retrospective source hash mismatch', 'file': source['path']})
    sources = []
    for name in sorted(names):
        p = ROOT / name
        if p.is_file():
            sources.append({'path': name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()})
    outputs = [{'path': str(p.relative_to(ROOT)), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted((ROOT / 'output/pdf').glob('*.pdf'))]
    return {'implementationFilesChecked': implementation_files, 'localLinksChecked': links, 'evidenceFiles': len(hashes), 'problems': problems, 'hashes': hashes, 'deliverySourceHashes': sources, 'outputHashes': outputs, 'passed': not problems}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = audit()
    if args.output:
        args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k:v for k,v in result.items() if k not in ('hashes', 'deliverySourceHashes', 'outputHashes')}))
    raise SystemExit(0 if result['passed'] else 1)


if __name__ == '__main__':
    main()
