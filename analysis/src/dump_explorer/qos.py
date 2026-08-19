"""Leituras limitadas de QoS para as fontes de infraestrutura do dump Argus."""

import json
from collections.abc import Iterable

import pandas as pd
from sqlalchemy import text

from dump_explorer.config import HARD_MAX_ROWS
from dump_explorer.database import ResultLimitError, read_frame
from dump_explorer.time_utils import epoch_ms_to_utc

_MAX_SELECTION_VALUES = 500
_MAX_PROM_SERIES = 20
_PLAYBACK_VHOSTS = frozenset(
    {
        "playback.video.globo.com",
        "watcher.playback.video.globo.com",
        "tv.globoplay.com.br",
        "apis-globoplay.globo.com",
    }
)
_TIDY_COLUMNS = ["timestamp", "source", "entity", "metric", "value", "unit"]


def _require_window(start, end) -> None:
    if start is None or end is None:
        raise ValueError("start e end são obrigatórios")
    if end <= start:
        raise ValueError("end deve ser posterior a start")


def _selection(values: Iterable[str] | None, prefix: str) -> tuple[list[str], dict[str, str]]:
    if values is None:
        return [], {}
    if isinstance(values, str):
        raise ValueError(f"{prefix} deve ser uma coleção de valores")
    selected = list(dict.fromkeys(values))
    if len(selected) > _MAX_SELECTION_VALUES:
        raise ValueError(f"{prefix} aceita no máximo {_MAX_SELECTION_VALUES} valores")
    if any(not isinstance(value, str) or not value.strip() for value in selected):
        raise ValueError(f"{prefix} deve conter apenas textos não vazios")
    return selected, {f"{prefix}_{index}": value for index, value in enumerate(selected)}


def _in_filter(column: str, params: dict[str, object], values: list[str], prefix: str) -> str:
    if not values:
        return ""
    names = []
    for index, value in enumerate(values):
        name = f"{prefix}_{index}"
        params[name] = value
        names.append(f":{name}")
    return f" AND {column} IN ({', '.join(names)})"


def _empty_tidy(*extra: str) -> pd.DataFrame:
    return pd.DataFrame(columns=[*_TIDY_COLUMNS, *extra])


def _assert_frame_cap(frame: pd.DataFrame) -> pd.DataFrame:
    if len(frame) > HARD_MAX_ROWS:
        raise ResultLimitError(f"consulta excedeu o limite de {HARD_MAX_ROWS} linhas")
    return frame


def _tidy_records(frame: pd.DataFrame, source: str, entity_column: str, metrics) -> pd.DataFrame:
    records = []
    for row in frame.itertuples(index=False):
        timestamp = row.timestamp_ms
        entity = getattr(row, entity_column)
        for column, metric, unit, direction in metrics:
            value = getattr(row, column)
            if pd.isna(value):
                continue
            records.append(
                {
                    "timestamp_ms": timestamp,
                    "source": source,
                    "entity": entity,
                    "metric": metric,
                    "value": value,
                    "unit": unit,
                    "direction": direction,
                }
            )
    if not records:
        return _empty_tidy("direction")
    tidy = pd.DataFrame.from_records(records)
    return _assert_frame_cap(
        tidy.assign(timestamp=epoch_ms_to_utc(tidy["timestamp_ms"])).drop(columns="timestamp_ms").loc[
            :, [*_TIDY_COLUMNS, "direction"]
        ]
    )


def load_newrelic(engine, apps, start, end) -> pd.DataFrame:
    """Carrega até 25 mil snapshots New Relic e os normaliza em quatro métricas."""
    _require_window(start, end)
    selected, _ = _selection(apps, "apps")
    row_limit = HARD_MAX_ROWS // 4
    params: dict[str, object] = {"start": start, "end": end, "row_limit": row_limit}
    app_filter = _in_filter("app_name", params, selected, "apps")
    frame = read_frame(
        engine,
        text(
            f"""
            SELECT timestamp AS timestamp_ms, app_name, response_time_avg_ms, throughput_rpm,
                   error_rate_pct, apdex_score
            FROM `service_overview`
            WHERE timestamp >= :start AND timestamp < :end{app_filter}
            ORDER BY timestamp, app_name
            LIMIT :row_limit
            """
        ),
        params=params,
        max_rows=row_limit,
    )
    return _tidy_records(
        frame,
        "newrelic",
        "app_name",
        [
            ("response_time_avg_ms", "response_time_avg_ms", "ms", "higher_is_worse"),
            ("throughput_rpm", "throughput_rpm", "req/min", "context_dependent"),
            ("error_rate_pct", "error_rate_pct", "pct", "higher_is_worse"),
            ("apdex_score", "apdex_score", "score", "lower_is_worse"),
        ],
    )


def load_apollo(engine, operations, start, end) -> pd.DataFrame:
    """Carrega Apollo por operação preservando contagens e a duração real de cada janela."""
    _require_window(start, end)
    selected, _ = _selection(operations, "operations")
    row_limit = HARD_MAX_ROWS // 7
    params: dict[str, object] = {"start": start, "end": end, "row_limit": row_limit}
    operation_filter = _in_filter("operation_name", params, selected, "operations")
    frame = read_frame(
        engine,
        text(
            f"""
            SELECT start_ts AS timestamp_ms, operation_name, request_count, error_count,
                   request_count * 60000.0 / NULLIF(end_ts - start_ts, 0) AS rpm,
                   error_count / NULLIF(request_count, 0) AS error_rate,
                   p50_ms, p90_ms, p99_ms
            FROM `operation_metrics`
            WHERE start_ts >= :start AND start_ts < :end{operation_filter}
            ORDER BY start_ts, operation_name
            LIMIT :row_limit
            """
        ),
        params=params,
        max_rows=row_limit,
    )
    return _tidy_records(
        frame,
        "apollo",
        "operation_name",
        [
            ("request_count", "request_count", "requests", "context_dependent"),
            ("error_count", "error_count", "errors", "higher_is_worse"),
            ("rpm", "rpm", "req/min", "context_dependent"),
            ("error_rate", "error_rate", "ratio", "higher_is_worse"),
            ("p50_ms", "p50_ms", "ms", "higher_is_worse"),
            ("p90_ms", "p90_ms", "ms", "higher_is_worse"),
            ("p99_ms", "p99_ms", "ms", "higher_is_worse"),
        ],
    )


def load_rpaas(engine, regions, vhosts, start, end) -> pd.DataFrame:
    """Carrega buckets RPaaS amostrados, sem expandir contagens para tráfego estimado."""
    _require_window(start, end)
    selected_regions, _ = _selection(regions, "regions")
    selected_vhosts, _ = _selection(vhosts, "vhosts")
    row_limit = HARD_MAX_ROWS // 13
    params: dict[str, object] = {"start": start, "end": end, "row_limit": row_limit}
    region_filter = _in_filter("region", params, selected_regions, "regions")
    vhost_filter = _in_filter("vhost", params, selected_vhosts, "vhosts")
    frame = read_frame(
        engine,
        text(
            f"""
            SELECT bucket_ts_ms AS timestamp_ms, region, vhost,
                   requests_total, requests_2xx, requests_3xx, requests_4xx, requests_5xx,
                   p50_ms, p90_ms, p95_ms, p99_ms,
                   requests_2xx / NULLIF(requests_total, 0) AS requests_2xx_rate,
                   requests_3xx / NULLIF(requests_total, 0) AS requests_3xx_rate,
                   requests_4xx / NULLIF(requests_total, 0) AS requests_4xx_rate,
                   requests_5xx / NULLIF(requests_total, 0) AS requests_5xx_rate
            FROM `rpaas_bucket`
            WHERE bucket_ts_ms >= :start AND bucket_ts_ms < :end{region_filter}{vhost_filter}
            ORDER BY bucket_ts_ms, region, vhost
            LIMIT :row_limit
            """
        ),
        params=params,
        max_rows=row_limit,
    )
    records = []
    metrics = [
        ("requests_total", "requests_total_sampled", "sampled requests", "context_dependent", True),
        ("requests_2xx", "requests_2xx_sampled", "sampled requests", "context_dependent", True),
        ("requests_3xx", "requests_3xx_sampled", "sampled requests", "context_dependent", True),
        ("requests_4xx", "requests_4xx_sampled", "sampled requests", "context_dependent", True),
        ("requests_5xx", "requests_5xx_sampled", "sampled requests", "higher_is_worse", True),
        ("requests_2xx_rate", "requests_2xx_rate", "ratio", "context_dependent", False),
        ("requests_3xx_rate", "requests_3xx_rate", "ratio", "context_dependent", False),
        ("requests_4xx_rate", "requests_4xx_rate", "ratio", "context_dependent", False),
        ("requests_5xx_rate", "requests_5xx_rate", "ratio", "higher_is_worse", False),
        ("p50_ms", "p50_ms", "ms", "higher_is_worse", False),
        ("p90_ms", "p90_ms", "ms", "higher_is_worse", False),
        ("p95_ms", "p95_ms", "ms", "higher_is_worse", False),
        ("p99_ms", "p99_ms", "ms", "higher_is_worse", False),
    ]
    for row in frame.itertuples(index=False):
        entity = f"{row.region}|{row.vhost}"
        for column, metric, unit, direction, sampled_count in metrics:
            value = getattr(row, column)
            if pd.isna(value):
                continue
            records.append(
                {
                    "timestamp_ms": row.timestamp_ms,
                    "source": "rpaas",
                    "entity": entity,
                    "metric": metric,
                    "value": value,
                    "unit": unit,
                    "direction": direction,
                    "sampled_count": sampled_count,
                    "sampling_rate": 0.01,
                    "playback_signal": metric == "requests_4xx_rate"
                    and row.vhost in _PLAYBACK_VHOSTS,
                }
            )
    if not records:
        return _empty_tidy("direction", "sampled_count", "sampling_rate", "playback_signal")
    tidy = pd.DataFrame.from_records(records)
    return _assert_frame_cap(
        tidy.assign(timestamp=epoch_ms_to_utc(tidy["timestamp_ms"])).drop(columns="timestamp_ms").loc[
            :, [*_TIDY_COLUMNS, "direction", "sampled_count", "sampling_rate", "playback_signal"]
        ]
    )


def load_cloudarmor(engine, apps, start, end) -> pd.DataFrame:
    """Carrega taxa bloqueada ou passada pelo Cloud Armor, limitada a 100 mil pontos."""
    _require_window(start, end)
    selected, _ = _selection(apps, "apps")
    params: dict[str, object] = {"start": start, "end": end, "row_limit": HARD_MAX_ROWS}
    app_filter = _in_filter("app", params, selected, "apps")
    frame = read_frame(
        engine,
        text(
            f"""
            SELECT ts_ms AS timestamp_ms, app, backend_target, blocked, rps
            FROM `ca_point`
            WHERE ts_ms >= :start AND ts_ms < :end{app_filter}
            ORDER BY ts_ms, app, blocked
            LIMIT :row_limit
            """
        ),
        params=params,
        max_rows=HARD_MAX_ROWS,
    )
    if frame.empty:
        return _empty_tidy("direction")
    tidy = frame.assign(
        timestamp=epoch_ms_to_utc(frame["timestamp_ms"]),
        source="cloudarmor",
        entity=frame["app"] + "|" + frame["backend_target"],
        metric=frame["blocked"].map({1: "blocked_rps", 0: "passed_rps"}).fillna("rps"),
        value=frame["rps"],
        unit="req/s",
        direction=frame["blocked"].map({1: "higher_is_worse", 0: "context_dependent"}).fillna(
            "context_dependent"
        ),
    )
    return _assert_frame_cap(tidy.loc[:, [*_TIDY_COLUMNS, "direction"]])


def parse_prometheus_labels(value) -> tuple[object, bool]:
    """Conserva labels inválidos como texto em vez de descartar a série Prometheus."""
    if value is None or not isinstance(value, (str, bytes, bytearray)):
        return value, False
    try:
        return json.loads(value), False
    except (TypeError, ValueError, json.JSONDecodeError):
        return value, True


def load_prometheus(
    engine, section, services, start, end, limit_series: int = _MAX_PROM_SERIES
) -> pd.DataFrame:
    """Lê pontos Prometheus somente após selecionar até 20 séries por seção."""
    _require_window(start, end)
    if not isinstance(section, str) or not section.strip():
        raise ValueError("section é obrigatória")
    if (
        isinstance(limit_series, bool)
        or not isinstance(limit_series, int)
        or not 1 <= limit_series <= _MAX_PROM_SERIES
    ):
        raise ValueError("limit_series deve estar entre 1 e 20")
    selected, _ = _selection(services, "services")
    params: dict[str, object] = {
        "section": section,
        "start": start,
        "end": end,
        "limit_series": limit_series,
        "point_limit": HARD_MAX_ROWS,
    }
    service_filter = _in_filter("s.service_label", params, selected, "services")
    frame = read_frame(
        engine,
        text(
            f"""
            WITH selected_series AS (
                SELECT s.series_id, s.labels_json, s.service_label,
                       s.service_instance_label, s.pod_label,
                       q.section, q.panel_title, q.ref_id, q.expr_hash
                FROM `prom_query` AS q
                JOIN `prom_series` AS s ON s.query_id = q.query_id
                WHERE q.section = :section{service_filter}
                ORDER BY s.service_label, s.series_id
                LIMIT :limit_series
            )
            SELECT p.epoch_ms AS timestamp_ms, ss.series_id,
                   COALESCE(NULLIF(ss.service_label, ''), NULLIF(ss.service_instance_label, ''),
                            NULLIF(ss.pod_label, ''), CAST(ss.series_id AS CHAR)) AS entity,
                   COALESCE(ss.panel_title, ss.ref_id, ss.expr_hash) AS metric,
                   p.value_num AS value, ss.labels_json AS labels
            FROM selected_series AS ss
            JOIN `prom_point` AS p ON p.series_id = ss.series_id
            WHERE p.epoch_ms >= :start AND p.epoch_ms < :end
            ORDER BY p.epoch_ms, ss.series_id
            LIMIT :point_limit
            """
        ),
        params=params,
        max_rows=HARD_MAX_ROWS,
    )
    if frame.empty:
        return _empty_tidy("series_id", "labels", "labels_parse_error")
    parsed = frame["labels"].map(parse_prometheus_labels)
    tidy = frame.assign(
        timestamp=epoch_ms_to_utc(frame["timestamp_ms"]),
        source="prometheus",
        unit="source unit",
        labels=parsed.map(lambda result: result[0]),
        labels_parse_error=parsed.map(lambda result: result[1]),
    )
    return _assert_frame_cap(
        tidy.loc[:, [*_TIDY_COLUMNS, "series_id", "labels", "labels_parse_error"]]
    )


def load_tsuru_events(engine, targets, start, end) -> pd.DataFrame:
    """Carrega eventos técnicos Tsuru sem expor ou inventar campos sanitizados."""
    _require_window(start, end)
    selected, _ = _selection(targets, "targets")
    params: dict[str, object] = {"start": start, "end": end, "row_limit": HARD_MAX_ROWS}
    target_filter = _in_filter("target_value", params, selected, "targets")
    frame = read_frame(
        engine,
        text(
            f"""
            SELECT start_time_ms AS timestamp_ms, uniqueid, target_type, target_value, kind,
                   end_time_ms, duration_ms
            FROM `tsuru_event`
            WHERE start_time_ms >= :start AND start_time_ms < :end{target_filter}
            ORDER BY start_time_ms, uniqueid
            LIMIT :row_limit
            """
        ),
        params=params,
        max_rows=HARD_MAX_ROWS,
    )
    columns = [
        "timestamp",
        "source",
        "entity",
        "metric",
        "value",
        "unit",
        "uniqueid",
        "target_type",
        "kind",
        "event_label",
        "end_timestamp",
        "duration_ms",
        "owner",
        "error",
    ]
    if frame.empty:
        return pd.DataFrame(columns=columns)
    event_label = frame["kind"].where(frame["kind"] != "autoscale.run", "rule_reapplication")
    tidy = frame.assign(
        timestamp=epoch_ms_to_utc(frame["timestamp_ms"]),
        end_timestamp=epoch_ms_to_utc(frame["end_time_ms"]),
        source="tsuru",
        entity=frame["target_value"],
        metric="event",
        value=1,
        unit="event",
        event_label=event_label,
        owner=None,
        error=None,
    )
    return _assert_frame_cap(tidy.loc[:, columns])
