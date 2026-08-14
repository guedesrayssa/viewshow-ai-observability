"""Assinatura de erros recorrentes.

O fingerprint agrupa ocorrências do mesmo problema mesmo quando a mensagem
varia em identificadores e números. Como deriva apenas de campos imutáveis do
erro, é calculado uma única vez na ingestão e apenas lido pelas consultas.
"""

from __future__ import annotations

import hashlib
import re

FINGERPRINT_LENGTH = 12

# Ruído removido antes de agrupar mensagens em um mesmo padrão.
_NOISE_PATTERNS = (
    (re.compile(r"'[^']*'|\"[^\"]*\""), "<str>"),
    (
        re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I),
        "<uuid>",
    ),
    (re.compile(r"\b0x[0-9a-f]+\b", re.I), "<hex>"),
    (re.compile(r"\b\d+(?:\.\d+)?\b"), "<num>"),
    (re.compile(r"\s+"), " "),
)


def normalize_message(message: str) -> str:
    """Remove identificadores e números para agrupar mensagens equivalentes."""
    normalized = message.strip().lower()
    for pattern, placeholder in _NOISE_PATTERNS:
        normalized = pattern.sub(placeholder, normalized)
    return normalized.strip()


def fingerprint_for(error_code: str, module: str, message: str) -> str:
    """Assinatura estável de um erro: código, módulo e mensagem normalizada."""
    signature = f"{error_code}|{module}|{normalize_message(message)}"
    return hashlib.sha1(signature.encode("utf-8")).hexdigest()[:FINGERPRINT_LENGTH]
