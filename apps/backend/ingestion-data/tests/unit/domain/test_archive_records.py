"""Verify archive records satisfy canonical ingestion validation rules."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from contracts.argus.v2.normalizers import NormalizationContext, normalize_row
from contracts.registry import DatasetRegistry
from domain.archive_records import validate_archive_record


def _fixture_rows() -> dict[str, dict[str, object]]:
    root = Path(__file__).parents[2] / "fixtures"
    rows = json.loads((root / "argus_v2_legacy_rows.json").read_text())
    rows.update(json.loads((root / "argus_v2_new_rows.json").read_text()))
    return rows


def test_pure_validator_accepts_aliases_for_all_contract_fixtures() -> None:
    """Every physical alias must resolve without importing or invoking the Parquet writer."""
    registry = DatasetRegistry.load_argus_v2()
    context = NormalizationContext(valid_sde_ids=frozenset({"sde-synthetic-001"}))

    for dataset, row in _fixture_rows().items():
        descriptor = registry.require(dataset)
        validate_archive_record(normalize_row(descriptor, row, context), descriptor)


def test_pure_validator_rejects_null_list_elements() -> None:
    """Arrow accepts some nested nulls, so list element nullability belongs in preflight."""
    descriptor = DatasetRegistry.load_argus_v2().require("live_event_sde")
    record = normalize_row(descriptor, _fixture_rows()[descriptor.table])
    invalid = replace(
        record,
        dimensions={**record.dimensions, "tidsJarvis": (None,)},
    )

    with pytest.raises(ValueError, match="dimensions.tidsJarvis.element does not allow null"):
        validate_archive_record(invalid, descriptor)


def test_pure_validator_rejects_null_struct_children() -> None:
    """Nested top-name children remain required even when the whole parsed list is nullable."""
    descriptor = DatasetRegistry.load_argus_v2().require("error_cat_hourly")
    record = normalize_row(descriptor, _fixture_rows()[descriptor.table])
    invalid = replace(
        record,
        measures={
            **record.measures,
            "topNames": ({"name": None, "errors": 7},),
        },
    )

    with pytest.raises(ValueError, match="measures.topNames.element.name does not allow null"):
        validate_archive_record(invalid, descriptor)


def test_pure_validator_requires_canonical_decimal_type() -> None:
    """Binary floats cannot enter the lossless canonical Decimal envelope."""
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")
    record = normalize_row(descriptor, _fixture_rows()[descriptor.table])
    invalid = replace(record, measures={"value": 1.25})

    with pytest.raises(ValueError, match="measures.value must be decimal"):
        validate_archive_record(invalid, descriptor)
