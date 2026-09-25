"""Publica eventos validados da outbox em uma fila SQS Standard.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Protocol
from urllib.parse import urlsplit

from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from domain.analysis import analysis_envelope as _analysis_envelope
from domain.analysis import validate_publish_request
from ports import AnalysisRequestPublisher, OutboxEvent, PublishReceipt

_SAFE_ERROR_CODE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")


class SqsClient(Protocol):
    """Define o contrato mínimo de sqs cliente usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def send_message(self, **kwargs: object) -> Mapping[str, object]:
        """Envia mensagem e valida a confirmação retornada pelo destino.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...


class SqsPublishError(RuntimeError):
    """Indica que ``SqsPublishError`` impediu a operação de continuar com segurança."""


def analysis_envelope(event: OutboxEvent) -> dict[str, object]:
    """Executa a etapa interna ``analysis_envelope`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        event: Evento de análise validado que será codificado ou publicado.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    if not isinstance(event, OutboxEvent):
        raise TypeError("event must be an OutboxEvent")
    return _analysis_envelope(event)


def _text(value: object, field: str) -> str:
    """Executa a etapa interna ``text`` e devolve o resultado validado indicado pela assinatura.

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
    return value


def _queue_url(value: object) -> str:
    """Executa a etapa interna ``queue_url`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    url = _text(value, "queue_url")
    parsed = urlsplit(url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path in {"", "/"}
        or bool(parsed.query)
        or bool(parsed.fragment)
        or any(character.isspace() for character in url)
    ):
        raise ValueError("queue_url must be an absolute HTTP(S) URL without credentials")
    return url


class SqsAnalysisRequestPublisher(AnalysisRequestPublisher):
    """Agrupa o estado e as operações de ``SqsAnalysisRequestPublisher`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(self, client: SqsClient, queue_url: str) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            client: Cliente externo que executa a operação de infraestrutura.
            queue_url: URL validada do serviço ou recurso externo.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._client = client
        self._queue_url = _queue_url(queue_url)

    def publish(self, event: OutboxEvent, *, idempotency_key: str) -> PublishReceipt:
        """Publica o conteúdo validado e devolve a confirmação do destino.

        Args:
            event: Evento de análise validado que será codificado ou publicado.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``PublishReceipt`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            SqsPublishError: Se a operação não puder preservar as invariantes descritas.
        """
        if not isinstance(event, OutboxEvent):
            raise TypeError("event must be an OutboxEvent")
        body_bytes = validate_publish_request(event, idempotency_key)
        try:
            response = self._client.send_message(
                QueueUrl=self._queue_url,
                MessageBody=body_bytes.decode("utf-8"),
            )
        except ClientError as error:
            raw_code = error.response.get("Error", {}).get("Code")
            code = (
                raw_code
                if isinstance(raw_code, str) and _SAFE_ERROR_CODE.fullmatch(raw_code)
                else "Unknown"
            )
            raise SqsPublishError(f"SQS SendMessage failed with code {code}") from None
        if not isinstance(response, Mapping):
            raise SqsPublishError("SQS SendMessage response must be a mapping")
        metadata = response.get("ResponseMetadata")
        status = metadata.get("HTTPStatusCode") if isinstance(metadata, Mapping) else None
        if type(status) is not int or status != 200:
            raise SqsPublishError("SQS SendMessage response status must be 200")
        message_id = response.get("MessageId")
        if (
            not isinstance(message_id, str)
            or not message_id
            or message_id.strip() != message_id
            or any(ord(character) < 32 for character in message_id)
            or len(message_id.encode("utf-8")) > 1024
        ):
            raise SqsPublishError("SQS SendMessage response must contain a valid MessageId")
        return PublishReceipt(message_id)


__all__ = [
    "SqsAnalysisRequestPublisher",
    "SqsClient",
    "SqsPublishError",
    "analysis_envelope",
]
