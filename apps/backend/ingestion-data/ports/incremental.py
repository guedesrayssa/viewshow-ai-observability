"""Ports for exporting and ingesting immutable incremental batches."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterable, Mapping
from pathlib import Path

from domain.datasets import DatasetDescriptor
from domain.incremental_batches import (
    BatchDelivery,
    BatchState,
    EncodedRawBatch,
    IncrementalBatchDefinition,
    IncrementalBatchManifest,
    IncrementalBatchRecord,
    IncrementalBatchReference,
    PhysicalColumn,
    RawBatchPage,
)
from domain.models import TimeWindow
from ports.contracts import Cursor
from ports.models import SourcePage


class IncrementalExportSource(ABC):
    @abstractmethod
    def observe_schema(self, descriptor: DatasetDescriptor) -> tuple[PhysicalColumn, ...]:
        raise NotImplementedError

    @abstractmethod
    def read_page(
        self,
        descriptor: DatasetDescriptor,
        window: TimeWindow,
        after: Cursor | None,
        limit: int,
    ) -> SourcePage:
        raise NotImplementedError


class RawBatchCodec(ABC):
    @abstractmethod
    def encode(
        self,
        columns: tuple[PhysicalColumn, ...],
        rows: Iterable[Mapping[str, object]],
        destination: Path,
    ) -> EncodedRawBatch:
        raise NotImplementedError


class IncrementalBatchObjectStore(ABC):
    @abstractmethod
    def publish(
        self,
        definition: IncrementalBatchDefinition,
        columns: tuple[PhysicalColumn, ...],
        encoded: EncodedRawBatch,
    ) -> IncrementalBatchReference:
        raise NotImplementedError

    @abstractmethod
    def load_manifest(self, reference: IncrementalBatchReference) -> IncrementalBatchManifest:
        raise NotImplementedError

    @abstractmethod
    def read_page(
        self, manifest: IncrementalBatchManifest, after: int | None, limit: int
    ) -> RawBatchPage:
        raise NotImplementedError


class IncrementalBatchQueue(ABC):
    @abstractmethod
    def send(
        self, reference: IncrementalBatchReference, *, batch_id: str, dataset: str
    ) -> None:
        raise NotImplementedError

    @abstractmethod
    def receive(self, limit: int) -> tuple[BatchDelivery, ...]:
        raise NotImplementedError

    @abstractmethod
    def ack(self, delivery: BatchDelivery) -> None:
        raise NotImplementedError


class IncrementalBatchRepository(ABC):
    @abstractmethod
    def claim(
        self,
        manifest: IncrementalBatchManifest,
        reference: IncrementalBatchReference,
    ) -> IncrementalBatchRecord:
        raise NotImplementedError

    @abstractmethod
    def transition(
        self,
        batch_id: str,
        expected_state: BatchState,
        expected_version: int,
        next_state: BatchState,
    ) -> IncrementalBatchRecord:
        raise NotImplementedError

    @abstractmethod
    def finish(
        self,
        batch_id: str,
        expected_state: BatchState,
        expected_version: int,
        next_state: BatchState,
        *,
        counts: Mapping[str, int],
        error_code: str | None = None,
    ) -> IncrementalBatchRecord:
        raise NotImplementedError
