"""Verify MySQL snapshot restoration validates archive and database safety."""

from __future__ import annotations

import base64
import gzip
import hashlib
import io
import os
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

import pytest

from adapters.sources.mysql_reader import MySqlConnectionSettings
from adapters.sources.mysql_snapshot import MySqlSnapshotRestorer, SnapshotRestoreError
from ports import IdempotencyConflict, RestoreRequest, SnapshotChecksumMismatch

SQL = b"CREATE TABLE signal_bucket (id BIGINT PRIMARY KEY);\n"


class FakeBody:
    def __init__(self, content: bytes) -> None:
        self._content = io.BytesIO(content)
        self.closed = False

    def read(self, amount: int | None = None) -> bytes:
        return self._content.read(-1 if amount is None else amount)

    def close(self) -> None:
        self.closed = True
        self._content.close()


class CloseOnlyBody:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


class FakeS3:
    def __init__(
        self,
        content: bytes,
        *,
        head_digest: bytes | None = None,
        metadata_sha256: str | None = None,
        checksum_type: str | None = None,
        head_checksum: str | None = None,
    ) -> None:
        digest = head_digest if head_digest is not None else hashlib.sha256(content).digest()
        self.content = content
        self.head_checksum = head_checksum or base64.b64encode(digest).decode("ascii")
        self.metadata_sha256 = metadata_sha256 or hashlib.sha256(content).hexdigest()
        self.checksum_type = checksum_type
        self.head_calls: list[dict[str, object]] = []
        self.get_calls: list[dict[str, object]] = []
        self.bodies: list[FakeBody] = []

    def head_object(self, **kwargs: object) -> Mapping[str, object]:
        self.head_calls.append(dict(kwargs))
        response: dict[str, object] = {"ChecksumSHA256": self.head_checksum}
        response["Metadata"] = {"sha256": self.metadata_sha256}
        if self.checksum_type is not None:
            response["ChecksumType"] = self.checksum_type
        return response

    def get_object(self, **kwargs: object) -> Mapping[str, object]:
        self.get_calls.append(dict(kwargs))
        body = FakeBody(self.content)
        self.bodies.append(body)
        return {"Body": body}


class MalformedBodyS3(FakeS3):
    def __init__(self, content: bytes, malformed: CloseOnlyBody) -> None:
        super().__init__(content)
        self._malformed = malformed

    def get_object(self, **kwargs: object) -> Mapping[str, object]:
        self.get_calls.append(dict(kwargs))
        return {"Body": self._malformed}


class RecordingStdin:
    def __init__(self, *, break_on_write: bool = False) -> None:
        self.content = bytearray()
        self.closed = False
        self._break_on_write = break_on_write

    def write(self, chunk: bytes) -> int:
        if self._break_on_write:
            raise BrokenPipeError("simulated broken pipe")
        self.content.extend(chunk)
        return len(chunk)

    def close(self) -> None:
        self.closed = True


class FakeProcess:
    def __init__(
        self,
        *,
        return_code: int = 0,
        break_on_write: bool = False,
        stderr: bytes = b"",
    ) -> None:
        self.stdin = RecordingStdin(break_on_write=break_on_write)
        self.stderr = io.BytesIO(stderr)
        self.return_code = return_code
        self.wait_calls = 0
        self.terminate_calls = 0
        self.kill_calls = 0

    def wait(self, timeout: float | None = None) -> int:
        del timeout
        self.wait_calls += 1
        return self.return_code

    def poll(self) -> int | None:
        return self.return_code if self.wait_calls else None

    def terminate(self) -> None:
        self.terminate_calls += 1

    def kill(self) -> None:
        self.kill_calls += 1


@dataclass(frozen=True, slots=True)
class ProcessCall:
    argv: tuple[str, ...]
    shell: bool
    env: Mapping[str, str]
    config_path: Path
    config_mode: int
    config_content: str
    process: FakeProcess


class FakeProcessFactory:
    def __init__(
        self,
        *,
        return_codes: Sequence[int] = (0,),
        break_on_write: Sequence[bool] = (False,),
        stderr: bytes = b"",
    ) -> None:
        self._return_codes = tuple(return_codes)
        self._break_on_write = tuple(break_on_write)
        self._stderr = stderr
        self.calls: list[ProcessCall] = []

    def __call__(
        self,
        argv: Sequence[str],
        *,
        stdin: int,
        stdout: int,
        stderr: int,
        shell: bool,
        env: Mapping[str, str],
    ) -> FakeProcess:
        assert stdin == subprocess.PIPE
        assert stdout == subprocess.DEVNULL
        assert stderr == subprocess.PIPE
        index = len(self.calls)
        option = argv[1]
        assert option.startswith("--defaults-extra-file=")
        config_path = Path(option.partition("=")[2])
        process = FakeProcess(
            return_code=self._return_codes[min(index, len(self._return_codes) - 1)],
            break_on_write=self._break_on_write[min(index, len(self._break_on_write) - 1)],
            stderr=self._stderr.replace(b"{config_path}", os.fsencode(config_path)),
        )
        self.calls.append(
            ProcessCall(
                tuple(argv),
                shell,
                dict(env),
                config_path,
                config_path.stat().st_mode & 0o777,
                config_path.read_text(encoding="utf-8"),
                process,
            )
        )
        return process


def gzipped_sql(sql: bytes = SQL) -> bytes:
    return gzip.compress(sql, mtime=0)


def request_for(content: bytes, *, key: str = "argus/dump.sql.gz") -> RestoreRequest:
    return RestoreRequest(
        "ingestion-bucket",
        key,
        "snapshot-version-1",
        hashlib.sha256(content).hexdigest(),
    )


def settings(password: str = "secret password #1") -> MySqlConnectionSettings:
    return MySqlConnectionSettings("127.0.0.1", 3306, "root", password, "argus")


def restorer(
    s3: FakeS3,
    process_factory: FakeProcessFactory,
    *,
    mysql_settings: MySqlConnectionSettings | None = None,
    chunk_size: int = 1024 * 1024,
) -> MySqlSnapshotRestorer:
    return MySqlSnapshotRestorer(
        s3,
        mysql_settings or settings(),
        process_factory=process_factory,
        chunk_size=chunk_size,
    )


def test_restore_rejects_head_checksum_before_get_or_mysql_spawn() -> None:
    content = gzipped_sql()
    s3 = FakeS3(content, head_digest=b"different".ljust(32, b"!"))
    processes = FakeProcessFactory()

    with pytest.raises(SnapshotChecksumMismatch, match="metadata"):
        restorer(s3, processes).restore(request_for(content), idempotency_key="restore-1")

    assert s3.get_calls == []
    assert processes.calls == []


def test_restore_accepts_multipart_composite_checksum_only_with_matching_full_hash_metadata() -> (
    None
):
    content = gzipped_sql()
    expected = hashlib.sha256(content).hexdigest()
    s3 = FakeS3(
        content,
        metadata_sha256=expected,
        checksum_type="COMPOSITE",
        head_checksum="multipart-composite-checksum-2",
    )
    processes = FakeProcessFactory()

    result = restorer(s3, processes).restore(request_for(content), idempotency_key="restore-1")

    assert result.compressed_sha256 == expected
    assert len(processes.calls) == 1


def test_restore_closes_malformed_body_before_rejecting_it() -> None:
    content = gzipped_sql()
    malformed = CloseOnlyBody()
    s3 = MalformedBodyS3(content, malformed)
    processes = FakeProcessFactory()

    with pytest.raises(SnapshotRestoreError, match="streaming body"):
        restorer(s3, processes).restore(request_for(content), idempotency_key="restore-1")

    assert malformed.closed
    assert processes.calls == []


def test_restore_streams_compressed_object_to_mysql_with_private_option_file() -> None:
    content = gzipped_sql()
    s3 = FakeS3(content)
    processes = FakeProcessFactory()
    secret = "secret password #1"
    previous_mysql_pwd = os.environ.get("MYSQL_PWD")
    os.environ["MYSQL_PWD"] = "must-not-be-inherited"
    try:
        result = restorer(s3, processes, mysql_settings=settings(secret)).restore(
            request_for(content), idempotency_key="restore-1"
        )
    finally:
        if previous_mysql_pwd is None:
            os.environ.pop("MYSQL_PWD", None)
        else:
            os.environ["MYSQL_PWD"] = previous_mysql_pwd

    assert result.compressed_sha256 == hashlib.sha256(content).hexdigest()
    assert result.compressed_bytes == len(content)
    assert s3.head_calls == [
        {
            "Bucket": "ingestion-bucket",
            "Key": "argus/dump.sql.gz",
            "VersionId": "snapshot-version-1",
            "ChecksumMode": "ENABLED",
        }
    ]
    assert s3.get_calls == s3.head_calls
    assert s3.bodies[0].closed

    call = processes.calls[0]
    assert call.argv[0] == "mysql"
    assert call.argv[1].startswith("--defaults-extra-file=")
    assert call.argv[2:] == ("--binary-mode=1",)
    assert call.shell is False
    assert "MYSQL_PWD" not in call.env
    assert secret not in " ".join(call.argv)
    assert secret not in repr(call.env)
    assert call.config_mode == 0o600
    assert "[client]" in call.config_content
    assert 'password="secret password #1"' in call.config_content
    assert bytes(call.process.stdin.content) == SQL
    assert call.process.stdin.closed
    assert call.process.wait_calls == 1
    assert not call.config_path.exists()


def test_restore_hashes_all_compressed_bytes_and_releases_failed_key() -> None:
    expected = gzipped_sql()
    streamed = gzipped_sql(SQL + b"-- changed after metadata was recorded\n")
    s3 = FakeS3(
        streamed,
        head_digest=hashlib.sha256(expected).digest(),
        metadata_sha256=hashlib.sha256(expected).hexdigest(),
    )
    processes = FakeProcessFactory(return_codes=(0, 0))
    snapshot_restorer = restorer(s3, processes)
    request = request_for(expected)

    with pytest.raises(SnapshotChecksumMismatch, match="stream"):
        snapshot_restorer.restore(request, idempotency_key="retryable")

    assert s3.bodies[0].closed
    assert processes.calls[0].process.stdin.closed
    assert processes.calls[0].process.wait_calls == 1

    s3.content = expected
    result = snapshot_restorer.restore(request, idempotency_key="retryable")
    assert result.compressed_sha256 == hashlib.sha256(expected).hexdigest()
    assert len(processes.calls) == 2


def test_restore_rejects_zero_compressed_bytes_without_reserving_key() -> None:
    empty = b""
    s3 = FakeS3(empty)
    processes = FakeProcessFactory(return_codes=(0, 0))
    snapshot_restorer = restorer(s3, processes)

    with pytest.raises(SnapshotRestoreError, match="gzip"):
        snapshot_restorer.restore(request_for(empty), idempotency_key="retryable")

    valid_empty_gzip = gzipped_sql(b"")
    s3.content = valid_empty_gzip
    s3.head_checksum = base64.b64encode(hashlib.sha256(valid_empty_gzip).digest()).decode("ascii")
    s3.metadata_sha256 = hashlib.sha256(valid_empty_gzip).hexdigest()
    result = snapshot_restorer.restore(request_for(valid_empty_gzip), idempotency_key="retryable")
    assert result.compressed_bytes == len(valid_empty_gzip)
    assert len(processes.calls) == 2
    assert bytes(processes.calls[1].process.stdin.content) == b""


def test_successful_restore_is_idempotent_and_conflicting_request_is_rejected() -> None:
    content = gzipped_sql()
    s3 = FakeS3(content)
    processes = FakeProcessFactory()
    snapshot_restorer = restorer(s3, processes)
    request = request_for(content)

    first = snapshot_restorer.restore(request, idempotency_key="stable-key")
    repeated = snapshot_restorer.restore(request, idempotency_key="stable-key")

    assert repeated is first
    assert len(s3.get_calls) == 1
    assert len(processes.calls) == 1
    with pytest.raises(IdempotencyConflict, match="different input"):
        snapshot_restorer.restore(
            request_for(content, key="argus/other.sql.gz"), idempotency_key="stable-key"
        )
    assert len(processes.calls) == 1


def test_mysql_failure_sanitizes_and_limits_stderr_then_allows_retry() -> None:
    content = gzipped_sql()
    s3 = FakeS3(content)
    secret = "credential-marker"
    stderr = b"{config_path}: " + secret.encode() + b"!" * 12_000
    processes = FakeProcessFactory(return_codes=(7, 0), stderr=stderr)
    snapshot_restorer = restorer(s3, processes, mysql_settings=settings(secret))

    with pytest.raises(SnapshotRestoreError) as captured:
        snapshot_restorer.restore(request_for(content), idempotency_key="retryable")

    message = str(captured.value)
    first_call = processes.calls[0]
    assert secret not in message
    assert str(first_call.config_path) not in message
    assert len(message.encode("utf-8")) <= 8 * 1024
    assert first_call.process.stdin.closed
    assert first_call.process.wait_calls == 1
    assert s3.bodies[0].closed
    assert not first_call.config_path.exists()

    processes._stderr = b""
    assert snapshot_restorer.restore(
        request_for(content), idempotency_key="retryable"
    ).compressed_bytes == len(content)


def test_broken_pipe_preserves_cause_and_reaps_process_without_reserving_key() -> None:
    content = gzipped_sql(SQL * 4)
    s3 = FakeS3(content)
    processes = FakeProcessFactory(
        return_codes=(9, 0),
        break_on_write=(True, False),
        stderr=b"mysql rejected input",
    )
    snapshot_restorer = restorer(s3, processes, chunk_size=8)

    with pytest.raises(SnapshotRestoreError) as captured:
        snapshot_restorer.restore(request_for(content), idempotency_key="retryable")

    first_process = processes.calls[0].process
    assert isinstance(captured.value.__cause__, BrokenPipeError)
    assert first_process.stdin.closed
    assert first_process.terminate_calls == 1
    assert first_process.wait_calls >= 1
    assert s3.bodies[0].closed

    result = snapshot_restorer.restore(request_for(content), idempotency_key="retryable")
    assert result.compressed_bytes == len(content)


def test_restore_rejects_empty_idempotency_key_before_touching_s3() -> None:
    content = gzipped_sql()
    s3 = FakeS3(content)
    processes = FakeProcessFactory()

    with pytest.raises(ValueError, match="idempotency_key"):
        restorer(s3, processes).restore(request_for(content), idempotency_key="")

    assert s3.head_calls == []
    assert processes.calls == []
