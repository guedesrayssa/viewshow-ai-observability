"""Valida e projeta registros canônicos para o esquema físico do arquivo histórico.

Papel no fluxo:
    Este arquivo pertence ao núcleo de domínio e deve permanecer determinístico, sem acesso a
    rede, sistema de arquivos, banco de dados ou variáveis de ambiente.

Garantias e limites:
    As validações falham de forma fechada: valores ambíguos ou incompletos são rejeitados antes
    de atravessar uma porta de persistência.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from datetime import datetime, timedelta
from decimal import Decimal

from domain.datasets import DatasetColumn, DatasetDescriptor
from domain.models import CanonicalRecord

_INTEGER_TYPES = frozenset({"INT", "BIGINT", "TINYINT"})

CANONICAL_TIMESTAMP_COLUMNS = frozenset(
    {
        "resolved_at",
        "closed_at",
        "last_run_at",
        "finished_at",
        "range_start",
        "range_end",
        "range_start_ms",
        "range_end_ms",
        "kickoff_ts",
        "updated_at",
        "first_seen_ts",
        "end_ts",
    }
)

ARCHIVE_SHAPES: Mapping[str, tuple[Mapping[str, str], Mapping[str, str], Mapping[str, str]]] = {
    "signal_bucket": (
        {"source": "string", "entity": "string", "metric": "string"},
        {"value": "decimal"},
        {"coveragePolicy": "string"},
    ),
    "live_active_15min": (
        {"sinal": "string"},
        {
            "active_sessions": "int",
            "active_with_error": "int",
            "joins_in_bucket": "int",
            "latency_ms_p50": "decimal",
            "latency_ms_p95": "decimal",
            "bufferratio_avg": "decimal",
            "jointime_s_avg": "decimal",
            "dropped_frames_avg": "decimal",
        },
        {"coveragePolicy": "string"},
    ),
    "live_qoe_hourly": (
        {"sinal": "string"},
        {
            "sessions": "int",
            "errors": "int",
            "startup_errors": "int",
            "latency_ms_avg": "decimal",
            "latency_ms_p50": "decimal",
            "latency_ms_p95": "decimal",
            "bufferratio_avg": "decimal",
            "jointime_s_avg": "decimal",
            "dropped_frames_avg": "decimal",
            "stalls_avg": "decimal",
        },
        {"coveragePolicy": "string"},
    ),
    "player_hourly": (
        {"player": "string"},
        {"sessions": "int", "errors": "int"},
        {"coveragePolicy": "string"},
    ),
    "device_hourly": (
        {"device": "string"},
        {"sessions": "int", "errors": "int"},
        {"coveragePolicy": "string"},
    ),
    "geo_hourly": (
        {"state_province": "string", "isp": "string"},
        {"sessions": "int", "errors": "int"},
        {"coveragePolicy": "string"},
    ),
    "live_error_attr_hourly": (
        {
            "sinal": "string",
            "cdn": "string",
            "tier": "string",
            "http_code": "string",
            "error_name": "string",
        },
        {"errors": "int"},
        {"coveragePolicy": "string"},
    ),
    "error_cat_hourly": (
        {"kind": "string", "category": "string"},
        {
            "errors": "int",
            "errorsBot": "int",
            "humanErrors": "int",
            "topNames": "list[topName]",
        },
        {"coveragePolicy": "string", "botCoverageStatus": "string"},
    ),
    "incidents": (
        {
            "number": "string",
            "priority": "string",
            "priority_value": "string",
            "state": "string",
            "assignment_group": "string",
            "business_service": "string",
            "cmdb_ci": "string",
            "u_this_incident_caused_external_impacts": "string",
            "u_this_incident_was_caused_by_a_change_or_deploy": "string",
            "parent_incident": "string",
            "state_value": "string",
            "category": "string",
            "subcategory": "string",
            "impact_component": "string",
            "impact_component_value": "string",
            "close_code": "string",
            "close_code_value": "string",
            "scr_vendor": "string",
            "scr_vendor_ticket": "string",
            "childIncidents": "list[string]",
        },
        {"resolved_at": "timestamp", "closed_at": "timestamp"},
        {"coveragePolicy": "string"},
    ),
    "signal_meta": (
        {"source": "string"},
        {"rows_total": "int", "rows_last_run": "int", "last_run_at": "timestamp"},
        {"coveragePolicy": "string"},
    ),
    "collector_run": (
        {"source": "string"},
        {
            "rows_upserted": "int",
            "bytes_scanned": "int",
            "cost_usd": "decimal",
            "duration_s": "decimal",
            "finished_at": "timestamp",
            "range_start": "timestamp",
            "range_end": "timestamp",
        },
        {"coveragePolicy": "string"},
    ),
    "apollo_run": (
        {"kind": "string"},
        {
            "pages": "int",
            "rows_inserted": "int",
            "rows_updated": "int",
            "duration_s": "decimal",
            "finished_at": "timestamp",
            "range_start": "timestamp",
            "range_end": "timestamp",
        },
        {"coveragePolicy": "string"},
    ),
    "ca_run": (
        {},
        {
            "points_inserted": "int",
            "duration_s": "decimal",
            "finished_at": "timestamp",
            "range_start_ms": "timestamp",
            "range_end_ms": "timestamp",
        },
        {"coveragePolicy": "string"},
    ),
    "nr_run": (
        {"kind": "string", "account_id": "int"},
        {
            "rows_seen": "int",
            "rows_inserted": "int",
            "duration_s": "decimal",
            "finished_at": "timestamp",
        },
        {"coveragePolicy": "string"},
    ),
    "prom_run": (
        {},
        {
            "step_s": "int",
            "queries_total": "int",
            "queries_ok": "int",
            "queries_err": "int",
            "series_touched": "int",
            "points_inserted": "int",
            "duration_s": "decimal",
            "finished_at": "timestamp",
            "range_start_ms": "timestamp",
            "range_end_ms": "timestamp",
        },
        {"coveragePolicy": "string"},
    ),
    "rpaas_run": (
        {},
        {
            "entries_read": "int",
            "buckets_upd": "int",
            "duration_s": "decimal",
            "finished_at": "timestamp",
            "range_start": "timestamp",
            "range_end": "timestamp",
            "regions": "list[string]",
        },
        {"coveragePolicy": "string"},
    ),
    "app_error": (
        {"errorCode": "string", "manufacturer": "string"},
        {"errors": "int", "devices": "int"},
        {"coveragePolicy": "string"},
    ),
    "app_error_model": (
        {"errorCode": "string", "manufacturer": "string", "model": "string"},
        {"errors": "int", "devices": "int"},
        {"coveragePolicy": "string"},
    ),
    "app_error_version": (
        {"errorCode": "string", "appVersion": "string"},
        {"errors": "int", "devices": "int"},
        {"coveragePolicy": "string"},
    ),
    "cdn_vod_shadow": (
        {"entity": "string"},
        {"req2xx": "decimal", "errors4xx": "decimal", "errors5xx": "decimal"},
        {
            "coveragePolicy": "string",
            "sourceLifecycle": "string",
            "sourceCoverageStatus": "string",
            "observedStart": "string",
            "observedEnd": "string",
            "expectedEnd": "string",
        },
    ),
    "finding_status_log": (
        {
            "findingId": "string",
            "fromStatus": "string",
            "toStatus": "string",
            "resolved": "bool",
            "unit": "string",
        },
        {"volume": "int"},
        {"coveragePolicy": "string", "labelAuthority": "string", "goldenSetEligible": "bool"},
    ),
    "live_event_sde": (
        {
            "sdeId": "string",
            "teamHome": "string",
            "teamAway": "string",
            "competition": "string",
            "status": "string",
            "isFinished": "bool",
            "tidsJarvis": "list[int]",
            "tidsEpg": "list[int]",
            "tidOnlyEpg": "list[int]",
            "tidOnlyJarvis": "list[int]",
            "nameMismatch": "bool",
            "epgTeams": "list[string]",
        },
        {"updatedAt": "timestamp"},
        {"coveragePolicy": "string"},
    ),
    "live_event": (
        {
            "eventKey": "string",
            "eventDate": "string",
            "slug": "string",
            "channel": "string",
            "competition": "string",
            "program": "string",
            "sport": "string",
            "teamHome": "string",
            "teamAway": "string",
            "sdeId": "string",
            "guiaSlotId": "int",
            "urlProgram": "string",
        },
        {"firstSeenAt": "timestamp", "updatedAt": "timestamp"},
        {"coveragePolicy": "string", "sportsMatchStatus": "string"},
    ),
}

CANONICAL_COLUMN_ALIASES: Mapping[str, Mapping[str, str]] = {
    "app_error": {"error_code": "errorCode"},
    "app_error_model": {"error_code": "errorCode"},
    "app_error_version": {"error_code": "errorCode", "app_version": "appVersion"},
    "cdn_vod_shadow": {
        "req_2xx": "req2xx",
        "err_4xx": "errors4xx",
        "err_5xx": "errors5xx",
    },
    "error_cat_hourly": {"errors_bot": "errorsBot", "top_names": "topNames"},
    "finding_status_log": {"from_status": "fromStatus", "to_status": "toStatus"},
    "live_event_sde": {
        "sde_id": "sdeId",
        "team_home": "teamHome",
        "team_away": "teamAway",
        "is_finished": "isFinished",
        "tids_jarvis": "tidsJarvis",
        "tids_epg": "tidsEpg",
        "tid_only_epg": "tidOnlyEpg",
        "tid_only_jarvis": "tidOnlyJarvis",
        "name_mismatch": "nameMismatch",
        "epg_teams": "epgTeams",
        "updated_at": "updatedAt",
    },
    "live_event": {
        "end_ts": "_window_end",
        "event_key": "eventKey",
        "event_date": "eventDate",
        "team_home": "teamHome",
        "team_away": "teamAway",
        "sde_id": "sdeId",
        "guia_slot_id": "guiaSlotId",
        "url_program": "urlProgram",
        "first_seen_ts": "firstSeenAt",
        "updated_at": "updatedAt",
    },
    "incidents": {"child_incidents": "childIncidents"},
}

ANALYTIC_JSON_KINDS: Mapping[tuple[str, str], str] = {
    ("error_cat_hourly", "top_names"): "list[topName]",
    ("incidents", "child_incidents"): "list[string]",
    ("rpaas_run", "regions"): "list[string]",
    ("live_event_sde", "tids_jarvis"): "list[int]",
    ("live_event_sde", "tids_epg"): "list[int]",
    ("live_event_sde", "tid_only_epg"): "list[int]",
    ("live_event_sde", "tid_only_jarvis"): "list[int]",
    ("live_event_sde", "epg_teams"): "list[string]",
}

_CANONICAL_NULLABLE_OVERRIDES = frozenset(
    {
        ("error_cat_hourly", "measures", "humanErrors"),
    }
)
_ABSENT = object()


class ArchiveRecordValidationError(ValueError):
    """Indica que ``ArchiveRecordValidationError`` impediu a operação de continuar com
    segurança.
    """


def physical_field_nullable(descriptor: DatasetDescriptor, column: DatasetColumn) -> bool:
    """Verifica a condição associada a physical campo nullable.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        column: Entrada ``column``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.
    """
    return column.nullable or (descriptor.table, column.name) in ANALYTIC_JSON_KINDS


def canonical_field_nullable(descriptor: DatasetDescriptor, namespace: str, field: str) -> bool:
    """Produz a representação canônica de campo nullable.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        namespace: Entrada ``namespace``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.
    """
    if namespace == "quality":
        return False
    if (descriptor.table, namespace, field) in _CANONICAL_NULLABLE_OVERRIDES:
        return True
    aliases = CANONICAL_COLUMN_ALIASES.get(descriptor.table, {})
    for column in descriptor.columns:
        if aliases.get(column.name, column.name) == field:
            return physical_field_nullable(descriptor, column)
    return False


def physical_value(
    record: CanonicalRecord, descriptor: DatasetDescriptor, column: DatasetColumn
) -> object:
    """Produz o valor de physical usado pela etapa seguinte.

    Args:
        record: Registro canônico consumido pela operação.
        descriptor: Descritor físico e semântico do dataset processado.
        column: Entrada ``column``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``object`` produzido pela operação após as validações.

    Raises:
        ArchiveRecordValidationError: Se a operação não puder preservar as invariantes
        descritas.
    """
    natural = dict(record.natural_key)
    if column.name == descriptor.timestamp_field:
        return record.observed_at
    if column.name in natural:
        return natural[column.name]
    alias = CANONICAL_COLUMN_ALIASES.get(record.source_dataset, {}).get(column.name)
    candidates: list[object] = []
    for values in (record.dimensions, record.measures):
        if column.name in values:
            candidates.append(values[column.name])
        if alias is not None and alias != "_window_end" and alias in values:
            candidates.append(values[alias])
    if alias == "_window_end" and record.window is not None:
        candidates.append(record.window.end)
    if len(candidates) > 1:
        raise ArchiveRecordValidationError(
            f"{record.source_dataset}.{column.name} has multiple canonical sources"
        )
    value = candidates[0] if candidates else _ABSENT
    if value is _ABSENT:
        if physical_field_nullable(descriptor, column):
            return None
        raise ArchiveRecordValidationError(
            f"{record.source_dataset}.{column.name} is required by the descriptor "
            "but absent canonically"
        )
    if value is None:
        if physical_field_nullable(descriptor, column):
            return None
        raise ArchiveRecordValidationError(f"{column.name} does not allow null")
    if column.sql_type == "DOUBLE":
        if not isinstance(value, Decimal) or not value.is_finite():
            raise ArchiveRecordValidationError(f"{column.name} must be a finite Decimal")
        try:
            projected = 0.0 if value.is_zero() else float(value)
        except (OverflowError, ValueError) as error:
            raise ArchiveRecordValidationError(
                f"{column.name} must fit finite DOUBLE range"
            ) from error
        if not math.isfinite(projected) or (not value.is_zero() and projected == 0.0):
            raise ArchiveRecordValidationError(f"{column.name} must fit finite DOUBLE range")
        return projected
    if column.sql_type in _INTEGER_TYPES and not isinstance(value, datetime):
        if isinstance(value, bool) and column.sql_type == "TINYINT":
            return int(value)
        if isinstance(value, int) and not isinstance(value, bool):
            return value
        raise ArchiveRecordValidationError(f"{column.name} must be an integer")
    return value


def _validate_timestamp(value: object, field: str) -> None:
    """Valida timestamp contra as invariantes deste módulo.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        ArchiveRecordValidationError: Se a operação não puder preservar as invariantes
        descritas.
    """
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ArchiveRecordValidationError(f"{field} must be an aware UTC datetime")


def _validate_value(value: object, kind: str, field: str, *, nullable: bool) -> None:
    """Valida valor contra as invariantes deste módulo.

    Args:
        value: Valor não confiável que será validado ou convertido.
        kind: Entrada ``kind``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        field: Nome do campo usado para produzir mensagens de validação precisas.
        nullable: Entrada ``nullable``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        ArchiveRecordValidationError: Se a operação não puder preservar as invariantes
        descritas.
    """
    if value is None:
        if nullable:
            return
        raise ArchiveRecordValidationError(f"{field} does not allow null")
    if kind == "string":
        valid = isinstance(value, str)
    elif kind == "int":
        valid = isinstance(value, int) and not isinstance(value, bool)
    elif kind == "bool":
        valid = type(value) is bool
    elif kind == "decimal":
        valid = isinstance(value, Decimal) and value.is_finite()
    elif kind == "timestamp":
        _validate_timestamp(value, field)
        return
    elif kind in {"list[string]", "list[int]", "list[topName]"}:
        if not isinstance(value, tuple | list):
            raise ArchiveRecordValidationError(f"{field} must be a canonical list")
        item_kind = {"list[string]": "string", "list[int]": "int"}.get(kind)
        for item in value:
            item_field = f"{field}.element"
            if item_kind is not None:
                _validate_value(item, item_kind, item_field, nullable=False)
                continue
            if not isinstance(item, Mapping) or set(item) != {"name", "errors"}:
                raise ArchiveRecordValidationError(
                    f"{field}.element must be a closed topName struct"
                )
            _validate_value(item["name"], "string", f"{item_field}.name", nullable=False)
            _validate_value(item["errors"], "int", f"{item_field}.errors", nullable=False)
        return
    else:
        raise ArchiveRecordValidationError(f"{field} declares unsupported kind {kind}")
    if not valid:
        raise ArchiveRecordValidationError(f"{field} must be {kind}")


def _validate_namespace(
    record: CanonicalRecord,
    descriptor: DatasetDescriptor,
    namespace: str,
    actual: object,
    expected: Mapping[str, str],
) -> None:
    """Valida namespace contra as invariantes deste módulo.

    Args:
        record: Registro canônico consumido pela operação.
        descriptor: Descritor físico e semântico do dataset processado.
        namespace: Entrada ``namespace``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        actual: Entrada ``actual``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        expected: Entrada ``expected``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        ArchiveRecordValidationError: Se a operação não puder preservar as invariantes
        descritas.
    """
    if not isinstance(actual, Mapping) or set(actual) != set(expected):
        raise ArchiveRecordValidationError(
            f"record {namespace} differs from the closed canonical schema"
        )
    for field, kind in expected.items():
        _validate_value(
            actual[field],
            kind,
            f"{namespace}.{field}",
            nullable=canonical_field_nullable(descriptor, namespace, field),
        )


def _natural_kind(column: DatasetColumn) -> str:
    """Executa a etapa interna ``natural_kind`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        column: Entrada ``column``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    if column.sql_type == "DOUBLE":
        return "decimal"
    if column.sql_type in _INTEGER_TYPES:
        return "int"
    return "string"


def _validate_physical_projection(
    record: CanonicalRecord, descriptor: DatasetDescriptor, column: DatasetColumn
) -> None:
    """Valida physical projeção contra as invariantes deste módulo.

    Args:
        record: Registro canônico consumido pela operação.
        descriptor: Descritor físico e semântico do dataset processado.
        column: Entrada ``column``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        ArchiveRecordValidationError: Se a operação não puder preservar as invariantes
        descritas.
    """
    value = physical_value(record, descriptor, column)
    field = f"physical.{column.name}"
    nullable = physical_field_nullable(descriptor, column)
    json_kind = ANALYTIC_JSON_KINDS.get((descriptor.table, column.name))
    if json_kind is not None:
        _validate_value(value, json_kind, field, nullable=nullable)
    elif column.name == descriptor.timestamp_field or column.name in CANONICAL_TIMESTAMP_COLUMNS:
        _validate_value(value, "timestamp", field, nullable=nullable)
    elif column.sql_type == "DOUBLE":
        if value is None:
            _validate_value(value, "decimal", field, nullable=nullable)
        elif not isinstance(value, float):
            raise ArchiveRecordValidationError(f"{field} must project as double")
    elif column.sql_type in _INTEGER_TYPES:
        _validate_value(value, "int", field, nullable=nullable)
    else:
        _validate_value(value, "string", field, nullable=nullable)


def validate_archive_record(record: CanonicalRecord, descriptor: DatasetDescriptor) -> None:
    """Valida arquivo histórico registro contra as invariantes deste módulo.

    Args:
        record: Registro canônico consumido pela operação.
        descriptor: Descritor físico e semântico do dataset processado.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        ArchiveRecordValidationError: Se a operação não puder preservar as invariantes
        descritas.
    """
    if record.source_dataset != descriptor.table or record.record_type != descriptor.record_type:
        raise ArchiveRecordValidationError("record dataset or type differs from descriptor")
    if record.source_system != "argus" or record.schema_version != "1.0":
        raise ArchiveRecordValidationError("record source system or schema version is unsupported")
    if tuple(name for name, _value in record.natural_key) != descriptor.natural_key:
        raise ArchiveRecordValidationError("record natural key differs from descriptor")
    columns = {column.name: column for column in descriptor.columns}
    for name, value in record.natural_key:
        _validate_value(value, _natural_kind(columns[name]), f"naturalKey.{name}", nullable=False)
    try:
        dimensions, measures, quality = ARCHIVE_SHAPES[descriptor.table]
    except KeyError as error:
        raise ArchiveRecordValidationError(
            f"descriptor {descriptor.table!r} has no canonical archive schema"
        ) from error
    _validate_namespace(record, descriptor, "dimensions", record.dimensions, dimensions)
    _validate_namespace(record, descriptor, "measures", record.measures, measures)
    _validate_namespace(record, descriptor, "quality", record.quality, quality)
    for flag in record.quality_flags:
        _validate_value(flag, "string", "qualityFlags.element", nullable=False)
    for column in descriptor.columns:
        _validate_physical_projection(record, descriptor, column)


__all__ = [
    "ANALYTIC_JSON_KINDS",
    "ARCHIVE_SHAPES",
    "ArchiveRecordValidationError",
    "CANONICAL_COLUMN_ALIASES",
    "CANONICAL_TIMESTAMP_COLUMNS",
    "canonical_field_nullable",
    "physical_field_nullable",
    "physical_value",
    "validate_archive_record",
]
