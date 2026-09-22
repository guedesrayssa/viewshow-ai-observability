"""Mantém tabelas e partições do Glue coerentes com o esquema público dos arquivos Parquet.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Protocol, cast

from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from adapters.archive.parquet import athena_schema_for_descriptor
from domain.archive import partition_date, require_key_component
from domain.datasets import DatasetDescriptor
from ports import ConditionalWriteError, GlueCatalog

_IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]{0,254}$")
_TABLE_ROOT = re.compile(r"^s3://[^/]+/canonical/schema_version=1\.0/$")
_PARTITION_ROOT = re.compile(
    r"^s3://[^/]+/canonical/schema_version=1\.0/dataset_version=[^/]+/"
    r"dataset=(?P<dataset>[^/]+)/(?P<partition>.+?)/"
    r"generation=(?P<generation>[0-9a-f]{64})/$"
)
_LEGACY_PARTITION_ROOT = re.compile(
    r"^s3://[^/]+/canonical/schema_version=1\.0/dataset_version=[^/]+/"
    r"dataset=(?P<dataset>[^/]+)/(?P<partition>.+)/$"
)
_SAFE_ERROR_CODE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
_INPUT_FORMAT = "org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat"
_OUTPUT_FORMAT = "org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat"
_SERDE = "org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe"


class GlueClient(Protocol):
    """Define o contrato mínimo de glue cliente usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def get_table(self, **kwargs: object) -> Mapping[str, object]:
        """Obtém tabela a partir da fonte configurada.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def create_table(self, **kwargs: object) -> Mapping[str, object]:
        """Cria tabela preservando as invariantes da camada.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def get_partition(self, **kwargs: object) -> Mapping[str, object]:
        """Obtém partição a partir da fonte configurada.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def create_partition(self, **kwargs: object) -> Mapping[str, object]:
        """Cria partição preservando as invariantes da camada.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...


class GlueCatalogError(RuntimeError):
    """Indica que ``GlueCatalogError`` impediu a operação de continuar com segurança."""


class GlueCatalogDrift(ConditionalWriteError):
    """Indica que ``GlueCatalogDrift`` impediu a operação de continuar com segurança."""


def _error_code(error: ClientError) -> str:
    """Obtém o código de erro em formato seguro para exposição.

    Args:
        error: Entrada ``error``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    raw = error.response.get("Error", {}).get("Code")
    return raw if isinstance(raw, str) and _SAFE_ERROR_CODE.fullmatch(raw) else "Unknown"


def _missing(error: ClientError) -> bool:
    """Verifica a condição associada a missing.

    Args:
        error: Entrada ``error``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.
    """
    return _error_code(error) == "EntityNotFoundException"


def _already_exists(error: ClientError) -> bool:
    """Verifica a condição associada a already exists.

    Args:
        error: Entrada ``error``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.
    """
    return _error_code(error) == "AlreadyExistsException"


def _idempotency_key(value: object) -> None:
    """Monta a chave de idempotência a partir de componentes validados.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, str) or not value:
        raise ValueError("idempotency_key must be a non-empty string")


def _table_location(value: object) -> str:
    """Executa a etapa interna ``table_location`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, str) or _TABLE_ROOT.fullmatch(value) is None:
        raise ValueError("Glue table location must be the canonical schema root")
    return value


def _partition_values(
    descriptor: DatasetDescriptor, dataset_version: str, partition: str
) -> list[str]:
    """Executa a etapa interna ``partition_values`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        dataset_version: Identificador imutável da versão do dataset.
        partition: Identificador canônico da partição física ou lógica.

    Returns:
        Valor ``list[str]`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    require_key_component(dataset_version, "dataset_version")
    partition_date(partition)
    strategy = descriptor.archive_partition["strategy"]
    if strategy == "event_time":
        matched = re.fullmatch(r"year=([0-9]{4})/month=([0-9]{2})/day=([0-9]{2})", partition)
        if matched is None:
            raise ValueError("event-time Glue partition has an invalid layout")
        return [dataset_version, *matched.groups()]
    if strategy == "snapshot_date":
        matched = re.fullmatch(r"snapshot_date=([0-9]{4}-[0-9]{2}-[0-9]{2})", partition)
        if matched is None:
            raise ValueError("snapshot Glue partition has an invalid layout")
        return [dataset_version, matched.group(1)]
    raise ValueError("descriptor archive partition strategy is unsupported")


def _partition_keys(descriptor: DatasetDescriptor) -> list[dict[str, str]]:
    """Executa a etapa interna ``partition_keys`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.

    Returns:
        Valor ``list[dict[str, str]]`` produzido pela operação após as validações.
    """
    dataset_version = {"Name": "dataset_version", "Type": "string"}
    if descriptor.archive_partition["strategy"] == "event_time":
        return [
            dataset_version,
            {"Name": "year", "Type": "string"},
            {"Name": "month", "Type": "string"},
            {"Name": "day", "Type": "string"},
        ]
    return [dataset_version, {"Name": "snapshot_date", "Type": "string"}]


def _columns(descriptor: DatasetDescriptor) -> list[dict[str, str]]:
    # Glue/Hive converte nomes de colunas de primeiro nível para minúsculas no CreateTable.
    # Enviar essa representação desde o início mantém exata a comparação imediatamente após a
    # escrita; Parquet/Athena continuam case-insensitive nesses nomes. Campos de structs
    # aninhados pertencem à string do tipo e são preservados deliberadamente.
    """Executa a etapa interna ``columns`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.

    Returns:
        Valor ``list[dict[str, str]]`` produzido pela operação após as validações.

    Raises:
        GlueCatalogError: Se a operação não puder preservar as invariantes descritas.
    """
    schema = athena_schema_for_descriptor(descriptor)
    names = [name.lower() for name in schema]
    if len(names) != len(set(names)):
        raise GlueCatalogError(
            "public Parquet schema has case-insensitive top-level column collisions"
        )
    return [{"Name": name.lower(), "Type": field_type} for name, field_type in schema.items()]


def _storage_descriptor(descriptor: DatasetDescriptor, location: str) -> dict[str, object]:
    """Executa a etapa interna ``storage_descriptor`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        location: Entrada ``location``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.
    """
    return {
        "Columns": _columns(descriptor),
        "Location": location,
        "InputFormat": _INPUT_FORMAT,
        "OutputFormat": _OUTPUT_FORMAT,
        "Compressed": True,
        "NumberOfBuckets": -1,
        "SerdeInfo": {
            "SerializationLibrary": _SERDE,
            "Parameters": {"serialization.format": "1"},
        },
        "StoredAsSubDirectories": False,
    }


def _table_input(descriptor: DatasetDescriptor, location: str) -> dict[str, object]:
    """Executa a etapa interna ``table_input`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        descriptor: Descritor físico e semântico do dataset processado.
        location: Entrada ``location``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.
    """
    return {
        "Name": descriptor.table,
        "Description": f"ARGUS 2.0 canonical archive for {descriptor.table}",
        "TableType": "EXTERNAL_TABLE",
        "Parameters": {"classification": "parquet", "EXTERNAL": "TRUE"},
        "PartitionKeys": _partition_keys(descriptor),
        "StorageDescriptor": _storage_descriptor(descriptor, location),
    }


def _selected_storage(value: object) -> dict[str, object]:
    """Executa a etapa interna ``selected_storage`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``dict[str, object]`` produzido pela operação após as validações.

    Raises:
        GlueCatalogError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(value, Mapping):
        raise GlueCatalogError("Glue storage descriptor is not a mapping")
    required = {
        "Columns",
        "Location",
        "InputFormat",
        "OutputFormat",
        "Compressed",
        "NumberOfBuckets",
        "SerdeInfo",
        "StoredAsSubDirectories",
    }
    try:
        return {name: value[name] for name in required}
    except KeyError as error:
        raise GlueCatalogError("Glue storage descriptor is incomplete") from error


def _table_matches(actual: object, expected: Mapping[str, object]) -> bool:
    """Verifica a condição associada a tabela matches.

    Args:
        actual: Entrada ``actual``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        expected: Entrada ``expected``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.

    Raises:
        GlueCatalogError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(actual, Mapping):
        raise GlueCatalogError("Glue GetTable response has no table mapping")
    for name in ("Name", "Description", "TableType", "Parameters", "PartitionKeys"):
        if actual.get(name) != expected[name]:
            return False
    return _selected_storage(actual.get("StorageDescriptor")) == expected["StorageDescriptor"]


def _partition_matches(actual: object, expected: Mapping[str, object]) -> bool:
    """Verifica a condição associada a partição matches.

    Args:
        actual: Entrada ``actual``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        expected: Entrada ``expected``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.

    Raises:
        GlueCatalogError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(actual, Mapping):
        raise GlueCatalogError("Glue GetPartition response has no partition mapping")
    return (
        actual.get("Values") == expected["Values"]
        and actual.get("Parameters") == expected["Parameters"]
        and _selected_storage(actual.get("StorageDescriptor")) == expected["StorageDescriptor"]
    )


class AwsGlueCatalog(GlueCatalog):
    """Agrupa o estado e as operações de ``AwsGlueCatalog`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(self, client: GlueClient, database: str) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            client: Cliente externo que executa a operação de infraestrutura.
            database: Entrada ``database``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(database, str) or _IDENTIFIER.fullmatch(database) is None:
            raise ValueError("database must be a safe Glue identifier")
        self._client = client
        self.database = database

    def _get_table(self, name: str) -> object | None:
        """Obtém tabela a partir da fonte configurada.

        Args:
            name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Valor ``object | None`` produzido pela operação após as validações.

        Raises:
            GlueCatalogError: Se a operação não puder preservar as invariantes descritas.
        """
        try:
            response = self._client.get_table(DatabaseName=self.database, Name=name)
        except ClientError as error:
            if _missing(error):
                return None
            raise GlueCatalogError(f"Glue GetTable failed ({_error_code(error)})") from None
        if not isinstance(response, Mapping) or "Table" not in response:
            raise GlueCatalogError("Glue GetTable returned an invalid response")
        return response["Table"]

    def ensure_table(
        self, descriptor: DatasetDescriptor, location: str, *, idempotency_key: str
    ) -> None:
        """Garante a existência compatível de tabela sem sobrescrever divergências.

        Args:
            descriptor: Descritor físico e semântico do dataset processado.
            location: Entrada ``location``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            GlueCatalogDrift: Se a operação não puder preservar as invariantes descritas.
            GlueCatalogError: Se a operação não puder preservar as invariantes descritas.
        """
        if not isinstance(descriptor, DatasetDescriptor):
            raise TypeError("descriptor must be a DatasetDescriptor")
        _idempotency_key(idempotency_key)
        expected = _table_input(descriptor, _table_location(location))
        existing = self._get_table(descriptor.table)
        if existing is not None:
            if not _table_matches(existing, expected):
                raise GlueCatalogDrift("existing Glue table differs from the public Parquet schema")
            return
        try:
            self._client.create_table(DatabaseName=self.database, TableInput=expected)
        except ClientError as error:
            if not _already_exists(error):
                raise GlueCatalogError(f"Glue CreateTable failed ({_error_code(error)})") from None
        confirmed = self._get_table(descriptor.table)
        if confirmed is None or not _table_matches(confirmed, expected):
            raise GlueCatalogDrift("created Glue table differs from the public Parquet schema")

    def _partition_location(
        self,
        descriptor: DatasetDescriptor,
        dataset_version: str,
        partition: str,
        location: object,
        aggregate_digest: str,
    ) -> str:
        """Executa a etapa interna ``partition_location`` e devolve o resultado validado
        indicado pela assinatura.

        Args:
            descriptor: Descritor físico e semântico do dataset processado.
            dataset_version: Identificador imutável da versão do dataset.
            partition: Identificador canônico da partição física ou lógica.
            location: Entrada ``location``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            aggregate_digest: Geração canônica que deve aparecer no subprefixo v2.

        Returns:
            Valor ``str`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(location, str):
            raise TypeError("Glue partition location must be a string")
        matched = _PARTITION_ROOT.fullmatch(location)
        if (
            matched is None
            or matched.group("dataset") != descriptor.table
            or matched.group("partition") != partition
            or location.split("dataset_version=", 1)[1].split("/", 1)[0] != dataset_version
        ):
            raise ValueError("Glue partition location must use the exact canonical prefix")
        if matched.group("generation") != aggregate_digest:
            raise ValueError("Glue partition location must use the committed generation")
        require_key_component(
            location.split("dataset_version=", 1)[1].split("/", 1)[0], "dataset_version"
        )
        return location

    def _legacy_partition_location(
        self,
        descriptor: DatasetDescriptor,
        dataset_version: str,
        partition: str,
        location: object,
    ) -> str:
        """Decode and validate the explicitly named metadata-v1 partition location."""
        if not isinstance(location, str):
            raise TypeError("Glue partition location must be a string")
        matched = _LEGACY_PARTITION_ROOT.fullmatch(location)
        if (
            matched is None
            or matched.group("dataset") != descriptor.table
            or matched.group("partition") != partition
            or location.split("dataset_version=", 1)[1].split("/", 1)[0] != dataset_version
        ):
            raise ValueError("Glue partition location must use the exact canonical prefix")
        require_key_component(dataset_version, "dataset_version")
        return location

    def _get_partition(self, table: str, values: list[str]) -> object | None:
        """Obtém partição a partir da fonte configurada.

        Args:
            table: Nome da tabela previamente autorizado pelo contrato.
            values: Coleção de valores consumida pela operação.

        Returns:
            Valor ``object | None`` produzido pela operação após as validações.

        Raises:
            GlueCatalogError: Se a operação não puder preservar as invariantes descritas.
        """
        try:
            response = self._client.get_partition(
                DatabaseName=self.database,
                TableName=table,
                PartitionValues=values,
            )
        except ClientError as error:
            if _missing(error):
                return None
            raise GlueCatalogError(f"Glue GetPartition failed ({_error_code(error)})") from None
        if not isinstance(response, Mapping) or "Partition" not in response:
            raise GlueCatalogError("Glue GetPartition returned an invalid response")
        return response["Partition"]

    def register_partition(
        self,
        descriptor: DatasetDescriptor,
        dataset_version: str,
        partition: str,
        location: str,
        *,
        aggregate_digest: str,
        expected_absent: bool,
        idempotency_key: str,
    ) -> None:
        """Registra partição e confirma que o estado persistido é compatível.

        Args:
            descriptor: Descritor físico e semântico do dataset processado.
            dataset_version: Identificador imutável da versão do dataset.
            partition: Identificador canônico da partição física ou lógica.
            location: Entrada ``location``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            aggregate_digest: Geração canônica que deve aparecer no subprefixo v2.
            expected_absent: Indica se a operação exige que o recurso ainda não exista.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
            GlueCatalogDrift: Se a operação não puder preservar as invariantes descritas.
            GlueCatalogError: Se a operação não puder preservar as invariantes descritas.
        """
        if not isinstance(descriptor, DatasetDescriptor):
            raise TypeError("descriptor must be a DatasetDescriptor")
        canonical_location = self._partition_location(
            descriptor, dataset_version, partition, location, aggregate_digest
        )
        self._register_partition(
            descriptor,
            dataset_version,
            partition,
            canonical_location,
            expected_absent=expected_absent,
            idempotency_key=idempotency_key,
        )

    def register_legacy_partition(
        self,
        descriptor: DatasetDescriptor,
        dataset_version: str,
        partition: str,
        location: str,
        *,
        expected_absent: bool,
        idempotency_key: str,
    ) -> None:
        """Register the explicitly named single-object metadata-v1 partition layout."""
        if not isinstance(descriptor, DatasetDescriptor):
            raise TypeError("descriptor must be a DatasetDescriptor")
        canonical_location = self._legacy_partition_location(
            descriptor, dataset_version, partition, location
        )
        self._register_partition(
            descriptor,
            dataset_version,
            partition,
            canonical_location,
            expected_absent=expected_absent,
            idempotency_key=idempotency_key,
        )

    def _register_partition(
        self,
        descriptor: DatasetDescriptor,
        dataset_version: str,
        partition: str,
        canonical_location: str,
        *,
        expected_absent: bool,
        idempotency_key: str,
    ) -> None:
        """Persist one already layout-validated Glue partition."""
        if not isinstance(descriptor, DatasetDescriptor):
            raise TypeError("descriptor must be a DatasetDescriptor")
        if expected_absent is not True:
            raise ConditionalWriteError("Glue partition creation requires expected_absent=True")
        _idempotency_key(idempotency_key)
        values = _partition_values(descriptor, dataset_version, partition)
        table = self._get_table(descriptor.table)
        if table is None:
            raise ConditionalWriteError("Glue table must exist before registering a partition")
        table_root = canonical_location.split("dataset_version=", 1)[0]
        expected_table = _table_input(descriptor, _table_location(table_root))
        if not _table_matches(table, expected_table):
            raise GlueCatalogDrift("existing Glue table differs from the public Parquet schema")
        table_storage = _selected_storage(
            cast(Mapping[str, object], table).get("StorageDescriptor")
        )
        expected: dict[str, object] = {
            "Values": values,
            "StorageDescriptor": {**table_storage, "Location": canonical_location},
            "Parameters": {"classification": "parquet"},
        }
        existing = self._get_partition(descriptor.table, values)
        if existing is not None:
            if not _partition_matches(existing, expected):
                raise GlueCatalogDrift("existing Glue partition differs from the canonical archive")
            return
        try:
            self._client.create_partition(
                DatabaseName=self.database,
                TableName=descriptor.table,
                PartitionInput=expected,
            )
        except ClientError as error:
            if not _already_exists(error):
                raise GlueCatalogError(
                    f"Glue CreatePartition failed ({_error_code(error)})"
                ) from None
        confirmed = self._get_partition(descriptor.table, values)
        if confirmed is None or not _partition_matches(confirmed, expected):
            raise GlueCatalogDrift("created Glue partition differs from the canonical archive")


__all__ = ["AwsGlueCatalog", "GlueCatalogDrift", "GlueCatalogError"]
