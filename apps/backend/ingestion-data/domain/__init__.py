"""Identifica o núcleo de regras puras e valores imutáveis da ingestão.

Papel no fluxo:
    Este arquivo pertence ao núcleo de domínio e deve permanecer determinístico, sem acesso a
    rede, sistema de arquivos, banco de dados ou variáveis de ambiente.

Garantias e limites:
    As validações falham de forma fechada: valores ambíguos ou incompletos são rejeitados antes
    de atravessar uma porta de persistência.
"""

from domain.incremental_batches import (
    BatchDelivery,
    BatchState,
    EncodedRawBatch,
    IncrementalBatchDefinition,
    IncrementalBatchManifest,
    IncrementalBatchRecord,
    IncrementalBatchReference,
    PhysicalColumn,
    RawBatchPage,
    incremental_batch_id,
)

__all__ = [
    "BatchDelivery",
    "BatchState",
    "EncodedRawBatch",
    "IncrementalBatchDefinition",
    "IncrementalBatchManifest",
    "IncrementalBatchRecord",
    "IncrementalBatchReference",
    "PhysicalColumn",
    "RawBatchPage",
    "incremental_batch_id",
]
