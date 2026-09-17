"""Verify retention policies enforce ingestion storage lifetime defaults."""

import pytest

from domain.retention import RetentionPolicy


def test_default_retention_matches_architecture_policy() -> None:
    policy = RetentionPolicy()
    assert policy.hot_days == 30
    assert policy.canonical_months == 12
    assert policy.run_days == 90
    assert policy.dump_days == 30
    assert policy.staging_days == 7
    assert policy.queue_days == 14


def test_retention_periods_must_be_positive() -> None:
    with pytest.raises(ValueError, match="positive"):
        RetentionPolicy(hot_days=0)


def test_retention_policy_is_immutable() -> None:
    policy = RetentionPolicy()
    with pytest.raises((AttributeError, TypeError)):
        policy.hot_days = 60  # type: ignore[misc]
