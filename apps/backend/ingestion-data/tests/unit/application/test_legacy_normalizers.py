"""Verify legacy source rows normalize into canonical ingestion records."""

from __future__ import annotations

import json
import math
import sys
from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import cast

import pytest

from application.ingest_dataset import identify_record
from application.reconciliation import Reconciliation
from contracts.argus.v2.normalizers import normalize_row
from contracts.registry import DatasetRegistry
from domain.canonical_json import canonical_bytes
from domain.models import RecordType

FIXTURE_PATH = Path(__file__).parents[2] / "fixtures" / "argus_v2_legacy_rows.json"
EXPECTED_OBSERVED_AT = datetime(2026, 9, 1, tzinfo=UTC)


def fixture_row(dataset: str) -> dict[str, object]:
    document = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    return cast(dict[str, object], document[dataset])


@pytest.mark.parametrize(
    ("dataset", "record_type"),
    (
        ("signal_bucket", RecordType.SIGNAL_OBSERVATION),
        ("live_active_15min", RecordType.DIMENSIONAL_METRIC_AGGREGATE),
        ("live_qoe_hourly", RecordType.DIMENSIONAL_METRIC_AGGREGATE),
        ("player_hourly", RecordType.DIMENSIONAL_METRIC_AGGREGATE),
        ("device_hourly", RecordType.DIMENSIONAL_METRIC_AGGREGATE),
        ("geo_hourly", RecordType.DIMENSIONAL_METRIC_AGGREGATE),
        ("live_error_attr_hourly", RecordType.DIMENSIONAL_METRIC_AGGREGATE),
        ("error_cat_hourly", RecordType.DIMENSIONAL_METRIC_AGGREGATE),
        ("incidents", RecordType.INCIDENT),
        ("signal_meta", RecordType.UPSTREAM_SOURCE_HEALTH),
        ("collector_run", RecordType.UPSTREAM_COLLECTOR_RUN),
        ("apollo_run", RecordType.UPSTREAM_COLLECTOR_RUN),
        ("ca_run", RecordType.UPSTREAM_COLLECTOR_RUN),
        ("nr_run", RecordType.UPSTREAM_COLLECTOR_RUN),
        ("prom_run", RecordType.UPSTREAM_COLLECTOR_RUN),
        ("rpaas_run", RecordType.UPSTREAM_COLLECTOR_RUN),
    ),
)
def test_legacy_row_becomes_expected_canonical_type(dataset: str, record_type: RecordType) -> None:
    descriptor = DatasetRegistry.load_argus_v2().require(dataset)

    record = normalize_row(descriptor, fixture_row(dataset))

    assert record.record_type is record_type
    assert record.source_system == "argus"
    assert record.source_dataset == dataset
    assert record.observed_at == EXPECTED_OBSERVED_AT
    if descriptor.grain_seconds is None:
        assert record.window is None
    else:
        assert record.window is not None
        assert record.window.start == EXPECTED_OBSERVED_AT
        assert record.window.end > record.window.start


def test_numeric_measures_use_decimal_without_binary_float_noise() -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")

    record = normalize_row(descriptor, fixture_row("signal_bucket"))

    assert record.measures == {"value": Decimal("10.25")}


def test_iso_run_dates_and_epoch_ranges_are_normalized_to_utc() -> None:
    registry = DatasetRegistry.load_argus_v2()

    apollo = normalize_row(registry.require("apollo_run"), fixture_row("apollo_run"))
    prom = normalize_row(registry.require("prom_run"), fixture_row("prom_run"))

    assert apollo.observed_at == EXPECTED_OBSERVED_AT
    assert apollo.measures["finished_at"] == datetime(2026, 9, 1, 0, 1, tzinfo=UTC)
    assert apollo.measures["range_start"] == datetime(2026, 8, 31, 23, tzinfo=UTC)
    assert prom.measures["range_start_ms"] == datetime(2026, 8, 31, 23, tzinfo=UTC)


def test_geographic_question_marks_become_explicit_unknown_dimensions() -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("geo_hourly")

    record = normalize_row(descriptor, fixture_row("geo_hourly"))

    assert record.dimensions["state_province"] == "UNKNOWN"
    assert record.dimensions["isp"] == "UNKNOWN"


def test_incident_drops_contact_and_unstructured_free_text() -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("incidents")

    record = normalize_row(descriptor, fixture_row("incidents"))
    serialized = canonical_bytes(
        {
            "naturalKey": record.natural_key,
            "dimensions": record.dimensions,
            "measures": record.measures,
        }
    )

    persisted_fields = set(record.dimensions) | set(record.measures)
    assert persisted_fields.isdisjoint(
        {
            "scr_vendor_point_of_contact",
            "short_description",
            "child_incidents",
            "cause",
            "caused_by",
            "u_what_s_the_root_cause",
            "close_notes",
        }
    )
    assert b"synthetic-contact@example.invalid" not in serialized
    assert b"synthetic unstructured cause that must be removed" not in serialized
    assert b"synthetic-change" not in serialized
    assert record.dimensions["number"] == "INC-SYNTHETIC-001"
    assert record.dimensions["parent_incident"] == ""
    assert record.dimensions["childIncidents"] == ("INC-SYNTHETIC-002",)
    assert record.measures["resolved_at"] == datetime(2026, 9, 1, 1, tzinfo=UTC)


def test_invalid_top_names_preserves_count_and_never_persists_raw_json() -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("error_cat_hourly")
    row = fixture_row("error_cat_hourly") | {"top_names": "not-json"}

    record = normalize_row(descriptor, row)
    serialized = canonical_bytes(
        {"dimensions": record.dimensions, "measures": record.measures, "quality": record.quality}
    )

    assert record.measures["errors"] == 12
    assert record.measures["topNames"] is None
    assert "INVALID_SOURCE_JSON" in record.quality_flags
    assert b"not-json" not in serialized


def test_valid_top_names_is_parsed_instead_of_preserved_as_text() -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("error_cat_hourly")

    record = normalize_row(descriptor, fixture_row("error_cat_hourly"))

    assert record.measures["topNames"] == ({"errors": 7, "name": "synthetic-timeout"},)
    assert record.quality_flags == ()


@pytest.mark.parametrize(
    ("dataset", "field", "value", "message"),
    (
        ("signal_bucket", "source", None, "does not allow null"),
        ("signal_bucket", "value", True, "DOUBLE"),
        ("signal_bucket", "value", Decimal("NaN"), "finite"),
        ("signal_bucket", "value", math.inf, "finite"),
        ("live_qoe_hourly", "sessions", 1.5, "BIGINT"),
        ("live_qoe_hourly", "sessions", 2**63, "BIGINT"),
        ("live_qoe_hourly", "errors", True, "BIGINT"),
        ("error_cat_hourly", "errors_bot", 2**31, "INT"),
        ("error_cat_hourly", "kind", "definitely-invalid", "ENUM"),
        ("player_hourly", "player", "x" * 65, "VARCHAR"),
        ("player_hourly", "player", 123, "VARCHAR"),
    ),
)
def test_physical_type_constraints_fail_before_normalization(
    dataset: str, field: str, value: object, message: str
) -> None:
    descriptor = DatasetRegistry.load_argus_v2().require(dataset)
    row = fixture_row(dataset) | {field: value}

    with pytest.raises(ValueError, match=message):
        normalize_row(descriptor, row)


def test_integer_double_is_converted_to_decimal() -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")

    record = normalize_row(descriptor, fixture_row("signal_bucket") | {"value": 10})

    assert record.measures["value"] == Decimal("10")
    assert isinstance(record.measures["value"], Decimal)


@pytest.mark.parametrize(
    "value",
    (
        Decimal("1e309"),
        Decimal("-1e309"),
        10**1000,
        -(10**1000),
    ),
    ids=("decimal-positive", "decimal-negative", "int-positive", "int-negative"),
)
def test_double_rejects_finite_values_outside_binary64_range(value: int | Decimal) -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")

    with pytest.raises(ValueError, match="DOUBLE"):
        normalize_row(descriptor, fixture_row("signal_bucket") | {"value": value})


@pytest.mark.parametrize("value", (Decimal("1e-4000"), Decimal("-1e-4000")))
def test_double_rejects_nonzero_values_that_underflow_to_zero(value: Decimal) -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")

    with pytest.raises(ValueError, match="underflow"):
        normalize_row(descriptor, fixture_row("signal_bucket") | {"value": value})


@pytest.mark.parametrize(
    "value",
    (
        sys.float_info.max,
        -sys.float_info.max,
        float.fromhex("0x0.0000000000001p-1022"),
        -float.fromhex("0x0.0000000000001p-1022"),
    ),
)
def test_double_accepts_binary64_limits_and_subnormal_values(value: float) -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")

    record = normalize_row(descriptor, fixture_row("signal_bucket") | {"value": value})

    assert record.measures["value"] == Decimal(str(value))


@pytest.mark.parametrize(
    "notes",
    (
        "a" * 65_535,
        "a" * 3 + "😀" * 16_383,
    ),
    ids=("ascii", "utf8mb4"),
)
def test_text_accepts_up_to_65535_utf8_bytes(notes: str) -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("collector_run")

    record = normalize_row(descriptor, fixture_row("collector_run") | {"notes": notes})

    assert "notes" not in record.dimensions


@pytest.mark.parametrize(
    "notes",
    (
        "a" * 65_536,
        "a" * 4 + "😀" * 16_383,
    ),
    ids=("ascii", "utf8mb4"),
)
def test_text_rejects_more_than_65535_utf8_bytes(notes: str) -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("collector_run")

    with pytest.raises(ValueError, match="TEXT"):
        normalize_row(descriptor, fixture_row("collector_run") | {"notes": notes})


def test_text_rejects_invalid_unicode_before_normalization() -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("collector_run")

    with pytest.raises(ValueError, match="UTF-8"):
        normalize_row(descriptor, fixture_row("collector_run") | {"notes": "\ud800"})


def test_nullable_signal_meta_without_watermark_has_no_observation_or_window() -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("signal_meta")
    row = fixture_row("signal_meta") | {"last_ingested_ts": None}

    record = normalize_row(descriptor, row)

    assert record.observed_at is None
    assert record.window is None


@pytest.mark.parametrize("dataset", ("incidents", "collector_run", "apollo_run"))
def test_ungrained_event_or_run_has_observation_but_no_window(dataset: str) -> None:
    descriptor = DatasetRegistry.load_argus_v2().require(dataset)

    record = normalize_row(descriptor, fixture_row(dataset))

    assert record.observed_at == EXPECTED_OBSERVED_AT
    assert record.window is None


@pytest.mark.parametrize(
    "top_names",
    (
        "{}",
        '[{"name":"timeout","count":1}]',
        '[{"name":"first","name":"second","errors":1}]',
        '[{"name":"","errors":1}]',
        '[{"name":"timeout","errors":true}]',
        '[{"name":"timeout","errors":-1}]',
        json.dumps([{"name": "timeout", "errors": 1}] * 21),
    ),
)
def test_top_names_rejects_wrong_shape_or_oversize_without_raw(top_names: str) -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("error_cat_hourly")
    row = fixture_row("error_cat_hourly") | {"top_names": top_names}

    record = normalize_row(descriptor, row)
    serialized = canonical_bytes({"measures": record.measures, "quality": record.quality})

    assert record.measures["errors"] == 12
    assert record.measures["topNames"] is None
    assert record.quality_flags == ("INVALID_SOURCE_JSON",)
    assert top_names.encode() not in serialized


@pytest.mark.parametrize(
    "regions",
    (
        '[{"name":"synthetic-region"}]',
        '[""]',
        json.dumps(["synthetic-region"] * 65),
    ),
)
def test_regions_rejects_non_string_empty_or_oversize_values(regions: str) -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("rpaas_run")

    record = normalize_row(descriptor, fixture_row("rpaas_run") | {"regions": regions})

    assert record.measures["regions"] is None
    assert record.quality_flags == ("INVALID_SOURCE_JSON",)
    assert regions.encode() not in canonical_bytes(record.measures)


@pytest.mark.parametrize(
    "child_incidents",
    (
        "not-json",
        '{"id":"INC-SYNTHETIC-002"}',
        '[""]',
        json.dumps(["INC-SYNTHETIC-002"] * 101),
    ),
)
def test_child_incidents_rejects_invalid_or_oversize_payload(child_incidents: str) -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("incidents")

    record = normalize_row(
        descriptor,
        fixture_row("incidents") | {"child_incidents": child_incidents},
    )

    assert record.dimensions["childIncidents"] is None
    assert record.quality_flags == ("INVALID_SOURCE_JSON",)
    assert child_incidents.encode() not in canonical_bytes(record.dimensions)


@pytest.mark.parametrize(
    "dataset",
    ("collector_run", "apollo_run", "ca_run", "nr_run", "prom_run", "rpaas_run"),
)
def test_run_free_text_never_reaches_canonical_payload(dataset: str) -> None:
    descriptor = DatasetRegistry.load_argus_v2().require(dataset)
    row = fixture_row(dataset) | {"notes": "alice@example.invalid token=synthetic-secret"}
    if dataset == "nr_run":
        row["nrql"] = "SELECT synthetic_token FROM InternalEvent"

    record = normalize_row(descriptor, row)
    serialized = canonical_bytes({"dimensions": record.dimensions, "measures": record.measures})

    assert b"alice@example.invalid" not in serialized
    assert b"synthetic-secret" not in serialized
    assert b"synthetic_token" not in serialized
    assert "notes" not in record.dimensions
    assert "nrql" not in record.dimensions


def test_dispatch_rejects_descriptor_whose_normalizer_does_not_match_table() -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")
    inconsistent = replace(descriptor, normalizer="live_qoe_hourly")

    with pytest.raises(ValueError, match="does not match"):
        normalize_row(inconsistent, fixture_row("signal_bucket"))


def test_normalizer_rejects_missing_or_unknown_physical_columns() -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")
    missing = fixture_row("signal_bucket")
    del missing["entity"]
    unknown = fixture_row("signal_bucket") | {"invented_column": "must-fail"}

    with pytest.raises(ValueError, match="physical columns"):
        normalize_row(descriptor, missing)
    with pytest.raises(ValueError, match="physical columns"):
        normalize_row(descriptor, unknown)


def test_same_logical_row_has_stable_id_and_measure_change_has_new_payload_hash() -> None:
    descriptor = DatasetRegistry.load_argus_v2().require("signal_bucket")
    base = identify_record(normalize_row(descriptor, fixture_row("signal_bucket")))
    changed_row = fixture_row("signal_bucket") | {"value": 11.25}
    changed = identify_record(normalize_row(descriptor, changed_row))

    assert base.record_id == changed.record_id
    assert base.payload_hash != changed.payload_hash


def test_reconciliation_requires_a_complete_non_negative_partition() -> None:
    result = Reconciliation(read=10, accepted=8, rejected=2, unchanged=3, written=5)

    assert result == Reconciliation(read=10, accepted=8, rejected=2, unchanged=3, written=5)
    with pytest.raises(ValueError, match="non-negative"):
        Reconciliation(read=-1, accepted=0, rejected=0, unchanged=0, written=0)
    with pytest.raises(ValueError, match="read"):
        Reconciliation(read=10, accepted=9, rejected=2, unchanged=4, written=5)
    with pytest.raises(ValueError, match="accepted"):
        Reconciliation(read=10, accepted=8, rejected=2, unchanged=4, written=5)


def test_declared_bitrate_columns_are_not_consumed_into_the_canonical_record() -> None:
    """bitrate_mbps_avg e bitrate_mbps_p50 existem no dump custodiado
    (snapshot.json dumpSha256) e por isso são declaradas no descriptor: sem elas
    o contrato físico não bate e o backfill recusa a fonte inteira no
    VALIDATING. Mas elas NÃO são consumidas — o modelo canônico precisa ficar
    idêntico ao de antes da declaração, senão isto deixou de ser uma correção
    de contrato e passou a ser mudança de produto, com raio em projeções e no
    contrato público.
    """
    descriptor = DatasetRegistry.load_argus_v2().require("live_qoe_hourly")
    row = fixture_row("live_qoe_hourly")
    assert {"bitrate_mbps_avg", "bitrate_mbps_p50"} <= set(row)

    record = normalize_row(descriptor, row)
    outro_bitrate = normalize_row(
        descriptor, row | {"bitrate_mbps_avg": 999.0, "bitrate_mbps_p50": 888.0}
    )

    # Mudar o bitrate não pode mudar nada do registro canônico.
    assert outro_bitrate == record
    assert outro_bitrate.natural_key == record.natural_key
    assert outro_bitrate.measures == record.measures
    for campo in ("bitrate_mbps_avg", "bitrate_mbps_p50"):
        assert campo not in record.measures
        assert campo not in record.dimensions
