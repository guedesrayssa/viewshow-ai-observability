"""Leitura e validação dos parâmetros de consulta compartilhados."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import timedelta

from flask import current_app, request

from app.domain.time_window import TimeWindow, resolve_interval
from app.errors import ValidationError


def request_window() -> TimeWindow:
    """Janela pedida via `window` ou `from`/`to`, com limites da configuração."""
    return TimeWindow.from_args(
        request.args,
        default=current_app.config["DEFAULT_WINDOW"],
        maximum=current_app.config["MAX_WINDOW"],
    )


def request_interval(window: TimeWindow) -> timedelta:
    """Granularidade dos buckets; ausente, é derivada do tamanho da janela."""
    return resolve_interval(
        window,
        request.args.get("interval"),
        max_buckets=current_app.config["MAX_TIMESERIES_BUCKETS"],
    )


def request_limit() -> int:
    """Quantidade máxima de itens em rankings e listagens."""
    default = current_app.config["DEFAULT_LIMIT"]
    maximum = current_app.config["MAX_LIMIT"]

    raw = request.args.get("limit")
    if raw is None:
        return default

    try:
        limit = int(raw)
    except ValueError as exc:
        raise ValidationError("O parâmetro `limit` deve ser um número inteiro.") from exc

    if not 1 <= limit <= maximum:
        raise ValidationError(f"O parâmetro `limit` deve estar entre 1 e {maximum}.")
    return limit


def request_choice(name: str, allowed: Iterable[str], default: str) -> str:
    """Parâmetro restrito a um conjunto fechado de valores."""
    options = list(allowed)
    value = request.args.get(name, default).strip().lower()
    if value not in options:
        formatted = ", ".join(f"`{option}`" for option in options)
        raise ValidationError(f"O parâmetro `{name}` deve ser um destes valores: {formatted}.")
    return value


def request_ratio(name: str, default: float) -> float:
    """Parâmetro numérico entre 0 e 1, usado por limiares de correlação."""
    raw = request.args.get(name)
    if raw is None:
        return default

    try:
        value = float(raw)
    except ValueError as exc:
        raise ValidationError(f"O parâmetro `{name}` deve ser numérico.") from exc

    if not 0.0 <= value <= 1.0:
        raise ValidationError(f"O parâmetro `{name}` deve estar entre 0 e 1.")
    return value
