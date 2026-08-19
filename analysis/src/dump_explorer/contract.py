"""Contrato lógico para uma futura ingestão BigQuery ainda não mapeada fisicamente."""

from dataclasses import asdict, dataclass, fields
from pathlib import Path

import pandas as pd

UNKNOWN_PHYSICAL_MAPPING = "não fornecido"
FRONTEND_SAMPLE_SOURCE = "amostra frontend; origem BigQuery não comprovada"
OUTPUTS_DIR = Path(__file__).resolve().parents[2] / "outputs"


@dataclass(frozen=True)
class LogicalField:
    """Um campo lógico documentado, sem presumir o schema físico do BigQuery."""

    logical_table: str
    logical_field: str
    source_system: str
    grain: str
    logical_type: str
    key_role: str
    event_timestamp: bool
    watermark_candidate: bool
    known_delay: str
    storage_recommendation: str
    sensitivity: str
    bigquery_table: str = UNKNOWN_PHYSICAL_MAPPING
    bigquery_column: str = UNKNOWN_PHYSICAL_MAPPING
    bigquery_partition_column: str = UNKNOWN_PHYSICAL_MAPPING
    bigquery_write_watermark: str = UNKNOWN_PHYSICAL_MAPPING
    update_semantics: str = UNKNOWN_PHYSICAL_MAPPING


@dataclass(frozen=True)
class ContractIssue:
    """Uma lacuna que a Globo precisa resolver antes da ingestão incremental."""

    logical_table: str
    logical_field: str
    code: str
    message: str


REQUIRED_CONTRACT_COLUMNS = tuple(field.name for field in fields(LogicalField))


def _npaw_field(
    logical_table: str,
    logical_field: str,
    logical_type: str,
    key_role: str = "measure",
    *,
    timestamp: bool = False,
) -> LogicalField:
    return LogicalField(
        logical_table=logical_table,
        logical_field=logical_field,
        source_system="NPAW/Youbora; domínio documentado via BigQuery",
        grain=_NPAW_GRAINS[logical_table],
        logical_type=logical_type,
        key_role=key_role,
        event_timestamp=timestamp,
        watermark_candidate=timestamp,
        known_delay="~28h",
        storage_recommendation="hot+cold",
        sensitivity="aggregate",
    )


_NPAW_GRAINS = {
    "player_hourly": "hora por player",
    "device_hourly": "hora por dispositivo",
    "geo_hourly": "hora por UF por operadora",
    "live_qoe_hourly": "hora por sinal",
    "player_live_hourly": "hora por player",
    "live_active_15min": "15 min por sinal",
    "live_error_attr_hourly": "hora por sinal por CDN por camada por HTTP por erro",
    "error_cat_hourly": "hora por kind por categoria",
}


def _npaw_fields() -> list[LogicalField]:
    records: list[LogicalField] = []
    records.extend(
        [
            _npaw_field(
                "player_hourly",
                "hour_ts",
                "timestamp (epoch_ms UTC)",
                "natural key component",
                timestamp=True,
            ),
            _npaw_field("player_hourly", "player", "string", "natural key component"),
            _npaw_field("player_hourly", "sessions", "integer"),
            _npaw_field("player_hourly", "errors", "integer"),
        ]
    )
    records.extend(
        [
            _npaw_field(
                "device_hourly",
                "hour_ts",
                "timestamp (epoch_ms UTC)",
                "natural key component",
                timestamp=True,
            ),
            _npaw_field("device_hourly", "device", "string", "natural key component"),
            _npaw_field("device_hourly", "sessions", "integer"),
            _npaw_field("device_hourly", "errors", "integer"),
        ]
    )
    records.extend(
        [
            _npaw_field(
                "geo_hourly",
                "hour_ts",
                "timestamp (epoch_ms UTC)",
                "natural key component",
                timestamp=True,
            ),
            _npaw_field("geo_hourly", "state_province", "string", "natural key component"),
            _npaw_field("geo_hourly", "isp", "string", "natural key component"),
            _npaw_field("geo_hourly", "sessions", "integer"),
            _npaw_field("geo_hourly", "errors", "integer"),
        ]
    )
    records.extend(
        [
            _npaw_field(
                "live_qoe_hourly",
                "hour_ts",
                "timestamp (epoch_ms UTC)",
                "natural key component",
                timestamp=True,
            ),
            _npaw_field("live_qoe_hourly", "sinal", "string", "natural key component"),
            *[
                _npaw_field("live_qoe_hourly", field, kind)
                for field, kind in (
                    ("sessions", "integer"),
                    ("errors", "integer"),
                    ("startup_errors", "integer"),
                    ("latency_ms_avg", "number (ms)"),
                    ("latency_ms_p50", "number (ms)"),
                    ("latency_ms_p95", "number (ms)"),
                    ("bufferratio_avg", "number (ratio)"),
                    ("jointime_s_avg", "number (s)"),
                    ("dropped_frames_avg", "number"),
                    ("stalls_avg", "number"),
                )
            ],
        ]
    )
    records.extend(
        [
            _npaw_field(
                "player_live_hourly",
                "hour_ts",
                "timestamp (epoch_ms UTC)",
                "natural key component",
                timestamp=True,
            ),
            _npaw_field("player_live_hourly", "player", "string", "natural key component"),
            *[
                _npaw_field("player_live_hourly", field, kind)
                for field, kind in (
                    ("sessions", "integer"),
                    ("errors", "integer"),
                    ("startup_errors", "integer"),
                    ("jointime_s_avg", "number (s)"),
                    ("bufferratio_avg", "number (ratio)"),
                    ("latency_ms_avg", "number (ms)"),
                    ("dropped_frames_avg", "number"),
                    ("stalls_avg", "number"),
                )
            ],
        ]
    )
    records.extend(
        [
            _npaw_field(
                "live_active_15min",
                "bucket_ts",
                "timestamp (epoch_ms UTC)",
                "natural key component",
                timestamp=True,
            ),
            _npaw_field("live_active_15min", "sinal", "string", "natural key component"),
            *[
                _npaw_field("live_active_15min", field, kind)
                for field, kind in (
                    ("active_sessions", "integer"),
                    ("active_with_error", "integer"),
                    ("joins_in_bucket", "integer"),
                    ("latency_ms_p50", "number (ms)"),
                    ("latency_ms_p95", "number (ms)"),
                    ("bufferratio_avg", "number (ratio)"),
                    ("jointime_s_avg", "number (s)"),
                    ("dropped_frames_avg", "number"),
                )
            ],
        ]
    )
    records.extend(
        [
            _npaw_field(
                "live_error_attr_hourly",
                "hour_ts",
                "timestamp (epoch_ms UTC)",
                "natural key component",
                timestamp=True,
            ),
            _npaw_field("live_error_attr_hourly", "sinal", "string", "natural key component"),
            _npaw_field("live_error_attr_hourly", "cdn", "string", "natural key component"),
            _npaw_field("live_error_attr_hourly", "tier", "string", "natural key component"),
            _npaw_field("live_error_attr_hourly", "http_code", "string", "natural key component"),
            _npaw_field("live_error_attr_hourly", "error_name", "string", "natural key component"),
            _npaw_field("live_error_attr_hourly", "errors", "integer"),
        ]
    )
    records.extend(
        [
            _npaw_field(
                "error_cat_hourly",
                "hour_ts",
                "timestamp (epoch_ms UTC)",
                "natural key component",
                timestamp=True,
            ),
            _npaw_field("error_cat_hourly", "kind", "string", "natural key component"),
            _npaw_field("error_cat_hourly", "category", "string", "natural key component"),
            _npaw_field("error_cat_hourly", "errors", "integer"),
            _npaw_field("error_cat_hourly", "top_names", "json"),
        ]
    )
    return records


def _incident_fields() -> list[LogicalField]:
    definitions = [
        (
            "opened_at",
            "timestamp (epoch_ms UTC; ticket-open time, not incident-start)",
            "event timestamp",
            True,
        ),
        ("sys_id", "string", "natural key", False),
        ("number", "string", "attribute", False),
        ("resolved_at", "timestamp (epoch_ms UTC)", "attribute", True),
        ("closed_at", "timestamp (epoch_ms UTC)", "attribute", True),
        ("priority", "string", "attribute", False),
        ("priority_value", "string", "attribute", False),
        ("state", "string", "attribute", False),
        ("state_value", "string", "attribute", False),
        ("assignment_group", "string", "attribute", False),
        ("business_service", "string", "attribute", False),
        ("cmdb_ci", "string", "attribute", False),
        ("category", "string", "attribute", False),
        ("subcategory", "string", "attribute", False),
        ("impact_component", "string", "attribute", False),
        ("impact_component_value", "string", "attribute", False),
        ("close_code", "string", "attribute", False),
        ("close_code_value", "string", "attribute", False),
        ("u_this_incident_caused_external_impacts", "boolean-like string", "attribute", False),
        (
            "u_this_incident_was_caused_by_a_change_or_deploy",
            "boolean-like string",
            "attribute",
            False,
        ),
        ("parent_incident", "string", "relationship", False),
        ("child_incidents", "string", "relationship", False),
        ("scr_vendor", "string", "attribute", False),
        ("scr_vendor_ticket", "string", "attribute", False),
    ]
    return [
        LogicalField(
            logical_table="incidents",
            logical_field=logical_field,
            source_system="ServiceNow; domínio documentado via BigQuery",
            grain="ticket",
            logical_type=logical_type,
            key_role=key_role,
            event_timestamp=timestamp,
            watermark_candidate=timestamp,
            known_delay="ticket-open typically +5-40min after incident onset"
            if logical_field == "opened_at"
            else "não fornecido",
            storage_recommendation="hot+cold",
            sensitivity="operational",
        )
        for logical_field, logical_type, key_role, timestamp in definitions
    ]


def _frontend_sample_fields() -> list[LogicalField]:
    definitions = [
        ("timestamp", "timestamp", "event timestamp", True),
        ("event_name", "string", "attribute", False),
        ("app_bucket", "string", "attribute", False),
        ("app_env", "string", "attribute", False),
        ("app_target", "string", "attribute", False),
        ("route_path", "string", "attribute", False),
    ]
    return [
        LogicalField(
            logical_table="frontend_events_sample",
            logical_field=logical_field,
            source_system=FRONTEND_SAMPLE_SOURCE,
            grain="evento individual de amostra",
            logical_type=logical_type,
            key_role=key_role,
            event_timestamp=timestamp,
            watermark_candidate=timestamp,
            known_delay="não fornecido",
            storage_recommendation="cold",
            sensitivity="restricted",
        )
        for logical_field, logical_type, key_role, timestamp in definitions
    ]


def build_logical_contract() -> pd.DataFrame:
    """Constrói o catálogo estático de necessidades lógicas da futura ingestão."""
    records = [*_incident_fields(), *_npaw_fields(), *_frontend_sample_fields()]
    frame = pd.DataFrame([asdict(record) for record in records], columns=REQUIRED_CONTRACT_COLUMNS)
    # Preserve Python bool scalars for notebook users and callers that use identity checks.
    for column in ("event_timestamp", "watermark_candidate"):
        frame[column] = frame[column].astype(object)
    return frame


def _is_missing_physical(value) -> bool:
    return (
        pd.isna(value)
        or not isinstance(value, str)
        or not value.strip()
        or value == UNKNOWN_PHYSICAL_MAPPING
    )


def _require_contract_columns(frame: pd.DataFrame) -> None:
    missing = [column for column in REQUIRED_CONTRACT_COLUMNS if column not in frame.columns]
    if missing:
        raise ValueError(f"frame não contém colunas obrigatórias: {', '.join(missing)}")


def validate_physical_mapping(frame: pd.DataFrame) -> list[ContractIssue]:
    """Lista as garantias físicas que ainda impedem uma ingestão segura e idempotente."""
    _require_contract_columns(frame)
    issues: list[ContractIssue] = []
    for logical_table, table_frame in frame.groupby("logical_table", sort=True, dropna=False):
        table_name = str(logical_table)
        if table_frame["bigquery_table"].map(_is_missing_physical).all():
            issues.append(
                ContractIssue(
                    table_name,
                    "*",
                    "missing_bigquery_table",
                    "Tabela física BigQuery não fornecida.",
                )
            )
        if table_frame["bigquery_partition_column"].map(_is_missing_physical).all():
            issues.append(
                ContractIssue(
                    table_name,
                    "*",
                    "missing_partition_column",
                    "Coluna de partição BigQuery não fornecida.",
                )
            )
        if table_frame["bigquery_write_watermark"].map(_is_missing_physical).all():
            issues.append(
                ContractIssue(
                    table_name,
                    "*",
                    "missing_write_watermark",
                    "Watermark de escrita BigQuery não fornecido.",
                )
            )
        if table_frame["update_semantics"].map(_is_missing_physical).all():
            issues.append(
                ContractIssue(
                    table_name,
                    "*",
                    "unknown_update_semantics",
                    "Semântica de atualizações, correções e deletes não fornecida.",
                )
            )

        key_candidates = table_frame.loc[
            table_frame["key_role"].astype(str).str.contains("natural key", case=False, na=False)
        ]
        duplicate_keys = key_candidates.loc[
            key_candidates.duplicated(["logical_table", "logical_field"], keep=False)
        ]
        for logical_field in sorted(duplicate_keys["logical_field"].astype(str).unique()):
            issues.append(
                ContractIssue(
                    table_name,
                    logical_field,
                    "non_unique_key_candidate",
                    "Campo candidato à chave natural aparece mais de uma vez no contrato.",
                )
            )

    missing_columns = frame.loc[frame["bigquery_column"].map(_is_missing_physical)]
    for row in missing_columns.loc[:, ["logical_table", "logical_field"]].itertuples(index=False):
        issues.append(
            ContractIssue(
                str(row.logical_table),
                str(row.logical_field),
                "missing_bigquery_column",
                "Coluna física BigQuery não fornecida.",
            )
        )
    return issues


def export_contract_csv(frame: pd.DataFrame, path: Path | str) -> Path:
    """Exporta somente para ``analysis/outputs`` após validar a forma do contrato."""
    _require_contract_columns(frame)
    target = Path(path).expanduser().resolve()
    output_root = OUTPUTS_DIR.resolve()
    try:
        target.relative_to(output_root)
    except ValueError as exc:
        raise ValueError("A exportação deve permanecer em analysis/outputs.") from exc
    target.parent.mkdir(parents=True, exist_ok=True)
    frame.loc[:, REQUIRED_CONTRACT_COLUMNS].to_csv(target, index=False)
    return target
