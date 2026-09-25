"""Provide validated MySQL connection settings shared by integration tests."""

from __future__ import annotations

import os


def mysql_test_host() -> str:
    return os.environ.get(
        "MYSQL_TEST_HOST",
        os.environ.get("MYSQL_SNAPSHOT_TEST_HOST", "127.0.0.1"),
    )


def mysql_test_port() -> int:
    return int(
        os.environ.get(
            "MYSQL_TEST_PORT",
            os.environ.get("MYSQL_SNAPSHOT_TEST_PORT", "33077"),
        )
    )
