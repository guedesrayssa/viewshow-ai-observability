"""Produz logs JSON de uma linha com remoção recursiva de valores sensíveis.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, date, datetime
from decimal import Decimal
from enum import Enum
from pathlib import Path
from types import MappingProxyType
from typing import TextIO

from domain.persisted_error import PersistedError
from domain.telemetry_identity import SERVICE_NAME
from ports import Logger

REDACTED = "[REDACTED]"
UNSERIALIZABLE = "[UNSERIALIZABLE]"
_SECRET_FRAGMENTS = (
    "password",
    "passwd",
    "pwd",
    "token",
    "secret",
    "authorization",
    "cookie",
    "dsn",
    "connectionstring",
    "payload",
    "raw",
    "body",
    "privatekey",
    "apikey",
    "accesskey",
)
_LEVEL_PRIORITY = {"debug": 10, "info": 20, "warn": 30, "error": 40, "fatal": 50}


def _normalized_key(key: object) -> str:
    """Monta a chave de normalized a partir de componentes validados.

    Args:
        key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return "".join(character for character in str(key).lower() if character.isalnum())


def _is_secret_key(key: object) -> bool:
    """Informa se secret chave satisfaz a condição esperada.

    Args:
        key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.
    """
    normalized = _normalized_key(key)
    return any(fragment in normalized for fragment in _SECRET_FRAGMENTS)


def _safe_scalar(value: object) -> object:
    """Produz scalar em formato seguro para logs ou persistência.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``object`` produzido pela operação após as validações.
    """
    if value is None or isinstance(value, bool | int):
        return value
    if isinstance(value, float):
        return value if value == value and abs(value) != float("inf") else UNSERIALIZABLE
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        rendered = value.astimezone(UTC) if value.tzinfo is not None else value
        return rendered.isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Enum):
        return _safe_value(value.value)
    if isinstance(value, Path):
        return value.name
    if isinstance(value, BaseException):
        message = str(value) or type(value).__name__
        return PersistedError.from_untrusted(message).message
    if isinstance(value, str):
        try:
            return PersistedError.from_untrusted(value).message
        except (TypeError, ValueError):
            return UNSERIALIZABLE
    return UNSERIALIZABLE


def _safe_value(value: object) -> object:
    """Produz valor em formato seguro para logs ou persistência.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``object`` produzido pela operação após as validações.
    """
    if isinstance(value, Mapping):
        result: dict[str, object] = {}
        for key, nested in value.items():
            safe_key = str(key) if isinstance(key, str) else UNSERIALIZABLE
            result[safe_key] = REDACTED if _is_secret_key(key) else _safe_value(nested)
        return result
    if isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray):
        return [_safe_value(item) for item in value]
    return _safe_scalar(value)


class JsonLogger(Logger):
    """Agrupa o estado e as operações de ``JsonLogger`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        *,
        environment: str,
        service_name: str = SERVICE_NAME,
        level: str = "info",
        stream: TextIO | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        context: Mapping[str, object] | None = None,
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            environment: Mapeamento de variáveis de ambiente disponível para validação.
            service_name: Nome validado do recurso, campo ou operação correspondente.
            level: Entrada ``level``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            stream: Fluxo binário ou textual consumido incrementalmente.
            clock: Função injetável que fornece o instante atual para validação e testes.
            context: Contexto validado compartilhado durante o processamento.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        if not isinstance(environment, str) or not environment:
            raise ValueError("environment must be non-empty text")
        if not isinstance(service_name, str) or not service_name:
            raise ValueError("service_name must be non-empty text")
        if level not in _LEVEL_PRIORITY:
            raise ValueError("level must be debug, info, warn, error, or fatal")
        if not callable(clock):
            raise TypeError("clock must be callable")
        safe_environment = _safe_value(environment)
        safe_service_name = _safe_value(service_name)
        self._environment = (
            safe_environment if isinstance(safe_environment, str) else UNSERIALIZABLE
        )
        self._service_name = (
            safe_service_name if isinstance(safe_service_name, str) else UNSERIALIZABLE
        )
        self._level = level
        self._stream = sys.stdout if stream is None else stream
        self._clock = clock
        self._context = MappingProxyType(dict(context or {}))

    def bind(self, **context: object) -> JsonLogger:
        """Cria uma visão com a entrada associado ao contexto atual.

        Args:
            context: Contexto validado compartilhado durante o processamento.

        Returns:
            Valor ``JsonLogger`` produzido pela operação após as validações.
        """
        merged = dict(self._context)
        merged.update(context)
        return JsonLogger(
            environment=self._environment,
            service_name=self._service_name,
            level=self._level,
            stream=self._stream,
            clock=self._clock,
            context=merged,
        )

    def debug(self, event: str, **fields: object) -> None:
        """Emite um evento de diagnóstico com contexto estruturado.

        Args:
            event: Evento de análise validado que será codificado ou publicado.
            fields: Entrada ``fields``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._emit("debug", event, fields)

    def info(self, event: str, **fields: object) -> None:
        """Emite um evento informativo com contexto estruturado.

        Args:
            event: Evento de análise validado que será codificado ou publicado.
            fields: Entrada ``fields``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._emit("info", event, fields)

    def warning(self, event: str, **fields: object) -> None:
        """Emite um alerta recuperável com contexto estruturado.

        Args:
            event: Evento de análise validado que será codificado ou publicado.
            fields: Entrada ``fields``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._emit("warn", event, fields)

    def error(self, event: str, **fields: object) -> None:
        """Registra ou transforma uma falha sem expor dados sensíveis.

        Args:
            event: Evento de análise validado que será codificado ou publicado.
            fields: Entrada ``fields``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._emit("error", event, fields)

    def fatal(self, event: str, **fields: object) -> None:
        """Emite uma falha terminal com contexto estruturado.

        Args:
            event: Evento de análise validado que será codificado ou publicado.
            fields: Entrada ``fields``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._emit("fatal", event, fields)

    def _emit(self, level: str, event: str, fields: Mapping[str, object]) -> None:
        """Emite a entrada pelo canal de telemetria configurado.

        Args:
            level: Entrada ``level``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            event: Evento de análise validado que será codificado ou publicado.
            fields: Entrada ``fields``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if _LEVEL_PRIORITY[level] < _LEVEL_PRIORITY[self._level]:
            return
        if not isinstance(event, str) or not event:
            raise ValueError("event must be non-empty text")
        now = self._clock()
        if not isinstance(now, datetime) or now.tzinfo is None:
            raise ValueError("clock must return an aware datetime")
        combined = dict(self._context)
        combined.update(fields)
        message = combined.pop("message", event)
        record: dict[str, object] = {
            "timestamp": now.astimezone(UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "level": level,
            "service_name": self._service_name,
            "environment": self._environment,
            "event": _safe_value(event),
            "message": _safe_value(message),
        }
        for key, value in combined.items():
            record[key] = REDACTED if _is_secret_key(key) else _safe_value(value)
        rendered = json.dumps(record, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        try:
            self._stream.write(rendered + "\n")
            self._stream.flush()
        except Exception:
            # A telemetria é best-effort e nunca deve substituir o resultado da operação.
            return


__all__ = ["JsonLogger", "REDACTED", "UNSERIALIZABLE"]
