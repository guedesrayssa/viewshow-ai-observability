"""Expõe os construtores fechados das projeções operacionais do dashboard.

Papel no fluxo:
    No fluxo da aplicação, este módulo coordena regras do domínio por meio das interfaces de
    ``ports`` e não depende diretamente de SDKs ou formatos de infraestrutura.

Garantias e limites:
    A ordem das operações preserva idempotência, reconciliação e retomada segura quando uma
    execução é interrompida.
"""

from application.projections.event_correlation import (
    CORRELATION_RULE_VERSION,
    CorrelationOutcome,
    EventIncidentLink,
    IncidentCorrelationInput,
    ProjectedEvidence,
    correlate_event,
    correlate_event_fields,
)
from application.projections.events import (
    EventQuality,
    ProjectedEvent,
    RawAvailability,
    project_event,
)

__all__ = [
    "CORRELATION_RULE_VERSION",
    "CorrelationOutcome",
    "EventIncidentLink",
    "EventQuality",
    "IncidentCorrelationInput",
    "ProjectedEvent",
    "ProjectedEvidence",
    "RawAvailability",
    "correlate_event",
    "correlate_event_fields",
    "project_event",
]
