"""Valida ambiente, contrato e checksum do snapshot sem publicar dados.

Papel no fluxo:
    No fluxo da aplicação, este módulo coordena regras do domínio por meio das interfaces de
    ``ports`` e não depende diretamente de SDKs ou formatos de infraestrutura.

Garantias e limites:
    A ordem das operações preserva idempotência, reconciliação e retomada segura quando uma
    execução é interrompida.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType

from contracts.registry import DatasetRegistry
from domain.identity import dataset_version
from ports import RestoreRequest, RestoreResult

type ChecksumVerifier = Callable[[RestoreRequest], RestoreResult]


@dataclass(frozen=True, slots=True)
class ValidateRequest:
    """Representa os dados de ``ValidateRequest`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        restore_request: Entrada ``restore_request``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        environment: Mapeamento de variáveis de ambiente disponível para validação.
        required_environment: Entrada ``required_environment``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
    """

    restore_request: RestoreRequest
    environment: Mapping[str, str]
    required_environment: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(self.restore_request, RestoreRequest):
            raise TypeError("restore_request must be a RestoreRequest")
        values = dict(self.environment)
        if any(
            not isinstance(key, str) or not isinstance(value, str) for key, value in values.items()
        ):
            raise TypeError("environment must map strings to strings")
        if any(not isinstance(name, str) or not name for name in self.required_environment):
            raise ValueError("required_environment must contain non-empty names")
        if len(set(self.required_environment)) != len(self.required_environment):
            raise ValueError("required_environment must not contain duplicates")
        object.__setattr__(self, "environment", MappingProxyType(values))
        object.__setattr__(self, "required_environment", tuple(self.required_environment))


@dataclass(frozen=True, slots=True)
class ValidationResult:
    """Representa os dados de ``ValidationResult`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        dataset_count: Quantidade inteira não negativa usada na reconciliação.
        dataset_version: Identificador imutável da versão do dataset.
        schema_fingerprint: Entrada ``schema_fingerprint``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        checksum_sha256: Entrada ``checksum_sha256``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
    """

    dataset_count: int
    dataset_version: str
    schema_fingerprint: str
    checksum_sha256: str

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if isinstance(self.dataset_count, bool) or not isinstance(self.dataset_count, int):
            raise TypeError("dataset_count must be an integer")
        if self.dataset_count <= 0:
            raise ValueError("dataset_count must be positive")
        for field in ("dataset_version", "schema_fingerprint", "checksum_sha256"):
            value = getattr(self, field)
            if not isinstance(value, str) or not value:
                raise ValueError(f"{field} must be non-empty text")


@dataclass(frozen=True, slots=True)
class Validate:
    """Representa os dados de ``Validate`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        registry: Entrada ``registry``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        checksum_verifier: Entrada ``checksum_verifier``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
    """

    registry: DatasetRegistry
    checksum_verifier: ChecksumVerifier

    def execute(self, request: ValidateRequest) -> ValidationResult:
        """Executa o caso de uso implementado por ``Validate``.

        Args:
            request: Objeto de entrada já estruturado para o caso de uso.

        Returns:
            Valor ``ValidationResult`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(request, ValidateRequest):
            raise TypeError("request must be a ValidateRequest")
        missing = tuple(
            name for name in request.required_environment if not request.environment.get(name)
        )
        if missing:
            raise ValueError(f"required environment is missing: {', '.join(missing)}")
        snapshot = self.registry.snapshot
        # O sha esperado é a evidência operacional do snapshot desta execução,
        # não um valor do contrato. A guarda que importa continua logo abaixo:
        # o stream restaurado tem de bater com esse sha.
        expected = request.restore_request.expected_sha256
        verified = self.checksum_verifier(request.restore_request)
        if not isinstance(verified, RestoreResult):
            raise TypeError("checksum_verifier must return RestoreResult")
        if verified.compressed_sha256 != expected:
            raise ValueError("verified snapshot checksum differs from the versioned contract")
        version = dataset_version(
            str(snapshot["sourceSystem"]),
            expected,
            str(snapshot["physicalContractVersion"]),
            str(snapshot["canonicalSchemaVersion"]),
        )
        return ValidationResult(
            len(self.registry.names()),
            version,
            self.registry.schema_fingerprint,
            verified.compressed_sha256,
        )


__all__ = ["ChecksumVerifier", "Validate", "ValidateRequest", "ValidationResult"]
