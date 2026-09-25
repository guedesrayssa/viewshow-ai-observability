"""Identifica o pacote que contém os casos de uso do serviço de ingestão.

Papel no fluxo:
    No fluxo da aplicação, este módulo coordena regras do domínio por meio das interfaces de
    ``ports`` e não depende diretamente de SDKs ou formatos de infraestrutura.

Garantias e limites:
    A ordem das operações preserva idempotência, reconciliação e retomada segura quando uma
    execução é interrompida.
"""

from application.export_incremental import (
    ExportIncremental,
    ExportIncrementalRequest,
    ExportIncrementalResult,
)
from application.ingest_incremental import IngestIncremental, IngestIncrementalResult

__all__ = [
    "ExportIncremental",
    "ExportIncrementalRequest",
    "ExportIncrementalResult",
    "IngestIncremental",
    "IngestIncrementalResult",
]
