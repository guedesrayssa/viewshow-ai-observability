"""Funções estatísticas usadas pelos serviços analíticos."""

from __future__ import annotations

import math
from collections.abc import Sequence


def ratio(numerator: float, denominator: float) -> float:
    """Divisão protegida contra denominador zero."""
    if not denominator:
        return 0.0
    return numerator / denominator


def rate(numerator: float, denominator: float) -> float | None:
    """Taxa que vale ``None`` quando não há base de comparação.

    Diferente de `ratio`, distingue "nenhuma medição" de "medição igual a zero":
    cinco erros sem nenhum evento de reprodução não formam uma taxa de 0%.
    """
    if not denominator:
        return None
    return numerator / denominator


def mean(values: Sequence[float]) -> float | None:
    """Média aritmética, ou ``None`` quando não há amostras."""
    if not values:
        return None
    return sum(values) / len(values)


def percentile(values: Sequence[float], percent: float) -> float | None:
    """Percentil por interpolação linear, ou ``None`` quando não há amostras."""
    if not 0 <= percent <= 100:
        raise ValueError("O percentil deve estar entre 0 e 100.")
    if not values:
        return None

    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])

    rank = (len(ordered) - 1) * (percent / 100)
    lower = math.floor(rank)
    upper = math.ceil(rank)
    if lower == upper:
        return float(ordered[lower])
    return float(ordered[lower] + (ordered[upper] - ordered[lower]) * (rank - lower))


def pearson(xs: Sequence[float], ys: Sequence[float]) -> float:
    """Coeficiente de correlação de Pearson; 0.0 quando alguma série é constante."""
    size = min(len(xs), len(ys))
    if size < 2:
        return 0.0

    mean_x = sum(xs[:size]) / size
    mean_y = sum(ys[:size]) / size
    covariance = sum((xs[i] - mean_x) * (ys[i] - mean_y) for i in range(size))
    deviation_x = math.sqrt(sum((xs[i] - mean_x) ** 2 for i in range(size)))
    deviation_y = math.sqrt(sum((ys[i] - mean_y) ** 2 for i in range(size)))

    if not deviation_x or not deviation_y:
        return 0.0
    return covariance / (deviation_x * deviation_y)


def rounded(value: float | None, digits: int = 4) -> float | None:
    """Arredonda mantendo ``None`` quando a métrica não tem amostras."""
    if value is None:
        return None
    return round(value, digits)
