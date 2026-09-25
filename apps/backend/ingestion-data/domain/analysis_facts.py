"""Fatos de série temporal que o worker de análise consulta no DynamoDB.

Papel no fluxo:
    Converte registros canônicos dos datasets de série em itens de fato com a identidade estável
    de série do catálogo do worker. A chave de partição, o formato da chave de ordenação e o
    ``seriesId`` formam o contrato executável entre a ingestão e o worker.

Garantias e limites:
    Só entram no resultado as séries listadas no catálogo. A construção é determinística: o mesmo
    registro gera sempre o mesmo item, então repetir a escrita não altera o estado persistido.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from functools import lru_cache
from types import MappingProxyType

from domain.models import CanonicalRecord

FACT_ITEM_TYPE = "time-series-fact"
FACT_GRAINS = frozenset({900, 3600})
MAX_CATALOG_BYTES = 5 * 1024 * 1024

_SERIES_ID = re.compile(r"ts_[0-9a-f]{64}")
_CHANNEL_DATASETS = frozenset({"live_active_15min", "live_qoe_hourly"})
# Fontes de entrega em ``signal_bucket`` cuja taxa de erro vira uma série por canal.
_DELIVERY_METRICS: Mapping[str, str] = MappingProxyType(
    {
        "cdn_live_errors": "cdn_live_err_rate",
        "origin_live_errors": "origin_live_err_rate",
        "origin_cdn_live_errors": "origin_cdn_live_err_rate",
    }
)
_DELIVERY_SOURCE_METRIC = "err_rate"


@dataclass(frozen=True)
class SeriesIdentity:
    """Identifica uma série pelos mesmos campos que compõem o ``seriesId`` do catálogo."""

    logical_dataset: str
    source: str
    entity: str
    metric: str
    dimensions: Mapping[str, str]


def canonical_series_identity(identity: SeriesIdentity) -> str:
    """Serializa a identidade no JSON compacto cujo SHA-256 vira o ``seriesId``."""
    value = {
        "logicalDataset": identity.logical_dataset,
        "source": identity.source,
        "entity": identity.entity,
        "metric": identity.metric,
        "dimensions": sorted(identity.dimensions.items()),
    }
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def series_id(identity: SeriesIdentity) -> str:
    """Devolve o ``seriesId`` (``ts_`` mais SHA-256) da identidade canônica."""
    digest = hashlib.sha256(canonical_series_identity(identity).encode()).hexdigest()
    return f"ts_{digest}"


@lru_cache(maxsize=16_384)
def _channel_series_id(logical_dataset: str, source: str, entity: str, metric: str) -> str:
    """Calcula uma vez o ``seriesId`` das séries por canal, que se repetem a cada bucket."""
    identity = SeriesIdentity(logical_dataset, source, entity, metric, {"channel": entity})
    return series_id(identity)


def _instant(value: str | datetime) -> datetime:
    parsed = (
        value
        if isinstance(value, datetime)
        else datetime.fromisoformat(value.replace("Z", "+00:00"))
    )
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        raise ValueError("observed_at must be an ISO-8601 UTC instant")
    return parsed.astimezone(UTC)


def _metric_value(value: object) -> int | Decimal | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float | Decimal):
        raise ValueError("value must be finite or null")
    number = Decimal(str(value)) if isinstance(value, float) else value
    if isinstance(number, Decimal) and not number.is_finite():
        raise ValueError("value must be finite or null")
    return number


def build_fact(
    *,
    dataset_version: str,
    identity: SeriesIdentity,
    observed_at: str | datetime,
    grain_seconds: int,
    unit: str,
    value: object,
) -> dict[str, object]:
    """Devolve o item exato que ``DynamoAnalysisStore.read`` espera para um ponto da série.

    Args:
        dataset_version: Versão do dataset à qual o fato pertence.
        identity: Identidade da série, da qual deriva o ``seriesId``.
        observed_at: Início do bucket, em UTC e alinhado a ``grain_seconds``.
        grain_seconds: Granularidade do bucket, 900 ou 3600.
        unit: Unidade declarada pelo catálogo para a métrica.
        value: Valor numérico finito ou ``None`` quando a fonte não mediu o bucket.

    Raises:
        ValueError: Se algum dado violar o contrato do fato.
    """
    if not dataset_version or not unit or grain_seconds not in FACT_GRAINS:
        raise ValueError("invalid fact metadata")
    observed = _instant(observed_at)
    if observed.microsecond or int(observed.timestamp()) % grain_seconds:
        raise ValueError("observed_at is not aligned to grain_seconds")
    number = _metric_value(value)
    sid = series_id(identity)
    observed_text = observed.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    record_input = f"{dataset_version}|{sid}|{observed_text}|{grain_seconds}"
    record_id = "fact_" + hashlib.sha256(record_input.encode()).hexdigest()
    return {
        "pk": f"DATASET#{dataset_version}#FACT#TS#{sid}#{observed.strftime('%Y%m%d')}",
        "sk": f"T#{int(observed.timestamp()) * 1000}#{record_id}",
        "itemType": FACT_ITEM_TYPE,
        "recordId": record_id,
        "datasetVersion": dataset_version,
        "seriesId": sid,
        "observedAt": observed_text,
        "grainSeconds": grain_seconds,
        "source": identity.source,
        "entity": identity.entity,
        "dimensions": dict(sorted(identity.dimensions.items())),
        "payload": {"metric": {"name": identity.metric, "unit": unit, "value": number}},
    }


@dataclass(frozen=True)
class FactSeries:
    """Série declarada no catálogo do worker."""

    series_id: str
    metric: str
    unit: str
    grain_seconds: int


@dataclass(frozen=True)
class AnalysisFactCatalog:
    """Séries que o worker consulta, indexadas por ``seriesId``.

    Attributes:
        series: Definição de cada série do catálogo.
        entities: Entidades dos escopos, usadas para descartar cedo os registros fora do piloto.
    """

    series: Mapping[str, FactSeries]
    entities: frozenset[str]

    @classmethod
    def from_json(cls, raw: bytes | str) -> AnalysisFactCatalog:
        """Lê o catálogo de escopos do worker (lista de escopos com suas séries).

        Raises:
            ValueError: Se o documento não seguir o formato do catálogo.
        """
        try:
            document = json.loads(raw)
        except ValueError as error:
            raise ValueError("analysis catalog is not valid JSON") from error
        if not isinstance(document, list) or not document:
            raise ValueError("analysis catalog must be a non-empty list of scopes")
        series: dict[str, FactSeries] = {}
        entities: set[str] = set()
        for scope in document:
            if not isinstance(scope, dict) or not isinstance(scope.get("series"), list):
                raise ValueError("analysis catalog scope must declare its series")
            entity = scope.get("entity")
            if not isinstance(entity, str) or not entity:
                raise ValueError("analysis catalog scope must declare its entity")
            entities.add(entity)
            for raw_series in scope["series"]:
                entry = _catalog_series(raw_series)
                if series.setdefault(entry.series_id, entry) != entry:
                    raise ValueError("analysis catalog series has conflicting definitions")
        return cls(MappingProxyType(series), frozenset(entities))


def _catalog_series(value: object) -> FactSeries:
    if not isinstance(value, dict):
        raise ValueError("analysis catalog series must be an object")
    identifier, metric, unit = value.get("seriesId"), value.get("metric"), value.get("unit")
    grain = value.get("grainSeconds")
    if (
        not isinstance(identifier, str)
        or _SERIES_ID.fullmatch(identifier) is None
        or not isinstance(metric, str)
        or not metric
        or not isinstance(unit, str)
        or not unit
        or isinstance(grain, bool)
        or grain not in FACT_GRAINS
    ):
        raise ValueError("analysis catalog series has an invalid definition")
    return FactSeries(identifier, metric, unit, int(grain))


def _candidate_series(
    record: CanonicalRecord, catalog: AnalysisFactCatalog
) -> Iterator[tuple[str, str, str, str, object]]:
    """Enumera ``(dataset lógico, fonte, entidade, métrica, valor)`` que o registro pode gerar."""
    dimensions = record.dimensions
    if record.source_dataset in _CHANNEL_DATASETS:
        entity = dimensions.get("sinal")
        if isinstance(entity, str) and entity in catalog.entities:
            for metric, value in record.measures.items():
                yield record.source_dataset, record.source_system, entity, metric, value
    elif record.source_dataset == "signal_bucket":
        source, entity = dimensions.get("source"), dimensions.get("entity")
        if (
            isinstance(source, str)
            and source in _DELIVERY_METRICS
            and dimensions.get("metric") == _DELIVERY_SOURCE_METRIC
            and isinstance(entity, str)
            and entity in catalog.entities
        ):
            yield (
                source,
                record.source_system,
                entity,
                _DELIVERY_METRICS[source],
                record.measures.get("value"),
            )


def facts_from_records(
    records: Iterable[CanonicalRecord],
    dataset_version: str,
    catalog: AnalysisFactCatalog,
) -> tuple[dict[str, object], ...]:
    """Deriva, em ordem determinística, os fatos das séries do catálogo presentes nos registros.

    Args:
        records: Registros canônicos já confirmados.
        dataset_version: Versão do dataset que os registros compõem.
        catalog: Séries que o worker consulta.

    Raises:
        ValueError: Se um registro do catálogo não trouxer janela, tiver granularidade diferente
            da declarada ou repetir a chave de um fato com valor diferente.
    """
    items: dict[tuple[str, str], dict[str, object]] = {}
    for record in records:
        for dataset, source, entity, metric, value in _candidate_series(record, catalog):
            entry = catalog.series.get(_channel_series_id(dataset, source, entity, metric))
            if entry is None:
                continue
            window = record.window
            if window is None:
                raise ValueError(f"series {entry.metric} record must carry its bucket window")
            if window.grain_seconds != entry.grain_seconds:
                raise ValueError(f"series {entry.metric} grain differs from the catalog")
            item = build_fact(
                dataset_version=dataset_version,
                identity=SeriesIdentity(dataset, source, entity, metric, {"channel": entity}),
                observed_at=window.start,
                grain_seconds=entry.grain_seconds,
                unit=entry.unit,
                value=value,
            )
            key = (str(item["pk"]), str(item["sk"]))
            if items.setdefault(key, item) != item:
                raise ValueError(f"duplicate fact key has conflicting payload: {key[1]}")
    return tuple(items[key] for key in sorted(items))


__all__ = [
    "FACT_GRAINS",
    "FACT_ITEM_TYPE",
    "MAX_CATALOG_BYTES",
    "AnalysisFactCatalog",
    "FactSeries",
    "SeriesIdentity",
    "build_fact",
    "canonical_series_identity",
    "facts_from_records",
    "series_id",
]
