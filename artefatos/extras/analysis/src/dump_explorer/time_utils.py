"""Conversões explícitas entre épocas UTC e fusos de exibição."""

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pandas as pd


class TimeConversionError(ValueError):
    """Indica que um fuso horário não pode ser aplicado."""


def epoch_ms_to_utc(values: pd.Series) -> pd.Series:
    """Converte milissegundos desde a época em timestamps UTC."""
    return pd.to_datetime(values, unit="ms", utc=True, errors="coerce")


def to_timezone(values: pd.Series, timezone: str) -> pd.Series:
    """Converte uma série de timestamps UTC para o fuso solicitado."""
    try:
        zone = ZoneInfo(timezone)
    except ZoneInfoNotFoundError as exc:
        raise TimeConversionError(f"Fuso horário inválido: {timezone}") from exc

    return values.dt.tz_convert(zone)


def local_day(values: pd.Series, timezone: str) -> pd.Series:
    """Retorna o dia civil do fuso solicitado para timestamps UTC."""
    return to_timezone(values, timezone).dt.date
