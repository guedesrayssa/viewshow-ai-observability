"""Reconcilia, no Athena, a quantidade de linhas publicada em cada partição histórica.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable, Mapping
from typing import Protocol

from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from contracts.registry import EXPECTED_ARGUS_V2_DATASETS
from domain.archive import partition_date, require_key_component
from ports import ArchiveReconciliationError, AthenaValidator

_SQL_IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]{0,254}$")
_WORKGROUP = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_OUTPUT_LOCATION = re.compile(r"^s3://[^/]+/.+/$")
_SAFE_ERROR_CODE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
_RUNNING = frozenset({"QUEUED", "RUNNING"})
_TERMINAL_FAILURE = frozenset({"FAILED", "CANCELLED"})


class AthenaClient(Protocol):
    """Define o contrato mínimo de athena cliente usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def start_query_execution(self, **kwargs: object) -> Mapping[str, object]:
        """Executa a etapa interna ``start_query_execution`` e devolve o resultado validado
        indicado pela assinatura.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def get_query_execution(self, **kwargs: object) -> Mapping[str, object]:
        """Obtém consulta execution a partir da fonte configurada.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def get_query_results(self, **kwargs: object) -> Mapping[str, object]:
        """Obtém consulta results a partir da fonte configurada.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...


class AthenaQueryError(RuntimeError):
    """Indica que ``AthenaQueryError`` impediu a operação de continuar com segurança."""


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


def _quoted(identifier: str) -> str:
    """Executa a etapa interna ``quoted`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        identifier: Entrada ``identifier``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if _SQL_IDENTIFIER.fullmatch(identifier) is None:
        raise ValueError("SQL identifier is not allowlisted")
    return f'"{identifier}"'


def _partition_predicate(partition: str) -> str:
    """Executa a etapa interna ``partition_predicate`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        partition: Identificador canônico da partição física ou lógica.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    partition_date(partition)
    temporal = re.fullmatch(r"year=([0-9]{4})/month=([0-9]{2})/day=([0-9]{2})", partition)
    if temporal is not None:
        year, month, day = temporal.groups()
        return f"\"year\" = '{year}' AND \"month\" = '{month}' AND \"day\" = '{day}'"
    snapshot = re.fullmatch(r"snapshot_date=([0-9]{4}-[0-9]{2}-[0-9]{2})", partition)
    if snapshot is not None:
        return f"\"snapshot_date\" = '{snapshot.group(1)}'"
    raise ValueError("Athena partition must use the canonical layout")


def _literal(value: object, field: str) -> str:
    """Executa a etapa interna ``literal`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return "'" + require_key_component(value, field).replace("'", "''") + "'"


def count_query(
    database: str,
    table: str,
    dataset_version: str,
    partition: str,
    aggregate_digest: str,
) -> str:
    """Executa a etapa interna ``count_query`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        database: Entrada ``database``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        table: Nome da tabela previamente autorizado pelo contrato.
        dataset_version: Identificador imutável da versão do dataset.
        partition: Identificador canônico da partição física ou lógica.
        aggregate_digest: Geração canônica registrada no Glue para limitar os objetos lidos.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if table not in EXPECTED_ARGUS_V2_DATASETS:
        raise ValueError("Athena table is not allowlisted")
    if re.fullmatch(r"[0-9a-f]{64}", aggregate_digest) is None:
        raise ValueError("aggregate_digest must be a lowercase SHA-256 digest")
    generation_predicate = f' AND "$path" LIKE \'%/generation={aggregate_digest}/%\''
    return (
        f'SELECT COUNT(*) AS "row_count" FROM {_quoted(database)}.{_quoted(table)} '
        f"WHERE {_quoted('dataset_version')} = {_literal(dataset_version, 'dataset_version')} "
        f"AND {_partition_predicate(partition)}{generation_predicate}"
    )


def legacy_count_query(
    database: str,
    table: str,
    dataset_version: str,
    partition: str,
) -> str:
    """Build the explicitly named metadata-v1 count query without generation semantics."""
    if table not in EXPECTED_ARGUS_V2_DATASETS:
        raise ValueError("Athena table is not allowlisted")
    return (
        f'SELECT COUNT(*) AS "row_count" FROM {_quoted(database)}.{_quoted(table)} '
        f"WHERE {_quoted('dataset_version')} = {_literal(dataset_version, 'dataset_version')} "
        f"AND {_partition_predicate(partition)}"
    )


class AwsAthenaValidator(AthenaValidator):
    """Agrupa o estado e as operações de ``AwsAthenaValidator`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        client: AthenaClient,
        *,
        database: str,
        workgroup: str,
        output_location: str,
        timeout_seconds: float = 120.0,
        poll_interval_seconds: float = 1.0,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            client: Cliente externo que executa a operação de infraestrutura.
            database: Entrada ``database``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            workgroup: Entrada ``workgroup``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            output_location: Entrada ``output_location``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.
            timeout_seconds: Duração ou prazo expresso em segundos.
            poll_interval_seconds: Duração ou prazo expresso em segundos.
            monotonic: Entrada ``monotonic``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            sleep: Entrada ``sleep``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        _quoted(database)
        if not isinstance(workgroup, str) or _WORKGROUP.fullmatch(workgroup) is None:
            raise ValueError("workgroup must be a safe Athena workgroup name")
        if (
            not isinstance(output_location, str)
            or _OUTPUT_LOCATION.fullmatch(output_location) is None
        ):
            raise ValueError("output_location must be an S3 prefix ending in slash")
        for value, name in (
            (timeout_seconds, "timeout_seconds"),
            (poll_interval_seconds, "poll_interval_seconds"),
        ):
            if isinstance(value, bool) or not isinstance(value, int | float):
                raise TypeError(f"{name} must be numeric")
            if value <= 0:
                raise ValueError(f"{name} must be positive")
        self._client = client
        self.database = database
        self.workgroup = workgroup
        self.output_location = output_location
        self.timeout_seconds = float(timeout_seconds)
        self.poll_interval_seconds = float(poll_interval_seconds)
        self._monotonic = monotonic
        self._sleep = sleep

    def validate_partition(
        self,
        table: str,
        dataset_version: str,
        partition: str,
        expected_row_count: int,
        *,
        aggregate_digest: str,
    ) -> int:
        """Valida partição contra as invariantes deste módulo.

        Args:
            table: Nome da tabela previamente autorizado pelo contrato.
            dataset_version: Identificador imutável da versão do dataset.
            partition: Identificador canônico da partição física ou lógica.
            expected_row_count: Valor esperado usado para detectar concorrência ou divergência
            de estado.
            aggregate_digest: Geração canônica registrada no Glue para limitar os objetos lidos.

        Returns:
            Valor ``int`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
            AthenaQueryError: Se a operação não puder preservar as invariantes descritas.
            ArchiveReconciliationError: Se a operação não puder preservar as invariantes
            descritas.
        """
        query = count_query(
            self.database,
            table,
            dataset_version,
            partition,
            aggregate_digest,
        )
        return self._validate_query(query, expected_row_count)

    def validate_legacy_partition(
        self,
        table: str,
        dataset_version: str,
        partition: str,
        expected_row_count: int,
    ) -> int:
        """Validate the explicitly named single-object metadata-v1 partition layout."""
        query = legacy_count_query(self.database, table, dataset_version, partition)
        return self._validate_query(query, expected_row_count)

    def _validate_query(self, query: str, expected_row_count: int) -> int:
        """Execute one already layout-scoped count query and reconcile its result."""
        if isinstance(expected_row_count, bool) or not isinstance(expected_row_count, int):
            raise TypeError("expected_row_count must be an integer")
        if expected_row_count < 0:
            raise ValueError("expected_row_count must be non-negative")
        try:
            response = self._client.start_query_execution(
                QueryString=query,
                QueryExecutionContext={"Database": self.database},
                ResultConfiguration={"OutputLocation": self.output_location},
                WorkGroup=self.workgroup,
            )
        except ClientError as error:
            raise AthenaQueryError(
                f"Athena StartQueryExecution failed ({_error_code(error)})"
            ) from None
        query_id = response.get("QueryExecutionId") if isinstance(response, Mapping) else None
        if not isinstance(query_id, str) or not query_id:
            raise AthenaQueryError("Athena did not return a query execution id")
        self._wait(query_id)
        actual = self._count(query_id)
        if actual != expected_row_count:
            raise ArchiveReconciliationError(
                f"Athena returned {actual} rows; expected {expected_row_count}"
            )
        return actual

    def _wait(self, query_id: str) -> None:
        """Aguarda a entrada respeitando o tempo limite configurado.

        Args:
            query_id: Identificador estável da entidade ou operação correspondente.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            AthenaQueryError: Se a operação não puder preservar as invariantes descritas.
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        deadline = self._monotonic() + self.timeout_seconds
        while True:
            try:
                response = self._client.get_query_execution(QueryExecutionId=query_id)
            except ClientError as error:
                raise AthenaQueryError(
                    f"Athena GetQueryExecution failed ({_error_code(error)})"
                ) from None
            try:
                execution = response["QueryExecution"]
                if (
                    not isinstance(execution, Mapping)
                    or execution.get("QueryExecutionId") != query_id
                ):
                    raise TypeError
                status = execution["Status"]
                if not isinstance(status, Mapping):
                    raise TypeError
                state = status["State"]
                if not isinstance(state, str):
                    raise TypeError
            except (KeyError, TypeError) as error:
                raise AthenaQueryError("Athena query status response is invalid") from error
            if state == "SUCCEEDED":
                return
            if state in _TERMINAL_FAILURE:
                raise AthenaQueryError(f"Athena query ended in {state}")
            if state not in _RUNNING:
                raise AthenaQueryError("Athena query returned an unknown state")
            remaining = deadline - self._monotonic()
            if remaining <= 0:
                raise AthenaQueryError("Athena query timed out")
            self._sleep(min(self.poll_interval_seconds, remaining))

    def _count(self, query_id: str) -> int:
        """Executa a etapa interna ``count`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            query_id: Identificador estável da entidade ou operação correspondente.

        Returns:
            Valor ``int`` produzido pela operação após as validações.

        Raises:
            AthenaQueryError: Se a operação não puder preservar as invariantes descritas.
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        try:
            response = self._client.get_query_results(
                QueryExecutionId=query_id,
                MaxResults=3,
            )
        except ClientError as error:
            raise AthenaQueryError(
                f"Athena GetQueryResults failed ({_error_code(error)})"
            ) from None
        try:
            if not isinstance(response, Mapping) or response.get("NextToken") is not None:
                raise TypeError
            result_set = response["ResultSet"]
            if not isinstance(result_set, Mapping):
                raise TypeError
            metadata = result_set["ResultSetMetadata"]
            rows = result_set["Rows"]
            if not isinstance(metadata, Mapping) or not isinstance(rows, list) or len(rows) != 2:
                raise TypeError
            columns = metadata["ColumnInfo"]
            if (
                not isinstance(columns, list)
                or len(columns) != 1
                or not isinstance(columns[0], Mapping)
                or columns[0].get("Name") != "row_count"
                or columns[0].get("Type") != "bigint"
            ):
                raise TypeError
            header, data = rows
            if not isinstance(header, Mapping) or not isinstance(data, Mapping):
                raise TypeError
            if header.get("Data") != [{"VarCharValue": "row_count"}]:
                raise TypeError
            cells = data["Data"]
            if not isinstance(cells, list) or len(cells) != 1 or not isinstance(cells[0], Mapping):
                raise TypeError
            raw_count = cells[0]["VarCharValue"]
            if not isinstance(raw_count, str) or re.fullmatch(r"0|[1-9][0-9]*", raw_count) is None:
                raise TypeError
            return int(raw_count)
        except (KeyError, TypeError, ValueError) as error:
            raise AthenaQueryError("Athena count result is invalid") from error


__all__ = ["AthenaQueryError", "AwsAthenaValidator", "count_query"]
