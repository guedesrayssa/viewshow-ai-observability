"""Verify snapshot upload/build safeguards for Kubernetes operations."""

from __future__ import annotations

import base64
import gzip
import hashlib
import os
import stat
import threading
import time
import zipfile
from collections.abc import Callable, Mapping
from datetime import date
from pathlib import Path

import pytest

from scripts import upload_snapshot as upload_module
from scripts.upload_snapshot import SnapshotUploadError, upload_snapshot

ACCOUNT_ID = "999999999999"

REGION = "us-east-1"

SNAPSHOT_EXTRACTED_ON = date(2026, 8, 31)

BUCKET = f"view-show-ingestion-{ACCOUNT_ID}-{REGION}"


class FakeS3:
    def __init__(self) -> None:
        self.created: dict[str, object] | None = None
        self.parts: list[dict[str, object]] = []
        self.completed: dict[str, object] | None = None
        self.aborted = False

    def get_bucket_versioning(self, **kwargs: object) -> Mapping[str, object]:
        assert kwargs["ExpectedBucketOwner"] == ACCOUNT_ID
        return {"Status": "Enabled"}

    def create_multipart_upload(self, **kwargs: object) -> Mapping[str, object]:
        self.created = dict(kwargs)
        return {"UploadId": "upload-1"}

    def upload_part(self, **kwargs: object) -> Mapping[str, object]:
        self.parts.append(dict(kwargs))
        return {
            "ETag": f'"part-{kwargs["PartNumber"]}"',
            "ChecksumSHA256": kwargs["ChecksumSHA256"],
        }

    def complete_multipart_upload(self, **kwargs: object) -> Mapping[str, object]:
        self.completed = dict(kwargs)
        return {"VersionId": "version-123"}

    def head_object(self, **kwargs: object) -> Mapping[str, object]:
        assert kwargs["VersionId"] == "version-123"
        assert self.created is not None
        assert self.completed is not None
        digests = [
            base64.b64decode(str(part["ChecksumSHA256"]), validate=True) for part in self.parts
        ]
        composite = base64.b64encode(hashlib.sha256(b"".join(digests)).digest()).decode("ascii")
        return {
            "ContentLength": sum(len(part["Body"]) for part in self.parts),
            "Metadata": self.created["Metadata"],
            "ChecksumType": "COMPOSITE",
            "ChecksumSHA256": f"{composite}-{len(digests)}",
        }

    def abort_multipart_upload(self, **kwargs: object) -> None:
        self.aborted = True


class BrokenPartS3(FakeS3):
    def upload_part(self, **kwargs: object) -> Mapping[str, object]:
        response = dict(super().upload_part(**kwargs))
        response["ChecksumSHA256"] = "wrong-checksum"
        return response


class ConditionalCheckFailed(Exception):
    def __init__(self) -> None:
        self.response: Mapping[str, object] = {"Error": {"Code": "ConditionalCheckFailedException"}}


def _gzip_sql() -> bytes:
    return gzip.compress(b"CREATE TABLE signal_bucket (id BIGINT PRIMARY KEY);\n", mtime=0)


class ManualClock:
    def __init__(self, value: float) -> None:
        self._value = value
        self._lock = threading.Lock()

    def __call__(self) -> float:
        with self._lock:
            return self._value

    def advance(self, seconds: float) -> None:
        with self._lock:
            self._value += seconds


def _wait_until(condition: Callable[[], bool]) -> None:
    deadline = time.monotonic() + 2
    while not condition():
        if time.monotonic() >= deadline:
            raise AssertionError("timed out waiting for condition")
        time.sleep(0.01)


def test_upload_streams_gzip_bytes_to_versioned_multipart_s3(tmp_path: Path) -> None:
    source = tmp_path / "argus_dump.sql.gz"
    compressed = _gzip_sql()
    source.write_bytes(compressed)
    s3 = FakeS3()

    result = upload_snapshot(
        s3,
        source,
        bucket=BUCKET,
        expected_bucket_owner=ACCOUNT_ID,
        snapshot_extracted_on=SNAPSHOT_EXTRACTED_ON,
        part_size=5 * 1024 * 1024,
    )

    assert result.version_id == "version-123"
    assert result.sha256 == hashlib.sha256(compressed).hexdigest()
    assert result.key == f"dumps/{result.sha256}/argus_dump.sql.gz"
    assert result.size == len(compressed)
    assert result.to_public_dict()["snapshotExtractedOn"] == "2026-08-31"
    assert s3.created is not None
    assert s3.created["ChecksumAlgorithm"] == "SHA256"
    assert s3.created["Metadata"] == {"sha256": result.sha256}
    assert s3.completed is not None
    assert s3.completed["ChecksumType"] == "COMPOSITE"
    assert not s3.aborted


def test_upload_rejects_nested_member_and_sidecar_before_s3(tmp_path: Path) -> None:
    source = tmp_path / "argus.zip"
    compressed = _gzip_sql()
    with zipfile.ZipFile(source, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("safe/argus_dump.sql.gz", compressed)
        archive.writestr("readme.txt", b"sidecar metadata", compress_type=zipfile.ZIP_BZIP2)

    s3 = FakeS3()
    with pytest.raises(SnapshotUploadError, match="exactly one root member"):
        upload_snapshot(
            s3,
            source,
            bucket=BUCKET,
            expected_bucket_owner=ACCOUNT_ID,
            snapshot_extracted_on=SNAPSHOT_EXTRACTED_ON,
            part_size=5 * 1024 * 1024,
        )
    assert s3.created is None


def test_upload_rejects_duplicate_zip_basename_before_s3_mutation(tmp_path: Path) -> None:
    source = tmp_path / "ambiguous.zip"
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("one/argus_dump.sql.gz", _gzip_sql())
        archive.writestr("two/argus_dump.sql.gz", _gzip_sql())
    s3 = FakeS3()

    with pytest.raises(SnapshotUploadError, match="exactly one"):
        upload_snapshot(
            s3,
            source,
            bucket=BUCKET,
            expected_bucket_owner=ACCOUNT_ID,
            snapshot_extracted_on=SNAPSHOT_EXTRACTED_ON,
        )

    assert s3.created is None


def test_upload_rejects_traversal_member_before_s3_mutation(tmp_path: Path) -> None:
    source = tmp_path / "traversal.zip"
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("../argus_dump.sql.gz", _gzip_sql())
    s3 = FakeS3()

    with pytest.raises(SnapshotUploadError, match="path is not safe"):
        upload_snapshot(
            s3,
            source,
            bucket=BUCKET,
            expected_bucket_owner=ACCOUNT_ID,
            snapshot_extracted_on=SNAPSHOT_EXTRACTED_ON,
        )

    assert s3.created is None


@pytest.mark.parametrize("file_type", [stat.S_IFLNK, stat.S_IFCHR])
def test_upload_rejects_special_zip_members_even_without_unix_creator(
    tmp_path: Path, file_type: int
) -> None:
    source = tmp_path / "special-member.zip"
    member = zipfile.ZipInfo("argus_dump.sql.gz")
    member.create_system = 0
    member.external_attr = (file_type | 0o600) << 16
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr(member, _gzip_sql())
    s3 = FakeS3()

    with pytest.raises(SnapshotUploadError, match="regular file"):
        upload_snapshot(
            s3,
            source,
            bucket=BUCKET,
            expected_bucket_owner=ACCOUNT_ID,
            snapshot_extracted_on=SNAPSHOT_EXTRACTED_ON,
        )

    assert s3.created is None


def test_upload_enforces_configurable_zip_and_gzip_bomb_limits(tmp_path: Path) -> None:
    compressed = gzip.compress(b"x" * 4_096, mtime=0)
    direct = tmp_path / "argus_dump.sql.gz"
    direct.write_bytes(compressed)
    packaged = tmp_path / "argus.zip"
    with zipfile.ZipFile(packaged, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("argus_dump.sql.gz", compressed)
    limits = upload_module.UploadLimits(
        max_input_bytes=1_000_000,
        max_gzip_bytes=1_000_000,
        max_sql_bytes=100,
        max_zip_expansion_ratio=1,
    )

    with pytest.raises(SnapshotUploadError, match="gzip SQL payload"):
        upload_snapshot(
            FakeS3(),
            direct,
            bucket=BUCKET,
            expected_bucket_owner=ACCOUNT_ID,
            snapshot_extracted_on=SNAPSHOT_EXTRACTED_ON,
            limits=limits,
        )
    with pytest.raises(SnapshotUploadError, match="expansion ratio"):
        upload_snapshot(
            FakeS3(),
            packaged,
            bucket=BUCKET,
            expected_bucket_owner=ACCOUNT_ID,
            snapshot_extracted_on=SNAPSHOT_EXTRACTED_ON,
            limits=limits,
        )


@pytest.mark.parametrize("corruption", ["truncated", "bad-crc"])
def test_upload_rejects_incomplete_or_crc_corrupt_gzip_before_s3(
    tmp_path: Path, corruption: str
) -> None:
    source = tmp_path / "argus_dump.sql.gz"
    compressed = bytearray(_gzip_sql())
    if corruption == "truncated":
        source.write_bytes(compressed[:-4])
    else:
        compressed[-1] ^= 0xFF
        source.write_bytes(compressed)
    s3 = FakeS3()

    with pytest.raises(SnapshotUploadError, match="complete valid gzip"):
        upload_snapshot(
            s3,
            source,
            bucket=BUCKET,
            expected_bucket_owner=ACCOUNT_ID,
            snapshot_extracted_on=SNAPSHOT_EXTRACTED_ON,
        )

    assert s3.created is None


def test_upload_stages_compressed_snapshot_before_upload_to_close_toctou(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "argus_dump.sql.gz"
    original = _gzip_sql()
    source.write_bytes(original)
    s3 = FakeS3()
    copy_to_staging = upload_module._copy_to_staging

    def mutate_source_after_copy(*args: object, **kwargs: object) -> tuple[str, int]:
        result = copy_to_staging(*args, **kwargs)
        source.write_bytes(gzip.compress(b"changed after staging", mtime=0))
        return result

    monkeypatch.setattr(upload_module, "_copy_to_staging", mutate_source_after_copy)

    result = upload_snapshot(
        s3,
        source,
        bucket=BUCKET,
        expected_bucket_owner=ACCOUNT_ID,
        snapshot_extracted_on=SNAPSHOT_EXTRACTED_ON,
        part_size=5 * 1024 * 1024,
    )

    assert result.sha256 == hashlib.sha256(original).hexdigest()
    assert b"".join(part["Body"] for part in s3.parts) == original


def test_upload_staging_file_is_private_and_cleaned_up(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "argus_dump.sql.gz"
    source.write_bytes(_gzip_sql())
    monkeypatch.setattr(upload_module.tempfile, "tempdir", str(tmp_path))
    multipart_upload = upload_module._upload_multipart

    def inspect_private_staging(*args: object, **kwargs: object) -> object:
        stream = args[1]
        assert hasattr(stream, "fileno")
        assert stat.S_IMODE(os.fstat(stream.fileno()).st_mode) == 0o600
        return multipart_upload(*args, **kwargs)

    monkeypatch.setattr(upload_module, "_upload_multipart", inspect_private_staging)

    upload_snapshot(
        FakeS3(),
        source,
        bucket=BUCKET,
        expected_bucket_owner=ACCOUNT_ID,
        snapshot_extracted_on=SNAPSHOT_EXTRACTED_ON,
        part_size=5 * 1024 * 1024,
    )

    assert list(tmp_path.glob("argus-snapshot-*.sql.gz")) == []


def test_upload_aborts_unconfirmed_multipart_upload(tmp_path: Path) -> None:
    source = tmp_path / "argus_dump.sql.gz"
    source.write_bytes(_gzip_sql())
    s3 = BrokenPartS3()

    with pytest.raises(SnapshotUploadError, match="part confirmation"):
        upload_snapshot(
            s3,
            source,
            bucket=BUCKET,
            expected_bucket_owner=ACCOUNT_ID,
            snapshot_extracted_on=SNAPSHOT_EXTRACTED_ON,
            part_size=5 * 1024 * 1024,
        )

    assert s3.aborted is True


def test_reduced_snapshot_is_the_schema_and_the_fixture_the_suite_already_proves(
    tmp_path: Path,
) -> None:
    """O dump reduzido não inventa dado: ele é a junção de dois arquivos já provados.

    db_schema.sql é o mesmo cujo casamento com os 23 descriptors é garantido por
    test_every_descriptor_matches_the_reduced_official_schema, e
    argus_v2_minimal.sql é o mesmo que o docker-compose.test.yml monta como init
    do MySQL para os testes de integração. O par já é um banco mínimo que
    funciona; o gerador só o torna um artefato restaurável.

    A ordem importa: o fixture faz ALTER TABLE ... ADD PARTITION, que exige as
    tabelas criadas antes.
    """
    from scripts.build_reduced_snapshot import build_reduced_snapshot

    schema = tmp_path / "schema.sql"
    fixture = tmp_path / "fixture.sql"
    schema.write_text("CREATE TABLE alpha (id BIGINT NOT NULL);\n", encoding="utf-8")
    fixture.write_text("INSERT INTO alpha (id) VALUES (1);\n", encoding="utf-8")
    output = tmp_path / "reduced.sql.gz"

    result = build_reduced_snapshot(schema, fixture, output)

    sql = gzip.decompress(output.read_bytes()).decode("utf-8")
    assert sql.index("CREATE TABLE alpha") < sql.index("INSERT INTO alpha")
    assert result.sha256 == hashlib.sha256(output.read_bytes()).hexdigest()
    assert result.compressed_bytes == output.stat().st_size
    assert result.tables == 1


def test_reduced_snapshot_is_byte_identical_across_runs(tmp_path: Path) -> None:
    """Gerar duas vezes tem de dar o mesmo sha, ou o upload deixa de ser idempotente.

    A chave no S3 é dumps/<sha>/argus_dump.sql.gz. Se o gerador embutisse o
    horário — que é o padrão do gzip — cada execução criaria um objeto novo e um
    dataset_version novo, e repetir o fluxo deixaria lixo acumulado no bucket.
    """
    from scripts.build_reduced_snapshot import build_reduced_snapshot

    schema = tmp_path / "schema.sql"
    fixture = tmp_path / "fixture.sql"
    schema.write_text("CREATE TABLE alpha (id BIGINT NOT NULL);\n", encoding="utf-8")
    fixture.write_text("INSERT INTO alpha (id) VALUES (1);\n", encoding="utf-8")

    primeira = build_reduced_snapshot(schema, fixture, tmp_path / "a.sql.gz")
    segunda = build_reduced_snapshot(schema, fixture, tmp_path / "b.sql.gz")

    assert primeira.sha256 == segunda.sha256
    assert (tmp_path / "a.sql.gz").read_bytes() == (tmp_path / "b.sql.gz").read_bytes()


def test_reduced_snapshot_refuses_a_schema_without_tables(tmp_path: Path) -> None:
    from scripts.build_reduced_snapshot import ReducedSnapshotError, build_reduced_snapshot

    schema = tmp_path / "schema.sql"
    fixture = tmp_path / "fixture.sql"
    schema.write_text("-- sem nenhuma tabela\n", encoding="utf-8")
    fixture.write_text("INSERT INTO alpha (id) VALUES (1);\n", encoding="utf-8")

    with pytest.raises(ReducedSnapshotError, match="CREATE TABLE"):
        build_reduced_snapshot(schema, fixture, tmp_path / "out.sql.gz")
