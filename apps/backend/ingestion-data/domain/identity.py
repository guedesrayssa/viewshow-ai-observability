"""Calcula identificadores determinísticos para fatos, payloads e versões de dataset.

Papel no fluxo:
    Este arquivo pertence ao núcleo de domínio e deve permanecer determinístico, sem acesso a
    rede, sistema de arquivos, banco de dados ou variáveis de ambiente.

Garantias e limites:
    As validações falham de forma fechada: valores ambíguos ou incompletos são rejeitados antes
    de atravessar uma porta de persistência.
"""

from __future__ import annotations

import hashlib
from typing import Any

from domain.canonical_json import canonical_bytes
from domain.models import CanonicalRecord

CANONICAL_REPRESENTATION_CONTRACT = "canonical-set-v2"


def sha256_id(prefix: str, value: object) -> str:
    """Calcula ou valida o identificador de sha256.

    Args:
        prefix: Entrada ``prefix``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return prefix + hashlib.sha256(canonical_bytes(value)).hexdigest()


def dataset_version(source: str, dump_sha256: str, physical: str, canonical: str) -> str:
    """Executa a etapa interna ``dataset_version`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        source: Identificador da fonte de dados processada.
        dump_sha256: Entrada ``dump_sha256``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        physical: Entrada ``physical``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        canonical: Entrada ``canonical``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return sha256_id(
        "dsv_",
        {
            "sourceSystem": source,
            "dumpSha256": dump_sha256,
            "physicalContractVersion": physical,
            "canonicalSchemaVersion": canonical,
        },
    )


def canonical_dataset_version(
    source: str,
    dump_sha256: str,
    physical: str,
    canonical: str,
) -> str:
    """Derive the canonical-first representation namespace for a source snapshot."""
    return sha256_id(
        "dsv_",
        {
            "sourceSystem": source,
            "dumpSha256": dump_sha256,
            "physicalContractVersion": physical,
            "canonicalSchemaVersion": canonical,
            "representationContract": CANONICAL_REPRESENTATION_CONTRACT,
        },
    )


def _record_identity(record: CanonicalRecord) -> dict[str, Any]:
    """Obtém ou registra identidade como evidência da execução atual.

    Args:
        record: Registro canônico consumido pela operação.

    Returns:
        Valor ``dict[str, Any]`` produzido pela operação após as validações.
    """
    return {
        "schemaVersion": record.schema_version,
        "recordType": record.record_type,
        "sourceSystem": record.source_system,
        "sourceDataset": record.source_dataset,
        "naturalKey": record.natural_key,
    }


def _window_payload(record: CanonicalRecord) -> dict[str, Any] | None:
    """Monta o payload de janela com o conjunto fechado de campos.

    Args:
        record: Registro canônico consumido pela operação.

    Returns:
        Valor ``dict[str, Any] | None`` produzido pela operação após as validações.
    """
    if record.window is None:
        return None
    return {
        "start": record.window.start,
        "end": record.window.end,
        "grainSeconds": record.window.grain_seconds,
    }


def record_id(record: CanonicalRecord) -> str:
    """Obtém ou registra id como evidência da execução atual.

    Args:
        record: Registro canônico consumido pela operação.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return sha256_id("rid_", _record_identity(record))


def payload_hash(record: CanonicalRecord) -> str:
    """Executa a etapa interna ``payload_hash`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        record: Registro canônico consumido pela operação.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return sha256_id(
        "ph_",
        {
            **_record_identity(record),
            "observedAt": record.observed_at,
            "window": _window_payload(record),
            "dimensions": record.dimensions,
            "measures": record.measures,
            "quality": record.quality,
            "qualityFlags": record.quality_flags,
        },
    )
