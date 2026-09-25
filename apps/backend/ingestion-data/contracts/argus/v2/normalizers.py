"""Converte linhas das tabelas legadas ARGUS 2.0 em registros canônicos.

Papel no fluxo:
    Este módulo faz parte do contrato executável ARGUS 2.0 e define quais estruturas físicas
    podem entrar no pipeline canônico.

Garantias e limites:
    Mudanças aqui alteram a interpretação dos dados e precisam manter compatibilidade explícita
    com descritores, normalizadores e testes de contrato.
"""

from __future__ import annotations

import json
import math
import re
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import MappingProxyType
from typing import cast

from domain.datasets import DatasetColumn, DatasetDescriptor
from domain.models import CanonicalRecord, CanonicalValue, Scalar, TimeWindow
from domain.quality import BotCoverage, derive_human_errors

type Row = Mapping[str, object]
type RowNormalizer = Callable[[DatasetDescriptor, Row], CanonicalRecord]


@dataclass(frozen=True, slots=True)
class NormalizationContext:
    """Representa os dados de ``NormalizationContext`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        bot_reliable_from_ms: Entrada ``bot_reliable_from_ms``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        valid_sde_ids: Entrada ``valid_sde_ids``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
    """

    bot_reliable_from_ms: int | None = None
    valid_sde_ids: frozenset[str] | None = None

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if self.valid_sde_ids is None:
            return
        frozen_ids = frozenset(self.valid_sde_ids)
        if any(not isinstance(sde_id, str) or not sde_id.strip() for sde_id in frozen_ids):
            raise ValueError("valid_sde_ids must contain only non-empty strings")
        object.__setattr__(self, "valid_sde_ids", frozen_ids)


_UNKNOWN_DIMENSION = "UNKNOWN"
_INVALID_SOURCE_JSON = "INVALID_SOURCE_JSON"
_LIMITED_SOURCE_COVERAGE = "LIMITED_SOURCE_COVERAGE"
_SOURCE_COUNT_INCONSISTENCY = "SOURCE_COUNT_INCONSISTENCY"
_SHADOW_EXPECTED_END = "2026-08-31T23:59:59.999Z"
_SHADOW_OBSERVED_START = "2026-08-27T18:35:00.000Z"
_SHADOW_OBSERVED_END = "2026-08-31T23:48:00.000Z"
_INTEGER_TYPES = frozenset({"INT", "BIGINT", "TINYINT"})
_INTEGER_RANGES = {
    "TINYINT": (-(2**7), 2**7 - 1),
    "INT": (-(2**31), 2**31 - 1),
    "BIGINT": (-(2**63), 2**63 - 1),
}
_MAX_DOUBLE = Decimal.from_float(sys.float_info.max)
_TEXT_MAX_BYTES = 65_535
_VARCHAR_TYPE = re.compile(r"^VARCHAR\((?P<length>[1-9][0-9]*)\)$")
_ENUM_TYPE = re.compile(r"^ENUM\((?P<values>.*)\)$")
_ENUM_VALUE = re.compile(r"'((?:''|[^'])*)'")
_INCIDENT_DIMENSIONS = (
    "number",
    "priority",
    "priority_value",
    "state",
    "assignment_group",
    "business_service",
    "cmdb_ci",
    "u_this_incident_caused_external_impacts",
    "u_this_incident_was_caused_by_a_change_or_deploy",
    "parent_incident",
    "state_value",
    "category",
    "subcategory",
    "impact_component",
    "impact_component_value",
    "close_code",
    "close_code_value",
    "scr_vendor",
    "scr_vendor_ticket",
)


def _validate_row(descriptor: DatasetDescriptor, row: Row) -> dict[str, object]:
    """Valida linha contra as invariantes deste módulo.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    expected = {column.name for column in descriptor.columns}
    actual = set(row)
    if actual != expected:
        raise ValueError(
            f"{descriptor.table} physical columns differ; "
            f"missing={sorted(expected - actual)}, unknown={sorted(actual - expected)}"
        )
    converted = {
        column.name: _validate_column_value(column, row[column.name])
        for column in descriptor.columns
    }
    if any(converted[field] is None for field in descriptor.natural_key):
        raise ValueError(f"{descriptor.table} natural key cannot contain null")
    return converted


def _validate_column_value(column: DatasetColumn, value: object) -> object:
    """Valida column valor contra as invariantes deste módulo.

    Args:
        column: Entrada ``column``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``object`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if value is None:
        if column.nullable:
            return None
        raise ValueError(f"{column.name} does not allow null")
    sql_type = column.sql_type
    if sql_type in _INTEGER_TYPES:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f"{column.name} must match {sql_type}")
        minimum, maximum = _INTEGER_RANGES[sql_type]
        if not minimum <= value <= maximum:
            raise ValueError(f"{column.name} must match {sql_type} range")
        return value
    if sql_type == "DOUBLE":
        if isinstance(value, bool) or not isinstance(value, int | float | Decimal):
            raise ValueError(f"{column.name} must match DOUBLE")
        try:
            converted = Decimal(str(value))
        except ValueError as error:
            raise ValueError(f"{column.name} must match DOUBLE") from error
        if not converted.is_finite():
            raise ValueError(f"{column.name} must be finite")
        if converted.copy_abs() > _MAX_DOUBLE:
            raise ValueError(f"{column.name} must fit finite DOUBLE range")
        try:
            binary64 = float(converted)
        except (OverflowError, ValueError) as error:
            raise ValueError(f"{column.name} must fit finite DOUBLE range") from error
        if not math.isfinite(binary64):
            raise ValueError(f"{column.name} must fit finite DOUBLE range")
        if converted != 0 and binary64 == 0.0:
            raise ValueError(f"{column.name} DOUBLE underflow would lose a non-zero value")
        return converted
    if varchar := _VARCHAR_TYPE.fullmatch(sql_type):
        if not isinstance(value, str) or len(value) > int(varchar.group("length")):
            raise ValueError(f"{column.name} must match {sql_type}")
        return value
    if sql_type == "TEXT":
        if not isinstance(value, str):
            raise ValueError(f"{column.name} must match TEXT")
        try:
            encoded = value.encode("utf-8")
        except UnicodeEncodeError as error:
            raise ValueError(f"{column.name} must contain valid UTF-8 TEXT") from error
        if len(encoded) > _TEXT_MAX_BYTES:
            raise ValueError(f"{column.name} must fit TEXT byte limit")
        return value
    if enum := _ENUM_TYPE.fullmatch(sql_type):
        allowed = tuple(
            item.replace("''", "'") for item in _ENUM_VALUE.findall(enum.group("values"))
        )
        if not isinstance(value, str) or value not in allowed:
            raise ValueError(f"{column.name} must match {sql_type}")
        return value
    raise ValueError(f"{column.name} declares unsupported physical type {sql_type}")


def _epoch_ms(value: object, field: str) -> datetime:
    """Executa a etapa interna ``epoch_ms`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``datetime`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{field} must be an epoch-millisecond integer")
    return datetime.fromtimestamp(value / 1000, UTC)


def _optional_epoch_ms(value: object, field: str) -> datetime | None:
    """Converte época Unix ms quando presente e preserva a ausência como ``None``.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``datetime | None`` produzido pela operação após as validações.
    """
    if value is None:
        return None
    return _epoch_ms(value, field)


def _iso_utc(value: object, field: str) -> datetime:
    """Executa a etapa interna ``iso_utc`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``datetime`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field} must be a non-empty ISO-8601 string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"{field} must be a valid ISO-8601 datetime") from error
    if parsed.tzinfo is None:
        raise ValueError(f"{field} must include a UTC offset")
    return parsed.astimezone(UTC)


def _optional_iso_utc(value: object, field: str) -> datetime | None:
    """Converte iso utc quando presente e preserva a ausência como ``None``.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``datetime | None`` produzido pela operação após as validações.
    """
    if value is None:
        return None
    return _iso_utc(value, field)


def _canonical_scalar(value: object, field: str) -> Scalar:
    """Produz a representação canônica de scalar.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``Scalar`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if isinstance(value, Decimal) and not value.is_finite():
        raise ValueError(f"{field} must be finite")
    if value is None or isinstance(value, str | int | bool | Decimal | datetime):
        return value
    if isinstance(value, float):
        converted = Decimal(str(value))
        if not converted.is_finite():
            raise ValueError(f"{field} must be finite")
        return converted
    raise ValueError(f"{field} has unsupported physical value {type(value).__name__}")


def _reject_duplicate_json_members(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Registra a rejeição de duplicate json members com motivo seguro e limitado.

    Args:
        pairs: Entrada ``pairs``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    document: dict[str, object] = {}
    for key, item in pairs:
        if key in document:
            raise ValueError(f"duplicate JSON member {key!r}")
        document[key] = item
    return document


def _load_json_array(value: object) -> tuple[list[object] | None, bool]:
    """Carrega json lista e rejeita conteúdo incompleto ou malformado.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``tuple[list[object] | None, bool]`` produzido pela operação após as validações.
    """
    if value is None:
        return None, False
    if not isinstance(value, str):
        return None, True
    try:
        parsed = json.loads(value, object_pairs_hook=_reject_duplicate_json_members)
        if not isinstance(parsed, list):
            return None, True
        return cast(list[object], parsed), False
    except (json.JSONDecodeError, ValueError):
        return None, True


def _parse_top_names(value: object) -> tuple[CanonicalValue | None, bool]:
    """Converte principais nomes para a representação interna validada.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``tuple[CanonicalValue | None, bool]`` produzido pela operação após as validações.
    """
    items, invalid = _load_json_array(value)
    if invalid or items is None:
        return None, invalid
    if len(items) > 20:
        return None, True
    normalized: list[CanonicalValue] = []
    for item in items:
        if not isinstance(item, dict) or set(item) != {"name", "errors"}:
            return None, True
        name = item["name"]
        errors = item["errors"]
        if not isinstance(name, str) or not name.strip():
            return None, True
        if isinstance(errors, bool) or not isinstance(errors, int) or errors < 0:
            return None, True
        normalized.append({"name": name, "errors": errors})
    return normalized, False


def _parse_string_array(value: object, *, limit: int) -> tuple[CanonicalValue | None, bool]:
    """Converte string lista para a representação interna validada.

    Args:
        value: Valor não confiável que será validado ou convertido.
        limit: Quantidade máxima de itens que a operação pode processar.

    Returns:
        Valor ``tuple[CanonicalValue | None, bool]`` produzido pela operação após as validações.
    """
    items, invalid = _load_json_array(value)
    if invalid or items is None:
        return None, invalid
    if len(items) > limit:
        return None, True
    normalized: list[CanonicalValue] = []
    for item in items:
        if not isinstance(item, str) or not item.strip():
            return None, True
        normalized.append(item)
    return normalized, False


def _parse_integer_array(value: object, *, limit: int) -> tuple[CanonicalValue | None, bool]:
    """Converte inteiro lista para a representação interna validada.

    Args:
        value: Valor não confiável que será validado ou convertido.
        limit: Quantidade máxima de itens que a operação pode processar.

    Returns:
        Valor ``tuple[CanonicalValue | None, bool]`` produzido pela operação após as validações.
    """
    items, invalid = _load_json_array(value)
    if invalid or items is None:
        return None, invalid
    if len(items) > limit:
        return None, True
    normalized: list[CanonicalValue] = []
    for item in items:
        if isinstance(item, bool) or not isinstance(item, int) or item < 0:
            return None, True
        normalized.append(item)
    return normalized, False


def _boolean_tinyint(value: object, field: str) -> bool:
    """Verifica a condição associada a boolean tinyint.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if value not in (0, 1) or isinstance(value, bool):
        raise ValueError(f"{field} must be a TINYINT boolean (0 or 1)")
    return value == 1


def _with_quality(record: CanonicalRecord, additions: Mapping[str, Scalar]) -> CanonicalRecord:
    """Devolve uma cópia imutável da instância com qualidade substituído.

    Args:
        record: Registro canônico consumido pela operação.
        additions: Entrada ``additions``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    return replace(record, quality={**record.quality, **additions})


def _validate_application_error_counts(row: Row) -> tuple[str, ...]:
    """Valida aplicação erro contagens contra as invariantes deste módulo.

    Args:
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Flags de qualidade derivadas sem alterar as medidas recebidas da origem.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    errors = cast(int, row["errors"])
    devices = cast(int | None, row["devices"])
    if errors < 0:
        raise ValueError("errors cannot be negative")
    if devices is not None and devices < 0:
        raise ValueError("devices cannot be negative")
    return (
        (_SOURCE_COUNT_INCONSISTENCY,)
        if devices is not None and devices > errors
        else ()
    )


def _validated_sde_id(value: object) -> str | None:
    """Calcula ou valida o identificador de validated sde.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str | None`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    sde_id = cast(str | None, value)
    if sde_id is not None and not sde_id.strip():
        raise ValueError("sde_id must be a non-empty string or null")
    return sde_id


def _observed_at(descriptor: DatasetDescriptor, row: Row) -> datetime | None:
    """Executa a etapa interna ``observed_at`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``datetime | None`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    field = descriptor.timestamp_field
    if field is None:
        raise ValueError(f"{descriptor.table} must declare a timestamp field")
    if row[field] is None:
        return None
    sql_type = next(column.sql_type for column in descriptor.columns if column.name == field)
    if sql_type == "BIGINT":
        return _epoch_ms(row[field], field)
    if sql_type.startswith("VARCHAR"):
        return _iso_utc(row[field], field)
    raise ValueError(f"{descriptor.table}.{field} has unsupported timestamp type {sql_type}")


def _record(
    descriptor: DatasetDescriptor,
    row: Row,
    *,
    dimension_fields: Sequence[str],
    measure_fields: Sequence[str],
    overrides: Mapping[str, CanonicalValue] | None = None,
    additional_dimensions: Mapping[str, CanonicalValue] | None = None,
    quality_flags: Sequence[str] = (),
) -> CanonicalRecord:
    """Obtém ou registra a entrada como evidência da execução atual.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        dimension_fields: Entrada ``dimension_fields``; a forma aceita é definida pela anotação
        de tipo e validada antes do uso.
        measure_fields: Entrada ``measure_fields``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        overrides: Entrada ``overrides``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        additional_dimensions: Entrada ``additional_dimensions``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        quality_flags: Entrada ``quality_flags``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    values = dict(row)
    if overrides:
        values.update(overrides)
    observed_at = _observed_at(descriptor, values)
    dimensions = {
        field: cast(CanonicalValue, _canonical_scalar(values[field], field))
        for field in dimension_fields
    }
    if additional_dimensions:
        dimensions.update(additional_dimensions)
    measures = {
        field: cast(CanonicalValue, _canonical_scalar(values[field], field))
        for field in measure_fields
    }
    return CanonicalRecord(
        schema_version="1.0",
        record_type=descriptor.record_type,
        source_system="argus",
        source_dataset=descriptor.table,
        natural_key=tuple(
            (field, _canonical_scalar(values[field], field)) for field in descriptor.natural_key
        ),
        observed_at=observed_at,
        window=(
            TimeWindow(
                start=observed_at,
                end=observed_at + timedelta(seconds=descriptor.grain_seconds),
                grain_seconds=descriptor.grain_seconds,
            )
            if observed_at is not None and descriptor.grain_seconds is not None
            else None
        ),
        dimensions=dimensions,
        measures=measures,
        quality={"coveragePolicy": descriptor.coverage_policy},
        quality_flags=tuple(quality_flags),
    )


def _normalize_signal_bucket(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza signal bucket para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    return _record(
        descriptor,
        row,
        dimension_fields=("source", "entity", "metric"),
        measure_fields=("value",),
    )


def _normalize_live_active_15min(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza live ativo 15min para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    return _record(
        descriptor,
        row,
        dimension_fields=("sinal",),
        measure_fields=(
            "active_sessions",
            "active_with_error",
            "joins_in_bucket",
            "latency_ms_p50",
            "latency_ms_p95",
            "bufferratio_avg",
            "jointime_s_avg",
            "dropped_frames_avg",
        ),
    )


def _normalize_live_qoe_hourly(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza live qoe hourly para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    return _record(
        descriptor,
        row,
        dimension_fields=("sinal",),
        measure_fields=(
            "sessions",
            "errors",
            "startup_errors",
            "latency_ms_avg",
            "latency_ms_p50",
            "latency_ms_p95",
            "bufferratio_avg",
            "jointime_s_avg",
            "dropped_frames_avg",
            "stalls_avg",
        ),
    )


def _normalize_player_hourly(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza player hourly para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    return _record(
        descriptor,
        row,
        dimension_fields=("player",),
        measure_fields=("sessions", "errors"),
    )


def _normalize_device_hourly(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza device hourly para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    return _record(
        descriptor,
        row,
        dimension_fields=("device",),
        measure_fields=("sessions", "errors"),
    )


def _normalize_geo_hourly(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza geo hourly para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    overrides = {
        field: _UNKNOWN_DIMENSION if row[field] == "?" else _canonical_scalar(row[field], field)
        for field in ("state_province", "isp")
    }
    return _record(
        descriptor,
        row,
        dimension_fields=("state_province", "isp"),
        measure_fields=("sessions", "errors"),
        overrides=overrides,
    )


def _normalize_live_error_attr_hourly(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza live erro attr hourly para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    return _record(
        descriptor,
        row,
        dimension_fields=("sinal", "cdn", "tier", "http_code", "error_name"),
        measure_fields=("errors",),
    )


def _normalize_error_cat_hourly(
    descriptor: DatasetDescriptor,
    row: Row,
    context: NormalizationContext | None = None,
) -> CanonicalRecord:
    """Normaliza erro cat hourly para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        context: Contexto validado compartilhado durante o processamento.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    normalization_context = context or NormalizationContext()
    top_names, invalid = _parse_top_names(row["top_names"])
    record = _record(
        descriptor,
        row,
        dimension_fields=("kind", "category"),
        measure_fields=("errors",),
        quality_flags=(_INVALID_SOURCE_JSON,) if invalid else (),
    )
    hour_ts = cast(int, row["hour_ts"])
    bot_coverage = (
        BotCoverage.RELIABLE
        if normalization_context.bot_reliable_from_ms is not None
        and hour_ts >= normalization_context.bot_reliable_from_ms
        else BotCoverage.AMBIGUOUS_DEFAULT_ZERO
    )
    errors = cast(int, row["errors"])
    errors_bot = cast(int, row["errors_bot"])
    record = record.with_measures(
        {
            **record.measures,
            "errorsBot": errors_bot,
            "humanErrors": derive_human_errors(errors, errors_bot, bot_coverage),
            "topNames": top_names,
        }
    )
    return _with_quality(record, {"botCoverageStatus": bot_coverage.value})


def _normalize_app_error(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza app erro para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    return _record(
        descriptor,
        row,
        dimension_fields=(),
        measure_fields=("errors", "devices"),
        additional_dimensions={
            "errorCode": cast(CanonicalValue, row["error_code"]),
            "manufacturer": cast(CanonicalValue, row["manufacturer"]),
        },
        quality_flags=(
            _LIMITED_SOURCE_COVERAGE,
            *_validate_application_error_counts(row),
        ),
    )


def _normalize_app_error_model(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza app erro model para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    return _record(
        descriptor,
        row,
        dimension_fields=(),
        measure_fields=("errors", "devices"),
        additional_dimensions={
            "errorCode": cast(CanonicalValue, row["error_code"]),
            "manufacturer": cast(CanonicalValue, row["manufacturer"]),
            "model": cast(CanonicalValue, row["model"]),
        },
        quality_flags=(
            _LIMITED_SOURCE_COVERAGE,
            *_validate_application_error_counts(row),
        ),
    )


def _normalize_app_error_version(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza app erro versão para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    return _record(
        descriptor,
        row,
        dimension_fields=(),
        measure_fields=("errors", "devices"),
        additional_dimensions={
            "errorCode": cast(CanonicalValue, row["error_code"]),
            "appVersion": cast(CanonicalValue, row["app_version"]),
        },
        quality_flags=(
            _LIMITED_SOURCE_COVERAGE,
            *_validate_application_error_counts(row),
        ),
    )


def _normalize_cdn_vod_shadow(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza cdn vod shadow para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    record = _record(
        descriptor,
        row,
        dimension_fields=("entity",),
        measure_fields=(),
        quality_flags=(_LIMITED_SOURCE_COVERAGE,),
    ).with_measures(
        {
            "req2xx": cast(CanonicalValue, row["req_2xx"]),
            "errors4xx": cast(CanonicalValue, row["err_4xx"]),
            "errors5xx": cast(CanonicalValue, row["err_5xx"]),
        }
    )
    return _with_quality(
        record,
        {
            "sourceLifecycle": "retired_experiment",
            "sourceCoverageStatus": "limited_known",
            "observedStart": _SHADOW_OBSERVED_START,
            "observedEnd": _SHADOW_OBSERVED_END,
            "expectedEnd": _SHADOW_EXPECTED_END,
        },
    )


def _normalize_finding_status_log(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza finding status log para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    record = _record(
        descriptor,
        row,
        dimension_fields=(),
        measure_fields=("volume",),
        additional_dimensions={
            "findingId": cast(CanonicalValue, row["finding_id"]),
            "fromStatus": cast(CanonicalValue, row["from_status"]),
            "toStatus": cast(CanonicalValue, row["to_status"]),
            "resolved": row["to_status"] == "resolved",
            "unit": cast(CanonicalValue, row["unit"]),
        },
    )
    return _with_quality(record, {"labelAuthority": "derived", "goldenSetEligible": False})


def _normalize_live_event_sde(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza live evento sde para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    sde_id = _validated_sde_id(row["sde_id"])
    tids_jarvis, invalid_jarvis = _parse_integer_array(row["tids_jarvis"], limit=100)
    tids_epg, invalid_epg = _parse_integer_array(row["tids_epg"], limit=100)
    tid_only_epg, invalid_only_epg = _parse_integer_array(row["tid_only_epg"], limit=100)
    tid_only_jarvis, invalid_only_jarvis = _parse_integer_array(row["tid_only_jarvis"], limit=100)
    epg_teams, invalid_teams = _parse_string_array(row["epg_teams"], limit=4)
    invalid_json = any(
        (invalid_jarvis, invalid_epg, invalid_only_epg, invalid_only_jarvis, invalid_teams)
    )
    record = _record(
        descriptor,
        row,
        dimension_fields=(),
        measure_fields=(),
        additional_dimensions={
            "sdeId": sde_id,
            "teamHome": cast(CanonicalValue, row["team_home"]),
            "teamAway": cast(CanonicalValue, row["team_away"]),
            "competition": cast(CanonicalValue, row["competition"]),
            "status": cast(CanonicalValue, row["status"]),
            "isFinished": _boolean_tinyint(row["is_finished"], "is_finished"),
            "tidsJarvis": tids_jarvis,
            "tidsEpg": tids_epg,
            "tidOnlyEpg": tid_only_epg,
            "tidOnlyJarvis": tid_only_jarvis,
            "nameMismatch": _boolean_tinyint(row["name_mismatch"], "name_mismatch"),
            "epgTeams": epg_teams,
        },
        quality_flags=(_INVALID_SOURCE_JSON,) if invalid_json else (),
    )
    return record.with_measures({"updatedAt": _epoch_ms(row["updated_at"], "updated_at")})


def _normalize_live_event(
    descriptor: DatasetDescriptor,
    row: Row,
    context: NormalizationContext | None = None,
) -> CanonicalRecord:
    """Normaliza live evento para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        context: Contexto validado compartilhado durante o processamento.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    normalization_context = context or NormalizationContext()
    sde_id = _validated_sde_id(row["sde_id"])
    record = _record(
        descriptor,
        row,
        dimension_fields=(),
        measure_fields=(),
        additional_dimensions={
            "eventKey": cast(CanonicalValue, row["event_key"]),
            "eventDate": cast(CanonicalValue, row["event_date"]),
            "slug": cast(CanonicalValue, row["slug"]),
            "channel": cast(CanonicalValue, row["channel"]),
            "competition": cast(CanonicalValue, row["competition"]),
            "program": cast(CanonicalValue, row["program"]),
            "sport": cast(CanonicalValue, row["sport"]),
            "teamHome": cast(CanonicalValue, row["team_home"]),
            "teamAway": cast(CanonicalValue, row["team_away"]),
            "sdeId": sde_id,
            "guiaSlotId": cast(CanonicalValue, row["guia_slot_id"]),
            "urlProgram": cast(CanonicalValue, row["url_program"]),
        },
    )
    start_ts = cast(int, row["start_ts"])
    end_ts = cast(int, row["end_ts"])
    record = replace(
        record,
        window=TimeWindow.from_epoch_ms(start_ts, end_ts),
        measures={
            "firstSeenAt": _epoch_ms(row["first_seen_ts"], "first_seen_ts"),
            "updatedAt": _epoch_ms(row["updated_at"], "updated_at"),
        },
    )
    if sde_id is None:
        match_status = "unmatched"
    elif normalization_context.valid_sde_ids is None:
        match_status = "sde_id_present_unverified"
    elif sde_id in normalization_context.valid_sde_ids:
        match_status = "matched_by_sde_id"
    else:
        match_status = "orphaned_sde_id"
    return _with_quality(record, {"sportsMatchStatus": match_status})


def _normalize_incidents(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza incidentes para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    children, invalid = _parse_string_array(row["child_incidents"], limit=100)
    record = _record(
        descriptor,
        row,
        dimension_fields=_INCIDENT_DIMENSIONS,
        measure_fields=(),
        additional_dimensions={"childIncidents": children},
        quality_flags=(_INVALID_SOURCE_JSON,) if invalid else (),
    )
    return record.with_measures(
        {
            "resolved_at": _optional_epoch_ms(row["resolved_at"], "resolved_at"),
            "closed_at": _optional_epoch_ms(row["closed_at"], "closed_at"),
        }
    )


def _normalize_signal_meta(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza signal meta para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    record = _record(
        descriptor,
        row,
        dimension_fields=("source",),
        measure_fields=("rows_total", "rows_last_run"),
    )
    return record.with_measures(
        {
            **record.measures,
            "last_run_at": _optional_iso_utc(row["last_run_at"], "last_run_at"),
        }
    )


def _normalize_collector_run(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza collector execução para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    record = _record(
        descriptor,
        row,
        dimension_fields=("source",),
        measure_fields=("rows_upserted", "bytes_scanned", "cost_usd", "duration_s"),
    )
    return record.with_measures(
        {
            **record.measures,
            "finished_at": _optional_epoch_ms(row["finished_at"], "finished_at"),
            "range_start": _optional_epoch_ms(row["range_start"], "range_start"),
            "range_end": _optional_epoch_ms(row["range_end"], "range_end"),
        }
    )


def _normalize_apollo_run(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza apollo execução para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    record = _record(
        descriptor,
        row,
        dimension_fields=("kind",),
        measure_fields=("pages", "rows_inserted", "rows_updated", "duration_s"),
    )
    return record.with_measures(
        {
            **record.measures,
            "finished_at": _optional_iso_utc(row["finished_at"], "finished_at"),
            "range_start": _optional_iso_utc(row["range_start"], "range_start"),
            "range_end": _optional_iso_utc(row["range_end"], "range_end"),
        }
    )


def _normalize_ca_run(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza ca execução para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    record = _record(
        descriptor,
        row,
        dimension_fields=(),
        measure_fields=("points_inserted", "duration_s"),
    )
    return record.with_measures(
        {
            **record.measures,
            "finished_at": _optional_iso_utc(row["finished_at"], "finished_at"),
            "range_start_ms": _optional_epoch_ms(row["range_start_ms"], "range_start_ms"),
            "range_end_ms": _optional_epoch_ms(row["range_end_ms"], "range_end_ms"),
        }
    )


def _normalize_nr_run(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza nr execução para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    record = _record(
        descriptor,
        row,
        dimension_fields=("kind", "account_id"),
        measure_fields=("rows_seen", "rows_inserted", "duration_s"),
    )
    return record.with_measures(
        {**record.measures, "finished_at": _optional_iso_utc(row["finished_at"], "finished_at")}
    )


def _normalize_prom_run(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza prom execução para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    record = _record(
        descriptor,
        row,
        dimension_fields=(),
        measure_fields=(
            "step_s",
            "queries_total",
            "queries_ok",
            "queries_err",
            "series_touched",
            "points_inserted",
            "duration_s",
        ),
    )
    return record.with_measures(
        {
            **record.measures,
            "finished_at": _optional_iso_utc(row["finished_at"], "finished_at"),
            "range_start_ms": _optional_epoch_ms(row["range_start_ms"], "range_start_ms"),
            "range_end_ms": _optional_epoch_ms(row["range_end_ms"], "range_end_ms"),
        }
    )


def _normalize_rpaas_run(descriptor: DatasetDescriptor, row: Row) -> CanonicalRecord:
    """Normaliza rpaas execução para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.
    """
    regions, invalid = _parse_string_array(row["regions"], limit=64)
    record = _record(
        descriptor,
        row,
        dimension_fields=(),
        measure_fields=("entries_read", "buckets_upd", "duration_s"),
        quality_flags=(_INVALID_SOURCE_JSON,) if invalid else (),
    )
    return record.with_measures(
        {
            **record.measures,
            "finished_at": _optional_iso_utc(row["finished_at"], "finished_at"),
            "range_start": _optional_iso_utc(row["range_start"], "range_start"),
            "range_end": _optional_iso_utc(row["range_end"], "range_end"),
            "regions": regions,
        }
    )


NORMALIZERS: Mapping[str, RowNormalizer] = MappingProxyType(
    {
        "signal_bucket": _normalize_signal_bucket,
        "live_active_15min": _normalize_live_active_15min,
        "live_qoe_hourly": _normalize_live_qoe_hourly,
        "player_hourly": _normalize_player_hourly,
        "device_hourly": _normalize_device_hourly,
        "geo_hourly": _normalize_geo_hourly,
        "live_error_attr_hourly": _normalize_live_error_attr_hourly,
        "error_cat_hourly": _normalize_error_cat_hourly,
        "app_error": _normalize_app_error,
        "app_error_model": _normalize_app_error_model,
        "app_error_version": _normalize_app_error_version,
        "cdn_vod_shadow": _normalize_cdn_vod_shadow,
        "finding_status_log": _normalize_finding_status_log,
        "live_event_sde": _normalize_live_event_sde,
        "live_event": _normalize_live_event,
        "incidents": _normalize_incidents,
        "signal_meta": _normalize_signal_meta,
        "collector_run": _normalize_collector_run,
        "apollo_run": _normalize_apollo_run,
        "ca_run": _normalize_ca_run,
        "nr_run": _normalize_nr_run,
        "prom_run": _normalize_prom_run,
        "rpaas_run": _normalize_rpaas_run,
    }
)


def normalize_row(
    descriptor: DatasetDescriptor,
    row: Row,
    context: NormalizationContext | None = None,
) -> CanonicalRecord:
    """Normaliza linha para o modelo canônico da ingestão.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        row: Entrada ``row``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        context: Contexto validado compartilhado durante o processamento.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if descriptor.normalizer != descriptor.table:
        raise ValueError(
            f"descriptor normalizer {descriptor.normalizer!r} does not match "
            f"table {descriptor.table!r}"
        )
    try:
        normalizer = NORMALIZERS[descriptor.normalizer]
    except KeyError as error:
        raise ValueError(f"normalizer {descriptor.normalizer!r} is not implemented") from error
    validated_row = _validate_row(descriptor, row)
    if descriptor.normalizer == "error_cat_hourly":
        return _normalize_error_cat_hourly(descriptor, validated_row, context)
    if descriptor.normalizer == "live_event":
        return _normalize_live_event(descriptor, validated_row, context)
    return normalizer(descriptor, validated_row)


__all__ = ["NORMALIZERS", "NormalizationContext", "RowNormalizer", "normalize_row"]
