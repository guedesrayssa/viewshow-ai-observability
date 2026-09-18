"""Limita e higieniza mensagens de erro antes de persistência durável.

Papel no fluxo:
    Este arquivo pertence ao núcleo de domínio e deve permanecer determinístico, sem acesso a
    rede, sistema de arquivos, banco de dados ou variáveis de ambiente.

Garantias e limites:
    As validações falham de forma fechada: valores ambíguos ou incompletos são rejeitados antes
    de atravessar uma porta de persistência.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

MAX_PERSISTED_ERROR_BYTES = 4096
_TRUNCATION_SUFFIX = " [truncated]"
_SANITIZATION_INPUT_BYTES = MAX_PERSISTED_ERROR_BYTES * 4
_PEM_PRIVATE_KEY_BLOCK = re.compile(
    r"-----BEGIN (?P<label>(?:[A-Z0-9][A-Z0-9 -]{0,48} )?PRIVATE KEY)-----"
    r".*?"
    r"-----END (?P=label)-----",
    re.IGNORECASE | re.DOTALL,
)
_PEM_PRIVATE_KEY_REMAINDER = re.compile(
    r"-----BEGIN (?:[A-Z0-9][A-Z0-9 -]{0,48} )?PRIVATE KEY-----.*$",
    re.IGNORECASE | re.DOTALL,
)
_CREDENTIAL_URI = re.compile(
    r"\b(?P<scheme>[a-z][a-z0-9+.-]*://)[^\s/@:]+:[^\s/@]+@",
    re.IGNORECASE,
)
_SECRET_ASSIGNMENT = re.compile(
    r"(?P<quote>[\"']?)\b"
    r"(?P<name>aws_secret_access_key|aws_access_key_id|client_secret|private_key|"
    r"(?:[a-z][a-z0-9]*[_-])*(?:password|passwd|pwd|token|secret)|"
    r"api[_-]?key|authorization)\b"
    r"(?P=quote)"
    r"(?P<separator>\s*[:=]\s*)"
    r"(?:\"[^\"]*\"|'[^']*'|[^\s,;}\]]+)",
    re.IGNORECASE,
)
_BEARER = re.compile(r"\bBearer\s+[^\s,;}\]]+", re.IGNORECASE)
_PAYLOAD = re.compile(
    r"\b(?P<name>payload|body|source[_ -]?row)(?P<separator>\s*[:=]\s*).*$",
    re.IGNORECASE | re.DOTALL,
)


def _truncate_utf8(value: str, limit: int) -> str:
    """Limita utf8 sem produzir uma sequência UTF-8 inválida.

    Args:
        value: Valor não confiável que será validado ou convertido.
        limit: Quantidade máxima de itens que a operação pode processar.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    encoded = value.encode("utf-8")
    if len(encoded) <= limit:
        return value
    suffix = _TRUNCATION_SUFFIX.encode("utf-8")
    prefix = encoded[: limit - len(suffix)].decode("utf-8", errors="ignore")
    return prefix + _TRUNCATION_SUFFIX


def sanitize_error_message(message: str) -> str:
    """Higieniza erro mensagem antes de exposição ou persistência.

    Args:
        message: Entrada ``message``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(message, str):
        raise TypeError("message must be a string")
    if not message:
        raise ValueError("message must not be empty")
    # Material PEM precisa ser removido antes de limitar o buffer; caso contrário, uma chave
    # longa pode ser cortada antes do marcador END e deixar seu prefixo secreto persistido.
    without_private_keys = _PEM_PRIVATE_KEY_BLOCK.sub("[REDACTED_PRIVATE_KEY]", message)
    without_private_keys = _PEM_PRIVATE_KEY_REMAINDER.sub(
        "[REDACTED_PRIVATE_KEY]", without_private_keys
    )
    bounded_input = _truncate_utf8(without_private_keys, _SANITIZATION_INPUT_BYTES)
    sanitized = _CREDENTIAL_URI.sub(r"\g<scheme>[REDACTED]@", bounded_input)
    sanitized = _BEARER.sub("Bearer [REDACTED]", sanitized)
    sanitized = _SECRET_ASSIGNMENT.sub(
        lambda match: f"{match.group('name')}{match.group('separator')}[REDACTED]",
        sanitized,
    )
    sanitized = _PAYLOAD.sub(
        lambda match: f"{match.group('name')}{match.group('separator')}[REDACTED_PAYLOAD]",
        sanitized,
    )
    return _truncate_utf8(sanitized, MAX_PERSISTED_ERROR_BYTES)


@dataclass(frozen=True, slots=True)
class PersistedError:
    """Indica que ``PersistedError`` impediu a operação de continuar com segurança.

    Attributes:
        message: Entrada ``message``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
    """

    message: str

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(self.message, str) or not self.message:
            raise ValueError("persisted error message must be a non-empty string")
        if len(self.message.encode("utf-8")) > MAX_PERSISTED_ERROR_BYTES:
            raise ValueError("persisted error message exceeds the byte limit")

    @classmethod
    def from_untrusted(cls, message: str) -> PersistedError:
        """Cria a instância a partir de untrusted previamente validado.

        Args:
            message: Entrada ``message``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``PersistedError`` produzido pela operação após as validações.
        """
        return cls(sanitize_error_message(message))


__all__ = ["MAX_PERSISTED_ERROR_BYTES", "PersistedError", "sanitize_error_message"]
