"""Valida respostas básicas do cliente de baixo nível do DynamoDB.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol, cast

from boto3.dynamodb.types import TypeDeserializer  # type: ignore[import-untyped]
from botocore.exceptions import ClientError  # type: ignore[import-untyped]

_DIRECT_THROTTLING_CODES = frozenset(
    {
        "ProvisionedThroughputExceededException",
        "RequestLimitExceeded",
        "Throttling",
        "ThrottlingException",
        "TransactionInProgressException",
    }
)
_TRANSACTION_THROTTLING_CODES = frozenset(
    {
        "ProvisionedThroughputExceeded",
        "ThrottlingError",
        "TransactionConflict",
    }
)


class DynamoControlClient(Protocol):
    """Define o contrato mínimo de dynamo control cliente usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def get_item(self, **kwargs: object) -> Mapping[str, object]:
        """Obtém item a partir da fonte configurada.

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


class DynamoControlProtocolError(RuntimeError):
    """Indica que ``DynamoControlProtocolError`` impediu a operação de continuar com segurança."""


class DynamoDbThrottled(RuntimeError):
    """DynamoDB esgotou o orçamento de retries antes de confirmar a operação."""


# Preserve the vendor's conventional acronym spelling for callers that prefer it.
DynamoDBThrottled = DynamoDbThrottled


def is_dynamodb_throttling(error: ClientError) -> bool:
    """Retorna se ``error`` representa apenas throttling após retries do SDK."""
    response = error.response
    code = response.get("Error", {}).get("Code")
    if code in _DIRECT_THROTTLING_CODES:
        return True
    reasons = response.get("CancellationReasons")
    if code != "TransactionCanceledException" or not isinstance(reasons, list) or not reasons:
        return False
    reason_codes: list[object] = []
    for reason in reasons:
        if not isinstance(reason, Mapping):
            return False
        reason_codes.append(reason.get("Code"))
    return any(item in _TRANSACTION_THROTTLING_CODES for item in reason_codes) and all(
        item in _TRANSACTION_THROTTLING_CODES or item == "None" for item in reason_codes
    )


def raise_if_dynamodb_throttled(error: ClientError) -> None:
    """Traduz throttling esgotado para o erro compartilhado do control plane."""
    if is_dynamodb_throttling(error):
        raise DynamoDbThrottled("DynamoDB operation was throttled after retries") from None


_DESERIALIZER = TypeDeserializer()


def decode_get_item(response: object) -> dict[str, object] | None:
    """Decodifica get item e valida sua forma antes de devolvê-lo.

    Args:
        response: Entrada ``response``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``dict[str, object] | None`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    if not isinstance(response, Mapping):
        raise DynamoControlProtocolError("DynamoDB GetItem response must be a mapping")
    if "Item" not in response:
        return None
    raw_item = response["Item"]
    if not isinstance(raw_item, Mapping) or not raw_item:
        raise DynamoControlProtocolError("DynamoDB GetItem Item must be a non-empty mapping")
    decoded: dict[str, object] = {}
    try:
        for name, attribute in raw_item.items():
            if not isinstance(name, str) or not isinstance(attribute, Mapping):
                raise TypeError
            decoded[name] = _DESERIALIZER.deserialize(cast(dict[str, Any], attribute))
    except (KeyError, TypeError, ValueError) as error:
        raise DynamoControlProtocolError(
            "DynamoDB GetItem Item contains an invalid AttributeValue"
        ) from error
    return decoded


def validate_transaction_response(response: object) -> None:
    """Valida transaction resposta contra as invariantes deste módulo.

    Args:
        response: Entrada ``response``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(response, Mapping):
        raise DynamoControlProtocolError("DynamoDB transaction response must be a mapping")
    unexpected = set(response) - {"ResponseMetadata", "ConsumedCapacity", "ItemCollectionMetrics"}
    if unexpected:
        raise DynamoControlProtocolError("DynamoDB transaction response contains unknown fields")
    metadata = response.get("ResponseMetadata")
    if not isinstance(metadata, Mapping):
        raise DynamoControlProtocolError("DynamoDB transaction response metadata must be a mapping")
    status = metadata.get("HTTPStatusCode")
    if isinstance(status, bool) or not isinstance(status, int) or status != 200:
        raise DynamoControlProtocolError("DynamoDB transaction response status must be 200")


__all__ = [
    "DynamoDBThrottled",
    "DynamoControlClient",
    "DynamoControlProtocolError",
    "DynamoDbThrottled",
    "decode_get_item",
    "is_dynamodb_throttling",
    "raise_if_dynamodb_throttled",
    "validate_transaction_response",
]
