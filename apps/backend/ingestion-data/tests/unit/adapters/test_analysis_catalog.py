"""Verifica o carregamento do catálogo de séries do worker a partir de arquivo ou S3."""

from __future__ import annotations

import io
from typing import Any

import pytest

from adapters.analysis_catalog import load_fact_catalog
from domain.analysis_facts import MAX_CATALOG_BYTES
from tests.analysis_fact_support import PILOT_CATALOG


class FakeS3:
    def __init__(self, body: bytes) -> None:
        self.body = body
        self.requests: list[dict[str, Any]] = []

    def get_object(self, **kwargs: object) -> dict[str, object]:
        self.requests.append(dict(kwargs))
        return {"Body": io.BytesIO(self.body)}


def test_catalog_is_read_from_an_s3_object_of_the_expected_owner() -> None:
    s3 = FakeS3(PILOT_CATALOG.read_bytes())

    catalog = load_fact_catalog(
        "s3://bucket-ingestao/analysis/catalogs/abc.json",
        s3_client=s3,
        expected_bucket_owner="123456789012",
    )

    assert len(catalog.series) == 150
    assert len(catalog.entities) == 10
    assert s3.requests == [
        {
            "Bucket": "bucket-ingestao",
            "Key": "analysis/catalogs/abc.json",
            "ExpectedBucketOwner": "123456789012",
        }
    ]


def test_catalog_is_read_from_an_absolute_local_path() -> None:
    assert len(load_fact_catalog(str(PILOT_CATALOG)).series) == 150


@pytest.mark.parametrize(
    ("location", "message"),
    [
        ("catalogo.json", "absolute path"),
        ("s3://bucket-sem-chave", "s3://bucket/key"),
        ("s3:///chave.json", "s3://bucket/key"),
    ],
)
def test_catalog_location_must_be_an_s3_object_or_an_absolute_path(
    location: str, message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        load_fact_catalog(location, s3_client=FakeS3(b"[]"))


def test_s3_location_requires_a_client() -> None:
    with pytest.raises(ValueError, match="S3 client"):
        load_fact_catalog("s3://bucket/chave.json")


def test_catalog_larger_than_the_limit_is_rejected_before_parsing() -> None:
    with pytest.raises(ValueError, match="size limit"):
        load_fact_catalog(
            "s3://bucket/chave.json", s3_client=FakeS3(b" " * (MAX_CATALOG_BYTES + 1))
        )
