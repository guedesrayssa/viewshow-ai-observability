"""Porta de escrita dos fatos de série consumidos pelo worker de análise."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterable

from domain.models import CanonicalRecord


class AnalysisFactSink(ABC):
    """Persiste os fatos das séries do catálogo do worker a partir de registros confirmados.

    Implementações devem ser idempotentes: os itens têm chaves determinísticas, então repetir a
    escrita dos mesmos registros não pode alterar o resultado nem duplicar fatos.
    """

    @abstractmethod
    def write(self, records: Iterable[CanonicalRecord], dataset_version: str) -> int:
        """Grava os fatos derivados de ``records`` e devolve quantos itens foram persistidos.

        Args:
            records: Registros canônicos já confirmados no arquivo.
            dataset_version: Versão imutável do dataset dos registros.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError


__all__ = ["AnalysisFactSink"]
