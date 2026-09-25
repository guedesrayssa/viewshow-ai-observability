"""Pinned-version downloads reject mismatches and stream within the input ceiling."""

import gzip
import importlib
import io

import pytest

from scripts.upload_snapshot import SnapshotUploadError


class S3:
    def __init__(self, data=b"dump", head_size=4, head_version="v1", get_version="v1"):
        self.body = io.BytesIO(data)
        self.head_size, self.head_version, self.get_version = head_size, head_version, get_version
        self.calls = []
        self.checksum = "ZaVr0TDKqXAbP/p1W9Cyv28pqc89B+Z3qZS9CI6Ua2Q=-1"
        self.head_overrides = {}
        self.get_overrides = {}

    def head_object(self, **kwargs):
        self.calls.append(("head", kwargs))
        return {
            "ContentLength": self.head_size,
            "VersionId": self.head_version,
            "ChecksumSHA256": self.checksum,
            "ChecksumType": "COMPOSITE",
            **self.head_overrides,
        }

    def get_object(self, **kwargs):
        self.calls.append(("get", kwargs))
        return {
            "ContentLength": self.head_size,
            "VersionId": self.get_version,
            "Body": self.body,
            "ChecksumSHA256": self.checksum,
            "ChecksumType": "COMPOSITE",
            **self.get_overrides,
        }


def adapter(s3):
    try:
        module = importlib.import_module("adapters.sources.staging_download")
    except ModuleNotFoundError:
        pytest.fail("pinned staging downloader is missing")
    return module.S3StagingDownloader(s3, expected_bucket_owner="123456789012")


def download(s3, path, *, size=4, part_size=16 * 1024**2, count=1, version="v1"):
    adapter(s3).download(
        "uploads",
        "staging/source",
        path,
        version_id=version,
        expected_size=size,
        part_size_bytes=part_size,
        expected_part_count=count,
    )


def test_head_and_get_pin_version_owner_and_request_checksums(tmp_path):
    s3 = S3()
    path = tmp_path / "source.sql.gz"
    download(s3, path)
    assert path.read_bytes() == b"dump"
    assert path.stat().st_mode & 0o777 == 0o600
    assert s3.body.closed
    for operation, request in s3.calls:
        assert operation in {"head", "get"}
        assert request == {
            "Bucket": "uploads",
            "Key": "staging/source",
            "VersionId": "v1",
            "ExpectedBucketOwner": "123456789012",
            "ChecksumMode": "ENABLED",
        }


@pytest.mark.parametrize(
    "kwargs",
    [
        {"head_size": 3},
        {"head_version": "v2"},
        {"get_version": "v2"},
        {"data": b"abc"},
        {"data": b"abcde"},
    ],
)
def test_size_and_version_mismatches_never_leave_downloaded_data(tmp_path, kwargs):
    s3 = S3(**kwargs)
    path = tmp_path / "source.sql.gz"
    with pytest.raises(SnapshotUploadError):
        download(s3, path)
    assert not path.exists()
    if any(operation == "get" for operation, _ in s3.calls):
        assert s3.body.closed


@pytest.mark.parametrize("version,size", [("null", 4), ("", 4), ("v1", 10 * 1024**3 + 1)])
def test_invalid_identity_and_oversize_fail_before_s3(tmp_path, version, size):
    s3 = S3()
    with pytest.raises(SnapshotUploadError):
        download(s3, tmp_path / "dump", version=version, size=size)
    assert not s3.calls


def test_rejects_a_different_valid_gzip_of_same_size_using_the_composite_checksum(tmp_path):
    body = gzip.compress(b"SELECT 2;", mtime=0)
    assert len(body) == 29
    s3 = S3(body, head_size=29)
    # Independent fixed checksum for gzip(SELECT 1;) with mtime=0, uploaded in one part.
    s3.checksum = "cgROcfh78LYGeX16+ZseQ6cXKMUMkHLN+NtzU87OFT4=-1"
    path = tmp_path / "dump.sql.gz"
    with pytest.raises(SnapshotUploadError, match="checksum"):
        download(s3, path, size=29)
    assert not path.exists() and s3.body.closed


@pytest.mark.parametrize(
    "checksum",
    [
        None,
        "",
        "invalid-1",
        "ZaVr0TDKqXAbP/p1W9Cyv28pqc89B+Z3qZS9CI6Ua2Q=",
        "ZaVr0TDKqXAbP/p1W9Cyv28pqc89B+Z3qZS9CI6Ua2Q=-0",
        "ZaVr0TDKqXAbP/p1W9Cyv28pqc89B+Z3qZS9CI6Ua2Q=-01",
        "ZaVr0TDKqXAbP/p1W9Cyv28pqc89B+Z3qZS9CI6Ua2Q=-2",
        "ZaVr0TDKqXAbP/p1W9Cyv28pqc89B+Z3qZS9CI6Ua2R=-1",
    ],
)
def test_missing_malformed_or_incompatible_checksum_fails_closed(tmp_path, checksum):
    s3 = S3()
    s3.checksum = checksum
    path = tmp_path / "dump.sql.gz"
    with pytest.raises(SnapshotUploadError, match="checksum"):
        download(s3, path)
    assert not path.exists()


@pytest.mark.parametrize(
    "field,value",
    [
        ("ChecksumType", "FULL_OBJECT"),
        ("ChecksumType", None),
        ("PartsCount", 2),
        ("PartsCount", True),
        ("ChecksumSHA256", "cgROcfh78LYGeX16+ZseQ6cXKMUMkHLN+NtzU87OFT4=-1"),
    ],
)
def test_head_and_get_must_agree_on_composite_evidence(tmp_path, field, value):
    s3 = S3()
    s3.get_overrides[field] = value
    path = tmp_path / "dump.sql.gz"
    with pytest.raises(SnapshotUploadError, match="checksum"):
        download(s3, path)
    assert not path.exists() and s3.body.closed


@pytest.mark.parametrize("short_reads", [False, True])
def test_composite_checksum_obeys_part_boundaries_and_short_final_part(tmp_path, short_reads):
    s3 = S3(b"abcdefghij", head_size=10)
    s3.checksum = "Obym+jYZ9n7k1vjfUUkVWFYPQpkgWT9/ZJEZuj8oXtk=-3"
    reads = []
    original = s3.body.read

    def read(amount):
        assert 0 < amount <= 1024 * 1024
        reads.append(amount)
        return original(min(amount, 2) if short_reads else amount)

    s3.body.read = read
    path = tmp_path / "dump"
    download(s3, path, size=10, part_size=4, count=3)
    assert path.read_bytes() == b"abcdefghij" and s3.body.closed
    assert len(reads) >= 4


def test_composite_rejects_correct_bytes_hashed_with_different_part_boundaries(tmp_path):
    s3 = S3(b"abcdefghij", head_size=10)
    s3.checksum = "KYVePWA7ioU8sF6InP5auYGeXLHvAE8VgBiiwqy5gxY=-3"
    path = tmp_path / "dump"
    with pytest.raises(SnapshotUploadError, match="checksum"):
        download(s3, path, size=10, part_size=4, count=3)
    assert not path.exists()


@pytest.mark.parametrize(
    "part_size,count", [(None, 1), (0, 1), (True, 1), (4, None), (4, 2), (4, 10001), (4, True)]
)
def test_unknown_or_invalid_part_geometry_fails_before_s3(tmp_path, part_size, count):
    s3 = S3()
    with pytest.raises(SnapshotUploadError):
        download(s3, tmp_path / "dump", part_size=part_size, count=count)
    assert s3.calls == []


def test_large_parts_are_hashed_with_bounded_reads_instead_of_materializing_a_part(tmp_path):
    total = 2 * 1024**2 + 3

    class BoundedBody:
        remaining = total
        closed = False

        def read(self, amount):
            assert 0 < amount <= 1024**2
            count = min(amount, self.remaining)
            self.remaining -= count
            return bytes(count)

        def close(self):
            self.closed = True

    s3 = S3(head_size=total)
    s3.body = BoundedBody()
    s3.checksum = "Z41mHJL0HXGkHix8LYABE0haBsFAjSYtMCEnTakGzhI=-2"
    path = tmp_path / "dump"
    download(s3, path, size=total, part_size=1024**2 + 2, count=2)
    assert path.stat().st_size == total and s3.body.closed
