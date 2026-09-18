"""Divide atrasos de sincronização em janelas completas executadas em ordem.

Papel no fluxo:
    No fluxo da aplicação, este módulo coordena regras do domínio por meio das interfaces de
    ``ports`` e não depende diretamente de SDKs ou formatos de infraestrutura.

Garantias e limites:
    A ordem das operações preserva idempotência, reconciliação e retomada segura quando uma
    execução é interrompida.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from types import MappingProxyType
from typing import Protocol

from application.sync import SyncRequest, SyncResult, SyncSourceResult
from domain.disk_budget import DiskUsage
from domain.models import TimeWindow
from domain.run import RunStage
from ports import LiveSyncConfiguration

_WINDOW_SECONDS = 900
_DEFAULT_MAX_WINDOWS = 96
_ANOMALY_EVENT_TYPE = "ANOMALY_DETECTION"
_QOE_EVENT_TYPE = "QOE_FORECAST"
_QOE_SECONDS = 3600


class SyncWindowRunner(Protocol):
    """Define o contrato mínimo de sync janela runner usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def execute(self, request: SyncRequest) -> SyncResult:
        """Executa o caso de uso implementado por ``SyncWindowRunner``.

        Args:
            request: Objeto de entrada já estruturado para o caso de uso.

        Returns:
            Valor ``SyncResult`` produzido pela operação após as validações.
        """
        ...


@dataclass(frozen=True, slots=True)
class SyncCatchupRequest:
    """Representa os dados de ``SyncCatchupRequest`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        run_id: Identificador não secreto e estável da execução.
        dataset_version: Identificador imutável da versão do dataset.
        latest_window: Entrada ``latest_window``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        dataset_names: Entrada ``dataset_names``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        page_size: Entrada ``page_size``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        analysis_watermarks: Entrada ``analysis_watermarks``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        source_watermarks: Entrada ``source_watermarks``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        lease_ttl_seconds: Duração ou prazo expresso em segundos.
        max_windows: Entrada ``max_windows``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        source_grain_seconds: Duração ou prazo expresso em segundos.
    """

    run_id: str
    dataset_version: str
    latest_window: TimeWindow
    dataset_names: tuple[str, ...]
    page_size: int = 500
    analysis_watermarks: Mapping[str, datetime] = MappingProxyType({})
    source_watermarks: Mapping[str, datetime] = MappingProxyType({})
    lease_ttl_seconds: int = 300
    max_windows: int = _DEFAULT_MAX_WINDOWS
    source_grain_seconds: Mapping[str, int | None] = MappingProxyType({})

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        validated = SyncRequest(
            run_id=self.run_id,
            dataset_version=self.dataset_version,
            window=self.latest_window,
            dataset_names=self.dataset_names,
            page_size=self.page_size,
            analysis_watermarks=self.analysis_watermarks,
            source_watermarks=self.source_watermarks,
            lease_ttl_seconds=self.lease_ttl_seconds,
        )
        if (
            self.latest_window.grain_seconds != _WINDOW_SECONDS
            or (self.latest_window.end - self.latest_window.start).total_seconds()
            != _WINDOW_SECONDS
            or int(self.latest_window.end.timestamp()) % _WINDOW_SECONDS != 0
        ):
            raise ValueError("latest_window must be one closed fifteen-minute window")
        if isinstance(self.max_windows, bool) or not isinstance(self.max_windows, int):
            raise TypeError("max_windows must be an integer")
        if self.max_windows <= 0:
            raise ValueError("max_windows must be positive")
        source_grains = dict(self.source_grain_seconds)
        if not set(source_grains) <= set(validated.dataset_names):
            raise ValueError("source_grain_seconds must contain only requested datasets")
        if any(
            value is not None
            and (
                isinstance(value, bool)
                or not isinstance(value, int)
                or value <= 0
                or value % _WINDOW_SECONDS != 0
            )
            for value in source_grains.values()
        ):
            raise ValueError(
                "source_grain_seconds must contain positive fifteen-minute-aligned values or None"
            )
        object.__setattr__(self, "dataset_names", validated.dataset_names)
        object.__setattr__(self, "analysis_watermarks", validated.analysis_watermarks)
        object.__setattr__(self, "source_watermarks", validated.source_watermarks)
        object.__setattr__(self, "source_grain_seconds", MappingProxyType(source_grains))


def _window_end_after(start: datetime, boundary: datetime) -> datetime:
    """Executa a etapa interna ``window_end_after`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        start: Entrada ``start``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        boundary: Entrada ``boundary``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``datetime`` produzido pela operação após as validações.
    """
    next_boundary = datetime.fromtimestamp(
        (int(start.timestamp()) // _WINDOW_SECONDS + 1) * _WINDOW_SECONDS,
        UTC,
    )
    return min(next_boundary, boundary)


def _window_count(start: datetime, boundary: datetime) -> int:
    """Executa a etapa interna ``window_count`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        start: Entrada ``start``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        boundary: Entrada ``boundary``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``int`` produzido pela operação após as validações.
    """
    if start >= boundary:
        return 0
    first_end = _window_end_after(start, boundary)
    if first_end == boundary:
        return 1
    return 1 + int((boundary - first_end).total_seconds() // _WINDOW_SECONDS)


def _source_grain_seconds(request: SyncCatchupRequest, dataset: str) -> int:
    """Executa a etapa interna ``source_grain_seconds`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        request: Objeto de entrada já estruturado para o caso de uso.
        dataset: Nome do dataset permitido pelo registro de contratos.

    Returns:
        Valor ``int`` produzido pela operação após as validações.
    """
    return request.source_grain_seconds.get(dataset) or _WINDOW_SECONDS


def _source_is_eligible_at(request: SyncCatchupRequest, dataset: str, boundary: datetime) -> bool:
    """Verifica a condição associada a fonte is eligible at.

    Args:
        request: Objeto de entrada já estruturado para o caso de uso.
        dataset: Nome do dataset permitido pelo registro de contratos.
        boundary: Entrada ``boundary``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.
    """
    return int(boundary.timestamp()) % _source_grain_seconds(request, dataset) == 0


def _source_window_start_after(
    request: SyncCatchupRequest, dataset: str, watermark: datetime, boundary: datetime
) -> datetime | None:
    """Executa a etapa interna ``source_window_start_after`` e devolve o resultado validado
    indicado pela assinatura.

    Args:
        request: Objeto de entrada já estruturado para o caso de uso.
        dataset: Nome do dataset permitido pelo registro de contratos.
        watermark: Entrada ``watermark``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        boundary: Entrada ``boundary``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``datetime | None`` produzido pela operação após as validações.
    """
    if watermark >= boundary:
        return None
    grain_seconds = _source_grain_seconds(request, dataset)
    if grain_seconds == _WINDOW_SECONDS:
        return watermark
    next_boundary = datetime.fromtimestamp(
        (int(watermark.timestamp()) // grain_seconds + 1) * grain_seconds,
        UTC,
    )
    if next_boundary > boundary:
        return None
    return next_boundary - timedelta(seconds=_WINDOW_SECONDS)


def _first_window_start(request: SyncCatchupRequest) -> datetime | None:
    """Executa a etapa interna ``first_window_start`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        request: Objeto de entrada já estruturado para o caso de uso.

    Returns:
        Valor ``datetime | None`` produzido pela operação após as validações.
    """
    boundary = request.latest_window.end
    source_prior = {
        dataset: watermark
        for dataset in request.dataset_names
        if (watermark := request.source_watermarks.get(dataset)) is not None
        and watermark <= boundary
    }
    durable = [
        candidate
        for dataset, watermark in source_prior.items()
        if (candidate := _source_window_start_after(request, dataset, watermark, boundary))
        is not None
    ]
    subwindow_source_prior = tuple(
        watermark
        for dataset, watermark in source_prior.items()
        if _source_grain_seconds(request, dataset) == _WINDOW_SECONDS
    )
    anomaly = request.analysis_watermarks.get(_ANOMALY_EVENT_TYPE)
    if anomaly is not None and anomaly < boundary:
        durable.append(anomaly)
    elif anomaly is None and subwindow_source_prior:
        durable.append(min(subwindow_source_prior) - timedelta(seconds=_WINDOW_SECONDS))

    qoe = request.analysis_watermarks.get(_QOE_EVENT_TYPE)
    if qoe is not None:
        next_qoe_boundary = datetime.fromtimestamp(
            (int(qoe.timestamp()) // _QOE_SECONDS + 1) * _QOE_SECONDS,
            UTC,
        )
        if next_qoe_boundary <= boundary:
            durable.append(next_qoe_boundary - timedelta(seconds=_WINDOW_SECONDS))
    elif int(boundary.timestamp()) % _QOE_SECONDS == 0 and source_prior:
        durable.append(request.latest_window.start)

    if durable:
        earliest = min(durable)
        return datetime.fromtimestamp(
            int(earliest.timestamp()) // _WINDOW_SECONDS * _WINDOW_SECONDS,
            UTC,
        )
    if (
        any(
            dataset not in request.source_watermarks
            and _source_is_eligible_at(request, dataset, boundary)
            for dataset in request.dataset_names
        )
        or anomaly is None
        or (qoe is None and int(boundary.timestamp()) % _QOE_SECONDS == 0)
    ):
        return request.latest_window.start
    return None


def _sub_run_id(parent_run_id: str, window: TimeWindow) -> str:
    """Calcula ou valida o identificador de sub execução.

    Args:
        parent_run_id: Identificador estável da entidade ou operação correspondente.
        window: Janela temporal UTC, fechada no início e aberta no fim.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return (
        f"{parent_run_id}:window:{int(window.start.timestamp() * 1000)}"
        f"-{int(window.end.timestamp() * 1000)}"
    )


def _later(current: datetime | None, candidate: datetime | None) -> datetime | None:
    """Executa a etapa interna ``later`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        current: Entrada ``current``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        candidate: Manifesto candidato que poderá se tornar ativo.

    Returns:
        Valor ``datetime | None`` produzido pela operação após as validações.
    """
    if candidate is None or (current is not None and candidate <= current):
        return current
    return candidate


@dataclass(slots=True)
class _Aggregate:
    """Representa os dados de ``_Aggregate`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        sources: Entrada ``sources``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        analysis_watermarks: Entrada ``analysis_watermarks``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        source_watermarks: Entrada ``source_watermarks``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        new_analysis_events: Entrada ``new_analysis_events``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        local_disk_usage: Entrada ``local_disk_usage``; a forma aceita é definida pela anotação
        de tipo e validada antes do uso.
    """

    sources: dict[str, SyncSourceResult]
    analysis_watermarks: dict[str, datetime]
    source_watermarks: dict[str, datetime]
    new_analysis_events: int = 0
    local_disk_usage: DiskUsage | None = None

    def merge(self, result: SyncResult) -> None:
        """Combina resultados compatíveis sem ocultar lacunas ou falhas.

        Args:
            result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self.new_analysis_events += result.new_analysis_events
        for event_type, watermark in result.analysis_watermarks.items():
            current = self.analysis_watermarks.get(event_type)
            if current is None or watermark > current:
                self.analysis_watermarks[event_type] = watermark
        for dataset, source in result.sources.items():
            source_watermark = _later(self.source_watermarks.get(dataset), source.watermark)
            if source_watermark is not None:
                self.source_watermarks[dataset] = source_watermark
            prior = self.sources.get(dataset)
            if prior is None:
                self.sources[dataset] = SyncSourceResult(
                    dataset,
                    source.succeeded,
                    source.records_written,
                    source.records_unchanged,
                    source_watermark,
                    source.error,
                    source.latest_observed_at,
                )
                continue
            self.sources[dataset] = SyncSourceResult(
                dataset,
                prior.succeeded and source.succeeded,
                prior.records_written + source.records_written,
                prior.records_unchanged + source.records_unchanged,
                source_watermark,
                prior.error or source.error,
                _later(prior.latest_observed_at, source.latest_observed_at),
            )
        if result.local_disk_usage is not None and (
            self.local_disk_usage is None
            or result.local_disk_usage.peak_bytes > self.local_disk_usage.peak_bytes
        ):
            self.local_disk_usage = result.local_disk_usage

    def result(
        self,
        *,
        stage: RunStage,
        publication_error: str | None = None,
    ) -> SyncResult:
        """Consolida e devolve o resultado validado da execução atual.

        Args:
            stage: Entrada ``stage``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            publication_error: Entrada ``publication_error``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.

        Returns:
            Valor ``SyncResult`` produzido pela operação após as validações.
        """
        return SyncResult(
            self.sources,
            self.analysis_watermarks,
            self.new_analysis_events,
            publication_error,
            stage,
            self.local_disk_usage,
        )


class SyncCatchup:
    """Agrupa o estado e as operações de ``SyncCatchup`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self, sync: SyncWindowRunner, live_sync_configuration: LiveSyncConfiguration
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            sync: Entrada ``sync``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            live_sync_configuration: Configuração consultada uma vez antes da primeira janela.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._sync = sync
        self._live_sync_configuration = live_sync_configuration

    def execute(self, request: SyncCatchupRequest) -> SyncResult:
        """Executa o caso de uso implementado por ``SyncCatchup``.

        Args:
            request: Objeto de entrada já estruturado para o caso de uso.

        Returns:
            Valor ``SyncResult`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        if not isinstance(request, SyncCatchupRequest):
            raise TypeError("request must be a SyncCatchupRequest")
        if not self._live_sync_configuration.is_enabled():
            return SyncResult({}, request.analysis_watermarks, 0, stage=RunStage.SKIPPED_DISABLED)
        start = _first_window_start(request)
        if start is None:
            return SyncResult({}, request.analysis_watermarks, 0)
        total_windows = _window_count(start, request.latest_window.end)
        aggregate = _Aggregate(
            {},
            dict(request.analysis_watermarks),
            dict(request.source_watermarks),
        )
        current = start
        processed = 0
        while current < request.latest_window.end and processed < request.max_windows:
            end = _window_end_after(current, request.latest_window.end)
            window = TimeWindow(current, end, _WINDOW_SECONDS)
            result = self._sync.execute(
                SyncRequest(
                    run_id=_sub_run_id(request.run_id, window),
                    dataset_version=request.dataset_version,
                    window=window,
                    dataset_names=request.dataset_names,
                    page_size=request.page_size,
                    analysis_watermarks=aggregate.analysis_watermarks,
                    source_watermarks=aggregate.source_watermarks,
                    lease_ttl_seconds=request.lease_ttl_seconds,
                )
            )
            if result.stage is RunStage.SKIPPED_LOCKED and processed == 0:
                return result
            aggregate.merge(result)
            processed += 1
            if result.stage is not RunStage.SUCCEEDED:
                return aggregate.result(
                    stage=RunStage.PARTIAL,
                    publication_error=result.publication_error,
                )
            current = end
        if processed < total_windows:
            remaining = total_windows - processed
            return aggregate.result(
                stage=RunStage.PARTIAL,
                publication_error=f"sync catch-up limit reached with {remaining} windows remaining",
            )
        return aggregate.result(stage=RunStage.SUCCEEDED)


DEFAULT_SYNC_MAX_CATCHUP_WINDOWS = _DEFAULT_MAX_WINDOWS


__all__ = [
    "DEFAULT_SYNC_MAX_CATCHUP_WINDOWS",
    "SyncCatchup",
    "SyncCatchupRequest",
]
