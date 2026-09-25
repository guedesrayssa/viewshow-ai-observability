"""Verify MySQL snapshot restoration against a live database boundary."""

from __future__ import annotations

import base64
import gzip
import hashlib
import io
import os
from collections.abc import Mapping
from pathlib import Path

import pymysql
import pytest

from adapters.sources.mysql_reader import MySqlConnectionSettings
from adapters.sources.mysql_snapshot import MySqlSnapshotRestorer
from ports import RestoreRequest
from tests.integration.mysql_test_config import mysql_test_host, mysql_test_port

MYSQL_IMAGE = "mysql@sha256:902368b688a8aba1d9de3f59110e4b3cb1a5ea76d370c1c29fa64f724a110cad"
DATABASE = "argus_restore_task9"


class MemoryBody:
    def __init__(self, content: bytes) -> None:
        self._content = io.BytesIO(content)

    def read(self, amount: int | None = None) -> bytes:
        return self._content.read(-1 if amount is None else amount)

    def close(self) -> None:
        self._content.close()


class MemoryS3:
    def __init__(self, content: bytes) -> None:
        self._content = content
        self._checksum = base64.b64encode(hashlib.sha256(content).digest()).decode("ascii")

    def head_object(self, **kwargs: object) -> Mapping[str, object]:
        del kwargs
        return {
            "ChecksumSHA256": self._checksum,
            "Metadata": {"sha256": hashlib.sha256(self._content).hexdigest()},
        }

    def get_object(self, **kwargs: object) -> Mapping[str, object]:
        del kwargs
        return {"Body": MemoryBody(self._content)}


def _write_docker_mysql_wrapper(path: Path) -> None:
    path.write_text(
        f"""#!/usr/bin/env python3
import os
import sys

defaults = sys.argv[1].partition("=")[2]
os.execvp(
    "docker",
    [
        "docker",
        "run",
        "--rm",
        "--network",
        "host",
        "-i",
        "--volume",
        defaults + ":/run/secrets/mysql.cnf:ro",
        "{MYSQL_IMAGE}",
        "mysql",
        "--defaults-extra-file=/run/secrets/mysql.cnf",
        *sys.argv[2:],
    ],
)
""",
        encoding="utf-8",
    )
    path.chmod(0o700)


def _root_connection(database: str | None = None) -> pymysql.Connection:
    return pymysql.connect(
        host=mysql_test_host(),
        port=mysql_test_port(),
        user="root",
        password="root-test-only",
        database=database,
        autocommit=True,
    )


@pytest.mark.integration
@pytest.mark.mysql
def test_snapshot_restorer_loads_synthetic_gzip_into_empty_mysql(
    tmp_path: Path,
) -> None:
    sql = b"""CREATE TABLE signal_bucket (
  bts BIGINT NOT NULL,
  source VARCHAR(64) NOT NULL,
  entity VARCHAR(128) NOT NULL,
  metric VARCHAR(64) NOT NULL,
  value DOUBLE NOT NULL,
  PRIMARY KEY (bts, source, entity, metric)
);
INSERT INTO signal_bucket VALUES (1788000000000, 'apollo', 'edge-a', 'rpm', 12.5);
"""
    compressed = gzip.compress(sql, mtime=0)
    executable = "mysql"
    if mysql_test_host() == "127.0.0.1" and mysql_test_port() == 33_077:
        wrapper = tmp_path / "mysql"
        _write_docker_mysql_wrapper(wrapper)
        executable = os.fspath(wrapper)
    admin = _root_connection()
    try:
        with admin.cursor() as cursor:
            cursor.execute(f"DROP DATABASE IF EXISTS `{DATABASE}`")
            cursor.execute(f"CREATE DATABASE `{DATABASE}`")

        restorer = MySqlSnapshotRestorer(
            MemoryS3(compressed),
            MySqlConnectionSettings(
                mysql_test_host(),
                mysql_test_port(),
                "root",
                "root-test-only",
                DATABASE,
            ),
            mysql_executable=executable,
            chunk_size=17,
        )
        result = restorer.restore(
            RestoreRequest(
                "test-bucket",
                "argus/minimal.sql.gz",
                "version-1",
                hashlib.sha256(compressed).hexdigest(),
            ),
            idempotency_key="integration-restore-1",
        )

        restored = _root_connection(DATABASE)
        try:
            with restored.cursor() as cursor:
                cursor.execute("SELECT bts, source, entity, metric, value FROM signal_bucket")
                assert cursor.fetchone() == (
                    1_788_000_000_000,
                    "apollo",
                    "edge-a",
                    "rpm",
                    12.5,
                )
        finally:
            restored.close()
        assert result.compressed_sha256 == hashlib.sha256(compressed).hexdigest()
        assert result.compressed_bytes == len(compressed)
    finally:
        with admin.cursor() as cursor:
            cursor.execute(f"DROP DATABASE IF EXISTS `{DATABASE}`")
        admin.close()
