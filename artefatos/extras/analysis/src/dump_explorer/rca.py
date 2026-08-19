"""Leituras seguras para correlacionar incidentes e evidência de RCA do Argus."""

import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import pandas as pd
from sqlalchemy import text

from dump_explorer.config import HARD_MAX_ROWS
from dump_explorer.database import read_frame
from dump_explorer.qos import load_tsuru_events
from dump_explorer.time_utils import epoch_ms_to_utc

_INCIDENT_SCOPES = {"video": "incidents", "platform": "incidents_platform"}
_CONFIRMED_PROVENANCES = ("rca-confirmed", "team-confirmed")
_DISPLAY_PROVENANCES = frozenset((*_CONFIRMED_PROVENANCES, "itsm", "detector-derived"))
_ALLOWED_OFFSETS = {
    "15m": timedelta(minutes=15),
    "30m": timedelta(minutes=30),
    "1h": timedelta(hours=1),
    "2h": timedelta(hours=2),
    "6h": timedelta(hours=6),
}
_MAX_SELECTION_VALUES = 500


class ArtifactFormatError(ValueError):
    """Indica que um artefato nomeado não tem um payload JSON utilizável."""


@dataclass(frozen=True)
class IncidentWindow:
    """Contexto temporal de um ticket sem inferir causalidade a partir da sobreposição."""

    incident: pd.Series
    signals: pd.DataFrame
    deploys: pd.DataFrame
    attribution: pd.DataFrame
    labels: pd.DataFrame


def _require_window(start, end) -> None:
    if start is None or end is None:
        raise ValueError("start e end são obrigatórios")
    if end <= start:
        raise ValueError("end deve ser posterior a start")


def _parse_json(value) -> tuple[object, bool]:
    """Mantém JSON inválido visível e marca-o, em vez de escondê-lo ou falhar a leitura."""
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return value, False
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    if not isinstance(value, str):
        return value, True
    try:
        return json.loads(value), False
    except (TypeError, ValueError, json.JSONDecodeError):
        return value, True


def _selected_values(
    values: Iterable[str] | None, *, name: str, allowed=None
) -> tuple[list[str], dict[str, str]]:
    if values is None:
        return [], {}
    if isinstance(values, str):
        raise ValueError(f"{name} deve ser uma coleção explícita de valores")
    selected = list(dict.fromkeys(values))
    if len(selected) > _MAX_SELECTION_VALUES:
        raise ValueError(f"{name} aceita no máximo {_MAX_SELECTION_VALUES} valores")
    if any(not isinstance(value, str) or not value.strip() for value in selected):
        raise ValueError(f"{name} deve conter apenas textos não vazios")
    if allowed is not None and any(value not in allowed for value in selected):
        raise ValueError(f"{name} contém valor não permitido")
    return selected, {f"{name[:-1]}_{index}": value for index, value in enumerate(selected)}


def _empty_incidents() -> pd.DataFrame:
    return pd.DataFrame(
        columns=[
            "opened_at",
            "resolved_at",
            "closed_at",
            "priority",
            "priority_value",
            "state",
            "state_value",
            "assignment_group",
            "business_service",
            "cmdb_ci",
            "external_impact",
            "change_or_deploy",
            "duration_ms",
            "opened_at_label",
            "opened_at_uncertainty_minutes",
        ]
    )


def load_incidents(engine, start, end, scope: str = "video") -> pd.DataFrame:
    """Carrega somente campos estruturados de tickets numa janela UTC fechada-aberta.

    ``opened_at`` é a abertura do ticket, não o início do incidente. A coluna
    ``opened_at_uncertainty_minutes`` documenta uma banda visual de ±40 minutos;
    o timestamp armazenado nunca é deslocado ou corrigido.
    """
    _require_window(start, end)
    try:
        table = _INCIDENT_SCOPES[scope]
    except KeyError as exc:
        raise ValueError("scope deve ser video ou platform") from exc
    frame = read_frame(
        engine,
        text(
            f"""
            SELECT opened_at AS opened_at_ms, resolved_at AS resolved_at_ms,
                   closed_at AS closed_at_ms, priority, priority_value, state, state_value,
                   assignment_group, business_service, cmdb_ci,
                   u_this_incident_caused_external_impacts AS external_impact,
                   u_this_incident_was_caused_by_a_change_or_deploy AS change_or_deploy
            FROM `{table}`
            WHERE opened_at >= :start AND opened_at < :end
            ORDER BY opened_at
            LIMIT :row_limit
            """
        ),
        params={"start": start, "end": end, "row_limit": HARD_MAX_ROWS},
        max_rows=HARD_MAX_ROWS,
    )
    if frame.empty:
        return _empty_incidents()
    opened_at = epoch_ms_to_utc(frame["opened_at_ms"])
    resolved_at = epoch_ms_to_utc(frame["resolved_at_ms"])
    closed_at = epoch_ms_to_utc(frame["closed_at_ms"])
    return frame.assign(
        opened_at=opened_at,
        resolved_at=resolved_at,
        closed_at=closed_at,
        duration_ms=frame["resolved_at_ms"].sub(frame["opened_at_ms"]),
        opened_at_label="ticket-open time (not incident-start)",
        opened_at_uncertainty_minutes=40,
    ).loc[:, _empty_incidents().columns]


def _empty_labels() -> pd.DataFrame:
    return pd.DataFrame(
        columns=[
            "tier",
            "kind",
            "ts_start",
            "ts_end",
            "severity",
            "region",
            "services",
            "services_parse_error",
            "metrics_cited",
            "metrics_cited_parse_error",
            "provenance",
            "circular",
            "evaluation_eligible",
        ]
    )


def load_labels(engine, provenances: Iterable[str] | None = None) -> pd.DataFrame:
    """Lê rótulos curados; a avaliação padrão exclui fontes circulares por construção."""
    if provenances is None:
        selected = list(_CONFIRMED_PROVENANCES)
        params = {f"provenance_{index}": value for index, value in enumerate(selected)}
    else:
        selected, params = _selected_values(
            provenances, name="provenances", allowed=_DISPLAY_PROVENANCES
        )
        if not selected:
            return _empty_labels()
        params = {f"provenance_{index}": value for index, value in enumerate(selected)}
    placeholders = ", ".join(f":provenance_{index}" for index in range(len(selected)))
    params["row_limit"] = HARD_MAX_ROWS
    frame = read_frame(
        engine,
        text(
            f"""
            SELECT tier, kind, ts_start AS ts_start_ms, ts_end AS ts_end_ms, severity, region,
                   services, metrics_cited, provenance
            FROM `incident_label`
            WHERE provenance IN ({placeholders})
            ORDER BY ts_start, provenance
            LIMIT :row_limit
            """
        ),
        params=params,
        max_rows=HARD_MAX_ROWS,
    )
    if frame.empty:
        return _empty_labels()
    services = frame["services"].map(_parse_json)
    metrics = frame["metrics_cited"].map(_parse_json)
    return frame.assign(
        ts_start=epoch_ms_to_utc(frame["ts_start_ms"]),
        ts_end=epoch_ms_to_utc(frame["ts_end_ms"]),
        services=services.map(lambda item: item[0]),
        services_parse_error=services.map(lambda item: item[1]),
        metrics_cited=metrics.map(lambda item: item[0]),
        metrics_cited_parse_error=metrics.map(lambda item: item[1]),
        circular=frame["provenance"].eq("detector-derived"),
        evaluation_eligible=frame["provenance"].isin(_CONFIRMED_PROVENANCES),
    ).loc[:, _empty_labels().columns]


def load_error_attribution(
    engine, start, end, signals: Iterable[str] | None = None
) -> pd.DataFrame:
    """Agrega erros live por camada, CDN e código HTTP, com janela e fan-out limitados."""
    _require_window(start, end)
    selected, signal_params = _selected_values(signals, name="signals")
    signal_filter = ""
    if selected:
        placeholders = ", ".join(f":signal_{index}" for index in range(len(selected)))
        signal_filter = f" AND sinal IN ({placeholders})"
    frame = read_frame(
        engine,
        text(
            f"""
            SELECT hour_ts AS timestamp_ms, sinal, cdn, tier, http_code, SUM(errors) AS errors
            FROM `live_error_attr_hourly`
            WHERE hour_ts >= :start AND hour_ts < :end{signal_filter}
            GROUP BY hour_ts, sinal, cdn, tier, http_code
            ORDER BY hour_ts, sinal, cdn, tier, http_code
            LIMIT :row_limit
            """
        ),
        params={"start": start, "end": end, "row_limit": HARD_MAX_ROWS, **signal_params},
        max_rows=HARD_MAX_ROWS,
    )
    columns = ["timestamp", "sinal", "cdn", "tier", "http_code", "errors"]
    if frame.empty:
        return pd.DataFrame(columns=columns)
    return frame.assign(timestamp=epoch_ms_to_utc(frame["timestamp_ms"])).loc[:, columns]


def _window_offset(value: str, name: str) -> timedelta:
    if value not in _ALLOWED_OFFSETS:
        allowed = ", ".join(_ALLOWED_OFFSETS)
        raise ValueError(f"{name} deve ser um de: {allowed}")
    return _ALLOWED_OFFSETS[value]


def _as_utc_timestamp(value) -> pd.Timestamp:
    timestamp = pd.Timestamp(value)
    if pd.isna(timestamp):
        raise ValueError("incident.opened_at deve ser um timestamp válido")
    if timestamp.tzinfo is None:
        return timestamp.tz_localize("UTC")
    return timestamp.tz_convert("UTC")


def build_incident_window(
    engine, incident: pd.Series, before: str = "1h", after: str = "1h"
) -> IncidentWindow:
    """Reúne atribuição, deploy e rótulos no entorno permitido da abertura do ticket."""
    if not isinstance(incident, pd.Series) or "opened_at" not in incident:
        raise ValueError("incident deve conter opened_at")
    opened_at = _as_utc_timestamp(incident["opened_at"])
    start = int((opened_at - _window_offset(before, "before")).value // 1_000_000)
    end = int((opened_at + _window_offset(after, "after")).value // 1_000_000)
    attribution = load_error_attribution(engine, start, end)
    deploys = load_tsuru_events(engine, [], start, end)
    labels = load_labels(engine)
    if not labels.empty:
        window_start = pd.Timestamp(start, unit="ms", tz="UTC")
        window_end = pd.Timestamp(end, unit="ms", tz="UTC")
        labels = labels.loc[
            (labels["ts_start"] < window_end)
            & (labels["ts_end"].isna() | (labels["ts_end"] >= window_start))
        ].reset_index(drop=True)
    return IncidentWindow(
        incident=incident,
        signals=attribution,
        deploys=deploys,
        attribution=attribution,
        labels=labels,
    )


def load_dashboard_artifact(engine, name: str) -> Mapping[str, Any]:
    """Lê um único artefato pelo nome exato e exige que seu JSON seja um objeto."""
    if not isinstance(name, str) or not name.strip() or len(name) > 64:
        raise ArtifactFormatError(f"artefato inválido: {name}")
    frame = read_frame(
        engine,
        text("SELECT payload FROM `dashboard_artifact` WHERE name = :name LIMIT 1"),
        params={"name": name},
        max_rows=1,
    )
    if frame.empty or "payload" not in frame:
        raise ArtifactFormatError(f"artefato inválido: {name}")
    payload = frame.loc[frame.index[0], "payload"]
    if isinstance(payload, bytes):
        payload = payload.decode("utf-8", errors="replace")
    try:
        parsed = json.loads(payload)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ArtifactFormatError(f"artefato inválido: {name}") from exc
    if not isinstance(parsed, Mapping):
        raise ArtifactFormatError(f"artefato inválido: {name}")
    return parsed
