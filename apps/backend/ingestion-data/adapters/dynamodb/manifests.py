"""Armazena manifestos candidatos e troca atomicamente o ponteiro do dataset ativo.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import cast

from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from adapters.dynamodb.client import (
    DynamoControlClient,
    DynamoControlProtocolError,
    decode_get_item,
    raise_if_dynamodb_throttled,
    validate_transaction_response,
)
from adapters.dynamodb.codec import serialize_item, serialized_item_bytes
from domain.archive import (
    manifest_is_ready_for_activation,
    require_key_component,
    validate_candidate_manifest,
)
from domain.canonical_json import canonical_bytes
from ports import (
    CandidateManifest,
    ConcurrentActivationError,
    ConditionalWriteError,
    IdempotencyConflict,
    ManifestRepository,
)

_CONTROL_PK = "CONTROL#DATASET"
_ACTIVE_SK = "ACTIVE"
_PROJECTION_FENCE_SK = "ACTIVE"
_MARKER_TTL_SECONDS = 90 * 24 * 60 * 60
_MAX_INTERNAL_ITEM_BYTES = 200 * 1024


def _idempotency_key(value: object) -> str:
    """Monta a chave de idempotência a partir de componentes validados.

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
    if len(value.encode("utf-8")) > 1024:
        raise ValueError("idempotency_key exceeds the internal 1024-byte limit")
    return value


def _required_text(item: Mapping[str, object], field: str) -> str:
    """Obtém texto e rejeita a ausência ou um formato inválido.

    Args:
        item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    value = item.get(field)
    if not isinstance(value, str) or not value:
        raise DynamoControlProtocolError(f"DynamoDB manifest {field} must be a non-empty string")
    return value


def _fingerprint(manifest: CandidateManifest) -> str:
    """Executa a etapa interna ``fingerprint`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        manifest: Entrada ``manifest``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return hashlib.sha256(
        canonical_bytes({"datasetVersion": manifest.dataset_version, "metadata": manifest.metadata})
    ).hexdigest()


def _manifest_payload(manifest: CandidateManifest) -> dict[str, object]:
    """Monta o payload de manifesto com o conjunto fechado de campos.

    Args:
        manifest: Entrada ``manifest``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.
    """
    return {
        "datasetVersion": manifest.dataset_version,
        "metadata": manifest.metadata,
        "fingerprint": _fingerprint(manifest),
    }


def _normalize_numbers(value: object) -> object:
    """Normaliza numbers para o modelo canônico da ingestão.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``object`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
    """
    if type(value) is Decimal:
        decimal = value
        if not decimal.is_finite():
            raise DynamoControlProtocolError("DynamoDB manifest contains a non-finite number")
        if decimal == decimal.to_integral_value():
            return int(decimal)
        return decimal
    if isinstance(value, Mapping):
        return {key: _normalize_numbers(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_normalize_numbers(item) for item in value]
    return value


def _decode_manifest_payload(value: object, *, context: str) -> CandidateManifest:
    """Decodifica manifesto payload e valida sua forma antes de devolvê-lo.

    Args:
        value: Valor não confiável que será validado ou convertido.
        context: Contexto validado compartilhado durante o processamento.

    Returns:
        Valor ``CandidateManifest`` produzido pela operação após as validações.

    Raises:
        DynamoControlProtocolError: Se a operação não puder preservar as invariantes descritas.
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, Mapping) or set(value) != {
        "datasetVersion",
        "metadata",
        "fingerprint",
    }:
        raise DynamoControlProtocolError(f"DynamoDB {context} payload has an invalid shape")
    try:
        dataset_version = _required_text(value, "datasetVersion")
        metadata = value.get("metadata")
        if not isinstance(metadata, Mapping):
            raise TypeError
        normalized = _normalize_numbers(metadata)
        if not isinstance(normalized, Mapping):
            raise TypeError
        manifest = CandidateManifest(dataset_version, cast(Mapping[str, object], normalized))
        validate_candidate_manifest(manifest)
        if _required_text(value, "fingerprint") != _fingerprint(manifest):
            raise ValueError
        return manifest
    except (TypeError, ValueError) as error:
        raise DynamoControlProtocolError(f"DynamoDB {context} payload is invalid") from error


def _domain_cancellation(
    reasons: object, count: int, conditional_positions: frozenset[int]
) -> bool:
    """Verifica a condição associada a domain cancellation.

    Args:
        reasons: Entrada ``reasons``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        count: Entrada ``count``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        conditional_positions: Entrada ``conditional_positions``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.
    """
    if not isinstance(reasons, list) or len(reasons) != count:
        return False
    failures: set[int] = set()
    for index, raw in enumerate(reasons):
        if not isinstance(raw, Mapping):
            return False
        code = raw.get("Code")
        if code == "None":
            continue
        if code != "ConditionalCheckFailed":
            return False
        failures.add(index)
    return bool(failures) and failures <= conditional_positions


class DynamoManifestRepository(ManifestRepository):
    """Agrupa o estado e as operações de ``DynamoManifestRepository`` neste módulo.

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

    def _now(self) -> datetime:
        """Executa a etapa interna ``now`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``datetime`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        value = self._clock()
        if type(value) is not datetime:
            raise TypeError("clock result must be a datetime")
        if value.tzinfo is None or value.utcoffset() != timedelta(0):
            raise ValueError("clock result must be an aware UTC datetime")
        return value.astimezone(UTC)

    @staticmethod
    def _candidate_key(version: str) -> tuple[str, str]:
        """Monta a chave isolada do manifesto candidato.

        Args:
            version: Entrada ``version``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``str`` produzido pela operação após as validações.
        """
        return f"CANDIDATE#DATASET#{version}", "MANIFEST"

    @staticmethod
    def _projection_fence_key(version: str) -> tuple[str, str]:
        """Monta a chave de projeção fence a partir de componentes validados.

        Args:
            version: Entrada ``version``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``tuple[str, str]`` produzido pela operação após as validações.
        """
        return f"DATASET#{version}#INGESTION#PROJECTION_FENCE", _PROJECTION_FENCE_SK

    def _validate_projection_fence(self, dataset_version: str) -> None:
        """Valida projeção fence contra as invariantes deste módulo.

        Args:
            dataset_version: Identificador imutável da versão do dataset.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        pk, sk = self._projection_fence_key(dataset_version)
        item = self._get(pk, sk)
        if item != {
            "pk": pk,
            "sk": sk,
            "entityType": "ACTIVE_PROJECTION_FENCE",
            "datasetVersion": dataset_version,
        }:
            raise DynamoControlProtocolError("DynamoDB active projection fence is invalid")

    @staticmethod
    def _marker_pk(scope: str, key: str) -> str:
        """Executa a etapa interna ``marker_pk`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            scope: Entrada ``scope``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Valor ``str`` produzido pela operação após as validações.
        """
        digest = hashlib.sha256(f"{scope}\0{key}".encode()).hexdigest()
        return f"INGESTION#IDEMPOTENCY#{scope}#{digest}"

    def _get(self, pk: str, sk: str) -> dict[str, object] | None:
        """Obtém a entrada a partir da fonte configurada.

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
        if item is not None and (item.get("pk") != pk or item.get("sk") != sk):
            raise DynamoControlProtocolError("DynamoDB GetItem returned an unexpected key")
        return item

    def _decode_item(self, item: Mapping[str, object], *, active: bool) -> CandidateManifest:
        """Decodifica item e valida sua forma antes de devolvê-lo.

        Args:
            item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            active: Entrada ``active``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``CandidateManifest`` produzido pela operação após as validações.

        Raises:
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        expected = {
            "pk",
            "sk",
            "entityType",
            "activeDatasetVersion" if active else "candidateDatasetVersion",
            "manifest",
        }
        if set(item) != expected:
            raise DynamoControlProtocolError("DynamoDB manifest item has an invalid shape")
        if item.get("entityType") != ("ACTIVE_MANIFEST" if active else "CANDIDATE_MANIFEST"):
            raise DynamoControlProtocolError("DynamoDB manifest item has an invalid entity type")
        manifest = _decode_manifest_payload(item.get("manifest"), context="manifest")
        pointer = _required_text(
            item, "activeDatasetVersion" if active else "candidateDatasetVersion"
        )
        if pointer != manifest.dataset_version:
            raise DynamoControlProtocolError("DynamoDB manifest pointer is inconsistent")
        return manifest

    def _marker(
        self, scope: str, key: str, fingerprint: str, result: Mapping[str, object]
    ) -> dict[str, object]:
        """Executa a etapa interna ``marker`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            scope: Entrada ``scope``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``dict[str, object]`` produzido pela operação após as validações.
        """
        now = self._now()
        item = {
            "pk": self._marker_pk(scope, key),
            "sk": "META",
            "operation": scope,
            "fingerprint": fingerprint,
            "result": result,
            "ttl": int(now.timestamp()) + _MARKER_TTL_SECONDS,
        }
        self._ensure_size(item)
        return item

    @staticmethod
    def _ensure_size(item: Mapping[str, object]) -> None:
        """Garante a existência compatível de tamanho sem sobrescrever divergências.

        Args:
            item: Entrada ``item``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if serialized_item_bytes(serialize_item(item)) > _MAX_INTERNAL_ITEM_BYTES:
            raise ValueError("manifest item exceeds the internal 200 KiB limit")

    def _replay(self, scope: str, key: str, fingerprint: str) -> CandidateManifest | None | bool:
        """Executa a etapa interna ``replay`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            scope: Entrada ``scope``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.

        Returns:
            Valor ``CandidateManifest | None | bool`` produzido pela operação após as
            validações.

        Raises:
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
            IdempotencyConflict: Se a operação não puder preservar as invariantes descritas.
        """
        marker = self._get(self._marker_pk(scope, key), "META")
        if marker is None:
            return False
        if set(marker) != {"pk", "sk", "operation", "fingerprint", "result", "ttl"}:
            raise DynamoControlProtocolError("DynamoDB idempotency marker has an invalid shape")
        if _required_text(marker, "operation") != scope:
            raise DynamoControlProtocolError("DynamoDB idempotency operation is invalid")
        if _required_text(marker, "fingerprint") != fingerprint:
            raise IdempotencyConflict("idempotency key was reused with different input")
        result = marker.get("result")
        if not isinstance(result, Mapping):
            raise DynamoControlProtocolError("DynamoDB idempotency result must be a mapping")
        if result == {"kind": "none"}:
            return None
        if set(result) != {"kind", "manifest"} or result.get("kind") != "manifest":
            raise DynamoControlProtocolError("DynamoDB idempotency result is invalid")
        return _decode_manifest_payload(result.get("manifest"), context="idempotency result")

    def _transact(
        self,
        items: list[dict[str, object]],
        *,
        scope: str,
        key: str,
        fingerprint: str,
        conditional_positions: frozenset[int],
        conditional_error: Exception,
    ) -> CandidateManifest | None | bool:
        """Executa a etapa interna ``transact`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            items: Entrada ``items``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            scope: Entrada ``scope``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            fingerprint: Entrada ``fingerprint``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            conditional_positions: Entrada ``conditional_positions``; a forma aceita é definida
            pela anotação de tipo e validada antes do uso.
            conditional_error: Entrada ``conditional_error``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.

        Returns:
            Valor ``CandidateManifest | None | bool`` produzido pela operação após as
            validações.
        """
        try:
            validate_transaction_response(self._client.transact_write_items(TransactItems=items))
            return False
        except ClientError as error:
            raise_if_dynamodb_throttled(error)
            code = error.response.get("Error", {}).get("Code")
            if code not in {"ConditionalCheckFailedException", "TransactionCanceledException"}:
                raise
            replay = self._replay(scope, key, fingerprint)
            if replay is not False:
                return replay
            if code == "TransactionCanceledException" and not _domain_cancellation(
                error.response.get("CancellationReasons"), len(items), conditional_positions
            ):
                raise
            raise conditional_error from None

    def get_active(self) -> CandidateManifest | None:
        """Obtém ativo a partir da fonte configurada.

        Returns:
            Valor ``CandidateManifest | None`` produzido pela operação após as validações.
        """
        item = self._get(_CONTROL_PK, _ACTIVE_SK)
        return None if item is None else self._decode_item(item, active=True)

    def get_candidate(self, dataset_version: str) -> CandidateManifest | None:
        """Obtém candidato a partir da fonte configurada.

        Args:
            dataset_version: Identificador imutável da versão do dataset.

        Returns:
            Valor ``CandidateManifest | None`` produzido pela operação após as validações.
        """
        version = require_key_component(dataset_version, "dataset_version")
        item = self._get(*self._candidate_key(version))
        return None if item is None else self._decode_item(item, active=False)

    def put_candidate(
        self,
        manifest: CandidateManifest,
        *,
        expected_absent: bool,
        idempotency_key: str,
    ) -> None:
        """Executa a etapa interna ``put_candidate`` e valida seus efeitos antes de concluir.

        Args:
            manifest: Entrada ``manifest``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            expected_absent: Indica se a operação exige que o recurso ainda não exista.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        validate_candidate_manifest(manifest)
        if type(expected_absent) is not bool:
            raise TypeError("expected_absent must be a boolean")
        key = _idempotency_key(idempotency_key)
        operation_fingerprint = hashlib.sha256(
            canonical_bytes(
                {
                    "manifest": _manifest_payload(manifest),
                    "expectedAbsent": expected_absent,
                }
            )
        ).hexdigest()
        replay = self._replay("manifest-put", key, operation_fingerprint)
        if replay is not False:
            if replay is not None:
                raise DynamoControlProtocolError("DynamoDB void replay returned a value")
            return
        candidate_pk, candidate_sk = self._candidate_key(manifest.dataset_version)
        item = {
            "pk": candidate_pk,
            "sk": candidate_sk,
            "entityType": "CANDIDATE_MANIFEST",
            "candidateDatasetVersion": manifest.dataset_version,
            "manifest": _manifest_payload(manifest),
        }
        self._ensure_size(item)
        put: dict[str, object] = {
            "TableName": self._table_name,
            "Item": serialize_item(item),
        }
        if expected_absent:
            put["ConditionExpression"] = "attribute_not_exists(pk)"
        marker = self._marker("manifest-put", key, operation_fingerprint, {"kind": "none"})
        self._transact(
            [
                {"Put": put},
                {
                    "Put": {
                        "TableName": self._table_name,
                        "Item": serialize_item(marker),
                        "ConditionExpression": "attribute_not_exists(pk)",
                    }
                },
            ],
            scope="manifest-put",
            key=key,
            fingerprint=operation_fingerprint,
            conditional_positions=frozenset({0}),
            conditional_error=ConditionalWriteError("candidate manifest already exists"),
        )

    def activate(
        self,
        expected_active: str | None,
        candidate: CandidateManifest,
        *,
        idempotency_key: str,
    ) -> CandidateManifest:
        """Ativa a entrada por meio de uma troca atômica do estado esperado.

        Args:
            expected_active: Valor esperado usado para detectar concorrência ou divergência de
            estado.
            candidate: Manifesto candidato que poderá se tornar ativo.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``CandidateManifest`` produzido pela operação após as validações.

        Raises:
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
            DynamoControlProtocolError: Se a operação não puder preservar as invariantes
            descritas.
        """
        validate_candidate_manifest(candidate)
        if not manifest_is_ready_for_activation(candidate):
            raise ConditionalWriteError("candidate validation has not passed")
        if expected_active is not None:
            require_key_component(expected_active, "expected_active")
        key = _idempotency_key(idempotency_key)
        operation_fingerprint = hashlib.sha256(
            canonical_bytes(
                {
                    "expectedActive": expected_active,
                    "candidate": _manifest_payload(candidate),
                }
            )
        ).hexdigest()
        replay = self._replay("manifest-activate", key, operation_fingerprint)
        if replay is not False:
            if not isinstance(replay, CandidateManifest):
                raise DynamoControlProtocolError("DynamoDB activation replay has no manifest")
            self._validate_projection_fence(replay.dataset_version)
            return replay

        candidate_pk, candidate_sk = self._candidate_key(candidate.dataset_version)
        stored_item = self._get(candidate_pk, candidate_sk)
        if stored_item is None:
            raise ConditionalWriteError("candidate manifest is missing")
        stored = self._decode_item(stored_item, active=False)
        if stored != candidate:
            raise ConditionalWriteError("candidate differs from the stored manifest")

        active_item = {
            "pk": _CONTROL_PK,
            "sk": _ACTIVE_SK,
            "entityType": "ACTIVE_MANIFEST",
            "activeDatasetVersion": candidate.dataset_version,
            "manifest": _manifest_payload(candidate),
        }
        self._ensure_size(active_item)
        active_put: dict[str, object] = {
            "TableName": self._table_name,
            "Item": serialize_item(active_item),
        }
        if expected_active is None:
            active_put["ConditionExpression"] = "attribute_not_exists(pk)"
        else:
            active_put["ConditionExpression"] = "activeDatasetVersion = :expectedActive"
            active_put["ExpressionAttributeValues"] = {":expectedActive": {"S": expected_active}}
        marker = self._marker(
            "manifest-activate",
            key,
            operation_fingerprint,
            {"kind": "manifest", "manifest": _manifest_payload(candidate)},
        )
        fence_pk, fence_sk = self._projection_fence_key(candidate.dataset_version)
        fence_item = {
            "pk": fence_pk,
            "sk": fence_sk,
            "entityType": "ACTIVE_PROJECTION_FENCE",
            "datasetVersion": candidate.dataset_version,
        }
        self._ensure_size(fence_item)
        outcome = self._transact(
            [
                {
                    "ConditionCheck": {
                        "TableName": self._table_name,
                        "Key": {
                            "pk": {"S": candidate_pk},
                            "sk": {"S": candidate_sk},
                        },
                        "ConditionExpression": (
                            "candidateDatasetVersion = :candidateVersion "
                            "AND manifest.fingerprint = :candidateFingerprint"
                        ),
                        "ExpressionAttributeValues": {
                            ":candidateVersion": {"S": candidate.dataset_version},
                            ":candidateFingerprint": {"S": _fingerprint(candidate)},
                        },
                    }
                },
                {"Put": active_put},
                {
                    "Put": {
                        "TableName": self._table_name,
                        "Item": serialize_item(fence_item),
                        "ConditionExpression": "attribute_not_exists(pk)",
                    }
                },
                {
                    "Put": {
                        "TableName": self._table_name,
                        "Item": serialize_item(marker),
                        "ConditionExpression": "attribute_not_exists(pk)",
                    }
                },
            ],
            scope="manifest-activate",
            key=key,
            fingerprint=operation_fingerprint,
            conditional_positions=frozenset({0, 1, 2}),
            conditional_error=ConcurrentActivationError(
                "active manifest changed or candidate no longer matches"
            ),
        )
        if outcome is False:
            return candidate
        if not isinstance(outcome, CandidateManifest):
            raise DynamoControlProtocolError("DynamoDB activation replay has no manifest")
        self._validate_projection_fence(outcome.dataset_version)
        return outcome


__all__ = ["DynamoManifestRepository"]
