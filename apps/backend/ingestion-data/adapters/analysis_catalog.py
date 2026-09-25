"""Carrega o catálogo de séries do worker de análise a partir de arquivo local ou S3."""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

from domain.analysis_facts import MAX_CATALOG_BYTES, AnalysisFactCatalog

_S3_PREFIX = "s3://"


class S3ObjectReader(Protocol):
    """Subconjunto do cliente S3 necessário para ler o catálogo."""

    def get_object(self, **kwargs: object) -> dict[str, object]:
        """Executa ``GetObject`` e devolve a resposta com o corpo em streaming."""
        ...


class _Body(Protocol):
    def read(self, amount: int = ..., /) -> bytes: ...


def load_fact_catalog(
    location: str,
    *,
    s3_client: S3ObjectReader | None = None,
    expected_bucket_owner: str | None = None,
) -> AnalysisFactCatalog:
    """Lê e valida o catálogo em ``s3://bucket/chave`` ou em um caminho local.

    Args:
        location: URI S3 ou caminho absoluto do JSON do catálogo.
        s3_client: Cliente S3, obrigatório para URIs ``s3://``.
        expected_bucket_owner: Conta dona do bucket, enviada como ``ExpectedBucketOwner``.

    Raises:
        ValueError: Se a localização, o tamanho ou o conteúdo forem inválidos.
    """
    if location.startswith(_S3_PREFIX):
        bucket, _, key = location[len(_S3_PREFIX) :].partition("/")
        if not bucket or not key:
            raise ValueError("analysis catalog location must be s3://bucket/key")
        if s3_client is None:
            raise ValueError("an S3 client is required to read the analysis catalog")
        arguments: dict[str, object] = {"Bucket": bucket, "Key": key}
        if expected_bucket_owner is not None:
            arguments["ExpectedBucketOwner"] = expected_bucket_owner
        body: _Body = s3_client.get_object(**arguments)["Body"]  # type: ignore[assignment]
        raw = body.read(MAX_CATALOG_BYTES + 1)
    else:
        path = Path(location)
        if not path.is_absolute():
            raise ValueError("analysis catalog location must be an s3:// URI or an absolute path")
        with path.open("rb") as stream:
            raw = stream.read(MAX_CATALOG_BYTES + 1)
    if len(raw) > MAX_CATALOG_BYTES:
        raise ValueError("analysis catalog exceeds the size limit")
    return AnalysisFactCatalog.from_json(raw)


__all__ = ["S3ObjectReader", "load_fact_catalog"]
