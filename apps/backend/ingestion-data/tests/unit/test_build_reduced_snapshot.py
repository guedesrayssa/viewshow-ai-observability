"""Verify reduced MySQL snapshots are built with deterministic safe contents."""

from __future__ import annotations

from pathlib import Path

import pytest

from scripts.build_reduced_snapshot import (
    ReducedSnapshotError,
    build_reduced_snapshot,
    main,
)


def _write_sql(path: Path, statements: tuple[str, ...]) -> Path:
    path.write_text("\n".join(statements) + "\n", encoding="utf-8")
    return path


def _schema(path: Path, tables: tuple[str, ...]) -> Path:
    return _write_sql(
        path,
        tuple(f"CREATE TABLE {table} (id BIGINT NOT NULL);" for table in tables),
    )


def _fixture(path: Path, tables: tuple[str, ...]) -> Path:
    return _write_sql(
        path,
        tuple(f"INSERT INTO {table} (id) VALUES (1);" for table in tables),
    )


@pytest.mark.parametrize(
    ("schema_tables", "fixture_tables", "expected_message"),
    (
        (("alpha",), ("alpha", "beta"), "schema.*faltando.*beta"),
        (("alpha", "gamma"), ("alpha", "beta"), "schema.*faltando.*beta.*extras.*gamma"),
        (("alpha", "alpha", "beta"), ("alpha", "beta"), "schema.*duplicadas.*alpha"),
        (("alpha", "beta"), ("alpha",), "fixture.*faltando.*beta"),
        (("alpha", "beta"), ("alpha", "gamma"), "fixture.*faltando.*beta.*extras.*gamma"),
        (("alpha", "beta"), ("alpha", "alpha", "beta"), "fixture.*duplicadas.*alpha"),
    ),
)
def test_reduced_snapshot_rejects_table_sets_that_differ_from_the_expected_contract(
    tmp_path: Path,
    schema_tables: tuple[str, ...],
    fixture_tables: tuple[str, ...],
    expected_message: str,
) -> None:
    schema = _schema(tmp_path / "schema.sql", schema_tables)
    fixture = _fixture(tmp_path / "fixture.sql", fixture_tables)
    output = tmp_path / "reduced.sql.gz"

    with pytest.raises(ReducedSnapshotError, match=expected_message):
        build_reduced_snapshot(
            schema,
            fixture,
            output,
            expected_tables=("alpha", "beta"),
        )

    assert not output.exists()


def test_reduced_snapshot_rejects_an_inconsistent_expected_contract(tmp_path: Path) -> None:
    schema = _schema(tmp_path / "schema.sql", ("alpha",))
    fixture = _fixture(tmp_path / "fixture.sql", ("alpha",))

    with pytest.raises(ReducedSnapshotError, match="contrato esperado.*duplicadas.*alpha"):
        build_reduced_snapshot(
            schema,
            fixture,
            tmp_path / "reduced.sql.gz",
            expected_tables=("alpha", "alpha"),
        )


def test_cli_rejects_custom_inputs_that_do_not_cover_the_canonical_registry(
    tmp_path: Path,
) -> None:
    schema = _schema(tmp_path / "schema.sql", ("alpha",))
    fixture = _fixture(tmp_path / "fixture.sql", ("alpha",))
    output = tmp_path / "reduced.sql.gz"

    with pytest.raises(ReducedSnapshotError, match="schema.*faltando"):
        main(
            [
                "--schema",
                str(schema),
                "--fixture",
                str(fixture),
                "--output",
                str(output),
            ]
        )

    assert not output.exists()


def test_reduced_snapshot_accepts_each_expected_table_exactly_once(tmp_path: Path) -> None:
    expected = ("alpha", "beta")
    schema = _schema(tmp_path / "schema.sql", expected)
    fixture = _fixture(tmp_path / "fixture.sql", expected)

    result = build_reduced_snapshot(
        schema,
        fixture,
        tmp_path / "reduced.sql.gz",
        expected_tables=expected,
    )

    assert result.tables == 2


def test_reduced_snapshot_accepts_a_multiline_insert_column_list(tmp_path: Path) -> None:
    schema = _schema(tmp_path / "schema.sql", ("alpha",))
    fixture = _write_sql(
        tmp_path / "fixture.sql",
        ("INSERT INTO alpha\n    (id) VALUES (1);",),
    )

    result = build_reduced_snapshot(
        schema,
        fixture,
        tmp_path / "reduced.sql.gz",
        expected_tables=("alpha",),
    )

    assert result.tables == 1
