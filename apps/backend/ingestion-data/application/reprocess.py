"""Reprocessa uma janela limitada de um dataset sem alterar o manifesto ativo.

Papel no fluxo:
    No fluxo da aplicação, este módulo coordena regras do domínio por meio das interfaces de
    ``ports`` e não depende diretamente de SDKs ou formatos de infraestrutura.

Garantias e limites:
    A ordem das operações preserva idempotência, reconciliação e retomada segura quando uma
    execução é interrompida.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from application.archive_partition import archive_partition_key
from application.lease_guard import LeaseGuard
from application.sync import ActiveManifestError, validate_active_manifest_identity
from contracts.argus.v2.normalizers import NormalizationContext, normalize_row
from contracts.registry import DatasetRegistry
from domain.models import CanonicalRecord, TimeWindow
from domain.run import RunStage
from ports import (
    HotRecordSink,
    LeaseRepository,
    LiveSyncConfiguration,
    ManifestRepository,
    SourceReader,
)


def _text(value: object, field: str) -> str:
    """Executa a etapa interna ``text`` e devolve o resultado validado indicado pela assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    if not value:
        raise ValueError(f"{field} must not be empty")
    return value


@dataclass(frozen=True, slots=True)
class ReprocessRequest:
    """Representa os dados de ``ReprocessRequest`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        run_id: Identificador não secreto e estável da execução.
        dataset_version: Identificador imutável da versão do dataset.
        dataset: Nome do dataset permitido pelo registro de contratos.
        window: Janela temporal UTC, fechada no início e aberta no fim.
        page_size: Entrada ``page_size``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        maximum_window: Entrada ``maximum_window``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        lease_ttl_seconds: Duração ou prazo expresso em segundos.
    """

    run_id: str
    dataset_version: str | None
    dataset: str
    window: TimeWindow
    page_size: int = 500
    maximum_window: timedelta = timedelta(days=31)
    lease_ttl_seconds: int = 300

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        for field in ("run_id", "dataset"):
            _text(getattr(self, field), field)
        if self.dataset_version is not None:
            _text(self.dataset_version, "dataset_version")
        if not isinstance(self.window, TimeWindow):
            raise TypeError("window must be an explicit UTC TimeWindow")
        if not isinstance(self.maximum_window, timedelta) or self.maximum_window <= timedelta(0):
            raise ValueError("maximum_window must be a positive duration")
        if self.window.end - self.window.start > self.maximum_window:
            raise ValueError("reprocess window must be explicitly bounded")
        if isinstance(self.page_size, bool) or not isinstance(self.page_size, int):
            raise TypeError("page_size must be an integer")
        if self.page_size <= 0:
            raise ValueError("page_size must be positive")
        if isinstance(self.lease_ttl_seconds, bool) or not isinstance(self.lease_ttl_seconds, int):
            raise TypeError("lease_ttl_seconds must be an integer")
        if self.lease_ttl_seconds <= 0:
            raise ValueError("lease_ttl_seconds must be positive")


@dataclass(frozen=True, slots=True)
class ReprocessResult:
    """Representa os dados de ``ReprocessResult`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        dataset: Nome do dataset permitido pelo registro de contratos.
        records_read: Entrada ``records_read``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.
        records_written: Entrada ``records_written``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        records_unchanged: Entrada ``records_unchanged``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        stage: Entrada ``stage``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
    """

    dataset: str
    records_read: int
    records_written: int
    records_unchanged: int
    stage: RunStage = RunStage.SUCCEEDED

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        _text(self.dataset, "dataset")
        for field in ("records_read", "records_written", "records_unchanged"):
            value = getattr(self, field)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{field} must be a non-negative integer")
        if self.records_written + self.records_unchanged != self.records_read:
            raise ValueError("reprocess outcomes must account for every source row")
        if self.stage not in {
            RunStage.SUCCEEDED,
            RunStage.SKIPPED_LOCKED,
            RunStage.SKIPPED_DISABLED,
        }:
            raise ValueError("reprocess result stage is invalid")
        if (
            self.stage in {RunStage.SKIPPED_LOCKED, RunStage.SKIPPED_DISABLED}
            and self.records_read != 0
        ):
            raise ValueError("a skipped reprocess cannot report source rows")


class Reprocess:
    """Agrupa o estado e as operações de ``Reprocess`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        *,
        registry: DatasetRegistry,
        reader_factory: Callable[[], SourceReader],
        hot_sink: HotRecordSink | Callable[[], HotRecordSink],
        leases: LeaseRepository | Callable[[], LeaseRepository],
        live_sync_configuration: LiveSyncConfiguration,
        manifests: ManifestRepository | Callable[[], ManifestRepository] | None = None,
        dataset_version_observer: Callable[[str], None] | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        normalization_context: Callable[[SourceReader], NormalizationContext] | None = None,
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            registry: Entrada ``registry``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            reader_factory: Fábrica injetada que cria a dependência somente quando necessária.
            hot_sink: Destino injetado ou fábrica resolvida após autorização e validação.
            leases: Repositório ou fábrica resolvida após autorização e validação.
            live_sync_configuration: Configuração consultada uma vez antes de obter trabalho.
            clock: Função injetável que fornece o instante atual para validação e testes.
            normalization_context: Entrada ``normalization_context``; a forma aceita é definida
            pela anotação de tipo e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._registry = registry
        self._reader_factory = reader_factory
        self._hot_sink = hot_sink
        self._leases = leases
        self._live_sync_configuration = live_sync_configuration
        self._manifests = manifests
        self._dataset_version_observer = dataset_version_observer or (lambda _version: None)
        self._clock = clock
        self._normalization_context = normalization_context or (
            lambda _reader: NormalizationContext()
        )

    def execute(self, request: ReprocessRequest) -> ReprocessResult:
        """Executa o caso de uso implementado por ``Reprocess``.

        Args:
            request: Objeto de entrada já estruturado para o caso de uso.

        Returns:
            Valor ``ReprocessResult`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(request, ReprocessRequest):
            raise TypeError("request must be a ReprocessRequest")
        if not self._live_sync_configuration.is_enabled():
            return ReprocessResult(request.dataset, 0, 0, 0, RunStage.SKIPPED_DISABLED)
        descriptor = self._registry.require(request.dataset)
        if not descriptor.supports_live_window_sync:
            raise ValueError(
                "reprocess requires a dataset eligible for bounded live-window reprocess"
            )
        dataset_version = request.dataset_version
        if self._manifests is not None:
            manifests = self._manifests() if callable(self._manifests) else self._manifests
            active = validate_active_manifest_identity(
                manifests.get_active(),
                registry=self._registry,
            )
            if dataset_version is not None and dataset_version != active.dataset_version:
                raise ActiveManifestError(
                    "reprocess dataset version does not match the ACTIVE representation"
                )
            dataset_version = active.dataset_version
        if dataset_version is None:
            raise ActiveManifestError("reprocess requires an ACTIVE dataset version")
        self._dataset_version_observer(dataset_version)
        source = str(self._registry.snapshot["sourceSystem"])
        hot_sink = self._hot_sink() if callable(self._hot_sink) else self._hot_sink
        leases = self._leases() if callable(self._leases) else self._leases
        lease = LeaseGuard(
            leases,
            (source,),
            f"reprocess-{request.run_id}",
            request.lease_ttl_seconds,
            self._clock,
        )
        if not lease.try_acquire():
            return ReprocessResult(request.dataset, 0, 0, 0, RunStage.SKIPPED_LOCKED)
        try:
            lease.checkpoint()
            reader = self._reader_factory()
            schema = reader.validate_schema(descriptor)
            if not schema.is_compatible:
                raise ValueError("reprocess source schema is incompatible")
            context = self._normalization_context(reader)
            if not isinstance(context, NormalizationContext):
                raise TypeError("normalization_context must return NormalizationContext")
            after = None
            page_number = read = written = unchanged = 0
            while True:
                lease.checkpoint()
                page = reader.read_page(descriptor, request.window, after, request.page_size)
                if not page.rows:
                    break
                records = tuple(normalize_row(descriptor, row, context) for row in page.rows)
                grouped: dict[str, list[CanonicalRecord]] = {}
                for record in records:
                    partition = archive_partition_key(
                        record,
                        descriptor,
                        snapshot_date=request.window.end.date(),
                    )
                    grouped.setdefault(partition, []).append(record)
                for partition, values in sorted(grouped.items()):
                    lease.checkpoint()
                    result = hot_sink.write(
                        tuple(values),
                        dataset_version,
                        partition,
                        idempotency_key=(
                            f"reprocess:{request.run_id}:{request.dataset}:"
                            f"{page_number}:{partition}"
                        ),
                    )
                    if result.written + result.unchanged != len(values):
                        raise ValueError(
                            "hot write reconciliation does not account for every accepted record"
                        )
                    written += result.written
                    unchanged += result.unchanged
                    lease.checkpoint()
                read += len(records)
                if page.next_cursor is None or page.next_cursor == after:
                    raise ValueError("source page cursor did not advance")
                after = page.next_cursor
                page_number += 1
            lease.fence()
            return ReprocessResult(request.dataset, read, written, unchanged)
        finally:
            lease.close()


__all__ = ["Reprocess", "ReprocessRequest", "ReprocessResult"]
