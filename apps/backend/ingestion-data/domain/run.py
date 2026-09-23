"""Modela a máquina de estados explícita de uma execução de ingestão.

Papel no fluxo:
    Este arquivo pertence ao núcleo de domínio e deve permanecer determinístico, sem acesso a
    rede, sistema de arquivos, banco de dados ou variáveis de ambiente.

Garantias e limites:
    As validações falham de forma fechada: valores ambíguos ou incompletos são rejeitados antes
    de atravessar uma porta de persistência.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from enum import StrEnum


class RunStage(StrEnum):
    """Enumera os estados aceitos para execução etapa."""

    STARTING = "STARTING"
    RESTORING = "RESTORING"
    VALIDATING = "VALIDATING"
    INGESTING = "INGESTING"
    EXTRACTING = "EXTRACTING"
    PROJECTING = "PROJECTING"
    ARCHIVING = "ARCHIVING"
    MATERIALIZING_HOT = "MATERIALIZING_HOT"
    FINALIZING_CANDIDATE = "FINALIZING_CANDIDATE"
    ACTIVATING = "ACTIVATING"
    PUBLISHING = "PUBLISHING"
    SUCCEEDED = "SUCCEEDED"
    PARTIAL = "PARTIAL"
    FAILED = "FAILED"
    SKIPPED_LOCKED = "SKIPPED_LOCKED"
    SKIPPED_DISABLED = "SKIPPED_DISABLED"


class RunPipeline(StrEnum):
    """Identifies the immutable execution graph selected for a run."""

    LEGACY_V1 = "legacy-v1"
    CANONICAL_V2 = "canonical-v2"


def materialize_hot_records_for(pipeline: RunPipeline) -> bool:
    """Return the immutable hot-materialization policy for a pipeline."""

    if not isinstance(pipeline, RunPipeline):
        raise TypeError("pipeline must be a RunPipeline")
    return pipeline is RunPipeline.LEGACY_V1


_LEGACY_TRANSITIONS: dict[RunStage, frozenset[RunStage]] = {
    RunStage.STARTING: frozenset({RunStage.RESTORING, RunStage.VALIDATING, RunStage.FAILED}),
    RunStage.RESTORING: frozenset({RunStage.VALIDATING, RunStage.FAILED}),
    RunStage.VALIDATING: frozenset({RunStage.INGESTING, RunStage.FAILED}),
    RunStage.INGESTING: frozenset({RunStage.PROJECTING, RunStage.FAILED}),
    RunStage.PROJECTING: frozenset({RunStage.ARCHIVING, RunStage.FAILED}),
    RunStage.ARCHIVING: frozenset({RunStage.ACTIVATING, RunStage.FAILED}),
    RunStage.ACTIVATING: frozenset({RunStage.PUBLISHING, RunStage.FAILED}),
    RunStage.PUBLISHING: frozenset({RunStage.SUCCEEDED, RunStage.PARTIAL}),
    RunStage.SUCCEEDED: frozenset(),
    RunStage.PARTIAL: frozenset(),
    RunStage.FAILED: frozenset(),
    RunStage.SKIPPED_LOCKED: frozenset(),
    RunStage.SKIPPED_DISABLED: frozenset(),
}

_CANONICAL_TRANSITIONS: dict[RunStage, frozenset[RunStage]] = {
    RunStage.STARTING: frozenset({RunStage.RESTORING, RunStage.VALIDATING, RunStage.FAILED}),
    RunStage.RESTORING: frozenset({RunStage.VALIDATING, RunStage.FAILED}),
    RunStage.VALIDATING: frozenset({RunStage.EXTRACTING, RunStage.FAILED}),
    RunStage.EXTRACTING: frozenset({RunStage.ARCHIVING, RunStage.FAILED}),
    RunStage.ARCHIVING: frozenset({RunStage.PROJECTING, RunStage.FAILED}),
    RunStage.PROJECTING: frozenset({RunStage.MATERIALIZING_HOT, RunStage.FAILED}),
    RunStage.MATERIALIZING_HOT: frozenset({RunStage.FINALIZING_CANDIDATE, RunStage.FAILED}),
    RunStage.FINALIZING_CANDIDATE: frozenset({RunStage.PUBLISHING, RunStage.FAILED}),
    RunStage.PUBLISHING: frozenset({RunStage.SUCCEEDED, RunStage.PARTIAL}),
    RunStage.SUCCEEDED: frozenset(),
    RunStage.PARTIAL: frozenset(),
    RunStage.FAILED: frozenset(),
    RunStage.SKIPPED_LOCKED: frozenset(),
    RunStage.SKIPPED_DISABLED: frozenset(),
}

_TRANSITIONS_BY_PIPELINE = {
    RunPipeline.LEGACY_V1: _LEGACY_TRANSITIONS,
    RunPipeline.CANONICAL_V2: _CANONICAL_TRANSITIONS,
}


def allowed_transitions(pipeline: RunPipeline, stage: RunStage) -> frozenset[RunStage]:
    """Return the allowed next stages for the selected immutable graph."""

    if not isinstance(pipeline, RunPipeline):
        raise TypeError("pipeline must be a RunPipeline")
    if not isinstance(stage, RunStage):
        raise TypeError("stage must be a RunStage")
    graph = _TRANSITIONS_BY_PIPELINE[pipeline]
    try:
        return graph[stage]
    except KeyError as error:
        raise ValueError(
            f"run stage {stage.value} is not valid for pipeline {pipeline.value}"
        ) from error


def _require_non_negative_int(value: object, field: str) -> None:
    """Valida e devolve non negative inteiro, rejeitando entradas fora do contrato.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field} must be an integer")
    if value < 0:
        raise ValueError(f"{field} must be non-negative")


def _validate_progress_detail(
    substage: str | None,
    units_completed: int | None,
    units_total: int | None,
    unit_label: str | None,
) -> None:
    if substage is not None:
        if not isinstance(substage, str):
            raise TypeError("substage must be a string or None")
        if not substage or len(substage) > 128:
            raise ValueError("substage must contain 1 to 128 characters")
    if units_completed is None and units_total is None and unit_label is None:
        return
    if units_completed is None or units_total is None or unit_label is None:
        raise ValueError("unit progress fields must be provided together")
    _require_non_negative_int(units_completed, "units_completed")
    _require_non_negative_int(units_total, "units_total")
    if units_completed > units_total:
        raise ValueError("units_completed must not exceed units_total")
    if not isinstance(unit_label, str):
        raise TypeError("unit_label must be a string or None")
    if not unit_label or len(unit_label) > 128:
        raise ValueError("unit_label must contain 1 to 128 characters")


@dataclass(frozen=True, slots=True)
class RunTransitionMetadata:
    """Representa os dados de ``RunTransitionMetadata`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        transitioned_at: Instante UTC com fuso horário usado pela regra temporal.
        duration_ms: Entrada ``duration_ms``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        records_read: Entrada ``records_read``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.
        records_written: Entrada ``records_written``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        records_rejected: Entrada ``records_rejected``; a forma aceita é definida pela anotação
        de tipo e validada antes do uso.
        error: Entrada ``error``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
    """

    transitioned_at: datetime
    duration_ms: int = 0
    records_read: int = 0
    records_written: int = 0
    records_rejected: int = 0
    error: str | None = None
    substage: str | None = None
    units_completed: int | None = None
    units_total: int | None = None
    unit_label: str | None = None

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(self.transitioned_at, datetime):
            raise TypeError("transitioned_at must be a datetime")
        if self.transitioned_at.tzinfo is None or self.transitioned_at.utcoffset() != timedelta(0):
            raise ValueError("transitioned_at must be an aware UTC datetime")
        for field in ("duration_ms", "records_read", "records_written", "records_rejected"):
            _require_non_negative_int(getattr(self, field), field)
        if self.error is not None:
            if not isinstance(self.error, str):
                raise TypeError("error must be a string or None")
            if not self.error:
                raise ValueError("error must not be empty")
        _validate_progress_detail(
            self.substage,
            self.units_completed,
            self.units_total,
            self.unit_label,
        )


@dataclass(frozen=True, slots=True)
class RunActivity:
    """Public-safe snapshot proving that a long-running stage is still advancing."""

    stage: RunStage
    stage_started_at: datetime
    observed_at: datetime
    records_read: int = 0
    records_written: int = 0
    records_rejected: int = 0
    records_total: int | None = None
    current_dataset: str | None = None
    datasets_completed: int = 0
    datasets_total: int = 0
    substage: str | None = None
    units_completed: int | None = None
    units_total: int | None = None
    unit_label: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.stage, RunStage):
            raise TypeError("stage must be a RunStage")
        for field in ("stage_started_at", "observed_at"):
            value = getattr(self, field)
            if not isinstance(value, datetime):
                raise TypeError(f"{field} must be a datetime")
            if value.tzinfo is None or value.utcoffset() != timedelta(0):
                raise ValueError(f"{field} must be an aware UTC datetime")
        if self.observed_at < self.stage_started_at:
            raise ValueError("observed_at must not precede stage_started_at")
        for field in (
            "records_read",
            "records_written",
            "records_rejected",
            "datasets_completed",
            "datasets_total",
        ):
            _require_non_negative_int(getattr(self, field), field)
        if self.records_total is not None:
            _require_non_negative_int(self.records_total, "records_total")
            if self.records_read > self.records_total:
                raise ValueError("records_read must not exceed records_total")
        if self.datasets_completed > self.datasets_total:
            raise ValueError("datasets_completed must not exceed datasets_total")
        if self.current_dataset is not None:
            if not isinstance(self.current_dataset, str):
                raise TypeError("current_dataset must be a string or None")
            if not self.current_dataset or len(self.current_dataset) > 128:
                raise ValueError("current_dataset must contain 1 to 128 characters")
        _validate_progress_detail(
            self.substage,
            self.units_completed,
            self.units_total,
            self.unit_label,
        )


@dataclass(frozen=True, slots=True)
class RunState:
    """Representa os dados de ``RunState`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        run_id: Identificador não secreto e estável da execução.
        dataset_version: Identificador imutável da versão do dataset.
        stage: Entrada ``stage``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        active_dataset_version: Versão imutável usada para identidade e compatibilidade.
    """

    run_id: str
    dataset_version: str
    stage: RunStage
    active_dataset_version: str | None = None
    pipeline: RunPipeline = RunPipeline.LEGACY_V1

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(self.run_id, str):
            raise TypeError("run_id must be a string")
        if not self.run_id:
            raise ValueError("run_id must not be empty")
        if not isinstance(self.dataset_version, str):
            raise TypeError("dataset_version must be a string")
        if not self.dataset_version:
            raise ValueError("dataset_version must not be empty")
        if not isinstance(self.stage, RunStage):
            raise TypeError("stage must be a RunStage")
        if not isinstance(self.pipeline, RunPipeline):
            raise TypeError("pipeline must be a RunPipeline")
        allowed_transitions(self.pipeline, self.stage)
        if self.active_dataset_version is not None:
            if not isinstance(self.active_dataset_version, str):
                raise TypeError("active_dataset_version must be a string or None")
            if not self.active_dataset_version:
                raise ValueError("active_dataset_version must not be empty")

    @classmethod
    def start(
        cls,
        run_id: str,
        dataset_version: str,
        *,
        pipeline: RunPipeline = RunPipeline.LEGACY_V1,
    ) -> RunState:
        """Inicia o processamento ou recurso gerenciado pela instância.

        Args:
            run_id: Identificador não secreto e estável da execução.
            dataset_version: Identificador imutável da versão do dataset.

        Returns:
            Valor ``RunState`` produzido pela operação após as validações.
        """
        return cls(run_id, dataset_version, RunStage.STARTING, pipeline=pipeline)

    @classmethod
    def at(
        cls,
        stage: RunStage,
        *,
        active_dataset_version: str | None = None,
        run_id: str = "run-at",
        dataset_version: str | None = None,
        pipeline: RunPipeline = RunPipeline.LEGACY_V1,
    ) -> RunState:
        """Executa a etapa interna ``at`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            stage: Entrada ``stage``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            active_dataset_version: Versão imutável usada para identidade e compatibilidade.
            run_id: Identificador não secreto e estável da execução.
            dataset_version: Identificador imutável da versão do dataset.

        Returns:
            Valor ``RunState`` produzido pela operação após as validações.
        """
        candidate_version = dataset_version if dataset_version is not None else "dataset-at"
        return cls(run_id, candidate_version, stage, active_dataset_version, pipeline)

    def transition(
        self,
        target: RunStage,
        *,
        mark_candidate_active: bool = False,
    ) -> RunState:
        """Aplica uma transição usando o estado previamente observado como proteção.

        Args:
            target: Estado ou destino solicitado para a operação.
            mark_candidate_active: Entrada ``mark_candidate_active``; a forma aceita é definida
            pela anotação de tipo e validada antes do uso.

        Returns:
            Valor ``RunState`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(target, RunStage):
            raise TypeError("target must be a RunStage")
        if type(mark_candidate_active) is not bool:
            raise TypeError("mark_candidate_active must be a boolean")
        if mark_candidate_active and target is not RunStage.PUBLISHING:
            raise ValueError("candidate activation can only be confirmed when publishing")
        allowed = allowed_transitions(self.pipeline, self.stage)
        if target not in allowed:
            if not allowed:
                raise ValueError(f"run stage {self.stage} is terminal")
            expected = ", ".join(sorted(stage.value for stage in allowed))
            raise ValueError(
                f"invalid transition from {self.stage} to {target}; expected {expected}"
            )
        active_version = self.active_dataset_version
        if mark_candidate_active:
            active_version = self.dataset_version
        return replace(self, stage=target, active_dataset_version=active_version)


@dataclass(frozen=True, slots=True)
class RunProgress:
    """Stage and cumulative counters read atomically from the durable run record."""

    state: RunState
    updated_at: datetime
    records_read: int
    records_written: int
    records_rejected: int


__all__ = [
    "RunPipeline",
    "RunProgress",
    "RunStage",
    "RunState",
    "RunTransitionMetadata",
    "allowed_transitions",
    "materialize_hot_records_for",
]
