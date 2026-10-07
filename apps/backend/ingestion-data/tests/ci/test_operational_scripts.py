"""Verify ingestion operational scripts preserve their execution safeguards."""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import os
import secrets
import stat
import threading
import time
import zipfile
from collections.abc import Callable, Mapping
from datetime import date
from pathlib import Path

import pytest

from scripts import upload_snapshot as upload_module
from scripts.run_task import (
    LaunchLeaseHeartbeat,
    OperationalError,
    RunTaskClients,
    RunTaskConfig,
    SnapshotEvidence,
    _acquire_launch_lease,
    _parse_arguments,
    run_task,
)
from scripts.upload_snapshot import SnapshotUploadError, upload_snapshot

# Conta deliberadamente DIFERENTE da conta real da entrega: a suíte inteira
# passa a ser prova de que nada no código de produção crava um número de
# conta. Se alguém reintroduzir o literal, estes testes caem.
ACCOUNT_ID = "999999999999"
REGION = "us-east-1"
SNAPSHOT_EXTRACTED_ON = date(2026, 8, 31)
BUCKET = f"view-show-ingestion-{ACCOUNT_ID}-{REGION}"
SNAPSHOT_SECRET_ARN = f"arn:aws:secretsmanager:{REGION}:{ACCOUNT_ID}:secret:snapshot"
BACKFILL_TASK_ARN = (
    f"arn:aws:ecs:{REGION}:{ACCOUNT_ID}:task-definition/view-show-ingestion-backfill:7"
)
SCHEDULE_ARN = (
    f"arn:aws:scheduler:{REGION}:{ACCOUNT_ID}:schedule/view-show-ingestion/view-show-ingestion-sync"
)
ECS_CLIENT_TOKEN_MAX_TTL_SECONDS = 24 * 60 * 60
ECS_CLIENT_TOKEN_POST_STOP_TTL_SECONDS = 60 * 60


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


class FakeSts:
    def get_caller_identity(self) -> Mapping[str, object]:
        return {
            "Account": ACCOUNT_ID,
            "Arn": f"arn:aws:sts::{ACCOUNT_ID}:assumed-role/voclabs/test",
        }


class FakeSecrets:
    def __init__(self) -> None:
        self.versions: dict[str, list[str]] = {}
        self.values: list[str] = []

    def describe_secret(self, **kwargs: object) -> Mapping[str, object]:
        del kwargs
        # A AWS OMITE VersionIdsToStages num segredo sem nenhuma versão, que é
        # exatamente o estado do segredo recém-provisionado: o Terraform cria o
        # segredo e nunca a versão, para a senha não tocar o state. O dublê
        # devolvia sempre um dicionário vazio, e por isso a primeira execução
        # real falhava num caminho que os testes davam como coberto.
        if not self.versions:
            return {}
        return {"VersionIdsToStages": self.versions}

    def put_secret_value(self, **kwargs: object) -> Mapping[str, object]:
        token = str(kwargs["ClientRequestToken"])
        self.values.append(str(kwargs["SecretString"]))
        self.versions[token] = ["AWSCURRENT"]
        return {"VersionId": token}


class ConditionalCheckFailed(Exception):
    def __init__(self) -> None:
        self.response: Mapping[str, object] = {"Error": {"Code": "ConditionalCheckFailedException"}}


class FakeDynamo:
    def __init__(self) -> None:
        self.items: dict[tuple[str, str], dict[str, dict[str, str]]] = {}
        self.put_calls: list[dict[str, object]] = []
        self.update_calls: list[dict[str, object]] = []
        self.delete_calls: list[dict[str, object]] = []
        self.lease_contended = threading.Event()
        self.on_delete: Callable[[], None] | None = None
        self.on_update: Callable[[], None] | None = None
        self._lock = threading.RLock()

    def put_item(self, **kwargs: object) -> Mapping[str, object]:
        item = kwargs["Item"]
        assert isinstance(item, dict)
        pk = item["pk"]
        sk = item["sk"]
        assert isinstance(pk, dict) and isinstance(sk, dict)
        key = (str(pk["S"]), str(sk["S"]))
        values = kwargs["ExpressionAttributeValues"]
        assert isinstance(values, dict)
        now = int(values[":now"]["N"])
        with self._lock:
            self.put_calls.append(dict(kwargs))
            existing = self.items.get(key)
            if existing is not None and int(existing["expiresAt"]["N"]) >= now:
                self.lease_contended.set()
                raise ConditionalCheckFailed()
            self.items[key] = item
        return {}

    def update_item(self, **kwargs: object) -> Mapping[str, object]:
        key = kwargs["Key"]
        assert isinstance(key, dict)
        pk = key["pk"]
        sk = key["sk"]
        assert isinstance(pk, dict) and isinstance(sk, dict)
        item_key = (str(pk["S"]), str(sk["S"]))
        values = kwargs["ExpressionAttributeValues"]
        assert isinstance(values, dict)
        with self._lock:
            self.update_calls.append(dict(kwargs))
            if self.on_update is not None:
                on_update = self.on_update
                self.on_update = None
                on_update()
            existing = self.items.get(item_key)
            if (
                existing is None
                or existing["owner"]["S"] != values[":owner"]["S"]
                or existing["token"]["S"] != values[":token"]["S"]
                or int(existing["expiresAt"]["N"]) <= int(values[":validAfter"]["N"])
                or int(existing["expiresAt"]["N"]) >= int(values[":expiresAt"]["N"])
            ):
                raise ConditionalCheckFailed()
            existing["expiresAt"] = {"N": str(values[":expiresAt"]["N"])}
            existing["ttl"] = {"N": str(values[":ttl"]["N"])}
        return {}

    def delete_item(self, **kwargs: object) -> Mapping[str, object]:
        key = kwargs["Key"]
        assert isinstance(key, dict)
        pk = key["pk"]
        sk = key["sk"]
        assert isinstance(pk, dict) and isinstance(sk, dict)
        item_key = (str(pk["S"]), str(sk["S"]))
        values = kwargs["ExpressionAttributeValues"]
        assert isinstance(values, dict)
        with self._lock:
            self.delete_calls.append(dict(kwargs))
            if self.on_delete is not None:
                on_delete = self.on_delete
                self.on_delete = None
                on_delete()
            existing = self.items.get(item_key)
            if (
                existing is None
                or existing["owner"]["S"] != values[":owner"]["S"]
                or existing["token"]["S"] != values[":token"]["S"]
            ):
                raise ConditionalCheckFailed()
            del self.items[item_key]
        return {}


class FakeScheduler:
    def get_schedule(self, **kwargs: object) -> Mapping[str, object]:
        assert kwargs == {"Name": "view-show-ingestion-sync", "GroupName": "view-show-ingestion"}
        return {
            "Name": "view-show-ingestion-sync",
            "GroupName": "view-show-ingestion",
            "Arn": SCHEDULE_ARN,
            "State": "DISABLED",
        }


class FakeEcs:
    def __init__(self, *, clock: Callable[[], float] = time.time) -> None:
        self.run_calls: list[dict[str, object]] = []
        self.describe_task_calls: list[dict[str, object]] = []
        self.stop_calls: list[dict[str, object]] = []
        self.tasks_by_token: dict[str, dict[str, object]] = {}
        self.tasks_by_arn: dict[str, dict[str, object]] = {}
        self.task_last_status = "RUNNING"
        self.container_statuses = {"ingestion": "RUNNING", "mysql-snapshot": "RUNNING"}
        self.clock = clock
        self._task_sequence = 0
        self.describe_started = threading.Event()
        self.release_describe = threading.Event()
        self.block_describe = False

    def _token_expired(self, task: Mapping[str, object]) -> bool:
        created_at = task["createdAt"]
        stopped_at = task["stoppedAt"]
        assert isinstance(created_at, int | float)
        expires_at = created_at + ECS_CLIENT_TOKEN_MAX_TTL_SECONDS
        if isinstance(stopped_at, int | float):
            expires_at = min(expires_at, stopped_at + ECS_CLIENT_TOKEN_POST_STOP_TTL_SECONDS)
        return self.clock() >= expires_at

    def describe_clusters(self, **kwargs: object) -> Mapping[str, object]:
        assert kwargs["clusters"] == [
            f"arn:aws:ecs:{REGION}:{ACCOUNT_ID}:cluster/view-show-iac-cluster"
        ]
        return {"clusters": [{"status": "ACTIVE"}], "failures": []}

    def describe_task_definition(self, **kwargs: object) -> Mapping[str, object]:
        assert kwargs["taskDefinition"] == BACKFILL_TASK_ARN
        return {
            "taskDefinition": {
                "status": "ACTIVE",
                "family": "view-show-ingestion-backfill",
                "requiresCompatibilities": ["FARGATE"],
                "networkMode": "awsvpc",
                "runtimePlatform": {"cpuArchitecture": "X86_64", "operatingSystemFamily": "LINUX"},
                "containerDefinitions": [
                    {
                        "name": "mysql-snapshot",
                        "essential": False,
                        # A AWS injeta portMappings normalizado mesmo quando o
                        # Terraform não declara nenhum. O dublê precisa dizer a
                        # mesma coisa que a API, ou o teste aprova um contrato
                        # que nenhuma task definition real satisfaz.
                        "portMappings": [],
                        "secrets": [
                            {
                                "name": "MYSQL_ROOT_PASSWORD",
                                "valueFrom": SNAPSHOT_SECRET_ARN,
                            }
                        ],
                    },
                    {
                        "name": "ingestion",
                        "essential": True,
                        "image": "example/data@sha256:" + "a" * 64,
                        "command": ["backfill"],
                        "dependsOn": [{"containerName": "mysql-snapshot", "condition": "HEALTHY"}],
                        "portMappings": [],
                        "secrets": [
                            {
                                "name": "MYSQL_PASSWORD",
                                "valueFrom": SNAPSHOT_SECRET_ARN,
                            }
                        ],
                    },
                ],
            }
        }

    def run_task(self, **kwargs: object) -> Mapping[str, object]:
        self.run_calls.append(dict(kwargs))
        token = kwargs["clientToken"]
        assert isinstance(token, str)
        task = self.tasks_by_token.get(token)
        if task is None or self._token_expired(task):
            self._task_sequence += 1
            suffix = "abc" if self._task_sequence == 1 else f"abc-{self._task_sequence}"
            task_arn = f"arn:aws:ecs:{REGION}:{ACCOUNT_ID}:task/{suffix}"
            now = self.clock()
            task = {
                "taskArn": task_arn,
                "lastStatus": self.task_last_status,
                "containerStatuses": dict(self.container_statuses),
                "createdAt": now,
                "stoppedAt": now if self.task_last_status == "STOPPED" else None,
            }
            self.tasks_by_token[token] = task
            self.tasks_by_arn[task_arn] = task
        return {
            "failures": [],
            "tasks": [{"taskArn": task["taskArn"]}],
        }

    def describe_tasks(self, **kwargs: object) -> Mapping[str, object]:
        self.describe_task_calls.append(dict(kwargs))
        self.describe_started.set()
        if self.block_describe:
            assert self.release_describe.wait(timeout=5)
        tasks = kwargs["tasks"]
        assert isinstance(tasks, list) and len(tasks) == 1
        task_arn = tasks[0]
        assert isinstance(task_arn, str)
        task = self.tasks_by_arn.get(task_arn)
        assert task is not None
        container_statuses = task["containerStatuses"]
        assert isinstance(container_statuses, dict)
        return {
            "failures": [],
            "tasks": [
                {
                    "taskArn": task_arn,
                    "lastStatus": task["lastStatus"],
                    "containers": [
                        {"name": name, "lastStatus": status}
                        for name, status in container_statuses.items()
                    ],
                }
            ],
        }

    def stop_task(self, **kwargs: object) -> Mapping[str, object]:
        self.stop_calls.append(dict(kwargs))
        task_arn = kwargs["task"]
        assert isinstance(task_arn, str)
        self.mark_stopped(task_arn)
        return {"task": {"taskArn": task_arn}}

    def mark_stopped(self, task_arn: str) -> None:
        task = self.tasks_by_arn.get(task_arn)
        assert task is not None
        if task["lastStatus"] != "STOPPED":
            task["stoppedAt"] = self.clock()
        task["lastStatus"] = "STOPPED"
        task["containerStatuses"] = {
            "ingestion": "STOPPED",
            "mysql-snapshot": "STOPPED",
        }


def _gzip_sql() -> bytes:
    return gzip.compress(b"CREATE TABLE signal_bucket (id BIGINT PRIMARY KEY);\n", mtime=0)


def _config() -> RunTaskConfig:
    return RunTaskConfig.from_terraform_output(
        {
            "ingestion_runbook": {
                "value": {
                    "ambiente": "learner-lab",
                    "deployment_namespace": "view-show",
                    "storage": {"bucket": BUCKET},
                    "data": {
                        "operational_table": "view-show-iac-operacional",
                        "snapshot_secret_arn": SNAPSHOT_SECRET_ARN,
                    },
                    "runtime": {
                        "cluster_arn": (
                            f"arn:aws:ecs:{REGION}:{ACCOUNT_ID}:cluster/view-show-iac-cluster"
                        ),
                        "backfill_task_arn": BACKFILL_TASK_ARN,
                        "backfill_task_family": "view-show-ingestion-backfill",
                        "security_group_id": "sg-0123456789abcdef0",
                        "subnet_ids": ["subnet-a", "subnet-b"],
                        "assign_public_ip": False,
                        "platform_version": "1.4.0",
                    },
                    "scheduler": {
                        "group_name": "view-show-ingestion",
                        "name": "view-show-ingestion-sync",
                        "schedule_arn": SCHEDULE_ARN,
                        "state": "DISABLED",
                    },
                }
            }
        }
    )


def _evidence() -> SnapshotEvidence:
    return SnapshotEvidence(
        bucket=BUCKET,
        key="dumps/" + "b" * 64 + "/argus_dump.sql.gz",
        version_id="version-123",
        sha256="b" * 64,
        size=123,
        snapshot_extracted_on=date(2026, 9, 1),
    )


def _clients(
    *, ecs_clock: Callable[[], float] = time.time
) -> tuple[RunTaskClients, FakeSecrets, FakeEcs, FakeDynamo]:
    secret = FakeSecrets()
    ecs = FakeEcs(clock=ecs_clock)
    dynamodb = FakeDynamo()
    return (
        RunTaskClients(
            sts=FakeSts(),
            secrets=secret,
            ecs=ecs,
            scheduler=FakeScheduler(),
            dynamodb=dynamodb,
        ),
        secret,
        ecs,
        dynamodb,
    )


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


def _renewal_expiries(dynamodb: FakeDynamo) -> list[int]:
    expiries: list[int] = []
    for call in dynamodb.update_calls:
        values = call["ExpressionAttributeValues"]
        assert isinstance(values, Mapping)
        expiry = values[":expiresAt"]
        assert isinstance(expiry, Mapping)
        value = expiry["N"]
        assert isinstance(value, str)
        expiries.append(int(value))
    return expiries


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


def test_run_task_rotates_secret_in_memory_and_limits_overrides() -> None:
    clients, secrets_client, ecs, dynamodb = _clients()
    sentinel = "operator-secret-sentinel"

    result = run_task(
        clients,
        _config(),
        _evidence(),
        launch_attempt="attempt-1",
        password_factory=lambda amount: sentinel if amount == 48 else secrets.token_urlsafe(amount),
    )

    assert secrets_client.values == [sentinel]
    assert sentinel not in json.dumps(result.to_public_dict())
    assert sentinel not in repr(result)
    assert result.to_public_dict()["launchAttempt"] == "attempt-1"
    assert result.to_public_dict()["runId"] == result.run_id
    assert result.run_id.startswith("backfill-")
    assert len(result.run_id) <= 64
    call = ecs.run_calls[0]
    overrides = call["overrides"]
    assert overrides == {
        "containerOverrides": [
            {
                "name": "ingestion",
                "command": ["backfill", "--run-id", result.run_id],
                "environment": [
                    {"name": "SNAPSHOT_BUCKET", "value": _evidence().bucket},
                    {"name": "SNAPSHOT_OBJECT_KEY", "value": _evidence().key},
                    {"name": "SNAPSHOT_OBJECT_VERSION_ID", "value": _evidence().version_id},
                    {"name": "SNAPSHOT_SHA256", "value": _evidence().sha256},
                    {
                        "name": "SNAPSHOT_EXTRACTED_ON",
                        "value": _evidence().snapshot_extracted_on.isoformat(),
                    },
                    {"name": "ACTIVATE_CANDIDATE", "value": "false"},
                ],
            }
        ]
    }
    assert call["platformVersion"] == "1.4.0"
    assert call["enableExecuteCommand"] is False
    assert len(str(call["clientToken"])) <= 64
    assert ecs.describe_task_calls == [
        {
            "cluster": f"arn:aws:ecs:{REGION}:{ACCOUNT_ID}:cluster/view-show-iac-cluster",
            "tasks": [f"arn:aws:ecs:{REGION}:{ACCOUNT_ID}:task/abc"],
        }
    ]
    assert dynamodb.items == {}
    assert len(dynamodb.put_calls) == len(dynamodb.delete_calls) == 1
    assert dynamodb.delete_calls[0]["ConditionExpression"] == "#owner = :owner AND #token = :token"
    assert dynamodb.delete_calls[0]["ExpressionAttributeNames"] == {
        "#owner": "owner",
        "#token": "token",
    }


def test_snapshot_evidence_requires_canonical_extraction_date() -> None:
    payload: dict[str, object] = {
        "bucket": BUCKET,
        "key": "dumps/" + "b" * 64 + "/argus_dump.sql.gz",
        "versionId": "version-123",
        "sha256": "b" * 64,
        "size": 123,
    }

    with pytest.raises(OperationalError, match="snapshotExtractedOn"):
        SnapshotEvidence.from_mapping(payload)
    with pytest.raises(OperationalError, match="snapshotExtractedOn"):
        SnapshotEvidence.from_mapping({**payload, "snapshotExtractedOn": "20260901"})


def test_run_task_retransmission_reuses_ecs_token_and_task_arn() -> None:
    clients, secrets_client, ecs, _ = _clients()
    first = run_task(
        clients,
        _config(),
        _evidence(),
        launch_attempt="attempt-1",
        password_factory=lambda _: "first-secret",
    )
    second = run_task(
        clients,
        _config(),
        _evidence(),
        launch_attempt="attempt-1",
        password_factory=lambda _: "second-secret",
    )

    assert secrets_client.values == ["first-secret"]
    assert first.client_token == second.client_token
    assert first.task_arn == second.task_arn
    assert len(ecs.tasks_by_token) == 1
    assert ecs.run_calls[0]["clientToken"] == ecs.run_calls[1]["clientToken"]


def test_run_task_stopped_task_can_be_relaunched_with_a_new_attempt() -> None:
    clients, _, ecs, _ = _clients()
    first = run_task(clients, _config(), _evidence(), launch_attempt="attempt-1")
    ecs.mark_stopped(first.task_arn)

    second = run_task(clients, _config(), _evidence(), launch_attempt="attempt-2")

    assert any(
        task["taskArn"] == first.task_arn and task["lastStatus"] == "STOPPED"
        for task in ecs.tasks_by_token.values()
    )
    assert first.client_token != second.client_token
    assert first.task_arn != second.task_arn
    assert len(ecs.tasks_by_token) == 2


def test_run_task_same_attempt_within_stopped_task_ttl_returns_original_task() -> None:
    clock = ManualClock(1_000)
    clients, _, ecs, _ = _clients(ecs_clock=clock)
    first = run_task(clients, _config(), _evidence(), launch_attempt="attempt-1")
    clock.advance(7_200)
    ecs.mark_stopped(first.task_arn)
    clock.advance(ECS_CLIENT_TOKEN_POST_STOP_TTL_SECONDS - 1)

    with pytest.raises(OperationalError, match="stopped before"):
        run_task(clients, _config(), _evidence(), launch_attempt="attempt-1")

    assert len(ecs.tasks_by_token) == 1
    assert len(ecs.tasks_by_arn) == 1
    assert ecs.run_calls[0]["clientToken"] == ecs.run_calls[1]["clientToken"]


def test_run_task_same_attempt_after_stopped_task_ttl_can_create_a_new_task() -> None:
    clock = ManualClock(1_000)
    clients, _, ecs, _ = _clients(ecs_clock=clock)
    first = run_task(clients, _config(), _evidence(), launch_attempt="attempt-1")
    clock.advance(7_200)
    ecs.mark_stopped(first.task_arn)
    clock.advance(ECS_CLIENT_TOKEN_POST_STOP_TTL_SECONDS + 1)

    second = run_task(clients, _config(), _evidence(), launch_attempt="attempt-1")

    assert first.client_token == second.client_token
    assert first.task_arn != second.task_arn
    assert len(ecs.tasks_by_token) == 1
    assert len(ecs.tasks_by_arn) == 2


def test_run_task_same_attempt_after_maximum_ttl_can_create_a_new_running_task() -> None:
    clock = ManualClock(1_000)
    clients, _, ecs, _ = _clients(ecs_clock=clock)
    first = run_task(clients, _config(), _evidence(), launch_attempt="attempt-1")
    clock.advance(ECS_CLIENT_TOKEN_MAX_TTL_SECONDS + 1)

    second = run_task(clients, _config(), _evidence(), launch_attempt="attempt-1")

    assert first.client_token == second.client_token
    assert first.task_arn != second.task_arn
    assert len(ecs.tasks_by_token) == 1
    assert len(ecs.tasks_by_arn) == 2


def test_run_task_new_attempt_preserves_the_deterministic_secret_version() -> None:
    clients, secrets_client, _, _ = _clients()
    first = run_task(
        clients,
        _config(),
        _evidence(),
        launch_attempt="attempt-1",
        password_factory=lambda _: "first-secret",
    )
    second = run_task(
        clients,
        _config(),
        _evidence(),
        launch_attempt="attempt-2",
        password_factory=lambda _: "must-not-rotate",
    )

    assert secrets_client.values == ["first-secret"]
    assert first.client_token != second.client_token


def test_run_task_new_attempt_keeps_snapshot_identity_but_gets_a_distinct_run_id() -> None:
    clients, _, ecs, _ = _clients()
    snapshot = _evidence()

    first = run_task(clients, _config(), snapshot, launch_attempt="attempt-1")
    second = run_task(clients, _config(), snapshot, launch_attempt="attempt-2")

    assert first.snapshot == second.snapshot == snapshot
    assert first.run_id != second.run_id
    first_override = ecs.run_calls[0]["overrides"]["containerOverrides"][0]
    second_override = ecs.run_calls[1]["overrides"]["containerOverrides"][0]
    assert first_override["environment"] == second_override["environment"]
    assert first_override["command"] == ["backfill", "--run-id", first.run_id]
    assert second_override["command"] == ["backfill", "--run-id", second.run_id]


def test_run_task_serializes_rotations_until_the_first_task_containers_are_running() -> None:
    clients, secrets_client, ecs, dynamodb = _clients()
    ecs.block_describe = True
    failures: list[BaseException] = []
    replacement = SnapshotEvidence(
        bucket=_evidence().bucket,
        key="dumps/" + "c" * 64 + "/argus_dump.sql.gz",
        version_id="version-456",
        sha256="c" * 64,
        size=456,
        snapshot_extracted_on=date(2026, 9, 2),
    )

    def launch(snapshot: SnapshotEvidence, password: str) -> None:
        try:
            run_task(
                clients,
                _config(),
                snapshot,
                launch_attempt="attempt-1",
                password_factory=lambda _: password,
            )
        except BaseException as error:  # pragma: no cover - asserted below
            failures.append(error)

    first = threading.Thread(target=launch, args=(_evidence(), "first-secret"))
    first.start()
    assert ecs.describe_started.wait(timeout=2)

    second = threading.Thread(target=launch, args=(replacement, "second-secret"))
    second.start()
    assert dynamodb.lease_contended.wait(timeout=2)
    assert secrets_client.values == ["first-secret"]

    ecs.release_describe.set()
    first.join(timeout=2)
    second.join(timeout=2)

    assert not first.is_alive()
    assert not second.is_alive()
    assert failures == []
    assert secrets_client.values == ["first-secret", "second-secret"]


def test_run_task_fails_closed_when_an_expired_lease_is_taken_over_before_rotation() -> None:
    clients, secrets_client, ecs, dynamodb = _clients()

    def take_over_expired_lease() -> None:
        item = next(iter(dynamodb.items.values()))
        item["owner"] = {"S": "replacement-owner"}
        item["token"] = {"S": "replacement-token"}
        item["expiresAt"] = {"N": "9999999999"}

    dynamodb.on_update = take_over_expired_lease

    with pytest.raises(OperationalError, match="launcher lease"):
        run_task(
            clients,
            _config(),
            _evidence(),
            launch_attempt="attempt-1",
            password_factory=lambda _: "must-not-rotate",
        )

    assert secrets_client.values == []
    assert ecs.run_calls == []
    assert len(dynamodb.update_calls) == 1
    assert dynamodb.update_calls[0]["ConditionExpression"] == (
        "#owner = :owner AND #token = :token AND #expiresAt > :validAfter "
        "AND #expiresAt < :expiresAt"
    )
    assert len(dynamodb.items) == 1
    replacement = next(iter(dynamodb.items.values()))
    assert replacement["owner"] == {"S": "replacement-owner"}


def test_run_task_rechecks_lease_ownership_immediately_before_rotating_secret() -> None:
    clients, secrets_client, ecs, dynamodb = _clients()

    def take_over_expired_lease() -> None:
        item = next(iter(dynamodb.items.values()))
        item["owner"] = {"S": "replacement-owner"}
        item["token"] = {"S": "replacement-token"}
        item["expiresAt"] = {"N": "9999999999"}

    def rotate_then_take_over(_: int) -> str:
        dynamodb.on_update = take_over_expired_lease
        return "rotated-secret"

    with pytest.raises(OperationalError, match="launcher lease"):
        run_task(
            clients,
            _config(),
            _evidence(),
            launch_attempt="attempt-1",
            password_factory=rotate_then_take_over,
        )

    assert secrets_client.values == []
    assert ecs.run_calls == []
    assert len(dynamodb.update_calls) == 2


def test_run_task_rechecks_lease_ownership_before_calling_ecs() -> None:
    clients, _, ecs, dynamodb = _clients()

    def take_over_expired_lease() -> None:
        item = next(iter(dynamodb.items.values()))
        item["owner"] = {"S": "replacement-owner"}
        item["token"] = {"S": "replacement-token"}
        item["expiresAt"] = {"N": "9999999999"}

    class TakeoverAfterSecret(FakeSecrets):
        def put_secret_value(self, **kwargs: object) -> Mapping[str, object]:
            response = super().put_secret_value(**kwargs)
            dynamodb.on_update = take_over_expired_lease
            return response

    secrets_client = TakeoverAfterSecret()
    takeover_clients = RunTaskClients(
        sts=clients.sts,
        secrets=secrets_client,
        ecs=ecs,
        scheduler=clients.scheduler,
        dynamodb=clients.dynamodb,
    )

    with pytest.raises(OperationalError, match="launcher lease"):
        run_task(
            takeover_clients,
            _config(),
            _evidence(),
            launch_attempt="attempt-1",
            password_factory=lambda _: "rotated-secret",
        )

    assert secrets_client.values == ["rotated-secret"]
    assert ecs.run_calls == []
    assert len(dynamodb.update_calls) == 3


def test_run_task_fails_closed_when_polling_detects_a_lease_takeover() -> None:
    clients, _, _, dynamodb = _clients()

    def take_over_expired_lease() -> None:
        item = next(iter(dynamodb.items.values()))
        item["owner"] = {"S": "replacement-owner"}
        item["token"] = {"S": "replacement-token"}
        item["expiresAt"] = {"N": "9999999999"}

    class TakeoverBeforeDescribeEcs(FakeEcs):
        def run_task(self, **kwargs: object) -> Mapping[str, object]:
            response = super().run_task(**kwargs)
            dynamodb.on_update = take_over_expired_lease
            return response

    ecs = TakeoverBeforeDescribeEcs()
    takeover_clients = RunTaskClients(
        sts=clients.sts,
        secrets=clients.secrets,
        ecs=ecs,
        scheduler=clients.scheduler,
        dynamodb=clients.dynamodb,
    )

    with pytest.raises(OperationalError, match="launcher lease"):
        run_task(
            takeover_clients,
            _config(),
            _evidence(),
            launch_attempt="attempt-1",
            password_factory=lambda _: "secret",
        )

    assert len(ecs.stop_calls) == 1
    assert len(ecs.describe_task_calls) == 1
    assert len(dynamodb.items) == 1
    assert next(iter(dynamodb.items.values()))["owner"] == {"S": "replacement-owner"}


def test_heartbeat_keeps_lease_live_while_secret_rotation_is_blocked_past_ttl() -> None:
    clients, _, _, dynamodb = _clients()
    clock = ManualClock(1_000)

    class BlockingSecrets(FakeSecrets):
        def __init__(self) -> None:
            super().__init__()
            self.put_started = threading.Event()
            self.allow_put = threading.Event()

        def put_secret_value(self, **kwargs: object) -> Mapping[str, object]:
            self.put_started.set()
            assert self.allow_put.wait(timeout=2)
            return super().put_secret_value(**kwargs)

    secrets_client = BlockingSecrets()
    first_ecs = FakeEcs()
    first_clients = RunTaskClients(
        sts=clients.sts,
        secrets=secrets_client,
        ecs=first_ecs,
        scheduler=clients.scheduler,
        dynamodb=dynamodb,
    )
    failures: list[BaseException] = []

    def first_launcher() -> None:
        try:
            run_task(
                first_clients,
                _config(),
                _evidence(),
                launch_attempt="attempt-1",
                password_factory=lambda _: "first-secret",
                lease_clock=clock,
                lease_heartbeat_interval_seconds=0.01,
            )
        except BaseException as error:  # pragma: no cover - asserted below
            failures.append(error)

    first = threading.Thread(target=first_launcher)
    first.start()
    assert secrets_client.put_started.wait(timeout=2)
    updates_before = len(dynamodb.update_calls)
    clock.advance(300)
    _wait_until(lambda: len(dynamodb.update_calls) > updates_before)
    updates_after_first_jump = len(dynamodb.update_calls)
    clock.advance(301)
    _wait_until(lambda: len(dynamodb.update_calls) > updates_after_first_jump)

    second_clients, second_secrets, second_ecs, _ = _clients()
    second_clients = RunTaskClients(
        sts=second_clients.sts,
        secrets=second_secrets,
        ecs=second_ecs,
        scheduler=second_clients.scheduler,
        dynamodb=dynamodb,
    )
    with pytest.raises(OperationalError, match="launcher lease"):
        run_task(
            second_clients,
            _config(),
            _evidence(),
            launch_attempt="attempt-1",
            password_factory=lambda _: "second-secret",
            lease_acquire_timeout_seconds=0,
            lease_clock=clock,
        )

    secrets_client.allow_put.set()
    first.join(timeout=2)

    assert not first.is_alive()
    assert failures == []
    assert second_secrets.values == []
    assert first_ecs.run_calls


def test_run_task_validates_heartbeat_interval_before_acquiring_lease() -> None:
    clients, _, _, dynamodb = _clients()

    with pytest.raises(OperationalError, match="heartbeat interval"):
        run_task(
            clients,
            _config(),
            _evidence(),
            launch_attempt="attempt-1",
            lease_heartbeat_interval_seconds=0,
        )

    assert dynamodb.items == {}


def test_heartbeat_serializes_reordered_renewals_and_never_regresses_expiry() -> None:
    class BlockingFirstRenewDynamo(FakeDynamo):
        def __init__(self) -> None:
            super().__init__()
            self.first_update_started = threading.Event()
            self.allow_first_update = threading.Event()
            self._update_count = 0
            self._update_count_lock = threading.Lock()

        def update_item(self, **kwargs: object) -> Mapping[str, object]:
            with self._update_count_lock:
                call_number = self._update_count
                self._update_count += 1
            if call_number == 0:
                self.first_update_started.set()
                assert self.allow_first_update.wait(timeout=2)
            return super().update_item(**kwargs)

    clock = ManualClock(1_000)
    dynamodb = BlockingFirstRenewDynamo()
    lease = _acquire_launch_lease(dynamodb, _config(), timeout_seconds=0, clock=clock)
    heartbeat = LaunchLeaseHeartbeat(
        dynamodb,
        _config(),
        lease,
        clock=clock,
        interval_seconds=0.01,
    )
    errors: list[BaseException] = []
    stale_done = threading.Event()
    fresh_done = threading.Event()

    def renew(done: threading.Event) -> None:
        try:
            heartbeat.revalidate()
        except BaseException as error:  # pragma: no cover - asserted below
            errors.append(error)
        finally:
            done.set()

    stale = threading.Thread(target=renew, args=(stale_done,))
    stale.start()
    assert dynamodb.first_update_started.wait(timeout=2)
    clock.advance(601)
    fresh = threading.Thread(target=renew, args=(fresh_done,))
    fresh.start()
    assert not fresh_done.wait(timeout=0.1)

    dynamodb.allow_first_update.set()
    stale.join(timeout=2)
    fresh.join(timeout=2)

    assert not stale.is_alive()
    assert not fresh.is_alive()
    assert len(errors) == 1
    assert isinstance(errors[0], OperationalError)
    assert "launcher lease ownership was lost" in str(errors[0])
    written_expiries = _renewal_expiries(dynamodb)
    assert written_expiries == sorted(written_expiries)
    assert written_expiries == [1_601, 2_201]
    assert next(iter(dynamodb.items.values()))["expiresAt"] == {"N": "1601"}


def test_heartbeat_high_watermark_prevents_expiry_regression_after_clock_rewind() -> None:
    clock = ManualClock(1_000)
    dynamodb = FakeDynamo()
    lease = _acquire_launch_lease(dynamodb, _config(), timeout_seconds=0, clock=clock)
    heartbeat = LaunchLeaseHeartbeat(
        dynamodb,
        _config(),
        lease,
        clock=clock,
        interval_seconds=0.01,
    )

    heartbeat.revalidate()
    clock.advance(-750)
    heartbeat.revalidate()

    written_expiries = _renewal_expiries(dynamodb)
    assert written_expiries == [1_601, 1_602]


def test_heartbeat_shutdown_does_not_deadlock_on_a_blocked_renewal() -> None:
    class BlockingRenewDynamo(FakeDynamo):
        def __init__(self) -> None:
            super().__init__()
            self.update_started = threading.Event()
            self.allow_update = threading.Event()

        def update_item(self, **kwargs: object) -> Mapping[str, object]:
            self.update_started.set()
            assert self.allow_update.wait(timeout=2)
            return super().update_item(**kwargs)

    dynamodb = BlockingRenewDynamo()
    lease = _acquire_launch_lease(dynamodb, _config(), timeout_seconds=0)
    heartbeat = LaunchLeaseHeartbeat(
        dynamodb,
        _config(),
        lease,
        clock=time.time,
        interval_seconds=0.01,
    )
    heartbeat.start()
    assert dynamodb.update_started.wait(timeout=2)

    started_at = time.monotonic()
    heartbeat.close()
    assert time.monotonic() - started_at < 1.5
    with pytest.raises(OperationalError, match="heartbeat did not stop"):
        heartbeat.revalidate()

    dynamodb.allow_update.set()
    heartbeat.close()


def test_run_task_stops_even_when_ownership_is_lost_after_task_arn() -> None:
    clients, _, _, dynamodb = _clients()

    def take_over_lease() -> None:
        item = next(iter(dynamodb.items.values()))
        item["owner"] = {"S": "replacement-owner"}
        item["token"] = {"S": "replacement-token"}
        item["expiresAt"] = {"N": "9999999999"}

    class TakeoverAfterRunTaskEcs(FakeEcs):
        def run_task(self, **kwargs: object) -> Mapping[str, object]:
            response = super().run_task(**kwargs)
            dynamodb.on_update = take_over_lease
            return response

    ecs = TakeoverAfterRunTaskEcs()
    takeover_clients = RunTaskClients(
        sts=clients.sts,
        secrets=clients.secrets,
        ecs=ecs,
        scheduler=clients.scheduler,
        dynamodb=dynamodb,
    )

    with pytest.raises(OperationalError, match="launcher lease"):
        run_task(
            takeover_clients,
            _config(),
            _evidence(),
            launch_attempt="attempt-1",
            password_factory=lambda _: "secret",
        )

    assert len(ecs.stop_calls) == 1
    assert next(iter(dynamodb.items.values()))["owner"] == {"S": "replacement-owner"}


def test_run_task_revalidates_lease_after_running_task_response() -> None:
    clients, _, _, dynamodb = _clients()

    def take_over_lease() -> None:
        item = next(iter(dynamodb.items.values()))
        item["owner"] = {"S": "replacement-owner"}
        item["token"] = {"S": "replacement-token"}
        item["expiresAt"] = {"N": "9999999999"}

    class RunningThenTakeoverEcs(FakeEcs):
        def describe_tasks(self, **kwargs: object) -> Mapping[str, object]:
            response = super().describe_tasks(**kwargs)
            dynamodb.on_update = take_over_lease
            return response

    ecs = RunningThenTakeoverEcs()
    takeover_clients = RunTaskClients(
        sts=clients.sts,
        secrets=clients.secrets,
        ecs=ecs,
        scheduler=clients.scheduler,
        dynamodb=dynamodb,
    )

    with pytest.raises(OperationalError, match="launcher lease"):
        run_task(
            takeover_clients,
            _config(),
            _evidence(),
            launch_attempt="attempt-1",
            password_factory=lambda _: "secret",
        )

    assert len(ecs.stop_calls) == 1
    assert next(iter(dynamodb.items.values()))["owner"] == {"S": "replacement-owner"}


def test_run_task_takes_over_only_an_expired_launcher_lease() -> None:
    clients, secrets_client, _, dynamodb = _clients()
    lease_key = (
        "INGESTION#RUN_TASK#" + hashlib.sha256(SNAPSHOT_SECRET_ARN.encode("utf-8")).hexdigest(),
        "LAUNCH_LEASE",
    )
    dynamodb.items[lease_key] = {
        "pk": {"S": lease_key[0]},
        "sk": {"S": lease_key[1]},
        "owner": {"S": "crashed-launcher"},
        "token": {"S": "stale-token"},
        "expiresAt": {"N": "1"},
    }

    run_task(
        clients,
        _config(),
        _evidence(),
        launch_attempt="attempt-1",
        password_factory=lambda _: "fresh-secret",
    )

    assert secrets_client.values == ["fresh-secret"]
    assert len(dynamodb.put_calls) == 1
    assert dynamodb.put_calls[0]["ConditionExpression"] == (
        "attribute_not_exists(pk) OR #expiresAt < :now"
    )
    assert dynamodb.put_calls[0]["ExpressionAttributeNames"] == {"#expiresAt": "expiresAt"}


def test_run_task_times_out_on_a_live_lease_without_rotating_the_secret() -> None:
    clients, secrets_client, _, dynamodb = _clients()
    lease_key = (
        "INGESTION#RUN_TASK#" + hashlib.sha256(SNAPSHOT_SECRET_ARN.encode("utf-8")).hexdigest(),
        "LAUNCH_LEASE",
    )
    dynamodb.items[lease_key] = {
        "pk": {"S": lease_key[0]},
        "sk": {"S": lease_key[1]},
        "owner": {"S": "live-launcher"},
        "token": {"S": "live-token"},
        "expiresAt": {"N": "9999999999"},
    }

    with pytest.raises(OperationalError, match="launcher lease"):
        run_task(
            clients,
            _config(),
            _evidence(),
            launch_attempt="attempt-1",
            password_factory=lambda _: "must-not-rotate",
            lease_acquire_timeout_seconds=0,
        )

    assert secrets_client.values == []
    assert dynamodb.delete_calls == []


def test_run_task_releases_its_lease_when_containers_never_reach_running() -> None:
    clients, secrets_client, ecs, dynamodb = _clients()
    ecs.task_last_status = "PENDING"
    ecs.container_statuses["ingestion"] = "PENDING"

    with pytest.raises(OperationalError, match="containers"):
        run_task(
            clients,
            _config(),
            _evidence(),
            launch_attempt="attempt-1",
            password_factory=lambda _: "transient-secret",
            task_ready_timeout_seconds=0,
        )

    assert secrets_client.values == ["transient-secret"]
    assert dynamodb.items == {}
    assert len(dynamodb.delete_calls) == 1
    assert ecs.stop_calls == [
        {
            "cluster": f"arn:aws:ecs:{REGION}:{ACCOUNT_ID}:cluster/view-show-iac-cluster",
            "task": f"arn:aws:ecs:{REGION}:{ACCOUNT_ID}:task/abc",
            "reason": "run-task readiness failed",
        }
    ]


def test_run_task_waits_for_nonessential_mysql_sidecar_to_reach_running() -> None:
    clients, secrets_client, ecs, dynamodb = _clients()
    ecs.container_statuses["mysql-snapshot"] = "PENDING"

    with pytest.raises(OperationalError, match="containers"):
        run_task(
            clients,
            _config(),
            _evidence(),
            launch_attempt="attempt-1",
            password_factory=lambda _: "transient-secret",
            task_ready_timeout_seconds=0,
        )

    assert secrets_client.values == ["transient-secret"]
    assert dynamodb.items == {}
    assert len(dynamodb.delete_calls) == 1
    assert len(ecs.stop_calls) == 1


def test_run_task_stops_and_releases_after_a_generic_describe_error() -> None:
    clients, _, _, dynamodb = _clients()

    class DescribeRaisesOnceEcs(FakeEcs):
        def __init__(self) -> None:
            super().__init__()
            self._raise_once = True

        def describe_tasks(self, **kwargs: object) -> Mapping[str, object]:
            if self._raise_once:
                self._raise_once = False
                raise RuntimeError("describe transport failed")
            return super().describe_tasks(**kwargs)

    ecs = DescribeRaisesOnceEcs()
    failing_clients = RunTaskClients(
        sts=clients.sts,
        secrets=clients.secrets,
        ecs=ecs,
        scheduler=clients.scheduler,
        dynamodb=clients.dynamodb,
    )

    with pytest.raises(RuntimeError, match="describe transport failed"):
        run_task(
            failing_clients,
            _config(),
            _evidence(),
            launch_attempt="attempt-1",
            password_factory=lambda _: "secret",
        )

    assert len(ecs.stop_calls) == 1
    assert dynamodb.items == {}
    assert len(dynamodb.delete_calls) == 1


def test_run_task_releases_lease_when_ecs_explicitly_reports_no_task_created() -> None:
    clients, secrets_client, _, dynamodb = _clients()

    class FailedRunTaskEcs(FakeEcs):
        def run_task(self, **kwargs: object) -> Mapping[str, object]:
            del kwargs
            return {"failures": [{"reason": "capacity"}], "tasks": []}

    failing_clients = RunTaskClients(
        sts=clients.sts,
        secrets=clients.secrets,
        ecs=FailedRunTaskEcs(),
        scheduler=clients.scheduler,
        dynamodb=clients.dynamodb,
    )

    with pytest.raises(OperationalError, match="RunTask"):
        run_task(
            failing_clients,
            _config(),
            _evidence(),
            launch_attempt="attempt-1",
            password_factory=lambda _: "secret",
        )

    assert secrets_client.values == ["secret"]
    assert dynamodb.items == {}
    assert len(dynamodb.delete_calls) == 1


def test_run_task_keeps_its_lease_when_run_task_response_cannot_be_cleaned_up() -> None:
    clients, _, _, dynamodb = _clients()

    class MalformedRunTaskEcs(FakeEcs):
        def run_task(self, **kwargs: object) -> Mapping[str, object]:
            del kwargs
            return {"failures": [], "tasks": [{"notTaskArn": "unknown"}]}

    malformed_clients = RunTaskClients(
        sts=clients.sts,
        secrets=clients.secrets,
        ecs=MalformedRunTaskEcs(),
        scheduler=clients.scheduler,
        dynamodb=clients.dynamodb,
    )

    with pytest.raises(OperationalError, match="invalid task ARN"):
        run_task(
            malformed_clients,
            _config(),
            _evidence(),
            launch_attempt="attempt-1",
            password_factory=lambda _: "secret",
        )

    assert len(dynamodb.items) == 1
    assert dynamodb.delete_calls == []


def test_run_task_does_not_delete_a_takeover_lease_during_conditional_release() -> None:
    clients, _, _, dynamodb = _clients()

    def replace_lease() -> None:
        assert len(dynamodb.items) == 1
        item = next(iter(dynamodb.items.values()))
        item["owner"] = {"S": "replacement-owner"}
        item["token"] = {"S": "replacement-token"}

    dynamodb.on_delete = replace_lease
    run_task(
        clients,
        _config(),
        _evidence(),
        launch_attempt="attempt-1",
        password_factory=lambda _: "transient-secret",
    )

    assert len(dynamodb.items) == 1
    replacement = next(iter(dynamodb.items.values()))
    assert replacement["owner"] == {"S": "replacement-owner"}
    assert replacement["token"] == {"S": "replacement-token"}


def test_run_task_activation_reuses_secret_but_uses_a_distinct_ecs_token() -> None:
    clients, secrets_client, ecs, _ = _clients()
    inactive = run_task(
        clients,
        _config(),
        _evidence(),
        launch_attempt="attempt-1",
        activate_candidate=False,
        password_factory=lambda _: "first-secret",
    )
    active = run_task(
        clients,
        _config(),
        _evidence(),
        launch_attempt="attempt-1",
        activate_candidate=True,
        password_factory=lambda _: "second-secret",
    )

    assert secrets_client.values == ["first-secret"]
    assert inactive.client_token != active.client_token
    assert inactive.to_public_dict()["activated"] is False
    assert active.to_public_dict()["activated"] is True
    assert ecs.run_calls[0]["overrides"] != ecs.run_calls[1]["overrides"]
    assert ecs.run_calls[1]["overrides"] == {
        "containerOverrides": [
            {
                "name": "ingestion",
                "command": ["backfill", "--run-id", active.run_id],
                "environment": [
                    {"name": "SNAPSHOT_BUCKET", "value": _evidence().bucket},
                    {"name": "SNAPSHOT_OBJECT_KEY", "value": _evidence().key},
                    {"name": "SNAPSHOT_OBJECT_VERSION_ID", "value": _evidence().version_id},
                    {"name": "SNAPSHOT_SHA256", "value": _evidence().sha256},
                    {
                        "name": "SNAPSHOT_EXTRACTED_ON",
                        "value": _evidence().snapshot_extracted_on.isoformat(),
                    },
                    {"name": "ACTIVATE_CANDIDATE", "value": "true"},
                ],
            }
        ]
    }


def test_run_task_requires_explicit_mutually_exclusive_activation_flag() -> None:
    base = [
        "--terraform-output",
        "terraform.json",
        "--snapshot",
        "snapshot.json",
        "--launch-attempt",
        "attempt-1",
    ]

    with pytest.raises(SystemExit):
        _parse_arguments(base)
    assert _parse_arguments([*base, "--activate"]).activate_candidate is True
    assert _parse_arguments([*base, "--no-activate"]).activate_candidate is False
    with pytest.raises(SystemExit):
        _parse_arguments([*base, "--activate", "--no-activate"])


def test_run_task_requires_an_explicit_bounded_launch_attempt() -> None:
    base = ["--terraform-output", "terraform.json", "--snapshot", "snapshot.json"]

    with pytest.raises(SystemExit):
        _parse_arguments([*base, "--no-activate"])
    assert (
        _parse_arguments([*base, "--launch-attempt", "recovery-2", "--no-activate"]).launch_attempt
        == "recovery-2"
    )
    for invalid in ["", " attempt", "attempt/2", "a" * 65]:
        with pytest.raises(OperationalError, match="launch attempt"):
            run_task(_clients()[0], _config(), _evidence(), launch_attempt=invalid)


def test_run_task_requires_real_matching_scheduler_name_and_arn() -> None:
    values = _config().to_mapping()
    scheduler = values["scheduler"]
    assert isinstance(scheduler, dict)
    scheduler.pop("name")

    with pytest.raises(OperationalError, match="required field name"):
        RunTaskConfig.from_mapping(values)


def test_run_task_rejects_scheduler_identity_other_than_the_declared_disabled_schedule() -> None:
    clients, _, _, _ = _clients()

    class WrongScheduler:
        def get_schedule(self, **kwargs: object) -> Mapping[str, object]:
            assert kwargs == {
                "Name": "view-show-ingestion-sync",
                "GroupName": "view-show-ingestion",
            }
            return {
                "Name": "different",
                "GroupName": "view-show-ingestion",
                "Arn": (
                    f"arn:aws:scheduler:{REGION}:{ACCOUNT_ID}:schedule/view-show-ingestion/different"
                ),
                "State": "DISABLED",
            }

    wrong_clients = RunTaskClients(
        sts=clients.sts,
        secrets=clients.secrets,
        ecs=clients.ecs,
        scheduler=WrongScheduler(),
        dynamodb=clients.dynamodb,
    )
    with pytest.raises(OperationalError, match="identity"):
        run_task(wrong_clients, _config(), _evidence(), launch_attempt="attempt-1")


@pytest.mark.parametrize(
    "port_mappings",
    [[{"containerPort": 8080}], [{"containerPort": 3306, "hostPort": 3306}]],
)
def test_run_task_rejects_port_mappings_in_any_task_container(port_mappings: list[object]) -> None:
    clients, _, _, _ = _clients()

    class SidecarPortEcs(FakeEcs):
        def describe_task_definition(self, **kwargs: object) -> Mapping[str, object]:
            response = json.loads(json.dumps(super().describe_task_definition(**kwargs)))
            definition = response["taskDefinition"]
            assert isinstance(definition, dict)
            containers = definition["containerDefinitions"]
            assert isinstance(containers, list)
            containers.append({"name": "sidecar", "portMappings": port_mappings})
            return response

    wrong_clients = RunTaskClients(
        sts=clients.sts,
        secrets=clients.secrets,
        ecs=SidecarPortEcs(),
        scheduler=clients.scheduler,
        dynamodb=clients.dynamodb,
    )
    with pytest.raises(OperationalError, match="port mappings"):
        run_task(wrong_clients, _config(), _evidence(), launch_attempt="attempt-1")


@pytest.mark.parametrize(
    "dependency",
    [[], [{"containerName": "mysql-snapshot", "condition": "START"}]],
)
def test_run_task_rejects_task_definition_without_mysql_health_dependency(
    dependency: list[object],
) -> None:
    clients, _, _, _ = _clients()

    class WeakDependencyEcs(FakeEcs):
        def describe_task_definition(self, **kwargs: object) -> Mapping[str, object]:
            response = json.loads(json.dumps(super().describe_task_definition(**kwargs)))
            containers = response["taskDefinition"]["containerDefinitions"]
            ingestion = next(item for item in containers if item["name"] == "ingestion")
            ingestion["dependsOn"] = dependency
            return response

    wrong_clients = RunTaskClients(
        sts=clients.sts,
        secrets=clients.secrets,
        ecs=WeakDependencyEcs(),
        scheduler=clients.scheduler,
        dynamodb=clients.dynamodb,
    )
    with pytest.raises(OperationalError, match="backfill container"):
        run_task(wrong_clients, _config(), _evidence(), launch_attempt="attempt-1")


def test_run_task_rejects_mysql_as_an_essential_container() -> None:
    clients, _, _, _ = _clients()

    class EssentialMysqlEcs(FakeEcs):
        def describe_task_definition(self, **kwargs: object) -> Mapping[str, object]:
            response = json.loads(json.dumps(super().describe_task_definition(**kwargs)))
            containers = response["taskDefinition"]["containerDefinitions"]
            mysql = next(item for item in containers if item["name"] == "mysql-snapshot")
            mysql["essential"] = True
            return response

    wrong_clients = RunTaskClients(
        sts=clients.sts,
        secrets=clients.secrets,
        ecs=EssentialMysqlEcs(),
        scheduler=clients.scheduler,
        dynamodb=clients.dynamodb,
    )
    with pytest.raises(OperationalError, match="MySQL non-essential"):
        run_task(wrong_clients, _config(), _evidence(), launch_attempt="attempt-1")


@pytest.mark.parametrize(
    ("environment", "assign_public_ip"), [("learner-lab", True), ("production", True)]
)
def test_run_task_config_rejects_public_ip_for_private_subnet_environments(
    environment: str, assign_public_ip: bool
) -> None:
    values = _config().to_mapping()
    values["environment"] = environment
    runtime = values["runtime"]
    assert isinstance(runtime, dict)
    runtime["assign_public_ip"] = assign_public_ip

    with pytest.raises(OperationalError, match="public IP"):
        RunTaskConfig.from_mapping(values)


def test_run_task_config_accepts_learner_lab_private_subnets_with_nat() -> None:
    values = _config().to_mapping()
    runtime = values["runtime"]
    assert isinstance(runtime, dict)
    runtime["assign_public_ip"] = False

    assert RunTaskConfig.from_mapping(values).assign_public_ip is False


def test_run_task_accepts_only_the_namespaced_backfill_family_from_terraform() -> None:
    config = _config()

    assert config.deployment_namespace == "view-show"
    assert config.task_family == "view-show-ingestion-backfill"

    values = config.to_mapping()
    runtime = values["runtime"]
    assert isinstance(runtime, dict)
    runtime["task_family"] = "different-ingestion-backfill"

    with pytest.raises(OperationalError, match="task family"):
        RunTaskConfig.from_mapping(values)


def test_production_requires_redundant_environment_and_account_confirmation() -> None:
    clients, _, _, _ = _clients()
    values = _config().to_mapping()
    values["environment"] = "production"
    runtime = values["runtime"]
    assert isinstance(runtime, dict)
    runtime["assign_public_ip"] = False
    config = RunTaskConfig.from_mapping(values)

    with pytest.raises(OperationalError, match="production confirmation"):
        run_task(clients, config, _evidence(), launch_attempt="attempt-1")


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
