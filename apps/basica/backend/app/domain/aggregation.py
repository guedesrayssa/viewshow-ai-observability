"""Agregações genéricas compartilhadas pelos serviços analíticos."""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Iterable
from typing import Any, TypeVar

from app.domain.statistics import ratio, rounded

RecordT = TypeVar("RecordT")


def count_by(records: Iterable[RecordT], key: Callable[[RecordT], str]) -> Counter[str]:
    """Conta registros por chave de agrupamento."""
    return Counter(key(record) for record in records)


def unique_by(records: Iterable[RecordT], key: Callable[[RecordT], str]) -> set[str]:
    """Conjunto de valores distintos de uma chave."""
    return {key(record) for record in records}


def sessions_of(*collections: Iterable[Any]) -> set[str]:
    """Sessões distintas observadas em uma ou mais coleções de registros."""
    return {record.session_id for collection in collections for record in collection}


def ranking(
    counts: Counter[str],
    *,
    total: int | None = None,
    limit: int | None = None,
    label: str = "value",
) -> list[dict[str, Any]]:
    """Ordena contagens por volume (e alfabeticamente em caso de empate)."""
    base = total if total is not None else sum(counts.values())
    ordered = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    if limit is not None:
        ordered = ordered[:limit]

    return [
        {label: value, "occurrences": occurrences, "share": rounded(ratio(occurrences, base))}
        for value, occurrences in ordered
    ]
