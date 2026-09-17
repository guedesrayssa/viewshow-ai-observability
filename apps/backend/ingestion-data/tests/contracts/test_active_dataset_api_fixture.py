"""Verify active-dataset API fixtures conform to the ingestion contract."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from adapters.dynamodb.client import DynamoControlProtocolError
from adapters.dynamodb.manifests import _decode_manifest_payload

FIXTURE = Path(__file__).resolve().parents[3] / "contracts" / "fixtures" / "active-dataset-v1.json"


def _active_item() -> dict[str, object]:
    value = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert isinstance(value, dict)
    return value


def test_api_active_fixture_is_accepted_by_the_python_producer_contract() -> None:
    item = _active_item()
    manifest = _decode_manifest_payload(item["manifest"], context="API fixture")

    assert item == {
        "pk": "CONTROL#DATASET",
        "sk": "ACTIVE",
        "entityType": "ACTIVE_MANIFEST",
        "activeDatasetVersion": manifest.dataset_version,
        "manifest": item["manifest"],
    }


def test_api_active_fixture_fails_when_metadata_changes_without_a_new_fingerprint() -> None:
    item = _active_item()
    payload = item["manifest"]
    assert isinstance(payload, dict)
    metadata = payload["metadata"]
    assert isinstance(metadata, dict)
    metadata["projectionVersions"] = {"overview/day": "2.0"}

    with pytest.raises(DynamoControlProtocolError, match="payload is invalid"):
        _decode_manifest_payload(payload, context="API fixture")
