"""Extrai de um dump somente as definições SQL das tabelas permitidas.

Papel no fluxo:
    Este arquivo é uma ferramenta operacional executada fora do worker principal e valida todas
    as entradas antes de produzir efeitos externos.

Garantias e limites:
    A saída contém somente evidências não sensíveis que podem ser preservadas para auditoria ou
    consumidas pela etapa operacional seguinte.
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import NamedTuple

_CREATE_TABLE = re.compile(
    r"^[ \t]*CREATE[ \t]+TABLE(?:[ \t]+IF[ \t]+NOT[ \t]+EXISTS)?"
    r"[ \t]+`?(?P<name>[A-Za-z_][A-Za-z0-9_]*)`?[ \t]*\(",
    re.IGNORECASE | re.MULTILINE,
)
_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_NAMED_PRIMARY_KEY = re.compile(
    r"^CONSTRAINT\s+(?:`(?:``|[^`])+`|[A-Za-z_][A-Za-z0-9_]*)\s+PRIMARY\s+KEY\b",
    re.IGNORECASE,
)
_CONSTRAINT_PREFIXES = (
    "NOT ",
    "NULL",
    "DEFAULT",
    "AUTO_INCREMENT",
    "PRIMARY ",
    "UNIQUE ",
    "COMMENT ",
    "COLLATE ",
    "REFERENCES ",
    "CHECK ",
    "GENERATED ",
)


class SchemaExtractionError(ValueError):
    """Indica que ``SchemaExtractionError`` impediu a operação de continuar com segurança."""


class ColumnDefinition(NamedTuple):
    """Representa ``ColumnDefinition`` como um valor posicional imutável.

    Os campos formam parte do contrato e mantêm ordem estável durante comparações.

    Attributes:
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        sql_type: Entrada ``sql_type``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        nullable: Entrada ``nullable``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
    """

    name: str
    sql_type: str
    nullable: bool

    def as_contract(self) -> tuple[str, str, bool]:
        """Representa a instância como contrato.

        Returns:
            Valor ``tuple[str, str, bool]`` produzido pela operação após as validações.
        """
        return (self.name, self.sql_type, self.nullable)


class TableDefinition(NamedTuple):
    """Representa ``TableDefinition`` como um valor posicional imutável.

    Os campos formam parte do contrato e mantêm ordem estável durante comparações.

    Attributes:
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        columns: Entrada ``columns``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        primary_key: Chave usada para identificar, consultar ou persistir o recurso.
        ddl: Entrada ``ddl``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
    """

    name: str
    columns: tuple[ColumnDefinition, ...]
    primary_key: tuple[str, ...]
    ddl: str


def _statement_end(sql: str, start: int) -> int:
    """Executa a etapa interna ``statement_end`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        sql: Entrada ``sql``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        start: Entrada ``start``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``int`` produzido pela operação após as validações.

    Raises:
        SchemaExtractionError: Se a operação não puder preservar as invariantes descritas.
    """
    quote: str | None = None
    line_comment = False
    block_comment = False
    index = start
    while index < len(sql):
        char = sql[index]
        following = sql[index + 1] if index + 1 < len(sql) else ""
        if line_comment:
            if char in "\r\n":
                line_comment = False
        elif block_comment:
            if char == "*" and following == "/":
                block_comment = False
                index += 1
        elif quote is not None:
            if char == "\\":
                index += 1
            elif char == quote:
                if following == quote:
                    index += 1
                else:
                    quote = None
        elif char in "'\"`":
            quote = char
        elif char == "-" and following == "-":
            line_comment = True
            index += 1
        elif char == "/" and following == "*":
            block_comment = True
            index += 1
        elif char == ";":
            return index + 1
        index += 1
    raise SchemaExtractionError("unterminated CREATE TABLE statement")


def _scan_statements(sql: str) -> list[tuple[str, str]]:
    """Percorre statements reconhecendo somente estruturas completas.

    Args:
        sql: Entrada ``sql``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``list[tuple[str, str]]`` produzido pela operação após as validações.
    """
    statements: list[tuple[str, str]] = []
    for match in _CREATE_TABLE.finditer(sql):
        end = _statement_end(sql, match.start())
        statements.append((match.group("name"), sql[match.start() : end].strip()))
    return statements


def _strip_comments(sql: str) -> str:
    """Remove comments sem alterar o conteúdo significativo.

    Args:
        sql: Entrada ``sql``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    result: list[str] = []
    quote: str | None = None
    line_comment = False
    block_comment = False
    index = 0
    while index < len(sql):
        char = sql[index]
        following = sql[index + 1] if index + 1 < len(sql) else ""
        if line_comment:
            if char in "\r\n":
                line_comment = False
                result.append(char)
        elif block_comment:
            if char == "*" and following == "/":
                block_comment = False
                index += 1
        elif quote is not None:
            result.append(char)
            if char == "\\":
                if following:
                    result.append(following)
                    index += 1
            elif char == quote:
                if following == quote:
                    result.append(following)
                    index += 1
                else:
                    quote = None
        elif char in "'\"`":
            quote = char
            result.append(char)
        elif char == "-" and following == "-":
            line_comment = True
            index += 1
        elif char == "/" and following == "*":
            block_comment = True
            index += 1
        else:
            result.append(char)
        index += 1
    return "".join(result)


def _definition_body(statement: str) -> str:
    """Executa a etapa interna ``definition_body`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        statement: Entrada ``statement``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        SchemaExtractionError: Se a operação não puder preservar as invariantes descritas.
    """
    opening = statement.find("(")
    if opening < 0:
        raise SchemaExtractionError("CREATE TABLE has no definition body")
    depth = 0
    quote: str | None = None
    for index in range(opening, len(statement)):
        char = statement[index]
        previous = statement[index - 1] if index > 0 else ""
        if quote is not None:
            if char == quote and previous != "\\":
                quote = None
            continue
        if char in "'\"`":
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return statement[opening + 1 : index]
    raise SchemaExtractionError("unbalanced CREATE TABLE definition")


def _split_definitions(body: str) -> tuple[str, ...]:
    """Divide definitions respeitando delimitadores e estruturas aninhadas.

    Args:
        body: Entrada ``body``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``tuple[str, ...]`` produzido pela operação após as validações.
    """
    cleaned = _strip_comments(body)
    parts: list[str] = []
    start = 0
    depth = 0
    quote: str | None = None
    index = 0
    while index < len(cleaned):
        char = cleaned[index]
        following = cleaned[index + 1] if index + 1 < len(cleaned) else ""
        if quote is not None:
            if char == "\\":
                index += 1
            elif char == quote:
                if following == quote:
                    index += 1
                else:
                    quote = None
        elif char in "'\"`":
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif char == "," and depth == 0:
            if part := cleaned[start:index].strip():
                parts.append(part)
            start = index + 1
        index += 1
    if part := cleaned[start:].strip():
        parts.append(part)
    return tuple(parts)


def _type_and_constraints(definition: str) -> tuple[str, str]:
    """Executa a etapa interna ``type_and_constraints`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        definition: Entrada ``definition``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``tuple[str, str]`` produzido pela operação após as validações.

    Raises:
        SchemaExtractionError: Se a operação não puder preservar as invariantes descritas.
    """
    match = re.match(r"`?[A-Za-z_][A-Za-z0-9_]*`?\s+(?P<tail>.+)", definition, re.DOTALL)
    if match is None:
        raise SchemaExtractionError(f"invalid column definition: {definition!r}")
    tail = match.group("tail").strip()
    depth = 0
    quote: str | None = None
    index = 0
    while index < len(tail):
        char = tail[index]
        following = tail[index + 1] if index + 1 < len(tail) else ""
        if quote is not None:
            if char == "\\":
                index += 1
            elif char == quote:
                if following == quote:
                    index += 1
                else:
                    quote = None
        elif char in "'\"`":
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif char.isspace() and depth == 0:
            remainder = tail[index:].lstrip()
            if remainder.upper().startswith(_CONSTRAINT_PREFIXES):
                return " ".join(tail[:index].split()), remainder
        index += 1
    return " ".join(tail.split()), ""


def _identifier_list(definition: str) -> tuple[str, ...]:
    """Executa a etapa interna ``identifier_list`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        definition: Entrada ``definition``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``tuple[str, ...]`` produzido pela operação após as validações.

    Raises:
        SchemaExtractionError: Se a operação não puder preservar as invariantes descritas.
    """
    match = re.search(r"\((?P<columns>[^)]*)\)", definition, re.DOTALL)
    if match is None:
        raise SchemaExtractionError(f"PRIMARY KEY has no column list: {definition!r}")
    columns = tuple(
        token.strip().strip("`").split("(", maxsplit=1)[0]
        for token in match.group("columns").split(",")
    )
    if not columns or any(not _IDENTIFIER.fullmatch(column) for column in columns):
        raise SchemaExtractionError(f"invalid PRIMARY KEY column list: {definition!r}")
    return columns


def _constraint_tokens(constraints: str) -> tuple[str, ...]:
    """Executa a etapa interna ``constraint_tokens`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        constraints: Entrada ``constraints``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``tuple[str, ...]`` produzido pela operação após as validações.
    """
    tokens: list[str] = []
    current: list[str] = []
    quote: str | None = None
    index = 0
    while index < len(constraints):
        char = constraints[index]
        following = constraints[index + 1] if index + 1 < len(constraints) else ""
        if quote is not None:
            if char == "\\":
                index += 1
            elif char == quote:
                if following == quote:
                    index += 1
                else:
                    quote = None
        elif char in "'\"`":
            if current:
                tokens.append("".join(current).upper())
                current.clear()
            quote = char
        elif char.isalnum() or char == "_":
            current.append(char)
        elif current:
            tokens.append("".join(current).upper())
            current.clear()
        index += 1
    if current:
        tokens.append("".join(current).upper())
    return tuple(tokens)


def _has_inline_primary_key(constraints: str) -> bool:
    """Informa se existe inline primary chave nas evidências disponíveis.

    Args:
        constraints: Entrada ``constraints``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.
    """
    tokens = _constraint_tokens(constraints)
    return any(
        first == "PRIMARY" and second == "KEY"
        for first, second in zip(tokens, tokens[1:], strict=False)
    )


def _is_explicitly_not_null(constraints: str) -> bool:
    """Informa se explicitly not null satisfaz a condição esperada.

    Args:
        constraints: Entrada ``constraints``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.
    """
    tokens = _constraint_tokens(constraints)
    return any(
        first == "NOT" and second == "NULL"
        for first, second in zip(tokens, tokens[1:], strict=False)
    )


def _parse_table(name: str, statement: str) -> TableDefinition:
    """Converte tabela para a representação interna validada.

    Args:
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        statement: Entrada ``statement``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``TableDefinition`` produzido pela operação após as validações.

    Raises:
        SchemaExtractionError: Se a operação não puder preservar as invariantes descritas.
    """
    columns: list[ColumnDefinition] = []
    table_primary_key: tuple[str, ...] | None = None
    inline_primary_keys: list[str] = []
    for definition in _split_definitions(_definition_body(statement)):
        normalized = definition.lstrip().upper()
        if normalized.startswith("PRIMARY KEY"):
            if table_primary_key is not None:
                raise SchemaExtractionError(f"table {name!r} declares PRIMARY KEY twice")
            table_primary_key = _identifier_list(definition)
            continue
        if _NAMED_PRIMARY_KEY.match(definition):
            if table_primary_key is not None:
                raise SchemaExtractionError(f"table {name!r} declares PRIMARY KEY twice")
            table_primary_key = _identifier_list(definition)
            continue
        if normalized.startswith(
            ("KEY ", "INDEX ", "UNIQUE ", "CONSTRAINT ", "FOREIGN ", "CHECK ")
        ):
            continue
        name_match = re.match(r"`?(?P<name>[A-Za-z_][A-Za-z0-9_]*)`?\s+", definition)
        if name_match is None:
            raise SchemaExtractionError(f"unrecognized definition in {name!r}: {definition!r}")
        column_name = name_match.group("name")
        sql_type, constraints = _type_and_constraints(definition)
        columns.append(
            ColumnDefinition(
                name=column_name,
                sql_type=sql_type,
                nullable=not _is_explicitly_not_null(constraints),
            )
        )
        if _has_inline_primary_key(constraints):
            if inline_primary_keys:
                raise SchemaExtractionError(
                    f"table {name!r} declares inline PRIMARY KEY more than once"
                )
            inline_primary_keys.append(column_name)
    if table_primary_key is not None and inline_primary_keys:
        raise SchemaExtractionError(f"table {name!r} mixes inline and table PRIMARY KEY")
    primary_key = table_primary_key or tuple(inline_primary_keys)
    if not columns:
        raise SchemaExtractionError(f"table {name!r} has no columns")
    if not primary_key:
        raise SchemaExtractionError(f"table {name!r} has no PRIMARY KEY")
    column_names = {column.name for column in columns}
    if any(key not in column_names for key in primary_key):
        raise SchemaExtractionError(f"table {name!r} PRIMARY KEY references an unknown column")
    columns = [
        ColumnDefinition(column.name, column.sql_type, False)
        if column.name in primary_key
        else column
        for column in columns
    ]
    return TableDefinition(name, tuple(columns), primary_key, statement)


def parse_create_tables(sql: str) -> dict[str, TableDefinition]:
    """Converte criação tabelas para a representação interna validada.

    Args:
        sql: Entrada ``sql``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``dict[str, TableDefinition]`` produzido pela operação após as validações.

    Raises:
        SchemaExtractionError: Se a operação não puder preservar as invariantes descritas.
    """
    statements = _scan_statements(sql)
    counts = Counter(name for name, _ in statements)
    if duplicates := sorted(name for name, count in counts.items() if count > 1):
        raise SchemaExtractionError(f"table {duplicates[0]!r} appears more than once")
    return {name: _parse_table(name, statement) for name, statement in statements}


def extract_create_tables(sql: str, tables: Iterable[str]) -> str:
    """Extrai criação tabelas depois de validar a estrutura de origem.

    Args:
        sql: Entrada ``sql``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        tables: Entrada ``tables``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        SchemaExtractionError: Se a operação não puder preservar as invariantes descritas.
    """
    requested = tuple(tables)
    invalid = next((name for name in requested if not _IDENTIFIER.fullmatch(name)), None)
    if invalid is not None:
        raise SchemaExtractionError(f"invalid requested table name: {invalid!r}")
    counts = Counter(requested)
    if duplicate := next((name for name, count in counts.items() if count > 1), None):
        raise SchemaExtractionError(f"table {duplicate!r} requested more than once")
    definitions = parse_create_tables(sql)
    if missing := sorted(set(requested) - definitions.keys()):
        raise SchemaExtractionError(f"missing requested table: {missing[0]!r}")
    requested_set = set(requested)
    selected = [table.ddl for table in definitions.values() if table.name in requested_set]
    return "\n\n".join(selected) + "\n"


def build_parser() -> argparse.ArgumentParser:
    """Constrói parser a partir das entradas validadas.

    Returns:
        Valor ``argparse.ArgumentParser`` produzido pela operação após as validações.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tables", nargs="+", required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Executa o ponto de entrada de linha de comando e devolve seu código de saída.

    Args:
        argv: Argumentos da linha de comando; ``None`` utiliza ``sys.argv``.

    Returns:
        Valor ``int`` produzido pela operação após as validações.
    """
    parser = build_parser()
    arguments = parser.parse_args(argv)
    try:
        reduced = extract_create_tables(sys.stdin.read(), arguments.tables)
    except SchemaExtractionError as error:
        parser.error(str(error))
    arguments.output.write_text(reduced, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
