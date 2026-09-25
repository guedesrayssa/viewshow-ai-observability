"""Lê tabelas ARGUS do MySQL com projeções permitidas e paginação por chave.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import cast

import pymysql
from pymysql.connections import Connection
from pymysql.cursors import SSDictCursor

from contracts.argus.v2.normalizers import NormalizationContext
from contracts.registry import DatasetRegistry
from domain.canonical_json import canonical_bytes
from domain.datasets import DatasetColumn, DatasetDescriptor
from domain.incremental_batches import PhysicalColumn
from domain.models import TimeWindow
from domain.quality import BOT_RELIABLE_FROM_SQL, CoverageStatus, discover_bot_coverage
from ports import CoverageObservation, Cursor, SchemaObservation, SourcePage, SourceReader

MAX_PAGE_SIZE = 10_000
_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_INTEGER_TYPES = frozenset({"BIGINT", "INT", "TINYINT"})
_TEXT_TYPES = re.compile(r"^(?:VARCHAR\([1-9][0-9]*\)|TEXT|ENUM\(.*\))$")
_ISO_TYPES = re.compile(r"^VARCHAR\([1-9][0-9]*\)$")
_CANONICAL_BUCKET_DATASETS = frozenset({"signal_bucket", "live_active_15min", "live_qoe_hourly"})
_COLUMNS_SQL = """SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, ORDINAL_POSITION
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s
ORDER BY ORDINAL_POSITION"""
type ConnectionFactory = Callable[[], Connection]
type QueryParameters = tuple[object, ...]


@dataclass(frozen=True, slots=True)
class MySqlConnectionSettings:
    """Representa os dados de ``MySqlConnectionSettings`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        host: Entrada ``host``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        port: Entrada ``port``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        user: Entrada ``user``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        password: Entrada ``password``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        database: Entrada ``database``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        connect_timeout_seconds: Duração ou prazo expresso em segundos.
    """

    host: str
    port: int
    user: str
    password: str = field(repr=False)
    database: str
    connect_timeout_seconds: int = 10
    read_timeout_seconds: int = 30
    write_timeout_seconds: int = 30
    ddl_timeout_seconds: int = 1_800
    query_max_attempts: int = 1
    query_retry_base_ms: int = 250
    query_retry_max_ms: int = 4_000

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        for field_name in ("host", "user", "password", "database"):
            value = getattr(self, field_name)
            if not isinstance(value, str):
                raise TypeError(f"{field_name} must be a string")
            if not value:
                raise ValueError(f"{field_name} must not be empty")
        _require_positive_int(self.port, "port", maximum=65_535)
        _require_positive_int(self.connect_timeout_seconds, "connect_timeout_seconds")
        _require_positive_int(self.read_timeout_seconds, "read_timeout_seconds", maximum=3_600)
        _require_positive_int(self.write_timeout_seconds, "write_timeout_seconds", maximum=3_600)
        _require_positive_int(self.ddl_timeout_seconds, "ddl_timeout_seconds", maximum=7_200)
        _require_positive_int(self.query_max_attempts, "query_max_attempts", maximum=8)
        _require_positive_int(self.query_retry_base_ms, "query_retry_base_ms")
        _require_positive_int(self.query_retry_max_ms, "query_retry_max_ms")
        if self.query_retry_base_ms > self.query_retry_max_ms:
            raise ValueError("query_retry_base_ms must not exceed query_retry_max_ms")


def _require_positive_int(value: object, field: str, *, maximum: int | None = None) -> int:
    """Valida e devolve positivo inteiro, rejeitando entradas fora do contrato.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.
        maximum: Entrada ``maximum``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``int`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field} must be an integer")
    if value <= 0 or (maximum is not None and value > maximum):
        suffix = f" between 1 and {maximum}" if maximum is not None else " positive"
        raise ValueError(f"{field} must be{suffix}")
    return value


def quote_identifier(identifier: str) -> str:
    """Escapa identifier para uso seguro no formato de destino.

    Args:
        identifier: Entrada ``identifier``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(identifier, str) or _IDENTIFIER.fullmatch(identifier) is None:
        raise ValueError("identifier is not a valid allowlisted SQL identifier")
    return f"`{identifier}`"


def _column_by_name(descriptor: DatasetDescriptor, name: str) -> DatasetColumn:
    """Executa a etapa interna ``column_by_name`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``DatasetColumn`` produzido pela operação após as validações.
    """
    return next(column for column in descriptor.columns if column.name == name)


def _validate_cursor_value(column: DatasetColumn, value: object) -> None:
    """Valida cursor valor contra as invariantes deste módulo.

    Args:
        column: Entrada ``column``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    if value is None:
        raise TypeError(f"cursor field {column.name} cannot be null")
    if column.sql_type in _INTEGER_TYPES:
        if isinstance(value, bool) or not isinstance(value, int):
            raise TypeError(f"cursor field {column.name} must be an integer")
        return
    if column.sql_type == "DOUBLE":
        if isinstance(value, bool) or not isinstance(value, int | float | Decimal):
            raise TypeError(f"cursor field {column.name} must be numeric")
        return
    if _TEXT_TYPES.fullmatch(column.sql_type):
        if not isinstance(value, str):
            raise TypeError(f"cursor field {column.name} must be a string")
        return
    raise TypeError(f"cursor field {column.name} has unsupported type {column.sql_type}")


def _window_parameters(descriptor: DatasetDescriptor, window: TimeWindow) -> tuple[object, object]:
    """Executa a etapa interna ``window_parameters`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        window: Janela temporal UTC, fechada no início e aberta no fim.

    Returns:
        Valor ``tuple[object, object]`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    if descriptor.archive_partition.get("strategy") == "snapshot_date":
        raise ValueError(f"snapshot dataset {descriptor.table!r} does not accept a time window")
    if descriptor.timestamp_field is None:
        raise ValueError(f"dataset {descriptor.table!r} does not declare a timestamp field")
    column = _column_by_name(descriptor, descriptor.timestamp_field)
    if column.sql_type in _INTEGER_TYPES:
        return int(window.start.timestamp() * 1000), int(window.end.timestamp() * 1000)
    if _ISO_TYPES.fullmatch(column.sql_type):
        return _mysql_datetime(window.start), _mysql_datetime(window.end)
    raise TypeError(
        f"timestamp field {descriptor.timestamp_field!r} has unsupported type {column.sql_type}"
    )


def _mysql_datetime(value: datetime) -> str:
    """Executa a etapa interna ``mysql_datetime`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return value.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def _timestamp_expression(descriptor: DatasetDescriptor) -> str:
    """Executa a etapa interna ``timestamp_expression`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    timestamp_field = cast(str, descriptor.timestamp_field)
    quoted = quote_identifier(timestamp_field)
    column = _column_by_name(descriptor, timestamp_field)
    if _ISO_TYPES.fullmatch(column.sql_type):
        return f"CAST({quoted} AS DATETIME(3))"
    return quoted


def build_page_query(
    descriptor: DatasetDescriptor,
    window: TimeWindow | None,
    after: Cursor | None,
    limit: int,
    *,
    selected_columns: tuple[str, ...] | None = None,
    forced_index: str | None = None,
) -> tuple[str, QueryParameters]:
    """Constrói página consulta a partir das entradas validadas.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        window: Janela temporal UTC, fechada no início e aberta no fim.
        after: Cursor da última linha consumida; ``None`` inicia a paginação.
        limit: Quantidade máxima de itens que a operação pode processar.

    Returns:
        Valor ``tuple[str, QueryParameters]`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    _require_positive_int(limit, "limit", maximum=MAX_PAGE_SIZE)
    selected = (
        tuple(column.name for column in descriptor.columns)
        if selected_columns is None
        else selected_columns
    )
    if not selected:
        raise ValueError("selected_columns must not be empty")
    columns = ", ".join(quote_identifier(column) for column in selected)
    table = quote_identifier(descriptor.table)
    index_hint = (
        "" if forced_index is None else f" FORCE INDEX ({quote_identifier(forced_index)})"
    )
    predicates: list[str] = []
    parameters: list[object] = []

    if window is not None:
        if not isinstance(window, TimeWindow):
            raise TypeError("window must be a TimeWindow or None")
        start, end = _window_parameters(descriptor, window)
        timestamp = _timestamp_expression(descriptor)
        predicates.append(f"{timestamp} >= %s AND {timestamp} < %s")
        parameters.extend((start, end))

    cursor_columns = tuple(_column_by_name(descriptor, field) for field in descriptor.cursor_key)
    if after is not None:
        if not isinstance(after, tuple):
            raise TypeError("cursor must be a tuple or None")
        if len(after) != len(cursor_columns):
            raise ValueError("cursor shape differs from descriptor cursor_key")
        for column, value in zip(cursor_columns, after, strict=True):
            _validate_cursor_value(column, value)
        lexicographic_terms: list[str] = []
        for position, column in enumerate(cursor_columns):
            equalities = " AND ".join(
                f"{quote_identifier(previous.name)} = %s"
                for previous in cursor_columns[:position]
            )
            greater = f"{quote_identifier(column.name)} > %s"
            lexicographic_terms.append(
                f"({equalities} AND {greater})" if equalities else greater
            )
            parameters.extend(after[: position + 1])
        predicates.append(f"({' OR '.join(lexicographic_terms)})")

    where = f" WHERE {' AND '.join(predicates)}" if predicates else ""
    order = ", ".join(quote_identifier(column.name) for column in cursor_columns)
    sql = f"SELECT {columns} FROM {table}{index_hint}{where} ORDER BY {order} LIMIT %s"
    parameters.append(limit)
    return sql, tuple(parameters)


def _normalize_mysql_type(value: object) -> str:
    """Normaliza mysql type para o modelo canônico da ingestão.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, str) or not value:
        raise ValueError("INFORMATION_SCHEMA returned an invalid COLUMN_TYPE")
    match = re.match(r"^(bigint|int|tinyint|double|varchar|text|enum)(.*)$", value, re.IGNORECASE)
    if match is None:
        return value.upper()
    return match.group(1).upper() + match.group(2)


def _physical_column(row: Mapping[str, object]) -> PhysicalColumn:
    """Converte uma linha de INFORMATION_SCHEMA em uma coluna física observada."""
    nullable = _require_schema_string(row, "IS_NULLABLE")
    if nullable not in {"YES", "NO"}:
        raise ValueError("INFORMATION_SCHEMA returned invalid IS_NULLABLE")
    return PhysicalColumn(
        _require_schema_string(row, "COLUMN_NAME"),
        _normalize_mysql_type(row.get("COLUMN_TYPE")),
        nullable == "YES",
        _require_schema_int(row, "ORDINAL_POSITION"),
    )


def _parse_coverage_timestamp(column: DatasetColumn, value: object) -> datetime:
    """Converte cobertura timestamp para a representação interna validada.

    Args:
        column: Entrada ``column``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``datetime`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    if column.sql_type in _INTEGER_TYPES:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f"coverage field {column.name} must be an epoch-millisecond integer")
        return datetime.fromtimestamp(value / 1000, UTC)
    if _ISO_TYPES.fullmatch(column.sql_type):
        if isinstance(value, datetime):
            if value.tzinfo is not None:
                return value.astimezone(UTC)
            return value.replace(tzinfo=UTC)
        if not isinstance(value, str) or not value:
            raise ValueError(f"coverage field {column.name} must be an ISO-8601 string")
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError(f"coverage field {column.name} must be valid ISO-8601") from error
        if parsed.tzinfo is None:
            raise ValueError(f"coverage field {column.name} must include a UTC offset")
        return parsed.astimezone(UTC)
    raise TypeError(f"coverage field {column.name} has unsupported type {column.sql_type}")


class MySqlSourceReader(SourceReader):
    """Agrupa o estado e as operações de ``MySqlSourceReader`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        registry: DatasetRegistry,
        settings: MySqlConnectionSettings,
        *,
        connection_factory: ConnectionFactory | None = None,
        force_cursor_index: bool = False,
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            registry: Entrada ``registry``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            settings: Entrada ``settings``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            connection_factory: Fábrica injetada que cria a dependência somente quando
            necessária.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        if not isinstance(registry, DatasetRegistry):
            raise TypeError("registry must be a DatasetRegistry")
        if not isinstance(settings, MySqlConnectionSettings):
            raise TypeError("settings must be MySqlConnectionSettings")
        self._registry = registry
        self._settings = settings
        self._connection_factory = connection_factory or self._connect
        self._force_cursor_index = force_cursor_index

    def _connect(self) -> Connection:
        """Executa a etapa interna ``connect`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``Connection`` produzido pela operação após as validações.
        """
        settings = self._settings
        return pymysql.connect(
            host=settings.host,
            port=settings.port,
            user=settings.user,
            password=settings.password,
            database=settings.database,
            charset="utf8mb4",
            autocommit=True,
            connect_timeout=settings.connect_timeout_seconds,
            read_timeout=settings.read_timeout_seconds,
            write_timeout=settings.write_timeout_seconds,
            cursorclass=SSDictCursor,
        )

    def _require_descriptor(self, descriptor: DatasetDescriptor) -> DatasetDescriptor:
        """Valida e devolve descritor, rejeitando entradas fora do contrato.

        Args:
            descriptor: Descritor físico e semântico do dataset processado.

        Returns:
            Valor ``DatasetDescriptor`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(descriptor, DatasetDescriptor):
            raise TypeError("descriptor must be a DatasetDescriptor")
        try:
            approved = self._registry.require(descriptor.table)
        except KeyError as error:
            raise ValueError("descriptor is not present in the registry") from error
        if descriptor != approved:
            raise ValueError("descriptor differs from the registry contract")
        return approved

    def _fetch_all(
        self, statement: str, parameters: QueryParameters = ()
    ) -> tuple[Mapping[str, object], ...]:
        """Executa a etapa interna ``fetch_all`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            statement: Entrada ``statement``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            parameters: Entrada ``parameters``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.

        Returns:
            Valor ``tuple[Mapping[str, object], ...]`` produzido pela operação após as
            validações.
        """
        connection = self._connection_factory()
        try:
            with connection.cursor(SSDictCursor) as cursor:
                cursor.execute(statement, parameters)
                rows = cast(list[Mapping[str, object]], cursor.fetchall())
                return tuple(dict(row) for row in rows)
        finally:
            connection.close()

    def _fetch_one(
        self, statement: str, parameters: QueryParameters = ()
    ) -> Mapping[str, object] | None:
        """Executa a etapa interna ``fetch_one`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            statement: Entrada ``statement``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            parameters: Entrada ``parameters``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.

        Returns:
            Valor ``Mapping[str, object] | None`` produzido pela operação após as validações.
        """
        connection = self._connection_factory()
        try:
            with connection.cursor(SSDictCursor) as cursor:
                cursor.execute(statement, parameters)
                row = cast(Mapping[str, object] | None, cursor.fetchone())
                return None if row is None else dict(row)
        finally:
            connection.close()

    def _observe_columns(self, descriptor: DatasetDescriptor) -> tuple[PhysicalColumn, ...]:
        """Obtém a ordem e os tipos físicos declarados pela tabela aprovada."""
        approved = self._require_descriptor(descriptor)
        rows = self._fetch_all(_COLUMNS_SQL, (self._settings.database, approved.table))
        return tuple(_physical_column(row) for row in rows)

    def _validated_page(
        self,
        descriptor: DatasetDescriptor,
        selected_columns: tuple[str, ...],
        statement: str,
        parameters: QueryParameters,
    ) -> SourcePage:
        """Executa uma página e mantém cursor somente na chave aprovada do descritor."""
        rows = self._fetch_all(statement, parameters)
        for row in rows:
            if tuple(row) != selected_columns:
                raise ValueError(f"source row shape differs from descriptor {descriptor.table!r}")
        next_cursor = tuple(rows[-1][field] for field in descriptor.cursor_key) if rows else None
        if next_cursor is not None:
            for column, value in zip(
                (_column_by_name(descriptor, field) for field in descriptor.cursor_key),
                next_cursor,
                strict=True,
            ):
                _validate_cursor_value(column, value)
        return SourcePage(rows, next_cursor)

    def _read_selected_page(
        self,
        descriptor: DatasetDescriptor,
        selected_columns: tuple[str, ...],
        window: TimeWindow | None,
        after: Cursor | None,
        limit: int,
    ) -> SourcePage:
        """Lê uma página projetando somente os nomes físicos previamente permitidos."""
        statement, parameters = build_page_query(
            descriptor,
            window,
            after,
            limit,
            selected_columns=selected_columns,
            forced_index=(
                (
                    "PRIMARY"
                    if descriptor.cursor_key == descriptor.natural_key
                    else "ix_ingestion_cursor"
                )
                if self._force_cursor_index
                else None
            ),
        )
        return self._validated_page(descriptor, selected_columns, statement, parameters)

    def validate_schema(self, descriptor: DatasetDescriptor) -> SchemaObservation:
        """Valida esquema contra as invariantes deste módulo.

        Args:
            descriptor: Descritor físico e semântico do dataset processado.

        Returns:
            Valor ``SchemaObservation`` produzido pela operação após as validações.
        """
        approved = self._require_descriptor(descriptor)
        observed_physical_columns = self._observe_columns(approved)
        primary_rows = self._fetch_all(
            """SELECT COLUMN_NAME, SEQ_IN_INDEX
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s AND INDEX_NAME = 'PRIMARY'
ORDER BY SEQ_IN_INDEX""",
            (self._settings.database, approved.table),
        )
        observed_columns = tuple(
            (column.name, column.physical_type, column.nullable, column.ordinal)
            for column in observed_physical_columns
        )
        observed_primary = tuple(_require_schema_string(row, "COLUMN_NAME") for row in primary_rows)
        expected_columns = tuple(
            (column.name, column.sql_type, column.nullable, index)
            for index, column in enumerate(approved.columns, start=1)
        )
        differences: list[str] = []
        if observed_columns != expected_columns:
            differences.append(
                f"columns differ; expected={expected_columns!r}, observed={observed_columns!r}"
            )
        if observed_primary != approved.natural_key:
            differences.append(
                f"primary key differs; expected={approved.natural_key!r}, "
                f"observed={observed_primary!r}"
            )
        fingerprint = hashlib.sha256(
            canonical_bytes(
                {
                    "table": approved.table,
                    "columns": observed_columns,
                    "primaryKey": observed_primary,
                }
            )
        ).hexdigest()
        return SchemaObservation(fingerprint, not differences, tuple(differences))

    def measure_coverage(self, descriptor: DatasetDescriptor) -> CoverageObservation:
        """Mede cobertura e devolve evidências explícitas da observação.

        Args:
            descriptor: Descritor físico e semântico do dataset processado.

        Returns:
            Valor ``CoverageObservation`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        approved = self._require_descriptor(descriptor)
        table = quote_identifier(approved.table)
        if approved.archive_partition.get("strategy") == "snapshot_date":
            row = self._fetch_one(f"SELECT COUNT(*) AS row_count FROM {table}")
            row_count = _coverage_count(row, "row_count")
            return CoverageObservation(CoverageStatus.COMPLETE, row_count, None)

        timestamp_name = cast(str, approved.timestamp_field)
        timestamp = _timestamp_expression(approved)
        bucket_dependency = approved.table in _CANONICAL_BUCKET_DATASETS
        if bucket_dependency:
            grain_ms = (approved.grain_seconds or 0) * 1000
            if grain_ms <= 0:
                raise ValueError("canonical bucket dependency must declare a positive grain")
            row = self._fetch_one(
                f"SELECT COUNT(*) AS row_count, COUNT({timestamp}) AS timestamped_row_count, "
                f"MIN({timestamp}) AS min_timestamp, MAX({timestamp}) AS max_timestamp, "
                f"COUNT(DISTINCT {timestamp}) AS distinct_bucket_count, "
                f"COUNT(DISTINCT CASE WHEN MOD({timestamp}, {grain_ms}) = 0 "
                f"THEN {timestamp} END) AS canonical_bucket_count, "
                f"SUM(CASE WHEN MOD({timestamp}, {grain_ms}) = 0 THEN 1 ELSE 0 END) "
                f"AS canonical_timestamped_row_count FROM {table}"
            )
        else:
            row = self._fetch_one(
                f"SELECT COUNT(*) AS row_count, COUNT({timestamp}) AS timestamped_row_count, "
                f"MIN({timestamp}) AS min_timestamp, MAX({timestamp}) AS max_timestamp FROM {table}"
            )
        row_count = _coverage_count(row, "row_count")
        timestamped_count = _coverage_count(row, "timestamped_row_count")
        if row_count == 0:
            return CoverageObservation(CoverageStatus.COMPLETE, 0, None)
        if timestamped_count == 0:
            return CoverageObservation(CoverageStatus.UNAVAILABLE, row_count, None)
        if row is None:
            raise ValueError("coverage query returned no row")
        column = _column_by_name(approved, timestamp_name)
        observed_start = _parse_coverage_timestamp(column, row.get("min_timestamp"))
        observed_maximum = _parse_coverage_timestamp(column, row.get("max_timestamp"))
        grain = approved.grain_seconds or 1
        observed = TimeWindow(observed_start, observed_maximum + timedelta(seconds=grain), grain)
        canonical_complete = True
        coverage_numerator: int | None = None
        coverage_denominator: int | None = None
        if bucket_dependency:
            distinct = _coverage_count(row, "distinct_bucket_count")
            canonical_buckets = _coverage_count(row, "canonical_bucket_count")
            canonical_rows = _coverage_count(row, "canonical_timestamped_row_count")
            expected = int((observed_maximum - observed_start).total_seconds() // grain) + 1
            if canonical_buckets > expected:
                raise ValueError("coverage query returned more canonical buckets than possible")
            coverage_numerator = canonical_buckets
            coverage_denominator = expected
            canonical_complete = (
                canonical_rows == timestamped_count
                and distinct == expected
                and int(observed_start.timestamp() * 1000) % (grain * 1000) == 0
                and int(observed_maximum.timestamp() * 1000) % (grain * 1000) == 0
            )
        status = (
            CoverageStatus.COMPLETE
            if timestamped_count == row_count and canonical_complete
            else CoverageStatus.PARTIAL
        )
        return CoverageObservation(
            status,
            row_count,
            observed,
            coverage_numerator=coverage_numerator,
            coverage_denominator=coverage_denominator,
            latest_observed_at=observed_maximum,
            verified_through=(
                observed.end if bucket_dependency and status is CoverageStatus.COMPLETE else None
            ),
        )

    def read_page(
        self,
        descriptor: DatasetDescriptor,
        window: TimeWindow | None,
        after: Cursor | None,
        limit: int,
    ) -> SourcePage:
        """Lê página sem ampliar o escopo solicitado.

        Args:
            descriptor: Descritor físico e semântico do dataset processado.
            window: Janela temporal UTC, fechada no início e aberta no fim.
            after: Cursor da última linha consumida; ``None`` inicia a paginação.
            limit: Quantidade máxima de itens que a operação pode processar.

        Returns:
            Valor ``SourcePage`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        approved = self._require_descriptor(descriptor)
        return self._read_selected_page(
            approved,
            tuple(column.name for column in approved.columns),
            window,
            after,
            limit,
        )

    def execute_scalar(self, statement: str) -> object | None:
        """Executa a etapa interna ``execute_scalar`` e devolve o resultado validado indicado
        pela assinatura.

        Args:
            statement: Entrada ``statement``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``object | None`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if statement != BOT_RELIABLE_FROM_SQL:
            raise ValueError("scalar statement is not allowlisted")
        row = self._fetch_one(statement)
        if row is None or set(row) != {"first_bot_bucket"}:
            raise ValueError("bot coverage query returned an unexpected shape")
        return row["first_bot_bucket"]

    def build_normalization_context(self) -> NormalizationContext:
        """Constrói normalization context a partir das entradas validadas.

        Returns:
            Valor ``NormalizationContext`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        bot = discover_bot_coverage(self.execute_scalar)
        descriptor = self._registry.require("live_event_sde")
        valid_sde_ids: set[str] = set()
        after: Cursor | None = None
        while True:
            page = self.read_page(descriptor, None, after, MAX_PAGE_SIZE)
            if not page.rows:
                break
            for row in page.rows:
                sde_id = row["sde_id"]
                if not isinstance(sde_id, str) or not sde_id:
                    raise ValueError("live_event_sde returned an invalid sde_id")
                valid_sde_ids.add(sde_id)
            after = page.next_cursor
        return NormalizationContext(bot.bot_reliable_from_ms, frozenset(valid_sde_ids))


def _require_schema_string(row: Mapping[str, object], field: str) -> str:
    """Valida e devolve esquema string, rejeitando entradas fora do contrato.

    Args:
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    value = row.get(field)
    if not isinstance(value, str) or not value:
        raise ValueError(f"INFORMATION_SCHEMA returned invalid {field}")
    return value


def _require_schema_int(row: Mapping[str, object], field: str) -> int:
    """Valida e devolve esquema inteiro, rejeitando entradas fora do contrato.

    Args:
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``int`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    value = row.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"INFORMATION_SCHEMA returned invalid {field}")
    return value


def _coverage_count(row: Mapping[str, object] | None, field: str) -> int:
    """Executa a etapa interna ``coverage_count`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``int`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if row is None:
        raise ValueError("coverage query returned no row")
    value = row.get(field)
    if isinstance(value, Decimal):
        if not value.is_finite() or value < 0 or value != value.to_integral_value():
            raise ValueError(f"coverage query returned invalid {field}")
        return int(value)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"coverage query returned invalid {field}")
    return value


__all__ = [
    "MAX_PAGE_SIZE",
    "MySqlConnectionSettings",
    "MySqlSourceReader",
    "build_page_query",
    "quote_identifier",
]
