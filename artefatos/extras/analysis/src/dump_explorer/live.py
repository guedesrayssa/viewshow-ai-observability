"""Exploração agregada de confrontos ao vivo, audiência e QoE."""

from collections.abc import Iterable
from dataclasses import dataclass

import pandas as pd
from sqlalchemy import text

from dump_explorer.config import HARD_MAX_ROWS
from dump_explorer.database import ResultLimitError, read_frame
from dump_explorer.time_utils import epoch_ms_to_utc

_MAX_EVENT_KEYS = 100
_TIMELINE_COLUMNS = [
    "event_key",
    "tid",
    "slug",
    "start_ts",
    "end_ts",
    "timestamp_ms",
    "timestamp",
    "active_sessions",
    "active_with_error",
    "bufferratio_avg",
    "jointime_s_avg",
    "error_rate_pct",
    "telemetry_available",
    "mapping_scope",
]
_COMPARISON_COLUMNS = [
    "event_key",
    "tid",
    "slug",
    "start_ts",
    "end_ts",
    "telemetry_available",
    "mapping_scope",
    "peak_audience",
    "peak_active_with_error",
    "error_rate_pct",
    "bufferratio_avg",
    "jointime_s_avg",
]


@dataclass(frozen=True)
class SignalPattern:
    """Mapeamento explícito entre slug EPG e sinal de telemetria."""

    pattern: str
    approximate: bool
    mapping_scope: str


def _require_window(start, end) -> None:
    if start is None or end is None:
        raise ValueError("start e end são obrigatórios")
    if end <= start:
        raise ValueError("end deve ser posterior a start")


def _empty_timeline() -> pd.DataFrame:
    return pd.DataFrame(columns=_TIMELINE_COLUMNS)


def _empty_comparison() -> pd.DataFrame:
    return pd.DataFrame(columns=_COMPARISON_COLUMNS)


def signal_pattern_for_slug(slug: str) -> SignalPattern:
    """Declara quando a família nacional Globo substitui um sinal exato."""
    if not isinstance(slug, str) or not slug.strip():
        raise ValueError("slug deve ser um texto não vazio")
    normalized = slug.strip().lower()
    if normalized == "globo":
        return SignalPattern(
            pattern="globo%",
            approximate=True,
            mapping_scope="national_family_approximation",
        )
    return SignalPattern(pattern=normalized, approximate=False, mapping_scope="exact_signal")


def distinct_event_count(events: pd.DataFrame) -> int:
    """Conta confrontos pela chave EPG, nunca pelo instante ou pelo feed."""
    if "event_key" not in events:
        raise ValueError("events deve conter event_key")
    return int(events["event_key"].nunique(dropna=True))


def load_live_events(engine, start, end) -> pd.DataFrame:
    """Carrega slots EPG que se sobrepõem à janela UTC `[start, end)`."""
    _require_window(start, end)
    return read_frame(
        engine,
        text(
            """
            SELECT event_key, tid, slug, start_ts, end_ts
            FROM `live_event`
            WHERE start_ts < :end AND end_ts > :start
            ORDER BY start_ts, end_ts, event_key, tid
            """
        ),
        params={"start": start, "end": end},
    )


def load_event_audience(engine, event_key: str, padding_minutes: int = 60) -> pd.DataFrame:
    """Alinha audiência/QoE de 15 minutos ao slot EPG, preservando ausência de telemetria."""
    if not isinstance(event_key, str) or not event_key.strip():
        raise ValueError("event_key deve ser um texto não vazio")
    if (
        isinstance(padding_minutes, bool)
        or not isinstance(padding_minutes, int)
        or padding_minutes < 0
    ):
        raise ValueError("padding_minutes deve ser um inteiro não negativo")

    frame = read_frame(
        engine,
        text(
            """
            WITH event_slots AS (
                SELECT
                    event_key,
                    tid,
                    slug,
                    start_ts,
                    end_ts,
                    CASE
                        WHEN slug = 'globo' THEN 'national_family_approximation'
                        ELSE 'exact_signal'
                    END AS mapping_scope
                FROM `live_event`
                WHERE event_key = :event_key
            )
            SELECT
                e.event_key,
                e.tid,
                e.slug,
                e.start_ts,
                e.end_ts,
                e.mapping_scope,
                a.bucket_ts AS timestamp_ms,
                SUM(a.active_sessions) AS active_sessions,
                SUM(a.active_with_error) AS active_with_error,
                SUM(a.bufferratio_avg * a.active_sessions)
                    / NULLIF(SUM(a.active_sessions), 0) AS bufferratio_avg,
                SUM(a.jointime_s_avg * a.active_sessions)
                    / NULLIF(SUM(a.active_sessions), 0) AS jointime_s_avg
            FROM event_slots AS e
            LEFT JOIN `live_active_15min` AS a
                ON a.bucket_ts >= e.start_ts - :padding_ms
                AND a.bucket_ts < e.end_ts + :padding_ms
                AND (
                    a.sinal = e.slug
                    OR (e.slug = 'globo' AND a.sinal LIKE :globo_pattern)
                )
            GROUP BY
                e.event_key,
                e.tid,
                e.slug,
                e.start_ts,
                e.end_ts,
                e.mapping_scope,
                a.bucket_ts
            ORDER BY e.start_ts, e.event_key, e.tid, a.bucket_ts
            """
        ),
        params={
            "event_key": event_key.strip(),
            "padding_ms": padding_minutes * 60_000,
            "globo_pattern": signal_pattern_for_slug("globo").pattern,
        },
    )
    if frame.empty:
        return _empty_timeline()

    result = frame.copy()
    result["telemetry_available"] = result["timestamp_ms"].notna()
    result["timestamp"] = epoch_ms_to_utc(result["timestamp_ms"])
    audience = pd.to_numeric(result["active_sessions"], errors="coerce")
    errors = pd.to_numeric(result["active_with_error"], errors="coerce")
    result["error_rate_pct"] = errors.div(audience.where(audience > 0)).mul(100)
    return result.reindex(columns=_TIMELINE_COLUMNS)


def _selected_event_keys(event_keys: Iterable[str]) -> list[str]:
    if isinstance(event_keys, str):
        raise ValueError("event_keys deve ser uma coleção explícita de chaves")
    selected = list(dict.fromkeys(event_keys))
    if not selected:
        raise ValueError("event_keys deve conter ao menos uma chave")
    if len(selected) > _MAX_EVENT_KEYS:
        raise ResultLimitError(f"event_keys aceita no máximo {_MAX_EVENT_KEYS} valores")
    if any(not isinstance(key, str) or not key.strip() for key in selected):
        raise ValueError("event_keys deve conter apenas textos não vazios")
    return selected


def _weighted_average(frame: pd.DataFrame, column: str) -> float | None:
    values = pd.to_numeric(frame[column], errors="coerce")
    weights = pd.to_numeric(frame["active_sessions"], errors="coerce")
    valid = values.notna() & weights.notna() & (weights > 0)
    if not valid.any():
        return None
    return float((values[valid] * weights[valid]).sum() / weights[valid].sum())


def build_event_comparison(engine, event_keys: Iterable[str]) -> pd.DataFrame:
    """Resume confrontos sem descartar slots EPG que ainda não têm telemetria."""
    records = []
    for event_key in _selected_event_keys(event_keys):
        timeline = load_event_audience(engine, event_key)
        if timeline.empty:
            continue
        for _, feed in timeline.groupby(
            ["event_key", "tid", "slug", "start_ts", "end_ts"], dropna=False
        ):
            first = feed.iloc[0]
            in_event_window = (feed["timestamp_ms"] >= first["start_ts"]) & (
                feed["timestamp_ms"] < first["end_ts"]
            )
            observed = feed.loc[feed["telemetry_available"] & in_event_window.fillna(False)]
            available = not observed.empty
            audience = pd.to_numeric(observed["active_sessions"], errors="coerce")
            errors = pd.to_numeric(observed["active_with_error"], errors="coerce")
            records.append(
                {
                    "event_key": first["event_key"],
                    "tid": first["tid"],
                    "slug": first["slug"],
                    "start_ts": first["start_ts"],
                    "end_ts": first["end_ts"],
                    "telemetry_available": available,
                    "mapping_scope": first["mapping_scope"],
                    "peak_audience": audience.max() if available else None,
                    "peak_active_with_error": errors.max() if available else None,
                    "error_rate_pct": (
                        errors.sum() / audience.where(audience > 0).sum() * 100
                        if audience.where(audience > 0).notna().any()
                        else None
                    ),
                    "bufferratio_avg": _weighted_average(observed, "bufferratio_avg"),
                    "jointime_s_avg": _weighted_average(observed, "jointime_s_avg"),
                }
            )
    if len(records) > HARD_MAX_ROWS:
        raise ResultLimitError(f"comparação excede o limite de {HARD_MAX_ROWS} linhas")
    return pd.DataFrame(records, columns=_COMPARISON_COLUMNS)
