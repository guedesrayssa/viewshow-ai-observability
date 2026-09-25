"""Controla o espaço local pertencente à ingestão antes de novas alocações.

Papel no fluxo:
    Este arquivo pertence ao núcleo de domínio e deve permanecer determinístico, sem acesso a
    rede, sistema de arquivos, banco de dados ou variáveis de ambiente.

Garantias e limites:
    As validações falham de forma fechada: valores ambíguos ou incompletos são rejeitados antes
    de atravessar uma porta de persistência.
"""

from __future__ import annotations

import errno
import shutil
import stat
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Literal, Protocol

type FreeBytes = Callable[[Path], int]
type DiskUsageReason = Literal["observe", "reserve", "heartbeat", "fatal"]

FARGATE_EPHEMERAL_STORAGE_BYTES = 200 * 1024**3
# A task de import/backfill executa um sidecar MySQL efêmero no mesmo storage de 200 GiB. O
# orçamento da ingestão fica significativamente abaixo dessa capacidade, sem tentar adivinhar a
# ocupação variável do sidecar em disco.
DEFAULT_INGESTION_DISK_BUDGET_BYTES = 8 * 1024**3
SNAPSHOT_INGESTION_DISK_BUDGET_BYTES = 64 * 1024**3
MAX_INGESTION_DISK_BUDGET_BYTES = 128 * 1024**3


class DiskBudgetExceeded(RuntimeError):
    """Indica que ``DiskBudgetExceeded`` impediu a operação de continuar com segurança."""


class DiskUsageReporter(Protocol):
    """Recebe snapshots escalares de disco sem acoplar o domínio ao backend de métricas."""

    def report_disk_usage(
        self,
        current_bytes: int,
        peak_bytes: int,
        budget_bytes: int,
        *,
        reason: DiskUsageReason,
    ) -> None: ...


@dataclass(frozen=True, slots=True)
class DiskUsage:
    """Representa os dados de ``DiskUsage`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        budget_bytes: Quantidade de bytes usada como tamanho ou limite.
        used_bytes: Quantidade de bytes usada como tamanho ou limite.
        peak_bytes: Quantidade de bytes usada como tamanho ou limite.
        free_bytes: Quantidade de bytes usada como tamanho ou limite.
        artifacts: Entrada ``artifacts``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
    """

    budget_bytes: int
    used_bytes: int
    peak_bytes: int
    free_bytes: int
    artifacts: Mapping[str, int]

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        values = (self.budget_bytes, self.used_bytes, self.peak_bytes, self.free_bytes)
        if any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in values
        ):
            raise ValueError("disk usage values must be non-negative integers")
        if self.used_bytes > self.budget_bytes:
            raise ValueError("used bytes cannot exceed the configured budget")
        normalized = dict(self.artifacts)
        if any(
            not isinstance(name, str)
            or not name
            or isinstance(value, bool)
            or not isinstance(value, int)
            or value < 0
            for name, value in normalized.items()
        ):
            raise ValueError("artifact byte counters must be non-negative integers")
        if sum(normalized.values()) != self.used_bytes:
            raise ValueError("artifact byte counters must equal used bytes")
        object.__setattr__(self, "artifacts", MappingProxyType(normalized))


class DiskBudget:
    """Agrupa o estado e as operações de ``DiskBudget`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        root: Path,
        budget_bytes: int,
        *,
        free_bytes: FreeBytes | None = None,
        usage_reporter: DiskUsageReporter | None = None,
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            root: Entrada ``root``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            budget_bytes: Quantidade de bytes usada como tamanho ou limite.
            free_bytes: Quantidade de bytes usada como tamanho ou limite.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(root, Path):
            raise TypeError("root must be a Path")
        if (
            isinstance(budget_bytes, bool)
            or not isinstance(budget_bytes, int)
            or not 0 < budget_bytes <= MAX_INGESTION_DISK_BUDGET_BYTES
        ):
            raise ValueError("budget_bytes must be between 1 and 128 GiB")
        if free_bytes is not None and not callable(free_bytes):
            raise TypeError("free_bytes must be callable or None")
        if usage_reporter is not None and not callable(
            getattr(usage_reporter, "report_disk_usage", None)
        ):
            raise TypeError("usage_reporter must implement report_disk_usage or be None")
        self._root = root
        self._budget_bytes = budget_bytes
        self._free_bytes = free_bytes or self._filesystem_free_bytes
        self._usage_reporter = usage_reporter
        self._peak_bytes = 0
        self._last_used_bytes = 0
        self._last_fatal_observation: tuple[int, int] | None = None
        self._lock = threading.RLock()

    @property
    def root(self) -> Path:
        """Executa a etapa interna ``root`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``Path`` produzido pela operação após as validações.
        """
        return self._root

    @property
    def budget_bytes(self) -> int:
        """Converte budget para sua representação binária determinística.

        Returns:
            Valor ``int`` produzido pela operação após as validações.
        """
        return self._budget_bytes

    @staticmethod
    def _filesystem_free_bytes(path: Path) -> int:
        """Converte filesystem livre para sua representação binária determinística.

        Args:
            path: Caminho local do artefato lido ou produzido.

        Returns:
            Valor ``int`` produzido pela operação após as validações.
        """
        return shutil.disk_usage(path).free

    def _probe_path(self) -> Path:
        """Monta o caminho de probe sem permitir escapar do diretório autorizado.

        Returns:
            Valor ``Path`` produzido pela operação após as validações.

        Raises:
            DiskBudgetExceeded: Se a operação não puder preservar as invariantes descritas.
        """
        probe = self._root
        while not probe.exists() and probe != probe.parent:
            probe = probe.parent
        if not probe.is_dir():
            raise DiskBudgetExceeded("disk budget root has no existing directory parent")
        return probe

    def _free(self) -> int:
        """Executa a etapa interna ``free`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``int`` produzido pela operação após as validações.

        Raises:
            DiskBudgetExceeded: Se a operação não puder preservar as invariantes descritas.
        """
        try:
            value = self._free_bytes(self._probe_path())
        except Exception as error:
            raise DiskBudgetExceeded("could not inspect filesystem free space") from error
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise DiskBudgetExceeded("disk free-space probe returned an invalid byte count")
        return value

    @staticmethod
    def _category(path: Path) -> str:
        """Executa a etapa interna ``category`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            path: Caminho local do artefato lido ou produzido.

        Returns:
            Valor ``str`` produzido pela operação após as validações.
        """
        name = path.name
        if name.endswith(".jsonl"):
            return "jsonlBytes"
        if ".sqlite3" in name:
            return "sqliteBytes"
        if name.endswith(".parquet"):
            return "parquetBytes"
        if name.endswith(".tmp"):
            return "temporaryBytes"
        return "otherBytes"

    def _artifact_bytes(self) -> dict[str, int]:
        """Converte artifact para sua representação binária determinística.

        Returns:
            Valor ``dict[str, int]`` produzido pela operação após as validações.

        Raises:
            DiskBudgetExceeded: Se a operação não puder preservar as invariantes descritas.
        """
        values: dict[str, int] = {}
        if not self._root.exists():
            return values
        try:
            paths = self._root.rglob("*")
            for path in paths:
                try:
                    metadata = path.lstat()
                except FileNotFoundError:
                    continue
                except OSError as error:
                    if error.errno == errno.ENOENT:
                        continue
                    raise
                if stat.S_ISREG(metadata.st_mode):
                    category = self._category(path)
                    values[category] = values.get(category, 0) + metadata.st_size
        except OSError as error:
            raise DiskBudgetExceeded("could not inspect ingestion-owned disk artifacts") from error
        return values

    def _report(self, current_bytes: int, reason: DiskUsageReason) -> None:
        reporter = self._usage_reporter
        if reporter is None:
            return
        observation = (current_bytes, self._peak_bytes)
        if reason == "fatal":
            if observation == self._last_fatal_observation:
                return
            self._last_fatal_observation = observation
        try:
            reporter.report_disk_usage(
                current_bytes,
                self._peak_bytes,
                self._budget_bytes,
                reason=reason,
            )
        except Exception:
            # Telemetry is best-effort and cannot change disk-safety decisions.
            return

    def _observe(self, reason: DiskUsageReason) -> DiskUsage:
        with self._lock:
            try:
                artifacts = self._artifact_bytes()
            except DiskBudgetExceeded:
                self._report(self._last_used_bytes, "fatal")
                raise
            used = sum(artifacts.values())
            self._last_used_bytes = used
            self._peak_bytes = max(self._peak_bytes, used)
            if used > self._budget_bytes:
                self._report(used, "fatal")
                raise DiskBudgetExceeded(
                    "ingestion-owned disk artifacts exceed the configured budget"
                )
            try:
                free = self._free()
            except DiskBudgetExceeded:
                self._report(used, "fatal")
                raise
            usage = DiskUsage(self._budget_bytes, used, self._peak_bytes, free, artifacts)
            self._report(used, reason)
            return usage

    def observe(self) -> DiskUsage:
        """Observa a entrada sem alterar o resultado da operação decorada.

        Returns:
            Valor ``DiskUsage`` produzido pela operação após as validações.

        Raises:
            DiskBudgetExceeded: Se a operação não puder preservar as invariantes descritas.
        """
        return self._observe("observe")

    def heartbeat(self) -> DiskUsage:
        """Observe disk during the bounded lease heartbeat."""
        return self._observe("heartbeat")

    def report_fatal(self) -> None:
        """Best-effort final observation used before a failed run is unwound."""
        try:
            self._observe("fatal")
        except DiskBudgetExceeded:
            return

    def preflight(self, operation: str, *, required_bytes: int | None = None) -> DiskUsage:
        """Executa a etapa interna ``preflight`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            operation: Entrada ``operation``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            required_bytes: Quantidade de bytes usada como tamanho ou limite.

        Returns:
            Valor ``DiskUsage`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
            DiskBudgetExceeded: Se a operação não puder preservar as invariantes descritas.
        """
        if not isinstance(operation, str) or not operation:
            raise ValueError("operation must be non-empty text")
        usage = self._observe("reserve")
        required = (
            self._budget_bytes - usage.used_bytes if required_bytes is None else required_bytes
        )
        if isinstance(required, bool) or not isinstance(required, int) or required < 0:
            raise ValueError("required_bytes must be a non-negative integer or None")
        if required > self._budget_bytes - usage.used_bytes:
            with self._lock:
                self._report(usage.used_bytes, "fatal")
            raise DiskBudgetExceeded(
                f"disk budget is insufficient for {operation}: requires {required} bytes"
            )
        if usage.free_bytes < required:
            with self._lock:
                self._report(usage.used_bytes, "fatal")
            raise DiskBudgetExceeded(
                f"free disk is insufficient for {operation}: requires {required} bytes"
            )
        return usage

    def reserve(self, additional_bytes: int, operation: str) -> DiskUsage:
        """Reserva espaço para a entrada antes de iniciar a alocação.

        Args:
            additional_bytes: Quantidade de bytes usada como tamanho ou limite.
            operation: Entrada ``operation``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``DiskUsage`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
            DiskBudgetExceeded: Se a operação não puder preservar as invariantes descritas.
        """
        if isinstance(additional_bytes, bool) or not isinstance(additional_bytes, int):
            raise TypeError("additional_bytes must be an integer")
        if additional_bytes < 0:
            raise ValueError("additional_bytes must be non-negative")
        if not isinstance(operation, str) or not operation:
            raise ValueError("operation must be non-empty text")
        usage = self._observe("reserve")
        if additional_bytes > self._budget_bytes - usage.used_bytes:
            with self._lock:
                self._report(usage.used_bytes, "fatal")
            raise DiskBudgetExceeded(
                f"disk budget is insufficient for {operation}: requires {additional_bytes} bytes"
            )
        if usage.free_bytes < additional_bytes:
            with self._lock:
                self._report(usage.used_bytes, "fatal")
            raise DiskBudgetExceeded(
                f"free disk is insufficient for {operation}: requires {additional_bytes} bytes"
            )
        return usage


__all__ = [
    "DEFAULT_INGESTION_DISK_BUDGET_BYTES",
    "FARGATE_EPHEMERAL_STORAGE_BYTES",
    "MAX_INGESTION_DISK_BUDGET_BYTES",
    "SNAPSHOT_INGESTION_DISK_BUDGET_BYTES",
    "DiskBudget",
    "DiskBudgetExceeded",
    "DiskUsage",
    "DiskUsageReason",
    "DiskUsageReporter",
    "FreeBytes",
]
