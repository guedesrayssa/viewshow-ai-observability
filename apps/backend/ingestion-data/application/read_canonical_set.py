"""Read projection inputs exclusively from one committed canonical set."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Protocol, cast

from contracts.registry import DatasetRegistry
from domain.archive import validate_archive_partition
from domain.canonical_set import CanonicalPartitionEvidence, CanonicalSet
from domain.datasets import DatasetDescriptor
from domain.models import CanonicalRecord
from ports import (
    ArchiveObject,
    ArchivePartition,
    ArchivePartitionRepository,
    ArchiveReconciliationError,
    ArchiveState,
)

type ArchiveRecords = Mapping[tuple[str, str], tuple[CanonicalRecord, ...]]


class CanonicalRecordSourceError(ArchiveReconciliationError):
    """Canonical marker evidence cannot safely produce projection inputs."""


class CanonicalRecordSource(ABC):
    """Yield bounded projection input batches authorized by a canonical marker."""

    @abstractmethod
    def iter_batches(
        self,
        canonical_set: CanonicalSet,
        *,
        batch_size: int = 2_048,
    ) -> Iterable[ArchiveRecords]:
        raise NotImplementedError


class CanonicalObjectDownloader(Protocol):
    """Download one exact immutable marker object to a caller-owned path."""

    def download(
        self,
        key: str,
        destination: Path,
        *,
        expected_sha256: str,
        expected_size: int,
    ) -> ArchiveObject: ...


class CanonicalParquetReader(Protocol):
    """Decode one validated Parquet object without materializing the full file."""

    def iter_batches(
        self,
        path: Path,
        descriptor: DatasetDescriptor,
        *,
        dataset_version: str,
        partition: str,
        expected_row_count: int,
        expected_schema_fingerprint: str,
        batch_size: int,
    ) -> Iterable[tuple[CanonicalRecord, ...]]: ...


class ReadCanonicalSet(CanonicalRecordSource):
    """Preflight a marker and stream its exact object allowlist one object at a time."""

    def __init__(
        self,
        registry: DatasetRegistry,
        partitions: ArchivePartitionRepository,
        objects: CanonicalObjectDownloader,
        parquet: CanonicalParquetReader,
        temporary_root: Path,
    ) -> None:
        if not isinstance(registry, DatasetRegistry):
            raise TypeError("registry must be a DatasetRegistry")
        if not isinstance(temporary_root, Path):
            raise TypeError("temporary_root must be a Path")
        self._registry = registry
        self._partitions = partitions
        self._objects = objects
        self._parquet = parquet
        self._temporary_root = temporary_root

    @staticmethod
    def _object_documents(
        evidence: CanonicalPartitionEvidence,
    ) -> tuple[dict[str, object], ...]:
        return tuple(
            {
                "objectKey": item.object_key,
                "rowCount": item.row_count,
                "byteCount": item.byte_count,
                "sha256": item.sha256,
            }
            for item in evidence.objects
        )

    @staticmethod
    def _validate_persisted(
        archive: ArchivePartition,
        *,
        aggregate_digest: str,
        expected_partition: CanonicalPartitionEvidence,
    ) -> None:
        metadata = dict(archive.metadata)
        # Early canonical-v2 writers could retain this derived value. It is not immutable
        # archive identity and therefore must not reject an otherwise valid marker object.
        metadata.pop("projectionItemCount", None)
        try:
            validate_archive_partition(replace(archive, metadata=metadata))
        except (TypeError, ValueError) as error:
            raise CanonicalRecordSourceError(
                "canonical archive partition evidence is invalid"
            ) from error
        evidence = expected_partition
        if archive.state is not ArchiveState.AVAILABLE:
            raise CanonicalRecordSourceError(
                "canonical projection input requires every archive partition to be AVAILABLE"
            )
        if (
            archive.partition != evidence.partition
            or metadata.get("aggregateDigest") != aggregate_digest
            or metadata.get("catalogDigest") != aggregate_digest
            or metadata.get("counts")
            != {
                "accepted": evidence.row_count,
                "rejected": 0,
                "persisted": evidence.row_count,
            }
            or tuple(
                dict(cast(Mapping[str, object], item))
                for item in cast(Sequence[object], metadata.get("objects", ()))
            )
            != ReadCanonicalSet._object_documents(evidence)
        ):
            raise CanonicalRecordSourceError(
                "archive partition evidence differs from the canonical marker"
            )

    def _preflight(self, canonical_set: CanonicalSet) -> None:
        for dataset in canonical_set.datasets:
            persisted = self._partitions.query(canonical_set.dataset_version, dataset.dataset)
            if tuple(item.partition for item in persisted) != tuple(
                item.partition for item in dataset.partitions
            ):
                raise CanonicalRecordSourceError(
                    "archive partitions differ from canonical marker coverage"
                )
            for archive, evidence in zip(persisted, dataset.partitions, strict=True):
                self._validate_persisted(
                    archive,
                    aggregate_digest=canonical_set.aggregate_digest,
                    expected_partition=evidence,
                )

    def iter_batches(
        self,
        canonical_set: CanonicalSet,
        *,
        batch_size: int = 2_048,
    ) -> Iterable[ArchiveRecords]:
        if not isinstance(canonical_set, CanonicalSet):
            raise TypeError("canonical_set must be a CanonicalSet")
        if isinstance(batch_size, bool) or not isinstance(batch_size, int):
            raise TypeError("batch_size must be an integer")
        if batch_size <= 0:
            raise ValueError("batch_size must be positive")
        self._preflight(canonical_set)
        self._temporary_root.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(prefix="canonical-projection-", dir=self._temporary_root) as raw:
            temporary = Path(raw)
            total_rows = 0
            for dataset in canonical_set.datasets:
                descriptor = self._registry.require(dataset.dataset)
                dataset_rows = 0
                for partition in dataset.partitions:
                    partition_rows = 0
                    for ordinal, item in enumerate(partition.objects):
                        path = temporary / f"object-{ordinal:05d}.parquet"
                        try:
                            downloaded = self._objects.download(
                                item.object_key,
                                path,
                                expected_sha256=item.sha256,
                                expected_size=item.byte_count,
                            )
                            if (downloaded.key, downloaded.sha256, downloaded.size) != (
                                item.object_key,
                                item.sha256,
                                item.byte_count,
                            ):
                                raise CanonicalRecordSourceError(
                                    "downloaded canonical object differs from marker evidence"
                                )
                            object_rows = 0
                            for records in self._parquet.iter_batches(
                                path,
                                descriptor,
                                dataset_version=canonical_set.dataset_version,
                                partition=partition.partition,
                                expected_row_count=item.row_count,
                                expected_schema_fingerprint=dataset.schema_fingerprint,
                                batch_size=batch_size,
                            ):
                                batch = tuple(records)
                                if not batch or len(batch) > batch_size:
                                    raise CanonicalRecordSourceError(
                                        "canonical Parquet reader exceeded the configured "
                                        "batch bound"
                                    )
                                object_rows += len(batch)
                                yield {(dataset.dataset, partition.partition): batch}
                            if object_rows != item.row_count:
                                raise CanonicalRecordSourceError(
                                    "canonical object row count differs from marker evidence"
                                )
                            partition_rows += object_rows
                        finally:
                            path.unlink(missing_ok=True)
                    if partition_rows != partition.row_count:
                        raise CanonicalRecordSourceError(
                            "canonical partition row count differs from marker evidence"
                        )
                    dataset_rows += partition_rows
                if dataset_rows != dataset.accepted_row_count:
                    raise CanonicalRecordSourceError(
                        "canonical dataset row count differs from marker evidence"
                    )
                total_rows += dataset_rows
            if total_rows != canonical_set.total_accepted_rows:
                raise CanonicalRecordSourceError(
                    "canonical set row count differs from marker evidence"
                )


__all__ = [
    "ArchiveRecords",
    "CanonicalObjectDownloader",
    "CanonicalParquetReader",
    "CanonicalRecordSource",
    "CanonicalRecordSourceError",
    "ReadCanonicalSet",
]
