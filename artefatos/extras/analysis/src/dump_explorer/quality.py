"""Consultas seguras para cobertura e qualidade do dump Argus."""

from collections.abc import Iterable

import pandas as pd
from sqlalchemy import text

from dump_explorer.catalog import load_column_catalog
from dump_explorer.config import HARD_MAX_ROWS
from dump_explorer.database import ResultLimitError, read_frame
from dump_explorer.time_utils import epoch_ms_to_utc

TABLE_TIME_COLUMNS = {
    "signal_point": "ts",
    "signal_bucket": "bts",
    "operation_metrics": "start_ts",
    "service_overview": "timestamp",
    "prom_point": "epoch_ms",
    "rpaas_bucket": "bucket_ts_ms",
    "ca_point": "ts_ms",
    "tsuru_event": "start_time_ms",
    "incidents": "opened_at",
    "incidents_platform": "opened_at",
    "incident_label": "ts_start",
    "player_hourly": "hour_ts",
    "device_hourly": "hour_ts",
    "geo_hourly": "hour_ts",
    "live_qoe_hourly": "hour_ts",
    "live_error_attr_hourly": "hour_ts",
    "live_event": "start_ts",
    "player_live_hourly": "hour_ts",
    "live_active_15min": "bucket_ts",
    "error_cat_hourly": "hour_ts",
    "collector_run": "started_at",
    "dashboard_artifact": "updated_at",
    "field_metrics": "start_ts",
    "investigation_feedback": "created_at",
}

HEAVY_TABLES = frozenset({"signal_point", "prom_point"})

_COLLECTOR_TABLES = {
    "apollo_run": "apollo",
    "nr_run": "nr",
    "prom_run": "prom",
    "rpaas_run": "rpaas",
    "ca_run": "ca",
}
_COLLECTOR_WRITE_COLUMNS = {
    "apollo_run": "events_written",
    "nr_run": "metrics_written",
    "prom_run": "samples_written",
    "rpaas_run": "buckets_written",
    "ca_run": "checks_written",
}
_START_COLUMNS = ("started_at", "start_time", "started", "created_at")
_FINISH_COLUMNS = ("finished_at", "finish_time", "ended_at", "completed_at")


def _selected_tables(tables: Iterable[str] | None) -> tuple[str, ...]:
    """Retorna somente nomes conhecidos, sem repetir consultas por tabela."""
    requested = TABLE_TIME_COLUMNS if tables is None else tables
    selected = tuple(dict.fromkeys(name for name in requested if name in TABLE_TIME_COLUMNS))
    if len(selected) > HARD_MAX_ROWS:
        raise ResultLimitError(f"seleção excede o limite de {HARD_MAX_ROWS} tabelas")
    return selected


def _quote_known_identifier(identifier: str, allowed: Iterable[str]) -> str:
    """Delimita um identificador que já foi validado em uma allowlist confiável."""
    if identifier not in set(allowed):
        raise ValueError("identificador não permitido")
    return f"`{identifier}`"


def load_table_coverage(engine, tables: Iterable[str] | None = None) -> pd.DataFrame:
    """Resume cobertura temporal sem contar exatamente tabelas pesadas."""
    selected_tables = _selected_tables(tables)
    available_tables = (
        set(load_column_catalog(engine)["table_name"].tolist())
        if tables is None
        else set(selected_tables)
    )
    records = []
    for table_name in selected_tables:
        if table_name not in available_tables:
            continue
        time_column = TABLE_TIME_COLUMNS[table_name]
        table_sql = _quote_known_identifier(table_name, TABLE_TIME_COLUMNS)
        column_sql = _quote_known_identifier(time_column, TABLE_TIME_COLUMNS.values())

        if table_name in HEAVY_TABLES:
            estimate = read_frame(
                engine,
                text(
                    """
                    SELECT TABLE_ROWS AS estimated_rows
                    FROM information_schema.tables
                    WHERE table_schema = DATABASE() AND TABLE_NAME = :table_name
                    """
                ),
                params={"table_name": table_name},
            )
            timestamps = read_frame(
                engine,
                text(
                    f"SELECT MIN({column_sql}) AS first_ts, MAX({column_sql}) AS last_ts "
                    f"FROM {table_sql}"
                ),
            )
            rows = None if estimate.empty else estimate.iloc[0]["estimated_rows"]
            count_kind = "estimate"
        else:
            aggregate = read_frame(
                engine,
                text(
                    f"SELECT COUNT(*) AS rows_count, MIN({column_sql}) AS first_ts, "
                    f"MAX({column_sql}) AS last_ts FROM {table_sql}"
                ),
            )
            rows = None if aggregate.empty else aggregate.iloc[0]["rows_count"]
            timestamps = aggregate
            count_kind = "exact"

        first_ts = None if timestamps.empty else timestamps.iloc[0]["first_ts"]
        last_ts = None if timestamps.empty else timestamps.iloc[0]["last_ts"]
        records.append(
            {
                "table_name": table_name,
                "rows": rows,
                "first_ts": first_ts,
                "last_ts": last_ts,
                "count_kind": count_kind,
            }
        )
    return pd.DataFrame(
        records, columns=["table_name", "rows", "first_ts", "last_ts", "count_kind"]
    )


def load_source_coverage(engine) -> pd.DataFrame:
    """Resume sinal agregado por origem, convertendo bts (epoch ms) para UTC."""
    frame = read_frame(
        engine,
        text(
            """
            SELECT source, COUNT(*) AS `rows`, MIN(bts) AS first_ts, MAX(bts) AS last_ts
            FROM `signal_bucket`
            GROUP BY source
            ORDER BY source
            """
        ),
    )
    if frame.empty:
        return frame.reindex(columns=["source", "rows", "first_ts", "last_ts"])
    return frame.assign(
        first_ts=epoch_ms_to_utc(frame["first_ts"]),
        last_ts=epoch_ms_to_utc(frame["last_ts"]),
    )


def load_source_daily_coverage(engine, start, end) -> pd.DataFrame:
    """Agrega buckets por dia UTC em uma janela explícita e limitada."""
    if start is None or end is None:
        raise ValueError("start e end são obrigatórios para cobertura diária")
    if end <= start:
        raise ValueError("end deve ser posterior a start")
    frame = read_frame(
        engine,
        text(
            """
            SELECT
                source,
                FLOOR(bts / 86400000) * 86400000 AS day_epoch_ms,
                COUNT(*) AS `rows`
            FROM `signal_bucket`
            WHERE bts >= :start AND bts < :end
            GROUP BY source, FLOOR(bts / 86400000) * 86400000
            ORDER BY source, day_epoch_ms
            """
        ),
        params={"start": start, "end": end},
    )
    if frame.empty:
        return pd.DataFrame(columns=["source", "day", "rows"])
    return frame.assign(day=epoch_ms_to_utc(frame["day_epoch_ms"])).drop(columns="day_epoch_ms")


def load_series_cadence(engine, source, entity, metric, start, end) -> pd.DataFrame:
    """Carrega intervalos de uma série apenas dentro de uma janela fechada-aberta."""
    if start is None or end is None:
        raise ValueError("start e end são obrigatórios para cadência")
    if end <= start:
        raise ValueError("end deve ser posterior a start")

    frame = read_frame(
        engine,
        text(
            """
            SELECT
                bts,
                LAG(bts) OVER (ORDER BY bts) AS previous_bts
            FROM `signal_bucket`
            WHERE source = :source
              AND entity = :entity
              AND metric = :metric
              AND bts >= :start
              AND bts < :end
            ORDER BY bts
            """
        ),
        params={
            "source": source,
            "entity": entity,
            "metric": metric,
            "start": start,
            "end": end,
        },
    )
    if frame.empty:
        return pd.DataFrame(columns=["bts", "previous_bts", "cadence_s"])
    return frame.assign(
        cadence_s=(frame["bts"] - frame["previous_bts"]) / 1000,
        bts=epoch_ms_to_utc(frame["bts"]),
        previous_bts=epoch_ms_to_utc(frame["previous_bts"]),
    )


def load_missingness(engine, table_name: str, columns: Iterable[str]) -> pd.DataFrame:
    """Resume nulos de colunas de catálogo, sem retornar nenhum valor bruto."""
    if table_name in HEAVY_TABLES:
        raise ValueError("tabela pesada não permitida para missingness")
    catalog = load_column_catalog(engine)
    catalog_tables = set(catalog["table_name"].tolist())
    if table_name not in catalog_tables:
        raise ValueError("tabela não permitida para missingness")
    available = catalog.loc[catalog["table_name"] == table_name, "column_name"].tolist()
    requested = tuple(dict.fromkeys(column for column in columns if column in available))
    if not requested:
        return pd.DataFrame(
            columns=["table_name", "column_name", "null_count", "row_count", "null_pct"]
        )

    table_sql = _quote_known_identifier(table_name, catalog_tables)
    null_expressions = []
    for column in requested:
        column_sql = _quote_known_identifier(column, available)
        alias_sql = _quote_known_identifier(f"{column}_null_count", [f"{column}_null_count"])
        null_expressions.append(
            f"SUM(CASE WHEN {column_sql} IS NULL THEN 1 ELSE 0 END) AS {alias_sql}"
        )
    aggregate = read_frame(
        engine,
        text(f"SELECT COUNT(*) AS row_count, {', '.join(null_expressions)} FROM {table_sql}"),
    )
    row_count = 0 if aggregate.empty else int(aggregate.iloc[0]["row_count"])
    records = []
    for column in requested:
        null_count = 0 if aggregate.empty else int(aggregate.iloc[0][f"{column}_null_count"])
        records.append(
            {
                "table_name": table_name,
                "column_name": column,
                "null_count": null_count,
                "row_count": row_count,
                "null_pct": None if row_count == 0 else null_count / row_count * 100,
            }
        )
    return pd.DataFrame(
        records, columns=["table_name", "column_name", "null_count", "row_count", "null_pct"]
    )


def _first_catalog_column(available: set[str], candidates: tuple[str, ...]) -> str | None:
    return next((column for column in candidates if column in available), None)


def load_collector_health(engine) -> pd.DataFrame:
    """Normaliza execuções de coletores sem converter timestamps ISO em épocas."""
    catalog = load_column_catalog(engine)
    frames = []
    per_collector_limit = HARD_MAX_ROWS // len(_COLLECTOR_TABLES)
    for table_name, collector in _COLLECTOR_TABLES.items():
        available = set(catalog.loc[catalog["table_name"] == table_name, "column_name"].tolist())
        if not available:
            continue
        started_column = _first_catalog_column(available, _START_COLUMNS)
        finished_column = _first_catalog_column(available, _FINISH_COLUMNS)
        # Prefer the configured expected column, but tolerate alternate
        # names produced by different dump/schema versions (e.g. rows_inserted,
        # points_inserted, queries_ok, etc.). If none found, fall back to NULL
        # rather than failing the whole notebook.
        expected = _COLLECTOR_WRITE_COLUMNS.get(table_name)
        written_column = expected if expected in available else None
        if written_column is None:
            # heuristics: prefer columns containing these keywords
            candidates = [c for c in available if any(k in c for k in ("insert", "written", "rows", "points", "buckets", "samples"))]
            written_column = candidates[0] if candidates else None
        if started_column is None:
            continue

        table_sql = _quote_known_identifier(table_name, _COLLECTOR_TABLES)
        started_sql = _quote_known_identifier(started_column, available)
        finished_sql = (
            "NULL"
            if finished_column is None
            else _quote_known_identifier(finished_column, available)
        )
        written_sql = (
            "NULL" if written_column is None else _quote_known_identifier(written_column, available)
        )
        frame = read_frame(
            engine,
            text(
                f"SELECT {started_sql} AS started_at, {finished_sql} AS finished_at, "
                f"{written_sql} AS rows_written FROM {table_sql} "
                f"ORDER BY {started_sql} DESC LIMIT {per_collector_limit}"
            ),
            max_rows=per_collector_limit,
        )
        if not frame.empty:
            frames.append(frame.assign(collector=collector))

    columns = [
        "collector",
        "started_at",
        "finished_at",
        "duration_s",
        "rows_written",
        "status",
    ]
    if not frames:
        return pd.DataFrame(columns=columns)
    frame = pd.concat(frames, ignore_index=True)
    if len(frame) > HARD_MAX_ROWS:
        raise ResultLimitError(f"saída excede o limite de {HARD_MAX_ROWS} linhas")
    started_at = pd.to_datetime(frame["started_at"], utc=True, errors="coerce")
    finished_at = pd.to_datetime(frame["finished_at"], utc=True, errors="coerce")
    return pd.DataFrame(
        {
            "collector": frame["collector"],
            "started_at": started_at,
            "finished_at": finished_at,
            "duration_s": (finished_at - started_at).dt.total_seconds(),
            "rows_written": pd.to_numeric(frame["rows_written"], errors="coerce"),
            "status": finished_at.notna().map({True: "complete", False: "incomplete"}),
        }
    )
