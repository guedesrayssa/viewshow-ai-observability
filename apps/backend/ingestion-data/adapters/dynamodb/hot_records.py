"""Grava registros canônicos quentes em lotes limitados e idempotentes.

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
import random
import re
import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Protocol, cast

from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from adapters.dynamodb.client import (
    DynamoDbThrottled,
    raise_if_dynamodb_throttled,
    validate_transaction_response,
)
from adapters.dynamodb.codec import (
    AttributeValue,
    DynamoItem,
    SerializedItem,
    encode_hot_partition_catalog,
    encode_hot_record,
    serialize_item,
    serialized_item_bytes,
    validate_partition,
)
from domain.canonical_json import canonical_bytes
from domain.models import CanonicalRecord
from ports import ConditionalWriteError, HotRecordSink, IdempotencyConflict, WriteResult

_MAX_BATCH_GET_KEYS = 100
_MAX_TRANSACTION_ACTIONS = 100
_MAX_TRANSACTION_BYTES = 4 * 1024 * 1024
_TRANSACTION_SAFETY_MARGIN_BYTES = 64 * 1024
_TRANSACTION_BYTE_BUDGET = _MAX_TRANSACTION_BYTES - _TRANSACTION_SAFETY_MARGIN_BYTES
_CATALOG_FORMAT = "CHAIN_V1"
_DEFAULT_COMPLETED_CACHE_SIZE = 1_024
_MAX_LEGACY_MIGRATION_TARGET_BYTES = 180 * 1024
_MAX_IDEMPOTENCY_KEY_BYTES = 1_024
_HOT_WRITE_MARKER_OPERATION = "hot-write"
_HOT_WRITE_MARKER_ENTITY_TYPE = "HOT_WRITE_IDEMPOTENCY"
_HOT_WRITE_MARKER_TTL_SECONDS = 90 * 24 * 60 * 60
_HOT_WRITE_CLAIM_LEASE_SECONDS = 5 * 60


class DynamoBatchClient(Protocol):
    """Define o contrato mínimo de dynamo lote cliente usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def batch_get_item(self, **kwargs: object) -> Mapping[str, object]:
        """Monta o item de lote get no formato esperado pela camada de destino.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def query(self, **kwargs: object) -> Mapping[str, object]:
        """Consulta os itens que atendem às chaves e aos limites informados.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def transact_write_items(self, **kwargs: object) -> Mapping[str, object]:
        """Executa a etapa interna ``transact_write_items`` e devolve o resultado validado
        indicado pela assinatura.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...


class DynamoBatchRetryExhausted(DynamoDbThrottled):
    """Indica que ``DynamoBatchRetryExhausted`` impediu a operação de continuar com segurança."""


class UnprocessedKeysExhausted(DynamoBatchRetryExhausted):
    """Indica que ``UnprocessedKeysExhausted`` impediu a operação de continuar com segurança."""


class DynamoProtocolError(RuntimeError):
    """Indica que ``DynamoProtocolError`` impediu a operação de continuar com segurança."""


@dataclass(frozen=True, slots=True)
class _CompletedWrite:
    """Representa os dados de ``_CompletedWrite`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
    """

    fingerprint: bytes
    result: WriteResult


@dataclass(frozen=True, slots=True)
class _HotWriteMarker:
    """Representa os dados de ``_HotWriteMarker`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        claim_token: Entrada ``claim_token``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        lease_expires_at: Instante UTC com fuso horário usado pela regra temporal.
    """

    fingerprint: str
    result: WriteResult | None
    claim_token: str | None
    lease_expires_at: int | None


@dataclass(frozen=True, slots=True)
class _HotWriteClaim:
    """Representa os dados de ``_HotWriteClaim`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        claim_token: Entrada ``claim_token``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
    """

    claim_token: str | None
    result: WriteResult | None


def _chunks[T](values: Sequence[T], size: int) -> tuple[Sequence[T], ...]:
    """Executa a etapa interna ``chunks`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        values: Coleção de valores consumida pela operação.
        size: Entrada ``size``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``tuple[Sequence[T], ...]`` produzido pela operação após as validações.
    """
    return tuple(values[start : start + size] for start in range(0, len(values), size))


def _compact_json_bytes(value: object) -> int:
    """Converte compact json para sua representação binária determinística.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``int`` produzido pela operação após as validações.
    """
    return len(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    )


def _embedded_item_bytes(envelope: Mapping[str, object], item: SerializedItem) -> int:
    """Converte embedded item para sua representação binária determinística.

    Args:
        envelope: Entrada ``envelope``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``int`` produzido pela operação após as validações.
    """
    return _compact_json_bytes(envelope) - 2 + serialized_item_bytes(item)


def _required_mapping(value: object, field: str) -> Mapping[str, object]:
    """Obtém mapeamento e rejeita a ausência ou um formato inválido.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``Mapping[str, object]`` produzido pela operação após as validações.

    Raises:
        DynamoProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(value, Mapping):
        raise DynamoProtocolError(f"DynamoDB response {field} must be a mapping")
    if any(not isinstance(key, str) for key in value):
        raise DynamoProtocolError(f"DynamoDB response {field} keys must be strings")
    return cast(Mapping[str, object], value)


def _required_sequence(value: object, field: str) -> Sequence[object]:
    """Obtém sequence e rejeita a ausência ou um formato inválido.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``Sequence[object]`` produzido pela operação após as validações.

    Raises:
        DynamoProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(value, list):
        raise DynamoProtocolError(f"DynamoDB response {field} must be a list")
    return cast(Sequence[object], value)


def _attribute_string(item: Mapping[str, object], attribute: str) -> str:
    """Executa a etapa interna ``attribute_string`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        attribute: Entrada ``attribute``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        DynamoProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    attribute_value = _required_mapping(item.get(attribute), attribute)
    if set(attribute_value) != {"S"}:
        raise DynamoProtocolError(
            f"DynamoDB response {attribute} must be exactly one string AttributeValue"
        )
    value = attribute_value.get("S")
    if not isinstance(value, str):
        raise DynamoProtocolError(
            f"DynamoDB response {attribute} must contain a string AttributeValue"
        )
    return value


def _attribute_integer(item: Mapping[str, object], attribute: str) -> int:
    """Executa a etapa interna ``attribute_integer`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        attribute: Entrada ``attribute``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``int`` produzido pela operação após as validações.

    Raises:
        DynamoProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    raw = _required_mapping(item.get(attribute), attribute)
    if set(raw) != {"N"} or not isinstance(raw.get("N"), str):
        raise DynamoProtocolError(f"DynamoDB response {attribute} must be a numeric AttributeValue")
    value = cast(str, raw["N"])
    try:
        parsed = int(value)
    except ValueError as error:
        raise DynamoProtocolError(f"DynamoDB response {attribute} must be an integer") from error
    if str(parsed) != value or parsed < 0:
        raise DynamoProtocolError(f"DynamoDB response {attribute} must be a non-negative integer")
    return parsed


def _validate_attribute_value(value: object, field: str) -> None:
    """Valida atributo valor contra as invariantes deste módulo.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        DynamoProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    attribute = _required_mapping(value, field)
    if len(attribute) != 1:
        raise DynamoProtocolError(f"DynamoDB response {field} must contain one AttributeValue tag")
    tag, payload = next(iter(attribute.items()))
    if tag == "S":
        if not isinstance(payload, str):
            raise DynamoProtocolError(f"DynamoDB response {field}.S must be a string")
        return
    if tag == "N":
        if not isinstance(payload, str):
            raise DynamoProtocolError(f"DynamoDB response {field}.N must be a string")
        try:
            number = Decimal(payload)
        except InvalidOperation as error:
            raise DynamoProtocolError(f"DynamoDB response {field}.N is invalid") from error
        if not number.is_finite():
            raise DynamoProtocolError(f"DynamoDB response {field}.N must be finite")
        return
    if tag == "BOOL":
        if type(payload) is not bool:
            raise DynamoProtocolError(f"DynamoDB response {field}.BOOL must be a boolean")
        return
    if tag == "NULL":
        if payload is not True:
            raise DynamoProtocolError(f"DynamoDB response {field}.NULL must be true")
        return
    if tag == "B":
        if not isinstance(payload, bytes | bytearray):
            raise DynamoProtocolError(f"DynamoDB response {field}.B must be binary")
        return
    if tag == "M":
        nested = _required_mapping(payload, f"{field}.M")
        for name, item in nested.items():
            _validate_attribute_value(item, f"{field}.M.{name}")
        return
    if tag == "L":
        nested_values = _required_sequence(payload, f"{field}.L")
        for index, item in enumerate(nested_values):
            _validate_attribute_value(item, f"{field}.L[{index}]")
        return
    if tag in {"SS", "NS", "BS"}:
        values = _required_sequence(payload, f"{field}.{tag}")
        if not values:
            raise DynamoProtocolError(f"DynamoDB response {field}.{tag} must not be empty")
        for item in values:
            if tag == "SS" and not isinstance(item, str):
                raise DynamoProtocolError(f"DynamoDB response {field}.SS must contain strings")
            if tag == "BS" and not isinstance(item, bytes | bytearray):
                raise DynamoProtocolError(f"DynamoDB response {field}.BS must contain binary")
            if tag == "NS":
                if not isinstance(item, str):
                    raise DynamoProtocolError(
                        f"DynamoDB response {field}.NS must contain numeric strings"
                    )
                try:
                    number = Decimal(item)
                except InvalidOperation as error:
                    raise DynamoProtocolError(
                        f"DynamoDB response {field}.NS contains an invalid number"
                    ) from error
                if not number.is_finite():
                    raise DynamoProtocolError(
                        f"DynamoDB response {field}.NS numbers must be finite"
                    )
        return
    raise DynamoProtocolError(f"DynamoDB response {field} has unknown AttributeValue tag {tag!r}")


def _validate_serialized_item(value: object, field: str) -> Mapping[str, object]:
    """Valida serialized item contra as invariantes deste módulo.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``Mapping[str, object]`` produzido pela operação após as validações.

    Raises:
        DynamoProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    item = _required_mapping(value, field)
    if not item:
        raise DynamoProtocolError(f"DynamoDB response {field} must not be empty")
    for name, attribute in item.items():
        _validate_attribute_value(attribute, f"{field}.{name}")
    return item


def _serialized_key(value: object, field: str, *, exact: bool) -> tuple[str, str]:
    """Monta a chave de serialized a partir de componentes validados.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.
        exact: Entrada ``exact``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``tuple[str, str]`` produzido pela operação após as validações.

    Raises:
        DynamoProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    item = _validate_serialized_item(value, field)
    if exact and set(item) != {"pk", "sk"}:
        raise DynamoProtocolError(f"DynamoDB response {field} must contain exactly pk and sk")
    return _attribute_string(item, "pk"), _attribute_string(item, "sk")


def _table_payload(
    response: Mapping[str, object], field: str, table_name: str
) -> tuple[bool, object | None]:
    """Monta o payload de tabela com o conjunto fechado de campos.

    Args:
        response: Entrada ``response``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        field: Nome do campo usado para produzir mensagens de validação precisas.
        table_name: Nome validado do recurso, campo ou operação correspondente.

    Returns:
        Valor ``tuple[bool, object | None]`` produzido pela operação após as validações.

    Raises:
        DynamoProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    if field not in response:
        raise DynamoProtocolError(f"DynamoDB response is missing {field}")
    tables = _required_mapping(response[field], field)
    unexpected = set(tables) - {table_name}
    if unexpected:
        raise DynamoProtocolError(f"DynamoDB response {field} contains unexpected tables")
    if table_name in tables:
        return True, tables[table_name]
    return False, None


def _conditional_failure_positions(raw_reasons: object, item_count: int) -> frozenset[int] | None:
    """Executa a etapa interna ``conditional_failure_positions`` e devolve o resultado validado
    indicado pela assinatura.

    Args:
        raw_reasons: Entrada ``raw_reasons``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        item_count: Quantidade inteira não negativa usada na reconciliação.

    Returns:
        Valor ``frozenset[int] | None`` produzido pela operação após as validações.
    """
    if not isinstance(raw_reasons, list) or len(raw_reasons) != item_count:
        return None
    failures: set[int] = set()
    for index, raw_reason in enumerate(raw_reasons):
        if not isinstance(raw_reason, Mapping):
            return None
        code = raw_reason.get("Code")
        if code == "None":
            continue
        if code != "ConditionalCheckFailed":
            return None
        failures.add(index)
    return frozenset(failures) if failures else None


def _epoch_seconds() -> int:
    """Executa a etapa interna ``epoch_seconds`` e devolve o resultado validado indicado pela
    assinatura.

    Returns:
        Valor ``int`` produzido pela operação após as validações.
    """
    return int(time.time())


class DynamoHotRecordSink(HotRecordSink):
    """Agrupa o estado e as operações de ``DynamoHotRecordSink`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        client: DynamoBatchClient,
        table_name: str,
        *,
        max_attempts: int = 8,
        completed_cache_size: int = _DEFAULT_COMPLETED_CACHE_SIZE,
        base_backoff_seconds: float = 0.05,
        sleep: Callable[[float], object] = time.sleep,
        jitter: Callable[[], float] = random.random,
        clock: Callable[[], int] = _epoch_seconds,
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            client: Cliente externo que executa a operação de infraestrutura.
            table_name: Nome validado do recurso, campo ou operação correspondente.
            max_attempts: Entrada ``max_attempts``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            completed_cache_size: Entrada ``completed_cache_size``; a forma aceita é definida
            pela anotação de tipo e validada antes do uso.
            base_backoff_seconds: Duração ou prazo expresso em segundos.
            sleep: Entrada ``sleep``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            jitter: Entrada ``jitter``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
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
        if isinstance(max_attempts, bool) or not isinstance(max_attempts, int):
            raise TypeError("max_attempts must be an integer")
        if not 1 <= max_attempts <= 8:
            raise ValueError("max_attempts must be between 1 and 8")
        if isinstance(completed_cache_size, bool) or not isinstance(completed_cache_size, int):
            raise TypeError("completed_cache_size must be an integer")
        if not 1 <= completed_cache_size <= _DEFAULT_COMPLETED_CACHE_SIZE:
            raise ValueError(
                f"completed_cache_size must be between 1 and {_DEFAULT_COMPLETED_CACHE_SIZE}"
            )
        if not isinstance(base_backoff_seconds, int | float) or base_backoff_seconds < 0:
            raise ValueError("base_backoff_seconds must be non-negative")
        if not callable(clock):
            raise TypeError("clock must be callable")
        self._client = client
        self._table_name = table_name
        self._max_attempts = max_attempts
        self._base_backoff_seconds = float(base_backoff_seconds)
        self._sleep = sleep
        self._jitter = jitter
        self._clock = clock
        self._completed_cache_size = completed_cache_size
        self._completed: OrderedDict[bytes, _CompletedWrite] = OrderedDict()
        self._write_lock = threading.RLock()

    def _backoff(self, completed_attempt: int) -> None:
        """Executa a etapa interna ``backoff`` e valida seus efeitos antes de concluir.

        Args:
            completed_attempt: Entrada ``completed_attempt``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        jitter = self._jitter()
        if not isinstance(jitter, int | float) or not 0 <= jitter <= 1:
            raise ValueError("jitter must return a number between zero and one")
        delay = self._base_backoff_seconds * (2 ** (completed_attempt - 1)) + float(jitter)
        self._sleep(delay)

    def _now(self) -> int:
        """Executa a etapa interna ``now`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``int`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        now = self._clock()
        if isinstance(now, bool) or not isinstance(now, int) or now < 0:
            raise ValueError("clock must return a non-negative integer")
        return now

    def _batch_get_item(self, **kwargs: object) -> Mapping[str, object]:
        """Executa BatchGetItem e traduz apenas throttling esgotado."""
        try:
            return self._client.batch_get_item(**kwargs)
        except ClientError as error:
            raise_if_dynamodb_throttled(error)
            raise

    def _query(self, **kwargs: object) -> Mapping[str, object]:
        """Executa Query e traduz apenas throttling esgotado."""
        try:
            return self._client.query(**kwargs)
        except ClientError as error:
            raise_if_dynamodb_throttled(error)
            raise

    def _transact_write_items(self, **kwargs: object) -> Mapping[str, object]:
        """Executa TransactWriteItems e traduz apenas throttling esgotado."""
        try:
            return self._client.transact_write_items(**kwargs)
        except ClientError as error:
            raise_if_dynamodb_throttled(error)
            raise

    @staticmethod
    def _idempotency_cache_key(idempotency_key: str) -> bytes:
        """Monta a chave de idempotência cache a partir de componentes validados.

        Args:
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``bytes`` produzido pela operação após as validações.
        """
        return hashlib.sha256(idempotency_key.encode("utf-8")).digest()

    @staticmethod
    def _idempotency_marker_key(idempotency_key: str) -> tuple[str, str]:
        """Monta a chave de idempotência marker a partir de componentes validados.

        Args:
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``tuple[str, str]`` produzido pela operação após as validações.
        """
        digest = hashlib.sha256(
            f"{_HOT_WRITE_MARKER_OPERATION}\0{idempotency_key}".encode()
        ).hexdigest()
        return f"INGESTION#IDEMPOTENCY#{_HOT_WRITE_MARKER_OPERATION}#{digest}", "META"

    def _read_hot_write_marker(self, idempotency_key: str) -> _HotWriteMarker | None:
        """Lê quente write marker sem ampliar o escopo solicitado.

        Args:
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``_HotWriteMarker | None`` produzido pela operação após as validações.

        Raises:
            DynamoProtocolError: Se a operação não puder preservar as invariantes descritas.
        """
        pk, sk = self._idempotency_marker_key(idempotency_key)
        raw = self._existing_items(({"pk": {"S": pk}, "sk": {"S": sk}},)).get((pk, sk))
        if raw is None:
            return None
        expected = {
            "pk",
            "sk",
            "entityType",
            "operation",
            "fingerprint",
            "markerState",
            "ttl",
        }
        if (
            raw.get("pk") != {"S": pk}
            or raw.get("sk") != {"S": sk}
            or _attribute_string(raw, "entityType") != _HOT_WRITE_MARKER_ENTITY_TYPE
            or _attribute_string(raw, "operation") != _HOT_WRITE_MARKER_OPERATION
            or _attribute_integer(raw, "ttl") <= 0
        ):
            raise DynamoProtocolError("DynamoDB hot write idempotency marker is invalid")
        fingerprint = _attribute_string(raw, "fingerprint")
        if re.fullmatch(r"[0-9a-f]{64}", fingerprint) is None:
            raise DynamoProtocolError("DynamoDB hot write idempotency marker is invalid")
        state = _attribute_string(raw, "markerState")
        if state == "CLAIMED":
            if set(raw) != expected | {"claimToken", "leaseExpiresAt"}:
                raise DynamoProtocolError("DynamoDB hot write idempotency marker is invalid")
            claim_token = _attribute_string(raw, "claimToken")
            if re.fullmatch(r"[0-9a-f]{32}", claim_token) is None:
                raise DynamoProtocolError("DynamoDB hot write idempotency marker is invalid")
            return _HotWriteMarker(
                fingerprint,
                None,
                claim_token,
                _attribute_integer(raw, "leaseExpiresAt"),
            )
        if state != "COMPLETED" or set(raw) != expected | {"result"}:
            raise DynamoProtocolError("DynamoDB hot write idempotency marker is invalid")
        result_attribute = _required_mapping(raw.get("result"), "result")
        if set(result_attribute) != {"M"}:
            raise DynamoProtocolError("DynamoDB hot write idempotency marker is invalid")
        result = _required_mapping(result_attribute.get("M"), "result.M")
        if set(result) != {"written", "unchanged"}:
            raise DynamoProtocolError("DynamoDB hot write idempotency marker is invalid")
        return _HotWriteMarker(
            fingerprint,
            WriteResult(
                _attribute_integer(result, "written"), _attribute_integer(result, "unchanged")
            ),
            None,
            None,
        )

    @staticmethod
    def _matching_marker_result(
        marker: _HotWriteMarker | None, fingerprint: bytes
    ) -> WriteResult | None:
        """Consolida o resultado de matching marker a partir das evidências acumuladas.

        Args:
            marker: Entrada ``marker``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.

        Returns:
            Valor ``WriteResult | None`` produzido pela operação após as validações.

        Raises:
            IdempotencyConflict: Se a operação não puder preservar as invariantes descritas.
        """
        if marker is None:
            return None
        if marker.fingerprint != fingerprint.hex():
            raise IdempotencyConflict("idempotency key was reused with different input")
        return marker.result

    def _marker_item(
        self,
        idempotency_key: str,
        fingerprint: bytes,
        result: WriteResult | None = None,
        claim_token: str | None = None,
    ) -> DynamoItem:
        """Monta o item de marker no formato esperado pela camada de destino.

        Args:
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.
            fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            claim_token: Entrada ``claim_token``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.

        Returns:
            Valor ``DynamoItem`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        pk, sk = self._idempotency_marker_key(idempotency_key)
        now = self._now()
        marker: DynamoItem = {
            "pk": pk,
            "sk": sk,
            "entityType": _HOT_WRITE_MARKER_ENTITY_TYPE,
            "operation": _HOT_WRITE_MARKER_OPERATION,
            "fingerprint": fingerprint.hex(),
            "markerState": "COMPLETED" if result is not None else "CLAIMED",
            "ttl": now + _HOT_WRITE_MARKER_TTL_SECONDS,
        }
        if result is not None:
            marker["result"] = {"written": result.written, "unchanged": result.unchanged}
        else:
            if claim_token is None:
                raise ValueError("claimed hot write marker requires a claim token")
            marker["claimToken"] = claim_token
            marker["leaseExpiresAt"] = now + _HOT_WRITE_CLAIM_LEASE_SECONDS
        return marker

    def _claim_or_replay_hot_write(
        self, idempotency_key: str, fingerprint: bytes
    ) -> _HotWriteClaim:
        """Executa a etapa interna ``claim_or_replay_hot_write`` e devolve o resultado validado
        indicado pela assinatura.

        Args:
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.
            fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.

        Returns:
            Valor ``_HotWriteClaim`` produzido pela operação após as validações.

        Raises:
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
        """
        existing = self._read_hot_write_marker(idempotency_key)
        replay = self._matching_marker_result(existing, fingerprint)
        if replay is not None:
            return _HotWriteClaim(None, replay)
        claim_token = secrets.token_hex(16)
        if existing is not None:
            return self._take_over_or_reject_hot_write_claim(
                idempotency_key, fingerprint, existing, claim_token
            )
        marker = self._marker_item(idempotency_key, fingerprint, claim_token=claim_token)
        try:
            validate_transaction_response(
                self._transact_write_items(
                    TransactItems=[
                        {
                            "Put": {
                                "TableName": self._table_name,
                                "Item": serialize_item(marker),
                                "ConditionExpression": "attribute_not_exists(pk)",
                            }
                        }
                    ]
                )
            )
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") not in {
                "ConditionalCheckFailedException",
                "TransactionCanceledException",
            }:
                raise
            existing = self._read_hot_write_marker(idempotency_key)
            replay = self._matching_marker_result(existing, fingerprint)
            if replay is not None:
                return _HotWriteClaim(None, replay)
            if existing is None:
                raise ConditionalWriteError(
                    "hot write idempotency marker changed concurrently"
                ) from None
            return self._take_over_or_reject_hot_write_claim(
                idempotency_key, fingerprint, existing, claim_token
            )
        return _HotWriteClaim(claim_token, None)

    def _take_over_or_reject_hot_write_claim(
        self,
        idempotency_key: str,
        fingerprint: bytes,
        existing: _HotWriteMarker,
        claim_token: str,
    ) -> _HotWriteClaim:
        """Executa a etapa interna ``take_over_or_reject_hot_write_claim`` e devolve o resultado
        validado indicado pela assinatura.

        Args:
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.
            fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            existing: Entrada ``existing``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            claim_token: Entrada ``claim_token``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.

        Returns:
            Valor ``_HotWriteClaim`` produzido pela operação após as validações.

        Raises:
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
        """
        if existing.result is not None:
            return _HotWriteClaim(None, existing.result)
        lease_expires_at = existing.lease_expires_at
        now = self._now()
        if lease_expires_at is None or lease_expires_at > now:
            raise ConditionalWriteError("hot write idempotency marker is already claimed")
        marker = self._marker_item(idempotency_key, fingerprint, claim_token=claim_token)
        try:
            validate_transaction_response(
                self._transact_write_items(
                    TransactItems=[
                        {
                            "Put": {
                                "TableName": self._table_name,
                                "Item": serialize_item(marker),
                                "ConditionExpression": (
                                    "fingerprint = :fingerprint AND markerState = :claimed "
                                    "AND leaseExpiresAt <= :now"
                                ),
                                "ExpressionAttributeValues": {
                                    ":fingerprint": {"S": fingerprint.hex()},
                                    ":claimed": {"S": "CLAIMED"},
                                    ":now": {"N": str(now)},
                                },
                            }
                        }
                    ]
                )
            )
            return _HotWriteClaim(claim_token, None)
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") not in {
                "ConditionalCheckFailedException",
                "TransactionCanceledException",
            }:
                raise
            replay = self._matching_marker_result(
                self._read_hot_write_marker(idempotency_key), fingerprint
            )
            if replay is not None:
                return _HotWriteClaim(None, replay)
            raise ConditionalWriteError("hot write idempotency marker changed concurrently") from (
                None
            )

    def _complete_or_replay_hot_write(
        self, idempotency_key: str, fingerprint: bytes, claim_token: str, result: WriteResult
    ) -> WriteResult:
        """Conclui or replay quente write e devolve a evidência final da operação.

        Args:
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.
            fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            claim_token: Entrada ``claim_token``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``WriteResult`` produzido pela operação após as validações.

        Raises:
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
        """
        marker = self._marker_item(idempotency_key, fingerprint, result)
        try:
            validate_transaction_response(
                self._transact_write_items(
                    TransactItems=[
                        {
                            "Put": {
                                "TableName": self._table_name,
                                "Item": serialize_item(marker),
                                "ConditionExpression": (
                                    "fingerprint = :fingerprint AND markerState = :claimed "
                                    "AND claimToken = :claimToken"
                                ),
                                "ExpressionAttributeValues": {
                                    ":fingerprint": {"S": fingerprint.hex()},
                                    ":claimed": {"S": "CLAIMED"},
                                    ":claimToken": {"S": claim_token},
                                },
                            }
                        }
                    ]
                )
            )
            return result
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") not in {
                "ConditionalCheckFailedException",
                "TransactionCanceledException",
            }:
                raise
            replay = self._matching_marker_result(
                self._read_hot_write_marker(idempotency_key), fingerprint
            )
            if replay is not None:
                return replay
            raise ConditionalWriteError("hot write idempotency marker changed concurrently") from (
                None
            )

    def _remember_completed(
        self, cache_key: bytes, fingerprint: bytes, result: WriteResult
    ) -> None:
        """Executa a etapa interna ``remember_completed`` e valida seus efeitos antes de
        concluir.

        Args:
            cache_key: Chave usada para identificar, consultar ou persistir o recurso.
            fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._completed[cache_key] = _CompletedWrite(fingerprint, result)
        self._completed.move_to_end(cache_key)
        if len(self._completed) > self._completed_cache_size:
            self._completed.popitem(last=False)

    def _existing_items(
        self, keys: Sequence[dict[str, AttributeValue]]
    ) -> dict[tuple[str, str], Mapping[str, object]]:
        """Executa a etapa interna ``existing_items`` e devolve o resultado validado indicado
        pela assinatura.

        Args:
            keys: Entrada ``keys``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Valor ``dict[tuple[str, str], Mapping[str, object]]`` produzido pela operação após
            as validações.

        Raises:
            DynamoProtocolError: Se a operação não puder preservar as invariantes descritas.
            UnprocessedKeysExhausted: Se a operação não puder preservar as invariantes
            descritas.
        """
        existing: dict[tuple[str, str], Mapping[str, object]] = {}
        for key_chunk in _chunks(keys, _MAX_BATCH_GET_KEYS):
            pending: Mapping[str, object] = {
                "Keys": list(key_chunk),
                "ConsistentRead": True,
            }
            for attempt in range(1, self._max_attempts + 1):
                requested_keys = {
                    _serialized_key(key, "RequestItems.Keys", exact=True)
                    for key in _required_sequence(pending.get("Keys"), "RequestItems.Keys")
                }
                raw_response = self._batch_get_item(RequestItems={self._table_name: pending})
                response = _required_mapping(raw_response, "BatchGetItem")
                has_responses, response_payload = _table_payload(
                    response, "Responses", self._table_name
                )
                raw_items = (
                    _required_sequence(response_payload, f"Responses.{self._table_name}")
                    if has_responses
                    else ()
                )
                returned_keys: set[tuple[str, str]] = set()
                for raw_item in raw_items:
                    item = _validate_serialized_item(raw_item, "Responses item")
                    key = _serialized_key(item, "Responses item", exact=False)
                    if key not in requested_keys or key in returned_keys:
                        raise DynamoProtocolError(
                            "DynamoDB Responses contains an unsolicited or duplicate item"
                        )
                    returned_keys.add(key)
                    existing[key] = item
                has_unprocessed, raw_pending = _table_payload(
                    response, "UnprocessedKeys", self._table_name
                )
                if not has_unprocessed:
                    break
                pending_response = _required_mapping(raw_pending, "UnprocessedKeys table request")
                if set(pending_response) - {"Keys", "ConsistentRead"}:
                    raise DynamoProtocolError(
                        "DynamoDB UnprocessedKeys table request contains unexpected fields"
                    )
                if pending_response.get("ConsistentRead", True) is not True:
                    raise DynamoProtocolError("DynamoDB UnprocessedKeys changed ConsistentRead")
                if "Keys" not in pending_response:
                    raise DynamoProtocolError("DynamoDB UnprocessedKeys is missing Keys")
                remaining_keys = _required_sequence(
                    pending_response["Keys"], "UnprocessedKeys.Keys"
                )
                if not remaining_keys:
                    break
                seen_pending: set[tuple[str, str]] = set()
                validated_pending: list[object] = []
                for raw_key in remaining_keys:
                    key = _serialized_key(raw_key, "UnprocessedKeys key", exact=True)
                    if key not in requested_keys or key in returned_keys or key in seen_pending:
                        raise DynamoProtocolError(
                            "DynamoDB UnprocessedKeys contains an unsolicited, "
                            "processed, or duplicate key"
                        )
                    seen_pending.add(key)
                    validated_pending.append(raw_key)
                if attempt == self._max_attempts:
                    raise UnprocessedKeysExhausted(
                        f"BatchGetItem exhausted after {self._max_attempts} attempts"
                    )
                self._backoff(attempt)
                pending = {"Keys": validated_pending, "ConsistentRead": True}
        return existing

    def _hot_target_keys(
        self, hot_pk: str, *, maximum_target_bytes: int | None = None
    ) -> tuple[tuple[str, str], ...]:
        """Executa a etapa interna ``hot_target_keys`` e devolve o resultado validado indicado
        pela assinatura.

        Args:
            hot_pk: Entrada ``hot_pk``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            maximum_target_bytes: Quantidade de bytes usada como tamanho ou limite.

        Returns:
            Valor ``tuple[tuple[str, str], ...]`` produzido pela operação após as validações.

        Raises:
            DynamoProtocolError: Se a operação não puder preservar as invariantes descritas.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        keys: list[tuple[str, str]] = []
        seen_keys: set[tuple[str, str]] = set()
        target_bytes = 0
        start_key: Mapping[str, object] | None = None
        seen_pages: set[tuple[str, str]] = set()
        while True:
            request: dict[str, object] = {
                "TableName": self._table_name,
                "KeyConditionExpression": "pk = :pk",
                "ExpressionAttributeValues": {":pk": {"S": hot_pk}},
                "ConsistentRead": True,
                "ProjectionExpression": "pk, sk",
            }
            if start_key is not None:
                request["ExclusiveStartKey"] = start_key
            response = _required_mapping(self._query(**request), "Query")
            for raw in _required_sequence(response.get("Items"), "Query.Items"):
                key = _serialized_key(raw, "Query item", exact=True)
                if key in seen_keys or key[0] != hot_pk:
                    raise DynamoProtocolError(
                        "DynamoDB Query returned duplicate or unsolicited hot keys"
                    )
                target_bytes += len(key[0].encode("utf-8")) + len(key[1].encode("utf-8")) + 256
                if maximum_target_bytes is not None and target_bytes > maximum_target_bytes:
                    raise ValueError(
                        "legacy hot partition catalog exceeds the bounded 200 KiB migration "
                        "segment limit"
                    )
                seen_keys.add(key)
                keys.append(key)
            raw_last = response.get("LastEvaluatedKey")
            if raw_last is None:
                break
            last = _required_mapping(raw_last, "Query.LastEvaluatedKey")
            page_key = _serialized_key(last, "Query.LastEvaluatedKey", exact=True)
            if page_key in seen_pages:
                raise DynamoProtocolError("DynamoDB Query pagination did not advance")
            seen_pages.add(page_key)
            start_key = last
        return tuple(sorted(keys))

    @staticmethod
    def _catalog_key(dataset_version: str, dataset: str, hot_pk: str) -> tuple[str, str]:
        """Monta a chave de catálogo a partir de componentes validados.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            dataset: Nome do dataset permitido pelo registro de contratos.
            hot_pk: Entrada ``hot_pk``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``tuple[str, str]`` produzido pela operação após as validações.
        """
        day = hot_pk.rsplit("#", 1)[-1]
        return (
            f"DATASET#{dataset_version}#INGESTION#HOTPART#{dataset}#{day}",
            "PK#" + hashlib.sha256(hot_pk.encode()).hexdigest(),
        )

    def _catalog_head(
        self, dataset_version: str, dataset: str, hot_pk: str
    ) -> tuple[int, str] | None:
        """Executa a etapa interna ``catalog_head`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            dataset: Nome do dataset permitido pelo registro de contratos.
            hot_pk: Entrada ``hot_pk``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``tuple[int, str] | None`` produzido pela operação após as validações.

        Raises:
            DynamoProtocolError: Se a operação não puder preservar as invariantes descritas.
        """
        pk, sk = self._catalog_key(dataset_version, dataset, hot_pk)
        raw = self._existing_items(({"pk": {"S": pk}, "sk": {"S": sk}},)).get((pk, sk))
        if raw is None:
            return None
        if "catalogFormat" not in raw:
            return None
        if _attribute_string(raw, "entityType") != "HOT_PARTITION":
            raise DynamoProtocolError("DynamoDB HOTPART item has an invalid entity type")
        if _attribute_string(raw, "catalogFormat") != _CATALOG_FORMAT:
            raise DynamoProtocolError("DynamoDB HOTPART item has an unknown catalog format")
        return _attribute_integer(raw, "targetCount"), _attribute_string(raw, "targetDigest")

    @staticmethod
    def _chain_digest(previous: str, targets: Sequence[tuple[str, str]]) -> str:
        """Executa a etapa interna ``chain_digest`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            previous: Entrada ``previous``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            targets: Entrada ``targets``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``str`` produzido pela operação após as validações.
        """
        return hashlib.sha256(canonical_bytes([previous, list(targets)])).hexdigest()

    def _catalog_segment(
        self,
        dataset_version: str,
        dataset: str,
        partition: str,
        hot_pk: str,
        start: int,
        previous_digest: str,
        targets: Sequence[tuple[str, str]],
    ) -> DynamoItem:
        """Executa a etapa interna ``catalog_segment`` e devolve o resultado validado indicado
        pela assinatura.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            dataset: Nome do dataset permitido pelo registro de contratos.
            partition: Identificador canônico da partição física ou lógica.
            hot_pk: Entrada ``hot_pk``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            start: Entrada ``start``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            previous_digest: Entrada ``previous_digest``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.
            targets: Entrada ``targets``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``DynamoItem`` produzido pela operação após as validações.
        """
        digest = self._chain_digest(previous_digest, targets)
        catalog_pk, _catalog_sk = self._catalog_key(dataset_version, dataset, hot_pk)
        return {
            "pk": catalog_pk,
            "sk": f"SEG#{start:020d}",
            "entityType": "HOT_PARTITION_SEGMENT",
            "datasetVersion": dataset_version,
            "dataset": dataset,
            "partition": partition,
            "hotPk": hot_pk,
            "catalogGeneration": 1,
            "start": start,
            "previousTargetDigest": previous_digest,
            "targetCount": len(targets),
            "targetDigest": digest,
            "targets": [{"pk": pk, "sk": sk} for pk, sk in targets],
        }

    def _incremental_catalog(
        self,
        dataset_version: str,
        dataset: str,
        partition: str,
        hot_pk: str,
        pending: Sequence[DynamoItem],
    ) -> tuple[DynamoItem, DynamoItem, dict[str, object]]:
        """Executa a etapa interna ``incremental_catalog`` e devolve o resultado validado
        indicado pela assinatura.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            dataset: Nome do dataset permitido pelo registro de contratos.
            partition: Identificador canônico da partição física ou lógica.
            hot_pk: Entrada ``hot_pk``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            pending: Entrada ``pending``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``tuple[DynamoItem, DynamoItem, dict[str, object]]`` produzido pela operação
            após as validações.
        """
        head = self._catalog_head(dataset_version, dataset, hot_pk)
        if head is None:
            start, previous = 0, hashlib.sha256(canonical_bytes([])).hexdigest()
        else:
            start, previous = head
        targets = tuple((cast(str, item["pk"]), cast(str, item["sk"])) for item in pending)
        segment = self._catalog_segment(
            dataset_version, dataset, partition, hot_pk, start, previous, targets
        )
        catalog = encode_hot_partition_catalog(
            dataset_version,
            dataset,
            partition,
            hot_pk,
            catalog_generation=1,
            target_count=start + len(targets),
            target_digest=cast(str, segment["targetDigest"]),
        )
        catalog["catalogFormat"] = _CATALOG_FORMAT
        put: dict[str, object] = {"TableName": self._table_name, "Item": serialize_item(catalog)}
        if head is None:
            put["ConditionExpression"] = "attribute_not_exists(pk)"
        else:
            put["ConditionExpression"] = (
                "targetCount = :previousCount AND targetDigest = :previousDigest"
            )
            put["ExpressionAttributeValues"] = {
                ":previousCount": {"N": str(start)},
                ":previousDigest": {"S": previous},
            }
        return segment, catalog, put

    def _ensure_incremental_catalog(
        self,
        dataset_version: str,
        dataset: str,
        partition: str,
        hot_pk: str,
    ) -> None:
        """Garante a existência compatível de incremental catálogo sem sobrescrever
        divergências.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            dataset: Nome do dataset permitido pelo registro de contratos.
            partition: Identificador canônico da partição física ou lógica.
            hot_pk: Entrada ``hot_pk``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
        """
        if self._catalog_head(dataset_version, dataset, hot_pk) is not None:
            return
        targets = self._hot_target_keys(
            hot_pk, maximum_target_bytes=_MAX_LEGACY_MIGRATION_TARGET_BYTES
        )
        catalog_pk, catalog_sk = self._catalog_key(dataset_version, dataset, hot_pk)
        raw = self._existing_items(({"pk": {"S": catalog_pk}, "sk": {"S": catalog_sk}},)).get(
            (catalog_pk, catalog_sk)
        )
        if raw is None and not targets:
            return
        previous = hashlib.sha256(canonical_bytes([])).hexdigest()
        segment = self._catalog_segment(
            dataset_version, dataset, partition, hot_pk, 0, previous, targets
        )
        if serialized_item_bytes(serialize_item(segment)) > 200 * 1024:
            raise ValueError(
                "legacy hot partition catalog exceeds the bounded 200 KiB migration segment limit"
            )
        catalog = encode_hot_partition_catalog(
            dataset_version,
            dataset,
            partition,
            hot_pk,
            catalog_generation=1,
            target_count=len(targets),
            target_digest=cast(str, segment["targetDigest"]),
        )
        catalog["catalogFormat"] = _CATALOG_FORMAT
        day = hot_pk.rsplit("#", 1)[-1]
        seal_pk = f"DATASET#{dataset_version}#INGESTION#RETENTION#{dataset}#{day}"
        catalog_put: dict[str, object] = {
            "TableName": self._table_name,
            "Item": serialize_item(catalog),
            "ConditionExpression": (
                "attribute_not_exists(pk)"
                if raw is None
                else "attribute_exists(pk) AND attribute_not_exists(catalogFormat)"
            ),
        }
        actions: list[dict[str, object]] = [
            {
                "ConditionCheck": {
                    "TableName": self._table_name,
                    "Key": {"pk": {"S": seal_pk}, "sk": {"S": "META"}},
                    "ConditionExpression": "attribute_not_exists(pk)",
                }
            },
            {"Put": catalog_put},
        ]
        if targets:
            actions.insert(
                1,
                {
                    "Put": {
                        "TableName": self._table_name,
                        "Item": serialize_item(segment),
                        "ConditionExpression": "attribute_not_exists(pk)",
                    }
                },
            )
        try:
            validate_transaction_response(self._transact_write_items(TransactItems=actions))
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") != "TransactionCanceledException":
                raise
            failed = _conditional_failure_positions(
                error.response.get("CancellationReasons"), len(actions)
            )
            if failed is None:
                raise
            if 0 in failed:
                raise ConditionalWriteError(
                    "hot partition catalog generation is already sealed"
                ) from None
            raise ConditionalWriteError("hot partition catalog changed concurrently") from None

    def _preflight_legacy_catalogs(
        self,
        ordered_items: Sequence[DynamoItem],
        dataset_version: str,
        partition: str,
    ) -> frozenset[tuple[str, str]]:
        """Executa a etapa interna ``preflight_legacy_catalogs`` e devolve o resultado validado
        indicado pela assinatura.

        Args:
            ordered_items: Coleção limitada de itens consumida pela operação.
            dataset_version: Identificador imutável da versão do dataset.
            partition: Identificador canônico da partição física ou lógica.

        Returns:
            Valor ``frozenset[tuple[str, str]]`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        hot_partitions: dict[str, str] = {}
        for item in ordered_items:
            hot_pk = cast(str, item["pk"])
            source_dataset = cast(str, item["sourceDataset"])
            previous_dataset = hot_partitions.setdefault(hot_pk, source_dataset)
            if previous_dataset != source_dataset:
                raise ValueError("hot partition contains records from different datasets")
        empty_legacy_partitions: set[tuple[str, str]] = set()
        for hot_pk, source_dataset in sorted(hot_partitions.items()):
            if self._catalog_head(dataset_version, source_dataset, hot_pk) is not None:
                continue
            targets = self._hot_target_keys(
                hot_pk, maximum_target_bytes=_MAX_LEGACY_MIGRATION_TARGET_BYTES
            )
            previous = hashlib.sha256(canonical_bytes([])).hexdigest()
            segment = self._catalog_segment(
                dataset_version,
                source_dataset,
                partition,
                hot_pk,
                0,
                previous,
                targets,
            )
            if serialized_item_bytes(serialize_item(segment)) > 200 * 1024:
                raise ValueError(
                    "legacy hot partition catalog exceeds the bounded 200 KiB migration "
                    "segment limit"
                )
            if not targets:
                catalog_pk, catalog_sk = self._catalog_key(dataset_version, source_dataset, hot_pk)
                catalog_exists = (catalog_pk, catalog_sk) in self._existing_items(
                    ({"pk": {"S": catalog_pk}, "sk": {"S": catalog_sk}},)
                )
                if not catalog_exists:
                    empty_legacy_partitions.add((hot_pk, source_dataset))
        return frozenset(empty_legacy_partitions)

    def _transact_facts(
        self,
        dataset_version: str,
        dataset: str,
        partition: str,
        hot_pk: str,
        pending: Sequence[DynamoItem],
    ) -> WriteResult:
        """Executa a etapa interna ``transact_facts`` e devolve o resultado validado indicado
        pela assinatura.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            dataset: Nome do dataset permitido pelo registro de contratos.
            partition: Identificador canônico da partição física ou lógica.
            hot_pk: Entrada ``hot_pk``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            pending: Entrada ``pending``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``WriteResult`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
        """
        days = {cast(str, item["pk"]).rsplit("#", 1)[-1] for item in pending}
        if len(days) != 1:
            raise ValueError("fact transaction must contain exactly one partition day")
        day = next(iter(days))
        seal_pk = f"DATASET#{dataset_version}#INGESTION#RETENTION#{dataset}#{day}"
        gate_key: SerializedItem = {"pk": {"S": seal_pk}, "sk": {"S": "META"}}
        gate: dict[str, object] = {
            "ConditionCheck": {
                "TableName": self._table_name,
                "Key": gate_key,
                "ConditionExpression": "attribute_not_exists(pk)",
            }
        }
        gate_envelope: dict[str, object] = {
            "ConditionCheck": {
                "TableName": self._table_name,
                "Key": {},
                "ConditionExpression": "attribute_not_exists(pk)",
            }
        }
        base_bytes = _compact_json_bytes({"TransactItems": []}) + _embedded_item_bytes(
            gate_envelope, gate_key
        )
        chunks: list[list[tuple[DynamoItem, SerializedItem]]] = []
        current: list[tuple[DynamoItem, SerializedItem]] = []
        current_bytes = base_bytes
        for item in pending:
            serialized = serialize_item(item)
            put_envelope: dict[str, object] = {
                "Put": {
                    "TableName": self._table_name,
                    "Item": {},
                    "ConditionExpression": "attribute_not_exists(pk)",
                }
            }
            action_bytes = 1 + _embedded_item_bytes(put_envelope, serialized)
            action_limit_reached = len(current) >= _MAX_TRANSACTION_ACTIONS - 3
            byte_limit_reached = current_bytes + action_bytes >= _TRANSACTION_BYTE_BUDGET
            if current and (action_limit_reached or byte_limit_reached):
                chunks.append(current)
                current = []
                current_bytes = base_bytes
            if current_bytes + action_bytes >= _TRANSACTION_BYTE_BUDGET:
                raise ValueError("one hot fact cannot fit the conservative transaction byte budget")
            current.append((item, serialized))
            current_bytes += action_bytes
        if current:
            chunks.append(current)

        written = 0
        unchanged = 0
        pending_chunks = list(chunks)
        while pending_chunks:
            chunk = pending_chunks.pop(0)
            remaining = list(chunk)
            while remaining:
                segment, _catalog, catalog_put = self._incremental_catalog(
                    dataset_version,
                    dataset,
                    partition,
                    hot_pk,
                    tuple(item for item, _serialized in remaining),
                )
                serialized_segment = serialize_item(segment)
                actions: list[dict[str, object]] = [
                    gate,
                    {
                        "Put": {
                            "TableName": self._table_name,
                            "Item": serialized_segment,
                            "ConditionExpression": "attribute_not_exists(pk)",
                        }
                    },
                    {"Put": catalog_put},
                ]
                for _item, serialized in remaining:
                    put: dict[str, object] = {
                        "TableName": self._table_name,
                        "Item": serialized,
                        "ConditionExpression": "attribute_not_exists(pk)",
                    }
                    actions.append({"Put": put})
                if (
                    serialized_item_bytes(serialized_segment) > 200 * 1024
                    or _compact_json_bytes({"TransactItems": actions}) >= _TRANSACTION_BYTE_BUDGET
                ):
                    if len(remaining) == 1:
                        raise ValueError(
                            "one hot fact plus its catalog segment cannot fit DynamoDB limits"
                        )
                    midpoint = len(remaining) // 2
                    pending_chunks.insert(0, remaining[midpoint:])
                    remaining = remaining[:midpoint]
                    continue
                try:
                    validate_transaction_response(self._transact_write_items(TransactItems=actions))
                    written += len(remaining)
                    break
                except ClientError as error:
                    code = error.response.get("Error", {}).get("Code")
                    if code != "TransactionCanceledException":
                        raise
                    failed = _conditional_failure_positions(
                        error.response.get("CancellationReasons"), len(actions)
                    )
                    if failed is None:
                        raise
                    if 0 in failed:
                        raise ConditionalWriteError(
                            "hot partition catalog generation is already sealed"
                        ) from None
                    if 1 in failed or 2 in failed:
                        raise ConditionalWriteError(
                            "hot partition catalog changed concurrently"
                        ) from None
                    keys = [
                        {
                            "pk": {"S": cast(str, item["pk"])},
                            "sk": {"S": cast(str, item["sk"])},
                        }
                        for item, _serialized in remaining
                    ]
                    current_items = self._existing_items(keys)
                    retry: list[tuple[DynamoItem, SerializedItem]] = []
                    for item, serialized in remaining:
                        persisted = current_items.get(
                            (cast(str, item["pk"]), cast(str, item["sk"]))
                        )
                        if persisted is None:
                            retry.append((item, serialized))
                            continue
                        if _attribute_string(persisted, "payloadHash") != item["payloadHash"]:
                            raise ConditionalWriteError(
                                "versioned hot records are immutable"
                            ) from None
                        unchanged += 1
                    if len(retry) == len(remaining):
                        raise
                    remaining = retry
        return WriteResult(written=written, unchanged=unchanged)

    def _write_claimed_facts(
        self,
        ordered_items: tuple[DynamoItem, ...],
        dataset_version: str,
        partition: str,
        preflight_empty_legacy_partitions: frozenset[tuple[str, str]],
    ) -> WriteResult:
        """Grava claimed facts e devolve a evidência produzida pela operação.

        Args:
            ordered_items: Coleção limitada de itens consumida pela operação.
            dataset_version: Identificador imutável da versão do dataset.
            partition: Identificador canônico da partição física ou lógica.
            preflight_empty_legacy_partitions: Entrada ``preflight_empty_legacy_partitions``; a
            forma aceita é definida pela anotação de tipo e validada antes do uso.

        Returns:
            Valor ``WriteResult`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
        """
        hot_partitions: dict[str, str] = {}
        for item in ordered_items:
            hot_pk = cast(str, item["pk"])
            source_dataset = cast(str, item["sourceDataset"])
            previous_dataset = hot_partitions.setdefault(hot_pk, source_dataset)
            if previous_dataset != source_dataset:
                raise ValueError("hot partition contains records from different datasets")
        keys = [
            {"pk": {"S": cast(str, item["pk"])}, "sk": {"S": cast(str, item["sk"])}}
            for item in ordered_items
        ]
        existing = self._existing_items(keys)
        pending_by_hot_partition: dict[tuple[str, str], list[DynamoItem]] = {}
        for item in ordered_items:
            current = existing.get((cast(str, item["pk"]), cast(str, item["sk"])))
            if current is None:
                pending_by_hot_partition.setdefault(
                    (cast(str, item["pk"]), cast(str, item["sourceDataset"])), []
                ).append(item)
            else:
                current_hash = _attribute_string(current, "payloadHash")
                if current_hash == item["payloadHash"]:
                    continue
                raise ConditionalWriteError("versioned hot records are immutable")
        pending_count = sum(len(items) for items in pending_by_hot_partition.values())
        transaction_result = WriteResult(written=0, unchanged=0)
        for hot_pk, source_dataset in sorted(hot_partitions.items()):
            if (hot_pk, source_dataset) not in preflight_empty_legacy_partitions:
                self._ensure_incremental_catalog(dataset_version, source_dataset, partition, hot_pk)
        for (hot_pk, source_dataset), pending_items in sorted(pending_by_hot_partition.items()):
            current_result = self._transact_facts(
                dataset_version, source_dataset, partition, hot_pk, tuple(pending_items)
            )
            transaction_result = WriteResult(
                written=transaction_result.written + current_result.written,
                unchanged=transaction_result.unchanged + current_result.unchanged,
            )
        return WriteResult(
            written=transaction_result.written,
            unchanged=len(ordered_items) - pending_count + transaction_result.unchanged,
        )

    def write(
        self,
        records: tuple[CanonicalRecord, ...],
        dataset_version: str,
        partition: str,
        *,
        idempotency_key: str,
    ) -> WriteResult:
        """Grava os dados recebidos e devolve a evidência da persistência.

        Args:
            records: Registros canônicos consumidos pela operação.
            dataset_version: Identificador imutável da versão do dataset.
            partition: Identificador canônico da partição física ou lógica.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``WriteResult`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
            IdempotencyConflict: Se a operação não puder preservar as invariantes descritas.
            AssertionError: Se a operação não puder preservar as invariantes descritas.
        """
        if not isinstance(records, tuple) or any(
            not isinstance(record, CanonicalRecord) for record in records
        ):
            raise TypeError("records must be a tuple of CanonicalRecord")
        if not isinstance(idempotency_key, str):
            raise TypeError("idempotency_key must be a string")
        if not idempotency_key:
            raise ValueError("idempotency_key must not be empty")
        if len(idempotency_key.encode("utf-8")) > _MAX_IDEMPOTENCY_KEY_BYTES:
            raise ValueError(
                f"idempotency_key exceeds the internal {_MAX_IDEMPOTENCY_KEY_BYTES}-byte limit"
            )
        validate_partition(partition)

        by_key: dict[tuple[str, str], DynamoItem] = {}
        for record in records:
            item = encode_hot_record(record, dataset_version, partition)
            key = cast(tuple[str, str], (item["pk"], item["sk"]))
            previous = by_key.get(key)
            if previous is not None and previous["payloadHash"] != item["payloadHash"]:
                raise ValueError(f"duplicate recordId has conflicting payload: {item['recordId']}")
            by_key[key] = item
        ordered_items = tuple(by_key[key] for key in sorted(by_key))
        fingerprint = hashlib.sha256(
            canonical_bytes(
                {
                    "datasetVersion": dataset_version,
                    "partition": partition,
                    "records": [
                        {
                            "pk": item["pk"],
                            "sk": item["sk"],
                            "payloadHash": item["payloadHash"],
                        }
                        for item in ordered_items
                    ],
                }
            )
        ).digest()
        cache_key = self._idempotency_cache_key(idempotency_key)
        with self._write_lock:
            completed = self._completed.get(cache_key)
            if completed is not None:
                if completed.fingerprint != fingerprint:
                    raise IdempotencyConflict(
                        f"idempotency key {idempotency_key!r} was reused with different input"
                    )
                self._completed.move_to_end(cache_key)
                return completed.result
            marker = self._read_hot_write_marker(idempotency_key)
            replay = self._matching_marker_result(marker, fingerprint)
            if replay is not None:
                self._remember_completed(cache_key, fingerprint, replay)
                return replay
            preflight_empty_legacy_partitions = self._preflight_legacy_catalogs(
                ordered_items, dataset_version, partition
            )
            claim = self._claim_or_replay_hot_write(idempotency_key, fingerprint)
            if claim.result is not None:
                self._remember_completed(cache_key, fingerprint, claim.result)
                return claim.result
            if claim.claim_token is None:
                raise AssertionError("claimed hot write is missing its claim token")
            result = self._write_claimed_facts(
                ordered_items,
                dataset_version,
                partition,
                preflight_empty_legacy_partitions,
            )
            completed_result = self._complete_or_replay_hot_write(
                idempotency_key, fingerprint, claim.claim_token, result
            )
            self._remember_completed(cache_key, fingerprint, completed_result)
            return completed_result


__all__ = [
    "DynamoBatchRetryExhausted",
    "DynamoHotRecordSink",
    "DynamoProtocolError",
    "UnprocessedKeysExhausted",
]
