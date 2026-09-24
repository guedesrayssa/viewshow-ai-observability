"""Mantém em disco evidências temporais usadas para autorizar eventos de análise.

Papel no fluxo:
    No fluxo da aplicação, este módulo coordena regras do domínio por meio das interfaces de
    ``ports`` e não depende diretamente de SDKs ou formatos de infraestrutura.

Garantias e limites:
    A ordem das operações preserva idempotência, reconciliação e retomada segura quando uma
    execução é interrompida.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterable
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import cast

from domain.canonical_json import canonical_bytes
from domain.disk_budget import DiskBudget
from domain.models import CanonicalRecord, TimeWindow

_MAX_EVIDENCE_INTERVALS = 1_000_000
# O item de marca d'água no DynamoDB transporta esta evidência. Mantemos uma cauda pequena e
# limitada mesmo quando a origem apresenta uma varredura histórica extensa.
_MAX_MANIFEST_INTERVALS = 256
_MAX_LEGACY_EVIDENCE_BYTES = 200 * 1024
_SQLITE_BYTES_PER_RECORD = 4_096
_SQLITE_MINIMUM_BYTES = 32 * 1024
_SQLITE_PAGE_BYTES = 4 * 1024


class BucketEvidenceError(RuntimeError):
    """Indica que ``BucketEvidenceError`` impediu a operação de continuar com segurança."""


def _epoch_ms(value: datetime) -> int:
    """Executa a etapa interna ``epoch_ms`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``int`` produzido pela operação após as validações.

    Raises:
        BucketEvidenceError: Se a operação não puder preservar as invariantes descritas.
    """
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise BucketEvidenceError("bucket evidence requires aware UTC timestamps")
    return int(value.timestamp() * 1000)


def _utc(ms: int) -> datetime:
    """Executa a etapa interna ``utc`` e devolve o resultado validado indicado pela assinatura.

    Args:
        ms: Entrada ``ms``; a forma aceita é definida pela anotação de tipo e validada antes do
        uso.

    Returns:
        Valor ``datetime`` produzido pela operação após as validações.
    """
    return datetime.fromtimestamp(ms / 1000, UTC)


class BucketEvidence:
    """Agrupa o estado e as operações de ``BucketEvidence`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(self, directory: Path, *, disk_budget: DiskBudget | None = None) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            directory: Entrada ``directory``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            disk_budget: Entrada ``disk_budget``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        if not isinstance(directory, Path):
            raise TypeError("directory must be a Path")
        if disk_budget is not None and not isinstance(disk_budget, DiskBudget):
            raise TypeError("disk_budget must be DiskBudget or None")
        directory.mkdir(parents=True, exist_ok=True)
        if disk_budget is not None:
            disk_budget.reserve(_SQLITE_MINIMUM_BYTES, "bucket evidence SQLite initialization")
        with NamedTemporaryFile(
            dir=directory,
            prefix=".bucket-evidence.",
            suffix=".sqlite3",
            delete=False,
        ) as stream:
            self._path = Path(stream.name)
        self._connection: sqlite3.Connection | None = None
        self._disk_budget = disk_budget
        try:
            self._connection = sqlite3.connect(self._path)
            self._connection.execute(f"PRAGMA page_size={_SQLITE_PAGE_BYTES}")
            if disk_budget is not None:
                pages = disk_budget.budget_bytes // _SQLITE_PAGE_BYTES
                self._connection.execute(f"PRAGMA max_page_count={pages}")
            self._connection.execute(
                "CREATE TABLE intervals ("
                "dataset TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, "
                "grain_seconds INTEGER NOT NULL, "
                "PRIMARY KEY(dataset, start_ms, end_ms, grain_seconds))"
            )
            self._connection.execute(
                "CREATE INDEX intervals_by_dataset ON intervals(dataset, start_ms)"
            )
            self._connection.commit()
            if disk_budget is not None:
                disk_budget.observe()
        except BaseException:
            self.close()
            raise

    @staticmethod
    def _interval(record: CanonicalRecord, partition: str | None) -> tuple[int, int, int]:
        """Executa a etapa interna ``interval`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            record: Registro canônico consumido pela operação.
            partition: Identificador canônico da partição física ou lógica.

        Returns:
            Valor ``tuple[int, int, int]`` produzido pela operação após as validações.

        Raises:
            BucketEvidenceError: Se a operação não puder preservar as invariantes descritas.
        """
        if partition is not None and partition.startswith("snapshot_date="):
            try:
                snapshot_date = date.fromisoformat(partition.removeprefix("snapshot_date="))
            except ValueError as error:
                raise BucketEvidenceError("snapshot partition has an invalid date") from error
            start = datetime.combine(snapshot_date, time.min, tzinfo=UTC)
            return _epoch_ms(start), _epoch_ms(start + timedelta(days=1)), 0
        if record.window is not None:
            return (
                _epoch_ms(record.window.start),
                _epoch_ms(record.window.end),
                record.window.grain_seconds,
            )
        if record.observed_at is None:
            raise BucketEvidenceError("event-time record has no canonical observation timestamp")
        point = _epoch_ms(record.observed_at)
        # Registros esparsos são pontos, não evidência de todo o dia que os contém.
        return point, point + 1, 0

    def add(
        self,
        dataset: str,
        records: Iterable[CanonicalRecord],
        *,
        partition: str | None = None,
    ) -> None:
        """Acrescenta a entrada validada ao estado acumulado da instância.

        Args:
            dataset: Nome do dataset permitido pelo registro de contratos.
            records: Registros canônicos consumidos pela operação.
            partition: Identificador canônico da partição física ou lógica.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
            BucketEvidenceError: Se a operação não puder preservar as invariantes descritas.
        """
        if not isinstance(dataset, str) or not dataset:
            raise ValueError("dataset must be non-empty text")
        materialized = tuple(records)
        if any(record.source_dataset != dataset for record in materialized):
            raise BucketEvidenceError("bucket evidence records must belong to their dataset")
        if self._disk_budget is not None:
            self._disk_budget.reserve(
                max(1, len(materialized)) * _SQLITE_BYTES_PER_RECORD,
                "bucket evidence SQLite records",
            )
        assert self._connection is not None
        self._connection.executemany(
            "INSERT OR IGNORE INTO intervals(dataset, start_ms, end_ms, grain_seconds) "
            "VALUES (?, ?, ?, ?)",
            ((dataset, *self._interval(record, partition)) for record in materialized),
        )
        self._connection.commit()
        row = self._connection.execute("SELECT COUNT(*) FROM intervals").fetchone()
        if row is None or not isinstance(row[0], int):
            raise BucketEvidenceError("bucket evidence row count is invalid")
        if row[0] > _MAX_EVIDENCE_INTERVALS:
            raise BucketEvidenceError("bucket evidence interval limit was exceeded")
        if self._disk_budget is not None:
            self._disk_budget.observe()

    def clear_dataset(self, dataset: str) -> None:
        """Executa a etapa interna ``clear_dataset`` e valida seus efeitos antes de concluir.

        Args:
            dataset: Nome do dataset permitido pelo registro de contratos.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        assert self._connection is not None
        self._connection.execute("DELETE FROM intervals WHERE dataset = ?", (dataset,))
        self._connection.commit()

    def restore(self, intervals: tuple[tuple[str, int, int, int], ...]) -> None:
        """Restaura o recurso e confirma sua identidade antes de concluir.

        Args:
            intervals: Entrada ``intervals``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            BucketEvidenceError: Se a operação não puder preservar as invariantes descritas.
        """
        self._validate_persisted_intervals(intervals)
        if self._persisted_bytes(intervals) > _MAX_LEGACY_EVIDENCE_BYTES:
            raise BucketEvidenceError("persisted bucket evidence interval limit was exceeded")
        assert self._connection is not None
        self._connection.executemany(
            "INSERT OR IGNORE INTO intervals(dataset, start_ms, end_ms, grain_seconds) "
            "VALUES (?, ?, ?, ?)",
            intervals,
        )
        self._connection.commit()

    @staticmethod
    def _persisted_bytes(intervals: tuple[tuple[str, int, int, int], ...]) -> int:
        """Converte persisted para sua representação binária determinística.

        Args:
            intervals: Entrada ``intervals``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``int`` produzido pela operação após as validações.
        """
        return len(
            canonical_bytes(
                {
                    "bucketEvidence": [
                        {
                            "dataset": dataset,
                            "startMs": start,
                            "endMs": end,
                            "grainSeconds": grain,
                        }
                        for dataset, start, end, grain in intervals
                    ]
                }
            )
        )

    @staticmethod
    def _validate_persisted_intervals(intervals: tuple[tuple[str, int, int, int], ...]) -> None:
        """Valida persisted intervals contra as invariantes deste módulo.

        Args:
            intervals: Entrada ``intervals``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            BucketEvidenceError: Se a operação não puder preservar as invariantes descritas.
        """
        for item in intervals:
            if not isinstance(item, tuple) or len(item) != 4:
                raise BucketEvidenceError("persisted bucket evidence is invalid")
            dataset, start, end, grain = item
            if (
                not isinstance(dataset, str)
                or not dataset
                or any(
                    isinstance(value, bool) or not isinstance(value, int)
                    for value in (start, end, grain)
                )
                or start < 0
                or end <= start
                or grain < 0
            ):
                raise BucketEvidenceError("persisted bucket evidence is invalid")
            if grain == 0:
                if end != start + 1:
                    raise BucketEvidenceError("sparse bucket evidence is invalid")
            elif start % (grain * 1000) != 0 or (end - start) % (grain * 1000) != 0:
                raise BucketEvidenceError("canonical bucket evidence is invalid")

    @staticmethod
    def _compact(
        intervals: Iterable[tuple[str, int, int, int]],
    ) -> tuple[tuple[str, int, int, int], ...]:
        """Executa a etapa interna ``compact`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            intervals: Entrada ``intervals``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``tuple[tuple[str, int, int, int], ...]`` produzido pela operação após as
            validações.
        """
        ordered = sorted(intervals, key=lambda item: (item[0], item[3], item[1], item[2]))
        result: list[tuple[str, int, int, int]] = []
        for dataset, start, end, grain in ordered:
            if grain and result:
                prior_dataset, prior_start, prior_end, prior_grain = result[-1]
                if prior_dataset == dataset and prior_grain == grain and start <= prior_end:
                    result[-1] = (prior_dataset, prior_start, max(prior_end, end), prior_grain)
                    continue
            result.append((dataset, start, end, grain))
        return tuple(result)

    def snapshot(
        self, dataset: str, *, horizon_seconds: int | None = None
    ) -> tuple[tuple[str, int, int, int], ...]:
        """Executa a etapa interna ``snapshot`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            dataset: Nome do dataset permitido pelo registro de contratos.
            horizon_seconds: Duração ou prazo expresso em segundos.

        Returns:
            Valor ``tuple[tuple[str, int, int, int], ...]`` produzido pela operação após as
            validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
            BucketEvidenceError: Se a operação não puder preservar as invariantes descritas.
        """
        if horizon_seconds is not None and (
            isinstance(horizon_seconds, bool)
            or not isinstance(horizon_seconds, int)
            or horizon_seconds <= 0
        ):
            raise ValueError("horizon_seconds must be a positive integer or None")
        assert self._connection is not None
        query = "SELECT dataset, start_ms, end_ms, grain_seconds FROM intervals WHERE dataset = ?"
        values: tuple[object, ...] = (dataset,)
        if horizon_seconds is not None:
            query += " AND end_ms > (SELECT MAX(end_ms) - ? FROM intervals WHERE dataset = ?)"
            values = (dataset, horizon_seconds * 1000, dataset)
        query += " ORDER BY start_ms, end_ms, grain_seconds"
        rows = self._connection.execute(query, values).fetchall()
        compacted = self._compact(tuple(cast(tuple[str, int, int, int], row) for row in rows))
        if len(compacted) > _MAX_MANIFEST_INTERVALS:
            raise BucketEvidenceError("persisted bucket evidence interval limit was exceeded")
        return compacted

    def _covers(self, dataset: str, start: int, end: int, grain_seconds: int) -> bool:
        """Verifica a condição associada a covers.

        Args:
            dataset: Nome do dataset permitido pelo registro de contratos.
            start: Entrada ``start``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            end: Entrada ``end``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            grain_seconds: Duração ou prazo expresso em segundos.

        Returns:
            Valor ``bool`` produzido pela operação após as validações.

        Raises:
            BucketEvidenceError: Se a operação não puder preservar as invariantes descritas.
        """
        assert self._connection is not None
        grain_ms = grain_seconds * 1000
        rows = self._connection.execute(
            "SELECT start_ms, end_ms FROM intervals WHERE dataset = ? "
            "AND grain_seconds = ? AND start_ms < ? AND end_ms > ? "
            "ORDER BY start_ms, end_ms",
            (dataset, grain_seconds, end, start),
        )
        covered = start
        for raw_start, raw_end in rows:
            if (
                not isinstance(raw_start, int)
                or not isinstance(raw_end, int)
                or raw_end <= raw_start
                or raw_start % grain_ms != 0
                or (raw_end - raw_start) % grain_ms != 0
            ):
                raise BucketEvidenceError("bucket evidence interval is invalid")
            if raw_start > covered:
                return False
            covered = max(covered, raw_end)
            if covered >= end:
                return True
        return False

    def intervals(
        self, dataset: str
    ) -> tuple[list[dict[str, str]], str | None, tuple[str, ...]]:
        """Executa a etapa interna ``intervals`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            dataset: Nome do dataset permitido pelo registro de contratos.

        Returns:
            Valor ``tuple[list[dict[str, str]], str | None]`` produzido pela operação após as
            validações.

        Raises:
            BucketEvidenceError: Se a operação não puder preservar as invariantes descritas.
        """
        assert self._connection is not None
        cursor = self._connection.execute(
            "SELECT start_ms, end_ms FROM intervals WHERE dataset = ? "
            "ORDER BY start_ms ASC, end_ms ASC",
            (dataset,),
        )
        merged: list[tuple[int, int]] = []
        compacted = False
        for raw_start, raw_end in cursor:
            if (
                not isinstance(raw_start, int)
                or not isinstance(raw_end, int)
                or raw_end <= raw_start
            ):
                raise BucketEvidenceError("bucket evidence interval is invalid")
            if compacted:
                merged[0] = (merged[0][0], max(merged[0][1], raw_end))
            elif merged and raw_start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], raw_end))
            else:
                if len(merged) >= _MAX_MANIFEST_INTERVALS:
                    compacted = True
                    merged = [(merged[0][0], raw_end)]
                else:
                    merged.append((raw_start, raw_end))
        if not merged:
            return [], None, ()
        return (
            [
                {
                    "start": _utc(start).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                    "end": _utc(end).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                }
                for start, end in merged
            ],
            _utc(merged[-1][1]).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            ("SPARSE_INTERVALS_COMPACTED",) if compacted else (),
        )

    def common_complete_window(
        self, datasets: tuple[str, ...], grain_seconds: int
    ) -> TimeWindow | None:
        """Executa a etapa interna ``common_complete_window`` e devolve o resultado validado
        indicado pela assinatura.

        Args:
            datasets: Entrada ``datasets``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            grain_seconds: Duração ou prazo expresso em segundos.

        Returns:
            Valor ``TimeWindow | None`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
            BucketEvidenceError: Se a operação não puder preservar as invariantes descritas.
        """
        if not datasets or len(set(datasets)) != len(datasets):
            raise ValueError("datasets must be a non-empty unique tuple")
        if (
            isinstance(grain_seconds, bool)
            or not isinstance(grain_seconds, int)
            or grain_seconds <= 0
        ):
            raise ValueError("grain_seconds must be positive")
        assert self._connection is not None
        grain_ms = grain_seconds * 1000
        bounds: list[tuple[int, int]] = []
        for dataset in datasets:
            row = self._connection.execute(
                "SELECT MIN(start_ms), MAX(end_ms) FROM intervals "
                "WHERE dataset = ? AND grain_seconds = ?",
                (dataset, grain_seconds),
            ).fetchone()
            if row is None or row[0] is None or row[1] is None:
                return None
            if not isinstance(row[0], int) or not isinstance(row[1], int):
                raise BucketEvidenceError("bucket evidence bounds are invalid")
            bounds.append((row[0], row[1]))
        start = max(bound[0] for bound in bounds)
        end = min(bound[1] for bound in bounds)
        if end <= start or start % grain_ms != 0 or end % grain_ms != 0:
            return None
        for dataset in datasets:
            if not self._covers(dataset, start, end, grain_seconds):
                return None
        return TimeWindow(_utc(start), _utc(end), grain_seconds)

    def requested_complete_window(
        self, datasets: tuple[str, ...], requested: TimeWindow, grain_seconds: int
    ) -> TimeWindow | None:
        """Executa a etapa interna ``requested_complete_window`` e devolve o resultado validado
        indicado pela assinatura.

        Args:
            datasets: Entrada ``datasets``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            requested: Entrada ``requested``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            grain_seconds: Duração ou prazo expresso em segundos.

        Returns:
            Valor ``TimeWindow | None`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
            BucketEvidenceError: Se a operação não puder preservar as invariantes descritas.
        """
        if not isinstance(requested, TimeWindow):
            raise TypeError("requested must be TimeWindow")
        if requested.grain_seconds <= 0:
            raise ValueError("requested grain must be positive")
        duration_ms = _epoch_ms(requested.end) - _epoch_ms(requested.start)
        grain_ms = grain_seconds * 1000
        if duration_ms >= grain_ms:
            if duration_ms % grain_ms != 0 or _epoch_ms(requested.start) % grain_ms != 0:
                return None
            expected_start = _epoch_ms(requested.start)
            expected_end = _epoch_ms(requested.end)
            for dataset in datasets:
                if not self._covers(dataset, expected_start, expected_end, grain_seconds):
                    return None
            return TimeWindow(requested.start, requested.end, grain_seconds)

        assert self._connection is not None
        starts: list[int] = []
        for dataset in datasets:
            candidates: set[int] = set()
            rows = self._connection.execute(
                "SELECT start_ms, end_ms FROM intervals WHERE dataset = ? "
                "AND grain_seconds = ? AND start_ms < ? AND end_ms > ?",
                (dataset, grain_seconds, _epoch_ms(requested.end), _epoch_ms(requested.start)),
            )
            for raw_start, raw_end in rows:
                if (
                    not isinstance(raw_start, int)
                    or not isinstance(raw_end, int)
                    or raw_end <= raw_start
                    or raw_start % grain_ms != 0
                    or (raw_end - raw_start) % grain_ms != 0
                ):
                    raise BucketEvidenceError("requested bucket evidence is invalid")
                candidate = max(raw_start, _epoch_ms(requested.start))
                remainder = candidate % grain_ms
                if remainder:
                    candidate += grain_ms - remainder
                if candidate < _epoch_ms(requested.end) and candidate + grain_ms <= raw_end:
                    candidates.add(candidate)
            if len(candidates) != 1:
                return None
            starts.append(next(iter(candidates)))
        if len(set(starts)) != 1:
            return None
        return TimeWindow(_utc(starts[0]), _utc(starts[0] + grain_ms), grain_seconds)

    def close(self) -> None:
        """Libera recursos locais ainda mantidos pela instância.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        if self._connection is not None:
            try:
                self._connection.close()
            except (sqlite3.Error, OSError):
                pass
            finally:
                self._connection = None
        for candidate in (
            self._path,
            Path(f"{self._path}-journal"),
            Path(f"{self._path}-wal"),
            Path(f"{self._path}-shm"),
        ):
            try:
                candidate.unlink(missing_ok=True)
            except OSError:
                pass


__all__ = ["BucketEvidence", "BucketEvidenceError"]
