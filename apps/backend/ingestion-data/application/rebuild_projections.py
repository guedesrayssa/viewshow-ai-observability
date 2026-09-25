"""Reconstrói projeções operacionais a partir de fatos quentes ou arquivados.

Papel no fluxo:
    No fluxo da aplicação, este módulo coordena regras do domínio por meio das interfaces de
    ``ports`` e não depende diretamente de SDKs ou formatos de infraestrutura.

Garantias e limites:
    A ordem das operações preserva idempotência, reconciliação e retomada segura quando uma
    execução é interrompida.
"""

from __future__ import annotations

import json
import re
import sqlite3
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from types import MappingProxyType
from typing import Protocol, cast

from application.projections._common import InputWatermark, ProjectionCoverage
from application.projections.event_materialization import (
    EventProjectionCounts,
    EventProjectionMaterializer,
)
from application.projections.geography import build_geography
from application.projections.incidents import build_incident_views
from application.projections.monitoring import build_monitoring
from application.projections.overview import build_overview
from application.read_canonical_set import ArchiveRecords, CanonicalRecordSource
from domain.archive import partition_date
from domain.canonical_json import canonical_bytes
from domain.identity import payload_hash, record_id, sha256_id
from domain.models import CanonicalRecord, CanonicalValue, RecordType, Scalar, TimeWindow
from domain.quality import CoverageStatus
from ports import (
    ArchiveDependency,
    CanonicalSetStore,
    ConditionalWriteError,
    ManifestRepository,
    Projection,
    ProjectionRepository,
)
from ports.analysis_facts import AnalysisFactSink

type ProjectionTarget = tuple[str, str, str]

_FACT_PARTITION = re.compile(
    r"^DATASET#(?P<version>[^#\s]+)#(?P<family>FACT#TS|INCIDENT#TS|CONTEXT#TS|"
    r"INGESTION#SOURCE)#(?P<dataset>[^#\s]+)#(?P<day>[0-9]{8})$"
)
_PROJECTION_FAMILIES = frozenset(
    {"overview", "incidents", "monitoring", "geography", "events", "evidence"}
)
_MAX_ACTIVE_INCIDENTS = 1_000
_MAX_ACTIVE_PAYLOAD_BYTES = 160 * 1024
_REBUILD_SNAPSHOT_BATCH_SIZE = 256
_RECORD_FAMILY = {
    RecordType.SIGNAL_OBSERVATION: "FACT#TS",
    RecordType.DIMENSIONAL_METRIC_AGGREGATE: "FACT#TS",
    RecordType.APPLICATION_ERROR_AGGREGATE: "FACT#TS",
    RecordType.SHADOW_OBSERVATION: "FACT#TS",
    RecordType.INCIDENT: "INCIDENT#TS",
    RecordType.LIVE_EVENT_CONTEXT: "CONTEXT#TS",
    RecordType.FINDING_STATUS_TRANSITION: "CONTEXT#TS",
    RecordType.UPSTREAM_SOURCE_HEALTH: "INGESTION#SOURCE",
    RecordType.UPSTREAM_COLLECTOR_RUN: "INGESTION#SOURCE",
}


class _ProjectionView(Protocol):
    """Define o contrato mínimo de projeção view usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    @property
    def input_watermarks(self) -> tuple[InputWatermark, ...]:
        """Executa a etapa interna ``input_watermarks`` e devolve o resultado validado indicado
        pela assinatura.

        Returns:
            Valor ``tuple[InputWatermark, ...]`` produzido pela operação após as validações.
        """
        ...

    @property
    def coverage(self) -> ProjectionCoverage:
        """Executa a etapa interna ``coverage`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``ProjectionCoverage`` produzido pela operação após as validações.
        """
        ...

    @property
    def projection_version(self) -> str:
        """Executa a etapa interna ``projection_version`` e devolve o resultado validado
        indicado pela assinatura.

        Returns:
            Valor ``str`` produzido pela operação após as validações.
        """
        ...

    @property
    def formula_version(self) -> str:
        """Executa a etapa interna ``formula_version`` e devolve o resultado validado indicado
        pela assinatura.

        Returns:
            Valor ``str`` produzido pela operação após as validações.
        """
        ...


@dataclass(slots=True)
class _PartitionEvidence:
    """Representa os dados de ``_PartitionEvidence`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        dataset: Nome do dataset permitido pelo registro de contratos.
        count: Entrada ``count``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        observed_through: Valor efetivamente observado que será comparado com a evidência
        esperada.
        flags: Entrada ``flags``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        ambiguous: Entrada ``ambiguous``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
    """

    dataset: str
    count: int = 0
    observed_through: datetime | None = None
    flags: set[str] | None = None
    ambiguous: bool = False

    def add(self, record: CanonicalRecord) -> None:
        """Acrescenta a entrada validada ao estado acumulado da instância.

        Args:
            record: Registro canônico consumido pela operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        self.count += 1
        if record.observed_at is not None:
            self.observed_through = (
                record.observed_at
                if self.observed_through is None
                else max(self.observed_through, record.observed_at)
            )
        assert self.flags is not None
        self.flags.update(record.quality_flags)
        bot_status = record.quality.get("botCoverageStatus")
        self.ambiguous = self.ambiguous or (bot_status is not None and bot_status != "reliable")

    def common(self, partition: str) -> dict[str, object]:
        """Executa a etapa interna ``common`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            partition: Identificador canônico da partição física ou lógica.

        Returns:
            Valor ``dict[str, object]`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if partition.startswith("snapshot_date="):
            observed = datetime.combine(partition_date(partition), time.min, tzinfo=UTC)
        elif self.observed_through is None:
            raise ValueError("a projection requires persisted input watermarks")
        else:
            observed = self.observed_through
        flags = tuple(sorted(self.flags or ()))
        return {
            "projectionVersion": "1.0",
            "formulaVersion": "1.0",
            "inputWatermarks": MappingProxyType({self.dataset: observed}),
            "observedThrough": observed,
            "coverage": (
                CoverageStatus.PARTIAL.value
                if flags or self.ambiguous
                else CoverageStatus.COMPLETE.value
            ),
            "qualityFlags": flags,
        }


def _decimal_text(value: Decimal | None) -> str | None:
    """Converte decimal para sua representação textual canônica.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str | None`` produzido pela operação após as validações.
    """
    return None if value is None else str(value)


def _stored_datetime(value: datetime | None) -> str | None:
    """Executa a etapa interna ``stored_datetime`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str | None`` produzido pela operação após as validações.
    """
    return None if value is None else value.isoformat()


def _loaded_datetime(value: object) -> datetime | None:
    """Executa a etapa interna ``loaded_datetime`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``datetime | None`` produzido pela operação após as validações.
    """
    return None if value is None else datetime.fromisoformat(str(value))


def _snapshot_record_value(record: CanonicalRecord) -> Mapping[str, object]:
    """Produz o valor de snapshot registro usado pela etapa seguinte.

    Args:
        record: Registro canônico consumido pela operação.

    Returns:
        Valor ``Mapping[str, object]`` produzido pela operação após as validações.
    """
    return {
        "schema_version": record.schema_version,
        "record_type": record.record_type.value,
        "source_system": record.source_system,
        "source_dataset": record.source_dataset,
        "natural_key": record.natural_key,
        "observed_at": record.observed_at,
        "window": (
            {
                "start": record.window.start,
                "end": record.window.end,
                "grain_seconds": record.window.grain_seconds,
            }
            if record.window is not None
            else None
        ),
        "dimensions": record.dimensions,
        "measures": record.measures,
        "quality": record.quality,
        "quality_flags": record.quality_flags,
    }


def _restore_snapshot_value(value: object) -> object:
    """Restaura snapshot valor e confirma sua identidade antes de concluir.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``object`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if isinstance(value, list):
        return tuple(_restore_snapshot_value(item) for item in value)
    if not isinstance(value, Mapping):
        return value
    if set(value) == {"$decimal"} and isinstance(value["$decimal"], str):
        return Decimal(value["$decimal"])
    if set(value) == {"$datetime"} and isinstance(value["$datetime"], str):
        restored = datetime.fromisoformat(value["$datetime"].replace("Z", "+00:00"))
        if restored.tzinfo is None or restored.utcoffset() != timedelta(0):
            raise ValueError("rebuild snapshot datetime must be UTC")
        return restored.astimezone(UTC)
    return {key: _restore_snapshot_value(item) for key, item in value.items()}


def _record_from_snapshot(payload: bytes) -> CanonicalRecord:
    """Obtém ou registra from snapshot como evidência da execução atual.

    Args:
        payload: Entrada ``payload``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``CanonicalRecord`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    try:
        decoded = json.loads(payload)
    except (TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("rebuild snapshot contains invalid canonical JSON") from error
    expected = {
        "schema_version",
        "record_type",
        "source_system",
        "source_dataset",
        "natural_key",
        "observed_at",
        "window",
        "dimensions",
        "measures",
        "quality",
        "quality_flags",
    }
    if not isinstance(decoded, Mapping) or set(decoded) != expected:
        raise ValueError("rebuild snapshot contains an invalid record shape")
    values = cast(dict[str, object], _restore_snapshot_value(decoded))
    raw_window = values["window"]
    if raw_window is None:
        window = None
    elif isinstance(raw_window, Mapping) and set(raw_window) == {
        "start",
        "end",
        "grain_seconds",
    }:
        window = TimeWindow(
            cast(datetime, raw_window["start"]),
            cast(datetime, raw_window["end"]),
            cast(int, raw_window["grain_seconds"]),
        )
    else:
        raise ValueError("rebuild snapshot contains an invalid window")
    try:
        return CanonicalRecord(
            schema_version=cast(str, values["schema_version"]),
            record_type=RecordType(cast(str, values["record_type"])),
            source_system=cast(str, values["source_system"]),
            source_dataset=cast(str, values["source_dataset"]),
            natural_key=cast(tuple[tuple[str, Scalar], ...], values["natural_key"]),
            observed_at=cast(datetime | None, values["observed_at"]),
            window=window,
            dimensions=cast(Mapping[str, CanonicalValue], values["dimensions"]),
            measures=cast(Mapping[str, CanonicalValue], values["measures"]),
            quality=cast(Mapping[str, Scalar], values["quality"]),
            quality_flags=cast(tuple[str, ...], values["quality_flags"]),
        )
    except (TypeError, ValueError) as error:
        raise ValueError("rebuild snapshot contains an invalid canonical record") from error


class _PartitionAccumulator:
    """Agrupa o estado e as operações de ``_PartitionAccumulator`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(self, key: tuple[str, str], database: Path) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            database: Entrada ``database``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self.key = key
        self.evidence = _PartitionEvidence(key[0], flags=set())
        self.overview_sums: dict[str, Decimal] = {}
        self.has_overview = False
        self.human_complete = True
        self.overview_grain: int | None | object = object()
        self._connection = sqlite3.connect(database)
        self._connection.executescript(
            """
            CREATE TABLE geography (
                state TEXT NOT NULL, isp TEXT NOT NULL,
                sessions TEXT NOT NULL, errors TEXT NOT NULL,
                PRIMARY KEY (state, isp)
            );
            CREATE TABLE incidents (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                incident_id TEXT NOT NULL, number TEXT, opened_at TEXT NOT NULL,
                state TEXT, priority TEXT, resolved_at TEXT, closed_at TEXT,
                active INTEGER NOT NULL
            );
            CREATE TABLE monitoring (
                source TEXT PRIMARY KEY, observed_at TEXT NOT NULL, finished_at TEXT,
                rows_processed TEXT, duration_seconds TEXT, quality_flags TEXT NOT NULL,
                payload_fingerprint TEXT NOT NULL,
                conflicting_latest INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE monitoring_identity (
                identity TEXT PRIMARY KEY, payload_fingerprint TEXT NOT NULL
            );
            """
        )

    def close(self) -> None:
        """Libera recursos locais ainda mantidos pela instância.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._connection.close()

    def add(self, record: CanonicalRecord) -> None:
        """Acrescenta a entrada validada ao estado acumulado da instância.

        Args:
            record: Registro canônico consumido pela operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if record.source_dataset != self.key[0]:
            raise ValueError("projection batch record differs from its archive dataset")
        self.evidence.add(record)
        metric_types = {
            RecordType.SIGNAL_OBSERVATION,
            RecordType.DIMENSIONAL_METRIC_AGGREGATE,
            RecordType.APPLICATION_ERROR_AGGREGATE,
        }
        if record.record_type in metric_types:
            self._add_overview(record)
        if record.source_dataset == "geo_hourly":
            self._add_geography(record)
        if record.record_type is RecordType.INCIDENT:
            self._add_incident(record)
        if record.record_type in {
            RecordType.UPSTREAM_SOURCE_HEALTH,
            RecordType.UPSTREAM_COLLECTOR_RUN,
        }:
            self._add_monitoring(record)

    def _add_overview(self, record: CanonicalRecord) -> None:
        """Executa a etapa interna ``add_overview`` e valida seus efeitos antes de concluir.

        Args:
            record: Registro canônico consumido pela operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        self.has_overview = True
        grain = record.window.grain_seconds if record.window is not None else None
        if type(self.overview_grain) is object:
            self.overview_grain = grain
        elif grain != self.overview_grain:
            raise ValueError("overview records must have one dataset and one grain")
        view = build_overview((record,))
        for field in ("sessions", "errors", "startupErrors", "botErrors"):
            value = view.metrics[field]
            if value is not None:
                self.overview_sums[field] = self.overview_sums.get(field, Decimal(0)) + value
        human = view.metrics["humanErrors"]
        if human is None:
            self.human_complete = False
        else:
            self.overview_sums["humanErrors"] = (
                self.overview_sums.get("humanErrors", Decimal(0)) + human
            )

    def _add_geography(self, record: CanonicalRecord) -> None:
        """Executa a etapa interna ``add_geography`` e valida seus efeitos antes de concluir.

        Args:
            record: Registro canônico consumido pela operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        location = build_geography((record,)).locations[0]
        prior = self._connection.execute(
            "SELECT sessions, errors FROM geography WHERE state = ? AND isp = ?",
            (location.state, location.isp),
        ).fetchone()
        sessions = location.sessions + (Decimal(prior[0]) if prior is not None else Decimal(0))
        errors = location.errors + (Decimal(prior[1]) if prior is not None else Decimal(0))
        self._connection.execute(
            "INSERT OR REPLACE INTO geography VALUES (?, ?, ?, ?)",
            (location.state, location.isp, str(sessions), str(errors)),
        )

    def _add_incident(self, record: CanonicalRecord) -> None:
        """Executa a etapa interna ``add_incident`` e valida seus efeitos antes de concluir.

        Args:
            record: Registro canônico consumido pela operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        views = build_incident_views((record,))
        item = views.day.incidents[0]
        self._connection.execute(
            """INSERT INTO incidents (
                incident_id, number, opened_at, state, priority, resolved_at, closed_at, active
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                item.incident_id,
                item.number,
                item.opened_at.isoformat(),
                item.state,
                item.priority,
                _stored_datetime(item.resolved_at),
                _stored_datetime(item.closed_at),
                int(bool(views.active.incidents)),
            ),
        )

    def _add_monitoring(self, record: CanonicalRecord) -> None:
        """Executa a etapa interna ``add_monitoring`` e valida seus efeitos antes de concluir.

        Args:
            record: Registro canônico consumido pela operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        item = build_monitoring((record,)).sources[0]
        fingerprint = payload_hash(record)
        identity = record_id(record)
        prior_identity = self._connection.execute(
            "SELECT payload_fingerprint FROM monitoring_identity WHERE identity = ?",
            (identity,),
        ).fetchone()
        if prior_identity is not None and prior_identity[0] != fingerprint:
            raise ValueError("monitoring contains a conflicting duplicate canonical identity")
        self._connection.execute(
            "INSERT OR IGNORE INTO monitoring_identity VALUES (?, ?)",
            (identity, fingerprint),
        )
        prior = self._connection.execute(
            "SELECT observed_at, payload_fingerprint FROM monitoring WHERE source = ?",
            (item.source,),
        ).fetchone()
        observed = item.observed_at.isoformat()
        if prior is not None and prior[0] == observed and prior[1] != fingerprint:
            self._connection.execute(
                "UPDATE monitoring SET conflicting_latest = 1 WHERE source = ?",
                (item.source,),
            )
            return
        if prior is None or observed > prior[0]:
            self._connection.execute(
                "INSERT OR REPLACE INTO monitoring VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
                (
                    item.source,
                    observed,
                    _stored_datetime(item.finished_at),
                    _decimal_text(item.rows_processed),
                    _decimal_text(item.duration_seconds),
                    "\0".join(item.quality_flags),
                    fingerprint,
                ),
            )

    def overview_payload(self) -> Mapping[str, object] | None:
        """Monta o payload de overview com o conjunto fechado de campos.

        Returns:
            Valor ``Mapping[str, object] | None`` produzido pela operação após as validações.
        """
        if not self.has_overview:
            return None
        sessions = self.overview_sums.get("sessions")
        errors = self.overview_sums.get("errors")
        return {
            **self.evidence.common(self.key[1]),
            "metrics": {
                "sessions": sessions,
                "errors": errors,
                "startupErrors": self.overview_sums.get("startupErrors"),
                "botErrors": self.overview_sums.get("botErrors"),
                "humanErrors": (
                    self.overview_sums.get("humanErrors") if self.human_complete else None
                ),
                "errorRate": (
                    None
                    if errors is None or sessions is None or sessions == 0
                    else errors / sessions
                ),
            },
        }

    def geography_payloads(self) -> Iterable[tuple[str, Mapping[str, object]]]:
        """Executa a etapa interna ``geography_payloads`` e devolve o resultado validado
        indicado pela assinatura.

        Returns:
            Iterador que produz os itens válidos à medida que são processados.
        """
        common = self.evidence.common(self.key[1])
        cursor = self._connection.execute(
            "SELECT state, isp, sessions, errors FROM geography ORDER BY state, isp"
        )
        for state, isp, raw_sessions, raw_errors in cursor:
            sessions = Decimal(raw_sessions)
            errors = Decimal(raw_errors)
            dimension_id = sha256_id("geo_", {"state": state, "isp": isp})
            yield (
                dimension_id,
                {
                    **common,
                    "dimensionId": dimension_id,
                    "state": state,
                    "isp": isp,
                    "sessions": sessions,
                    "errors": errors,
                    "errorRate": None if sessions == 0 else errors / sessions,
                    "metric": "errorRate",
                },
            )

    def incident_rows(self) -> Iterable[tuple[object, ...]]:
        """Executa a etapa interna ``incident_rows`` e devolve o resultado validado indicado
        pela assinatura.

        Returns:
            Valor ``Iterable[tuple[object, ...]]`` produzido pela operação após as validações.
        """
        return self._connection.execute(
            """SELECT incident_id, number, opened_at, state, priority,
               resolved_at, closed_at, active
               FROM incidents ORDER BY opened_at, incident_id, sequence"""
        )

    def has_incidents(self) -> bool:
        """Informa se existe incidentes nas evidências disponíveis.

        Returns:
            Valor ``bool`` produzido pela operação após as validações.
        """
        return self._connection.execute("SELECT 1 FROM incidents LIMIT 1").fetchone() is not None

    def active_incident_updates(
        self,
    ) -> Iterable[tuple[str, Mapping[str, object] | None]]:
        """Executa a etapa interna ``active_incident_updates`` e devolve o resultado validado
        indicado pela assinatura.

        Returns:
            Iterador que produz os itens válidos à medida que são processados.
        """
        for (raw_incident_id,) in self._connection.execute(
            "SELECT DISTINCT incident_id FROM incidents ORDER BY incident_id"
        ):
            incident_id = _require_text(raw_incident_id, "incidentId")
            active = self._connection.execute(
                """SELECT number, opened_at, state, priority
                   FROM incidents
                   WHERE incident_id = ? AND active = 1
                   ORDER BY opened_at DESC, sequence DESC LIMIT 1""",
                (incident_id,),
            ).fetchone()
            if active is None:
                yield incident_id, None
                continue
            number, opened_at, incident_state, priority = active
            yield (
                incident_id,
                {
                    "incidentId": incident_id,
                    "number": number,
                    "openedAt": _projection_datetime(opened_at, "openedAt"),
                    "state": incident_state,
                    "priority": priority,
                },
            )

    def monitoring_payloads(self) -> Iterable[tuple[str, Mapping[str, object]]]:
        """Executa a etapa interna ``monitoring_payloads`` e devolve o resultado validado
        indicado pela assinatura.

        Returns:
            Iterador que produz os itens válidos à medida que são processados.
        """
        conflict = self._connection.execute(
            "SELECT 1 FROM monitoring WHERE conflicting_latest = 1 LIMIT 1"
        ).fetchone()
        if conflict is not None:
            raise ValueError("monitoring source has conflicting records at the latest timestamp")
        common = self.evidence.common(self.key[1])
        cursor = self._connection.execute(
            """SELECT source, observed_at, finished_at, rows_processed,
               duration_seconds, quality_flags FROM monitoring ORDER BY source"""
        )
        for source, observed, finished, rows, duration, _flags in cursor:
            yield (
                source,
                {
                    **common,
                    "source": source,
                    "observedAt": datetime.fromisoformat(observed),
                    "finishedAt": _loaded_datetime(finished),
                    "rowsProcessed": None if rows is None else Decimal(rows),
                    "durationSeconds": None if duration is None else Decimal(duration),
                },
            )


class _RebuildInputSnapshot:
    """Agrupa o estado e as operações de ``_RebuildInputSnapshot`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(self, database: Path) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            database: Entrada ``database``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._connection = sqlite3.connect(database)
        self._connection.executescript(
            """
            CREATE TABLE records (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                dataset TEXT NOT NULL,
                partition_key TEXT NOT NULL,
                payload BLOB NOT NULL
            );
            CREATE INDEX records_replay
                ON records (dataset, partition_key, sequence);
            """
        )

    def close(self) -> None:
        """Libera recursos locais ainda mantidos pela instância.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._connection.close()

    def add(self, dataset: str, partition: str, record: CanonicalRecord) -> None:
        """Acrescenta a entrada validada ao estado acumulado da instância.

        Args:
            dataset: Nome do dataset permitido pelo registro de contratos.
            partition: Identificador canônico da partição física ou lógica.
            record: Registro canônico consumido pela operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._connection.execute(
            "INSERT INTO records (dataset, partition_key, payload) VALUES (?, ?, ?)",
            (dataset, partition, canonical_bytes(_snapshot_record_value(record))),
        )

    def batches(self) -> Iterable[ArchiveRecords]:
        """Executa a etapa interna ``batches`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Iterador que produz os itens válidos à medida que são processados.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        cursor = self._connection.execute(
            "SELECT dataset, partition_key, payload "
            "FROM records ORDER BY dataset, partition_key, sequence"
        )
        while rows := cursor.fetchmany(_REBUILD_SNAPSHOT_BATCH_SIZE):
            grouped: dict[tuple[str, str], list[CanonicalRecord]] = {}
            for raw_dataset, raw_partition, raw_payload in rows:
                dataset = _require_text(raw_dataset, "snapshot dataset")
                partition = _require_text(raw_partition, "snapshot partition")
                if not isinstance(raw_payload, bytes):
                    raise TypeError("rebuild snapshot payload must be bytes")
                grouped.setdefault((dataset, partition), []).append(
                    _record_from_snapshot(raw_payload)
                )
            yield MappingProxyType({key: tuple(values) for key, values in sorted(grouped.items())})


class _ActiveIncidentStore:
    """Agrupa o estado e as operações de ``_ActiveIncidentStore`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(self, database: Path) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            database: Entrada ``database``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._connection = sqlite3.connect(database)
        self._connection.execute(
            """CREATE TABLE active_incidents (
                incident_id TEXT PRIMARY KEY, number TEXT, opened_at TEXT NOT NULL,
                state TEXT, priority TEXT
            )"""
        )

    def close(self) -> None:
        """Libera recursos locais ainda mantidos pela instância.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._connection.close()

    def load(self, raw_incidents: object) -> None:
        """Carrega a entrada e rejeita conteúdo incompleto ou malformado.

        Args:
            raw_incidents: Entrada ``raw_incidents``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(raw_incidents, tuple | list):
            raise ValueError("persisted active incidents must be a sequence")
        if len(raw_incidents) > _MAX_ACTIVE_INCIDENTS:
            raise ValueError("active incident cardinality exceeds the explicit limit")
        for raw in raw_incidents:
            if not isinstance(raw, Mapping) or set(raw) != {
                "incidentId",
                "number",
                "openedAt",
                "state",
                "priority",
            }:
                raise ValueError("persisted active incident has an invalid shape")
            incident_id = _require_text(raw["incidentId"], "incidentId")
            opened_at = _projection_datetime(raw["openedAt"], "openedAt")
            self._connection.execute(
                "INSERT OR REPLACE INTO active_incidents VALUES (?, ?, ?, ?, ?)",
                (
                    incident_id,
                    raw["number"],
                    opened_at.isoformat(),
                    raw["state"],
                    raw["priority"],
                ),
            )

    def clear(self) -> None:
        """Descarta o estado temporário mantido pela instância.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._connection.execute("DELETE FROM active_incidents")

    def apply(self, updates: Iterable[tuple[str, Mapping[str, object] | None]]) -> None:
        """Aplica os dados acumulados ao estado ou projeção de destino.

        Args:
            updates: Entrada ``updates``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        for incident_id, item in updates:
            if item is None:
                self._connection.execute(
                    "DELETE FROM active_incidents WHERE incident_id = ?", (incident_id,)
                )
                continue
            opened_at = _projection_datetime(item["openedAt"], "openedAt")
            self._connection.execute(
                "INSERT OR REPLACE INTO active_incidents VALUES (?, ?, ?, ?, ?)",
                (
                    incident_id,
                    item["number"],
                    opened_at.isoformat(),
                    item["state"],
                    item["priority"],
                ),
            )

    def payload(self, common: Mapping[str, object]) -> Mapping[str, object]:
        """Executa a etapa interna ``payload`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            common: Entrada ``common``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        (count,) = self._connection.execute("SELECT COUNT(*) FROM active_incidents").fetchone()
        if not isinstance(count, int) or count > _MAX_ACTIVE_INCIDENTS:
            raise ValueError("active incident cardinality exceeds the explicit limit")
        incidents = tuple(
            {
                "incidentId": incident_id,
                "number": number,
                "openedAt": _projection_datetime(opened_at, "openedAt"),
                "state": state,
                "priority": priority,
            }
            for incident_id, number, opened_at, state, priority in self._connection.execute(
                """SELECT incident_id, number, opened_at, state, priority
                   FROM active_incidents
                   ORDER BY COALESCE(priority, ''), opened_at, incident_id"""
            )
        )
        payload = {**common, "incidents": incidents}
        if len(canonical_bytes(payload)) > _MAX_ACTIVE_PAYLOAD_BYTES:
            raise ValueError("active incident payload exceeds the explicit size limit")
        return payload


def _require_text(value: object, field: str) -> str:
    """Valida e devolve texto, rejeitando entradas fora do contrato.

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


def _watermarks(value: _ProjectionView) -> Mapping[str, datetime]:
    """Executa a etapa interna ``watermarks`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``Mapping[str, datetime]`` produzido pela operação após as validações.
    """
    marks = value.input_watermarks
    return MappingProxyType({item.dataset: item.observed_at for item in marks})


def _common_payload(value: _ProjectionView, partition: str) -> dict[str, object]:
    """Monta o payload de common com o conjunto fechado de campos.

    Args:
        value: Valor não confiável que será validado ou convertido.
        partition: Identificador canônico da partição física ou lógica.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    marks = _watermarks(value)
    if not marks:
        raise ValueError("a projection requires persisted input watermarks")
    if partition.startswith("snapshot_date="):
        persisted_at = datetime.combine(partition_date(partition), time.min, tzinfo=UTC)
        marks = MappingProxyType({dataset: persisted_at for dataset in marks})
    coverage = value.coverage
    return {
        "projectionVersion": value.projection_version,
        "formulaVersion": value.formula_version,
        "inputWatermarks": marks,
        "observedThrough": max(marks.values()),
        "coverage": coverage.status.value,
        "qualityFlags": coverage.quality_flags,
    }


def _projection_family(key: str) -> str:
    """Executa a etapa interna ``projection_family`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    prefixes = {
        "OVERVIEW#": "overview",
        "INCIDENTS#": "incidents",
        "MONITORING#": "monitoring",
        "GEOGRAPHY#": "geography",
    }
    matches = tuple(family for prefix, family in prefixes.items() if key.startswith(prefix))
    if len(matches) != 1:
        raise ValueError("projection key does not belong to one supported family")
    return matches[0]


def _projection_datetime(value: object, field: str) -> datetime:
    """Executa a etapa interna ``projection_datetime`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``datetime`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError(f"persisted {field} is not a datetime") from error
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError(f"persisted {field} must be an aware UTC datetime")
    return value.astimezone(UTC)


def _dependencies(records: ArchiveRecords) -> tuple[ArchiveDependency, ...]:
    """Executa a etapa interna ``dependencies`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        records: Registros canônicos consumidos pela operação.

    Returns:
        Valor ``tuple[ArchiveDependency, ...]`` produzido pela operação após as validações.
    """
    return tuple(
        ArchiveDependency(dataset, partition)
        for dataset, partition in sorted(records)
        if records[(dataset, partition)]
    )


def _same_day_groups(records: ArchiveRecords) -> tuple[ArchiveRecords, ...]:
    """Compara as evidências e informa se dia groups é equivalente.

    Args:
        records: Registros canônicos consumidos pela operação.

    Returns:
        Valor ``tuple[ArchiveRecords, ...]`` produzido pela operação após as validações.
    """
    by_partition: dict[str, dict[tuple[str, str], tuple[CanonicalRecord, ...]]] = {}
    for key, values in records.items():
        if values:
            by_partition.setdefault(key[1], {})[key] = values
    return tuple(MappingProxyType(by_partition[key]) for key in sorted(by_partition))


@dataclass(frozen=True, slots=True)
class ProjectionBuildResult:
    """Representa os dados de ``ProjectionBuildResult`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        projections: Entrada ``projections``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        catalog_item_counts: Entrada ``catalog_item_counts``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        persisted_families: Entrada ``persisted_families``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
    """

    projections: tuple[Projection, ...]
    catalog_item_counts: Mapping[tuple[str, str], int]
    persisted_families: tuple[str, ...] = ()
    event_counts: Mapping[str, int] = MappingProxyType({})

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if any(not isinstance(item, Projection) for item in self.projections):
            raise TypeError("projections must contain only Projection values")
        counts = dict(self.catalog_item_counts)
        if any(
            not isinstance(key, tuple)
            or len(key) != 2
            or any(not isinstance(part, str) or not part for part in key)
            or isinstance(value, bool)
            or not isinstance(value, int)
            or value < 0
            for key, value in counts.items()
        ):
            raise ValueError("catalog_item_counts must contain validated archive counts")
        if len(self.persisted_families) != len(set(self.persisted_families)):
            raise ValueError("persisted_families must not contain duplicates")
        if any(family not in _PROJECTION_FAMILIES for family in self.persisted_families):
            raise ValueError("persisted_families contains an unsupported family")
        object.__setattr__(self, "projections", tuple(self.projections))
        object.__setattr__(self, "catalog_item_counts", MappingProxyType(counts))
        object.__setattr__(self, "persisted_families", tuple(self.persisted_families))
        event_counts = dict(self.event_counts)
        expected_event_counts = {"eligible", "events", "linked", "unlinked", "evidence"}
        if event_counts and (
            set(event_counts) != expected_event_counts
            or any(
                isinstance(value, bool) or not isinstance(value, int) or value < 0
                for value in event_counts.values()
            )
            or event_counts["eligible"] != event_counts["events"]
            or event_counts["linked"] + event_counts["unlinked"] != event_counts["events"]
        ):
            raise ValueError("event_counts must contain reconciled non-negative counts")
        object.__setattr__(self, "event_counts", MappingProxyType(event_counts))


@dataclass(frozen=True, slots=True)
class ProjectionService:
    """Representa os dados de ``ProjectionService`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        repository: Porta de persistência usada pelo caso de uso.
        event_correlation_window_seconds: Janela máxima de correlação entre eventos.
        fact_sink: Destino opcional dos fatos de série do worker de análise. Recebe cada lote
            de registros lido do arquivo confirmado, junto com as projeções do painel.
    """

    repository: ProjectionRepository
    event_correlation_window_seconds: int = 18_000
    fact_sink: AnalysisFactSink | None = None

    def __post_init__(self) -> None:
        if not 1 <= self.event_correlation_window_seconds <= 18_000:
            raise ValueError("event_correlation_window_seconds must be between 1 and 18000")

    def _publish(
        self,
        projection: Projection,
        expected_revisions: Mapping[ProjectionTarget, str],
    ) -> None:
        """Publica a entrada preservando idempotência e validação de resposta.

        Args:
            projection: Entrada ``projection``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.
            expected_revisions: Valor esperado usado para detectar concorrência ou divergência
            de estado.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        target = (
            projection.partition_key,
            projection.key,
            projection.operational_sort_key,
        )
        expected_revision = expected_revisions.get(target)
        self.repository.put(
            projection,
            expected_projection_version=(
                projection.projection_version if expected_revision is not None else None
            ),
            expected_materialization_revision=expected_revision,
            idempotency_key=(
                f"projection:{projection.dataset_version}:{projection.materialization_revision}:"
                f"{expected_revision or 'absent'}"
            ),
        )

    @staticmethod
    def _projection(
        dataset_version: str,
        partition: str,
        key: str,
        dependencies: tuple[ArchiveDependency, ...],
        payload: Mapping[str, object],
    ) -> Projection:
        """Executa a etapa interna ``projection`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            partition: Identificador canônico da partição física ou lógica.
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            dependencies: Entrada ``dependencies``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            payload: Entrada ``payload``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Projection`` produzido pela operação após as validações.
        """
        return Projection(
            dataset_version,
            partition,
            key,
            "1.0",
            dependencies,
            payload,
        )

    def materialize_record_batches(
        self,
        dataset_version: str,
        batches: Iterable[ArchiveRecords],
        *,
        expected_revisions: Mapping[ProjectionTarget, str] | None = None,
        retain_projections: bool = True,
        event_batches: Iterable[ArchiveRecords] | None = None,
        materialize_events: bool = True,
    ) -> ProjectionBuildResult:
        """Materializa registro batches a partir dos fatos de entrada validados.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            batches: Entrada ``batches``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            expected_revisions: Valor esperado usado para detectar concorrência ou divergência
            de estado.
            retain_projections: Entrada ``retain_projections``; a forma aceita é definida pela
                anotação de tipo e validada antes do uso.
            event_batches: Conjunto canônico completo usado para correlação entre dias.
            materialize_events: Desliga Eventos/Evidências quando só existem fatos quentes
                parciais, que não permitem reconstrução global correta.

        Returns:
            Valor ``ProjectionBuildResult`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        _require_text(dataset_version, "dataset_version")
        if type(retain_projections) is not bool:
            raise TypeError("retain_projections must be a boolean")
        if type(materialize_events) is not bool:
            raise TypeError("materialize_events must be a boolean")
        expectations = expected_revisions or {}
        produced: list[Projection] = []
        catalog_counts: dict[tuple[str, str], int] = {}
        persisted_families: set[str] = set()
        current_active = self.repository.get_current(dataset_version, "INCIDENTS#ACTIVE", "CURRENT")
        active_revision: str | None = None
        current_observed: datetime | None = None
        reconstructing_history = False
        raw_active_incidents: object = ()
        if current_active is not None:
            active_revision = current_active.materialization_revision
            current_observed = _projection_datetime(
                current_active.payload.get("observedThrough"), "observedThrough"
            )
            raw_active_incidents = current_active.payload.get("incidents")

        def publish_partition(accumulator: _PartitionAccumulator) -> None:
            """Publica partição preservando idempotência e validação de resposta.

            Args:
                accumulator: Entrada ``accumulator``; a forma aceita é definida pela anotação de
                tipo e validada antes do uso.

            Returns:
                Não produz valor de retorno; conclui após aplicar ou validar a operação.
            """
            nonlocal active_revision, current_observed, reconstructing_history
            dataset, partition = accumulator.key
            dependency = (ArchiveDependency(dataset, partition),)

            def publish_one(projection: Projection) -> None:
                """Publica one preservando idempotência e validação de resposta.

                Args:
                    projection: Entrada ``projection``; a forma aceita é definida pela anotação
                    de tipo e validada antes do uso.

                Returns:
                    Não produz valor de retorno; conclui após aplicar ou validar a operação.
                """
                nonlocal active_revision, current_observed
                if (
                    projection.key == "INCIDENTS#ACTIVE"
                    and current_observed is not None
                    and _projection_datetime(
                        projection.payload["observedThrough"], "observedThrough"
                    )
                    < current_observed
                ):
                    return
                effective_expectations = expectations
                if projection.key == "INCIDENTS#ACTIVE" and active_revision is not None:
                    target = (
                        projection.partition_key,
                        projection.key,
                        projection.operational_sort_key,
                    )
                    effective_expectations = {target: expectations.get(target, active_revision)}
                self._publish(projection, effective_expectations)
                persisted_families.add(_projection_family(projection.key))
                if projection.key == "INCIDENTS#ACTIVE":
                    active_revision = projection.materialization_revision
                    current_observed = _projection_datetime(
                        projection.payload["observedThrough"], "observedThrough"
                    )
                else:
                    catalog_counts[accumulator.key] = catalog_counts.get(accumulator.key, 0) + 2
                if retain_projections:
                    produced.append(projection)

            overview = accumulator.overview_payload()
            if overview is not None:
                publish_one(
                    self._projection(
                        dataset_version, partition, f"OVERVIEW#{dataset}", dependency, overview
                    )
                )
            for _dimension_id, payload in accumulator.geography_payloads():
                publish_one(
                    self._projection(
                        dataset_version,
                        partition,
                        "GEOGRAPHY#errorRate",
                        dependency,
                        payload,
                    )
                )
            incident_common = accumulator.evidence.common(partition)
            if accumulator.has_incidents():
                observed = accumulator.evidence.observed_through
                assert observed is not None
                if current_observed is not None and observed < current_observed:
                    if not reconstructing_history:
                        active_store.clear()
                        reconstructing_history = True
                active_store.apply(accumulator.active_incident_updates())
                active_payload = active_store.payload(incident_common)
                for (
                    incident_id,
                    number,
                    opened_at,
                    incident_state,
                    priority,
                    resolved_at,
                    closed_at,
                    _is_active,
                ) in accumulator.incident_rows():
                    publish_one(
                        self._projection(
                            dataset_version,
                            partition,
                            "INCIDENTS#DAY",
                            dependency,
                            {
                                **incident_common,
                                "incidentId": _require_text(incident_id, "incidentId"),
                                "number": number,
                                "openedAt": _projection_datetime(opened_at, "openedAt"),
                                "state": incident_state,
                                "priority": priority,
                                "resolvedAt": _loaded_datetime(resolved_at),
                                "closedAt": _loaded_datetime(closed_at),
                            },
                        )
                    )
                publish_one(
                    self._projection(
                        dataset_version,
                        partition,
                        "INCIDENTS#ACTIVE",
                        dependency,
                        active_payload,
                    )
                )
            for source, payload in accumulator.monitoring_payloads():
                publish_one(
                    self._projection(
                        dataset_version, partition, f"MONITORING#{source}", dependency, payload
                    )
                )

        with TemporaryDirectory(prefix="projection-aggregate-") as temporary:
            current: _PartitionAccumulator | None = None
            active_store = _ActiveIncidentStore(Path(temporary) / "active.sqlite3")
            event_store = EventProjectionMaterializer(
                Path(temporary) / "events.sqlite3",
                dataset_version=dataset_version,
                correlation_window_seconds=self.event_correlation_window_seconds,
            )
            completed_keys: set[tuple[str, str]] = set()
            sequence = 0
            try:
                try:
                    active_store.load(raw_active_incidents)
                    for day_records in batches:
                        if self.fact_sink is not None:
                            for values in day_records.values():
                                self.fact_sink.write(values, dataset_version)
                        for key, values in sorted(day_records.items()):
                            if current is None or key != current.key:
                                if current is not None:
                                    publish_partition(current)
                                    completed_keys.add(current.key)
                                    current.close()
                                    current = None
                                if key in completed_keys:
                                    raise ValueError(
                                        "projection pages for one partition must be contiguous"
                                    )
                                database = Path(temporary) / f"partition-{sequence}.sqlite3"
                                sequence += 1
                                current = _PartitionAccumulator(key, database)
                                catalog_counts.setdefault(key, 0)
                            for record in values:
                                current.add(record)
                                if materialize_events and event_batches is None:
                                    event_store.add(key[0], key[1], record)
                    if current is not None:
                        publish_partition(current)
                        current.close()
                        current = None
                finally:
                    if current is not None:
                        current.close()
                    active_store.close()

                if materialize_events:
                    if event_batches is not None:
                        for event_batch in event_batches:
                            for key, values in sorted(event_batch.items()):
                                for record in values:
                                    event_store.add(key[0], key[1], record)
                    event_counts = event_store.finish()
                    for items in event_store.iter_batches():
                        self.repository.put_event_items(items)
                else:
                    event_counts = EventProjectionCounts(0, 0, 0, 0, 0)
            finally:
                event_store.close()
            if materialize_events:
                persisted_families.update({"events", "evidence"})

        ordered = tuple(
            sorted(
                produced,
                key=lambda item: (
                    item.partition_key,
                    item.key,
                    item.operational_sort_key,
                    item.materialization_revision,
                ),
            )
        )
        return ProjectionBuildResult(
            ordered,
            catalog_counts,
            tuple(sorted(persisted_families)),
            event_counts.as_dict() if materialize_events else {},
        )

    def materialize_records(
        self,
        dataset_version: str,
        records: ArchiveRecords,
        *,
        expected_revisions: Mapping[ProjectionTarget, str] | None = None,
    ) -> ProjectionBuildResult:
        """Materializa registros a partir dos fatos de entrada validados.

        Args:
            dataset_version: Identificador imutável da versão do dataset.
            records: Registros canônicos consumidos pela operação.
            expected_revisions: Valor esperado usado para detectar concorrência ou divergência
            de estado.

        Returns:
            Valor ``ProjectionBuildResult`` produzido pela operação após as validações.
        """
        return self.materialize_record_batches(
            dataset_version,
            _same_day_groups(records),
            expected_revisions=expected_revisions,
        )


@dataclass(frozen=True, slots=True)
class RebuildProjectionsRequest:
    """Representa os dados de ``RebuildProjectionsRequest`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        dataset_version: Identificador imutável da versão do dataset.
        partition_keys: Entrada ``partition_keys``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        archive_partitions: Entrada ``archive_partitions``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        expected_revisions: Valor esperado usado para detectar concorrência ou divergência de
        estado.
    """

    dataset_version: str
    partition_keys: tuple[str, ...]
    archive_partitions: Mapping[str, str]
    expected_revisions: Mapping[ProjectionTarget, str] = MappingProxyType({})

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        _require_text(self.dataset_version, "dataset_version")
        if not self.partition_keys or any(
            not isinstance(item, str) or not item for item in self.partition_keys
        ):
            raise ValueError("partition_keys must contain persisted hot partition keys")
        if len(self.partition_keys) != len(set(self.partition_keys)):
            raise ValueError("partition_keys must not contain duplicates")
        matches = tuple(_FACT_PARTITION.fullmatch(item) for item in self.partition_keys)
        if any(match is None for match in matches):
            raise ValueError("partition_keys must identify exact persisted fact partitions")
        matched = tuple(match for match in matches if match is not None)
        if any(match.group("version") != self.dataset_version for match in matched):
            raise ValueError("partition_keys must belong to dataset_version")
        days = {match.group("day") for match in matched}
        if len(days) != 1 or len(matched) > 48:
            raise ValueError("partition_keys must identify one day and at most 48 partitions")
        partitions = dict(self.archive_partitions)
        if not partitions or any(
            not isinstance(dataset, str)
            or not dataset
            or not isinstance(partition, str)
            or not partition
            for dataset, partition in partitions.items()
        ):
            raise ValueError("archive_partitions must map datasets to partitions")
        queried_datasets = {match.group("dataset") for match in matched}
        if set(partitions) != queried_datasets:
            raise ValueError("archive_partitions must match queried fact datasets")
        queried_day = next(iter(days))
        if any(
            partition_date(partition).strftime("%Y%m%d") != queried_day
            for partition in partitions.values()
        ):
            raise ValueError("archive_partitions must match the queried fact day")
        revisions = dict(self.expected_revisions)
        if any(
            not isinstance(target, tuple)
            or len(target) != 3
            or any(not isinstance(part, str) or not part for part in target)
            or not isinstance(revision, str)
            or len(revision) != 68
            or not revision.startswith("pmr_")
            or any(
                character not in "0123456789abcdef" for character in revision.removeprefix("pmr_")
            )
            for target, revision in revisions.items()
        ):
            raise ValueError("expected_revisions must map valid targets to pmr revisions")
        object.__setattr__(self, "partition_keys", tuple(self.partition_keys))
        object.__setattr__(self, "archive_partitions", MappingProxyType(partitions))
        object.__setattr__(self, "expected_revisions", MappingProxyType(revisions))


@dataclass(frozen=True, slots=True)
class RebuildProjections:
    """Representa os dados de ``RebuildProjections`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        service: Entrada ``service``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        manifests: Entrada ``manifests``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
    """

    service: ProjectionService
    manifests: ManifestRepository
    canonical_sets: CanonicalSetStore | None = None
    canonical_source: CanonicalRecordSource | None = None

    def execute(self, request: RebuildProjectionsRequest) -> ProjectionBuildResult:
        """Executa o caso de uso implementado por ``RebuildProjections``.

        Args:
            request: Objeto de entrada já estruturado para o caso de uso.

        Returns:
            Valor ``ProjectionBuildResult`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(request, RebuildProjectionsRequest):
            raise TypeError("request must be a RebuildProjectionsRequest")
        active = self.manifests.get_active()
        if active is not None and active.dataset_version == request.dataset_version:
            raise ConditionalWriteError("cannot rebuild projections for an active dataset version")
        requested = {
            (match.group("dataset"), match.group("day"), match.group("family")): key
            for key in request.partition_keys
            if (match := _FACT_PARTITION.fullmatch(key)) is not None
        }

        def validate_record(record: CanonicalRecord) -> tuple[str, str, str]:
            """Valida registro contra as invariantes deste módulo.

            Args:
                record: Registro canônico consumido pela operação.

            Returns:
                Valor ``tuple[str, str, str]`` produzido pela operação após as validações.

            Raises:
                ValueError: Se um valor estiver fora das invariantes aceitas.
            """
            try:
                partition = request.archive_partitions[record.source_dataset]
            except KeyError as error:
                raise ValueError("persisted fact dataset has no archive partition") from error
            day = partition_date(partition).strftime("%Y%m%d")
            family = _RECORD_FAMILY.get(record.record_type)
            identity = (record.source_dataset, day, family)
            if identity not in requested:
                raise ValueError(
                    "persisted fact differs from the requested dataset, family, or day"
                )
            if partition.startswith("year=") and (
                record.observed_at is None or record.observed_at.strftime("%Y%m%d") != day
            ):
                raise ValueError("persisted event-time fact differs from the requested day")
            assert family is not None
            return record.source_dataset, day, family

        with TemporaryDirectory(prefix="projection-rebuild-snapshot-") as temporary:
            snapshot = _RebuildInputSnapshot(Path(temporary) / "inputs.sqlite3")
            present: set[str] = set()
            try:
                if (self.canonical_sets is None) != (self.canonical_source is None):
                    raise ValueError(
                        "canonical set store and record source must be configured together"
                    )
                canonical_set = None
                if self.canonical_sets is not None and self.canonical_source is not None:
                    canonical_set = self.canonical_sets.get(request.dataset_version)
                if canonical_set is not None and self.canonical_source is not None:
                    for batch in self.canonical_source.iter_batches(canonical_set):
                        for (dataset, partition), records in batch.items():
                            if request.archive_partitions.get(dataset) != partition:
                                continue
                            for record in records:
                                identity = validate_record(record)
                                present.add(requested[identity])
                                snapshot.add(dataset, partition, record)
                else:
                    for records in self.service.repository.iter_input_batches(
                        request.dataset_version,
                        tuple(sorted(request.partition_keys)),
                    ):
                        for record in records:
                            identity = validate_record(record)
                            present.add(requested[identity])
                            snapshot.add(
                                record.source_dataset,
                                request.archive_partitions[record.source_dataset],
                                record,
                            )
                missing = set(request.partition_keys) - present
                if not present:
                    raise ValueError("persisted projection input contains no facts")
                if missing:
                    raise ValueError(
                        f"requested projection partitions are missing facts: {sorted(missing)}"
                    )

                rebuild_event_batches = (
                    self.canonical_source.iter_batches(canonical_set)
                    if canonical_set is not None and self.canonical_source is not None
                    else None
                )
                return self.service.materialize_record_batches(
                    request.dataset_version,
                    snapshot.batches(),
                    expected_revisions=request.expected_revisions,
                    retain_projections=False,
                    event_batches=rebuild_event_batches,
                    materialize_events=rebuild_event_batches is not None,
                )
            finally:
                snapshot.close()


__all__ = [
    "ArchiveRecords",
    "ProjectionBuildResult",
    "ProjectionService",
    "ProjectionTarget",
    "RebuildProjections",
    "RebuildProjectionsRequest",
]
