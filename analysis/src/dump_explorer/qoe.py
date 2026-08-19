"""Consultas agregadas e sem identificadores individuais para QoE do NPAW."""

import json
from collections.abc import Iterable

import pandas as pd
from sqlalchemy import text

from dump_explorer.database import read_frame
from dump_explorer.time_utils import epoch_ms_to_utc

NPAW_DELAY_HOURS = 28
_MAX_SIGNALS = 500
_UNKNOWN_DIMENSIONS = frozenset({"(desconhecido)", "?", "unknown", ""})


def _require_window(start, end) -> None:
    if start is None or end is None:
        raise ValueError("start e end são obrigatórios")
    if end <= start:
        raise ValueError("end deve ser posterior a start")


def _selected_signals(signals: Iterable[str]) -> tuple[list[str], dict[str, str]]:
    if isinstance(signals, str):
        raise ValueError("signals deve ser uma coleção explícita de sinais")
    selected = list(dict.fromkeys(signals))
    if not selected:
        raise ValueError("signals deve conter ao menos um sinal")
    if len(selected) > _MAX_SIGNALS:
        raise ValueError(f"signals aceita no máximo {_MAX_SIGNALS} valores")
    if any(not isinstance(signal, str) or not signal.strip() for signal in selected):
        raise ValueError("signals deve conter apenas textos não vazios")
    return selected, {f"signal_{index}": signal for index, signal in enumerate(selected)}


def _signal_filter(signals: Iterable[str]) -> tuple[str, dict[str, str]]:
    selected, params = _selected_signals(signals)
    placeholders = ", ".join(f":signal_{index}" for index in range(len(selected)))
    return f" AND sinal IN ({placeholders})", params


def add_error_rate(frame: pd.DataFrame) -> pd.DataFrame:
    """Acrescenta porcentagem de erro somente onde houve sessões observadas."""
    result = frame.copy()
    sessions = pd.to_numeric(result["sessions"], errors="coerce")
    errors = pd.to_numeric(result["errors"], errors="coerce")
    result["error_rate_pct"] = errors.div(sessions.where(sessions > 0)).mul(100)
    return result


def annotate_unknown_dimensions(frame: pd.DataFrame) -> pd.DataFrame:
    """Mantém dimensões desconhecidas visíveis em vez de descartá-las do ranking."""
    result = frame.copy()
    dimensions = [
        column
        for column in ("player", "device", "state_province", "isp", "sinal")
        if column in result.columns
    ]
    if not dimensions:
        result["dimension_missing"] = False
        return result
    missing = pd.Series(False, index=result.index)
    for column in dimensions:
        values = result[column].astype("string").str.strip().str.lower()
        missing |= values.isna() | values.isin(_UNKNOWN_DIMENSIONS)
    result["dimension_missing"] = missing.astype(bool)
    return result


def _with_hour_timestamp(frame: pd.DataFrame) -> pd.DataFrame:
    if frame.empty:
        return frame
    return frame.assign(timestamp=epoch_ms_to_utc(frame["timestamp_ms"])).drop(
        columns="timestamp_ms"
    )


def _ranked_qoe(frame: pd.DataFrame) -> pd.DataFrame:
    return annotate_unknown_dimensions(add_error_rate(frame))


def load_player_qoe(engine, start, end) -> pd.DataFrame:
    """Agrega sessões e erros de player na janela UTC horária `[start, end)`."""
    _require_window(start, end)
    frame = read_frame(
        engine,
        text(
            """
            SELECT player, SUM(sessions) AS sessions, SUM(errors) AS errors
            FROM `player_hourly`
            WHERE hour_ts >= :start AND hour_ts < :end
            GROUP BY player
            ORDER BY errors DESC, sessions DESC, player
            """
        ),
        params={"start": start, "end": end},
    )
    return _ranked_qoe(frame)


def load_device_qoe(engine, start, end, min_sessions: int = 30) -> pd.DataFrame:
    """Ranqueia dispositivos somente após o limiar SQL de sessões agregadas."""
    _require_window(start, end)
    if isinstance(min_sessions, bool) or not isinstance(min_sessions, int) or min_sessions < 1:
        raise ValueError("min_sessions deve ser um inteiro positivo")
    frame = read_frame(
        engine,
        text(
            """
            SELECT device, SUM(sessions) AS sessions, SUM(errors) AS errors
            FROM `device_hourly`
            WHERE hour_ts >= :start AND hour_ts < :end
            GROUP BY device
            HAVING SUM(sessions) >= :min_sessions
            ORDER BY errors DESC, sessions DESC, device
            """
        ),
        params={"start": start, "end": end, "min_sessions": min_sessions},
    )
    return _ranked_qoe(frame)


def load_geo_qoe(engine, start, end) -> pd.DataFrame:
    """Agrega QoE por UF e ISP para uma janela UTC explícita."""
    _require_window(start, end)
    frame = read_frame(
        engine,
        text(
            """
            SELECT state_province, isp, SUM(sessions) AS sessions, SUM(errors) AS errors
            FROM `geo_hourly`
            WHERE hour_ts >= :start AND hour_ts < :end
            GROUP BY state_province, isp
            ORDER BY errors DESC, sessions DESC, state_province, isp
            """
        ),
        params={"start": start, "end": end},
    )
    return _ranked_qoe(frame)


def load_live_qoe(engine, signals: Iterable[str], start, end) -> pd.DataFrame:
    """Lê QoE live por canal preservando razão, segundos e milissegundos."""
    _require_window(start, end)
    signal_filter, signal_params = _signal_filter(signals)
    frame = read_frame(
        engine,
        text(
            f"""
            SELECT hour_ts AS timestamp_ms, sinal, sessions, errors, startup_errors,
                   latency_ms_avg, latency_ms_p50, latency_ms_p95, bufferratio_avg,
                   jointime_s_avg, dropped_frames_avg, stalls_avg
            FROM `live_qoe_hourly`
            WHERE hour_ts >= :start AND hour_ts < :end{signal_filter}
            ORDER BY hour_ts, sinal
            """
        ),
        params={"start": start, "end": end, **signal_params},
    )
    result = _with_hour_timestamp(frame)
    if result.empty:
        return result.reindex(
            columns=[
                "timestamp",
                "sinal",
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
                "error_rate_pct",
                "dimension_missing",
                "bufferratio_unit",
                "jointime_unit",
                "latency_unit",
            ]
        )
    return _ranked_qoe(result).assign(
        bufferratio_unit="ratio", jointime_unit="s", latency_unit="ms"
    )


def load_live_active(engine, signals: Iterable[str], start, end) -> pd.DataFrame:
    """Lê sessões ativas concorrentes, sem tratá-las como total acumulado de entradas."""
    _require_window(start, end)
    signal_filter, signal_params = _signal_filter(signals)
    frame = read_frame(
        engine,
        text(
            f"""
            SELECT bucket_ts AS timestamp_ms, sinal, active_sessions, active_with_error,
                   joins_in_bucket, latency_ms_p50, latency_ms_p95, bufferratio_avg,
                   jointime_s_avg, dropped_frames_avg
            FROM `live_active_15min`
            WHERE bucket_ts >= :start AND bucket_ts < :end{signal_filter}
            ORDER BY bucket_ts, sinal
            """
        ),
        params={"start": start, "end": end, **signal_params},
    )
    result = _with_hour_timestamp(frame)
    if result.empty:
        return result.reindex(
            columns=[
                "timestamp",
                "sinal",
                "active_sessions",
                "active_with_error",
                "joins_in_bucket",
                "latency_ms_p50",
                "latency_ms_p95",
                "bufferratio_avg",
                "jointime_s_avg",
                "dropped_frames_avg",
                "active_sessions_semantic",
                "joins_in_bucket_semantic",
            ]
        )
    return annotate_unknown_dimensions(result).assign(
        active_sessions_semantic="concurrent",
        joins_in_bucket_semantic="new_entries",
        bufferratio_unit="ratio",
        jointime_unit="s",
        latency_unit="ms",
    )


def _parse_top_names(value) -> tuple[object, bool]:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return value, False
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    if not isinstance(value, str):
        return value, True
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return value, True
    if not isinstance(parsed, list):
        return value, True
    return parsed, False


def load_error_categories(engine, kind: str, start, end) -> pd.DataFrame:
    """Carrega uma única categoria de conteúdo, sem combinar live e VOD."""
    if kind not in {"live", "vod"}:
        raise ValueError("kind deve ser live ou vod")
    _require_window(start, end)
    frame = read_frame(
        engine,
        text(
            """
            SELECT hour_ts AS timestamp_ms, kind, category, errors, top_names
            FROM `error_cat_hourly`
            WHERE kind = :kind AND hour_ts >= :start AND hour_ts < :end
            ORDER BY hour_ts, category
            """
        ),
        params={"kind": kind, "start": start, "end": end},
    )
    result = _with_hour_timestamp(frame)
    if result.empty:
        return result.reindex(
            columns=[
                "timestamp",
                "kind",
                "category",
                "errors",
                "top_names",
                "top_names_parsed",
                "top_names_parse_error",
            ]
        )
    parsed = result["top_names"].map(_parse_top_names)
    return result.assign(
        top_names_parsed=parsed.map(lambda item: item[0]),
        top_names_parse_error=parsed.map(lambda item: item[1]),
    )
