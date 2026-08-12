"""Relógio e serialização de datas, isolados para permitir testes determinísticos."""

from __future__ import annotations

from datetime import datetime, timezone


def utcnow() -> datetime:
    """Retorna o instante atual em UTC, sempre com fuso horário explícito."""
    return datetime.now(timezone.utc)


def ensure_utc(moment: datetime) -> datetime:
    """Normaliza um datetime para UTC; datas sem fuso são tratadas como UTC."""
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def to_iso(moment: datetime | None) -> str | None:
    """Serializa um datetime no formato ISO 8601 com sufixo `Z`."""
    if moment is None:
        return None
    return ensure_utc(moment).isoformat().replace("+00:00", "Z")
