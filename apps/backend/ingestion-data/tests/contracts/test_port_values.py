"""Runtime invariants for immutable values exchanged through ports."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Protocol, cast

import pytest

from domain.quality import CoverageStatus
from ports import (
    ArchiveObject,
    ArchivePartition,
    ArchiveState,
    CandidateManifest,
    CoverageObservation,
    EncodedPartition,
    Lease,
    OutboxEvent,
    RestoreRequest,
    RestoreResult,
    SchemaObservation,
    SourcePage,
)

SHA256 = "a" * 64


class ObjectFactory(Protocol):
    def __call__(self) -> object: ...


class MutableCustomValue:
    def __init__(self) -> None:
        self.value = "mutable"


class CustomInteger(int):
    pass


class CustomBytes(bytes):
    pass


class CustomString(str):
    pass


class CustomFloat(float):
    pass


class CustomDecimal(Decimal):
    pass


class CustomDatetime(datetime):
    pass


def test_source_page_deep_freezes_rows_and_cursor() -> None:
    """Mutating caller-owned nested values must not alter a page or its resume cursor."""
    labels = ["stable"]
    cursor_part = [1]
    page = SourcePage(({"metadata": {"labels": labels}},), (cursor_part,))

    labels.append("changed")
    cursor_part.append(2)

    assert page.rows[0] == {"metadata": {"labels": ("stable",)}}
    assert page.next_cursor == ((1,),)


def test_mapping_keys_are_rejected_instead_of_coerced() -> None:
    """A numeric key must not silently alias the textual representation of that key."""
    invalid = cast(dict[str, object], {1: "value"})

    with pytest.raises(TypeError, match="mapping keys must be strings"):
        CandidateManifest("dsv_new", invalid)


def test_mapping_fields_and_nested_mutables_are_nominally_safe() -> None:
    """A non-mapping payload or unsupported mutable container must not remain mutable."""
    with pytest.raises(TypeError, match="must be a mapping"):
        CandidateManifest("dsv_new", cast(Mapping[str, object], ["not-a-mapping"]))
    with pytest.raises(TypeError, match="canonical value"):
        CandidateManifest("dsv_new", {"labels": {"mutable"}})


@pytest.mark.parametrize(
    "value",
    (
        memoryview(bytearray(b"a")),
        bytearray(b"a"),
        {"mutable"},
        frozenset({"unknown"}),
        MutableCustomValue(),
        CustomInteger(1),
        CustomBytes(b"custom"),
        CustomString("custom"),
        CustomFloat(1.5),
        CustomDecimal("1.5"),
        CustomDatetime(2026, 9, 1, tzinfo=UTC),
        object(),
    ),
)
def test_freeze_rejects_values_outside_the_closed_canonical_allowlist(
    value: object,
) -> None:
    """Unknown objects must not preserve caller-owned mutability inside frozen DTOs."""
    with pytest.raises(TypeError, match="canonical value"):
        CandidateManifest("dsv_new", {"value": value})


@pytest.mark.parametrize(
    "value",
    (Decimal("NaN"), Decimal("Infinity"), float("nan"), float("inf")),
)
def test_freeze_rejects_non_finite_numbers(value: object) -> None:
    """NaN and infinity have no stable canonical representation at storage boundaries."""
    with pytest.raises(ValueError, match="finite"):
        CandidateManifest("dsv_new", {"value": value})


def test_freeze_requires_utc_datetimes_and_accepts_all_canonical_values() -> None:
    """Canonical scalar and collection values must be copied into immutable equivalents."""
    with pytest.raises(ValueError, match="aware UTC"):
        CandidateManifest("dsv_new", {"when": datetime(2026, 9, 1)})

    manifest = CandidateManifest(
        "dsv_new",
        {
            "none": None,
            "text": "value",
            "bool": True,
            "int": 1,
            "decimal": Decimal("1.25"),
            "float": 1.5,
            "when": datetime(2026, 9, 1, tzinfo=UTC),
            "bytes": b"immutable",
            "mapping": {"nested": [1, (2,)]},
        },
    )

    assert manifest.metadata["mapping"] == {"nested": (1, (2,))}


@pytest.mark.parametrize(
    "factory",
    (
        lambda: SchemaObservation(SHA256, cast(bool, 1)),
        lambda: CoverageObservation(CoverageStatus.COMPLETE, cast(int, 1.5), None),
        lambda: EncodedPartition(Path("part.parquet"), cast(int, 1.5), 10, SHA256),
        lambda: EncodedPartition(Path("part.parquet"), 1, cast(int, 1.5), SHA256),
        lambda: ArchiveObject("key", SHA256, cast(int, 1.5)),
    ),
)
def test_nominal_boolean_and_integer_fields_reject_numeric_lookalikes(
    factory: object,
) -> None:
    """Floats and integers that compare like valid values must not cross typed boundaries."""
    callable_factory = cast(ObjectFactory, factory)
    with pytest.raises(TypeError):
        callable_factory()


@pytest.mark.parametrize(
    "factory",
    (
        lambda: RestoreRequest("bucket", "key", "version", "NOT-A-SHA"),
        lambda: RestoreResult("A" * 64, 1),
        lambda: EncodedPartition(Path("part.parquet"), 1, 10, "abc"),
        lambda: ArchiveObject("key", "0" * 63, 10),
    ),
)
def test_sha256_fields_require_lowercase_64_hex(factory: object) -> None:
    """Malformed or non-canonical digests must fail before reaching AWS adapters."""
    callable_factory = cast(ObjectFactory, factory)
    with pytest.raises(ValueError, match="lowercase SHA-256"):
        callable_factory()


def test_archive_partition_requires_closed_state_enum() -> None:
    """An unknown archive state must not be persisted through a nominally typed DTO."""
    with pytest.raises(TypeError, match="ArchiveState"):
        ArchivePartition(
            "dsv_new",
            "signal_bucket",
            "2026-09-01",
            cast(ArchiveState, "NOT_A_STATE"),
            {},
        )


def test_datetime_and_text_fields_are_runtime_validated() -> None:
    """Naive timestamps and non-string identifiers must fail at the port boundary."""
    with pytest.raises(ValueError, match="aware UTC"):
        Lease("argus", "run-1", datetime(2026, 9, 1))
    with pytest.raises(TypeError, match="dataset_version must be a string"):
        CandidateManifest(cast(str, 1), {})
    with pytest.raises(ValueError, match="aware UTC"):
        OutboxEvent(
            "evt-1",
            "dsv_new",
            "ANOMALY_DETECTION",
            "idem-1",
            datetime(2026, 9, 1),
            {},
        )


def test_valid_archive_and_outbox_values_remain_explicit() -> None:
    """The happy path must retain version, state, byte size, and UTC event identity."""
    encoded = EncodedPartition(Path("part.parquet"), 1, 128, SHA256)
    partition = ArchivePartition(
        "dsv_new", "signal_bucket", "2026-09-01", ArchiveState.AVAILABLE, {}
    )
    event = OutboxEvent(
        "evt-1",
        "dsv_new",
        "ANOMALY_DETECTION",
        "idem-1",
        datetime(2026, 9, 1, tzinfo=UTC),
        {},
    )

    assert encoded.byte_size == 128
    assert partition.state is ArchiveState.AVAILABLE
    assert event.dataset_version == "dsv_new"


@pytest.mark.parametrize(
    "reserved",
    ("datasetVersion", "eventId", "eventType", "idempotencyKey", "createdAt"),
)
def test_outbox_payload_rejects_reserved_envelope_fields(reserved: str) -> None:
    """Typed envelope identity must have exactly one source of truth."""
    with pytest.raises(ValueError, match="reserved envelope"):
        OutboxEvent(
            "evt-1",
            "dsv_new",
            "ANOMALY_DETECTION",
            "idem-1",
            datetime(2026, 9, 1, tzinfo=UTC),
            {reserved: "contradiction"},
        )
