"""Catálogos de metadados do dump MySQL do Argus."""

from collections.abc import Iterable

import pandas as pd
from sqlalchemy import text

from dump_explorer.config import HARD_MAX_ROWS
from dump_explorer.database import ResultLimitError, read_frame

EXPECTED_TABLES = (
    "signal_point",
    "signal_bucket",
    "signal_meta",
    "cdn_entity_tier",
    "operation_metrics",
    "service_overview",
    "prom_query",
    "prom_series",
    "prom_point",
    "rpaas_bucket",
    "ca_point",
    "tsuru_event",
    "incidents",
    "incidents_platform",
    "incident_label",
    "player_hourly",
    "device_hourly",
    "geo_hourly",
    "live_qoe_hourly",
    "live_error_attr_hourly",
    "live_event",
    "player_live_hourly",
    "live_active_15min",
    "error_cat_hourly",
    "collector_run",
    "dashboard_artifact",
    "field_metrics",
    "apollo_run",
    "nr_run",
    "prom_run",
    "rpaas_run",
    "ca_run",
    "investigation_feedback",
)

_TABLE_CATALOG_QUERY = text(
    """
    SELECT
        TABLE_NAME AS table_name,
        TABLE_ROWS AS estimated_rows
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
    ORDER BY TABLE_NAME
    """
)

_COLUMN_CATALOG_QUERY = text(
    """
    SELECT
        columns_meta.TABLE_NAME AS table_name,
        columns_meta.COLUMN_NAME AS column_name,
        columns_meta.DATA_TYPE AS data_type,
        COALESCE(
            GROUP_CONCAT(DISTINCT indexes_meta.INDEX_NAME ORDER BY indexes_meta.INDEX_NAME),
            ''
        ) AS column_key
    FROM information_schema.columns AS columns_meta
    LEFT JOIN information_schema.statistics AS indexes_meta
        ON indexes_meta.TABLE_SCHEMA = columns_meta.TABLE_SCHEMA
        AND indexes_meta.TABLE_NAME = columns_meta.TABLE_NAME
        AND indexes_meta.COLUMN_NAME = columns_meta.COLUMN_NAME
    WHERE columns_meta.table_schema = DATABASE()
    GROUP BY
        columns_meta.TABLE_NAME,
        columns_meta.COLUMN_NAME,
        columns_meta.DATA_TYPE,
        columns_meta.ORDINAL_POSITION
    ORDER BY columns_meta.TABLE_NAME, columns_meta.ORDINAL_POSITION
    """
)


def load_table_catalog(engine) -> pd.DataFrame:
    """Lê estimativas de linhas do MySQL sem contar tabelas inteiras."""
    frame = read_frame(engine, _TABLE_CATALOG_QUERY)
    return frame.assign(count_kind="estimate")


def load_column_catalog(engine) -> pd.DataFrame:
    """Lê colunas e chaves indexadas publicadas pelo schema MySQL."""
    return read_frame(engine, _COLUMN_CATALOG_QUERY)


def compare_expected_tables(actual: Iterable[str], expected: Iterable[str]) -> pd.DataFrame:
    """Classifica tabelas documentadas, ausentes e encontradas sem documentação."""
    actual_names = set(actual)
    expected_names = set(expected)
    if len(actual_names) > HARD_MAX_ROWS or len(expected_names) > HARD_MAX_ROWS:
        raise ResultLimitError(f"catálogo excede o limite de {HARD_MAX_ROWS} linhas")

    table_names = actual_names | expected_names
    if len(table_names) > HARD_MAX_ROWS:
        raise ResultLimitError(f"catálogo excede o limite de {HARD_MAX_ROWS} linhas")

    records = [
        {
            "table_name": table_name,
            "status": (
                "present"
                if table_name in actual_names and table_name in expected_names
                else "missing"
                if table_name in expected_names
                else "undocumented"
            ),
        }
        for table_name in sorted(table_names)
    ]
    return pd.DataFrame(records, columns=["table_name", "status"])
