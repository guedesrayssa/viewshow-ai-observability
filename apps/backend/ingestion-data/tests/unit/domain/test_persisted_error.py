"""Verify persisted ingestion errors are bounded and safely redacted."""

from __future__ import annotations

import pytest

from domain.persisted_error import MAX_PERSISTED_ERROR_BYTES, sanitize_error_message


@pytest.mark.parametrize(
    ("message", "secret"),
    [
        ("restore failed MYSQL_PWD=top-secret", "top-secret"),
        ('restore failed mysql_password = "quoted secret"', "quoted secret"),
        ("restore failed MySQL_PaSsWoRd: 'mixed-case secret'", "mixed-case secret"),
        ("AWS_SESSION_TOKEN = 'session secret'", "session secret"),
        ("export argus_pwd : local-secret", "local-secret"),
        ('collector_access_token="access token"', "access token"),
    ],
)
def test_environment_style_secret_names_are_redacted_case_insensitively(
    message: str,
    secret: str,
) -> None:
    sanitized = sanitize_error_message(message)

    assert secret not in sanitized
    assert "REDACTED" in sanitized


@pytest.mark.parametrize(
    "kind", ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY"]
)
def test_complete_pem_private_key_blocks_are_fully_redacted_before_truncation(kind: str) -> None:
    private_material = "very-secret-private-material-" + ("A" * 20_000)
    message = (
        f"TLS setup failed -----BEGIN {kind}-----\n"
        f"{private_material}\n"
        f"-----END {kind}----- after-key context"
    )

    sanitized = sanitize_error_message(message)

    assert private_material[:100] not in sanitized
    assert "BEGIN" not in sanitized
    assert "END" not in sanitized
    assert "[REDACTED_PRIVATE_KEY]" in sanitized
    assert "after-key context" in sanitized
    assert len(sanitized.encode("utf-8")) <= MAX_PERSISTED_ERROR_BYTES


def test_unterminated_pem_private_key_cannot_leak_a_truncated_prefix() -> None:
    private_material = "partial-secret-" + ("B" * 20_000)

    sanitized = sanitize_error_message(
        f"TLS setup failed -----BEGIN PRIVATE KEY-----\n{private_material}"
    )

    assert "partial-secret" not in sanitized
    assert "BEGIN" not in sanitized
    assert sanitized.endswith("[REDACTED_PRIVATE_KEY]")
    assert len(sanitized.encode("utf-8")) <= MAX_PERSISTED_ERROR_BYTES
