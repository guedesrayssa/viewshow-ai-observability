"""Modelos de domínio da telemetria.

Os registros são imutáveis: uma vez ingeridos, só são lidos pelas consultas
analíticas. Isso torna o repositório seguro para acesso concorrente.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from app.domain.fingerprint import fingerprint_for

UNKNOWN = "unknown"

SPAN_OK = "ok"
SPAN_ERROR = "error"


@dataclass(frozen=True, slots=True)
class DeviceInfo:
    """Identificação do dispositivo que originou o registro."""

    model: str = UNKNOWN
    os: str = UNKNOWN
    os_version: str = UNKNOWN
    app_version: str = UNKNOWN

    def as_dict(self) -> dict[str, str]:
        return {
            "model": self.model,
            "os": self.os,
            "os_version": self.os_version,
            "app_version": self.app_version,
        }


@dataclass(frozen=True, slots=True)
class NetworkInfo:
    """Caminho de rede usado pela sessão."""

    isp: str = UNKNOWN
    cdn: str = UNKNOWN
    connection_type: str = UNKNOWN

    def as_dict(self) -> dict[str, str]:
        return {"isp": self.isp, "cdn": self.cdn, "connection_type": self.connection_type}


@dataclass(frozen=True, slots=True)
class Span:
    """Trecho de execução de um serviço dentro de um trace distribuído."""

    span_id: str
    trace_id: str
    service: str
    operation: str
    started_at: datetime
    duration_ms: float = 0.0
    status: str = SPAN_OK
    parent_span_id: str | None = None

    @property
    def failed(self) -> bool:
        return self.status == SPAN_ERROR

    @property
    def ended_at(self) -> datetime:
        return self.started_at + timedelta(milliseconds=self.duration_ms)


@dataclass(frozen=True, slots=True)
class PlaybackEvent:
    """Evento de reprodução enviado pelo player."""

    session_id: str
    event_type: str
    occurred_at: datetime
    device: DeviceInfo = field(default_factory=DeviceInfo)
    network: NetworkInfo = field(default_factory=NetworkInfo)
    content_id: str | None = None
    trace_id: str | None = None
    startup_time_ms: float | None = None
    rebuffer_duration_ms: float = 0.0
    rebuffer_count: int = 0
    playback_duration_ms: float = 0.0
    bitrate_kbps: float | None = None
    spans: tuple[Span, ...] = ()


@dataclass(frozen=True, slots=True)
class ErrorEvent:
    """Exceção ou falha reportada pela aplicação."""

    session_id: str
    error_code: str
    occurred_at: datetime
    message: str = ""
    module: str = UNKNOWN
    service: str = UNKNOWN
    fatal: bool = False
    device: DeviceInfo = field(default_factory=DeviceInfo)
    network: NetworkInfo = field(default_factory=NetworkInfo)
    content_id: str | None = None
    trace_id: str | None = None
    spans: tuple[Span, ...] = ()

    # Derivado dos demais campos, nunca informado pelo chamador: fica fora do
    # construtor para não haver como guardar um fingerprint desatualizado.
    fingerprint: str = field(init=False, default="")

    def __post_init__(self) -> None:
        """Deriva o fingerprint na criação; as consultas de RCA apenas o leem."""
        object.__setattr__(
            self, "fingerprint", fingerprint_for(self.error_code, self.module, self.message)
        )


@dataclass(frozen=True, slots=True)
class Heartbeat:
    """Sinal periódico de presença de uma sessão ativa."""

    session_id: str
    occurred_at: datetime
    device: DeviceInfo = field(default_factory=DeviceInfo)
    network: NetworkInfo = field(default_factory=NetworkInfo)
    content_id: str | None = None
