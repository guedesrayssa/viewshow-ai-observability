"""Define falhas compartilhadas por operações condicionais e idempotentes.

Papel no fluxo:
    Este módulo forma a fronteira tipada entre os casos de uso e seus adaptadores concretos.

Garantias e limites:
    Implementações devem preservar as invariantes descritas aqui, inclusive idempotência,
    controle de concorrência e imutabilidade dos valores transportados.
"""

from domain.archive import ArchiveNotAvailable as DomainArchiveNotAvailable


class PortContractError(RuntimeError):
    """Indica que ``PortContractError`` impediu a operação de continuar com segurança."""


class ConditionalWriteError(PortContractError):
    """Indica que ``ConditionalWriteError`` impediu a operação de continuar com segurança."""


class IdempotencyConflict(PortContractError):
    """Indica que ``IdempotencyConflict`` impediu a operação de continuar com segurança."""


class ConcurrentActivationError(ConditionalWriteError):
    """Indica que ``ConcurrentActivationError`` impediu a operação de continuar com segurança."""


class ArchiveNotAvailable(DomainArchiveNotAvailable, ConditionalWriteError):
    """Indica que ``ArchiveNotAvailable`` impediu a operação de continuar com segurança."""


class StaleCheckpoint(ConditionalWriteError):
    """Indica que ``StaleCheckpoint`` impediu a operação de continuar com segurança."""


class LeaseBusy(ConditionalWriteError):
    """Indica que ``LeaseBusy`` impediu a operação de continuar com segurança."""


class LeaseOwnershipError(ConditionalWriteError):
    """Indica que ``LeaseOwnershipError`` impediu a operação de continuar com segurança."""


class SnapshotChecksumMismatch(PortContractError):
    """Indica que ``SnapshotChecksumMismatch`` impediu a operação de continuar com segurança."""


class ArchiveReconciliationError(PortContractError):
    """Indica que ``ArchiveReconciliationError`` impediu a operação de continuar com segurança."""


__all__ = [
    "ArchiveReconciliationError",
    "ArchiveNotAvailable",
    "ConcurrentActivationError",
    "ConditionalWriteError",
    "IdempotencyConflict",
    "LeaseBusy",
    "LeaseOwnershipError",
    "PortContractError",
    "SnapshotChecksumMismatch",
    "StaleCheckpoint",
]
