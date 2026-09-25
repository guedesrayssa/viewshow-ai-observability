"""Verify MySQL records flow through ingestion into persistent stores."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from adapters.archive.parquet import schema_fingerprint_for_descriptor
from adapters.sources.mysql_reader import MySqlConnectionSettings, MySqlSourceReader
from application.archive_partition import ArchivePartitionEncoder, ArchivePartitionPublisher
from application.backfill import Backfill, BackfillRequest
from application.publish_outbox import OutboxPublisher
from application.rebuild_projections import ProjectionService
from contracts.registry import DatasetRegistry
from ports import AthenaValidator, CandidateManifest, RestoreRequest, RestoreResult
from tests.fakes import (
    FakeAnalysisRequestPublisher,
    FakeArchiveObjectStore,
    FakeArchivePartitionRepository,
    FakeCheckpointRepository,
    FakeGlueCatalog,
    FakeHotExpirationRepository,
    FakeHotRecordSink,
    FakeIngestionBackend,
    FakeLeaseRepository,
    FakeManifestRepository,
    FakeOutboxRepository,
    FakeParquetEncoder,
    FakeProjectionRepository,
    FakeRunRepository,
    FakeSnapshotRestorer,
    FakeWindowCommitRepository,
)
from tests.integration.mysql_test_config import mysql_test_host, mysql_test_port

# O sha do dump é evidência OPERACIONAL, não contrato: cada execução declara
# qual dump restaurou. Os testes declaram do mesmo jeito que o operador declara.
DUMP_SHA256 = "c1d86081679d66c392b63710bda4517b047f029c5403ad1502d731ab5ac126ea"


class TickingClock:
    def __init__(self) -> None:
        self.current = datetime(2026, 9, 9, tzinfo=UTC)

    def __call__(self) -> datetime:
        current = self.current
        self.current += timedelta(seconds=1)
        return current


class EchoAthena(AthenaValidator):
    def validate_partition(
        self,
        table: str,
        dataset_version: str,
        partition: str,
        expected_row_count: int,
        *,
        aggregate_digest: str,
    ) -> int:
        del table, dataset_version, partition, aggregate_digest
        return expected_row_count

    def validate_legacy_partition(
        self,
        table: str,
        dataset_version: str,
        partition: str,
        expected_row_count: int,
    ) -> int:
        del table, dataset_version, partition
        return expected_row_count


@dataclass
class IntegrationHarness:
    service: Backfill
    request: BackfillRequest
    backend: FakeIngestionBackend


def build_mysql_harness(tmp_path: Path) -> IntegrationHarness:
    registry = DatasetRegistry.load_argus_v2()
    checksum = DUMP_SHA256
    reader = MySqlSourceReader(
        registry,
        MySqlConnectionSettings(
            host=mysql_test_host(),
            port=mysql_test_port(),
            user="ingestion",
            password="ingestion-test-only",
            database="argus",
        ),
    )
    backend = FakeIngestionBackend()
    clock = TickingClock()
    outboxes = FakeOutboxRepository(backend=backend)
    service = Backfill(
        registry=registry,
        restorer=FakeSnapshotRestorer(RestoreResult(checksum, 100)),
        reader_factory=lambda: reader,
        hot_sink=FakeHotRecordSink(backend),
        checkpoints=FakeCheckpointRepository(),
        leases=FakeLeaseRepository(),
        runs=FakeRunRepository(),
        manifests=FakeManifestRepository(CandidateManifest("dsv_old", {"legacy": True})),
        projections=ProjectionService(FakeProjectionRepository(backend=backend)),
        archive_encoder=ArchivePartitionEncoder(FakeParquetEncoder()),
        archive_publisher=ArchivePartitionPublisher(
            FakeArchiveObjectStore(),
            FakeGlueCatalog(),
            EchoAthena(),
            FakeArchivePartitionRepository(backend),
            FakeHotExpirationRepository(backend),
            "archive-bucket",
            clock,
            schema_fingerprint_for_descriptor,
        ),
        window_commits=FakeWindowCommitRepository(backend=backend),
        outbox_publisher=OutboxPublisher(outboxes, FakeAnalysisRequestPublisher()),
        normalization_context=lambda _source: reader.build_normalization_context(),
        clock=clock,
    )
    request = BackfillRequest(
        run_id="run-mysql",
        restore_request=RestoreRequest("bucket", "dump.sql.gz", "v1", checksum),
        snapshot_extracted_on=date(2026, 9, 1),
        archive_workdir=tmp_path,
        disk_free_bytes=lambda _path: 50 * 1024**3,
        page_size=1,
        lease_ttl_seconds=300,
        outbox_limit=100,
    )
    return IntegrationHarness(service, request, backend)


@pytest.mark.mysql
def test_mysql_snapshot_reaches_hot_archive_projection_and_outbox_stores(
    tmp_path: Path,
) -> None:
    harness = build_mysql_harness(tmp_path)

    first = harness.service.execute(harness.request)
    facts = dict(harness.backend.fact_records)
    projections = dict(harness.backend.projections)
    archives = dict(harness.backend.archive_partitions)
    outboxes = dict(harness.backend.outboxes)
    second = harness.service.execute(replace(harness.request, run_id="run-mysql-replay"))

    assert first.records_read == 29
    assert first.records_accepted == 29
    assert first.records_written == 29
    assert first.new_archive_objects == 23
    assert first.new_analysis_events == 2
    assert len(harness.backend.fact_records) == 29
    assert harness.service._hot_sink.write_calls == 29  # type: ignore[attr-defined]
    assert len(harness.service._checkpoints.checkpoints) == 23  # type: ignore[attr-defined]
    assert len(harness.backend.projections) > 0
    assert len(harness.backend.archive_partitions) == 23
    assert len(harness.backend.outboxes) == 2
    assert second.dataset_version == first.dataset_version
    assert second.records_written == 0
    assert second.records_unchanged == 0
    assert second.new_archive_objects == 0
    assert second.new_analysis_events == 0
    assert harness.backend.fact_records == facts
    assert harness.backend.projections == projections
    assert harness.backend.archive_partitions == archives
    assert harness.backend.outboxes == outboxes
    assert harness.service._hot_sink.write_calls == 29  # type: ignore[attr-defined]
