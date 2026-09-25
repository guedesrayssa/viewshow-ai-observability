"""Fail-closed contract tests for the selected ARGUS 2.0 datasets."""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest

EXPECTED_ARGUS_V2_DATASETS = (
    "signal_bucket",
    "live_active_15min",
    "live_qoe_hourly",
    "player_hourly",
    "device_hourly",
    "geo_hourly",
    "live_error_attr_hourly",
    "error_cat_hourly",
    "incidents",
    "signal_meta",
    "collector_run",
    "apollo_run",
    "ca_run",
    "nr_run",
    "prom_run",
    "rpaas_run",
    "app_error",
    "app_error_model",
    "app_error_version",
    "cdn_vod_shadow",
    "finding_status_log",
    "live_event_sde",
    "live_event",
)

CONTRACT_ROOT = Path(__file__).parents[2] / "contracts" / "argus" / "v2"
ARGUS_V2_SCHEMA_PATH = CONTRACT_ROOT / "db_schema.sql"


def copy_contract(tmp_path: Path) -> Path:
    copied_contract = tmp_path / "v2"
    shutil.copytree(CONTRACT_ROOT, copied_contract)
    return copied_contract


def test_registry_is_exactly_the_approved_allowlist() -> None:
    """Adding an unreviewed physical table must not silently broaden ingestion."""
    from contracts.registry import DatasetRegistry

    registry = DatasetRegistry.load_argus_v2()

    assert tuple(registry.names()) == EXPECTED_ARGUS_V2_DATASETS
    assert "signal_point" not in registry
    assert "incident_label" not in registry
    assert "player_live_hourly" not in registry


def test_every_descriptor_matches_the_reduced_official_schema() -> None:
    """A made-up column, type, or natural key must invalidate the physical contract."""
    from contracts.registry import DatasetRegistry
    from scripts.extract_argus_schema import parse_create_tables

    schema = parse_create_tables(ARGUS_V2_SCHEMA_PATH.read_text(encoding="utf-8"))
    registry = DatasetRegistry.load_argus_v2()

    assert tuple(schema) == (
        "signal_bucket",
        "signal_meta",
        "app_error",
        "app_error_model",
        "app_error_version",
        "cdn_vod_shadow",
        "incidents",
        "player_hourly",
        "device_hourly",
        "geo_hourly",
        "live_qoe_hourly",
        "live_error_attr_hourly",
        "live_event",
        "live_event_sde",
        "live_active_15min",
        "error_cat_hourly",
        "collector_run",
        "apollo_run",
        "nr_run",
        "prom_run",
        "rpaas_run",
        "ca_run",
        "finding_status_log",
    )
    for descriptor in registry:
        assert descriptor.table in schema
        assert tuple(descriptor.columns) == tuple(schema[descriptor.table].columns)
        assert descriptor.natural_key == schema[descriptor.table].primary_key
        assert all(isinstance(column.nullable, bool) for column in descriptor.columns)
        assert all(
            not next(column for column in descriptor.columns if column.name == key).nullable
            for key in descriptor.natural_key
        )


def test_descriptor_schema_requires_column_nullability(tmp_path: Path) -> None:
    from contracts.registry import ContractValidationError, DatasetRegistry

    copied_contract = copy_contract(tmp_path)
    descriptor_path = copied_contract / "descriptors" / "signal_bucket.json"
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    descriptor["columns"][0].pop("nullable", None)
    descriptor_path.write_text(json.dumps(descriptor, indent=2) + "\n", encoding="utf-8")

    with pytest.raises(ContractValidationError, match="JSON Schema"):
        DatasetRegistry.load_argus_v2(copied_contract)


def test_registry_load_validates_snapshot_and_schema_fingerprint() -> None:
    """A contract generated from a different dump/schema must not load as ARGUS 2.0."""
    from contracts.registry import DatasetRegistry

    registry = DatasetRegistry.load_argus_v2()
    snapshot = json.loads((CONTRACT_ROOT / "snapshot.json").read_text(encoding="utf-8"))
    registry_document = json.loads((CONTRACT_ROOT / "registry.json").read_text(encoding="utf-8"))

    # A custódia é da FORMA. A instância do dump é entrada operacional e por
    # isso não aparece aqui — ver test_registry_pins_the_shape_and_not_the_dump_instance.
    assert snapshot == {
        "sourceSystem": "argus",
        "physicalContractVersion": "2.0",
        "canonicalSchemaVersion": "1.0",
    }
    assert (
        registry.schema_fingerprint
        == "sha256:" + hashlib.sha256(ARGUS_V2_SCHEMA_PATH.read_bytes()).hexdigest()
    )
    assert registry_document["schemaFingerprint"] == registry.schema_fingerprint


def test_registry_rejects_a_schema_that_no_longer_matches_its_fingerprint(
    tmp_path: Path,
) -> None:
    """An altered physical contract must be rejected before any dataset is read."""
    from contracts.registry import ContractValidationError, DatasetRegistry

    copied_contract = copy_contract(tmp_path)
    schema_path = copied_contract / "db_schema.sql"
    schema_path.write_text(
        schema_path.read_text(encoding="utf-8").replace("value   DOUBLE", "value   BIGINT", 1),
        encoding="utf-8",
    )

    with pytest.raises(ContractValidationError, match="fingerprint differs"):
        DatasetRegistry.load_argus_v2(copied_contract)


def test_registry_requires_the_expected_draft_2020_12_descriptor_schema(tmp_path: Path) -> None:
    """An empty or differently versioned schema cannot masquerade as the contract."""
    from contracts.registry import ContractValidationError, DatasetRegistry

    copied_contract = copy_contract(tmp_path)
    (copied_contract / "descriptor.schema.json").write_text("{}\n", encoding="utf-8")

    with pytest.raises(ContractValidationError, match="Draft 2020-12"):
        DatasetRegistry.load_argus_v2(copied_contract)


def test_registry_applies_the_descriptor_schema_to_every_descriptor(tmp_path: Path) -> None:
    """Changing a schema constraint must affect loading of the descriptor set."""
    from contracts.registry import ContractValidationError, DatasetRegistry

    copied_contract = copy_contract(tmp_path)
    schema_path = copied_contract / "descriptor.schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    schema["properties"]["coveragePolicy"]["enum"] = ["forbidden_policy"]
    schema_path.write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")

    with pytest.raises(ContractValidationError, match="JSON Schema"):
        DatasetRegistry.load_argus_v2(copied_contract)


def test_registry_applies_standard_draft_2020_12_const_constraints(tmp_path: Path) -> None:
    """A supported Draft assertion cannot be silently ignored by the loader."""
    from contracts.registry import ContractValidationError, DatasetRegistry

    copied_contract = copy_contract(tmp_path)
    schema_path = copied_contract / "descriptor.schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    schema["properties"]["coveragePolicy"]["const"] = "forbidden_policy"
    schema_path.write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")

    with pytest.raises(ContractValidationError, match="JSON Schema"):
        DatasetRegistry.load_argus_v2(copied_contract)


def test_registry_rejects_a_malformed_draft_2020_12_schema(tmp_path: Path) -> None:
    """Meta-schema validation must reject invalid keyword values before descriptors."""
    from contracts.registry import ContractValidationError, DatasetRegistry

    copied_contract = copy_contract(tmp_path)
    schema_path = copied_contract / "descriptor.schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    schema["properties"]["coveragePolicy"]["minLength"] = "invalid"
    schema_path.write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")

    with pytest.raises(ContractValidationError, match="invalid Draft 2020-12 schema"):
        DatasetRegistry.load_argus_v2(copied_contract)


@pytest.mark.parametrize(
    ("field", "altered_value"),
    (
        ("sourceSystem", "other"),
        ("physicalContractVersion", "2.1"),
        ("canonicalSchemaVersion", "1.1"),
        ("snapshotExtractedOn", "2026-09-01"),
        ("dumpSha256", "0" * 64),
        ("compressedBytes", 1),
    ),
)
def test_registry_rejects_any_change_to_approved_snapshot_custody(
    tmp_path: Path,
    field: str,
    altered_value: str | int,
) -> None:
    """Valid formatting cannot turn another snapshot into the approved ARGUS 2.0 source."""
    from contracts.registry import ContractValidationError, DatasetRegistry

    copied_contract = copy_contract(tmp_path)
    snapshot_path = copied_contract / "snapshot.json"
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    snapshot[field] = altered_value
    snapshot_path.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")

    with pytest.raises(ContractValidationError):
        DatasetRegistry.load_argus_v2(copied_contract)


def test_registry_rejects_duplicate_top_level_json_members(tmp_path: Path) -> None:
    """Last-member-wins JSON cannot hide a conflicting custody value."""
    from contracts.registry import ContractValidationError, DatasetRegistry

    copied_contract = copy_contract(tmp_path)
    snapshot_path = copied_contract / "snapshot.json"
    snapshot_path.write_text(
        snapshot_path.read_text(encoding="utf-8").replace(
            "{\n", '{\n  "sourceSystem": "wrong",\n', 1
        ),
        encoding="utf-8",
    )

    with pytest.raises(ContractValidationError, match="duplicate JSON member"):
        DatasetRegistry.load_argus_v2(copied_contract)


def test_registry_rejects_duplicate_nested_json_members(tmp_path: Path) -> None:
    """Duplicate members must also be rejected inside descriptor policy objects."""
    from contracts.registry import ContractValidationError, DatasetRegistry

    copied_contract = copy_contract(tmp_path)
    descriptor_path = copied_contract / "descriptors" / "app_error.json"
    descriptor_path.write_text(
        descriptor_path.read_text(encoding="utf-8").replace(
            '"sourceDays": 30,', '"sourceDays": 1,\n    "sourceDays": 30,', 1
        ),
        encoding="utf-8",
    )

    with pytest.raises(ContractValidationError, match="duplicate JSON member"):
        DatasetRegistry.load_argus_v2(copied_contract)


@pytest.mark.parametrize("archive_field", ("does_not_exist", "error_code"))
def test_event_time_partition_must_be_the_declared_physical_timestamp(
    tmp_path: Path,
    archive_field: str,
) -> None:
    """Archive partitioning cannot defer a typo or a second clock to runtime."""
    from contracts.registry import ContractValidationError, DatasetRegistry

    copied_contract = copy_contract(tmp_path)
    descriptor_path = copied_contract / "descriptors" / "app_error.json"
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    descriptor["archivePartition"]["field"] = archive_field
    descriptor_path.write_text(json.dumps(descriptor, indent=2) + "\n", encoding="utf-8")

    with pytest.raises(ContractValidationError, match="archive partition field"):
        DatasetRegistry.load_argus_v2(copied_contract)


def test_nullable_sde_kickoff_is_preserved_without_an_invented_partition_clock() -> None:
    """Nullable sports kickoff remains semantic time while archive uses snapshot date."""
    from contracts.registry import DatasetRegistry

    descriptor = DatasetRegistry.load_argus_v2().require("live_event_sde")

    assert descriptor.timestamp_field == "kickoff_ts"
    assert descriptor.archive_partition == {"strategy": "snapshot_date", "field": None}


def test_live_window_sync_is_limited_to_event_time_contracts() -> None:
    from contracts.registry import DatasetRegistry

    registry = DatasetRegistry.load_argus_v2()

    assert registry.require("signal_bucket").supports_live_window_sync is True
    assert registry.require("signal_meta").supports_live_window_sync is False
    assert registry.require("live_event_sde").supports_live_window_sync is False


def test_every_descriptor_declares_operational_metadata() -> None:
    """Missing cursor, coverage, archive, or normalizer policy must fail at startup."""
    from contracts.registry import DatasetRegistry

    for descriptor in DatasetRegistry.load_argus_v2():
        assert descriptor.record_type
        assert descriptor.cursor_key
        assert descriptor.retention
        assert descriptor.coverage_policy
        assert descriptor.required_modes
        assert descriptor.archive_partition
        assert descriptor.normalizer


def test_unknown_table_is_rejected() -> None:
    """Runtime lookup cannot fall back to a generic descriptor."""
    from contracts.registry import DatasetRegistry, UnknownDatasetError

    with pytest.raises(UnknownDatasetError, match="not allowlisted"):
        DatasetRegistry.load_argus_v2().require("signal_point")


def test_registry_pins_the_shape_and_not_the_dump_instance() -> None:
    """O contrato versionado descreve a FORMA dos dados, não qual dump foi lido.

    Forma (23 descriptors, fingerprint, versões) muda quando o sistema de origem
    muda o schema: raro, e merece revisão de código. Instância (sha do dump,
    bytes, data de extração) muda em TODA extração, mesmo com schema idêntico —
    cravá-la no contrato transformava um fato operacional em mudança de código,
    e era o que impedia ingerir qualquer outro dump, inclusive um reduzido para
    teste.

    A linhagem não se perde: dataset_version continua derivando do sha real do
    dump, então dump diferente produz dsv_ diferente, e o manifesto registra
    qual dump o gerou.
    """
    from contracts.registry import DatasetRegistry

    snapshot = DatasetRegistry.load_argus_v2().snapshot

    assert set(snapshot) == {
        "sourceSystem",
        "physicalContractVersion",
        "canonicalSchemaVersion",
    }
    # Toda evidência da instância do dump viaja pelo fluxo operacional.
    for instance_field in ("dumpSha256", "compressedBytes", "snapshotExtractedOn"):
        assert instance_field not in snapshot
