"""Serializa valores suportados em JSON canônico usado por hashes e identidades.

Papel no fluxo:
    Este arquivo pertence ao núcleo de domínio e deve permanecer determinístico, sem acesso a
    rede, sistema de arquivos, banco de dados ou variáveis de ambiente.

Garantias e limites:
    As validações falham de forma fechada: valores ambíguos ou incompletos são rejeitados antes
    de atravessar uma porta de persistência.
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from enum import Enum
from typing import Any, cast


def canonical_decimal_text(value: Decimal) -> str:
    """Produz a representação canônica de decimal texto.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not value.is_finite():
        raise ValueError("Decimal values must be finite")
    sign, digits, raw_exponent = value.as_tuple()
    if not any(digits):
        return "0"
    exponent = cast(int, raw_exponent)
    digit_text = "".join(str(digit) for digit in digits) or "0"
    if exponent >= 0:
        text = digit_text + ("0" * exponent)
    else:
        decimal_position = len(digit_text) + exponent
        if decimal_position > 0:
            text = digit_text[:decimal_position] + "." + digit_text[decimal_position:]
        else:
            text = "0." + ("0" * -decimal_position) + digit_text
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    text = text or "0"
    return ("-" if sign else "") + text


def _datetime_text(value: datetime) -> str:
    """Converte datetime para sua representação textual canônica.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError("datetime values must be aware UTC datetimes")
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _normalize(value: Any) -> Any:
    """Normaliza a entrada para o modelo canônico da ingestão.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``Any`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    if isinstance(value, Decimal):
        return {"$decimal": canonical_decimal_text(value)}
    if isinstance(value, datetime):
        return {"$datetime": _datetime_text(value)}
    if isinstance(value, Enum):
        return _normalize(value.value)
    if value is None or isinstance(value, str | int | bool):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("float values must be finite")
        return value
    if isinstance(value, Mapping):
        normalized: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError("canonical JSON object keys must be strings")
            normalized[key] = _normalize(item)
        return normalized
    if isinstance(value, list | tuple):
        return [_normalize(item) for item in value]
    raise TypeError(f"unsupported canonical JSON value: {type(value).__name__}")


def canonical_bytes(value: object) -> bytes:
    """Produz a representação canônica de bytes.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``bytes`` produzido pela operação após as validações.
    """
    normalized = _normalize(value)
    return json.dumps(
        normalized,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


__all__ = ["canonical_bytes", "canonical_decimal_text"]
