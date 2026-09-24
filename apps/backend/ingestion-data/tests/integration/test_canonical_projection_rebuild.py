"""Rebuild projections from committed Parquet objects, never hot facts."""

from __future__ import annotations

import hashlib
from pathlib import Path

from adapters.archive.parquet import PyArrowParquetEncoder
from application.read_canonical_set import ReadCanonicalSet
from application.rebuild_projections import (
    ProjectionService,
    RebuildProjections,
    RebuildProjectionsRequest,
)
from contracts.registry import DatasetRegistry
from ports import ArchiveDependency, ArchiveObject
from tests.fakes import FakeCanonicalSetStore, FakeManifestRepository, FakeProjectionRepository
from tests.unit.application.test_read_canonical_set import (
    PARTITION,
    _archive,
    _canonical_set,
    _record,
)


class LocalObjectStore:
    def __init__(self, objects: dict[str, Path]) -> None:
        self.objects = objects
        self.downloads: list[str] = []

    def download(
        self,
        key: str,
        destination: Path,
        *,
        expected_sha256: str,
        expected_size: int,
    ) -> ArchiveObject:
        self.downloads.append(key)
        source = self.objects[key]
        digest = hashlib.sha256()
        size = 0
        with source.open("rb") as input_stream, destination.open("xb") as output_stream:
            while chunk := input_stream.read(64 * 1024):
                digest.update(chunk)
                size += len(chunk)
                output_stream.write(chunk)
        assert (digest.hexdigest(), size) == (expected_sha256, expected_size)
        return ArchiveObject(key, expected_sha256, expected_size)


class NoHotFacts(FakeProjectionRepository):
    def iter_input_batches(self, *_args, **_kwargs):  # type: ignore[no-untyped-def]
        raise AssertionError("canonical rebuild must not read hot projection inputs")

    def query_inputs(self, *_args, **_kwargs):  # type: ignore[no-untyped-def]
        raise AssertionError("canonical rebuild must not read hot projection inputs")


def test_canonical_projection_rebuild_round_trips_s3_parquet_and_replays_idempotently(
    tmp_path: Path,
) -> None:
    registry = DatasetRegistry.load_argus_v2()
    descriptor = registry.require("app_error")
    encoded = PyArrowParquetEncoder().write_partition(
        (_record(),),
        descriptor,
        tmp_path / "published.parquet",
        dataset_version="dsv_canonical",
        expected_absent=True,
        idempotency_key="integration-canonical-object",
    )
    marker = _canonical_set(
        row_count=encoded.row_count,
        byte_count=encoded.byte_size,
        object_sha=encoded.sha256,
    )
    evidence = next(item for item in marker.datasets if item.dataset == "app_error").partitions[0]
    objects = LocalObjectStore({evidence.objects[0].object_key: encoded.path})
    source = ReadCanonicalSet(
        registry,
        type(
            "Partitions",
            (),
            {
                "query": lambda _self, version, dataset: (
                    (_archive(marker),)
                    if (version, dataset) == (marker.dataset_version, "app_error")
                    else ()
                )
            },
        )(),
        objects,
        PyArrowParquetEncoder(),
        tmp_path / "run-workspace",
    )
    canonical_sets = FakeCanonicalSetStore()
    canonical_sets.values[marker.dataset_version] = marker
    repository = NoHotFacts()
    command = RebuildProjections(
        ProjectionService(repository),
        FakeManifestRepository(),
        canonical_sets=canonical_sets,
        canonical_source=source,
    )
    request = RebuildProjectionsRequest(
        marker.dataset_version,
        (f"DATASET#{marker.dataset_version}#FACT#TS#app_error#20260901",),
        {"app_error": PARTITION},
    )

    first = command.execute(request)
    first_heads = dict(repository.backend.projection_heads)
    second = command.execute(request)

    assert first.catalog_item_counts == second.catalog_item_counts == {("app_error", PARTITION): 2}
    assert repository.backend.projection_heads == first_heads
    # Each execution reads the requested partition and then the complete
    # canonical set used by cross-day Event correlation.
    assert objects.downloads == [evidence.objects[0].object_key] * 4
    assert all(
        item.required_archives == (ArchiveDependency("app_error", PARTITION),)
        for item in repository.backend.projections.values()
    )
    assert not tuple((tmp_path / "run-workspace").rglob("*.parquet"))
