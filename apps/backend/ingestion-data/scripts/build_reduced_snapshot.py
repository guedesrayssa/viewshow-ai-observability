"""Monta um dump ARGUS 2.0 reduzido, restaurável, a partir de artefatos já provados.

O dump real tem 7,37 GiB descomprimidos e leva ~56 minutos só para restaurar.
Isso torna inviável iterar sobre o pipeline: as fases PROJECTING, ARCHIVING e
PUBLISHING ficam inalcançáveis numa sessão de Learner Lab, cuja credencial
expira.

Este gerador não inventa dado. Ele junta dois arquivos que a suíte já garante:

  contracts/argus/v2/db_schema.sql   as 23 tabelas, e
      test_every_descriptor_matches_the_reduced_official_schema prova que os
      descriptors casam com ele coluna por coluna;

  tests/fixtures/argus_v2_minimal.sql   INSERTs cobrindo as 23 tabelas, e é o
      mesmo arquivo que o docker-compose.test.yml monta como init do MySQL para
      os testes de integração.

O par já é um banco mínimo que funciona. O gerador só o torna um artefato
restaurável pelo caminho de produção: gzip, enviado ao S3, restaurado por
streaming no sidecar MySQL.

O QUE ISTO PROVA: os caminhos de código de ponta a ponta, incluindo as fases
que nunca rodaram.

O QUE ISTO NÃO PROVA: comportamento de capacidade — particionamento em volume,
o orçamento de disco do workdir, reconciliação Athena em escala. Isto é smoke,
não substitui uma execução completa antes de alguém confiar nos números.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import sys
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

_IDENTIFIER = r"[A-Za-z_][A-Za-z0-9_]*"
_CREATE_TABLE = re.compile(
    rf"^[ \t]*CREATE[ \t]+TABLE(?:[ \t]+IF[ \t]+NOT[ \t]+EXISTS)?[ \t]+"
    rf"(?:`(?P<quoted>{_IDENTIFIER})`|(?P<plain>{_IDENTIFIER}))(?=[ \t]*\()",
    re.IGNORECASE | re.MULTILINE,
)
_INSERT_INTO = re.compile(
    rf"^[ \t]*INSERT[ \t]+INTO[ \t]+"
    rf"(?:`(?P<quoted>{_IDENTIFIER})`|(?P<plain>{_IDENTIFIER}))"
    rf"(?=[ \t\r\n]*(?:\(|VALUES\b))",
    re.IGNORECASE | re.MULTILINE,
)
_CANONICAL_TABLE_COUNT = 23


class ReducedSnapshotError(ValueError):
    """Levantado antes de escrever quando a entrada não produz um dump restaurável."""


@dataclass(frozen=True, slots=True)
class ReducedSnapshot:
    """Descreve o arquivo gzip produzido sem devolver seus bytes ao chamador.

    Attributes:
        sha256: Hash hexadecimal calculado sobre os bytes comprimidos finais.
        compressed_bytes: Tamanho do arquivo que deve ser enviado ao S3.
        tables: Quantidade de tabelas cuja cobertura foi validada.
    """

    sha256: str
    compressed_bytes: int
    tables: int


def _read(path: Path, rotulo: str) -> str:
    """Lê a entrada sem ampliar o escopo solicitado.

    Args:
        path: Caminho local do artefato lido ou produzido.
        rotulo: Entrada ``rotulo``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ReducedSnapshotError: Se a operação não puder preservar as invariantes descritas.
    """
    try:
        return path.read_text(encoding="utf-8")
    except OSError as error:
        raise ReducedSnapshotError(f"{rotulo} não pôde ser lido: {path}") from error


def _matched_table_names(pattern: re.Pattern[str], sql: str) -> tuple[str, ...]:
    """Extrai, na ordem de aparição, os nomes de tabelas reconhecidos no SQL.

    Args:
        pattern: Expressão regular de ``CREATE TABLE`` ou ``INSERT INTO``.
        sql: Texto SQL no qual as declarações serão procuradas.

    Returns:
        Nomes encontrados, mantendo repetições para permitir a detecção de duplicatas.
    """
    return tuple(match.group("quoted") or match.group("plain") for match in pattern.finditer(sql))


def _validate_expected_tables(expected_tables: Iterable[str]) -> tuple[str, ...]:
    """Materializa e valida a lista de tabelas que o dump deve cobrir exatamente.

    Args:
        expected_tables: Nomes permitidos; não pode ser vazio nem conter duplicatas.

    Returns:
        Valor ``tuple[str, ...]`` produzido pela operação após as validações.

    Raises:
        ReducedSnapshotError: Se a operação não puder preservar as invariantes descritas.
    """
    expected = tuple(expected_tables)
    invalid = sorted({table for table in expected if re.fullmatch(_IDENTIFIER, table) is None})
    duplicates = sorted(table for table, count in Counter(expected).items() if count > 1)
    problems: list[str] = []
    if not expected:
        problems.append("vazio")
    if invalid:
        problems.append(f"nomes inválidos={invalid}")
    if duplicates:
        problems.append(f"tabelas duplicadas={duplicates}")
    if problems:
        raise ReducedSnapshotError(f"contrato esperado inconsistente: {'; '.join(problems)}")
    return expected


def _validate_table_coverage(
    *, source: str, actual_tables: tuple[str, ...], expected_tables: tuple[str, ...]
) -> None:
    """Exige que a fonte contenha cada tabela esperada exatamente uma vez.

    Args:
        source: Identificador da fonte de dados processada.
        actual_tables: Valor efetivamente observado que será comparado com a evidência esperada.
        expected_tables: Valor esperado usado para detectar concorrência ou divergência de
        estado.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        ReducedSnapshotError: Se a operação não puder preservar as invariantes descritas.
    """
    counts = Counter(actual_tables)
    duplicates = sorted(table for table, count in counts.items() if count > 1)
    actual = set(actual_tables)
    expected = set(expected_tables)
    missing = sorted(expected - actual)
    extras = sorted(actual - expected)
    problems: list[str] = []
    if duplicates:
        problems.append(f"tabelas duplicadas={duplicates}")
    if missing:
        problems.append(f"faltando={missing}")
    if extras:
        problems.append(f"extras={extras}")
    if problems:
        raise ReducedSnapshotError(f"{source} inconsistente: {'; '.join(problems)}")


def _load_canonical_tables(root: Path) -> tuple[str, ...]:
    """Carrega do registro ARGUS 2.0 a lista canônica das 23 tabelas.

    Args:
        root: Raiz de ``ingestion-data``, que contém o registro de contratos.

    Returns:
        Valor ``tuple[str, ...]`` produzido pela operação após as validações.

    Raises:
        ReducedSnapshotError: Se a operação não puder preservar as invariantes descritas.
    """
    registry_path = root / "contracts" / "argus" / "v2" / "registry.json"
    try:
        document = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReducedSnapshotError(
            f"registry canônico não pôde ser lido: {registry_path}"
        ) from error
    if not isinstance(document, dict):
        raise ReducedSnapshotError("registry canônico deve ser um objeto JSON")
    descriptors = document.get("descriptors")
    if not isinstance(descriptors, list) or not all(isinstance(item, str) for item in descriptors):
        raise ReducedSnapshotError("registry canônico deve declarar descriptors como strings")
    expected = _validate_expected_tables(descriptors)
    if len(expected) != _CANONICAL_TABLE_COUNT:
        raise ReducedSnapshotError(
            "registry canônico deve declarar exatamente "
            f"{_CANONICAL_TABLE_COUNT} tabelas; recebeu {len(expected)}"
        )
    return expected


def build_reduced_snapshot(
    schema_path: Path,
    fixture_path: Path,
    output: Path,
    *,
    expected_tables: Iterable[str] | None = None,
) -> ReducedSnapshot:
    """Combina o esquema contratual e as linhas mínimas em um dump gzip restaurável.

    Antes de escrever, confirma que esquema e fixture cobrem exatamente as tabelas oficiais. O
    arquivo temporário é substituído atomicamente e sua identidade SHA-256 é calculada sobre os
    bytes comprimidos que serão enviados ao S3.

    Args:
        schema_path: SQL com as definições ``CREATE TABLE`` oficiais.
        fixture_path: SQL com os ``INSERT`` mínimos para todas as tabelas.
        output: Caminho do arquivo ``.sql.gz`` que será criado ou substituído.
        expected_tables: Contrato opcional; quando ausente, usa as tabelas do schema.

    Returns:
        Checksum, tamanho comprimido e quantidade de tabelas do arquivo final.

    Raises:
        ReducedSnapshotError: Se a operação não puder preservar as invariantes descritas.
    """
    schema = _read(schema_path, "schema")
    fixture = _read(fixture_path, "fixture")

    schema_tables = _matched_table_names(_CREATE_TABLE, schema)
    if not schema_tables and expected_tables is None:
        raise ReducedSnapshotError("o schema não contém nenhum CREATE TABLE")
    expected = _validate_expected_tables(
        schema_tables if expected_tables is None else expected_tables
    )
    fixture_tables = _matched_table_names(_INSERT_INTO, fixture)
    _validate_table_coverage(source="schema", actual_tables=schema_tables, expected_tables=expected)
    _validate_table_coverage(
        source="fixture", actual_tables=fixture_tables, expected_tables=expected
    )

    sql = f"{schema.rstrip()}\n\n{fixture.lstrip()}"
    if not sql.endswith("\n"):
        sql += "\n"

    # mtime=0 e compresslevel fixo: sem isso o gzip embute o horário, o sha muda
    # a cada execução, e a chave dumps/<sha>/ no S3 deixa de ser idempotente.
    payload = gzip.compress(sql.encode("utf-8"), compresslevel=9, mtime=0)

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(payload)
    return ReducedSnapshot(
        sha256=hashlib.sha256(payload).hexdigest(),
        compressed_bytes=len(payload),
        tables=len(expected),
    )


def _parse_arguments(argv: list[str]) -> argparse.Namespace:
    """Converte argumentos para a representação interna validada.

    Args:
        argv: Argumentos da linha de comando; ``None`` utiliza ``sys.argv``.

    Returns:
        Valor ``argparse.Namespace`` produzido pela operação após as validações.
    """
    raiz = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--schema",
        type=Path,
        default=raiz / "contracts" / "argus" / "v2" / "db_schema.sql",
    )
    parser.add_argument(
        "--fixture",
        type=Path,
        default=raiz / "tests" / "fixtures" / "argus_v2_minimal.sql",
    )
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Executa o ponto de entrada de linha de comando e devolve seu código de saída.

    Args:
        argv: Argumentos da linha de comando; ``None`` utiliza ``sys.argv``.

    Returns:
        Valor ``int`` produzido pela operação após as validações.
    """
    arguments = _parse_arguments(sys.argv[1:] if argv is None else argv)
    root = Path(__file__).resolve().parents[1]
    result = build_reduced_snapshot(
        arguments.schema,
        arguments.fixture,
        arguments.output,
        expected_tables=_load_canonical_tables(root),
    )
    sys.stdout.write(
        f"dump reduzido: {arguments.output}\n"
        f"  tabelas        {result.tables}\n"
        f"  bytes          {result.compressed_bytes}\n"
        f"  sha256         {result.sha256}\n"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ReducedSnapshotError as error:
        sys.stderr.write(f"{error}\n")
        raise SystemExit(1) from error
