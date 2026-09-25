"""Valida evidências e inicia uma task ECS de backfill sem expor segredos.

Papel no fluxo:
    Este arquivo é uma ferramenta operacional executada fora do worker principal e valida todas
    as entradas antes de produzir efeitos externos.

Garantias e limites:
    A saída contém somente evidências não sensíveis que podem ser preservadas para auditoria ou
    consumidas pela etapa operacional seguinte.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import sys
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Protocol, cast

from domain.snapshot_provenance import parse_snapshot_extracted_on

SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")
LAUNCH_ATTEMPT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
DEPLOYMENT_NAMESPACE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
TASK_ARN = re.compile(
    r"^arn:[^:]+:ecs:(?P<region>[a-z0-9-]+):(?P<account>[0-9]{12}):task-definition/"
    r"(?P<family>[a-z0-9-]+):(?P<revision>[1-9][0-9]*)$"
)
CLUSTER_ARN = re.compile(
    r"^arn:[^:]+:ecs:(?P<region>[a-z0-9-]+):(?P<account>[0-9]{12}):cluster/"
    r"(?P<name>[A-Za-z0-9_-]+)$"
)
SECRET_ARN = re.compile(
    r"^arn:[^:]+:secretsmanager:(?P<region>[a-z0-9-]+):(?P<account>[0-9]{12}):secret:.+$"
)
SCHEDULE_ARN = re.compile(
    r"^arn:[^:]+:scheduler:(?P<region>[a-z0-9-]+):(?P<account>[0-9]{12}):schedule/"
    r"(?P<group>[A-Za-z0-9_-]+)/(?P<name>[A-Za-z0-9_-]+)$"
)
LAUNCH_LEASE_DURATION_SECONDS = 600
LAUNCH_LEASE_ACQUIRE_TIMEOUT_SECONDS = 30.0
LAUNCH_LEASE_POLL_INTERVAL_SECONDS = 0.25
# Desistimos 30 segundos antes da expiração local para falhar de modo fechado diante de um
# desvio limitado entre relógios.
LAUNCH_LEASE_CLOCK_SKEW_MARGIN_SECONDS = 30
LAUNCH_LEASE_HEARTBEAT_INTERVAL_SECONDS = 30.0
TASK_READY_TIMEOUT_SECONDS = 240.0
TASK_READY_POLL_INTERVAL_SECONDS = 2.0
TASK_STOP_TIMEOUT_SECONDS = 60.0
ESSENTIAL_BACKFILL_CONTAINERS = frozenset({"ingestion"})
REQUIRED_RUNNING_BACKFILL_CONTAINERS = frozenset({"ingestion", "mysql-snapshot"})


class OperationalError(RuntimeError):
    """Indica que ``OperationalError`` impediu a operação de continuar com segurança."""


class StsClient(Protocol):
    """Define o contrato mínimo de sts cliente usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def get_caller_identity(self) -> Mapping[str, object]:
        """Obtém caller identidade a partir da fonte configurada.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...


class SecretsClient(Protocol):
    """Define o contrato mínimo de secrets cliente usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def describe_secret(self, **kwargs: object) -> Mapping[str, object]:
        """Obtém a descrição de secret e valida a resposta externa.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def put_secret_value(self, **kwargs: object) -> Mapping[str, object]:
        """Produz o valor de put secret usado pela etapa seguinte.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...


class EcsClient(Protocol):
    """Define o contrato mínimo de ecs cliente usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def describe_clusters(self, **kwargs: object) -> Mapping[str, object]:
        """Obtém a descrição de clusters e valida a resposta externa.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def describe_task_definition(self, **kwargs: object) -> Mapping[str, object]:
        """Obtém a descrição de task definition e valida a resposta externa.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def run_task(self, **kwargs: object) -> Mapping[str, object]:
        """Executa a etapa interna ``run_task`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def describe_tasks(self, **kwargs: object) -> Mapping[str, object]:
        """Obtém a descrição de tasks e valida a resposta externa.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def stop_task(self, **kwargs: object) -> Mapping[str, object]:
        """Executa a etapa interna ``stop_task`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...


class DynamoClient(Protocol):
    """Define o contrato mínimo de dynamo cliente usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def put_item(self, **kwargs: object) -> Mapping[str, object]:
        """Monta o item de put no formato esperado pela camada de destino.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def update_item(self, **kwargs: object) -> Mapping[str, object]:
        """Atualiza item usando o estado esperado para controlar concorrência.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def delete_item(self, **kwargs: object) -> Mapping[str, object]:
        """Remove item somente após validar sua identidade.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...


class SchedulerClient(Protocol):
    """Define o contrato mínimo de scheduler cliente usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def get_schedule(self, **kwargs: object) -> Mapping[str, object]:
        """Obtém schedule a partir da fonte configurada.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...


@dataclass(frozen=True, slots=True)
class RunTaskClients:
    """Representa os dados de ``RunTaskClients`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        sts: Entrada ``sts``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        secrets: Entrada ``secrets``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        ecs: Entrada ``ecs``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        scheduler: Entrada ``scheduler``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        dynamodb: Entrada ``dynamodb``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
    """

    sts: StsClient
    secrets: SecretsClient
    ecs: EcsClient
    scheduler: SchedulerClient
    dynamodb: DynamoClient


@dataclass(frozen=True, slots=True)
class SnapshotEvidence:
    """Representa os dados de ``SnapshotEvidence`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        bucket: Nome do bucket S3 autorizado para a operação.
        key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        version_id: Identificador estável da entidade ou operação correspondente.
        sha256: Entrada ``sha256``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        size: Entrada ``size``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        snapshot_extracted_on: Entrada ``snapshot_extracted_on``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
    """

    bucket: str
    key: str
    version_id: str
    sha256: str
    size: int
    snapshot_extracted_on: date

    @classmethod
    def from_mapping(cls, source: Mapping[str, object]) -> SnapshotEvidence:
        """Cria a instância a partir de mapeamento previamente validado.

        Args:
            source: Identificador da fonte de dados processada.

        Returns:
            Valor ``SnapshotEvidence`` produzido pela operação após as validações.

        Raises:
            OperationalError: Se a operação não puder preservar as invariantes descritas.
        """
        try:
            snapshot_extracted_on = parse_snapshot_extracted_on(source.get("snapshotExtractedOn"))
        except ValueError as error:
            raise OperationalError(str(error)) from error
        return cls(
            bucket=_required_string(source, "bucket"),
            key=_required_string(source, "key"),
            version_id=_required_string(source, "versionId", alternate="version_id"),
            sha256=_required_string(source, "sha256"),
            size=_required_positive_int(source, "size"),
            snapshot_extracted_on=snapshot_extracted_on,
        )

    def validate(self, expected_bucket: str) -> None:
        """Valida a configuração e as invariantes mantidas pela instância.

        Args:
            expected_bucket: Valor esperado usado para detectar concorrência ou divergência de
            estado.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            OperationalError: Se a operação não puder preservar as invariantes descritas.
        """
        if self.bucket != expected_bucket:
            raise OperationalError("snapshot bucket differs from Terraform output")
        if not SHA256_HEX.fullmatch(self.sha256):
            raise OperationalError("snapshot SHA-256 must be 64 lowercase hexadecimal characters")
        if self.key != f"dumps/{self.sha256}/argus_dump.sql.gz":
            raise OperationalError("snapshot key does not match its immutable SHA-256 identity")
        if not self.version_id or self.version_id == "null":
            raise OperationalError("snapshot version ID must be concrete")
        if type(self.snapshot_extracted_on) is not date:
            raise OperationalError("snapshotExtractedOn must be a canonical ISO date")


@dataclass(frozen=True, slots=True)
class RunTaskConfig:
    """Representa os dados de ``RunTaskConfig`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        environment: Mapeamento de variáveis de ambiente disponível para validação.
        deployment_namespace: Entrada ``deployment_namespace``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        account_id: Identificador estável da entidade ou operação correspondente.
        region: Entrada ``region``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        bucket: Nome do bucket S3 autorizado para a operação.
        operational_table: Nome de tabela previamente autorizado pelo contrato.
        snapshot_secret_arn: Entrada ``snapshot_secret_arn``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        cluster_arn: Entrada ``cluster_arn``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        task_definition_arn: Entrada ``task_definition_arn``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        task_family: Entrada ``task_family``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        security_group_id: Identificador estável da entidade ou operação correspondente.
        subnet_ids: Entrada ``subnet_ids``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        assign_public_ip: Entrada ``assign_public_ip``; a forma aceita é definida pela anotação
        de tipo e validada antes do uso.
        platform_version: Versão imutável usada para identidade e compatibilidade.
        scheduler_group_name: Nome validado do recurso, campo ou operação correspondente.
        scheduler_name: Nome validado do recurso, campo ou operação correspondente.
        schedule_arn: Entrada ``schedule_arn``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.
    """

    environment: str
    deployment_namespace: str
    account_id: str
    region: str
    bucket: str
    operational_table: str
    snapshot_secret_arn: str
    cluster_arn: str
    task_definition_arn: str
    task_family: str
    security_group_id: str
    subnet_ids: tuple[str, ...]
    assign_public_ip: bool
    platform_version: str
    scheduler_group_name: str
    scheduler_name: str
    schedule_arn: str

    @classmethod
    def from_terraform_output(cls, source: Mapping[str, object]) -> RunTaskConfig:
        """Cria a instância a partir de terraform saída previamente validado.

        Args:
            source: Identificador da fonte de dados processada.

        Returns:
            Valor ``RunTaskConfig`` produzido pela operação após as validações.

        Raises:
            OperationalError: Se a operação não puder preservar as invariantes descritas.
        """
        candidate = source.get("ingestion_runbook", source)
        if not isinstance(candidate, Mapping):
            raise OperationalError("Terraform output must contain an ingestion_runbook object")
        value = candidate.get("value", candidate)
        if not isinstance(value, Mapping):
            raise OperationalError("Terraform ingestion_runbook value must be an object")
        return cls.from_mapping(value)

    @classmethod
    def from_mapping(cls, source: Mapping[str, object]) -> RunTaskConfig:
        """Cria a instância a partir de mapeamento previamente validado.

        Args:
            source: Identificador da fonte de dados processada.

        Returns:
            Valor ``RunTaskConfig`` produzido pela operação após as validações.

        Raises:
            OperationalError: Se a operação não puder preservar as invariantes descritas.
        """
        environment = _required_string(source, "ambiente", alternate="environment")
        deployment_namespace = _required_string(source, "deployment_namespace")
        storage = _required_mapping(source, "storage")
        data = _required_mapping(source, "data")
        runtime = _required_mapping(source, "runtime")
        scheduler = _required_mapping(source, "scheduler")
        cluster_arn = _required_string(runtime, "cluster_arn")
        task_arn = _required_string(runtime, "backfill_task_arn", alternate="task_definition_arn")
        cluster_match = CLUSTER_ARN.fullmatch(cluster_arn)
        task_match = TASK_ARN.fullmatch(task_arn)
        if cluster_match is None or task_match is None:
            raise OperationalError(
                "Terraform ECS ARNs must identify a cluster and explicit task revision"
            )
        if cluster_match.group("account") != task_match.group("account") or cluster_match.group(
            "region"
        ) != task_match.group("region"):
            raise OperationalError("Terraform ECS ARNs must belong to one account and region")
        subnets = _required_string_sequence(runtime, "subnet_ids")
        if len(set(subnets)) != len(subnets) or not all(
            value.startswith("subnet-") for value in subnets
        ):
            raise OperationalError("Terraform subnet IDs must be unique subnet identifiers")
        group_name = _required_string(scheduler, "group_name")
        schedule_name = _required_string(scheduler, "name")
        schedule_arn = _required_string(scheduler, "schedule_arn")
        schedule_match = SCHEDULE_ARN.fullmatch(schedule_arn)
        if schedule_match is None:
            raise OperationalError("Terraform scheduler ARN is invalid")
        if (
            schedule_match.group("account") != cluster_match.group("account")
            or schedule_match.group("region") != cluster_match.group("region")
            or schedule_match.group("group") != group_name
            or schedule_match.group("name") != schedule_name
        ):
            raise OperationalError(
                "Terraform scheduler ARN must match its account, group, and name"
            )
        config = cls(
            environment=environment,
            deployment_namespace=deployment_namespace,
            account_id=cluster_match.group("account"),
            region=cluster_match.group("region"),
            bucket=_required_string(storage, "bucket"),
            operational_table=_required_string(data, "operational_table"),
            snapshot_secret_arn=_required_string(data, "snapshot_secret_arn"),
            cluster_arn=cluster_arn,
            task_definition_arn=task_arn,
            task_family=_required_string(runtime, "backfill_task_family", alternate="task_family"),
            security_group_id=_required_string(runtime, "security_group_id"),
            subnet_ids=tuple(subnets),
            assign_public_ip=_required_bool(runtime, "assign_public_ip"),
            platform_version=_required_string(runtime, "platform_version"),
            scheduler_group_name=group_name,
            scheduler_name=schedule_name,
            schedule_arn=schedule_arn,
        )
        config.validate()
        return config

    def validate(self) -> None:
        """Valida a configuração e as invariantes mantidas pela instância.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            OperationalError: Se a operação não puder preservar as invariantes descritas.
        """
        task = TASK_ARN.fullmatch(self.task_definition_arn)
        cluster = CLUSTER_ARN.fullmatch(self.cluster_arn)
        if self.environment not in {"learner-lab", "production"}:
            raise OperationalError("Terraform environment must be learner-lab or production")
        if DEPLOYMENT_NAMESPACE.fullmatch(self.deployment_namespace) is None:
            raise OperationalError("Terraform deployment namespace is invalid")
        expected_task_family = f"{self.deployment_namespace}-ingestion-backfill"
        if task is None or task.group("family") != expected_task_family:
            raise OperationalError("only the namespaced ingestion backfill task may be run")
        if self.task_family != expected_task_family:
            raise OperationalError("Terraform task family must match the deployment namespace")
        # Espelha apps/fullstack/names.tf: cluster e tabela operacional usam o sufixo -iac.
        runtime_namespace = f"{self.deployment_namespace}-iac"
        if cluster is None or cluster.group("name") != f"{runtime_namespace}-cluster":
            raise OperationalError("Terraform cluster must match the deployment namespace")
        if self.operational_table != f"{runtime_namespace}-operacional":
            raise OperationalError(
                "Terraform operational table must match the deployment namespace"
            )
        if self.scheduler_group_name != f"{self.deployment_namespace}-ingestion":
            raise OperationalError("Terraform scheduler group must match the deployment namespace")
        if self.scheduler_name != f"{self.deployment_namespace}-ingestion-sync":
            raise OperationalError("Terraform scheduler name must match the deployment namespace")
        if not self.security_group_id.startswith("sg-"):
            raise OperationalError("Terraform security group must be an AWS security group ID")
        if self.platform_version != "1.4.0":
            raise OperationalError("backfill requires ECS Fargate platform version 1.4.0")
        secret = SECRET_ARN.fullmatch(self.snapshot_secret_arn)
        if secret is None:
            raise OperationalError("Terraform snapshot secret ARN is invalid")
        if secret.group("account") != self.account_id or secret.group("region") != self.region:
            raise OperationalError(
                "Terraform snapshot secret must belong to the ECS account and region"
            )
        if self.assign_public_ip:
            raise OperationalError("backfill in private subnets may not assign a public IP")

    def to_mapping(self) -> dict[str, object]:
        """Converte a instância para mapeamento.

        Returns:
            Valor ``dict[str, object]`` produzido pela operação após as validações.
        """
        return {
            "environment": self.environment,
            "deployment_namespace": self.deployment_namespace,
            "storage": {"bucket": self.bucket},
            "data": {
                "operational_table": self.operational_table,
                "snapshot_secret_arn": self.snapshot_secret_arn,
            },
            "runtime": {
                "cluster_arn": self.cluster_arn,
                "task_definition_arn": self.task_definition_arn,
                "task_family": self.task_family,
                "security_group_id": self.security_group_id,
                "subnet_ids": list(self.subnet_ids),
                "assign_public_ip": self.assign_public_ip,
                "platform_version": self.platform_version,
            },
            "scheduler": {
                "group_name": self.scheduler_group_name,
                "name": self.scheduler_name,
                "schedule_arn": self.schedule_arn,
            },
        }


@dataclass(frozen=True, slots=True)
class RunTaskResult:
    """Representa os dados de ``RunTaskResult`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        task_arn: Entrada ``task_arn``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        client_token: Entrada ``client_token``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.
        launch_attempt: Entrada ``launch_attempt``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        run_id: Identificador não secreto e estável da execução.
        snapshot: Entrada ``snapshot``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        activated: Entrada ``activated``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
    """

    task_arn: str
    client_token: str
    launch_attempt: str
    run_id: str
    snapshot: SnapshotEvidence
    activated: bool

    def to_public_dict(self) -> dict[str, object]:
        """Converte a instância para public dict.

        Returns:
            Valor ``dict[str, object]`` produzido pela operação após as validações.
        """
        return {
            "taskArn": self.task_arn,
            "clientToken": self.client_token,
            "launchAttempt": self.launch_attempt,
            "runId": self.run_id,
            "activated": self.activated,
            "snapshot": {
                "bucket": self.snapshot.bucket,
                "key": self.snapshot.key,
                "versionId": self.snapshot.version_id,
                "sha256": self.snapshot.sha256,
                "size": self.snapshot.size,
                "snapshotExtractedOn": self.snapshot.snapshot_extracted_on.isoformat(),
            },
        }


def _required_mapping(source: Mapping[str, object], name: str) -> Mapping[str, object]:
    """Obtém mapeamento e rejeita a ausência ou um formato inválido.

    Args:
        source: Identificador da fonte de dados processada.
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``Mapping[str, object]`` produzido pela operação após as validações.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """
    value = source.get(name)
    if not isinstance(value, Mapping):
        raise OperationalError(f"Terraform output field {name} must be an object")
    return cast(Mapping[str, object], value)


def _required_string(
    source: Mapping[str, object], name: str, *, alternate: str | None = None
) -> str:
    """Obtém string e rejeita a ausência ou um formato inválido.

    Args:
        source: Identificador da fonte de dados processada.
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        alternate: Entrada ``alternate``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """
    value = source.get(name)
    if value is None and alternate is not None:
        value = source.get(alternate)
    if not isinstance(value, str) or not value.strip():
        raise OperationalError(f"required field {name} must be a non-empty string")
    return value


def _required_positive_int(source: Mapping[str, object], name: str) -> int:
    """Obtém positivo inteiro e rejeita a ausência ou um formato inválido.

    Args:
        source: Identificador da fonte de dados processada.
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``int`` produzido pela operação após as validações.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """
    value = source.get(name)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise OperationalError(f"required field {name} must be a positive integer")
    return value


def _required_bool(source: Mapping[str, object], name: str) -> bool:
    """Obtém bool e rejeita a ausência ou um formato inválido.

    Args:
        source: Identificador da fonte de dados processada.
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """
    value = source.get(name)
    if not isinstance(value, bool):
        raise OperationalError(f"required field {name} must be boolean")
    return value


def _required_string_sequence(source: Mapping[str, object], name: str) -> tuple[str, ...]:
    """Obtém string sequence e rejeita a ausência ou um formato inválido.

    Args:
        source: Identificador da fonte de dados processada.
        name: Entrada ``name``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.

    Returns:
        Valor ``tuple[str, ...]`` produzido pela operação após as validações.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """
    value = source.get(name)
    if not isinstance(value, Sequence) or isinstance(value, str | bytes) or not value:
        raise OperationalError(f"required field {name} must be a non-empty string list")
    result = tuple(value)
    if not all(isinstance(item, str) and item for item in result):
        raise OperationalError(f"required field {name} must be a non-empty string list")
    return cast(tuple[str, ...], result)


def _operation_tokens(
    config: RunTaskConfig,
    snapshot: SnapshotEvidence,
    *,
    activate_candidate: bool,
    launch_attempt: str,
) -> tuple[str, str]:
    """Executa a etapa interna ``operation_tokens`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        config: Configuração validada utilizada pela operação.
        snapshot: Entrada ``snapshot``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        activate_candidate: Entrada ``activate_candidate``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        launch_attempt: Entrada ``launch_attempt``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.

    Returns:
        Valor ``tuple[str, str]`` produzido pela operação após as validações.
    """
    payload = json.dumps(
        {
            "bucket": snapshot.bucket,
            "cluster": config.cluster_arn,
            "network": {
                "assignPublicIp": config.assign_public_ip,
                "securityGroup": config.security_group_id,
                "subnets": list(config.subnet_ids),
            },
            "platformVersion": config.platform_version,
            "snapshot": {
                "key": snapshot.key,
                "sha256": snapshot.sha256,
                "versionId": snapshot.version_id,
                "snapshotExtractedOn": snapshot.snapshot_extracted_on.isoformat(),
            },
            "taskDefinition": config.task_definition_arn,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    secret_token = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    ecs_payload = json.dumps(
        {
            "activation": activate_candidate,
            "launchAttempt": launch_attempt,
            "operation": payload,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    ecs_token = hashlib.sha256(ecs_payload.encode("utf-8")).hexdigest()
    return secret_token, f"ingestion-{ecs_token[:54]}"


def _validate_launch_attempt(value: object) -> str:
    """Valida launch attempt contra as invariantes deste módulo.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(value, str) or LAUNCH_ATTEMPT.fullmatch(value) is None:
        raise OperationalError(
            "launch attempt must contain 1-64 ASCII letters, digits, dots, underscores or hyphens"
        )
    return value


def _error_code(error: BaseException) -> str | None:
    """Obtém o código de erro em formato seguro para exposição.

    Args:
        error: Entrada ``error``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``str | None`` produzido pela operação após as validações.
    """
    response = getattr(error, "response", None)
    if not isinstance(response, Mapping):
        return None
    error_value = response.get("Error")
    if not isinstance(error_value, Mapping):
        return None
    code = error_value.get("Code")
    return code if isinstance(code, str) else None


def _is_conditional_check_failure(error: BaseException) -> bool:
    """Informa se conditional check failure satisfaz a condição esperada.

    Args:
        error: Entrada ``error``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.
    """
    return _error_code(error) in {"ConditionalCheckFailed", "ConditionalCheckFailedException"}


@dataclass(slots=True)
class LaunchLease:
    """Representa os dados de ``LaunchLease`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        pk: Entrada ``pk``; a forma aceita é definida pela anotação de tipo e validada antes do
        uso.
        sk: Entrada ``sk``; a forma aceita é definida pela anotação de tipo e validada antes do
        uso.
        owner: Identidade do worker que possui ou solicita o lease.
        token: Entrada ``token``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        expires_at: Instante UTC com fuso horário usado pela regra temporal.
    """

    pk: str
    sk: str
    owner: str
    token: str
    # Marca d'água máxima local ao processo. Renovações nunca a reduzem se o relógio local
    # retroceder, e o DynamoDB rejeita de forma independente uma expiração menor.
    expires_at: int


def _launch_lease_key(secret_arn: str) -> tuple[str, str]:
    """Monta a chave de launch lease a partir de componentes validados.

    Args:
        secret_arn: Entrada ``secret_arn``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``tuple[str, str]`` produzido pela operação após as validações.
    """
    digest = hashlib.sha256(secret_arn.encode("utf-8")).hexdigest()
    return f"INGESTION#RUN_TASK#{digest}", "LAUNCH_LEASE"


def _acquire_launch_lease(
    client: DynamoClient,
    config: RunTaskConfig,
    *,
    timeout_seconds: float,
    clock: Callable[[], float] = time.time,
) -> LaunchLease:
    """Adquire launch lease para o proprietário solicitado.

    Args:
        client: Cliente externo que executa a operação de infraestrutura.
        config: Configuração validada utilizada pela operação.
        timeout_seconds: Duração ou prazo expresso em segundos.
        clock: Função injetável que fornece o instante atual para validação e testes.

    Returns:
        Valor ``LaunchLease`` produzido pela operação após as validações.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """
    if (
        isinstance(timeout_seconds, bool)
        or not isinstance(timeout_seconds, int | float)
        or timeout_seconds < 0
    ):
        raise OperationalError("launcher lease timeout must be a non-negative number")
    pk, sk = _launch_lease_key(config.snapshot_secret_arn)
    owner = f"run-task-{secrets.token_hex(16)}"
    token = secrets.token_hex(24)
    deadline = time.monotonic() + float(timeout_seconds)
    while True:
        now = int(clock())
        expires_at = now + LAUNCH_LEASE_DURATION_SECONDS
        lease = LaunchLease(
            pk=pk,
            sk=sk,
            owner=owner,
            token=token,
            expires_at=expires_at,
        )
        try:
            client.put_item(
                TableName=config.operational_table,
                Item={
                    "pk": {"S": lease.pk},
                    "sk": {"S": lease.sk},
                    "owner": {"S": lease.owner},
                    "token": {"S": lease.token},
                    "expiresAt": {"N": str(expires_at)},
                    "ttl": {"N": str(expires_at)},
                },
                ConditionExpression="attribute_not_exists(pk) OR #expiresAt < :now",
                ExpressionAttributeNames={"#expiresAt": "expiresAt"},
                ExpressionAttributeValues={":now": {"N": str(now)}},
            )
            return lease
        except Exception as error:
            if not _is_conditional_check_failure(error):
                raise OperationalError("could not acquire the launcher lease") from None
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise OperationalError("launcher lease is held by another operation")
        time.sleep(min(LAUNCH_LEASE_POLL_INTERVAL_SECONDS, remaining))


def _release_launch_lease(client: DynamoClient, config: RunTaskConfig, lease: LaunchLease) -> None:
    """Libera launch lease pertencente ao proprietário informado.

    Args:
        client: Cliente externo que executa a operação de infraestrutura.
        config: Configuração validada utilizada pela operação.
        lease: Entrada ``lease``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """
    try:
        client.delete_item(
            TableName=config.operational_table,
            Key={"pk": {"S": lease.pk}, "sk": {"S": lease.sk}},
            ConditionExpression="#owner = :owner AND #token = :token",
            ExpressionAttributeNames={"#owner": "owner", "#token": "token"},
            ExpressionAttributeValues={
                ":owner": {"S": lease.owner},
                ":token": {"S": lease.token},
            },
        )
    except Exception as error:
        if _is_conditional_check_failure(error):
            return
        raise OperationalError("could not release the launcher lease") from None


def _renew_launch_lease(
    client: DynamoClient,
    config: RunTaskConfig,
    lease: LaunchLease,
    *,
    clock: Callable[[], float] = time.time,
) -> None:
    """Renova launch lease sem permitir redução do prazo já persistido.

    Args:
        client: Cliente externo que executa a operação de infraestrutura.
        config: Configuração validada utilizada pela operação.
        lease: Entrada ``lease``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        clock: Função injetável que fornece o instante atual para validação e testes.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """
    now = int(clock())
    expires_at = max(now + LAUNCH_LEASE_DURATION_SECONDS, lease.expires_at + 1)
    valid_after = str(now + LAUNCH_LEASE_CLOCK_SKEW_MARGIN_SECONDS)
    try:
        client.update_item(
            TableName=config.operational_table,
            Key={"pk": {"S": lease.pk}, "sk": {"S": lease.sk}},
            UpdateExpression="SET #expiresAt = :expiresAt, #ttl = :ttl",
            ConditionExpression=(
                "#owner = :owner AND #token = :token AND #expiresAt > :validAfter "
                "AND #expiresAt < :expiresAt"
            ),
            ExpressionAttributeNames={
                "#owner": "owner",
                "#token": "token",
                "#expiresAt": "expiresAt",
                "#ttl": "ttl",
            },
            ExpressionAttributeValues={
                ":owner": {"S": lease.owner},
                ":token": {"S": lease.token},
                ":validAfter": {"N": valid_after},
                ":expiresAt": {"N": str(expires_at)},
                ":ttl": {"N": str(expires_at)},
            },
        )
    except Exception as error:
        if _is_conditional_check_failure(error):
            raise OperationalError("launcher lease ownership was lost") from None
        raise OperationalError("could not renew the launcher lease") from None
    lease.expires_at = expires_at


def _validate_heartbeat_interval(interval_seconds: float) -> float:
    """Valida heartbeat interval contra as invariantes deste módulo.

    Args:
        interval_seconds: Duração ou prazo expresso em segundos.

    Returns:
        Valor ``float`` produzido pela operação após as validações.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """
    if (
        isinstance(interval_seconds, bool)
        or not isinstance(interval_seconds, int | float)
        or interval_seconds <= 0
        or interval_seconds
        >= LAUNCH_LEASE_DURATION_SECONDS - LAUNCH_LEASE_CLOCK_SKEW_MARGIN_SECONDS
    ):
        raise OperationalError("launcher heartbeat interval must fit inside the lease margin")
    return float(interval_seconds)


class LaunchLeaseHeartbeat:
    """Agrupa o estado e as operações de ``LaunchLeaseHeartbeat`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        client: DynamoClient,
        config: RunTaskConfig,
        lease: LaunchLease,
        *,
        clock: Callable[[], float],
        interval_seconds: float,
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            client: Cliente externo que executa a operação de infraestrutura.
            config: Configuração validada utilizada pela operação.
            lease: Entrada ``lease``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            clock: Função injetável que fornece o instante atual para validação e testes.
            interval_seconds: Duração ou prazo expresso em segundos.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._client = client
        self._config = config
        self._lease = lease
        self._clock = clock
        self._interval_seconds = _validate_heartbeat_interval(interval_seconds)
        self._stop = threading.Event()
        self._lock = threading.Lock()
        # O launcher principal e a thread de heartbeat compartilham este objeto. Um único fluxo
        # de renovação impede que uma requisição atrasada chegue após uma renovação mais recente
        # trazendo uma expiração candidata mais antiga.
        self._renew_lock = threading.Lock()
        self._lost: OperationalError | None = None
        self._thread = threading.Thread(
            target=self._run,
            name="ingestion-launch-lease-heartbeat",
            daemon=True,
        )

    @property
    def owned(self) -> bool:
        """Informa se o lease ainda pertence a esta execução.

        Returns:
            Valor ``bool`` produzido pela operação após as validações.
        """
        with self._lock:
            return self._lost is None

    def start(self) -> None:
        """Inicia o processamento ou recurso gerenciado pela instância.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._thread.start()

    def _remember_loss(self, error: OperationalError) -> None:
        """Executa a etapa interna ``remember_loss`` e valida seus efeitos antes de concluir.

        Args:
            error: Entrada ``error``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        with self._lock:
            if self._lost is None:
                self._lost = error

    def _raise_if_lost(self) -> None:
        """Executa a etapa interna ``raise_if_lost`` e valida seus efeitos antes de concluir.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        with self._lock:
            error = self._lost
        if error is not None:
            raise error

    def ensure_owned(self) -> None:
        """Garante a existência compatível de owned sem sobrescrever divergências.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._raise_if_lost()

    def revalidate(self) -> None:
        """Executa a etapa interna ``revalidate`` e valida seus efeitos antes de concluir.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        with self._renew_lock:
            self._raise_if_lost()
            try:
                _renew_launch_lease(self._client, self._config, self._lease, clock=self._clock)
            except OperationalError as error:
                self._remember_loss(error)
                raise
            self._raise_if_lost()

    def _run(self) -> None:
        """Executa a etapa interna ``run`` e valida seus efeitos antes de concluir.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        while not self._stop.wait(self._interval_seconds):
            try:
                self.revalidate()
            except OperationalError:
                return

    def close(self) -> None:
        """Libera recursos locais ainda mantidos pela instância.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._stop.set()
        self._thread.join(timeout=max(1.0, self._interval_seconds * 2))
        if self._thread.is_alive():
            self._remember_loss(OperationalError("launcher heartbeat did not stop"))


def _existing_current_secret_version(client: SecretsClient, secret_arn: str, token: str) -> bool:
    """Verifica a condição associada a existing current secret versão.

    Args:
        client: Cliente externo que executa a operação de infraestrutura.
        secret_arn: Entrada ``secret_arn``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        token: Entrada ``token``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """
    response = client.describe_secret(SecretId=secret_arn)
    versions = response.get("VersionIdsToStages")
    if versions is None:
        # Segredo recém-provisionado não tem versão nenhuma, e a AWS omite a
        # chave nesse caso. Isso é a primeira execução — justamente a que precisa
        # criar a versão — e não metadado inválido. O Terraform cria o segredo
        # sem versão de propósito, para a senha nunca tocar o state.
        return False
    if not isinstance(versions, Mapping):
        raise OperationalError("Secrets Manager returned invalid version metadata")
    stages = versions.get(token)
    if stages is None:
        return False
    if not isinstance(stages, Sequence) or isinstance(stages, str | bytes):
        raise OperationalError("Secrets Manager returned invalid version stages")
    if "AWSCURRENT" not in stages:
        raise OperationalError("existing deterministic secret version is not AWSCURRENT")
    return True


def _ensure_secret_version(
    client: SecretsClient,
    secret_arn: str,
    token: str,
    *,
    password_factory: Callable[[int], str],
    before_put: Callable[[], None] | None = None,
    after_put: Callable[[], None] | None = None,
) -> None:
    """Garante a existência compatível de secret versão sem sobrescrever divergências.

    Args:
        client: Cliente externo que executa a operação de infraestrutura.
        secret_arn: Entrada ``secret_arn``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        token: Entrada ``token``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        password_factory: Fábrica injetada que cria a dependência somente quando necessária.
        before_put: Entrada ``before_put``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        after_put: Entrada ``after_put``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """
    if _existing_current_secret_version(client, secret_arn, token):
        return
    password = password_factory(48)
    if not isinstance(password, str) or not password:
        raise OperationalError("generated MySQL password is invalid")
    if before_put is not None:
        before_put()
    try:
        response = client.put_secret_value(
            SecretId=secret_arn,
            ClientRequestToken=token,
            SecretString=password,
        )
        if after_put is not None:
            after_put()
        version_id = response.get("VersionId")
        if version_id not in (None, token):
            raise OperationalError("Secrets Manager returned an unexpected secret version")
    except Exception as error:
        if isinstance(error, OperationalError):
            raise
        if _error_code(error) != "ResourceExistsException" or not _existing_current_secret_version(
            client, secret_arn, token
        ):
            raise OperationalError("could not store the deterministic secret version") from None


def _validate_identity(clients: RunTaskClients, config: RunTaskConfig) -> None:
    """Valida identidade contra as invariantes deste módulo.

    Args:
        clients: Entrada ``clients``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        config: Configuração validada utilizada pela operação.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """
    identity = clients.sts.get_caller_identity()
    account = identity.get("Account")
    caller = identity.get("Arn")
    if account != config.account_id or not isinstance(caller, str):
        raise OperationalError("AWS caller does not match Terraform account")
    # A conta vem do stack (derivada dos ARNs do terraform output) e não de um
    # literal: a mesma verificação vale em qualquer conta do Learner Lab, e
    # continua exigindo o papel voclabs.
    if config.environment == "learner-lab" and not re.fullmatch(
        rf"arn:[^:]+:sts::{re.escape(config.account_id)}:assumed-role/voclabs/[^/]+", caller
    ):
        raise OperationalError("learner-lab requires the voclabs assumed role")


def _validate_scheduler(clients: RunTaskClients, config: RunTaskConfig) -> None:
    """Valida scheduler contra as invariantes deste módulo.

    Args:
        clients: Entrada ``clients``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        config: Configuração validada utilizada pela operação.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """
    schedule = clients.scheduler.get_schedule(
        Name=config.scheduler_name,
        GroupName=config.scheduler_group_name,
    )
    if (
        schedule.get("Name") != config.scheduler_name
        or schedule.get("GroupName") != config.scheduler_group_name
        or schedule.get("Arn") != config.schedule_arn
    ):
        raise OperationalError("scheduler identity does not match Terraform output")
    if schedule.get("State") != "DISABLED":
        raise OperationalError("scheduler must remain DISABLED before a manual backfill")


def _validate_ecs_definition(clients: RunTaskClients, config: RunTaskConfig) -> None:
    """Valida ecs definition contra as invariantes deste módulo.

    Args:
        clients: Entrada ``clients``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        config: Configuração validada utilizada pela operação.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """
    clusters = clients.ecs.describe_clusters(clusters=[config.cluster_arn])
    if clusters.get("failures") not in ([], None):
        raise OperationalError("ECS cluster lookup returned failures")
    cluster_items = clusters.get("clusters")
    if not isinstance(cluster_items, Sequence) or len(cluster_items) != 1:
        raise OperationalError("ECS cluster lookup did not return exactly one cluster")
    cluster = cluster_items[0]
    if not isinstance(cluster, Mapping) or cluster.get("status") != "ACTIVE":
        raise OperationalError("ECS cluster is not active")
    response = clients.ecs.describe_task_definition(taskDefinition=config.task_definition_arn)
    definition = response.get("taskDefinition")
    if not isinstance(definition, Mapping):
        raise OperationalError("ECS task definition response is invalid")
    runtime = definition.get("runtimePlatform")
    containers = definition.get("containerDefinitions")
    if (
        definition.get("status") != "ACTIVE"
        or definition.get("family") != config.task_family
        or definition.get("networkMode") != "awsvpc"
        or not isinstance(runtime, Mapping)
        or runtime.get("cpuArchitecture") != "X86_64"
        or runtime.get("operatingSystemFamily") != "LINUX"
        or not isinstance(containers, Sequence)
    ):
        raise OperationalError("ECS task definition does not meet the immutable backfill contract")
    if "FARGATE" not in definition.get("requiresCompatibilities", []):
        raise OperationalError("ECS task definition is not Fargate compatible")
    # A checagem é pelo VALOR, não pela presença da chave: describe_task_definition
    # sempre devolve portMappings, normalizado para lista vazia quando a task
    # definition não declara nenhuma porta. Exigir a ausência da chave tornava o
    # contrato insatisfazível por qualquer task definition real, e recusava
    # justamente a que não expõe porta nenhuma. É a mesma forma já usada na
    # verificação do container de ingestão mais abaixo.
    if any(isinstance(item, Mapping) and item.get("portMappings") for item in containers):
        raise OperationalError("ECS task definition must not expose port mappings")
    ingestion = [
        item for item in containers if isinstance(item, Mapping) and item.get("name") == "ingestion"
    ]
    mysql_snapshot = [
        item
        for item in containers
        if isinstance(item, Mapping) and item.get("name") == "mysql-snapshot"
    ]
    essential_names = {
        item.get("name")
        for item in containers
        if isinstance(item, Mapping) and item.get("essential") is True
    }
    if (
        len(ingestion) != 1
        or len(mysql_snapshot) != 1
        or mysql_snapshot[0].get("essential") is not False
        or essential_names != ESSENTIAL_BACKFILL_CONTAINERS
    ):
        raise OperationalError(
            "ECS task definition must make only ingestion essential and MySQL non-essential"
        )
    container = ingestion[0]
    image = container.get("image")
    dependencies = container.get("dependsOn")
    secret_bindings = container.get("secrets")
    if (
        not isinstance(image, str)
        or not re.search(r"@sha256:[0-9a-f]{64}$", image)
        or container.get("command") != ["backfill"]
        or container.get("portMappings")
        or not isinstance(dependencies, Sequence)
        or not any(
            isinstance(dependency, Mapping)
            and dependency.get("containerName") == "mysql-snapshot"
            and dependency.get("condition") == "HEALTHY"
            for dependency in dependencies
        )
        or not isinstance(secret_bindings, Sequence)
        or not any(
            isinstance(binding, Mapping)
            and binding.get("name") == "MYSQL_PASSWORD"
            and binding.get("valueFrom") == config.snapshot_secret_arn
            for binding in secret_bindings
        )
    ):
        raise OperationalError("ECS backfill container does not meet the immutable contract")
    mysql_container = mysql_snapshot[0]
    mysql_secret_bindings = mysql_container.get("secrets")
    if not isinstance(mysql_secret_bindings, Sequence) or not any(
        isinstance(binding, Mapping)
        and binding.get("name") == "MYSQL_ROOT_PASSWORD"
        and binding.get("valueFrom") == config.snapshot_secret_arn
        for binding in mysql_secret_bindings
    ):
        raise OperationalError("ECS MySQL snapshot container does not meet the immutable contract")


def _describe_task(
    clients: RunTaskClients,
    config: RunTaskConfig,
    task_arn: str,
    *,
    heartbeat: LaunchLeaseHeartbeat | None = None,
) -> Mapping[str, object]:
    """Obtém a descrição de task e valida a resposta externa.

    Args:
        clients: Entrada ``clients``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        config: Configuração validada utilizada pela operação.
        task_arn: Entrada ``task_arn``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        heartbeat: Entrada ``heartbeat``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``Mapping[str, object]`` produzido pela operação após as validações.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """
    if heartbeat is not None:
        heartbeat.revalidate()
    response = clients.ecs.describe_tasks(cluster=config.cluster_arn, tasks=[task_arn])
    if heartbeat is not None:
        heartbeat.revalidate()
    if response.get("failures") not in ([], None):
        raise OperationalError("ECS task lookup returned failures")
    tasks = response.get("tasks")
    if not isinstance(tasks, Sequence) or len(tasks) != 1:
        raise OperationalError("ECS task lookup did not return exactly one task")
    task = tasks[0]
    if not isinstance(task, Mapping) or task.get("taskArn") != task_arn:
        raise OperationalError("ECS task lookup returned an unexpected task")
    return task


def _task_is_ready(
    clients: RunTaskClients,
    config: RunTaskConfig,
    task_arn: str,
    heartbeat: LaunchLeaseHeartbeat,
) -> bool:
    """Verifica a condição associada a task is ready.

    Args:
        clients: Entrada ``clients``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        config: Configuração validada utilizada pela operação.
        task_arn: Entrada ``task_arn``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        heartbeat: Entrada ``heartbeat``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """
    task = _describe_task(clients, config, task_arn, heartbeat=heartbeat)
    if task.get("lastStatus") == "STOPPED":
        raise OperationalError("ECS task stopped before its essential containers were running")
    containers = task.get("containers")
    if not isinstance(containers, Sequence):
        raise OperationalError("ECS task lookup did not include containers")
    statuses: dict[str, object] = {}
    for container in containers:
        if isinstance(container, Mapping) and isinstance(container.get("name"), str):
            statuses[container["name"]] = container.get("lastStatus")
    if not REQUIRED_RUNNING_BACKFILL_CONTAINERS <= statuses.keys():
        raise OperationalError("ECS task lookup omitted a required container")
    return task.get("lastStatus") == "RUNNING" and all(
        statuses[name] == "RUNNING" for name in REQUIRED_RUNNING_BACKFILL_CONTAINERS
    )


def _wait_for_task_ready(
    clients: RunTaskClients,
    config: RunTaskConfig,
    task_arn: str,
    heartbeat: LaunchLeaseHeartbeat,
    *,
    timeout_seconds: float,
) -> None:
    """Aguarda for task ready respeitando o tempo limite configurado.

    Args:
        clients: Entrada ``clients``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        config: Configuração validada utilizada pela operação.
        task_arn: Entrada ``task_arn``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        heartbeat: Entrada ``heartbeat``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        timeout_seconds: Duração ou prazo expresso em segundos.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """
    if (
        isinstance(timeout_seconds, bool)
        or not isinstance(timeout_seconds, int | float)
        or timeout_seconds < 0
    ):
        raise OperationalError("task readiness timeout must be a non-negative number")
    deadline = time.monotonic() + float(timeout_seconds)
    while True:
        if _task_is_ready(clients, config, task_arn, heartbeat):
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise OperationalError("ECS task containers did not reach RUNNING before timeout")
        time.sleep(min(TASK_READY_POLL_INTERVAL_SECONDS, remaining))


def _stop_task_and_confirm(
    clients: RunTaskClients,
    config: RunTaskConfig,
    task_arn: str,
    heartbeat: LaunchLeaseHeartbeat,
) -> None:
    """Executa a etapa interna ``stop_task_and_confirm`` e valida seus efeitos antes de
    concluir.

    Args:
        clients: Entrada ``clients``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        config: Configuração validada utilizada pela operação.
        task_arn: Entrada ``task_arn``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        heartbeat: Entrada ``heartbeat``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """
    try:
        clients.ecs.stop_task(
            cluster=config.cluster_arn,
            task=task_arn,
            reason="run-task readiness failed",
        )
    except Exception:
        raise OperationalError("could not stop the unready ECS task") from None
    try:
        heartbeat.revalidate()
    except OperationalError:
        pass
    deadline = time.monotonic() + TASK_STOP_TIMEOUT_SECONDS
    while True:
        if _describe_task(clients, config, task_arn).get("lastStatus") == "STOPPED":
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise OperationalError("ECS task did not stop after readiness failure")
        time.sleep(min(TASK_READY_POLL_INTERVAL_SECONDS, remaining))


def run_task(
    clients: RunTaskClients,
    config: RunTaskConfig,
    snapshot: SnapshotEvidence,
    *,
    launch_attempt: str,
    production_confirmation: str | None = None,
    activate_candidate: bool = False,
    password_factory: Callable[[int], str] = secrets.token_urlsafe,
    lease_acquire_timeout_seconds: float = LAUNCH_LEASE_ACQUIRE_TIMEOUT_SECONDS,
    task_ready_timeout_seconds: float = TASK_READY_TIMEOUT_SECONDS,
    lease_clock: Callable[[], float] = time.time,
    lease_heartbeat_interval_seconds: float = LAUNCH_LEASE_HEARTBEAT_INTERVAL_SECONDS,
) -> RunTaskResult:
    """Executa a etapa interna ``run_task`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        clients: Entrada ``clients``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        config: Configuração validada utilizada pela operação.
        snapshot: Entrada ``snapshot``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        launch_attempt: Entrada ``launch_attempt``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.
        production_confirmation: Entrada ``production_confirmation``; a forma aceita é definida
        pela anotação de tipo e validada antes do uso.
        activate_candidate: Entrada ``activate_candidate``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        password_factory: Fábrica injetada que cria a dependência somente quando necessária.
        lease_acquire_timeout_seconds: Duração ou prazo expresso em segundos.
        task_ready_timeout_seconds: Duração ou prazo expresso em segundos.
        lease_clock: Entrada ``lease_clock``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        lease_heartbeat_interval_seconds: Duração ou prazo expresso em segundos.

    Returns:
        Valor ``RunTaskResult`` produzido pela operação após as validações.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """

    if any(name.startswith("AWS_ENDPOINT_URL") for name in os.environ):
        raise OperationalError("AWS endpoint overrides are not allowed")
    launch_attempt = _validate_launch_attempt(launch_attempt)
    config.validate()
    snapshot.validate(config.bucket)
    if not isinstance(activate_candidate, bool):
        raise OperationalError("activation mode must be boolean")
    if config.environment == "production":
        if production_confirmation != f"production:{config.account_id}":
            raise OperationalError("production confirmation must repeat environment and account")
    _validate_identity(clients, config)
    _validate_scheduler(clients, config)
    _validate_ecs_definition(clients, config)
    secret_token, ecs_token = _operation_tokens(
        config,
        snapshot,
        activate_candidate=activate_candidate,
        launch_attempt=launch_attempt,
    )
    run_id = f"backfill-{ecs_token.removeprefix('ingestion-')[:40]}"
    heartbeat_interval = _validate_heartbeat_interval(lease_heartbeat_interval_seconds)
    lease = _acquire_launch_lease(
        clients.dynamodb,
        config,
        timeout_seconds=lease_acquire_timeout_seconds,
        clock=lease_clock,
    )
    heartbeat = LaunchLeaseHeartbeat(
        clients.dynamodb,
        config,
        lease,
        clock=lease_clock,
        interval_seconds=heartbeat_interval,
    )
    release_lease = False
    task_arn: str | None = None
    run_task_issued = False
    no_task_created = False
    primary_error: BaseException | None = None
    heartbeat.start()
    try:
        heartbeat.revalidate()
        _ensure_secret_version(
            clients.secrets,
            config.snapshot_secret_arn,
            secret_token,
            password_factory=password_factory,
            before_put=heartbeat.revalidate,
            after_put=heartbeat.revalidate,
        )
        overrides = {
            "containerOverrides": [
                {
                    "name": "ingestion",
                    "command": ["backfill", "--run-id", run_id],
                    "environment": [
                        {"name": "SNAPSHOT_BUCKET", "value": snapshot.bucket},
                        {"name": "SNAPSHOT_OBJECT_KEY", "value": snapshot.key},
                        {"name": "SNAPSHOT_OBJECT_VERSION_ID", "value": snapshot.version_id},
                        {"name": "SNAPSHOT_SHA256", "value": snapshot.sha256},
                        {
                            "name": "SNAPSHOT_EXTRACTED_ON",
                            "value": snapshot.snapshot_extracted_on.isoformat(),
                        },
                        {"name": "ACTIVATE_CANDIDATE", "value": str(activate_candidate).lower()},
                    ],
                }
            ]
        }
        heartbeat.revalidate()
        run_task_issued = True
        response = clients.ecs.run_task(
            cluster=config.cluster_arn,
            taskDefinition=config.task_definition_arn,
            count=1,
            launchType="FARGATE",
            platformVersion="1.4.0",
            enableExecuteCommand=False,
            clientToken=ecs_token,
            networkConfiguration={
                "awsvpcConfiguration": {
                    "subnets": list(config.subnet_ids),
                    "securityGroups": [config.security_group_id],
                    "assignPublicIp": "ENABLED" if config.assign_public_ip else "DISABLED",
                }
            },
            overrides=overrides,
        )
        failures = response.get("failures")
        tasks = response.get("tasks")
        if failures not in ([], None) or not isinstance(tasks, Sequence) or len(tasks) != 1:
            no_task_created = (
                failures not in ([], None) and isinstance(tasks, Sequence) and not tasks
            )
            raise OperationalError("ECS RunTask did not return exactly one task without failures")
        task = tasks[0]
        if (
            not isinstance(task, Mapping)
            or not isinstance(task.get("taskArn"), str)
            or not task["taskArn"]
        ):
            raise OperationalError("ECS RunTask returned an invalid task ARN")
        task_arn = task["taskArn"]
        heartbeat.revalidate()
        _wait_for_task_ready(
            clients,
            config,
            task_arn,
            heartbeat,
            timeout_seconds=task_ready_timeout_seconds,
        )
        release_lease = True
        return RunTaskResult(
            task_arn=task_arn,
            client_token=ecs_token,
            launch_attempt=launch_attempt,
            run_id=run_id,
            snapshot=snapshot,
            activated=activate_candidate,
        )
    except BaseException as error:
        primary_error = error
        if task_arn is not None:
            try:
                _stop_task_and_confirm(clients, config, task_arn, heartbeat)
            except Exception:
                pass
            else:
                release_lease = True
        elif not run_task_issued or no_task_created:
            release_lease = True
        raise
    finally:
        heartbeat.close()
        if not heartbeat.owned:
            release_lease = False
            if primary_error is None:
                heartbeat.ensure_owned()
        if release_lease:
            try:
                _release_launch_lease(clients.dynamodb, config, lease)
            except OperationalError:
                if primary_error is None:
                    raise


def _read_json(path: Path) -> Mapping[str, object]:
    """Lê json sem ampliar o escopo solicitado.

    Args:
        path: Caminho local do artefato lido ou produzido.

    Returns:
        Valor ``Mapping[str, object]`` produzido pela operação após as validações.

    Raises:
        OperationalError: Se a operação não puder preservar as invariantes descritas.
    """
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise OperationalError("operational input is not valid JSON") from error
    if not isinstance(payload, Mapping):
        raise OperationalError("operational JSON input must be an object")
    return cast(Mapping[str, object], payload)


def _parse_arguments(argv: list[str]) -> argparse.Namespace:
    """Converte argumentos para a representação interna validada.

    Args:
        argv: Argumentos da linha de comando; ``None`` utiliza ``sys.argv``.

    Returns:
        Valor ``argparse.Namespace`` produzido pela operação após as validações.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--terraform-output", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument(
        "--launch-attempt",
        required=True,
        help=(
            "Identificador não secreto e reproduzível desta tentativa de RunTask (1-64 caracteres)."
        ),
    )
    parser.add_argument("--confirm-production")
    activation = parser.add_mutually_exclusive_group(required=True)
    activation.add_argument("--activate", action="store_true", dest="activate_candidate")
    activation.add_argument("--no-activate", action="store_false", dest="activate_candidate")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Executa o ponto de entrada de linha de comando e devolve seu código de saída.

    Args:
        argv: Argumentos da linha de comando; ``None`` utiliza ``sys.argv``.

    Returns:
        Valor ``int`` produzido pela operação após as validações.
    """
    arguments = _parse_arguments(sys.argv[1:] if argv is None else argv)
    config = RunTaskConfig.from_terraform_output(_read_json(arguments.terraform_output))
    snapshot = SnapshotEvidence.from_mapping(_read_json(arguments.snapshot))
    import boto3  # type: ignore[import-untyped]

    session = boto3.session.Session(region_name=config.region)
    clients = RunTaskClients(
        sts=session.client("sts"),
        secrets=session.client("secretsmanager"),
        ecs=session.client("ecs"),
        scheduler=session.client("scheduler"),
        dynamodb=session.client("dynamodb"),
    )
    result = run_task(
        clients,
        config,
        snapshot,
        launch_attempt=arguments.launch_attempt,
        production_confirmation=arguments.confirm_production,
        activate_candidate=arguments.activate_candidate,
    )
    sys.stdout.write(json.dumps(result.to_public_dict(), sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OperationalError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
