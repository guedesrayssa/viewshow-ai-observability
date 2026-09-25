"""Declara as interfaces abstratas entre casos de uso e infraestrutura.

Papel no fluxo:
    Este módulo forma a fronteira tipada entre os casos de uso e seus adaptadores concretos.

Garantias e limites:
    Implementações devem preservar as invariantes descritas aqui, inclusive idempotência,
    controle de concorrência e imutabilidade dos valores transportados.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from domain.datasets import DatasetDescriptor
from domain.disk_budget import DiskBudget
from domain.models import CanonicalRecord, TimeWindow
from domain.run import RunProgress, RunStage, RunState, RunTransitionMetadata
from ports.models import (
    ArchiveObject,
    ArchivePartition,
    ArchiveState,
    CandidateManifest,
    CoverageObservation,
    CurrentProjection,
    EncodedPartition,
    EventProjectionItem,
    Lease,
    OutboxBacklog,
    OutboxEvent,
    Projection,
    PublishReceipt,
    ReconciliationCounts,
    RestoreRequest,
    RestoreResult,
    SchemaObservation,
    SourcePage,
    WriteResult,
)

if TYPE_CHECKING:
    from domain.canonical_set import CanonicalSet

type Cursor = tuple[object, ...]


@dataclass(frozen=True, slots=True)
class QueryPlanEvidence:
    dataset: str
    index_name: str
    cursor_columns: tuple[str, ...]
    created: bool
    access_type: str
    estimated_rows: int


class CanonicalSetStore(ABC):
    """Persists the immutable commit marker for one complete canonical generation."""

    @abstractmethod
    def get(self, dataset_version: str) -> CanonicalSet | None:
        raise NotImplementedError

    @abstractmethod
    def commit(self, value: CanonicalSet, *, idempotency_key: str) -> CanonicalSet:
        raise NotImplementedError


class LiveSyncConfiguration(ABC):
    """Fornece a configuração dinâmica que controla a sincronização ao vivo."""

    @abstractmethod
    def is_enabled(self) -> bool:
        """Informa se a sincronização ao vivo está habilitada."""
        raise NotImplementedError


class SourceReader(ABC):
    """Define a porta abstrata ``SourceReader`` consumida pela aplicação.

    Adaptadores concretos devem respeitar as assinaturas, a idempotência e as falhas
    documentadas pelos métodos.
    """

    @abstractmethod
    def validate_schema(self, descriptor: DatasetDescriptor) -> SchemaObservation:
        """Valida esquema contra as invariantes deste módulo.

        Args:
            descriptor: Descritor físico e semântico do dataset processado.

        Returns:
            Valor ``SchemaObservation`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def measure_coverage(self, descriptor: DatasetDescriptor) -> CoverageObservation:
        """Mede cobertura e devolve evidências explícitas da observação.

        Args:
            descriptor: Descritor físico e semântico do dataset processado.

        Returns:
            Valor ``CoverageObservation`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def read_page(
        self,
        descriptor: DatasetDescriptor,
        window: TimeWindow | None,
        after: Cursor | None,
        limit: int,
    ) -> SourcePage:
        """Lê página sem ampliar o escopo solicitado.

        Args:
            descriptor: Descritor físico e semântico do dataset processado.
            window: Janela temporal UTC, fechada no início e aberta no fim.
            after: Cursor da última linha consumida; ``None`` inicia a paginação.
            limit: Quantidade máxima de itens que a operação pode processar.

        Returns:
            Valor ``SourcePage`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError


class SnapshotRestorer(ABC):
    """Define a porta abstrata ``SnapshotRestorer`` consumida pela aplicação.

    Adaptadores concretos devem respeitar as assinaturas, a idempotência e as falhas
    documentadas pelos métodos.
    """

    @abstractmethod
    def restore(self, request: RestoreRequest, *, idempotency_key: str) -> RestoreResult:
        """Restaura o recurso e confirma sua identidade antes de concluir.

        Args:
            request: Objeto de entrada já estruturado para o caso de uso.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``RestoreResult`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError


class SnapshotPreparer(ABC):
    """Prepares stable cursor indexes and proves snapshot page query plans."""

    @abstractmethod
    def prepare(
        self,
        descriptors: tuple[DatasetDescriptor, ...],
    ) -> tuple[QueryPlanEvidence, ...]:
        raise NotImplementedError


class HotRecordSink(ABC):
    """Define a porta abstrata ``HotRecordSink`` consumida pela aplicação.

    Adaptadores concretos devem respeitar as assinaturas, a idempotência e as falhas
    documentadas pelos métodos.
    """

    @abstractmethod
    def write(
        self,
        records: tuple[CanonicalRecord, ...],
        dataset_version: str,
        partition: str,
        *,
        idempotency_key: str,
    ) -> WriteResult:
        """Grava os dados recebidos e devolve a evidência da persistência.

        Args:
            records: Registros canônicos consumidos pela operação.
            dataset_version: Identificador imutável da versão do dataset.
            partition: Identificador canônico da partição física ou lógica.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``WriteResult`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError


class HotExpirationRepository(ABC):
    """Define a porta abstrata ``HotExpirationRepository`` consumida pela aplicação.

    Adaptadores concretos devem respeitar as assinaturas, a idempotência e as falhas
    documentadas pelos métodos.
    """

    @abstractmethod
    def authorize_expiration(
        self,
        dataset_version: str,
        dataset: str,
        partition: str,
        ttl_epoch_s: int,
        *,
        expected_archive_state: ArchiveState,
        idempotency_key: str,
    ) -> int:
        """Autoriza expiração somente após validar as evidências exigidas.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            dataset: Nome do dataset permitido pelo registro de contratos.
            partition: Identificador canônico da partição física ou lógica.
            ttl_epoch_s: Entrada ``ttl_epoch_s``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            expected_archive_state: Valor esperado usado para detectar concorrência ou
            divergência de estado.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``int`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError


class CheckpointRepository(ABC):
    """Define a porta abstrata ``CheckpointRepository`` consumida pela aplicação.

    Adaptadores concretos devem respeitar as assinaturas, a idempotência e as falhas
    documentadas pelos métodos.
    """

    @abstractmethod
    def get(self, dataset_version: str, dataset: str) -> Cursor | None:
        """Obtém o valor atualmente persistido para a identidade informada.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            dataset: Nome do dataset permitido pelo registro de contratos.

        Returns:
            Valor ``Cursor | None`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def advance(
        self,
        dataset_version: str,
        dataset: str,
        cursor: Cursor,
        *,
        expected_cursor: Cursor | None,
        idempotency_key: str,
    ) -> Cursor:
        """Avança a entrada somente a partir do estado previamente observado.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            dataset: Nome do dataset permitido pelo registro de contratos.
            cursor: Cursor de paginação ou retomada associado à fonte.
            expected_cursor: Valor esperado usado para detectar concorrência ou divergência de
            estado.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``Cursor`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError


class LeaseRepository(ABC):
    """Define a porta abstrata ``LeaseRepository`` consumida pela aplicação.

    Adaptadores concretos devem respeitar as assinaturas, a idempotência e as falhas
    documentadas pelos métodos.
    """

    @abstractmethod
    def acquire(
        self,
        source: str,
        owner: str,
        now: datetime,
        ttl_seconds: int,
        *,
        idempotency_key: str,
    ) -> Lease:
        """Tenta adquirir a posse exclusiva do recurso para o proprietário informado.

        Args:
            source: Identificador da fonte de dados processada.
            owner: Identidade do worker que possui ou solicita o lease.
            now: Instante UTC usado como referência para a operação.
            ttl_seconds: Duração do lease ou da retenção, expressa em segundos.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``Lease`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def renew(
        self,
        source: str,
        owner: str,
        now: datetime,
        ttl_seconds: int,
        *,
        expected_expires_at: datetime,
        idempotency_key: str,
    ) -> Lease:
        """Renova a posse sem reduzir o prazo de expiração já observado.

        Args:
            source: Identificador da fonte de dados processada.
            owner: Identidade do worker que possui ou solicita o lease.
            now: Instante UTC usado como referência para a operação.
            ttl_seconds: Duração do lease ou da retenção, expressa em segundos.
            expected_expires_at: Valor esperado usado para detectar concorrência ou divergência
            de estado.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``Lease`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def release(self, source: str, owner: str, *, idempotency_key: str) -> None:
        """Libera a posse somente para o proprietário atual.

        Args:
            source: Identificador da fonte de dados processada.
            owner: Identidade do worker que possui ou solicita o lease.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError


class RunRepository(ABC):
    """Define a porta abstrata ``RunRepository`` consumida pela aplicação.

    Adaptadores concretos devem respeitar as assinaturas, a idempotência e as falhas
    documentadas pelos métodos.
    """

    @abstractmethod
    def get_run_progress(self, run_id: str) -> RunProgress | None:
        """Read the persisted state, timestamp, and cumulative counts as one snapshot."""
        raise NotImplementedError

    @abstractmethod
    def get_run(self, run_id: str) -> RunState | None:
        """Obtém execução a partir da fonte configurada.

        Args:
            run_id: Identificador não secreto e estável da execução.

        Returns:
            Valor ``RunState | None`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def create(self, state: RunState, *, idempotency_key: str) -> RunState:
        """Cria o recurso somente quando suas pré-condições são satisfeitas.

        Args:
            state: Estado imutável que será validado ou persistido.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``RunState`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def transition(
        self,
        run_id: str,
        target: RunStage,
        *,
        expected_stage: RunStage,
        metadata: RunTransitionMetadata | None = None,
        mark_candidate_active: bool = False,
        idempotency_key: str,
    ) -> RunState:
        """Aplica uma transição usando o estado previamente observado como proteção.

        Args:
            run_id: Identificador não secreto e estável da execução.
            target: Estado ou destino solicitado para a operação.
            expected_stage: Valor esperado usado para detectar concorrência ou divergência de
            estado.
            metadata: Metadados associados ao registro ou à transição.
            mark_candidate_active: Entrada ``mark_candidate_active``; a forma aceita é definida
            pela anotação de tipo e validada antes do uso.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``RunState`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def append_error(
        self,
        run_id: str,
        sequence: int,
        message: str,
        *,
        expected_stage: RunStage,
        idempotency_key: str,
    ) -> None:
        """Executa a etapa interna ``append_error`` e valida seus efeitos antes de concluir.

        Args:
            run_id: Identificador não secreto e estável da execução.
            sequence: Entrada ``sequence``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            message: Entrada ``message``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            expected_stage: Valor esperado usado para detectar concorrência ou divergência de
            estado.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError


class ManifestRepository(ABC):
    """Define a porta abstrata ``ManifestRepository`` consumida pela aplicação.

    Adaptadores concretos devem respeitar as assinaturas, a idempotência e as falhas
    documentadas pelos métodos.
    """

    @abstractmethod
    def get_active(self) -> CandidateManifest | None:
        """Obtém ativo a partir da fonte configurada.

        Returns:
            Valor ``CandidateManifest | None`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def get_candidate(self, dataset_version: str) -> CandidateManifest | None:
        """Obtém candidato a partir da fonte configurada.

        Args:
            dataset_version: Identificador imutável da versão do dataset.

        Returns:
            Valor ``CandidateManifest | None`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def put_candidate(
        self,
        manifest: CandidateManifest,
        *,
        expected_absent: bool,
        idempotency_key: str,
    ) -> None:
        """Executa a etapa interna ``put_candidate`` e valida seus efeitos antes de concluir.

        Args:
            manifest: Entrada ``manifest``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            expected_absent: Indica se a operação exige que o recurso ainda não exista.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def activate(
        self,
        expected_active: str | None,
        candidate: CandidateManifest,
        *,
        idempotency_key: str,
    ) -> CandidateManifest:
        """Ativa a entrada por meio de uma troca atômica do estado esperado.

        Args:
            expected_active: Valor esperado usado para detectar concorrência ou divergência de
            estado.
            candidate: Manifesto candidato que poderá se tornar ativo.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``CandidateManifest`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError


class ProjectionRepository(ABC):
    """Define a porta abstrata ``ProjectionRepository`` consumida pela aplicação.

    Adaptadores concretos devem respeitar as assinaturas, a idempotência e as falhas
    documentadas pelos métodos.
    """

    @abstractmethod
    def get_current(
        self, dataset_version: str, key: str, operational_sort_key: str
    ) -> CurrentProjection | None:
        """Obtém current a partir da fonte configurada.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            operational_sort_key: Chave usada para identificar, consultar ou persistir o
            recurso.

        Returns:
            Valor ``CurrentProjection | None`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def put(
        self,
        projection: Projection,
        *,
        expected_projection_version: str | None,
        idempotency_key: str,
        expected_materialization_revision: str | None = None,
    ) -> None:
        """Persiste o valor após validar identidade e pré-condições da escrita.

        Args:
            projection: Entrada ``projection``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.
            expected_projection_version: Valor esperado usado para detectar concorrência ou
            divergência de estado.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.
            expected_materialization_revision: Valor esperado usado para detectar concorrência
            ou divergência de estado.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def query_inputs(
        self, dataset_version: str, partition_keys: tuple[str, ...]
    ) -> tuple[CanonicalRecord, ...]:
        """Consulta entradas usando somente chaves previamente validadas.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            partition_keys: Entrada ``partition_keys``; a forma aceita é definida pela anotação
            de tipo e validada antes do uso.

        Returns:
            Valor ``tuple[CanonicalRecord, ...]`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    def iter_input_batches(
        self, dataset_version: str, partition_keys: tuple[str, ...]
    ) -> Iterator[tuple[CanonicalRecord, ...]]:
        """Produz entrada batches de forma incremental e com memória limitada.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            partition_keys: Entrada ``partition_keys``; a forma aceita é definida pela anotação
            de tipo e validada antes do uso.

        Returns:
            Iterador que produz os itens válidos à medida que são processados.
        """
        records = self.query_inputs(dataset_version, partition_keys)
        if records:
            yield records

    def put_event_items(self, items: tuple[EventProjectionItem, ...]) -> None:
        """Persist one bounded idempotent batch of candidate Event/Evidence items."""
        raise NotImplementedError


class ParquetEncoder(ABC):
    """Define a porta abstrata ``ParquetEncoder`` consumida pela aplicação.

    Adaptadores concretos devem respeitar as assinaturas, a idempotência e as falhas
    documentadas pelos métodos.
    """

    @abstractmethod
    def write_partition(
        self,
        records: Iterable[CanonicalRecord],
        descriptor: DatasetDescriptor,
        path: Path,
        *,
        dataset_version: str,
        expected_absent: bool,
        idempotency_key: str,
        disk_budget: DiskBudget | None = None,
    ) -> EncodedPartition:
        """Grava partição e devolve a evidência produzida pela operação.

        Args:
            records: Registros canônicos consumidos pela operação.
            descriptor: Descritor físico e semântico do dataset processado.
            path: Caminho local do artefato lido ou produzido.
            dataset_version: Identificador imutável da versão do dataset.
            expected_absent: Indica se a operação exige que o recurso ainda não exista.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.
            disk_budget: Entrada ``disk_budget``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.

        Returns:
            Valor ``EncodedPartition`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError


class ArchiveObjectStore(ABC):
    """Define a porta abstrata ``ArchiveObjectStore`` consumida pela aplicação.

    Adaptadores concretos devem respeitar as assinaturas, a idempotência e as falhas
    documentadas pelos métodos.
    """

    @abstractmethod
    def stage(
        self,
        partition: EncodedPartition,
        key: str,
        *,
        expected_absent: bool,
        idempotency_key: str,
    ) -> ArchiveObject:
        """Grava o objeto em staging antes de sua publicação definitiva.

        Args:
            partition: Identificador canônico da partição física ou lógica.
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            expected_absent: Indica se a operação exige que o recurso ainda não exista.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``ArchiveObject`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def promote(
        self,
        staged: ArchiveObject,
        canonical_key: str,
        *,
        expected_absent: bool,
        idempotency_key: str,
    ) -> ArchiveObject:
        """Promove o objeto temporário para sua identidade canônica e imutável.

        Args:
            staged: Entrada ``staged``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            canonical_key: Chave usada para identificar, consultar ou persistir o recurso.
            expected_absent: Indica se a operação exige que o recurso ainda não exista.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``ArchiveObject`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def head(self, key: str) -> ArchiveObject | None:
        """Executa a etapa interna ``head`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Valor ``ArchiveObject | None`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError


class GlueCatalog(ABC):
    """Define a porta abstrata ``GlueCatalog`` consumida pela aplicação.

    Adaptadores concretos devem respeitar as assinaturas, a idempotência e as falhas
    documentadas pelos métodos.
    """

    @abstractmethod
    def ensure_table(
        self, descriptor: DatasetDescriptor, location: str, *, idempotency_key: str
    ) -> None:
        """Garante a existência compatível de tabela sem sobrescrever divergências.

        Args:
            descriptor: Descritor físico e semântico do dataset processado.
            location: Entrada ``location``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def register_partition(
        self,
        descriptor: DatasetDescriptor,
        dataset_version: str,
        partition: str,
        location: str,
        *,
        aggregate_digest: str,
        expected_absent: bool,
        idempotency_key: str,
    ) -> None:
        """Registra partição e confirma que o estado persistido é compatível.

        Args:
            descriptor: Descritor físico e semântico do dataset processado.
            dataset_version: Identificador imutável da versão do dataset.
            partition: Identificador canônico da partição física ou lógica.
            location: Entrada ``location``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            expected_absent: Indica se a operação exige que o recurso ainda não exista.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def register_legacy_partition(
        self,
        descriptor: DatasetDescriptor,
        dataset_version: str,
        partition: str,
        location: str,
        *,
        expected_absent: bool,
        idempotency_key: str,
    ) -> None:
        """Register the explicitly named single-object metadata-v1 partition layout."""
        raise NotImplementedError


class AthenaValidator(ABC):
    """Define a porta abstrata ``AthenaValidator`` consumida pela aplicação.

    Adaptadores concretos devem respeitar as assinaturas, a idempotência e as falhas
    documentadas pelos métodos.
    """

    @abstractmethod
    def validate_partition(
        self,
        table: str,
        dataset_version: str,
        partition: str,
        expected_row_count: int,
        *,
        aggregate_digest: str,
    ) -> int:
        """Valida partição contra as invariantes deste módulo.

        Args:
            table: Nome da tabela previamente autorizado pelo contrato.
            dataset_version: Identificador imutável da versão do dataset.
            partition: Identificador canônico da partição física ou lógica.
            expected_row_count: Valor esperado usado para detectar concorrência ou divergência
            de estado.

        Returns:
            Valor ``int`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def validate_legacy_partition(
        self,
        table: str,
        dataset_version: str,
        partition: str,
        expected_row_count: int,
    ) -> int:
        """Validate the explicitly named single-object metadata-v1 partition layout."""
        raise NotImplementedError


class ArchivePartitionRepository(ABC):
    """Define a porta abstrata ``ArchivePartitionRepository`` consumida pela aplicação.

    Adaptadores concretos devem respeitar as assinaturas, a idempotência e as falhas
    documentadas pelos métodos.
    """

    @abstractmethod
    def put(
        self,
        partition: ArchivePartition,
        *,
        expected_absent: bool,
        idempotency_key: str,
    ) -> None:
        """Persiste o valor após validar identidade e pré-condições da escrita.

        Args:
            partition: Identificador canônico da partição física ou lógica.
            expected_absent: Indica se a operação exige que o recurso ainda não exista.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def get(
        self,
        dataset_version: str,
        dataset: str,
        partition: str,
    ) -> ArchivePartition | None:
        """Read one archive partition by its complete immutable identity.

        Concrete adapters must use a consistent exact-key read rather than filtering a
        dataset catalog.
        """
        raise NotImplementedError

    @abstractmethod
    def query(self, dataset_version: str, dataset: str) -> tuple[ArchivePartition, ...]:
        """Consulta os itens que atendem às chaves e aos limites informados.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            dataset: Nome do dataset permitido pelo registro de contratos.

        Returns:
            Valor ``tuple[ArchivePartition, ...]`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def record_reconciliation(
        self,
        dataset_version: str,
        dataset: str,
        partition: str,
        *,
        observed_counts: ReconciliationCounts,
        reconciled_at: datetime,
        expected_state: ArchiveState,
        idempotency_key: str,
    ) -> ArchivePartition:
        """Obtém ou registra reconciliação como evidência da execução atual.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            dataset: Nome do dataset permitido pelo registro de contratos.
            partition: Identificador canônico da partição física ou lógica.
            observed_counts: Valor efetivamente observado que será comparado com a evidência
            esperada.
            reconciled_at: Instante UTC com fuso horário usado pela regra temporal.
            expected_state: Estado previamente observado usado no controle de concorrência.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``ArchivePartition`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def update_state(
        self,
        dataset_version: str,
        dataset: str,
        partition: str,
        state: ArchiveState,
        *,
        expected_state: ArchiveState,
        idempotency_key: str,
    ) -> ArchivePartition:
        """Atualiza estado usando o estado esperado para controlar concorrência.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            dataset: Nome do dataset permitido pelo registro de contratos.
            partition: Identificador canônico da partição física ou lógica.
            state: Estado imutável que será validado ou persistido.
            expected_state: Estado previamente observado usado no controle de concorrência.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``ArchivePartition`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError


class WindowCommitRepository(ABC):
    """Define a porta abstrata ``WindowCommitRepository`` consumida pela aplicação.

    Adaptadores concretos devem respeitar as assinaturas, a idempotência e as falhas
    documentadas pelos métodos.
    """

    @abstractmethod
    def get_watermark(self, dataset_version: str, source: str) -> datetime | None:
        """Obtém marca d'água a partir da fonte configurada.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            source: Identificador da fonte de dados processada.

        Returns:
            Valor ``datetime | None`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def get_bucket_evidence(
        self, dataset_version: str, source: str
    ) -> tuple[tuple[str, int, int, int], ...]:
        """Obtém bucket evidência a partir da fonte configurada.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            source: Identificador da fonte de dados processada.

        Returns:
            Valor ``tuple[tuple[str, int, int, int], ...]`` produzido pela operação após as
            validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def get_outbox_event(self, event_id: str) -> OutboxEvent | None:
        """Obtém outbox evento a partir da fonte configurada.

        Args:
            event_id: Identificador estável da entidade ou operação correspondente.

        Returns:
            Valor ``OutboxEvent | None`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def commit_watermark_and_outboxes(
        self,
        dataset_version: str,
        source: str,
        watermark: datetime,
        events: tuple[OutboxEvent, ...],
        *,
        expected_watermark: datetime | None,
        idempotency_key: str,
        bucket_evidence: tuple[tuple[str, int, int, int], ...] = (),
    ) -> None:
        """Confirma marca d'água and outboxes atomicamente usando as evidências esperadas.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            source: Identificador da fonte de dados processada.
            watermark: Entrada ``watermark``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            events: Entrada ``events``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            expected_watermark: Valor esperado usado para detectar concorrência ou divergência
            de estado.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.
            bucket_evidence: Entrada ``bucket_evidence``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError


class OutboxRepository(ABC):
    """Define a porta abstrata ``OutboxRepository`` consumida pela aplicação.

    Adaptadores concretos devem respeitar as assinaturas, a idempotência e as falhas
    documentadas pelos métodos.
    """

    @abstractmethod
    def list_pending(self, limit: int) -> tuple[OutboxEvent, ...]:
        """Lista pendente respeitando os limites informados.

        Args:
            limit: Quantidade máxima de itens que a operação pode processar.

        Returns:
            Valor ``tuple[OutboxEvent, ...]`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def mark_published(
        self,
        event_id: str,
        message_id: str,
        *,
        expected_state: str,
        idempotency_key: str,
    ) -> None:
        """Marca published por meio de uma transição validada.

        Args:
            event_id: Identificador estável da entidade ou operação correspondente.
            message_id: Identificador estável da entidade ou operação correspondente.
            expected_state: Estado previamente observado usado no controle de concorrência.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError


class OutboxBacklogInspector(ABC):
    """Define a porta abstrata ``OutboxBacklogInspector`` consumida pela aplicação.

    Adaptadores concretos devem respeitar as assinaturas, a idempotência e as falhas
    documentadas pelos métodos.
    """

    @abstractmethod
    def inspect_pending(self) -> OutboxBacklog:
        """Executa a etapa interna ``inspect_pending`` e devolve o resultado validado indicado
        pela assinatura.

        Returns:
            Valor ``OutboxBacklog`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError


class AnalysisRequestPublisher(ABC):
    """Define a porta abstrata ``AnalysisRequestPublisher`` consumida pela aplicação.

    Adaptadores concretos devem respeitar as assinaturas, a idempotência e as falhas
    documentadas pelos métodos.
    """

    @abstractmethod
    def publish(self, event: OutboxEvent, *, idempotency_key: str) -> PublishReceipt:
        """Publica o conteúdo validado e devolve a confirmação do destino.

        Args:
            event: Evento de análise validado que será codificado ou publicado.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``PublishReceipt`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError


class Logger(ABC):
    """Define a porta abstrata ``Logger`` consumida pela aplicação.

    Adaptadores concretos devem respeitar as assinaturas, a idempotência e as falhas
    documentadas pelos métodos.
    """

    @abstractmethod
    def bind(self, **context: object) -> Logger:
        """Cria uma visão com a entrada associado ao contexto atual.

        Args:
            context: Contexto validado compartilhado durante o processamento.

        Returns:
            Valor ``Logger`` produzido pela operação após as validações.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def info(self, event: str, **fields: object) -> None:
        """Emite um evento informativo com contexto estruturado.

        Args:
            event: Evento de análise validado que será codificado ou publicado.
            fields: Entrada ``fields``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def error(self, event: str, **fields: object) -> None:
        """Registra ou transforma uma falha sem expor dados sensíveis.

        Args:
            event: Evento de análise validado que será codificado ou publicado.
            fields: Entrada ``fields``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError


class MetricsPublisher(ABC):
    """Define a porta abstrata ``MetricsPublisher`` consumida pela aplicação.

    Adaptadores concretos devem respeitar as assinaturas, a idempotência e as falhas
    documentadas pelos métodos.
    """

    @abstractmethod
    def increment(self, name: str, value: int, dimensions: Mapping[str, str]) -> None:
        """Incrementa um contador com dimensões de baixa cardinalidade.

        Args:
            name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            value: Valor não confiável que será validado ou convertido.
            dimensions: Entrada ``dimensions``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def gauge(self, name: str, value: float, dimensions: Mapping[str, str]) -> None:
        """Publica o valor atual de uma medida com dimensões controladas.

        Args:
            name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            value: Valor não confiável que será validado ou convertido.
            dimensions: Entrada ``dimensions``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError

    @abstractmethod
    def timing(self, name: str, milliseconds: float, dimensions: Mapping[str, str]) -> None:
        """Publica a duração observada da operação em milissegundos.

        Args:
            name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            milliseconds: Entrada ``milliseconds``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            dimensions: Entrada ``dimensions``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            NotImplementedError: Sempre, pois a implementação concreta deve fornecer a operação.
        """
        raise NotImplementedError


__all__ = [
    "AnalysisRequestPublisher",
    "ArchiveObjectStore",
    "ArchivePartitionRepository",
    "CanonicalSetStore",
    "AthenaValidator",
    "CheckpointRepository",
    "Cursor",
    "GlueCatalog",
    "HotExpirationRepository",
    "HotRecordSink",
    "LeaseRepository",
    "LiveSyncConfiguration",
    "Logger",
    "ManifestRepository",
    "MetricsPublisher",
    "OutboxRepository",
    "OutboxBacklogInspector",
    "ParquetEncoder",
    "ProjectionRepository",
    "RunRepository",
    "SnapshotRestorer",
    "SourceReader",
    "WindowCommitRepository",
]
