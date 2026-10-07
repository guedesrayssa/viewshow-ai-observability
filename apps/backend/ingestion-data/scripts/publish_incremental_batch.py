"""Publica lotes incrementais sintéticos na FIFO para os testes de carga da Sprint 5.

Papel no fluxo:
    Substitui o `export-incremental` (que depende do MySQL live) nos testes de
    artefatos/sprint5/testes-carga-ingestao.md: grava o Parquet e o manifesto
    imutáveis no bucket raw com os mesmos adaptadores do worker e envia a
    referência para a fila `*-incremental-batches.fifo`, de onde o
    `ingest-incremental` agendado consome.

Variantes:
    valid           M-05 — `--rows` linhas válidas de `signal_bucket` por janela.
    missing-column  M-06 — mesmo lote sem a coluna obrigatória `value`; o
                    worker deve colocá-lo em QUARANTINED (RS-03).
    poison          RS-05 — envelope válido apontando para uma versão de
                    manifesto inexistente; a leitura falha sempre como erro
                    retentável, e a mensagem vai para a DLQ após
                    maxReceiveCount = 5.

Garantias e limites:
    O worker não é chamado: o script só publica. A identidade do lote deriva
    da janela, então republicar a mesma janela com conteúdo diferente falha
    por conflito de imutabilidade; use outra `--window-start`. Mantenha o
    agendamento de `export-incremental` desligado durante os testes para não
    competir pelas mesmas janelas. `--dry-run` codifica e valida o lote
    localmente, sem acessar a AWS.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from collections.abc import Iterator, Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from contracts.registry import DatasetRegistry
from domain.analysis import canonical_utc_text
from domain.canonical_json import canonical_bytes
from domain.incremental_batches import IncrementalBatchDefinition, PhysicalColumn
from domain.models import TimeWindow

DATASET = "signal_bucket"
EXPORTER_VERSION = "1.0"
POISON_VERSION_ID = "k6-carga-versao-inexistente"


def _parse_utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise argparse.ArgumentTypeError("--window-start precisa de fuso (ex.: 2026-09-30T12:00:00Z)")
    return parsed.astimezone(UTC)


def _last_closed_window_start(now: datetime, grain_seconds: int) -> datetime:
    epoch = int(now.timestamp())
    return datetime.fromtimestamp(epoch - epoch % grain_seconds - grain_seconds, UTC)


def _columns(registry: DatasetRegistry, variant: str) -> tuple[PhysicalColumn, ...]:
    descriptor = registry.require(DATASET)
    names = [column for column in descriptor.columns if not (variant == "missing-column" and column.name == "value")]
    return tuple(
        PhysicalColumn(column.name, column.sql_type, column.nullable, ordinal)
        for ordinal, column in enumerate(names, start=1)
    )


def _rows(window: TimeWindow, count: int, columns: tuple[PhysicalColumn, ...]) -> Iterator[Mapping[str, object]]:
    """Linhas distintas por `entity`, todas no bucket da janela."""
    bts = int(window.start.timestamp() * 1000)
    for index in range(count):
        row: dict[str, object] = {
            "bts": bts,
            "source": "carga-sprint5",
            "entity": f"carga-{bts}-{index:07d}",
            "metric": "row-count",
            "value": float(index + 1),
        }
        yield {column.name: row[column.name] for column in columns}


def _window(start: datetime, grain_seconds: int) -> TimeWindow:
    if int(start.timestamp()) % grain_seconds:
        raise ValueError(f"--window-start precisa estar alinhada a {grain_seconds // 60} min")
    return TimeWindow(start, start + timedelta(seconds=grain_seconds), grain_seconds)


def _settings() -> tuple[str, str, str]:
    missing = [
        name
        for name in (
            "INCREMENTAL_BATCH_BUCKET",
            "INCREMENTAL_BATCH_EXPECTED_BUCKET_OWNER",
            "INCREMENTAL_BATCH_QUEUE_URL",
        )
        if not os.environ.get(name)
    ]
    if missing:
        raise SystemExit(
            "Defina " + ", ".join(missing) + " (terraform -chdir=apps/fullstack output -json ingestion_runbook)."
        )
    return (
        os.environ["INCREMENTAL_BATCH_BUCKET"],
        os.environ["INCREMENTAL_BATCH_EXPECTED_BUCKET_OWNER"],
        os.environ["INCREMENTAL_BATCH_QUEUE_URL"],
    )


def _schema_differences(registry: DatasetRegistry, columns: tuple[PhysicalColumn, ...]) -> list[str]:
    """Mesma regra de `_differences` em application/ingest_incremental.py, só para o dry-run."""
    observed = {column.name: (column.physical_type, column.nullable) for column in columns}
    differences = []
    for column in registry.require(DATASET).columns:
        actual = observed.get(column.name)
        if actual is None:
            differences.append(f"missing required column {column.name}")
        elif actual != (column.sql_type, column.nullable):
            differences.append(f"type or nullability differs for {column.name}")
    return differences


def publish_window(
    *,
    registry: DatasetRegistry,
    window: TimeWindow,
    variant: str,
    rows: int,
    workdir: Path,
    dry_run: bool,
) -> dict[str, object]:
    definition = IncrementalBatchDefinition(
        str(registry.snapshot["sourceSystem"]), DATASET, window, 0, EXPORTER_VERSION
    )
    evidence: dict[str, object] = {
        "variant": variant,
        "batchId": definition.batch_id,
        "windowStart": canonical_utc_text(window.start, "window.start"),
        "windowEnd": canonical_utc_text(window.end, "window.end"),
    }

    if variant == "poison":
        from adapters.incremental.s3_batches import _base_key

        key = f"{_base_key(definition)}/manifest.json"
        evidence.update({"rows": 0, "manifestKey": key, "manifestVersionId": POISON_VERSION_ID})
        if dry_run:
            return evidence
        import boto3

        bucket, _owner, queue_url = _settings()
        body = canonical_bytes(
            {
                "contractVersion": "1.0",
                "batchId": definition.batch_id,
                "sourceDataset": DATASET,
                "manifest": {"bucket": bucket, "key": key, "versionId": POISON_VERSION_ID},
            }
        )
        sent = boto3.client("sqs").send_message(
            QueueUrl=queue_url,
            MessageBody=body.decode("utf-8"),
            MessageGroupId=DATASET,
            # Deduplicação própria: não pode colidir com um lote válido da mesma janela.
            MessageDeduplicationId=f"poison-{definition.batch_id}",
        )
        evidence["messageId"] = sent["MessageId"]
        return evidence

    from adapters.incremental.parquet import RawParquetCodec

    columns = _columns(registry, variant)
    destination = workdir / definition.batch_id / "data.parquet"
    destination.parent.mkdir(parents=True, exist_ok=True)
    encoded = RawParquetCodec().encode(columns, _rows(window, rows, columns), destination)
    evidence.update(
        {
            "rows": encoded.row_count,
            "sizeBytes": encoded.size_bytes,
            "sha256": encoded.sha256,
            "schemaDifferences": _schema_differences(registry, columns),
        }
    )
    if dry_run:
        return evidence

    import boto3

    from adapters.incremental.s3_batches import S3IncrementalBatchStore
    from adapters.messaging.incremental_sqs import SqsIncrementalBatchQueue

    bucket, owner, queue_url = _settings()
    store = S3IncrementalBatchStore(boto3.client("s3"), bucket, expected_bucket_owner=owner, registry=registry)
    reference = store.publish(definition, columns, encoded)
    SqsIncrementalBatchQueue(boto3.client("sqs"), queue_url).send(
        reference, batch_id=definition.batch_id, dataset=DATASET
    )
    evidence.update({"manifestKey": reference.key, "manifestVersionId": reference.version_id})
    return evidence


def _parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--variant", choices=("valid", "missing-column", "poison"), default="valid")
    parser.add_argument("--rows", type=int, default=150_000, help="linhas por janela (padrão: 150.000)")
    parser.add_argument("--windows", type=int, default=1, help="janelas consecutivas a publicar (RS-01)")
    parser.add_argument(
        "--window-start",
        type=_parse_utc,
        help="início da primeira janela, alinhado a 15 min (padrão: as N janelas terminam na última fechada)",
    )
    parser.add_argument("--dry-run", action="store_true", help="só codifica e valida localmente")
    parser.add_argument("--output", type=Path, help="grava as evidências em JSON")
    arguments = parser.parse_args(argv)
    if arguments.rows < 1 or arguments.windows < 1:
        parser.error("--rows e --windows precisam ser positivos")
    return arguments


def main(argv: list[str] | None = None) -> int:
    arguments = _parse_arguments(sys.argv[1:] if argv is None else argv)
    registry = DatasetRegistry.load_argus_v2()
    grain = registry.require(DATASET).grain_seconds
    if grain is None:
        raise SystemExit(f"{DATASET} não tem grão incremental configurado")
    # Sem --window-start, as N janelas terminam na última janela já fechada.
    first = arguments.window_start or _last_closed_window_start(datetime.now(UTC), grain) - timedelta(
        seconds=grain * (arguments.windows - 1)
    )
    evidences = []
    with tempfile.TemporaryDirectory(prefix="lote-incremental-") as workdir:
        for offset in range(arguments.windows):
            window = _window(first + timedelta(seconds=grain * offset), grain)
            now = datetime.now(UTC)
            published_at = now.replace(microsecond=now.microsecond // 1000 * 1000)
            evidence = publish_window(
                registry=registry,
                window=window,
                variant=arguments.variant,
                rows=arguments.rows,
                workdir=Path(workdir),
                dry_run=arguments.dry_run,
            )
            evidence["publishedAt"] = canonical_utc_text(published_at, "publishedAt")
            evidence["dryRun"] = arguments.dry_run
            evidences.append(evidence)
            print(json.dumps(evidence, ensure_ascii=False), flush=True)
    if arguments.output:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(json.dumps(evidences, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
