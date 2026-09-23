"""Serializa registros canônicos em Parquet determinístico e lê o mesmo formato de volta.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import sqlite3
import sys
import threading
from collections.abc import Iterable, Iterator, Mapping
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import cast

import pyarrow as pa  # type: ignore[import-untyped]
import pyarrow.parquet as pq  # type: ignore[import-untyped]

from domain.archive import partition_date
from domain.archive_records import (
    ANALYTIC_JSON_KINDS,
    ARCHIVE_SHAPES,
    CANONICAL_TIMESTAMP_COLUMNS,
    ArchiveRecordValidationError,
    canonical_field_nullable,
    physical_field_nullable,
    physical_value,
    validate_archive_record,
)
from domain.canonical_json import canonical_bytes, canonical_decimal_text
from domain.datasets import DatasetColumn, DatasetDescriptor
from domain.disk_budget import DiskBudget
from domain.identity import payload_hash, record_id
from domain.models import CanonicalRecord, CanonicalValue, RecordType, Scalar, TimeWindow
from ports import ConditionalWriteError, EncodedPartition, IdempotencyConflict, ParquetEncoder

_INTEGER_TYPES = frozenset({"INT", "BIGINT", "TINYINT"})
_BATCH_SIZE = 10_000
TARGET_PARQUET_ROW_GROUP_BYTES = 128 * 1024 * 1024
_TYPE = {
    "bool": pa.bool_(),
    "int": pa.int64(),
    "string": pa.string(),
    "timestamp": pa.timestamp("ms", tz="UTC"),
    # Decimais canônicos são strings UTF-8 sem perda; projeções SQL DOUBLE usam float64.
    "decimal": pa.string(),
    "list[string]": pa.list_(pa.field("element", pa.string(), nullable=False)),
    "list[int]": pa.list_(pa.field("element", pa.int64(), nullable=False)),
    "list[topName]": pa.list_(
        pa.field(
            "element",
            pa.struct(
                [
                    pa.field("name", pa.string(), nullable=False),
                    pa.field("errors", pa.int64(), nullable=False),
                ]
            ),
            nullable=False,
        )
    ),
}
_ANALYTIC_JSON_TYPES: Mapping[tuple[str, str], pa.DataType] = {
    key: _TYPE[kind] for key, kind in ANALYTIC_JSON_KINDS.items()
}

ParquetEncodingError = ArchiveRecordValidationError


def _datetime(value: object, field: str) -> datetime | None:
    """Executa a etapa interna ``datetime`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``datetime | None`` produzido pela operação após as validações.

    Raises:
        ParquetEncodingError: Se a operação não puder preservar as invariantes descritas.
    """
    if value is None:
        return None
    if (
        not isinstance(value, datetime)
        or value.tzinfo is None
        or value.utcoffset() != UTC.utcoffset(None)
    ):
        raise ParquetEncodingError(f"{field} must be an aware UTC datetime")
    return value.astimezone(UTC)


def _value_for_arrow(value: CanonicalValue | Scalar | None, field_type: pa.DataType) -> object:
    """Executa a etapa interna ``value_for_arrow`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field_type: Entrada ``field_type``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``object`` produzido pela operação após as validações.

    Raises:
        ParquetEncodingError: Se a operação não puder preservar as invariantes descritas.
    """
    if value is None:
        return None
    if pa.types.is_timestamp(field_type):
        return _datetime(value, "timestamp")
    if pa.types.is_struct(field_type):
        if not isinstance(value, Mapping):
            raise ParquetEncodingError("canonical struct value must be a mapping")
        return {
            child.name: _value_for_arrow(value.get(child.name), child.type) for child in field_type
        }
    if pa.types.is_list(field_type):
        if not isinstance(value, tuple | list):
            raise ParquetEncodingError("canonical list value must be a sequence")
        return [_value_for_arrow(item, field_type.value_type) for item in value]
    if pa.types.is_decimal(field_type):
        if not isinstance(value, Decimal):
            raise ParquetEncodingError("canonical decimal value must be a Decimal")
        return value
    if pa.types.is_string(field_type):
        if isinstance(value, Decimal):
            return canonical_decimal_text(value)
        if isinstance(value, str):
            return value
        raise ParquetEncodingError("canonical string value must be text or Decimal")
    if pa.types.is_floating(field_type):
        if isinstance(value, bool) or not isinstance(value, int | float | Decimal):
            raise ParquetEncodingError("canonical floating value must be numeric")
        numeric = float(value)
        if not math.isfinite(numeric):
            raise ParquetEncodingError("canonical floating value must be finite")
        return numeric
    return value


def _shape_type(
    descriptor: DatasetDescriptor, namespace: str, shape: Mapping[str, str]
) -> pa.DataType:
    """Executa a etapa interna ``shape_type`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        namespace: Entrada ``namespace``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        shape: Entrada ``shape``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``pa.DataType`` produzido pela operação após as validações.
    """
    if not shape:
        return pa.struct([pa.field("_empty", pa.string(), nullable=True)])
    return pa.struct(
        [
            pa.field(
                name,
                _TYPE[kind],
                nullable=canonical_field_nullable(descriptor, namespace, name),
            )
            for name, kind in shape.items()
        ]
    )


def _physical_type(descriptor: DatasetDescriptor, column: DatasetColumn) -> pa.DataType:
    """Executa a etapa interna ``physical_type`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        column: Entrada ``column``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``pa.DataType`` produzido pela operação após as validações.
    """
    analytic_type = _ANALYTIC_JSON_TYPES.get((descriptor.table, column.name))
    if analytic_type is not None:
        return analytic_type
    if column.name == descriptor.timestamp_field or column.name in CANONICAL_TIMESTAMP_COLUMNS:
        return _TYPE["timestamp"]
    if column.sql_type == "DOUBLE":
        return pa.float64()
    if column.sql_type in _INTEGER_TYPES:
        return pa.int64()
    return pa.string()


def _natural_type(column: DatasetColumn) -> pa.DataType:
    """Executa a etapa interna ``natural_type`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        column: Entrada ``column``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``pa.DataType`` produzido pela operação após as validações.
    """
    if column.sql_type == "DOUBLE":
        return pa.float64()
    if column.sql_type in _INTEGER_TYPES:
        return pa.int64()
    return pa.string()


def _natural_key_type(descriptor: DatasetDescriptor) -> pa.DataType:
    """Executa a etapa interna ``natural_key_type`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.

    Returns:
        Valor ``pa.DataType`` produzido pela operação após as validações.
    """
    columns = {column.name: column for column in descriptor.columns}
    return pa.struct(
        [
            pa.field(
                key,
                _natural_type(columns[key]),
                nullable=False,
            )
            for key in descriptor.natural_key
        ]
    )


def _schema(descriptor: DatasetDescriptor) -> pa.Schema:
    """Executa a etapa interna ``schema`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.

    Returns:
        Valor ``pa.Schema`` produzido pela operação após as validações.

    Raises:
        ParquetEncodingError: Se a operação não puder preservar as invariantes descritas.
    """
    try:
        dimensions, measures, quality = ARCHIVE_SHAPES[descriptor.table]
    except KeyError as error:
        raise ParquetEncodingError(
            f"descriptor {descriptor.table!r} has no canonical Arrow schema"
        ) from error
    fields = [
        pa.field("schemaVersion", pa.string(), nullable=False),
        pa.field("recordId", pa.string(), nullable=False),
        pa.field("datasetVersion", pa.string(), nullable=False),
        pa.field("recordType", pa.string(), nullable=False),
        pa.field("sourceSystem", pa.string(), nullable=False),
        pa.field("observedAt", pa.timestamp("ms", tz="UTC"), nullable=True),
        pa.field("windowStart", pa.timestamp("ms", tz="UTC"), nullable=True),
        pa.field("windowEnd", pa.timestamp("ms", tz="UTC"), nullable=True),
        pa.field("windowGrainSeconds", pa.int64(), nullable=True),
        pa.field("payloadHash", pa.string(), nullable=False),
        pa.field("naturalKey", _natural_key_type(descriptor), nullable=False),
        pa.field("dimensions", _shape_type(descriptor, "dimensions", dimensions), nullable=False),
        pa.field("measures", _shape_type(descriptor, "measures", measures), nullable=False),
        pa.field("quality", _shape_type(descriptor, "quality", quality), nullable=False),
        pa.field(
            "qualityFlags",
            pa.list_(pa.field("element", pa.string(), nullable=False)),
            nullable=False,
        ),
    ]
    fields.extend(
        pa.field(
            column.name,
            _physical_type(descriptor, column),
            nullable=physical_field_nullable(descriptor, column),
        )
        for column in descriptor.columns
    )
    metadata = {
        b"canonicalSchemaVersion": b"1.0",
        b"dataset": descriptor.table.encode(),
        b"recordType": descriptor.record_type.value.encode(),
    }
    return pa.schema(fields, metadata=metadata)


def schema_fingerprint_for_descriptor(descriptor: DatasetDescriptor) -> str:
    """Executa a etapa interna ``schema_fingerprint_for_descriptor`` e devolve o resultado
    validado indicado pela assinatura.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    if not isinstance(descriptor, DatasetDescriptor):
        raise TypeError("descriptor must be a DatasetDescriptor")
    return _schema_fingerprint(_schema(descriptor))


def _schema_fingerprint(schema: pa.Schema) -> str:
    """Executa a etapa interna ``schema_fingerprint`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        schema: Entrada ``schema``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return hashlib.sha256(schema.serialize().to_pybytes()).hexdigest()


def _row(
    record: CanonicalRecord, descriptor: DatasetDescriptor, dataset_version: str, schema: pa.Schema
) -> dict[str, object]:
    """Executa a etapa interna ``row`` e devolve o resultado validado indicado pela assinatura.

    Args:
        record: Registro canônico consumido pela operação.
        descriptor: Descritor físico e semântico do dataset processado.
        dataset_version: Identificador imutável da versão do dataset.
        schema: Entrada ``schema``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.

    Raises:
        ParquetEncodingError: Se a operação não puder preservar as invariantes descritas.
    """
    if record.source_dataset != descriptor.table:
        raise ParquetEncodingError("record source_dataset differs from descriptor table")
    if record.record_type != descriptor.record_type:
        raise ParquetEncodingError("record type differs from descriptor record type")
    window = record.window
    return {
        "schemaVersion": record.schema_version,
        "recordId": record_id(record),
        "datasetVersion": dataset_version,
        "recordType": record.record_type.value,
        "sourceSystem": record.source_system,
        "observedAt": _datetime(record.observed_at, "observedAt"),
        "windowStart": _datetime(window.start, "windowStart") if window else None,
        "windowEnd": _datetime(window.end, "windowEnd") if window else None,
        "windowGrainSeconds": window.grain_seconds if window else None,
        "payloadHash": payload_hash(record),
        "naturalKey": _value_for_arrow(dict(record.natural_key), schema.field("naturalKey").type),
        "dimensions": _value_for_arrow(record.dimensions, schema.field("dimensions").type),
        "measures": _value_for_arrow(record.measures, schema.field("measures").type),
        "quality": _value_for_arrow(record.quality, schema.field("quality").type),
        "qualityFlags": list(record.quality_flags),
        **{
            column.name: _value_for_arrow(
                _physical_string_value(
                    physical_value(record, descriptor, column), schema.field(column.name).type
                ),
                schema.field(column.name).type,
            )
            for column in descriptor.columns
        },
    }


def _physical_string_value(
    value: object, field_type: pa.DataType
) -> CanonicalValue | Scalar | None:
    """Produz o valor de physical string usado pela etapa seguinte.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field_type: Entrada ``field_type``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``CanonicalValue | Scalar | None`` produzido pela operação após as validações.
    """
    if value is None or not pa.types.is_string(field_type) or isinstance(value, str):
        return cast(CanonicalValue | Scalar | None, value)
    return canonical_bytes(value).decode("utf-8")


def _checksum(path: Path) -> str:
    """Executa a etapa interna ``checksum`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        path: Caminho local do artefato lido ou produzido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _thaw(value: object) -> object:
    """Executa a etapa interna ``thaw`` e devolve o resultado validado indicado pela assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``object`` produzido pela operação após as validações.
    """
    if isinstance(value, Mapping):
        return {key: _thaw(item) for key, item in value.items()}
    if isinstance(value, tuple | list):
        return tuple(_thaw(item) for item in value)
    return value


def _serialize_record(record: CanonicalRecord) -> bytes:
    """Serializa registro de maneira determinística.

    Args:
        record: Registro canônico consumido pela operação.

    Returns:
        Valor ``bytes`` produzido pela operação após as validações.
    """
    return canonical_bytes(
        {
            "schema_version": record.schema_version,
            "record_type": record.record_type.value,
            "source_system": record.source_system,
            "source_dataset": record.source_dataset,
            "natural_key": _thaw(record.natural_key),
            "observed_at": record.observed_at,
            "window": (
                {
                    "start": record.window.start,
                    "end": record.window.end,
                    "grain_seconds": record.window.grain_seconds,
                }
                if record.window is not None
                else None
            ),
            "dimensions": _thaw(record.dimensions),
            "measures": _thaw(record.measures),
            "quality": _thaw(record.quality),
            "quality_flags": record.quality_flags,
        }
    )


def _restore_spool_value(value: object) -> object:
    """Restaura spool valor e confirma sua identidade antes de concluir.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``object`` produzido pela operação após as validações.

    Raises:
        ParquetEncodingError: Se a operação não puder preservar as invariantes descritas.
    """
    if isinstance(value, list):
        return tuple(_restore_spool_value(item) for item in value)
    if not isinstance(value, Mapping):
        return value
    if set(value) == {"$decimal"} and isinstance(value["$decimal"], str):
        return Decimal(value["$decimal"])
    if set(value) == {"$datetime"} and isinstance(value["$datetime"], str):
        restored = datetime.fromisoformat(value["$datetime"].replace("Z", "+00:00"))
        if restored.tzinfo is None or restored.utcoffset() != UTC.utcoffset(None):
            raise ParquetEncodingError("record spool datetime must be UTC")
        return restored.astimezone(UTC)
    return {key: _restore_spool_value(item) for key, item in value.items()}


def _deserialize_record(payload: bytes) -> CanonicalRecord:
    """Desserializa registro e rejeita representações inválidas.

    Args:
        payload: Entrada ``payload``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.

    Raises:
        ParquetEncodingError: Se a operação não puder preservar as invariantes descritas.
    """
    try:
        decoded = json.loads(payload)
    except (TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ParquetEncodingError("record spool contains invalid canonical JSON") from error
    if not isinstance(decoded, Mapping) or set(decoded) != {
        "schema_version",
        "record_type",
        "source_system",
        "source_dataset",
        "natural_key",
        "observed_at",
        "window",
        "dimensions",
        "measures",
        "quality",
        "quality_flags",
    }:
        raise ParquetEncodingError("record spool contains an invalid record shape")
    values = cast(dict[str, object], _restore_spool_value(decoded))
    raw_window = values["window"]
    if raw_window is None:
        window = None
    elif isinstance(raw_window, Mapping) and set(raw_window) == {
        "start",
        "end",
        "grain_seconds",
    }:
        window = TimeWindow(
            cast(datetime, raw_window["start"]),
            cast(datetime, raw_window["end"]),
            cast(int, raw_window["grain_seconds"]),
        )
    else:
        raise ParquetEncodingError("record spool contains an invalid window")
    try:
        return CanonicalRecord(
            schema_version=cast(str, values["schema_version"]),
            record_type=RecordType(cast(str, values["record_type"])),
            source_system=cast(str, values["source_system"]),
            source_dataset=cast(str, values["source_dataset"]),
            natural_key=cast(tuple[tuple[str, Scalar], ...], values["natural_key"]),
            observed_at=cast(datetime | None, values["observed_at"]),
            window=window,
            dimensions=cast(Mapping[str, CanonicalValue], values["dimensions"]),
            measures=cast(Mapping[str, CanonicalValue], values["measures"]),
            quality=cast(Mapping[str, Scalar], values["quality"]),
            quality_flags=cast(tuple[str, ...], values["quality_flags"]),
        )
    except (TypeError, ValueError) as error:
        raise ParquetEncodingError("record spool contains an invalid canonical record") from error


class _RecordSpool:
    """Agrupa o estado e as operações de ``_RecordSpool`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(self, directory: Path) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            directory: Entrada ``directory``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self.connection: sqlite3.Connection | None = None
        with NamedTemporaryFile(
            dir=directory, prefix=".parquet-records.", suffix=".sqlite3", delete=False
        ) as output:
            self.path = Path(output.name)
        try:
            self.connection = sqlite3.connect(self.path)
            self.connection.execute(
                "CREATE TABLE records ("
                "record_id TEXT PRIMARY KEY, sort_key BLOB NOT NULL, payload BLOB NOT NULL)"
            )
            self.count = 0
        except BaseException:
            self.close()
            raise

    def add(self, record: CanonicalRecord) -> None:
        """Acrescenta a entrada validada ao estado acumulado da instância.

        Args:
            record: Registro canônico consumido pela operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ParquetEncodingError: Se a operação não puder preservar as invariantes descritas.
        """
        identifier = record_id(record)
        try:
            assert self.connection is not None
            self.connection.execute(
                "INSERT INTO records (record_id, sort_key, payload) VALUES (?, ?, ?)",
                (identifier, canonical_bytes(record.natural_key), _serialize_record(record)),
            )
        except sqlite3.IntegrityError as error:
            raise ParquetEncodingError(f"duplicate recordId {identifier}") from error
        self.count += 1

    def ordered_batches(self) -> Iterator[tuple[CanonicalRecord, ...]]:
        """Executa a etapa interna ``ordered_batches`` e devolve o resultado validado indicado
        pela assinatura.

        Returns:
            Iterador que produz os itens válidos à medida que são processados.
        """
        assert self.connection is not None
        cursor = self.connection.execute(
            "SELECT payload FROM records ORDER BY sort_key ASC, record_id ASC"
        )
        payloads: list[bytes] = []
        estimated_bytes = 0
        while rows := cursor.fetchmany(_BATCH_SIZE):
            for row in rows:
                payload = cast(bytes, row[0])
                if payloads and estimated_bytes + len(payload) > TARGET_PARQUET_ROW_GROUP_BYTES:
                    yield tuple(_deserialize_record(item) for item in payloads)
                    payloads = []
                    estimated_bytes = 0
                payloads.append(payload)
                estimated_bytes += len(payload)
        if payloads:
            yield tuple(_deserialize_record(item) for item in payloads)

    def fingerprint(
        self, path: Path, descriptor: DatasetDescriptor, dataset_version: str, expected_absent: bool
    ) -> str:
        """Calcula a identidade determinística do conteúdo acumulado.

        Args:
            path: Caminho local do artefato lido ou produzido.
            descriptor: Descritor físico e semântico do dataset processado.
            dataset_version: Identificador imutável da versão do dataset.
            expected_absent: Indica se a operação exige que o recurso ainda não exista.

        Returns:
            Valor ``str`` produzido pela operação após as validações.
        """
        digest = hashlib.sha256()
        digest.update(
            canonical_bytes(
                {
                    "path": str(path),
                    "dataset": descriptor.table,
                    "datasetVersion": dataset_version,
                    "expectedAbsent": expected_absent,
                }
            )
        )
        for batch in self.ordered_batches():
            for record in batch:
                digest.update(
                    canonical_bytes(
                        {"recordId": record_id(record), "payloadHash": payload_hash(record)}
                    )
                )
        return digest.hexdigest()

    def close(self) -> None:
        """Libera recursos locais ainda mantidos pela instância.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        if self.connection is not None:
            try:
                self.connection.close()
            except (sqlite3.Error, OSError):
                pass
            finally:
                self.connection = None
        for candidate in (
            self.path,
            Path(f"{self.path}-journal"),
            Path(f"{self.path}-wal"),
            Path(f"{self.path}-shm"),
        ):
            try:
                candidate.unlink(missing_ok=True)
            except OSError:
                # Uma falha de limpeza nunca pode ocultar a falha original de inicialização/escrita.
                pass


def _value_from_arrow(
    value: object, field_type: pa.DataType, canonical_kind: str | None = None
) -> CanonicalValue | Scalar | None:
    """Executa a etapa interna ``value_from_arrow`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field_type: Entrada ``field_type``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        canonical_kind: Entrada ``canonical_kind``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.

    Returns:
        Valor ``CanonicalValue | Scalar | None`` produzido pela operação após as validações.

    Raises:
        ParquetEncodingError: Se a operação não puder preservar as invariantes descritas.
    """
    if value is None:
        return None
    if canonical_kind == "decimal":
        if not isinstance(value, str):
            raise ParquetEncodingError("decoded canonical decimal is invalid")
        try:
            return Decimal(value)
        except Exception as error:
            raise ParquetEncodingError("decoded canonical decimal is invalid") from error
    if pa.types.is_timestamp(field_type):
        return _datetime(value, "timestamp")
    if pa.types.is_struct(field_type):
        if not isinstance(value, Mapping):
            raise ParquetEncodingError("decoded canonical struct is not a mapping")
        return {
            child.name: _value_from_arrow(value.get(child.name), child.type)
            for child in field_type
            if child.name != "_empty"
        }
    if pa.types.is_list(field_type):
        if not isinstance(value, list):
            raise ParquetEncodingError("decoded canonical list is not a list")
        return tuple(_value_from_arrow(item, field_type.value_type) for item in value)
    if pa.types.is_floating(field_type):
        if not isinstance(value, float) or not math.isfinite(value):
            raise ParquetEncodingError("decoded canonical floating value is invalid")
        return Decimal(str(value))
    return cast(CanonicalValue | Scalar, value)


def _canonical_mapping_from_arrow(
    value: object, field_type: pa.DataType, shape: Mapping[str, str]
) -> Mapping[str, CanonicalValue | Scalar | None]:
    """Produz a representação canônica de mapeamento from arrow.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field_type: Entrada ``field_type``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        shape: Entrada ``shape``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``Mapping[str, CanonicalValue | Scalar | None]`` produzido pela operação após as
        validações.

    Raises:
        ParquetEncodingError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(value, Mapping) or not pa.types.is_struct(field_type):
        raise ParquetEncodingError("decoded canonical mapping is invalid")
    return {
        child.name: _value_from_arrow(value.get(child.name), child.type, shape[child.name])
        for child in field_type
        if child.name != "_empty"
    }


def _athena_type(field_type: pa.DataType) -> str:
    """Executa a etapa interna ``athena_type`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        field_type: Entrada ``field_type``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ParquetEncodingError: Se a operação não puder preservar as invariantes descritas.
    """
    if pa.types.is_boolean(field_type):
        return "boolean"
    if pa.types.is_integer(field_type):
        return "bigint"
    if pa.types.is_floating(field_type):
        return "double"
    if pa.types.is_string(field_type):
        return "string"
    if pa.types.is_timestamp(field_type):
        return "timestamp"
    if pa.types.is_decimal(field_type):
        if field_type.precision > 38:
            raise ParquetEncodingError("Athena DECIMAL precision cannot exceed 38")
        return f"decimal({field_type.precision},{field_type.scale})"
    if pa.types.is_list(field_type):
        return f"array<{_athena_type(field_type.value_type)}>"
    if pa.types.is_struct(field_type):
        return (
            "struct<"
            + ",".join(f"{child.name}:{_athena_type(child.type)}" for child in field_type)
            + ">"
        )
    raise ParquetEncodingError(f"Arrow type {field_type} is unsupported by Athena")


def athena_schema(schema: pa.Schema) -> dict[str, str]:
    """Executa a etapa interna ``athena_schema`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        schema: Entrada ``schema``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``dict[str, str]`` produzido pela operação após as validações.
    """
    return {field.name: _athena_type(field.type) for field in schema}


def schema_for_descriptor(descriptor: DatasetDescriptor) -> pa.Schema:
    """Executa a etapa interna ``schema_for_descriptor`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.

    Returns:
        Valor ``pa.Schema`` produzido pela operação após as validações.
    """
    return _schema(descriptor)


validate_canonical_record = validate_archive_record


def athena_schema_for_descriptor(descriptor: DatasetDescriptor) -> dict[str, str]:
    """Executa a etapa interna ``athena_schema_for_descriptor`` e devolve o resultado validado
    indicado pela assinatura.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.

    Returns:
        Valor ``dict[str, str]`` produzido pela operação após as validações.
    """
    return athena_schema(schema_for_descriptor(descriptor))


def _record_from_arrow(row: Mapping[str, object], schema: pa.Schema) -> CanonicalRecord:
    """Obtém ou registra from arrow como evidência da execução atual.

    Args:
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        schema: Entrada ``schema``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.

    Raises:
        ParquetEncodingError: Se a operação não puder preservar as invariantes descritas.
    """
    try:
        dataset = schema.metadata[b"dataset"].decode() if schema.metadata is not None else None
    except (KeyError, UnicodeDecodeError) as error:
        raise ParquetEncodingError("Parquet partition is missing dataset metadata") from error
    if dataset is None:
        raise ParquetEncodingError("Parquet partition is missing dataset metadata")
    try:
        dimension_shape, measure_shape, quality_shape = ARCHIVE_SHAPES[dataset]
    except KeyError as error:
        raise ParquetEncodingError("Parquet partition dataset is unsupported") from error
    natural = _value_from_arrow(row["naturalKey"], schema.field("naturalKey").type)
    dimensions = _canonical_mapping_from_arrow(
        row["dimensions"], schema.field("dimensions").type, dimension_shape
    )
    measures = _canonical_mapping_from_arrow(
        row["measures"], schema.field("measures").type, measure_shape
    )
    quality = _canonical_mapping_from_arrow(
        row["quality"], schema.field("quality").type, quality_shape
    )
    flags = _value_from_arrow(row["qualityFlags"], schema.field("qualityFlags").type)
    observed_at = _datetime(row["observedAt"], "observedAt")
    window_start = _datetime(row["windowStart"], "windowStart")
    window_end = _datetime(row["windowEnd"], "windowEnd")
    grain = row["windowGrainSeconds"]
    if (window_start is None) != (window_end is None):
        raise ParquetEncodingError("Parquet window bounds must both be present or absent")
    if window_start is None:
        window = None
    else:
        if isinstance(grain, bool) or not isinstance(grain, int):
            raise ParquetEncodingError("Parquet window grain must be an integer")
        window = TimeWindow(window_start, cast(datetime, window_end), grain)
    if not isinstance(natural, Mapping) or not isinstance(dimensions, Mapping):
        raise ParquetEncodingError("Parquet canonical mappings are invalid")
    if not isinstance(measures, Mapping) or not isinstance(quality, Mapping):
        raise ParquetEncodingError("Parquet canonical mappings are invalid")
    if not isinstance(flags, tuple) or not all(isinstance(flag, str) for flag in flags):
        raise ParquetEncodingError("Parquet quality flags are invalid")
    try:
        record = CanonicalRecord(
            schema_version=cast(str, row["schemaVersion"]),
            record_type=RecordType(cast(str, row["recordType"])),
            source_system=cast(str, row["sourceSystem"]),
            source_dataset=dataset,
            natural_key=tuple(cast(tuple[str, Scalar], item) for item in natural.items()),
            observed_at=observed_at,
            window=window,
            dimensions=dimensions,
            measures=measures,
            quality=cast(Mapping[str, Scalar], quality),
            quality_flags=cast(tuple[str, ...], flags),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise ParquetEncodingError("Parquet canonical envelope is invalid") from error
    if row["recordId"] != record_id(record) or row["payloadHash"] != payload_hash(record):
        raise ParquetEncodingError("Parquet canonical envelope checksum fields are invalid")
    return record


def _iter_partition(path: Path) -> Iterator[CanonicalRecord]:
    """Produz partição de forma incremental e com memória limitada.

    Args:
        path: Caminho local do artefato lido ou produzido.

    Returns:
        Iterador que produz os itens válidos à medida que são processados.

    Raises:
        ParquetEncodingError: Se a operação não puder preservar as invariantes descritas.
    """
    try:
        parquet = pq.ParquetFile(path)
    except (OSError, pa.ArrowException) as error:
        raise ParquetEncodingError("Parquet partition is not readable") from error
    schema = parquet.schema_arrow
    required = {
        "schemaVersion",
        "recordId",
        "datasetVersion",
        "recordType",
        "sourceSystem",
        "observedAt",
        "windowStart",
        "windowEnd",
        "windowGrainSeconds",
        "payloadHash",
        "naturalKey",
        "dimensions",
        "measures",
        "quality",
        "qualityFlags",
    }
    if not required <= set(schema.names):
        raise ParquetEncodingError("Parquet partition is missing canonical envelope fields")
    try:
        for batch in parquet.iter_batches(batch_size=_BATCH_SIZE):
            for row in pa.Table.from_batches([batch], schema=schema).to_pylist():
                yield _record_from_arrow(row, schema)
    except (OSError, pa.ArrowException) as error:
        raise ParquetEncodingError("Parquet partition is not readable") from error


def read_partition(path: Path) -> tuple[CanonicalRecord, ...]:
    """Lê partição sem ampliar o escopo solicitado.

    Args:
        path: Caminho local do artefato lido ou produzido.

    Returns:
        Valor ``tuple[CanonicalRecord, ...]`` produzido pela operação após as validações.
    """
    return tuple(_iter_partition(path))


def _verify(
    path: Path,
    schema: pa.Schema,
    expected_rows: int,
    descriptor: DatasetDescriptor,
    dataset_version: str,
) -> EncodedPartition:
    """Executa a etapa interna ``verify`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        path: Caminho local do artefato lido ou produzido.
        schema: Entrada ``schema``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        expected_rows: Valor esperado usado para detectar concorrência ou divergência de estado.
        descriptor: Descritor físico e semântico do dataset processado.
        dataset_version: Identificador imutável da versão do dataset.

    Returns:
        Valor ``EncodedPartition`` produzido pela operação após as validações.

    Raises:
        ParquetEncodingError: Se a operação não puder preservar as invariantes descritas.
    """
    try:
        parquet = pq.ParquetFile(path)
    except (OSError, pa.ArrowException) as error:
        raise ParquetEncodingError("temporary Parquet output is not readable") from error
    if parquet.metadata is None or parquet.metadata.num_rows != expected_rows:
        raise ParquetEncodingError("temporary Parquet output has an unexpected row count")
    if not parquet.schema_arrow.equals(schema, check_metadata=True):
        raise ParquetEncodingError("temporary Parquet output has an unexpected schema")
    if sum(1 for _record in _iter_partition(path)) != expected_rows:
        raise ParquetEncodingError("temporary Parquet output does not round-trip canonically")
    return EncodedPartition(
        path,
        expected_rows,
        path.stat().st_size,
        _checksum(path),
        dataset=descriptor.table,
        dataset_version=dataset_version,
        schema_version="1.0",
        schema_fingerprint=_schema_fingerprint(schema),
    )


class PyArrowParquetEncoder(ParquetEncoder):
    """Agrupa o estado e as operações de ``PyArrowParquetEncoder`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(self) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._idempotency: dict[str, tuple[str, EncodedPartition | None]] = {}
        self._idempotency_condition = threading.Condition()

    def iter_batches(
        self,
        path: Path,
        descriptor: DatasetDescriptor,
        *,
        dataset_version: str,
        partition: str,
        expected_row_count: int,
        expected_schema_fingerprint: str,
        batch_size: int,
    ) -> Iterator[tuple[CanonicalRecord, ...]]:
        """Validate one canonical object, then decode bounded Arrow record batches."""
        if not isinstance(path, Path):
            raise TypeError("path must be a Path")
        if not isinstance(descriptor, DatasetDescriptor):
            raise TypeError("descriptor must be a DatasetDescriptor")
        if not isinstance(dataset_version, str) or not dataset_version:
            raise ValueError("dataset_version must be non-empty")
        if isinstance(expected_row_count, bool) or not isinstance(expected_row_count, int):
            raise TypeError("expected_row_count must be an integer")
        if expected_row_count < 0:
            raise ValueError("expected_row_count must be non-negative")
        if isinstance(batch_size, bool) or not isinstance(batch_size, int):
            raise TypeError("batch_size must be an integer")
        if batch_size <= 0:
            raise ValueError("batch_size must be positive")
        expected_partition_day = partition_date(partition)
        try:
            parquet = pq.ParquetFile(path)
        except (OSError, pa.ArrowException) as error:
            raise ParquetEncodingError("canonical Parquet object is not readable") from error
        metadata = parquet.metadata
        if metadata is None or metadata.num_rows != expected_row_count:
            raise ParquetEncodingError("canonical Parquet footer row count differs from marker")
        schema = parquet.schema_arrow
        expected_schema = _schema(descriptor)
        if (
            not schema.equals(expected_schema, check_metadata=True)
            or _schema_fingerprint(schema) != expected_schema_fingerprint
        ):
            raise ParquetEncodingError("canonical Parquet schema differs from marker")
        schema_metadata = schema.metadata or {}
        if schema_metadata.get(b"dataset") != descriptor.table.encode():
            raise ParquetEncodingError("canonical Parquet dataset metadata differs from marker")

        observed_rows = 0
        try:
            arrow_batches = parquet.iter_batches(batch_size=batch_size)
            for arrow_batch in arrow_batches:
                if arrow_batch.num_rows <= 0 or arrow_batch.num_rows > batch_size:
                    raise ParquetEncodingError(
                        "canonical Parquet batch exceeds the configured row bound"
                    )
                table = pa.Table.from_batches([arrow_batch], schema=schema)
                if any(
                    value != dataset_version for value in table.column("datasetVersion").to_pylist()
                ):
                    raise ParquetEncodingError(
                        "canonical Parquet dataset version differs from marker"
                    )
                records = tuple(_record_from_arrow(row, schema) for row in table.to_pylist())
                for record in records:
                    if descriptor.archive_partition["strategy"] == "snapshot_date":
                        expected_partition = f"snapshot_date={expected_partition_day.isoformat()}"
                    else:
                        observed_at = record.observed_at
                        if observed_at is None:
                            raise ParquetEncodingError(
                                "canonical event-time record has no observation timestamp"
                            )
                        expected_partition = (
                            f"year={observed_at:%Y}/month={observed_at:%m}/day={observed_at:%d}"
                        )
                    if expected_partition != partition:
                        raise ParquetEncodingError(
                            "canonical Parquet record differs from marker partition"
                        )
                observed_rows += len(records)
                yield records
        except (OSError, pa.ArrowException) as error:
            raise ParquetEncodingError("canonical Parquet object is not readable") from error
        if observed_rows != expected_row_count:
            raise ParquetEncodingError("canonical Parquet row count differs from marker")

    @staticmethod
    def _verify_replay(result: EncodedPartition) -> None:
        """Executa a etapa interna ``verify_replay`` e valida seus efeitos antes de concluir.

        Args:
            result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ParquetEncodingError: Se a operação não puder preservar as invariantes descritas.
        """
        try:
            valid = result.path.is_file() and result.path.stat().st_size == result.byte_size
        except OSError as error:
            raise ParquetEncodingError(
                "idempotent result does not match its encoded result"
            ) from error
        if not valid or _checksum(result.path) != result.sha256:
            raise ParquetEncodingError("idempotent result does not match its encoded result")

    def _claim_or_replay(self, key: str, fingerprint: str) -> EncodedPartition | None:
        """Executa a etapa interna ``claim_or_replay`` e devolve o resultado validado indicado
        pela assinatura.

        Args:
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.

        Returns:
            Valor ``EncodedPartition | None`` produzido pela operação após as validações.

        Raises:
            IdempotencyConflict: Se a operação não puder preservar as invariantes descritas.
        """
        with self._idempotency_condition:
            while True:
                prior = self._idempotency.get(key)
                if prior is None:
                    self._idempotency[key] = (fingerprint, None)
                    return None
                if prior[0] != fingerprint:
                    raise IdempotencyConflict("idempotency key was reused with different input")
                if prior[1] is not None:
                    # O backfill limpa o workspace local depois de publicar com sucesso. Por isso,
                    # o cache do processo é apenas uma otimização de replay, nunca a fonte durável.
                    if not prior[1].path.exists():
                        self._idempotency[key] = (fingerprint, None)
                        return None
                    self._verify_replay(prior[1])
                    return prior[1]
                self._idempotency_condition.wait()

    def _complete_claim(self, key: str, fingerprint: str, result: EncodedPartition) -> None:
        """Conclui claim e devolve a evidência final da operação.

        Args:
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        with self._idempotency_condition:
            self._idempotency[key] = (fingerprint, result)
            self._idempotency_condition.notify_all()

    def _abandon_claim(self, key: str, fingerprint: str) -> None:
        """Executa a etapa interna ``abandon_claim`` e valida seus efeitos antes de concluir.

        Args:
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        with self._idempotency_condition:
            if self._idempotency.get(key) == (fingerprint, None):
                del self._idempotency[key]
                self._idempotency_condition.notify_all()

    def write_partition(
        self,
        records: Iterable[CanonicalRecord],
        descriptor: DatasetDescriptor,
        path: Path,
        *,
        dataset_version: str,
        expected_absent: bool,
        idempotency_key: str,
        disk_budget: DiskBudget | None = None,
    ) -> EncodedPartition:
        """Grava partição e devolve a evidência produzida pela operação.

        Args:
            records: Registros canônicos consumidos pela operação.
            descriptor: Descritor físico e semântico do dataset processado.
            path: Caminho local do artefato lido ou produzido.
            dataset_version: Identificador imutável da versão do dataset.
            expected_absent: Indica se a operação exige que o recurso ainda não exista.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.
            disk_budget: Entrada ``disk_budget``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.

        Returns:
            Valor ``EncodedPartition`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
        """
        if not isinstance(dataset_version, str) or not dataset_version:
            raise ValueError("dataset_version must be a non-empty string")
        if not isinstance(path, Path):
            raise TypeError("path must be a Path")
        if type(expected_absent) is not bool:
            raise TypeError("expected_absent must be a bool")
        if not isinstance(idempotency_key, str) or not idempotency_key:
            raise ValueError("idempotency_key must be a non-empty string")
        schema = _schema(descriptor)
        path.parent.mkdir(parents=True, exist_ok=True)
        spool: _RecordSpool | None = None
        temporary: Path | None = None
        fingerprint: str | None = None
        claimed = False
        published = False
        try:
            if disk_budget is not None:
                disk_budget.preflight("Parquet partition encoding")
                disk_budget.reserve(32 * 1024, "Parquet SQLite spool initialization")
            spool = _RecordSpool(path.parent)
            for record in records:
                validate_archive_record(record, descriptor)
                if disk_budget is not None:
                    disk_budget.reserve(
                        len(_serialize_record(record)) + 4_096,
                        "Parquet SQLite spool record",
                    )
                spool.add(record)
                if disk_budget is not None:
                    disk_budget.observe()
            assert spool.connection is not None
            spool.connection.commit()
            fingerprint = spool.fingerprint(path, descriptor, dataset_version, expected_absent)
            replay = self._claim_or_replay(idempotency_key, fingerprint)
            if replay is not None:
                return replay
            claimed = True
            if expected_absent and path.exists():
                raise ConditionalWriteError(f"partition path {path} already exists")
            if disk_budget is not None:
                disk_budget.reserve(
                    max(64 * 1024, spool.path.stat().st_size * 2),
                    "Parquet temporary partition",
                )
            with NamedTemporaryFile(
                dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
            ) as output:
                temporary = Path(output.name)
            with pq.ParquetWriter(
                temporary,
                schema,
                compression="zstd",
                use_dictionary=False,
                write_statistics=True,
                version="2.6",
                data_page_version="2.0",
            ) as writer:
                for batch in spool.ordered_batches():
                    if disk_budget is not None:
                        disk_budget.reserve(
                            max(
                                64 * 1024,
                                sum(len(_serialize_record(record)) for record in batch) * 4,
                            ),
                            "Parquet row group",
                        )
                    writer.write_table(
                        pa.Table.from_pylist(
                            [_row(record, descriptor, dataset_version, schema) for record in batch],
                            schema=schema,
                        )
                    )
                    if disk_budget is not None:
                        disk_budget.observe()
            encoded = _verify(temporary, schema, spool.count, descriptor, dataset_version)
            if disk_budget is not None:
                disk_budget.observe()
            if expected_absent:
                try:
                    os.link(temporary, path)
                except FileExistsError as error:
                    raise ConditionalWriteError(f"partition path {path} already exists") from error
                published = True
                try:
                    temporary.unlink()
                except OSError:
                    # O destino imutável já é válido. Repetir esta limpeza no finally não pode
                    # transformar um sucesso físico em uma falha ambígua.
                    pass
            else:
                os.replace(temporary, path)
                published = True
            result = EncodedPartition(
                path,
                encoded.row_count,
                encoded.byte_size,
                encoded.sha256,
                dataset=encoded.dataset,
                dataset_version=encoded.dataset_version,
                schema_version=encoded.schema_version,
                schema_fingerprint=encoded.schema_fingerprint,
            )
            self._complete_claim(idempotency_key, fingerprint, result)
            claimed = False
            return result
        finally:
            active_error = sys.exc_info()[0] is not None
            cleanup_error: OSError | None = None
            if claimed and fingerprint is not None:
                self._abandon_claim(idempotency_key, fingerprint)
            if temporary is not None and temporary.exists():
                try:
                    temporary.unlink()
                except OSError as error:
                    cleanup_error = error
            if spool is not None:
                spool.close()
            if cleanup_error is not None and not active_error and not published:
                raise cleanup_error


__all__ = [
    "ParquetEncodingError",
    "PyArrowParquetEncoder",
    "athena_schema",
    "athena_schema_for_descriptor",
    "read_partition",
    "schema_fingerprint_for_descriptor",
    "schema_for_descriptor",
    "validate_archive_record",
    "validate_canonical_record",
]
