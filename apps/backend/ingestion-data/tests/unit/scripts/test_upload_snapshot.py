"""The upload contract requires one exact root member before S3 mutations."""

import gzip
import io
import stat
import zipfile
from datetime import date
from pathlib import Path

import pytest

from scripts.upload_snapshot import (
    DEFAULT_UPLOAD_LIMITS,
    SnapshotUploadError,
    _safe_zip_member,
    upload_snapshot,
)
from tests.ci.test_operational_scripts import ACCOUNT_ID, BUCKET, FakeS3


def test_promotion_uses_requested_workdir_and_cleans_it(tmp_path, monkeypatch):
    import scripts.upload_snapshot as module

    source = tmp_path / "source.sql.gz"
    source.write_bytes(gzip.compress(b"SELECT 1;"))
    workdir = tmp_path / "work"
    workdir.mkdir()
    mkstemp = module.tempfile.mkstemp
    seen = []

    def observed_temp(*args, **kwargs):
        assert kwargs["dir"] == workdir
        seen.append(kwargs["dir"])
        return mkstemp(*args, **kwargs)

    monkeypatch.setattr(module.tempfile, "mkstemp", observed_temp)
    upload_snapshot(
        FakeS3(),
        source,
        bucket=BUCKET,
        expected_bucket_owner=ACCOUNT_ID,
        snapshot_extracted_on=date(2026, 9, 17),
        staging_directory=workdir,
    )
    assert seen == [workdir]
    assert list(workdir.iterdir()) == []


@pytest.mark.parametrize(
    "names",
    [
        ["argus_dump.sql.gz", "notes.txt"],
        ["argus_dump.sql.gz", "directory/"],
        ["nested/argus_dump.sql.gz"],
        ["./argus_dump.sql.gz"],
        ["argus_dump.sql.gz/"],
        [],
    ],
)
def test_rejects_noncanonical_zip_before_s3(tmp_path: Path, names: list[str]) -> None:
    source = tmp_path / "dump.zip"
    with zipfile.ZipFile(source, "w") as archive:
        for name in names:
            archive.writestr(name, gzip.compress(b"SELECT 1;"))
    s3 = FakeS3()
    with pytest.raises(SnapshotUploadError, match="exactly one root member"):
        upload_snapshot(
            s3,
            source,
            bucket=BUCKET,
            expected_bucket_owner=ACCOUNT_ID,
            snapshot_extracted_on=date(2026, 9, 17),
        )
    assert s3.created is None


@pytest.mark.parametrize(
    ("attribute", "value", "message"),
    [
        ("external_attr", (stat.S_IFLNK | 0o777) << 16, "regular file"),
        ("flag_bits", 1, "encrypted"),
        ("compress_type", zipfile.ZIP_BZIP2, "compression method"),
        ("file_size", 5 * 1024**3 + 1, "size limit"),
        ("file_size", 10100, "expansion ratio"),
    ],
)
def test_retains_zip_security_checks(attribute: str, value: int, message: str) -> None:
    with zipfile.ZipFile(io.BytesIO(), "w") as archive:
        archive.writestr("argus_dump.sql.gz", b"x" * 100)
        setattr(archive.infolist()[0], attribute, value)
        with pytest.raises(SnapshotUploadError, match=message):
            _safe_zip_member(archive, DEFAULT_UPLOAD_LIMITS)


def test_accepts_exact_regular_root() -> None:
    with zipfile.ZipFile(io.BytesIO(), "w") as archive:
        archive.writestr("argus_dump.sql.gz", gzip.compress(b"SELECT 1;"))
        assert _safe_zip_member(archive, DEFAULT_UPLOAD_LIMITS).filename == "argus_dump.sql.gz"


def test_rejects_null_truncated_original_member_name() -> None:
    with zipfile.ZipFile(io.BytesIO(), "w") as archive:
        archive.writestr("argus_dump.sql.gz", gzip.compress(b"SELECT 1;"))
        archive.infolist()[0].orig_filename = "argus_dump.sql.gz\x00unexpected"
        with pytest.raises(SnapshotUploadError, match="exactly one root member"):
            _safe_zip_member(archive, DEFAULT_UPLOAD_LIMITS)
