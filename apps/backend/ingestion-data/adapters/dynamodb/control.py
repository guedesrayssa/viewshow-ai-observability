"""Persiste runs, leases e checkpoints com escritas condicionais no DynamoDB.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import cast

from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from adapters.dynamodb.client import (
    DynamoControlClient,
    DynamoControlProtocolError,
    decode_get_item,
    raise_if_dynamodb_throttled,
    validate_transaction_response,
)
from adapters.dynamodb.codec import serialize_item
from domain.canonical_json import canonical_bytes
from domain.persisted_error import PersistedError
from domain.run import RunPipeline, RunProgress, RunStage, RunState, RunTransitionMetadata
from ports import (
    CheckpointRepository,
    ConditionalWriteError,
    Cursor,
    IdempotencyConflict,
    Lease,
    LeaseBusy,
    LeaseOwnershipError,
    LeaseRepository,
    RunRepository,
    StaleCheckpoint,
)

_CONTROL_TTL_SECONDS = 90 * 24 * 60 * 60
_INTEGER_TEXT = re.compile(r"^-?(?:0|[1-9][0-9]*)$")
_MISSING = object()


@dataclass(frozen=True, slots=True)
class _Replay:
    """Representa os dados de ``_Replay`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        found: Entrada ``found``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
    """

    found: bool
    result: object = None


@dataclass(frozen=True, slots=True)
class _PersistedRun:
    """Representa os dados de ``_PersistedRun`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        state: Estado imutável que será validado ou persistido.
        transition_count: Quantidade inteira não negativa usada na reconciliação.
        error_count: Quantidade inteira não negativa usada na reconciliação.
        total_duration_ms: Entrada ``total_duration_ms``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        records_read: Entrada ``records_read``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.
        records_written: Entrada ``records_written``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        records_rejected: Entrada ``records_rejected``; a forma aceita é definida pela anotação
        de tipo e validada antes do uso.
    """

    state: RunState
    transition_count: int
    error_count: int
    total_duration_ms: int
    records_read: int
    records_written: int
    records_rejected: int


def _require_component(value: object, field: str) -> str:
    """Valida e devolve component, rejeitando entradas fora do contrato.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    if not value:
        raise ValueError(f"{field} must not be empty")
    if "#" in value:
        raise ValueError(f"{field} must not contain the key delimiter")
    return value


def _require_idempotency_key(value: object) -> str:
    """Valida e devolve idempotência chave, rejeitando entradas fora do contrato.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, str):
        raise TypeError("idempotency_key must be a string")
    if not value:
        raise ValueError("idempotency_key must not be empty")
    return value


def _require_utc(value: object, field: str) -> datetime:
    """Valida e devolve utc, rejeitando entradas fora do contrato.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``datetime`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if type(value) is not datetime:
        raise TypeError(f"{field} must be a datetime")
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError(f"{field} must be an aware UTC datetime")
    return value.astimezone(UTC)


def _datetime_text(value: datetime) -> str:
    """Converte datetime para sua representação textual canônica.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return _require_utc(value, "datetime").isoformat(timespec="microseconds").replace("+00:00", "Z")


def _parse_datetime(value: object, field: str) -> datetime:
    """Converte datetime para a representação interna validada.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``datetime`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(value, str):
        raise DynamoControlProtocolError(f"DynamoDB {field} must be a string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return _require_utc(parsed, field)
    except (TypeError, ValueError) as error:
        raise DynamoControlProtocolError(f"DynamoDB {field} must be a UTC timestamp") from error


def _epoch_microseconds(value: datetime) -> int:
    """Executa a etapa interna ``epoch_microseconds`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``int`` produzido pela operação após as validações.
    """
    delta = _require_utc(value, "datetime") - datetime(1970, 1, 1, tzinfo=UTC)
    return delta.days * 86_400_000_000 + delta.seconds * 1_000_000 + delta.microseconds


def _require_ttl(ttl_seconds: object) -> int:
    """Valida e devolve ttl, rejeitando entradas fora do contrato.

    Args:
        ttl_seconds: Duração do lease ou da retenção, expressa em segundos.

    Returns:
        Valor ``int`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int):
        raise TypeError("ttl_seconds must be an integer")
    if ttl_seconds <= 0:
        raise ValueError("ttl_seconds must be positive")
    return ttl_seconds


def _decimal_text(value: Decimal) -> str:
    """Converte decimal para sua representação textual canônica.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    payload = json.loads(canonical_bytes(value))
    return cast(str, payload["$decimal"])


def _cursor_atom(value: object) -> dict[str, str]:
    """Executa a etapa interna ``cursor_atom`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``dict[str, str]`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if isinstance(value, bool) or value is None:
        raise TypeError("cursor values must be supported non-null scalar types")
    if type(value) is int:
        return {"type": "integer", "value": str(value)}
    if type(value) is float:
        if not math.isfinite(value):
            raise ValueError("cursor float values must be finite")
        return {"type": "float", "value": value.hex()}
    if type(value) is Decimal:
        if not value.is_finite():
            raise ValueError("cursor Decimal values must be finite")
        return {"type": "decimal", "value": _decimal_text(value)}
    if type(value) is str:
        return {"type": "string", "value": value}
    if type(value) is datetime:
        return {"type": "datetime", "value": _datetime_text(value)}
    raise TypeError(f"unsupported cursor value type: {type(value).__name__}")


def _serialize_cursor(cursor: object) -> str:
    """Serializa cursor de maneira determinística.

    Args:
        cursor: Cursor de paginação ou retomada associado à fonte.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(cursor, tuple):
        raise TypeError("cursor must be a tuple")
    if not cursor:
        raise ValueError("cursor must not be empty")
    return canonical_bytes([_cursor_atom(value) for value in cursor]).decode("utf-8")


def _decode_cursor_atom(value: object) -> object:
    """Decodifica cursor atom e valida sua forma antes de devolvê-lo.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``object`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, dict) or set(value) != {"type", "value"}:
        raise DynamoControlProtocolError("DynamoDB cursor contains an invalid element")
    tag = value.get("type")
    raw = value.get("value")
    if not isinstance(tag, str) or not isinstance(raw, str):
        raise DynamoControlProtocolError("DynamoDB cursor contains an invalid scalar")
    try:
        if tag == "integer":
            if _INTEGER_TEXT.fullmatch(raw) is None or str(int(raw)) != raw:
                raise ValueError
            return int(raw)
        if tag == "float":
            parsed_float = float.fromhex(raw)
            if not math.isfinite(parsed_float) or parsed_float.hex() != raw:
                raise ValueError
            return parsed_float
        if tag == "decimal":
            parsed_decimal = Decimal(raw)
            if not parsed_decimal.is_finite() or _decimal_text(parsed_decimal) != raw:
                raise ValueError
            return parsed_decimal
        if tag == "string":
            return raw
        if tag == "datetime":
            parsed_datetime = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            parsed_datetime = _require_utc(parsed_datetime, "cursor datetime")
            if _datetime_text(parsed_datetime) != raw:
                raise ValueError
            return parsed_datetime
    except (InvalidOperation, TypeError, ValueError) as error:
        raise DynamoControlProtocolError("DynamoDB cursor contains an invalid scalar") from error
    raise DynamoControlProtocolError("DynamoDB cursor contains an unsupported scalar type")


def _deserialize_cursor(canonical: object) -> Cursor:
    """Desserializa cursor e rejeita representações inválidas.

    Args:
        canonical: Entrada ``canonical``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``Cursor`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(canonical, str):
        raise DynamoControlProtocolError("DynamoDB cursorCanonical must be a string")
    try:
        decoded = json.loads(canonical)
    except (TypeError, ValueError) as error:
        raise DynamoControlProtocolError("DynamoDB cursorCanonical is not valid JSON") from error
    if not isinstance(decoded, list) or not decoded:
        raise DynamoControlProtocolError("DynamoDB cursorCanonical must contain a non-empty list")
    cursor = tuple(_decode_cursor_atom(value) for value in decoded)
    if _serialize_cursor(cursor) != canonical:
        raise DynamoControlProtocolError("DynamoDB cursorCanonical is not canonical")
    return cursor


def _numeric(value: object) -> Decimal | None:
    """Executa a etapa interna ``numeric`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``Decimal | None`` produzido pela operação após as validações.
    """
    if type(value) is int:
        return Decimal(value)
    if type(value) is Decimal:
        return value
    if type(value) is float:
        return Decimal.from_float(value)
    return None


def _compare_cursors(left: Cursor, right: Cursor) -> int:
    """Compara cursors de forma determinística.

    Args:
        left: Entrada ``left``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        right: Entrada ``right``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``int`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    if len(left) != len(right):
        raise TypeError("cursor shape differs from the persisted cursor")
    for left_value, right_value in zip(left, right, strict=True):
        left_number = _numeric(left_value)
        right_number = _numeric(right_value)
        if left_number is not None or right_number is not None:
            if left_number is None or right_number is None:
                raise TypeError("cursor type differs from the persisted cursor")
            comparison = (left_number > right_number) - (left_number < right_number)
        else:
            if type(left_value) is not type(right_value):
                raise TypeError("cursor type differs from the persisted cursor")
            if isinstance(left_value, str) and isinstance(right_value, str):
                comparison = (left_value > right_value) - (left_value < right_value)
            elif isinstance(left_value, datetime) and isinstance(right_value, datetime):
                comparison = (left_value > right_value) - (left_value < right_value)
            else:
                raise TypeError("cursor contains an unsupported comparison type")
        if comparison:
            return comparison
    return 0


def _required_string(item: Mapping[str, object], field: str) -> str:
    """Obtém string e rejeita a ausência ou um formato inválido.

    Args:
        item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    value = item.get(field, _MISSING)
    if not isinstance(value, str) or not value:
        raise DynamoControlProtocolError(f"DynamoDB item {field} must be a non-empty string")
    return value


def _required_non_negative_int(item: Mapping[str, object], field: str) -> int:
    """Obtém non negative inteiro e rejeita a ausência ou um formato inválido.

    Args:
        item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``int`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    value = item.get(field, _MISSING)
    if not isinstance(value, Decimal) or value != value.to_integral_value() or value < 0:
        raise DynamoControlProtocolError(f"DynamoDB item {field} must be a non-negative integer")
    return int(value)


class DynamoControlRepository(CheckpointRepository, LeaseRepository, RunRepository):
    """Agrupa o estado e as operações de ``DynamoControlRepository`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        client: DynamoControlClient,
        table_name: str,
        *,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            client: Cliente externo que executa a operação de infraestrutura.
            table_name: Nome validado do recurso, campo ou operação correspondente.
            clock: Função injetável que fornece o instante atual para validação e testes.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(table_name, str):
            raise TypeError("table_name must be a string")
        if not table_name:
            raise ValueError("table_name must not be empty")
        if not callable(clock):
            raise TypeError("clock must be callable")
        self._client = client
        self._table_name = table_name
        self._clock = clock

    @staticmethod
    def serialize_cursor(cursor: Cursor) -> str:
        """Serializa cursor de maneira determinística.

        Args:
            cursor: Cursor de paginação ou retomada associado à fonte.

        Returns:
            Valor ``str`` produzido pela operação após as validações.
        """
        return _serialize_cursor(cursor)

    def _now(self) -> datetime:
        """Executa a etapa interna ``now`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``datetime`` produzido pela operação após as validações.
        """
        return _require_utc(self._clock(), "clock result")

    def _control_ttl(self, observed_at: datetime | None = None) -> int:
        """Executa a etapa interna ``control_ttl`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            observed_at: Valor efetivamente observado que será comparado com a evidência
            esperada.

        Returns:
            Valor ``int`` produzido pela operação após as validações.
        """
        current = self._now() if observed_at is None else _require_utc(observed_at, "observed_at")
        return int(current.timestamp()) + _CONTROL_TTL_SECONDS

    def _get_item(self, pk: str, sk: str) -> dict[str, object] | None:
        """Obtém item a partir da fonte configurada.

        Args:
            pk: Entrada ``pk``; a forma aceita é definida pela anotação de tipo e validada antes
            do uso.
            sk: Entrada ``sk``; a forma aceita é definida pela anotação de tipo e validada antes
            do uso.

        Returns:
            Valor ``dict[str, object] | None`` produzido pela operação após as validações.

        Raises:
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        try:
            response = self._client.get_item(
                TableName=self._table_name,
                Key={"pk": {"S": pk}, "sk": {"S": sk}},
                ConsistentRead=True,
            )
        except ClientError as error:
            raise_if_dynamodb_throttled(error)
            raise
        item = decode_get_item(response)
        if item is None:
            return None
        if item.get("pk") != pk or item.get("sk") != sk:
            raise DynamoControlProtocolError("DynamoDB GetItem returned an unexpected key")
        return item

    @staticmethod
    def _fingerprint(payload: object) -> str:
        """Executa a etapa interna ``fingerprint`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            payload: Entrada ``payload``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``str`` produzido pela operação após as validações.
        """
        return hashlib.sha256(canonical_bytes(payload)).hexdigest()

    @staticmethod
    def _idempotency_pk(scope: str, idempotency_key: str) -> str:
        """Executa a etapa interna ``idempotency_pk`` e devolve o resultado validado indicado
        pela assinatura.

        Args:
            scope: Entrada ``scope``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``str`` produzido pela operação após as validações.
        """
        digest = hashlib.sha256(f"{scope}\0{idempotency_key}".encode()).hexdigest()
        return f"INGESTION#IDEMPOTENCY#{scope}#{digest}"

    def _marker(
        self,
        scope: str,
        idempotency_key: str,
        fingerprint: str,
        result: Mapping[str, object],
    ) -> dict[str, object]:
        """Executa a etapa interna ``marker`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            scope: Entrada ``scope``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.
            fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``dict[str, object]`` produzido pela operação após as validações.
        """
        return {
            "pk": self._idempotency_pk(scope, idempotency_key),
            "sk": "META",
            "operation": scope,
            "fingerprint": fingerprint,
            "result": dict(result),
            "ttl": self._control_ttl(),
        }

    def _replay(
        self,
        scope: str,
        idempotency_key: str,
        fingerprint: str,
        decoder: Callable[[Mapping[str, object]], object],
    ) -> _Replay:
        """Executa a etapa interna ``replay`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            scope: Entrada ``scope``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.
            fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            decoder: Entrada ``decoder``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``_Replay`` produzido pela operação após as validações.

        Raises:
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
            IdempotencyConflict: Se a operação não puder preservar as invariantes descritas.
        """
        marker = self._get_item(self._idempotency_pk(scope, idempotency_key), "META")
        if marker is None:
            return _Replay(False)
        if _required_string(marker, "operation") != scope:
            raise DynamoControlProtocolError("DynamoDB idempotency operation is invalid")
        if _required_string(marker, "fingerprint") != fingerprint:
            raise IdempotencyConflict("idempotency key was reused with different input")
        result = marker.get("result")
        if not isinstance(result, Mapping):
            raise DynamoControlProtocolError("DynamoDB idempotency result must be a mapping")
        return _Replay(True, decoder(cast(Mapping[str, object], result)))

    def _marker_put(self, marker: Mapping[str, object]) -> dict[str, object]:
        """Executa a etapa interna ``marker_put`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            marker: Entrada ``marker``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``dict[str, object]`` produzido pela operação após as validações.
        """
        return {
            "Put": {
                "TableName": self._table_name,
                "Item": serialize_item(marker),
                "ConditionExpression": "attribute_not_exists(pk)",
            }
        }

    def _transact(
        self,
        items: list[dict[str, object]],
        *,
        scope: str,
        idempotency_key: str,
        fingerprint: str,
        decoder: Callable[[Mapping[str, object]], object],
        conditional_error: Exception,
        conditional_positions: frozenset[int],
    ) -> _Replay:
        """Executa a etapa interna ``transact`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            items: Entrada ``items``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            scope: Entrada ``scope``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.
            fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            decoder: Entrada ``decoder``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            conditional_error: Entrada ``conditional_error``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.
            conditional_positions: Entrada ``conditional_positions``; a forma aceita é definida
            pela anotação de tipo e validada antes do uso.

        Returns:
            Valor ``_Replay`` produzido pela operação após as validações.
        """
        try:
            response = self._client.transact_write_items(TransactItems=items)
            validate_transaction_response(response)
            return _Replay(False)
        except ClientError as error:
            raise_if_dynamodb_throttled(error)
            code = error.response.get("Error", {}).get("Code")
            if code not in {"ConditionalCheckFailedException", "TransactionCanceledException"}:
                raise
            replay = self._replay(scope, idempotency_key, fingerprint, decoder)
            if replay.found:
                return replay
            if code == "TransactionCanceledException" and not self._is_domain_cancellation(
                error.response.get("CancellationReasons"),
                len(items),
                conditional_positions,
            ):
                raise
            raise conditional_error from None

    @staticmethod
    def _is_domain_cancellation(
        raw_reasons: object,
        item_count: int,
        conditional_positions: frozenset[int],
    ) -> bool:
        """Informa se domain cancellation satisfaz a condição esperada.

        Args:
            raw_reasons: Entrada ``raw_reasons``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            item_count: Quantidade inteira não negativa usada na reconciliação.
            conditional_positions: Entrada ``conditional_positions``; a forma aceita é definida
            pela anotação de tipo e validada antes do uso.

        Returns:
            Valor ``bool`` produzido pela operação após as validações.
        """
        if not isinstance(raw_reasons, list) or len(raw_reasons) != item_count:
            return False
        conditional_failures: set[int] = set()
        for index, raw_reason in enumerate(raw_reasons):
            if not isinstance(raw_reason, Mapping):
                return False
            code = raw_reason.get("Code")
            if code == "None":
                continue
            if code != "ConditionalCheckFailed":
                return False
            conditional_failures.add(index)
        return bool(conditional_failures) and conditional_failures <= conditional_positions

    @staticmethod
    def _decode_none(result: Mapping[str, object]) -> None:
        """Decodifica none e valida sua forma antes de devolvê-lo.

        Args:
            result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        if result != {"kind": "none"}:
            raise DynamoControlProtocolError("DynamoDB idempotency void result is invalid")

    @staticmethod
    def _run_result(state: RunState) -> dict[str, object]:
        """Consolida o resultado de execução a partir das evidências acumuladas.

        Args:
            state: Estado imutável que será validado ou persistido.

        Returns:
            Valor ``dict[str, object]`` produzido pela operação após as validações.
        """
        result: dict[str, object] = {
            "kind": "run",
            "runId": state.run_id,
            "datasetVersion": state.dataset_version,
            "stage": state.stage.value,
            "pipeline": state.pipeline.value,
        }
        if state.active_dataset_version is not None:
            result["activeDatasetVersion"] = state.active_dataset_version
        return result

    @staticmethod
    def _decode_run_result(result: Mapping[str, object]) -> RunState:
        """Decodifica execução resultado e valida sua forma antes de devolvê-lo.

        Args:
            result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``RunState`` produzido pela operação após as validações.

        Raises:
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        if result.get("kind") != "run":
            raise DynamoControlProtocolError("DynamoDB idempotency run result is invalid")
        try:
            active = result.get("activeDatasetVersion")
            if active is not None and not isinstance(active, str):
                raise TypeError
            return RunState(
                _required_string(result, "runId"),
                _required_string(result, "datasetVersion"),
                RunStage(_required_string(result, "stage")),
                active,
                RunPipeline(str(result.get("pipeline", RunPipeline.LEGACY_V1.value))),
            )
        except (TypeError, ValueError) as error:
            raise DynamoControlProtocolError(
                "DynamoDB idempotency run result is invalid"
            ) from error

    @staticmethod
    def _lease_result(lease: Lease) -> dict[str, object]:
        """Consolida o resultado de lease a partir das evidências acumuladas.

        Args:
            lease: Entrada ``lease``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Valor ``dict[str, object]`` produzido pela operação após as validações.
        """
        return {
            "kind": "lease",
            "source": lease.source,
            "owner": lease.owner,
            "expiresAt": _datetime_text(lease.expires_at),
        }

    @staticmethod
    def _decode_lease_result(result: Mapping[str, object]) -> Lease:
        """Decodifica lease resultado e valida sua forma antes de devolvê-lo.

        Args:
            result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Lease`` produzido pela operação após as validações.

        Raises:
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        if result.get("kind") != "lease":
            raise DynamoControlProtocolError("DynamoDB idempotency lease result is invalid")
        return Lease(
            _required_string(result, "source"),
            _required_string(result, "owner"),
            _parse_datetime(result.get("expiresAt"), "idempotency result expiresAt"),
        )

    @staticmethod
    def _cursor_result(canonical: str) -> dict[str, object]:
        """Consolida o resultado de cursor a partir das evidências acumuladas.

        Args:
            canonical: Entrada ``canonical``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``dict[str, object]`` produzido pela operação após as validações.
        """
        return {"kind": "cursor", "cursorCanonical": canonical}

    @staticmethod
    def _decode_cursor_result(result: Mapping[str, object]) -> Cursor:
        """Decodifica cursor resultado e valida sua forma antes de devolvê-lo.

        Args:
            result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Cursor`` produzido pela operação após as validações.

        Raises:
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        if result.get("kind") != "cursor":
            raise DynamoControlProtocolError("DynamoDB idempotency cursor result is invalid")
        return _deserialize_cursor(result.get("cursorCanonical"))

    def get(self, dataset_version: str, dataset: str) -> Cursor | None:
        """Obtém o valor atualmente persistido para a identidade informada.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            dataset: Nome do dataset permitido pelo registro de contratos.

        Returns:
            Valor ``Cursor | None`` produzido pela operação após as validações.
        """
        dataset_version = _require_component(dataset_version, "dataset_version")
        dataset = _require_component(dataset, "dataset")
        item = self._get_item(f"DATASET#{dataset_version}#INGESTION#SOURCE#{dataset}", "CHECKPOINT")
        if item is None:
            return None
        return _deserialize_cursor(item.get("cursorCanonical"))

    def advance(
        self,
        dataset_version: str,
        dataset: str,
        cursor: Cursor,
        *,
        expected_cursor: Cursor | None,
        idempotency_key: str,
    ) -> Cursor:
        """Avança a entrada somente a partir do estado previamente observado.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            dataset: Nome do dataset permitido pelo registro de contratos.
            cursor: Cursor de paginação ou retomada associado à fonte.
            expected_cursor: Valor esperado usado para detectar concorrência ou divergência de
            estado.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``Cursor`` produzido pela operação após as validações.

        Raises:
            StaleCheckpoint: Se a operação não puder preservar as invariantes descritas.
        """
        dataset_version = _require_component(dataset_version, "dataset_version")
        dataset = _require_component(dataset, "dataset")
        idempotency_key = _require_idempotency_key(idempotency_key)
        canonical = _serialize_cursor(cursor)
        expected_canonical = (
            _serialize_cursor(expected_cursor) if expected_cursor is not None else None
        )
        fingerprint = self._fingerprint(
            {
                "datasetVersion": dataset_version,
                "dataset": dataset,
                "cursor": canonical,
                "expectedCursor": expected_canonical,
            }
        )
        replay = self._replay(
            "checkpoint-advance",
            idempotency_key,
            fingerprint,
            self._decode_cursor_result,
        )
        if replay.found:
            return cast(Cursor, replay.result)

        pk = f"DATASET#{dataset_version}#INGESTION#SOURCE#{dataset}"
        current_item = self._get_item(pk, "CHECKPOINT")
        current_canonical = None if current_item is None else current_item.get("cursorCanonical")
        if current_canonical != expected_canonical:
            raise StaleCheckpoint("checkpoint changed from expected_cursor")
        if current_canonical is not None:
            current = _deserialize_cursor(current_canonical)
            if _compare_cursors(cursor, current) <= 0:
                raise StaleCheckpoint("checkpoint cursor is not monotonic")

        result = tuple(cursor)
        marker = self._marker(
            "checkpoint-advance",
            idempotency_key,
            fingerprint,
            self._cursor_result(canonical),
        )
        put: dict[str, object] = {
            "TableName": self._table_name,
            "Item": serialize_item({"pk": pk, "sk": "CHECKPOINT", "cursorCanonical": canonical}),
        }
        if expected_canonical is None:
            put["ConditionExpression"] = "attribute_not_exists(pk)"
        else:
            put["ConditionExpression"] = "cursorCanonical = :expected"
            put["ExpressionAttributeValues"] = {":expected": {"S": expected_canonical}}
        transaction = self._transact(
            [{"Put": put}, self._marker_put(marker)],
            scope="checkpoint-advance",
            idempotency_key=idempotency_key,
            fingerprint=fingerprint,
            decoder=self._decode_cursor_result,
            conditional_error=StaleCheckpoint("checkpoint changed concurrently"),
            conditional_positions=frozenset({0}),
        )
        return cast(Cursor, transaction.result) if transaction.found else result

    def acquire(
        self,
        source: str,
        owner: str,
        now: datetime,
        ttl_seconds: int,
        *,
        idempotency_key: str,
    ) -> Lease:
        """Tenta adquirir a posse exclusiva do recurso para o proprietário informado.

        Args:
            source: Identificador da fonte de dados processada.
            owner: Identidade do worker que possui ou solicita o lease.
            now: Instante UTC usado como referência para a operação.
            ttl_seconds: Duração do lease ou da retenção, expressa em segundos.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``Lease`` produzido pela operação após as validações.
        """
        source = _require_component(source, "source")
        owner = _require_component(owner, "owner")
        now = _require_utc(now, "now")
        ttl_seconds = _require_ttl(ttl_seconds)
        idempotency_key = _require_idempotency_key(idempotency_key)
        expires_at = now + timedelta(seconds=ttl_seconds)
        lease = Lease(source, owner, expires_at)
        fingerprint = self._fingerprint(
            {
                "source": source,
                "owner": owner,
                "now": _datetime_text(now),
                "ttlSeconds": ttl_seconds,
            }
        )
        replay = self._replay(
            "lease-acquire", idempotency_key, fingerprint, self._decode_lease_result
        )
        if replay.found:
            return cast(Lease, replay.result)
        marker = self._marker(
            "lease-acquire", idempotency_key, fingerprint, self._lease_result(lease)
        )
        lease_item = {
            "pk": f"INGESTION#SOURCE#{source}",
            "sk": "LEASE",
            "source": source,
            "owner": owner,
            "expiresAt": _datetime_text(expires_at),
            "expiresAtEpochUs": _epoch_microseconds(expires_at),
            "ttl": int(expires_at.timestamp()),
        }
        transaction = self._transact(
            [
                {
                    "Put": {
                        "TableName": self._table_name,
                        "Item": serialize_item(lease_item),
                        "ConditionExpression": (
                            "attribute_not_exists(pk) OR expiresAtEpochUs <= :now"
                        ),
                        "ExpressionAttributeValues": {":now": {"N": str(_epoch_microseconds(now))}},
                    }
                },
                self._marker_put(marker),
            ],
            scope="lease-acquire",
            idempotency_key=idempotency_key,
            fingerprint=fingerprint,
            decoder=self._decode_lease_result,
            conditional_error=LeaseBusy("source already has a live lease"),
            conditional_positions=frozenset({0}),
        )
        return cast(Lease, transaction.result) if transaction.found else lease

    def renew(
        self,
        source: str,
        owner: str,
        now: datetime,
        ttl_seconds: int,
        *,
        expected_expires_at: datetime,
        idempotency_key: str,
    ) -> Lease:
        """Renova a posse sem reduzir o prazo de expiração já observado.

        Args:
            source: Identificador da fonte de dados processada.
            owner: Identidade do worker que possui ou solicita o lease.
            now: Instante UTC usado como referência para a operação.
            ttl_seconds: Duração do lease ou da retenção, expressa em segundos.
            expected_expires_at: Valor esperado usado para detectar concorrência ou divergência
            de estado.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``Lease`` produzido pela operação após as validações.

        Raises:
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
        """
        source = _require_component(source, "source")
        owner = _require_component(owner, "owner")
        now = _require_utc(now, "now")
        ttl_seconds = _require_ttl(ttl_seconds)
        expected_expires_at = _require_utc(expected_expires_at, "expected_expires_at")
        idempotency_key = _require_idempotency_key(idempotency_key)
        expires_at = now + timedelta(seconds=ttl_seconds)
        if expires_at <= expected_expires_at:
            raise ConditionalWriteError("renewal must strictly extend lease expiration")
        lease = Lease(source, owner, expires_at)
        fingerprint = self._fingerprint(
            {
                "source": source,
                "owner": owner,
                "now": _datetime_text(now),
                "ttlSeconds": ttl_seconds,
                "expectedExpiresAt": _datetime_text(expected_expires_at),
            }
        )
        replay = self._replay(
            "lease-renew", idempotency_key, fingerprint, self._decode_lease_result
        )
        if replay.found:
            return cast(Lease, replay.result)
        marker = self._marker(
            "lease-renew", idempotency_key, fingerprint, self._lease_result(lease)
        )
        transaction = self._transact(
            [
                {
                    "Update": {
                        "TableName": self._table_name,
                        "Key": {
                            "pk": {"S": f"INGESTION#SOURCE#{source}"},
                            "sk": {"S": "LEASE"},
                        },
                        "UpdateExpression": (
                            "SET expiresAt = :expires, expiresAtEpochUs = :new, #ttl = :ttl"
                        ),
                        "ConditionExpression": (
                            "#owner = :owner AND expiresAtEpochUs = :expected "
                            "AND expiresAtEpochUs > :now"
                        ),
                        "ExpressionAttributeNames": {"#owner": "owner", "#ttl": "ttl"},
                        "ExpressionAttributeValues": {
                            ":owner": {"S": owner},
                            ":expected": {"N": str(_epoch_microseconds(expected_expires_at))},
                            ":now": {"N": str(_epoch_microseconds(now))},
                            ":new": {"N": str(_epoch_microseconds(expires_at))},
                            ":expires": {"S": _datetime_text(expires_at)},
                            ":ttl": {"N": str(int(expires_at.timestamp()))},
                        },
                    }
                },
                self._marker_put(marker),
            ],
            scope="lease-renew",
            idempotency_key=idempotency_key,
            fingerprint=fingerprint,
            decoder=self._decode_lease_result,
            conditional_error=LeaseOwnershipError("lease ownership or expiration changed"),
            conditional_positions=frozenset({0}),
        )
        return cast(Lease, transaction.result) if transaction.found else lease

    def release(self, source: str, owner: str, *, idempotency_key: str) -> None:
        """Libera a posse somente para o proprietário atual.

        Args:
            source: Identificador da fonte de dados processada.
            owner: Identidade do worker que possui ou solicita o lease.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        source = _require_component(source, "source")
        owner = _require_component(owner, "owner")
        idempotency_key = _require_idempotency_key(idempotency_key)
        fingerprint = self._fingerprint({"source": source, "owner": owner})
        replay = self._replay("lease-release", idempotency_key, fingerprint, self._decode_none)
        if replay.found:
            return
        marker = self._marker("lease-release", idempotency_key, fingerprint, {"kind": "none"})
        self._transact(
            [
                {
                    "Delete": {
                        "TableName": self._table_name,
                        "Key": {
                            "pk": {"S": f"INGESTION#SOURCE#{source}"},
                            "sk": {"S": "LEASE"},
                        },
                        "ConditionExpression": "#owner = :owner",
                        "ExpressionAttributeNames": {"#owner": "owner"},
                        "ExpressionAttributeValues": {":owner": {"S": owner}},
                    }
                },
                self._marker_put(marker),
            ],
            scope="lease-release",
            idempotency_key=idempotency_key,
            fingerprint=fingerprint,
            decoder=self._decode_none,
            conditional_error=LeaseOwnershipError("lease is absent or owned by another worker"),
            conditional_positions=frozenset({0}),
        )

    def _decode_run_item(self, item: Mapping[str, object], expected_run_id: str) -> _PersistedRun:
        """Decodifica execução item e valida sua forma antes de devolvê-lo.

        Args:
            item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            expected_run_id: Valor esperado usado para detectar concorrência ou divergência de
            estado.

        Returns:
            Valor ``_PersistedRun`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        try:
            active = item.get("activeDatasetVersion")
            if active is not None and not isinstance(active, str):
                raise TypeError
            state = RunState(
                _required_string(item, "runId"),
                _required_string(item, "datasetVersion"),
                RunStage(_required_string(item, "stage")),
                active,
                RunPipeline(str(item.get("pipeline", RunPipeline.LEGACY_V1.value))),
            )
            if state.run_id != expected_run_id:
                raise ValueError
            _parse_datetime(item.get("createdAt"), "run createdAt")
            _parse_datetime(item.get("updatedAt"), "run updatedAt")
            return _PersistedRun(
                state=state,
                transition_count=_required_non_negative_int(item, "transitionCount"),
                error_count=_required_non_negative_int(item, "errorCount"),
                total_duration_ms=_required_non_negative_int(item, "totalDurationMs"),
                records_read=_required_non_negative_int(item, "recordsRead"),
                records_written=_required_non_negative_int(item, "recordsWritten"),
                records_rejected=_required_non_negative_int(item, "recordsRejected"),
            )
        except (TypeError, ValueError) as error:
            raise DynamoControlProtocolError("DynamoDB run item is invalid") from error

    def get_run_progress(self, run_id: str) -> RunProgress | None:
        run_id = _require_component(run_id, "run_id")
        item = self._get_item(f"INGESTION#RUN#{run_id}", "META")
        if item is None:
            return None
        persisted = self._decode_run_item(item, run_id)
        return RunProgress(
            persisted.state,
            _parse_datetime(item.get("updatedAt"), "run updatedAt"),
            persisted.records_read,
            persisted.records_written,
            persisted.records_rejected,
        )

    def get_run(self, run_id: str) -> RunState | None:
        """Obtém execução a partir da fonte configurada.

        Args:
            run_id: Identificador não secreto e estável da execução.

        Returns:
            Valor ``RunState | None`` produzido pela operação após as validações.
        """
        run_id = _require_component(run_id, "run_id")
        item = self._get_item(f"INGESTION#RUN#{run_id}", "META")
        return None if item is None else self._decode_run_item(item, run_id).state

    def create(self, state: RunState, *, idempotency_key: str) -> RunState:
        """Cria o recurso somente quando suas pré-condições são satisfeitas.

        Args:
            state: Estado imutável que será validado ou persistido.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``RunState`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(state, RunState):
            raise TypeError("state must be a RunState")
        if state.stage is not RunStage.STARTING:
            raise ValueError("a new run must start at STARTING")
        _require_component(state.run_id, "run_id")
        _require_component(state.dataset_version, "dataset_version")
        idempotency_key = _require_idempotency_key(idempotency_key)
        result = self._run_result(state)
        fingerprint = self._fingerprint(result)
        replay = self._replay("run-create", idempotency_key, fingerprint, self._decode_run_result)
        if replay.found:
            return cast(RunState, replay.result)
        marker = self._marker("run-create", idempotency_key, fingerprint, result)
        created_at = self._now()
        item = {
            "pk": f"INGESTION#RUN#{state.run_id}",
            "sk": "META",
            "runId": state.run_id,
            "datasetVersion": state.dataset_version,
            "stage": state.stage.value,
            "pipeline": state.pipeline.value,
            "createdAt": _datetime_text(created_at),
            "updatedAt": _datetime_text(created_at),
            "transitionCount": 0,
            "errorCount": 0,
            "totalDurationMs": 0,
            "recordsRead": 0,
            "recordsWritten": 0,
            "recordsRejected": 0,
            "ttl": self._control_ttl(created_at),
        }
        if state.active_dataset_version is not None:
            item["activeDatasetVersion"] = state.active_dataset_version
        transaction = self._transact(
            [
                {
                    "Put": {
                        "TableName": self._table_name,
                        "Item": serialize_item(item),
                        "ConditionExpression": "attribute_not_exists(pk)",
                    }
                },
                self._marker_put(marker),
            ],
            scope="run-create",
            idempotency_key=idempotency_key,
            fingerprint=fingerprint,
            decoder=self._decode_run_result,
            conditional_error=ConditionalWriteError("run already exists"),
            conditional_positions=frozenset({0}),
        )
        return cast(RunState, transaction.result) if transaction.found else state

    def transition(
        self,
        run_id: str,
        target: RunStage,
        *,
        expected_stage: RunStage,
        metadata: RunTransitionMetadata | None = None,
        mark_candidate_active: bool = False,
        idempotency_key: str,
    ) -> RunState:
        """Aplica uma transição usando o estado previamente observado como proteção.

        Args:
            run_id: Identificador não secreto e estável da execução.
            target: Estado ou destino solicitado para a operação.
            expected_stage: Valor esperado usado para detectar concorrência ou divergência de
            estado.
            metadata: Metadados associados ao registro ou à transição.
            mark_candidate_active: Entrada ``mark_candidate_active``; a forma aceita é definida
            pela anotação de tipo e validada antes do uso.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``RunState`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
        """
        run_id = _require_component(run_id, "run_id")
        if not isinstance(target, RunStage):
            raise TypeError("target must be a RunStage")
        if not isinstance(expected_stage, RunStage):
            raise TypeError("expected_stage must be a RunStage")
        if metadata is not None and not isinstance(metadata, RunTransitionMetadata):
            raise TypeError("metadata must be a RunTransitionMetadata or None")
        if type(mark_candidate_active) is not bool:
            raise TypeError("mark_candidate_active must be a boolean")
        idempotency_key = _require_idempotency_key(idempotency_key)
        sanitized_error = (
            PersistedError.from_untrusted(metadata.error).message
            if metadata is not None and metadata.error is not None
            else None
        )
        metadata_fingerprint: dict[str, object] | None = None
        if metadata is not None:
            metadata_fingerprint = {
                "transitionedAt": _datetime_text(metadata.transitioned_at),
                "durationMs": metadata.duration_ms,
                "recordsRead": metadata.records_read,
                "recordsWritten": metadata.records_written,
                "recordsRejected": metadata.records_rejected,
                "error": sanitized_error,
            }
            if metadata.substage is not None:
                metadata_fingerprint["substage"] = metadata.substage
            if metadata.units_completed is not None:
                metadata_fingerprint.update(
                    unitsCompleted=metadata.units_completed,
                    unitsTotal=metadata.units_total,
                    unitLabel=metadata.unit_label,
                )
        fingerprint = self._fingerprint(
            {
                "runId": run_id,
                "target": target.value,
                "expectedStage": expected_stage.value,
                "metadata": metadata_fingerprint,
                "markCandidateActive": mark_candidate_active,
            }
        )
        replay = self._replay(
            "run-transition", idempotency_key, fingerprint, self._decode_run_result
        )
        if replay.found:
            return cast(RunState, replay.result)
        pk = f"INGESTION#RUN#{run_id}"
        item = self._get_item(pk, "META")
        if item is None:
            raise ConditionalWriteError("run does not exist")
        current = self._decode_run_item(item, run_id)
        if current.state.stage is not expected_stage:
            raise ConditionalWriteError("run stage differs from expected_stage")
        changed = current.state.transition(
            target,
            mark_candidate_active=mark_candidate_active,
        )
        persisted_at = self._now()
        audit = metadata or RunTransitionMetadata(persisted_at)
        retention_ttl = self._control_ttl(persisted_at)
        transition_number = current.transition_count + 1
        error_count = current.error_count + (1 if sanitized_error is not None else 0)
        total_duration_ms = current.total_duration_ms + audit.duration_ms
        records_read = current.records_read + audit.records_read
        records_written = current.records_written + audit.records_written
        records_rejected = current.records_rejected + audit.records_rejected
        marker = self._marker(
            "run-transition",
            idempotency_key,
            fingerprint,
            self._run_result(changed),
        )
        update_expression = (
            "SET #stage = :target, updatedAt = :updated, transitionCount = :nextCount, "
            "errorCount = :errorCount, totalDurationMs = :totalDuration, "
            "recordsRead = :recordsRead, recordsWritten = :recordsWritten, "
            "recordsRejected = :recordsRejected, #ttl = :ttl"
        )
        names = {"#stage": "stage", "#ttl": "ttl"}
        values: dict[str, object] = {
            ":target": {"S": target.value},
            ":expected": {"S": expected_stage.value},
            ":expectedCount": {"N": str(current.transition_count)},
            ":updated": {"S": _datetime_text(audit.transitioned_at)},
            ":nextCount": {"N": str(transition_number)},
            ":errorCount": {"N": str(error_count)},
            ":totalDuration": {"N": str(total_duration_ms)},
            ":recordsRead": {"N": str(records_read)},
            ":recordsWritten": {"N": str(records_written)},
            ":recordsRejected": {"N": str(records_rejected)},
            ":ttl": {"N": str(retention_ttl)},
        }
        if changed.active_dataset_version != current.state.active_dataset_version:
            update_expression += ", activeDatasetVersion = :active"
            values[":active"] = {"S": cast(str, changed.active_dataset_version)}
        audit_item: dict[str, object] = {
            "pk": pk,
            "sk": f"TRANSITION#{transition_number}",
            "sequence": transition_number,
            "fromStage": current.state.stage.value,
            "toStage": changed.stage.value,
            "transitionedAt": _datetime_text(audit.transitioned_at),
            "durationMs": audit.duration_ms,
            "recordsRead": audit.records_read,
            "recordsWritten": audit.records_written,
            "recordsRejected": audit.records_rejected,
            "ttl": retention_ttl,
        }
        if sanitized_error is not None:
            audit_item["error"] = sanitized_error
        if audit.substage is not None:
            audit_item["substage"] = audit.substage
        if audit.units_completed is not None:
            audit_item.update(
                unitsCompleted=audit.units_completed,
                unitsTotal=audit.units_total,
                unitLabel=audit.unit_label,
            )
        transaction = self._transact(
            [
                {
                    "Update": {
                        "TableName": self._table_name,
                        "Key": {"pk": {"S": pk}, "sk": {"S": "META"}},
                        "UpdateExpression": update_expression,
                        "ConditionExpression": (
                            "#stage = :expected AND transitionCount = :expectedCount"
                        ),
                        "ExpressionAttributeNames": names,
                        "ExpressionAttributeValues": values,
                    }
                },
                {
                    "Put": {
                        "TableName": self._table_name,
                        "Item": serialize_item(audit_item),
                        "ConditionExpression": "attribute_not_exists(pk)",
                    }
                },
                self._marker_put(marker),
            ],
            scope="run-transition",
            idempotency_key=idempotency_key,
            fingerprint=fingerprint,
            decoder=self._decode_run_result,
            conditional_error=ConditionalWriteError("run stage changed concurrently"),
            conditional_positions=frozenset({0, 1}),
        )
        return cast(RunState, transaction.result) if transaction.found else changed

    def append_error(
        self,
        run_id: str,
        sequence: int,
        message: str,
        *,
        expected_stage: RunStage,
        idempotency_key: str,
    ) -> None:
        """Executa a etapa interna ``append_error`` e valida seus efeitos antes de concluir.

        Args:
            run_id: Identificador não secreto e estável da execução.
            sequence: Entrada ``sequence``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            message: Entrada ``message``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            expected_stage: Valor esperado usado para detectar concorrência ou divergência de
            estado.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
        """
        run_id = _require_component(run_id, "run_id")
        if isinstance(sequence, bool) or not isinstance(sequence, int):
            raise TypeError("sequence must be an integer")
        if sequence <= 0:
            raise ValueError("sequence must be positive")
        persisted_error = PersistedError.from_untrusted(message)
        if not isinstance(expected_stage, RunStage):
            raise TypeError("expected_stage must be a RunStage")
        idempotency_key = _require_idempotency_key(idempotency_key)
        fingerprint = self._fingerprint(
            {
                "runId": run_id,
                "sequence": sequence,
                "message": persisted_error.message,
                "expectedStage": expected_stage.value,
            }
        )
        replay = self._replay("run-append-error", idempotency_key, fingerprint, self._decode_none)
        if replay.found:
            return
        pk = f"INGESTION#RUN#{run_id}"
        run_item = self._get_item(pk, "META")
        if run_item is None:
            raise ConditionalWriteError("run stage differs from expected_stage")
        current = self._decode_run_item(run_item, run_id)
        if current.state.stage is not expected_stage:
            raise ConditionalWriteError("run stage differs from expected_stage")
        occurred_at = self._now()
        marker = self._marker("run-append-error", idempotency_key, fingerprint, {"kind": "none"})
        self._transact(
            [
                {
                    "Update": {
                        "TableName": self._table_name,
                        "Key": {"pk": {"S": pk}, "sk": {"S": "META"}},
                        "UpdateExpression": (
                            "SET updatedAt = :updated, errorCount = :nextErrorCount, #ttl = :ttl"
                        ),
                        "ConditionExpression": (
                            "#stage = :expected AND errorCount = :expectedErrorCount"
                        ),
                        "ExpressionAttributeNames": {"#stage": "stage", "#ttl": "ttl"},
                        "ExpressionAttributeValues": {
                            ":expected": {"S": expected_stage.value},
                            ":expectedErrorCount": {"N": str(current.error_count)},
                            ":nextErrorCount": {"N": str(current.error_count + 1)},
                            ":updated": {"S": _datetime_text(occurred_at)},
                            ":ttl": {"N": str(self._control_ttl(occurred_at))},
                        },
                    }
                },
                {
                    "Put": {
                        "TableName": self._table_name,
                        "Item": serialize_item(
                            {
                                "pk": pk,
                                "sk": f"ERROR#{sequence}",
                                "sequence": sequence,
                                "message": persisted_error.message,
                                "stage": expected_stage.value,
                                "occurredAt": _datetime_text(occurred_at),
                                "ttl": self._control_ttl(occurred_at),
                            }
                        ),
                        "ConditionExpression": "attribute_not_exists(pk)",
                    }
                },
                self._marker_put(marker),
            ],
            scope="run-append-error",
            idempotency_key=idempotency_key,
            fingerprint=fingerprint,
            decoder=self._decode_none,
            conditional_error=ConditionalWriteError("run changed or error sequence exists"),
            conditional_positions=frozenset({0, 1}),
        )


__all__ = ["DynamoControlProtocolError", "DynamoControlRepository"]
