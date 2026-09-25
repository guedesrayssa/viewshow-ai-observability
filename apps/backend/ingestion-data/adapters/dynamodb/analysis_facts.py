"""Grava no DynamoDB os fatos de série que o worker de análise lê.

Papel no fluxo:
    Recebe registros canônicos confirmados, deriva os fatos das séries do catálogo e os grava em
    lotes na tabela operacional, sob ``DATASET#<versão>#FACT#TS#<seriesId>#<dia>``.

Garantias e limites:
    As chaves são determinísticas, então repetir a escrita sobrescreve cada item com o mesmo
    conteúdo. Itens não processados pelo DynamoDB são reenviados com espera exponencial e, se
    persistirem, a escrita falha em vez de perder fatos silenciosamente.
"""

from __future__ import annotations

import random
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Protocol, cast

from adapters.dynamodb.codec import serialize_item
from domain.analysis_facts import AnalysisFactCatalog, facts_from_records
from domain.models import CanonicalRecord
from ports.analysis_facts import AnalysisFactSink

_MAX_BATCH_ITEMS = 25


class DynamoFactBatchClient(Protocol):
    """Subconjunto do cliente DynamoDB usado para gravar fatos em lote."""

    def batch_write_item(self, **kwargs: object) -> Mapping[str, object]:
        """Executa ``BatchWriteItem`` e devolve a resposta bruta."""
        ...


class UnprocessedFactsExhausted(RuntimeError):
    """O DynamoDB continuou devolvendo itens não processados após todas as tentativas."""


class DynamoAnalysisFactSink(AnalysisFactSink):
    """Implementa ``AnalysisFactSink`` sobre ``BatchWriteItem``."""

    def __init__(
        self,
        client: DynamoFactBatchClient,
        table_name: str,
        catalog: AnalysisFactCatalog,
        *,
        max_attempts: int = 6,
        base_backoff_seconds: float = 0.05,
        sleep: Callable[[float], object] = time.sleep,
        jitter: Callable[[], float] = random.random,
    ) -> None:
        """Valida a configuração e guarda as dependências.

        Args:
            client: Cliente DynamoDB com ``batch_write_item``.
            table_name: Tabela operacional que também é lida pelo worker.
            catalog: Séries que o worker consulta.
            max_attempts: Tentativas por lote antes de falhar.
            base_backoff_seconds: Espera base entre tentativas.
            sleep: Função de espera injetável para testes.
            jitter: Fonte de aleatoriedade em ``[0, 1)`` para o backoff.

        Raises:
            ValueError: Se ``table_name`` for vazio ou os limites de tentativa forem inválidos.
        """
        if not table_name:
            raise ValueError("table_name must not be empty")
        if not 1 <= max_attempts <= 10:
            raise ValueError("max_attempts must be between 1 and 10")
        if base_backoff_seconds < 0:
            raise ValueError("base_backoff_seconds must be non-negative")
        self._client = client
        self._table_name = table_name
        self._catalog = catalog
        self._max_attempts = max_attempts
        self._base_backoff_seconds = base_backoff_seconds
        self._sleep = sleep
        self._jitter = jitter

    def write(self, records: Iterable[CanonicalRecord], dataset_version: str) -> int:
        """Grava os fatos das séries do catálogo e devolve quantos itens foram persistidos."""
        items = facts_from_records(records, dataset_version, self._catalog)
        requests = [{"PutRequest": {"Item": serialize_item(item)}} for item in items]
        for start in range(0, len(requests), _MAX_BATCH_ITEMS):
            self._put(requests[start : start + _MAX_BATCH_ITEMS])
        return len(items)

    def _put(self, requests: Sequence[object]) -> None:
        pending: Mapping[str, object] = {self._table_name: list(requests)}
        for attempt in range(self._max_attempts):
            response = self._client.batch_write_item(RequestItems=pending)
            unprocessed = response.get("UnprocessedItems")
            if not unprocessed:
                return
            pending = cast(Mapping[str, object], unprocessed)
            if attempt + 1 < self._max_attempts:
                delay = self._base_backoff_seconds * (2**attempt) * (0.5 + self._jitter() / 2)
                self._sleep(delay)
        raise UnprocessedFactsExhausted(
            f"DynamoDB left analysis facts unprocessed after {self._max_attempts} attempts"
        )


__all__ = ["DynamoAnalysisFactSink", "DynamoFactBatchClient", "UnprocessedFactsExhausted"]
