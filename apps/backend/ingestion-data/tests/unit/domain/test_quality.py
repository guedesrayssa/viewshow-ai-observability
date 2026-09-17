"""Verify ingestion quality metrics and coverage statuses are derived consistently."""

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from domain.models import TimeWindow
from domain.quality import (
    BotCoverage,
    CoverageStatus,
    derive_coverage_status,
    derive_human_errors,
)


def test_human_errors_stays_null_before_bot_coverage() -> None:
    assert derive_human_errors(100, 0, BotCoverage.AMBIGUOUS_DEFAULT_ZERO) is None
    assert derive_human_errors(100, 7, BotCoverage.RELIABLE) == 93


def test_human_errors_preserves_decimal_precision() -> None:
    assert derive_human_errors(Decimal("10.5"), Decimal("2.25"), BotCoverage.RELIABLE) == Decimal(
        "8.25"
    )


@pytest.mark.parametrize(
    ("errors", "errors_bot"),
    ((-1, 0), (1, -1), (1, 2)),
)
def test_human_errors_rejects_invalid_counts(errors: int, errors_bot: int) -> None:
    with pytest.raises(ValueError):
        derive_human_errors(errors, errors_bot, BotCoverage.RELIABLE)


def test_human_errors_rejects_invalid_bot_coverage_boundary() -> None:
    with pytest.raises(TypeError, match="bot_coverage"):
        derive_human_errors(100, 7, "reliable")  # type: ignore[arg-type]


def test_coverage_status_uses_expected_and_observed_windows() -> None:
    expected = TimeWindow(
        datetime(2026, 9, 1, tzinfo=UTC),
        datetime(2026, 9, 2, tzinfo=UTC),
        3600,
    )
    observed = TimeWindow(
        datetime(2026, 9, 1, 6, tzinfo=UTC),
        datetime(2026, 9, 2, tzinfo=UTC),
        3600,
    )
    assert derive_coverage_status(expected, observed) is CoverageStatus.PARTIAL
    assert derive_coverage_status(expected, None) is CoverageStatus.UNAVAILABLE
    assert derive_coverage_status(expected, expected) is CoverageStatus.COMPLETE
