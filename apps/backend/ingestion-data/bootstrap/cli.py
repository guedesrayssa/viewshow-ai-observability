"""Converte argumentos da CLI em comandos e códigos de saída estáveis.

Papel no fluxo:
    Este módulo fica na borda de inicialização: interpreta configuração, seleciona capacidades e
    conecta os casos de uso aos adaptadores concretos.

Garantias e limites:
    Importar o módulo não deve iniciar conexões nem executar efeitos; recursos são criados
    somente para o comando solicitado.
"""

from __future__ import annotations

import argparse
import re
import sys
import uuid
from collections.abc import Callable
from typing import Never, Protocol

from adapters.telemetry import JsonLogger, safe_error_message
from bootstrap.config import ConfigurationError, Settings
from bootstrap.container import build_container
from domain.import_job import validate_import_id
from domain.run import RunStage

COMMANDS = (
    "validate",
    "backfill",
    "import-dump",
    "sync",
    "reprocess",
    "rebuild-projections",
    "publish-outbox",
    "export-incremental",
    "ingest-incremental",
)

SUCCESS = 0
OPERATIONAL_FAILURE = 1
CONFIGURATION_FAILURE = 2
INTERRUPTED = 130
_RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class CommandHandler(Protocol):
    """Define o contrato mínimo de comando handler usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def __call__(self, arguments: argparse.Namespace) -> object:
        """Executa a instância como uma função com os argumentos fornecidos.

        Args:
            arguments: Entrada ``arguments``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        ...


type HandlerFactory = Callable[[str], CommandHandler]


class CommandConfigurationError(RuntimeError):
    """Indica que ``CommandConfigurationError`` impediu a operação de continuar com segurança."""


def _emit_json_failure(*, event: str, error_code: str, message: str, command: str | None) -> None:
    """Emite json failure pelo canal de telemetria configurado.

    Args:
        event: Evento de análise validado que será codificado ou publicado.
        error_code: Entrada ``error_code``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        message: Entrada ``message``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        command: Entrada ``command``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.
    """
    context: dict[str, object] = {
        "traceId": f"trace-{uuid.uuid4().hex}",
        "runId": f"cli-{uuid.uuid4().hex}",
    }
    if command in COMMANDS:
        context["command"] = command
    JsonLogger(environment="unknown", stream=sys.stderr).bind(**context).error(
        event,
        stage="FAILED",
        errorCode=error_code,
        message=message,
    )


def _emit_failure(arguments: argparse.Namespace, error: BaseException) -> None:
    """Emite failure pelo canal de telemetria configurado.

    Args:
        arguments: Entrada ``arguments``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        error: Entrada ``error``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.
    """
    _emit_json_failure(
        event="ingestion.run.failed",
        error_code=type(error).__name__,
        message=safe_error_message(error),
        command=getattr(arguments, "command", None),
    )


class SafeArgumentParser(argparse.ArgumentParser):
    """Agrupa o estado e as operações de ``SafeArgumentParser`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def error(self, _message: str) -> Never:
        """Registra ou transforma uma falha sem expor dados sensíveis.

        Args:
            _message: Mensagem não confiável que será sanitizada antes do uso.

        Returns:
            Valor ``Never`` produzido pela operação após as validações.

        Raises:
            SystemExit: Se a operação não puder preservar as invariantes descritas.
        """
        command = self.prog.rsplit(" ", 1)[-1]
        _emit_json_failure(
            event="ingestion.command.invalid",
            error_code="ArgumentError",
            message="invalid command arguments",
            command=command,
        )
        raise SystemExit(CONFIGURATION_FAILURE)


def _positive_int(value: str) -> int:
    """Executa a etapa interna ``positive_int`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``int`` produzido pela operação após as validações.

    Raises:
        ArgumentTypeError: Se a operação não puder preservar as invariantes descritas.
    """
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive integer") from error
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def _run_id(value: str) -> str:
    """Calcula ou valida o identificador de execução.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ArgumentTypeError: Se a operação não puder preservar as invariantes descritas.
    """
    if _RUN_ID.fullmatch(value) is None:
        raise argparse.ArgumentTypeError("must be a bounded non-secret run identifier")
    return value


def build_parser() -> argparse.ArgumentParser:
    """Constrói parser a partir das entradas validadas.

    Returns:
        Valor ``argparse.ArgumentParser`` produzido pela operação após as validações.
    """
    parser = SafeArgumentParser(prog="data-ingestion")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in COMMANDS:
        command_parser = subparsers.add_parser(command)
        if command == "validate":
            command_parser.add_argument("--no-write", action="store_true")
        elif command == "backfill":
            command_parser.add_argument("--run-id", required=True, type=_run_id)
        elif command == "import-dump":
            command_parser.add_argument("--import-id", required=True, type=validate_import_id)
        elif command == "publish-outbox":
            command_parser.add_argument("--limit", type=_positive_int)
        elif command == "ingest-incremental":
            command_parser.add_argument("--limit", type=_positive_int)
        elif command == "reprocess":
            command_parser.add_argument("--dataset", required=True)
            command_parser.add_argument("--start", required=True)
            command_parser.add_argument("--end", required=True)
        elif command == "rebuild-projections":
            command_parser.add_argument("--dataset-version")
            command_parser.add_argument("--partition-key", dest="partition_keys", action="append")
            command_parser.add_argument(
                "--archive-partition", dest="archive_partitions", action="append"
            )
    return parser


def _exit_code(result: object) -> int:
    """Obtém o código de exit em formato seguro para exposição.

    Args:
        result: Entrada ``result``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``int`` produzido pela operação após as validações.
    """
    stage = getattr(result, "stage", None)
    if stage in {RunStage.PARTIAL, RunStage.FAILED}:
        return OPERATIONAL_FAILURE
    if stage in {RunStage.SKIPPED_DISABLED, RunStage.SKIPPED_LOCKED}:
        return SUCCESS
    succeeded = getattr(result, "succeeded", None)
    if succeeded is False:
        return OPERATIONAL_FAILURE
    return SUCCESS


def main(
    argv: list[str] | None = None,
    *,
    handler_factory: HandlerFactory | None = None,
) -> int:
    """Executa o ponto de entrada de linha de comando e devolve seu código de saída.

    Args:
        argv: Argumentos da linha de comando; ``None`` utiliza ``sys.argv``.
        handler_factory: Fábrica injetada que cria a dependência somente quando necessária.

    Returns:
        Valor ``int`` produzido pela operação após as validações.

    Raises:
        CommandConfigurationError: Se a operação não puder preservar as invariantes descritas.
    """
    arguments = build_parser().parse_args(argv)
    telemetry_observed = False
    try:
        if handler_factory is None:
            no_write = bool(getattr(arguments, "no_write", False))
            settings = Settings.from_env(
                command=arguments.command,
                no_write=no_write,
            )
            runtime = build_container(settings).resolve(
                arguments.command,
                no_write=no_write,
            )
            handler = runtime.handler
        else:
            handler = handler_factory(arguments.command)
        if not callable(handler):
            raise CommandConfigurationError("handler factory returned a non-callable value")
        telemetry_observed = bool(getattr(handler, "telemetry_observed", False))
        return _exit_code(handler(arguments))
    except (CommandConfigurationError, ConfigurationError) as error:
        if not telemetry_observed:
            _emit_failure(arguments, error)
        return CONFIGURATION_FAILURE
    except KeyboardInterrupt as error:
        if not telemetry_observed:
            _emit_failure(arguments, error)
        return INTERRUPTED
    except Exception as error:
        if not telemetry_observed:
            _emit_failure(arguments, error)
        return OPERATIONAL_FAILURE


__all__ = [
    "COMMANDS",
    "CONFIGURATION_FAILURE",
    "CommandConfigurationError",
    "HandlerFactory",
    "INTERRUPTED",
    "OPERATIONAL_FAILURE",
    "SUCCESS",
    "build_parser",
    "main",
]
