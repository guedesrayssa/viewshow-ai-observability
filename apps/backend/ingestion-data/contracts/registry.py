"""Carrega e valida o registro fechado de datasets e descritores ARGUS 2.0.

Papel no fluxo:
    Este módulo faz parte do contrato executável ARGUS 2.0 e define quais estruturas físicas
    podem entrar no pipeline canônico.

Garantias e limites:
    Mudanças aqui alteram a interpretação dos dados e precisam manter compatibilidade explícita
    com descritores, normalizadores e testes de contrato.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator, Mapping
from pathlib import Path
from types import MappingProxyType
from typing import cast

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError

from domain.datasets import DatasetColumn, DatasetDescriptor
from domain.models import RecordType
from scripts.extract_argus_schema import parse_create_tables

EXPECTED_ARGUS_V2_DATASETS = (
    "signal_bucket",
    "live_active_15min",
    "live_qoe_hourly",
    "player_hourly",
    "device_hourly",
    "geo_hourly",
    "live_error_attr_hourly",
    "error_cat_hourly",
    "incidents",
    "signal_meta",
    "collector_run",
    "apollo_run",
    "ca_run",
    "nr_run",
    "prom_run",
    "rpaas_run",
    "app_error",
    "app_error_model",
    "app_error_version",
    "cdn_vod_shadow",
    "finding_status_log",
    "live_event_sde",
    "live_event",
)

_REGISTRY_FIELDS = {
    "sourceSystem",
    "physicalContractVersion",
    "schemaFingerprint",
    "descriptors",
}
# A FORMA dos dados.
#
# dumpSha256 e compressedBytes SAÍRAM daqui. Eles identificam uma instância de
# dump, mudam em toda extração mesmo com schema idêntico, e cravá-los no
# contrato obrigava um deploy de código por extração — além de impedir ingerir
# qualquer outro dump, inclusive um reduzido para teste. A linhagem não se
# perde: dataset_version deriva do sha REAL do dump e o manifesto registra em
# dumpChecksumSha256 qual dump produziu a versão.
#
_SNAPSHOT_FIELDS = {
    "sourceSystem",
    "physicalContractVersion",
    "canonicalSchemaVersion",
}
_DESCRIPTOR_FIELDS = {
    "table",
    "recordType",
    "columns",
    "naturalKey",
    "cursorKey",
    "timestampField",
    "grainSeconds",
    "retention",
    "coveragePolicy",
    "requiredModes",
    "archivePartition",
    "normalizer",
}
_DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema"
_DESCRIPTOR_SCHEMA_FIELDS = {
    "$schema",
    "$id",
    "title",
    "type",
    "additionalProperties",
    "required",
    "properties",
    "$defs",
}
_APPROVED_ARGUS_V2_SNAPSHOT: Mapping[str, object] = MappingProxyType(
    {
        "sourceSystem": "argus",
        "physicalContractVersion": "2.0",
        "canonicalSchemaVersion": "1.0",
    }
)


class ContractValidationError(ValueError):
    """Indica que ``ContractValidationError`` impediu a operação de continuar com segurança."""


class UnknownDatasetError(KeyError):
    """Indica que ``UnknownDatasetError`` impediu a operação de continuar com segurança."""


def _reject_duplicate_members(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Registra a rejeição de duplicate members com motivo seguro e limitado.

    Args:
        pairs: Entrada ``pairs``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.

    Raises:
        ContractValidationError: Se a operação não puder preservar as invariantes descritas.
    """
    document: dict[str, object] = {}
    for key, value in pairs:
        if key in document:
            raise ContractValidationError(f"duplicate JSON member {key!r}")
        document[key] = value
    return document


def _read_object(path: Path) -> dict[str, object]:
    """Lê objeto sem ampliar o escopo solicitado.

    Args:
        path: Caminho local do artefato lido ou produzido.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.

    Raises:
        ContractValidationError: Se a operação não puder preservar as invariantes descritas.
    """
    try:
        document = json.loads(
            path.read_text(encoding="utf-8"), object_pairs_hook=_reject_duplicate_members
        )
    except (OSError, json.JSONDecodeError) as error:
        raise ContractValidationError(f"cannot read contract artifact {path.name!r}") from error
    if not isinstance(document, dict) or not all(isinstance(key, str) for key in document):
        raise ContractValidationError(f"contract artifact {path.name!r} must be a JSON object")
    return cast(dict[str, object], document)


def _require_fields(document: Mapping[str, object], expected: set[str], artifact: str) -> None:
    """Valida e devolve campos, rejeitando entradas fora do contrato.

    Args:
        document: Entrada ``document``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        expected: Entrada ``expected``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        artifact: Entrada ``artifact``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        ContractValidationError: Se a operação não puder preservar as invariantes descritas.
    """
    actual = set(document)
    if actual != expected:
        missing = sorted(expected - actual)
        unknown = sorted(actual - expected)
        raise ContractValidationError(
            f"{artifact} fields differ from contract; missing={missing}, unknown={unknown}"
        )


def _require_string(value: object, field: str) -> str:
    """Valida e devolve string, rejeitando entradas fora do contrato.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ContractValidationError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(value, str) or not value:
        raise ContractValidationError(f"{field} must be a non-empty string")
    return value


def _require_nullable_string(value: object, field: str) -> str | None:
    """Valida e devolve nullable string, rejeitando entradas fora do contrato.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``str | None`` produzido pela operação após as validações.
    """
    if value is None:
        return None
    return _require_string(value, field)


def _require_positive_int(value: object, field: str, *, nullable: bool = False) -> int | None:
    """Valida e devolve positivo inteiro, rejeitando entradas fora do contrato.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.
        nullable: Entrada ``nullable``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``int | None`` produzido pela operação após as validações.

    Raises:
        ContractValidationError: Se a operação não puder preservar as invariantes descritas.
    """
    if nullable and value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        suffix = " or null" if nullable else ""
        raise ContractValidationError(f"{field} must be a positive integer{suffix}")
    return value


def _require_string_tuple(value: object, field: str) -> tuple[str, ...]:
    """Valida e devolve string tuple, rejeitando entradas fora do contrato.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``tuple[str, ...]`` produzido pela operação após as validações.

    Raises:
        ContractValidationError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(value, list) or not value or not all(isinstance(item, str) for item in value):
        raise ContractValidationError(f"{field} must be a non-empty string array")
    result = cast(tuple[str, ...], tuple(value))
    if len(set(result)) != len(result):
        raise ContractValidationError(f"{field} cannot contain duplicates")
    return result


def _require_object(value: object, field: str) -> dict[str, object]:
    """Valida e devolve objeto, rejeitando entradas fora do contrato.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.

    Raises:
        ContractValidationError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ContractValidationError(f"{field} must be an object")
    return cast(dict[str, object], value)


def _load_descriptor_schema(root: Path) -> Draft202012Validator:
    """Carrega descritor esquema e rejeita conteúdo incompleto ou malformado.

    Args:
        root: Entrada ``root``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``Draft202012Validator`` produzido pela operação após as validações.

    Raises:
        ContractValidationError: Se a operação não puder preservar as invariantes descritas.
    """
    schema = _read_object(root / "descriptor.schema.json")
    if schema.get("$schema") != _DRAFT_2020_12:
        raise ContractValidationError("descriptor schema must declare JSON Schema Draft 2020-12")
    try:
        Draft202012Validator.check_schema(schema)
    except SchemaError as error:
        raise ContractValidationError(f"invalid Draft 2020-12 schema: {error.message}") from error
    _require_fields(schema, _DESCRIPTOR_SCHEMA_FIELDS, "descriptor.schema.json")
    if schema["type"] != "object" or schema["additionalProperties"] is not False:
        raise ContractValidationError("descriptor schema root must be a closed object")
    required = _require_string_tuple(schema["required"], "descriptor schema required")
    if set(required) != _DESCRIPTOR_FIELDS:
        raise ContractValidationError("descriptor schema required fields differ from the contract")
    properties = _require_object(schema["properties"], "descriptor schema properties")
    if set(properties) != _DESCRIPTOR_FIELDS:
        raise ContractValidationError("descriptor schema properties differ from the contract")
    definitions = _require_object(schema["$defs"], "descriptor schema $defs")
    if set(definitions) != {"key"}:
        raise ContractValidationError("descriptor schema definitions differ from the contract")
    return Draft202012Validator(schema)


def _load_snapshot(root: Path) -> Mapping[str, object]:
    """Carrega snapshot e rejeita conteúdo incompleto ou malformado.

    Args:
        root: Entrada ``root``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``Mapping[str, object]`` produzido pela operação após as validações.

    Raises:
        ContractValidationError: Se a operação não puder preservar as invariantes descritas.
    """
    snapshot = _read_object(root / "snapshot.json")
    _require_fields(snapshot, _SNAPSHOT_FIELDS, "snapshot.json")
    if snapshot != _APPROVED_ARGUS_V2_SNAPSHOT:
        raise ContractValidationError(
            "snapshot metadata differs from the approved ARGUS 2.0 source"
        )
    return MappingProxyType(snapshot)


def _load_columns(value: object, artifact: str) -> tuple[DatasetColumn, ...]:
    """Carrega colunas e rejeita conteúdo incompleto ou malformado.

    Args:
        value: Valor não confiável que será validado ou convertido.
        artifact: Entrada ``artifact``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``tuple[DatasetColumn, ...]`` produzido pela operação após as validações.

    Raises:
        ContractValidationError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(value, list) or not value:
        raise ContractValidationError(f"{artifact}.columns must be a non-empty array")
    columns: list[DatasetColumn] = []
    for index, raw_column in enumerate(value):
        if not isinstance(raw_column, dict) or not all(isinstance(key, str) for key in raw_column):
            raise ContractValidationError(f"{artifact}.columns[{index}] must be an object")
        column = cast(dict[str, object], raw_column)
        _require_fields(column, {"name", "sqlType", "nullable"}, f"{artifact}.columns[{index}]")
        nullable = column["nullable"]
        if not isinstance(nullable, bool):
            raise ContractValidationError(f"{artifact}.columns[{index}].nullable must be boolean")
        columns.append(
            DatasetColumn(
                _require_string(column["name"], f"{artifact}.columns[{index}].name"),
                _require_string(column["sqlType"], f"{artifact}.columns[{index}].sqlType"),
                nullable,
            )
        )
    return tuple(columns)


def _load_retention(value: object, artifact: str) -> Mapping[str, int | None]:
    """Carrega retenção e rejeita conteúdo incompleto ou malformado.

    Args:
        value: Valor não confiável que será validado ou convertido.
        artifact: Entrada ``artifact``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``Mapping[str, int | None]`` produzido pela operação após as validações.

    Raises:
        ContractValidationError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ContractValidationError(f"{artifact}.retention must be an object")
    retention = cast(dict[str, object], value)
    _require_fields(retention, {"sourceDays", "hotDays", "canonicalMonths"}, "retention")
    return {
        "sourceDays": _require_positive_int(
            retention["sourceDays"], "retention.sourceDays", nullable=True
        ),
        "hotDays": _require_positive_int(retention["hotDays"], "retention.hotDays"),
        "canonicalMonths": _require_positive_int(
            retention["canonicalMonths"], "retention.canonicalMonths"
        ),
    }


def _load_archive_partition(value: object, artifact: str) -> Mapping[str, str | None]:
    """Carrega arquivo histórico partição e rejeita conteúdo incompleto ou malformado.

    Args:
        value: Valor não confiável que será validado ou convertido.
        artifact: Entrada ``artifact``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``Mapping[str, str | None]`` produzido pela operação após as validações.

    Raises:
        ContractValidationError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ContractValidationError(f"{artifact}.archivePartition must be an object")
    partition = cast(dict[str, object], value)
    _require_fields(partition, {"strategy", "field"}, "archivePartition")
    strategy = _require_string(partition["strategy"], "archivePartition.strategy")
    field = _require_nullable_string(partition["field"], "archivePartition.field")
    if strategy not in {"event_time", "snapshot_date"}:
        raise ContractValidationError("archivePartition.strategy is unsupported")
    if (strategy == "event_time") != (field is not None):
        raise ContractValidationError(
            "event_time partitions require a field; snapshot_date does not"
        )
    return {"strategy": strategy, "field": field}


def _load_descriptor(path: Path, validator: Draft202012Validator) -> DatasetDescriptor:
    """Carrega descritor e rejeita conteúdo incompleto ou malformado.

    Args:
        path: Caminho local do artefato lido ou produzido.
        validator: Entrada ``validator``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``DatasetDescriptor`` produzido pela operação após as validações.

    Raises:
        ContractValidationError: Se a operação não puder preservar as invariantes descritas.
    """
    artifact = path.name
    document = _read_object(path)
    try:
        validator.validate(document)
    except ValidationError as error:
        raise ContractValidationError(
            f"descriptor JSON Schema violation in {artifact}: {error.message}"
        ) from error
    _require_fields(document, _DESCRIPTOR_FIELDS, artifact)
    try:
        record_type = RecordType(_require_string(document["recordType"], "recordType"))
    except ValueError as error:
        raise ContractValidationError(f"{artifact}.recordType is unsupported") from error
    timestamp_field = _require_nullable_string(document["timestampField"], "timestampField")
    grain_seconds = _require_positive_int(document["grainSeconds"], "grainSeconds", nullable=True)
    try:
        return DatasetDescriptor(
            table=_require_string(document["table"], "table"),
            record_type=record_type,
            columns=_load_columns(document["columns"], artifact),
            natural_key=_require_string_tuple(document["naturalKey"], "naturalKey"),
            cursor_key=_require_string_tuple(document["cursorKey"], "cursorKey"),
            timestamp_field=timestamp_field,
            grain_seconds=grain_seconds,
            retention=_load_retention(document["retention"], artifact),
            coverage_policy=_require_string(document["coveragePolicy"], "coveragePolicy"),
            required_modes=_require_string_tuple(document["requiredModes"], "requiredModes"),
            archive_partition=_load_archive_partition(document["archivePartition"], artifact),
            normalizer=_require_string(document["normalizer"], "normalizer"),
        )
    except (TypeError, ValueError) as error:
        raise ContractValidationError(f"invalid descriptor {artifact!r}: {error}") from error


class DatasetRegistry:
    """Agrupa o estado e as operações de ``DatasetRegistry`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        descriptors: tuple[DatasetDescriptor, ...],
        schema_fingerprint: str,
        snapshot: Mapping[str, object],
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            descriptors: Entrada ``descriptors``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            schema_fingerprint: Entrada ``schema_fingerprint``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.
            snapshot: Entrada ``snapshot``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._descriptors = descriptors
        self._by_name = MappingProxyType(
            {descriptor.table: descriptor for descriptor in descriptors}
        )
        self.schema_fingerprint = schema_fingerprint
        self.snapshot = snapshot

    @classmethod
    def load_argus_v2(cls, contract_root: Path | None = None) -> DatasetRegistry:
        """Carrega argus v2 e rejeita conteúdo incompleto ou malformado.

        Args:
            contract_root: Entrada ``contract_root``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.

        Returns:
            Valor ``DatasetRegistry`` produzido pela operação após as validações.

        Raises:
            ContractValidationError: Se a operação não puder preservar as invariantes descritas.
        """
        root = contract_root or Path(__file__).resolve().parent / "argus" / "v2"
        registry = _read_object(root / "registry.json")
        _require_fields(registry, _REGISTRY_FIELDS, "registry.json")
        if registry["sourceSystem"] != "argus" or registry["physicalContractVersion"] != "2.0":
            raise ContractValidationError("registry identity must be ARGUS physical contract 2.0")
        names = _require_string_tuple(registry["descriptors"], "registry.descriptors")
        if names != EXPECTED_ARGUS_V2_DATASETS:
            raise ContractValidationError("registry descriptors differ from the approved allowlist")

        schema_path = root / "db_schema.sql"
        try:
            schema_bytes = schema_path.read_bytes()
        except OSError as error:
            raise ContractValidationError(
                "cannot read contract artifact 'db_schema.sql'"
            ) from error
        fingerprint = "sha256:" + hashlib.sha256(schema_bytes).hexdigest()
        if registry["schemaFingerprint"] != fingerprint:
            raise ContractValidationError("db_schema.sql fingerprint differs from registry.json")
        physical_schema = parse_create_tables(schema_bytes.decode("utf-8"))
        if set(physical_schema) != set(EXPECTED_ARGUS_V2_DATASETS):
            raise ContractValidationError("reduced schema differs from the approved allowlist")

        descriptor_root = root / "descriptors"
        actual_files = {path.stem for path in descriptor_root.glob("*.json")}
        if actual_files != set(EXPECTED_ARGUS_V2_DATASETS):
            raise ContractValidationError("descriptor files differ from the approved allowlist")
        descriptor_schema = _load_descriptor_schema(root)
        descriptors = tuple(
            _load_descriptor(descriptor_root / f"{name}.json", descriptor_schema) for name in names
        )
        for descriptor in descriptors:
            table = physical_schema[descriptor.table]
            descriptor_columns = tuple(column.as_contract() for column in descriptor.columns)
            schema_columns = tuple(column.as_contract() for column in table.columns)
            if descriptor_columns != schema_columns:
                raise ContractValidationError(
                    f"descriptor {descriptor.table!r} columns differ from db_schema.sql"
                )
            if descriptor.natural_key != table.primary_key:
                raise ContractValidationError(
                    f"descriptor {descriptor.table!r} natural key differs from db_schema.sql"
                )
        return cls(descriptors, fingerprint, _load_snapshot(root))

    def __iter__(self) -> Iterator[DatasetDescriptor]:
        """Percorre os itens produzidos por esta instância.

        Returns:
            Valor ``Iterator[DatasetDescriptor]`` produzido pela operação após as validações.
        """
        return iter(self._descriptors)

    def __contains__(self, name: object) -> bool:
        """Verifica a condição associada a contains.

        Args:
            name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Valor ``bool`` produzido pela operação após as validações.
        """
        return name in self._by_name

    def names(self) -> tuple[str, ...]:
        """Executa a etapa interna ``names`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``tuple[str, ...]`` produzido pela operação após as validações.
        """
        return tuple(self._by_name)

    def require(self, name: str) -> DatasetDescriptor:
        """Valida e devolve a entrada, rejeitando entradas fora do contrato.

        Args:
            name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Valor ``DatasetDescriptor`` produzido pela operação após as validações.

        Raises:
            UnknownDatasetError: Se a operação não puder preservar as invariantes descritas.
        """
        try:
            return self._by_name[name]
        except KeyError as error:
            raise UnknownDatasetError(f"dataset {name!r} is not allowlisted") from error


__all__ = [
    "ContractValidationError",
    "DatasetRegistry",
    "EXPECTED_ARGUS_V2_DATASETS",
    "UnknownDatasetError",
]
