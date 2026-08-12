"""Janelas de tempo, intervalos e agrupamento em buckets."""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, TypeVar

from app.domain.clock import ensure_utc, to_iso, utcnow
from app.errors import ValidationError

_DURATION_PATTERN = re.compile(r"^(?P<value>\d+)(?P<unit>[smhd])$")
_UNIT_TO_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400}

# Escada de intervalos "redondos" usada quando o cliente não informa `interval`.
_BUCKET_LADDER = (10, 30, 60, 300, 900, 1800, 3600, 10800, 21600, 86400)
_TARGET_BUCKETS = 60

RecordT = TypeVar("RecordT")


def parse_duration(raw: str, *, field: str) -> timedelta:
    """Interpreta durações no formato ``<número><s|m|h|d>``, como ``15m``."""
    match = _DURATION_PATTERN.match(raw.strip().lower())
    if not match:
        raise ValidationError(
            f"O parâmetro `{field}` deve seguir o formato <número><s|m|h|d>, por exemplo `15m`."
        )

    seconds = int(match["value"]) * _UNIT_TO_SECONDS[match["unit"]]
    if seconds <= 0:
        raise ValidationError(f"O parâmetro `{field}` deve ser maior que zero.")
    return timedelta(seconds=seconds)


def parse_timestamp(raw: str, *, field: str) -> datetime:
    """Interpreta uma data ISO 8601 e a normaliza para UTC."""
    try:
        moment = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValidationError(
            f"O parâmetro `{field}` deve ser uma data ISO 8601, por exemplo `2026-08-11T12:00:00Z`."
        ) from exc
    return ensure_utc(moment)


@dataclass(frozen=True, slots=True)
class TimeWindow:
    """Intervalo fechado ``[start, end]`` usado por todas as consultas."""

    start: datetime
    end: datetime

    def __post_init__(self) -> None:
        if self.start >= self.end:
            raise ValidationError("O início da janela deve ser anterior ao fim.")

    @property
    def duration(self) -> timedelta:
        return self.end - self.start

    def contains(self, moment: datetime) -> bool:
        return self.start <= moment <= self.end

    def buckets(self, interval: timedelta) -> list[TimeWindow]:
        """Divide a janela em fatias consecutivas de tamanho ``interval``."""
        if interval <= timedelta(0):
            raise ValidationError("O intervalo dos buckets deve ser maior que zero.")

        slices: list[TimeWindow] = []
        cursor = self.start
        while cursor < self.end:
            following = min(cursor + interval, self.end)
            slices.append(TimeWindow(cursor, following))
            cursor = following
        return slices

    def as_dict(self) -> dict[str, Any]:
        return {
            "start": to_iso(self.start),
            "end": to_iso(self.end),
            "duration_seconds": int(self.duration.total_seconds()),
        }

    @classmethod
    def from_args(
        cls,
        args: Mapping[str, str],
        *,
        default: timedelta,
        now: datetime | None = None,
        maximum: timedelta | None = None,
    ) -> TimeWindow:
        """Constrói a janela a partir de ``window`` ou do par ``from``/``to``."""
        now = ensure_utc(now or utcnow())
        relative = args.get("window")
        start_arg = args.get("from")
        end_arg = args.get("to")

        if relative and (start_arg or end_arg):
            raise ValidationError(
                "Use `window` ou o par `from`/`to`, nunca os dois ao mesmo tempo."
            )

        if relative:
            start, end = now - parse_duration(relative, field="window"), now
        elif start_arg and end_arg:
            start = parse_timestamp(start_arg, field="from")
            end = parse_timestamp(end_arg, field="to")
        elif start_arg:
            start, end = parse_timestamp(start_arg, field="from"), now
        elif end_arg:
            end = parse_timestamp(end_arg, field="to")
            start = end - default
        else:
            start, end = now - default, now

        if start >= end:
            raise ValidationError("O parâmetro `from` deve ser anterior a `to`.")
        if maximum is not None and end - start > maximum:
            raise ValidationError(
                f"A janela consultada não pode exceder {int(maximum.total_seconds())} segundos."
            )
        return cls(start, end)


def resolve_interval(
    window: TimeWindow,
    raw: str | None = None,
    *,
    max_buckets: int = 500,
) -> timedelta:
    """Escolhe o intervalo dos buckets, respeitando o teto de granularidade."""
    interval = parse_duration(raw, field="interval") if raw else _auto_interval(window)

    if math.ceil(window.duration / interval) > max_buckets:
        raise ValidationError(
            f"O intervalo informado gera mais de {max_buckets} pontos; "
            "aumente `interval` ou reduza a janela."
        )
    return interval


def _auto_interval(window: TimeWindow) -> timedelta:
    """Menor intervalo da escada que mantém a série próxima de 60 pontos."""
    target = window.duration / _TARGET_BUCKETS
    for seconds in _BUCKET_LADDER:
        candidate = timedelta(seconds=seconds)
        if candidate >= target:
            return candidate
    return timedelta(seconds=_BUCKET_LADDER[-1])


def group_by_bucket(
    records: Iterable[RecordT],
    buckets: Sequence[TimeWindow],
    key: Callable[[RecordT], datetime] | None = None,
) -> list[list[RecordT]]:
    """Distribui registros entre buckets consecutivos em uma única varredura."""
    moment_of = key or (lambda record: record.occurred_at)
    ordered = sorted(records, key=moment_of)
    grouped: list[list[RecordT]] = [[] for _ in buckets]

    position = 0
    for index, bucket in enumerate(buckets):
        is_last = index == len(buckets) - 1
        while position < len(ordered) and moment_of(ordered[position]) < bucket.start:
            position += 1
        while position < len(ordered):
            moment = moment_of(ordered[position])
            if moment > bucket.end or (moment == bucket.end and not is_last):
                break
            grouped[index].append(ordered[position])
            position += 1
    return grouped
