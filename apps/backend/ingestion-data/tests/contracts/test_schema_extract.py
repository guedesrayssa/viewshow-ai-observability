"""Behavioral tests for the reduced ARGUS schema extractor."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

SAMPLE_SCHEMA = """
-- unrelated table must never leak to the reduced schema
CREATE TABLE ignored_table (
    id BIGINT NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE second_table (
    run_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    kind ENUM('live','vod') NOT NULL,
    note VARCHAR(40)
) ENGINE=InnoDB;

INSERT INTO second_table VALUES (1, 'live', 'private payload');

CREATE TABLE first_table (
    ts BIGINT NOT NULL,
    source VARCHAR(64) NOT NULL,
    value DOUBLE,
    PRIMARY KEY (ts, source)
) ENGINE=InnoDB
  PARTITION BY RANGE (ts) (PARTITION p_init VALUES LESS THAN (0));
"""


def test_parser_exposes_physical_columns_types_nullability_and_primary_keys() -> None:
    """Dropping type, nullability, or PK metadata would permit invented descriptors."""
    from scripts.extract_argus_schema import parse_create_tables

    tables = parse_create_tables(SAMPLE_SCHEMA)

    assert tuple(column.as_contract() for column in tables["second_table"].columns) == (
        ("run_id", "BIGINT", False),
        ("kind", "ENUM('live','vod')", False),
        ("note", "VARCHAR(40)", True),
    )
    assert tables["second_table"].primary_key == ("run_id",)
    assert tuple(column.as_contract() for column in tables["first_table"].columns) == (
        ("ts", "BIGINT", False),
        ("source", "VARCHAR(64)", False),
        ("value", "DOUBLE", True),
    )
    assert tables["first_table"].primary_key == ("ts", "source")


def test_primary_key_is_non_nullable_even_without_explicit_not_null() -> None:
    from scripts.extract_argus_schema import parse_create_tables

    table = parse_create_tables("CREATE TABLE t (id BIGINT, PRIMARY KEY (id));")["t"]

    assert table.columns[0].nullable is False


@pytest.mark.parametrize(
    "constraint",
    ("COMMENT 'PRIMARY KEY'", "DEFAULT 'PRIMARY KEY'"),
)
def test_constraint_string_cannot_invent_an_inline_primary_key(constraint: str) -> None:
    """Quoted COMMENT/DEFAULT payloads are data, not SQL constraint tokens."""
    from scripts.extract_argus_schema import SchemaExtractionError, parse_create_tables

    ddl = f"CREATE TABLE t (id VARCHAR(32) {constraint});"

    with pytest.raises(SchemaExtractionError, match="has no PRIMARY KEY"):
        parse_create_tables(ddl)


def test_parser_accepts_a_quoted_named_primary_key_constraint() -> None:
    """MySQL's CONSTRAINT name PRIMARY KEY form is part of valid physical DDL."""
    from scripts.extract_argus_schema import parse_create_tables

    ddl = """
    CREATE TABLE t (
        id BIGINT NOT NULL,
        CONSTRAINT `pk_t` PRIMARY KEY (`id`)
    );
    """

    assert parse_create_tables(ddl)["t"].primary_key == ("id",)


@pytest.mark.parametrize(
    "definitions",
    (
        "id BIGINT PRIMARY KEY, CONSTRAINT `pk_t` PRIMARY KEY (`id`)",
        "id BIGINT, CONSTRAINT `pk_a` PRIMARY KEY (`id`), CONSTRAINT `pk_b` PRIMARY KEY (`id`)",
    ),
)
def test_parser_rejects_mixed_or_repeated_primary_key_declarations(definitions: str) -> None:
    """Multiple PK syntaxes cannot compete to define the ingestion identity."""
    from scripts.extract_argus_schema import SchemaExtractionError, parse_create_tables

    with pytest.raises(SchemaExtractionError, match="PRIMARY KEY"):
        parse_create_tables(f"CREATE TABLE t ({definitions});")


def test_parser_rejects_more_than_one_inline_primary_key() -> None:
    """Separate inline PK declarations cannot be invented into a composite identity."""
    from scripts.extract_argus_schema import SchemaExtractionError, parse_create_tables

    ddl = "CREATE TABLE t (a BIGINT PRIMARY KEY, b BIGINT PRIMARY KEY);"

    with pytest.raises(SchemaExtractionError, match="inline PRIMARY KEY more than once"):
        parse_create_tables(ddl)


def test_extractor_keeps_source_order_and_only_complete_requested_ddl() -> None:
    """Selection must not copy INSERTs, unrelated tables, or caller ordering."""
    from scripts.extract_argus_schema import extract_create_tables, parse_create_tables

    reduced = extract_create_tables(SAMPLE_SCHEMA, ("first_table", "second_table"))

    assert tuple(parse_create_tables(reduced)) == ("second_table", "first_table")
    assert "ignored_table" not in reduced
    assert "INSERT INTO" not in reduced
    assert "private payload" not in reduced
    assert reduced.count("CREATE TABLE") == 2
    assert reduced.count(";") == 2


@pytest.mark.parametrize(
    ("schema", "requested", "message"),
    (
        (SAMPLE_SCHEMA, ("missing_table",), "missing requested table"),
        (
            SAMPLE_SCHEMA + "\nCREATE TABLE first_table (id BIGINT PRIMARY KEY);\n",
            ("first_table",),
            "appears more than once",
        ),
        (SAMPLE_SCHEMA, ("first_table", "first_table"), "requested more than once"),
    ),
)
def test_extractor_fails_closed_for_missing_or_duplicate_tables(
    schema: str,
    requested: tuple[str, ...],
    message: str,
) -> None:
    """Ambiguous source DDL must stop contract generation rather than guess."""
    from scripts.extract_argus_schema import SchemaExtractionError, extract_create_tables

    with pytest.raises(SchemaExtractionError, match=message):
        extract_create_tables(schema, requested)


def test_cli_reads_stdin_and_writes_the_requested_output(tmp_path: Path) -> None:
    """The generation command must work as a pipe from the read-only package."""
    script = Path(__file__).parents[2] / "scripts" / "extract_argus_schema.py"
    output = tmp_path / "db_schema.sql"

    completed = subprocess.run(
        [
            sys.executable,
            str(script),
            "--tables",
            "first_table",
            "second_table",
            "--output",
            str(output),
        ],
        input=SAMPLE_SCHEMA,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    reduced = output.read_text(encoding="utf-8")
    assert reduced.index("second_table") < reduced.index("first_table")
    assert "ignored_table" not in reduced
    assert "private payload" not in reduced
