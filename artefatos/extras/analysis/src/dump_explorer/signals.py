"""Consultas limitadas para explorar sinais normalizados do dump Argus."""

import json
from collections.abc import Iterable
from itertools import islice

import pandas as pd
from sqlalchemy import text

from dump_explorer.config import HARD_MAX_ROWS
from dump_explorer.database import ResultLimitError, read_frame
from dump_explorer.time_utils import epoch_ms_to_utc

_SIGNAL_TABLES = {
    "signal_bucket": {"timestamp_column": "bts", "has_tags": False},
    "signal_point": {"timestamp_column": "ts", "has_tags": True},
}
_MAX_SERIES = 500
_MAX_CORRELATION_SERIES = 20


def _require_window(start, end) -> None:
    if start is None or end is None:
        raise ValueError("start e end são obrigatórios")
    if end <= start:
        raise ValueError("end deve ser posterior a start")


def _require_identity(source, entity, metric, start, end) -> None:
    if any(not isinstance(value, str) or not value.strip() for value in (source, entity, metric)):
        raise ValueError("source, entity, metric, start e end são obrigatórios")
    if start is None or end is None:
        raise ValueError("source, entity, metric, start e end são obrigatórios")
    if end <= start:
        raise ValueError("end deve ser posterior a start")


def _empty_metric_frame(has_tags: bool) -> pd.DataFrame:
    columns = ["timestamp", "value"]
    if has_tags:
        columns.extend(["tags", "tags_parse_error"])
    return pd.DataFrame(columns=columns)


def parse_signal_tags(value) -> tuple[object, bool]:
    """Interpreta tags JSON sem descartar o valor original se ele for inválido."""
    if value is None or not isinstance(value, (str, bytes, bytearray)):
        return value, False
    try:
        return json.loads(value), False
    except (TypeError, ValueError, json.JSONDecodeError):
        return value, True


def load_source_distribution(engine, start, end) -> pd.DataFrame:
    """Conta observações por origem dentro de uma janela UTC fechada-aberta."""
    _require_window(start, end)
    return read_frame(
        engine,
        text(
            """
            SELECT source, COUNT(*) AS rows
            FROM `signal_bucket`
            WHERE bts >= :start AND bts < :end
            GROUP BY source
            ORDER BY rows DESC, source
            """
        ),
        params={"start": start, "end": end},
    )


def list_series(engine, source, start, end, limit: int = _MAX_SERIES) -> pd.DataFrame:
    """Lista no máximo 500 identidades de série de uma origem e janela explícitas."""
    if not isinstance(source, str) or not source.strip():
        raise ValueError("source é obrigatório")
    _require_window(start, end)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= _MAX_SERIES:
        raise ValueError("limit deve estar entre 1 e 500")
    return read_frame(
        engine,
        text(
            """
            SELECT source, entity, metric, COUNT(*) AS rows
            FROM `signal_bucket`
            WHERE source = :source
              AND bts >= :start
              AND bts < :end
            GROUP BY source, entity, metric
            ORDER BY rows DESC, source, entity, metric
            LIMIT :limit
            """
        ),
        params={"source": source, "start": start, "end": end, "limit": limit},
        max_rows=limit,
    )


def load_metric_series(
    engine,
    source,
    entity,
    metric,
    start,
    end,
    table: str = "signal_bucket",
    *,
    max_rows: int = HARD_MAX_ROWS,
) -> pd.DataFrame:
    """Carrega valores sem reamostragem para uma única identidade natural."""
    if table not in _SIGNAL_TABLES:
        raise ValueError("table deve ser signal_bucket ou signal_point")
    _require_identity(source, entity, metric, start, end)
    spec = _SIGNAL_TABLES[table]
    tags_sql = ", tags" if spec["has_tags"] else ""
    frame = read_frame(
        engine,
        text(
            f"""
            SELECT {spec["timestamp_column"]} AS timestamp_ms, value{tags_sql}
            FROM `{table}`
            WHERE source = :source
              AND entity = :entity
              AND metric = :metric
              AND {spec["timestamp_column"]} >= :start
              AND {spec["timestamp_column"]} < :end
            ORDER BY {spec["timestamp_column"]}
            """
        ),
        params={
            "source": source,
            "entity": entity,
            "metric": metric,
            "start": start,
            "end": end,
        },
        max_rows=max_rows,
    )
    if frame.empty:
        return _empty_metric_frame(spec["has_tags"])

    normalized = frame.assign(timestamp=epoch_ms_to_utc(frame["timestamp_ms"])).drop(
        columns="timestamp_ms"
    )
    if not spec["has_tags"]:
        return normalized.loc[:, ["timestamp", "value"]]

    parsed_tags = normalized["tags"].map(parse_signal_tags)
    return normalized.assign(
        tags=parsed_tags.map(lambda result: result[0]),
        tags_parse_error=parsed_tags.map(lambda result: result[1]),
    ).loc[:, ["timestamp", "value", "tags", "tags_parse_error"]]


def load_correlation_frame(
    engine, series_keys: Iterable[tuple[str, str, str]], start, end
) -> pd.DataFrame:
    """Alinha séries solicitadas explicitamente, preservando lacunas como valores ausentes."""
    _require_window(start, end)
    keys = tuple(islice(series_keys, _MAX_CORRELATION_SERIES + 1))
    if len(keys) > _MAX_CORRELATION_SERIES:
        raise ValueError("correlação aceita no máximo 20 séries")
    if not keys:
        return pd.DataFrame(columns=["timestamp"])

    labels: set[str] = set()
    aligned = []
    rows_read = 0
    for key in keys:
        if len(key) != 3:
            raise ValueError("cada série deve conter source, entity e metric")
        source, entity, metric = key
        _require_identity(source, entity, metric, start, end)
        label = "|".join(key)
        if label in labels:
            raise ValueError("séries de correlação não podem ser repetidas")
        labels.add(label)

        remaining_rows = HARD_MAX_ROWS - rows_read
        if remaining_rows < 1:
            raise ResultLimitError(f"correlação excede o limite de {HARD_MAX_ROWS} linhas")
        frame = load_metric_series(
            engine, source, entity, metric, start, end, max_rows=remaining_rows
        )
        if frame["timestamp"].duplicated().any():
            raise ValueError("timestamps duplicados exigem agregação explícita antes da correlação")
        rows_read += len(frame)
        if rows_read > HARD_MAX_ROWS:
            raise ResultLimitError(f"correlação excede o limite de {HARD_MAX_ROWS} linhas")
        aligned.append(frame.set_index("timestamp")["value"].rename(label))

    return pd.concat(aligned, axis=1, join="outer").sort_index().reset_index()
