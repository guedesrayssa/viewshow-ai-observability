"""Verify deterministic canonical JSON encoding used by ingestion identities."""

from datetime import UTC, datetime
from decimal import Decimal, localcontext

import pytest

from domain.canonical_json import canonical_bytes


def test_canonical_bytes_are_order_independent_and_typed() -> None:
    left = {"b": Decimal("1.2300"), "a": datetime(2026, 9, 1, tzinfo=UTC)}
    right = {"a": datetime(2026, 9, 1, tzinfo=UTC), "b": Decimal("1.23")}
    assert canonical_bytes(left) == canonical_bytes(right)
    assert b'"$decimal":"1.23"' in canonical_bytes(left)


def test_naive_datetime_is_rejected() -> None:
    with pytest.raises(ValueError, match="UTC"):
        canonical_bytes(datetime(2026, 9, 1))


def test_decimal_encoding_is_independent_of_context_precision() -> None:
    value = Decimal("123456789012345678901234567890.12345678901234567890")
    with localcontext() as context:
        context.prec = 28
        narrow = canonical_bytes(value)
    with localcontext() as context:
        context.prec = 80
        wide = canonical_bytes(value)
    assert narrow == wide


def test_decimal_zero_normalizes_signed_and_scaled_zero() -> None:
    expected = b'{"$decimal":"0"}'
    assert canonical_bytes(Decimal("-0")) == expected
    assert canonical_bytes(Decimal("-0.00")) == expected
    assert canonical_bytes(Decimal("0")) == expected
    assert canonical_bytes(Decimal("0.00")) == expected
