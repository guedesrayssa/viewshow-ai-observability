"""Repositório de telemetria sobre o Amazon DynamoDB.

Modelagem (tabela única), desenhada a partir dos padrões de acesso da API:

| Atributo     | Papel                                                          |
| ------------ | -------------------------------------------------------------- |
| `pk`         | `{TIPO}#{início do bucket}` — agrupa registros por faixa de tempo |
| `sk`         | `{horário}#{id}` — ordena dentro do bucket e garante unicidade  |
| `trace_id`   | chave de partição do índice `trace-index` (esparso)             |
| `expires_at` | epoch usado pelo TTL nativo do DynamoDB                         |

Consultar uma janela vira uma `Query` por bucket — nunca uma varredura da
tabela — e as consultas dos vários buckets são disparadas em paralelo. Abrir um
trace é uma `Query` no índice esparso, que só contém registros com `trace_id`.

O horário na chave de ordenação usa largura fixa (com microssegundos sempre
presentes) porque o DynamoDB ordena `sk` lexicograficamente: sem isso,
`12:00:00.5Z` viria antes de `12:00:00Z`.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable, Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from app.domain.clock import ensure_utc, to_iso
from app.domain.models import (
    DeviceInfo,
    ErrorEvent,
    Heartbeat,
    NetworkInfo,
    PlaybackEvent,
    Span,
)
from app.domain.time_window import TimeWindow
from app.repositories.base import TelemetryRepository

try:  # pragma: no cover - depende do ambiente de instalação
    import boto3
    from boto3.dynamodb.types import TypeDeserializer, TypeSerializer
except ImportError:  # pragma: no cover
    boto3 = None
    TypeDeserializer = TypeSerializer = None

EVENT = "EVENT"
ERROR = "ERROR"
HEARTBEAT = "HEARTBEAT"

TRACE_INDEX = "trace-index"

DEFAULT_TABLE_NAME = "telemetry"
DEFAULT_BUCKET_SECONDS = 3_600
DEFAULT_MAX_WORKERS = 8
DEFAULT_RETENTION = timedelta(hours=24)

# Limites e formatos impostos pelo próprio DynamoDB.
_BATCH_WRITE_LIMIT = 25
_MAX_WRITE_ATTEMPTS = 5
_KEY_TIME_FORMAT = "%Y-%m-%dT%H:%M:%S.%f"
_MAX_SUFFIX = "￿"


class DynamoDbTelemetryRepository(TelemetryRepository):
    """Armazenamento dos registros de telemetria em uma tabela DynamoDB."""

    def __init__(
        self,
        *,
        table_name: str = DEFAULT_TABLE_NAME,
        client: Any = None,
        region_name: str | None = None,
        endpoint_url: str | None = None,
        retention: timedelta = DEFAULT_RETENTION,
        bucket_seconds: int = DEFAULT_BUCKET_SECONDS,
        max_workers: int = DEFAULT_MAX_WORKERS,
    ) -> None:
        if TypeSerializer is None:
            raise RuntimeError(
                "O backend DynamoDB exige o pacote `boto3`; instale-o com "
                "`pip install -r requirements.txt`."
            )
        if client is None:
            client = boto3.client("dynamodb", region_name=region_name, endpoint_url=endpoint_url)

        self._client = client
        self._table_name = table_name
        self._retention = retention
        self._bucket_seconds = bucket_seconds
        self._max_workers = max(max_workers, 1)
        self._serializer = TypeSerializer()
        self._deserializer = TypeDeserializer()

    # Escrita ------------------------------------------------------------

    def add_events(self, events: Iterable[PlaybackEvent]) -> int:
        return self._put(events, EVENT, _event_attributes)

    def add_errors(self, errors: Iterable[ErrorEvent]) -> int:
        return self._put(errors, ERROR, _error_attributes)

    def add_heartbeats(self, heartbeats: Iterable[Heartbeat]) -> int:
        return self._put(heartbeats, HEARTBEAT, _heartbeat_attributes)

    # Leitura ------------------------------------------------------------

    def events(self, window: TimeWindow | None = None) -> list[PlaybackEvent]:
        return self._read(EVENT, window, _to_event)

    def errors(self, window: TimeWindow | None = None) -> list[ErrorEvent]:
        return self._read(ERROR, window, _to_error)

    def heartbeats(self, window: TimeWindow | None = None) -> list[Heartbeat]:
        return self._read(HEARTBEAT, window, _to_heartbeat)

    def records_for_trace(self, trace_id: str) -> tuple[list[PlaybackEvent], list[ErrorEvent]]:
        """Resolve o trace pelo índice esparso, sem varrer a tabela."""
        items = self._paginate(
            self._client.query,
            TableName=self._table_name,
            IndexName=TRACE_INDEX,
            KeyConditionExpression="trace_id = :trace",
            ExpressionAttributeValues=self._encode_values({":trace": trace_id}),
        )

        events, errors = [], []
        for item in items:
            if item.get("record_type") == EVENT:
                events.append(_to_event(item))
            elif item.get("record_type") == ERROR:
                errors.append(_to_error(item))

        events.sort(key=lambda record: record.occurred_at)
        errors.sort(key=lambda record: record.occurred_at)
        return events, errors

    def stats(self) -> dict[str, int]:
        """Contagem por tipo. Custa uma varredura: use para diagnóstico."""
        return {
            "events": self._count(EVENT),
            "errors": self._count(ERROR),
            "heartbeats": self._count(HEARTBEAT),
        }

    def clear(self) -> None:
        """Apaga todos os itens da tabela. Apenas para desenvolvimento e testes."""
        keys = [
            {"pk": item["pk"], "sk": item["sk"]}
            for item in self._paginate(
                self._client.scan,
                TableName=self._table_name,
                ProjectionExpression="pk, sk",
            )
        ]
        for chunk in _chunks(keys, _BATCH_WRITE_LIMIT):
            self._write_batch(
                [{"DeleteRequest": {"Key": self._encode(key)}} for key in chunk]
            )

    # Internos -----------------------------------------------------------

    def _put(
        self,
        records: Iterable[Any],
        record_type: str,
        attributes: Callable[[Any], dict[str, Any]],
    ) -> int:
        items = [self._item(record, record_type, attributes) for record in records]
        for chunk in _chunks(items, _BATCH_WRITE_LIMIT):
            self._write_batch([{"PutRequest": {"Item": self._encode(item)}} for item in chunk])
        return len(items)

    def _item(
        self,
        record: Any,
        record_type: str,
        attributes: Callable[[Any], dict[str, Any]],
    ) -> dict[str, Any]:
        occurred_at = ensure_utc(record.occurred_at)
        item = {
            "pk": self._bucket_key(record_type, occurred_at),
            "sk": f"{_sort_key(occurred_at)}#{uuid.uuid4().hex}",
            "record_type": record_type,
            "occurred_at": to_iso(occurred_at),
            "session_id": record.session_id,
            "expires_at": int((occurred_at + self._retention).timestamp()),
            **attributes(record),
        }
        return _clean(item)

    def _read(
        self,
        record_type: str,
        window: TimeWindow | None,
        build: Callable[[dict[str, Any]], Any],
    ) -> list[Any]:
        if window is None:
            items = self._scan_all(record_type)
        else:
            items = self._query_window(record_type, window)

        records = [build(item) for item in items]
        records.sort(key=lambda record: record.occurred_at)
        return records

    def _query_window(self, record_type: str, window: TimeWindow) -> list[dict[str, Any]]:
        """Uma `Query` por bucket de tempo, disparadas em paralelo."""
        buckets = self._buckets_for(record_type, window)
        bounds = self._encode_values(
            {
                ":low": f"{_sort_key(window.start)}#",
                ":high": f"{_sort_key(window.end)}#{_MAX_SUFFIX}",
            }
        )

        def fetch(bucket: str) -> list[dict[str, Any]]:
            values = {**bounds, **self._encode_values({":pk": bucket})}
            return self._paginate(
                self._client.query,
                TableName=self._table_name,
                KeyConditionExpression="pk = :pk AND sk BETWEEN :low AND :high",
                ExpressionAttributeValues=values,
            )

        if len(buckets) == 1:
            return fetch(buckets[0])

        with ThreadPoolExecutor(max_workers=min(self._max_workers, len(buckets))) as pool:
            return [item for page in pool.map(fetch, buckets) for item in page]

    def _scan_all(self, record_type: str) -> list[dict[str, Any]]:
        """Leitura sem janela: varre a tabela. Uso em testes e diagnóstico."""
        return self._paginate(
            self._client.scan,
            TableName=self._table_name,
            FilterExpression="record_type = :type",
            ExpressionAttributeValues=self._encode_values({":type": record_type}),
        )

    def _count(self, record_type: str) -> int:
        total = 0
        start_key = None
        while True:
            request: dict[str, Any] = {
                "TableName": self._table_name,
                "Select": "COUNT",
                "FilterExpression": "record_type = :type",
                "ExpressionAttributeValues": self._encode_values({":type": record_type}),
            }
            if start_key:
                request["ExclusiveStartKey"] = start_key
            response = self._client.scan(**request)
            total += response.get("Count", 0)
            start_key = response.get("LastEvaluatedKey")
            if not start_key:
                return total

    def _paginate(self, operation: Callable[..., dict], **request: Any) -> list[dict[str, Any]]:
        """Percorre todas as páginas: sem isso, a leitura para no 1º MB."""
        items: list[dict[str, Any]] = []
        while True:
            page = operation(**request)
            items.extend(self._decode(item) for item in page.get("Items", []))

            start_key = page.get("LastEvaluatedKey")
            if not start_key:
                return items
            request["ExclusiveStartKey"] = start_key

    def _write_batch(self, requests: Sequence[dict[str, Any]]) -> None:
        """Grava um lote, reenviando o que o DynamoDB devolver como pendente."""
        pending = {self._table_name: list(requests)}
        for attempt in range(_MAX_WRITE_ATTEMPTS):
            response = self._client.batch_write_item(RequestItems=pending)
            pending = {
                table: unprocessed
                for table, unprocessed in response.get("UnprocessedItems", {}).items()
                if unprocessed
            }
            if not pending:
                return
            time.sleep(min(0.05 * 2**attempt, 1.0))

        raise RuntimeError(
            "O DynamoDB não aceitou parte do lote após várias tentativas; "
            "verifique a capacidade provisionada da tabela."
        )

    def _bucket_key(self, record_type: str, moment: datetime) -> str:
        epoch = int(moment.timestamp())
        start = epoch - (epoch % self._bucket_seconds)
        label = datetime.fromtimestamp(start, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return f"{record_type}#{label}"

    def _buckets_for(self, record_type: str, window: TimeWindow) -> list[str]:
        step = self._bucket_seconds
        start = int(window.start.timestamp())
        start -= start % step
        end = int(window.end.timestamp())
        return [
            self._bucket_key(record_type, datetime.fromtimestamp(moment, tz=timezone.utc))
            for moment in range(start, end + 1, step)
        ]

    def _encode(self, item: dict[str, Any]) -> dict[str, Any]:
        return {key: self._serializer.serialize(value) for key, value in item.items()}

    def _encode_values(self, values: dict[str, Any]) -> dict[str, Any]:
        return self._encode(values)

    def _decode(self, item: dict[str, Any]) -> dict[str, Any]:
        return {key: self._deserializer.deserialize(value) for key, value in item.items()}


# Provisionamento -----------------------------------------------------------


def create_table(
    client: Any,
    table_name: str = DEFAULT_TABLE_NAME,
    *,
    billing_mode: str = "PAY_PER_REQUEST",
) -> bool:
    """Cria a tabela, o índice de traces e o TTL. Devolve `False` se já existia.

    É a mesma definição usada pelos testes, para que o esquema exercitado seja
    o que vai para a AWS.
    """
    try:
        client.create_table(
            TableName=table_name,
            BillingMode=billing_mode,
            AttributeDefinitions=[
                {"AttributeName": "pk", "AttributeType": "S"},
                {"AttributeName": "sk", "AttributeType": "S"},
                {"AttributeName": "trace_id", "AttributeType": "S"},
            ],
            KeySchema=[
                {"AttributeName": "pk", "KeyType": "HASH"},
                {"AttributeName": "sk", "KeyType": "RANGE"},
            ],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": TRACE_INDEX,
                    "KeySchema": [
                        {"AttributeName": "trace_id", "KeyType": "HASH"},
                        {"AttributeName": "sk", "KeyType": "RANGE"},
                    ],
                    "Projection": {"ProjectionType": "ALL"},
                }
            ],
        )
    except client.exceptions.ResourceInUseException:
        return False

    client.get_waiter("table_exists").wait(TableName=table_name)
    # A retenção é delegada ao TTL nativo: o DynamoDB apaga os itens vencidos
    # sem custo de escrita, em até 48h após o horário de expiração.
    client.update_time_to_live(
        TableName=table_name,
        TimeToLiveSpecification={"Enabled": True, "AttributeName": "expires_at"},
    )
    return True


# Serialização --------------------------------------------------------------


def _number(value: float | int | None) -> Decimal | None:
    """O DynamoDB não aceita `float`: números viram `Decimal`."""
    if value is None:
        return None
    return Decimal(str(value))


def _float(value: Any, default: float | None = None) -> float | None:
    if value is None:
        return default
    return float(value)


def _clean(mapping: dict[str, Any]) -> dict[str, Any]:
    """Remove chaves nulas: mantém os itens enxutos e o índice esparso."""
    return {key: value for key, value in mapping.items() if value is not None}


def _chunks(items: Sequence[Any], size: int) -> Iterable[Sequence[Any]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def _sort_key(moment: datetime) -> str:
    """Horário de largura fixa, para que a ordem lexicográfica seja cronológica."""
    return ensure_utc(moment).strftime(_KEY_TIME_FORMAT) + "Z"


def _device_map(device: DeviceInfo) -> dict[str, str]:
    return device.as_dict()


def _network_map(network: NetworkInfo) -> dict[str, str]:
    return network.as_dict()


def _span_map(span: Span) -> dict[str, Any]:
    return _clean(
        {
            "span_id": span.span_id,
            "trace_id": span.trace_id,
            "service": span.service,
            "operation": span.operation,
            "started_at": to_iso(span.started_at),
            "duration_ms": _number(span.duration_ms),
            "status": span.status,
            "parent_span_id": span.parent_span_id,
        }
    )


def _to_span(item: dict[str, Any]) -> Span:
    return Span(
        span_id=item["span_id"],
        trace_id=item["trace_id"],
        service=item["service"],
        operation=item["operation"],
        started_at=datetime.fromisoformat(item["started_at"].replace("Z", "+00:00")),
        duration_ms=_float(item.get("duration_ms"), 0.0),
        status=item["status"],
        parent_span_id=item.get("parent_span_id"),
    )


def _common_attributes(record: Any) -> dict[str, Any]:
    return {
        "device": _device_map(record.device),
        "network": _network_map(record.network),
        "content_id": record.content_id,
        "trace_id": getattr(record, "trace_id", None),
        "spans": [_span_map(span) for span in getattr(record, "spans", ())] or None,
    }


def _event_attributes(event: PlaybackEvent) -> dict[str, Any]:
    return {
        **_common_attributes(event),
        "event_type": event.event_type,
        "startup_time_ms": _number(event.startup_time_ms),
        "rebuffer_duration_ms": _number(event.rebuffer_duration_ms),
        "rebuffer_count": event.rebuffer_count,
        "playback_duration_ms": _number(event.playback_duration_ms),
        "bitrate_kbps": _number(event.bitrate_kbps),
    }


def _error_attributes(error: ErrorEvent) -> dict[str, Any]:
    return {
        **_common_attributes(error),
        "error_code": error.error_code,
        "message": error.message,
        "module": error.module,
        "service": error.service,
        "fatal": error.fatal,
    }


def _heartbeat_attributes(heartbeat: Heartbeat) -> dict[str, Any]:
    return {
        "device": _device_map(heartbeat.device),
        "network": _network_map(heartbeat.network),
        "content_id": heartbeat.content_id,
    }


def _occurred_at(item: dict[str, Any]) -> datetime:
    return datetime.fromisoformat(item["occurred_at"].replace("Z", "+00:00"))


def _device(item: dict[str, Any]) -> DeviceInfo:
    return DeviceInfo(**item.get("device", {}))


def _network(item: dict[str, Any]) -> NetworkInfo:
    return NetworkInfo(**item.get("network", {}))


def _spans(item: dict[str, Any]) -> tuple[Span, ...]:
    return tuple(_to_span(span) for span in item.get("spans", ()))


def _to_event(item: dict[str, Any]) -> PlaybackEvent:
    return PlaybackEvent(
        session_id=item["session_id"],
        event_type=item["event_type"],
        occurred_at=_occurred_at(item),
        device=_device(item),
        network=_network(item),
        content_id=item.get("content_id"),
        trace_id=item.get("trace_id"),
        startup_time_ms=_float(item.get("startup_time_ms")),
        rebuffer_duration_ms=_float(item.get("rebuffer_duration_ms"), 0.0),
        rebuffer_count=int(item.get("rebuffer_count", 0)),
        playback_duration_ms=_float(item.get("playback_duration_ms"), 0.0),
        bitrate_kbps=_float(item.get("bitrate_kbps")),
        spans=_spans(item),
    )


def _to_error(item: dict[str, Any]) -> ErrorEvent:
    return ErrorEvent(
        session_id=item["session_id"],
        error_code=item["error_code"],
        occurred_at=_occurred_at(item),
        message=item.get("message", ""),
        module=item["module"],
        service=item["service"],
        fatal=bool(item.get("fatal", False)),
        device=_device(item),
        network=_network(item),
        content_id=item.get("content_id"),
        trace_id=item.get("trace_id"),
        spans=_spans(item),
    )


def _to_heartbeat(item: dict[str, Any]) -> Heartbeat:
    return Heartbeat(
        session_id=item["session_id"],
        occurred_at=_occurred_at(item),
        device=_device(item),
        network=_network(item),
        content_id=item.get("content_id"),
    )
