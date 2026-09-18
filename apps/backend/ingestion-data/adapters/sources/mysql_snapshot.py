"""Restaura por streaming um snapshot imutável do S3 em um MySQL temporário.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import hmac
import os
import subprocess
import tempfile
import threading
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import BinaryIO, Protocol, cast

from adapters.sources.mysql_reader import MySqlConnectionSettings
from ports import (
    IdempotencyConflict,
    RestoreRequest,
    RestoreResult,
    SnapshotChecksumMismatch,
    SnapshotRestorer,
)

DEFAULT_CHUNK_SIZE = 1024 * 1024
MAX_ERROR_BYTES = 8 * 1024
PROCESS_STOP_TIMEOUT_SECONDS = 5.0


class SnapshotRestoreError(RuntimeError):
    """Indica que ``SnapshotRestoreError`` impediu a operação de continuar com segurança."""


class StreamingBody(Protocol):
    """Define o contrato mínimo de streaming corpo usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def read(self, amount: int | None = None) -> bytes:
        """Lê e devolve o conteúdo solicitado pela interface desta instância.

        Args:
            amount: Entrada ``amount``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``bytes`` produzido pela operação após as validações.
        """
        ...

    def close(self) -> None:
        """Libera recursos locais ainda mantidos pela instância.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        ...


class S3SnapshotClient(Protocol):
    """Define o contrato mínimo de s3 snapshot cliente usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def head_object(self, **kwargs: object) -> Mapping[str, object]:
        """Executa a etapa interna ``head_object`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def get_object(self, **kwargs: object) -> Mapping[str, object]:
        """Obtém objeto a partir da fonte configurada.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...


class ProcessInput(Protocol):
    """Define o contrato mínimo de process entrada usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def write(self, content: bytes) -> int:
        """Grava os dados recebidos e devolve a evidência da persistência.

        Args:
            content: Entrada ``content``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``int`` produzido pela operação após as validações.
        """
        ...

    def close(self) -> None:
        """Libera recursos locais ainda mantidos pela instância.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        ...


class MySqlProcess(Protocol):
    """Define o contrato mínimo de my sql process usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    @property
    def stdin(self) -> ProcessInput | None:
        """Executa a etapa interna ``stdin`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``ProcessInput | None`` produzido pela operação após as validações.
        """
        ...

    @property
    def stderr(self) -> BinaryIO | None:
        """Executa a etapa interna ``stderr`` e devolve o resultado validado indicado pela
        assinatura.

        Returns:
            Valor ``BinaryIO | None`` produzido pela operação após as validações.
        """
        ...

    def wait(self, timeout: float | None = None) -> int:
        """Aguarda a conclusão do processo respeitando o tempo limite informado.

        Args:
            timeout: Entrada ``timeout``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``int`` produzido pela operação após as validações.
        """
        ...

    def poll(self) -> int | None:
        """Consulta o processo ou serviço sem bloquear além do limite configurado.

        Returns:
            Valor ``int | None`` produzido pela operação após as validações.
        """
        ...

    def terminate(self) -> None:
        """Solicita o encerramento controlado do processo externo.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        ...

    def kill(self) -> None:
        """Força o encerramento do processo que não respondeu à terminação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        ...


class ProcessFactory(Protocol):
    """Define o contrato mínimo de process factory usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def __call__(
        self,
        argv: Sequence[str],
        *,
        stdin: int,
        stdout: int,
        stderr: int,
        shell: bool,
        env: Mapping[str, str],
    ) -> MySqlProcess:
        """Executa a instância como uma função com os argumentos fornecidos.

        Args:
            argv: Argumentos da linha de comando; ``None`` utiliza ``sys.argv``.
            stdin: Entrada ``stdin``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            stdout: Entrada ``stdout``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            stderr: Entrada ``stderr``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            shell: Entrada ``shell``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            env: Entrada ``env``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Valor ``MySqlProcess`` produzido pela operação após as validações.
        """
        ...


class _HashingReader:
    """Agrupa o estado e as operações de ``_HashingReader`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(self, body: StreamingBody) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            body: Entrada ``body``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._body = body
        self._hasher = hashlib.sha256()
        self._prefix = bytearray()
        self.bytes_read = 0

    def read(self, amount: int = -1) -> bytes:
        """Lê e devolve o conteúdo solicitado pela interface desta instância.

        Args:
            amount: Entrada ``amount``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``bytes`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        content = self._body.read(amount)
        if not isinstance(content, bytes):
            raise TypeError("S3 snapshot body must return bytes")
        if len(self._prefix) < 2:
            remaining = 2 - len(self._prefix)
            self._prefix.extend(content[:remaining])
        self._hasher.update(content)
        self.bytes_read += len(content)
        return content

    def drain(self, chunk_size: int) -> None:
        """Consome o fluxo até o fim sem manter todo o conteúdo em memória.

        Args:
            chunk_size: Entrada ``chunk_size``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        while self.read(chunk_size):
            pass

    def hexdigest(self) -> str:
        """Devolve o digest hexadecimal acumulado pelo leitor.

        Returns:
            Valor ``str`` produzido pela operação após as validações.
        """
        return self._hasher.hexdigest()

    def contains_gzip_member(self) -> bool:
        """Verifica a condição associada a contains gzip member.

        Returns:
            Valor ``bool`` produzido pela operação após as validações.
        """
        return self._prefix == b"\x1f\x8b"


class _StderrCollector:
    """Agrupa o estado e as operações de ``_StderrCollector`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(self, stream: BinaryIO) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            stream: Fluxo binário ou textual consumido incrementalmente.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._stream = stream
        self._captured = bytearray()
        self._thread = threading.Thread(target=self._drain, daemon=True)

    def start(self) -> None:
        """Inicia o processamento ou recurso gerenciado pela instância.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        self._thread.start()

    def finish(self) -> bytes:
        """Finaliza o processamento e devolve a evidência acumulada.

        Returns:
            Valor ``bytes`` produzido pela operação após as validações.
        """
        self._thread.join()
        return bytes(self._captured)

    def _drain(self) -> None:
        """Consome a entrada até o fim sem manter todo o conteúdo em memória.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        try:
            while chunk := self._stream.read(DEFAULT_CHUNK_SIZE):
                if len(self._captured) < MAX_ERROR_BYTES:
                    remaining = MAX_ERROR_BYTES - len(self._captured)
                    self._captured.extend(chunk[:remaining])
        finally:
            self._stream.close()


def _validated_head_digest(response: Mapping[str, object]) -> bytes:
    """Executa a etapa interna ``validated_head_digest`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        response: Entrada ``response``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``bytes`` produzido pela operação após as validações.

    Raises:
        SnapshotChecksumMismatch: Se a operação não puder preservar as invariantes descritas.
    """
    checksum = response.get("ChecksumSHA256")
    if not isinstance(checksum, str) or not checksum:
        raise SnapshotChecksumMismatch("snapshot metadata has no SHA-256 checksum")
    try:
        digest = base64.b64decode(checksum, validate=True)
    except (ValueError, TypeError) as error:
        raise SnapshotChecksumMismatch(
            "snapshot metadata has an invalid SHA-256 checksum"
        ) from error
    if len(digest) != hashlib.sha256().digest_size:
        raise SnapshotChecksumMismatch("snapshot metadata has an invalid SHA-256 checksum")
    return digest


def _validated_metadata_digest(response: Mapping[str, object]) -> bytes:
    """Executa a etapa interna ``validated_metadata_digest`` e devolve o resultado validado
    indicado pela assinatura.

    Args:
        response: Entrada ``response``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``bytes`` produzido pela operação após as validações.

    Raises:
        SnapshotChecksumMismatch: Se a operação não puder preservar as invariantes descritas.
    """
    metadata = response.get("Metadata")
    if not isinstance(metadata, Mapping):
        raise SnapshotChecksumMismatch("snapshot metadata has no full SHA-256 value")
    value = metadata.get("sha256")
    if not isinstance(value, str) or len(value) != hashlib.sha256().digest_size * 2:
        raise SnapshotChecksumMismatch("snapshot metadata has an invalid full SHA-256 value")
    try:
        digest = bytes.fromhex(value)
    except ValueError as error:
        raise SnapshotChecksumMismatch(
            "snapshot metadata has an invalid full SHA-256 value"
        ) from error
    if digest.hex() != value:
        raise SnapshotChecksumMismatch("snapshot metadata has an invalid full SHA-256 value")
    return digest


def _quote_option_file_value(value: str) -> str:
    """Produz o valor de quote option arquivo usado pela etapa seguinte.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    escaped = (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )
    return f'"{escaped}"'


def _create_defaults_file(settings: MySqlConnectionSettings) -> Path:
    """Cria defaults arquivo preservando as invariantes da camada.

    Args:
        settings: Entrada ``settings``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``Path`` produzido pela operação após as validações.
    """
    descriptor, raw_path = tempfile.mkstemp(prefix="mysql-client-", suffix=".cnf")
    path = Path(raw_path)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write("[client]\n")
            stream.write(f"protocol={_quote_option_file_value('TCP')}\n")
            stream.write(f"host={_quote_option_file_value(settings.host)}\n")
            stream.write(f"port={settings.port}\n")
            stream.write(f"user={_quote_option_file_value(settings.user)}\n")
            stream.write(f"password={_quote_option_file_value(settings.password)}\n")
            stream.write(f"database={_quote_option_file_value(settings.database)}\n")
        return path
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        path.unlink(missing_ok=True)
        raise


def _mysql_environment() -> dict[str, str]:
    """Executa a etapa interna ``mysql_environment`` e devolve o resultado validado indicado
    pela assinatura.

    Returns:
        Valor ``dict[str, str]`` produzido pela operação após as validações.
    """
    environment = dict(os.environ)
    environment.pop("MYSQL_PWD", None)
    return environment


def _mysql_argv(executable: str, defaults_file: Path) -> tuple[str, ...]:
    """Executa a etapa interna ``mysql_argv`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        executable: Entrada ``executable``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        defaults_file: Entrada ``defaults_file``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.

    Returns:
        Valor ``tuple[str, ...]`` produzido pela operação após as validações.
    """
    return (
        executable,
        f"--defaults-extra-file={defaults_file}",
        "--binary-mode=1",
    )


def _close_input(process: MySqlProcess) -> None:
    """Executa a etapa interna ``close_input`` e valida seus efeitos antes de concluir.

    Args:
        process: Entrada ``process``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.
    """
    if process.stdin is None:
        return
    try:
        process.stdin.close()
    except (BrokenPipeError, OSError):
        pass


def _terminate_and_reap(process: MySqlProcess) -> None:
    """Executa a etapa interna ``terminate_and_reap`` e valida seus efeitos antes de concluir.

    Args:
        process: Entrada ``process``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.
    """
    _close_input(process)
    if process.poll() is None:
        try:
            process.terminate()
        except OSError:
            pass
    try:
        process.wait(timeout=PROCESS_STOP_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        try:
            process.kill()
        except OSError:
            pass
        process.wait(timeout=PROCESS_STOP_TIMEOUT_SECONDS)


def _write_all(target: ProcessInput, content: bytes) -> None:
    """Grava all e devolve a evidência produzida pela operação.

    Args:
        target: Estado ou destino solicitado para a operação.
        content: Entrada ``content``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        BrokenPipeError: Se a operação não puder preservar as invariantes descritas.
    """
    offset = 0
    while offset < len(content):
        written = target.write(content[offset:])
        if isinstance(written, bool) or not isinstance(written, int) or written <= 0:
            raise BrokenPipeError("mysql input pipe stopped accepting bytes")
        offset += written


def _bounded_error_message(
    prefix: str,
    stderr: bytes,
    *,
    settings: MySqlConnectionSettings,
    defaults_file: Path,
) -> str:
    """Executa a etapa interna ``bounded_error_message`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        prefix: Entrada ``prefix``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        stderr: Entrada ``stderr``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        settings: Entrada ``settings``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        defaults_file: Entrada ``defaults_file``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    detail = stderr.decode("utf-8", errors="replace")
    for secret in (settings.password, os.fspath(defaults_file)):
        if secret:
            detail = detail.replace(secret, "[redacted]")
    message = prefix if not detail.strip() else f"{prefix}: {detail.strip()}"
    encoded = message.encode("utf-8")[:MAX_ERROR_BYTES]
    return encoded.decode("utf-8", errors="ignore")


class MySqlSnapshotRestorer(SnapshotRestorer):
    """Agrupa o estado e as operações de ``MySqlSnapshotRestorer`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        s3_client: S3SnapshotClient,
        settings: MySqlConnectionSettings,
        *,
        process_factory: ProcessFactory | None = None,
        mysql_executable: str = "mysql",
        chunk_size: int = DEFAULT_CHUNK_SIZE,
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            s3_client: Cliente injetado da API externa correspondente.
            settings: Entrada ``settings``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            process_factory: Fábrica injetada que cria a dependência somente quando necessária.
            mysql_executable: Entrada ``mysql_executable``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.
            chunk_size: Entrada ``chunk_size``; a forma aceita é definida pela anotação de tipo
            e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(settings, MySqlConnectionSettings):
            raise TypeError("settings must be MySqlConnectionSettings")
        if not isinstance(mysql_executable, str):
            raise TypeError("mysql_executable must be a string")
        if not mysql_executable:
            raise ValueError("mysql_executable must not be empty")
        if isinstance(chunk_size, bool) or not isinstance(chunk_size, int):
            raise TypeError("chunk_size must be an integer")
        if chunk_size <= 0:
            raise ValueError("chunk_size must be positive")
        self._s3 = s3_client
        self._settings = settings
        self._process_factory = process_factory or cast(ProcessFactory, subprocess.Popen)
        self._mysql_executable = mysql_executable
        self._chunk_size = chunk_size
        self._completed: dict[str, tuple[RestoreRequest, RestoreResult]] = {}
        self._lock = threading.Lock()

    def restore(self, request: RestoreRequest, *, idempotency_key: str) -> RestoreResult:
        """Restaura o recurso e confirma sua identidade antes de concluir.

        Args:
            request: Objeto de entrada já estruturado para o caso de uso.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``RestoreResult`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
            IdempotencyConflict: Se a operação não puder preservar as invariantes descritas.
        """
        if not isinstance(request, RestoreRequest):
            raise TypeError("request must be a RestoreRequest")
        if not isinstance(idempotency_key, str):
            raise TypeError("idempotency_key must be a string")
        if not idempotency_key:
            raise ValueError("idempotency_key must not be empty")

        with self._lock:
            completed = self._completed.get(idempotency_key)
            if completed is not None:
                previous_request, result = completed
                if previous_request != request:
                    raise IdempotencyConflict("idempotency key was reused with different input")
                return result
            result = self._restore_once(request)
            self._completed[idempotency_key] = (request, result)
            return result

    def _restore_once(self, request: RestoreRequest) -> RestoreResult:
        """Restaura once e confirma sua identidade antes de concluir.

        Args:
            request: Objeto de entrada já estruturado para o caso de uso.

        Returns:
            Valor ``RestoreResult`` produzido pela operação após as validações.

        Raises:
            SnapshotChecksumMismatch: Se a operação não puder preservar as invariantes
            descritas.
            SnapshotRestoreError: Se a operação não puder preservar as invariantes descritas.
        """
        object_arguments = {
            "Bucket": request.bucket,
            "Key": request.key,
            "VersionId": request.version_id,
            "ChecksumMode": "ENABLED",
        }
        metadata = self._s3.head_object(**object_arguments)
        expected_digest = bytes.fromhex(request.expected_sha256)
        head_version = metadata.get("VersionId")
        if head_version is not None and head_version != request.version_id:
            raise SnapshotChecksumMismatch("snapshot metadata differs from the requested version")
        full_digest = _validated_metadata_digest(metadata)
        if not hmac.compare_digest(full_digest, expected_digest):
            raise SnapshotChecksumMismatch(
                "snapshot metadata full SHA-256 differs from the requested SHA-256"
            )
        if metadata.get("ChecksumType") != "COMPOSITE" and not hmac.compare_digest(
            _validated_head_digest(metadata), expected_digest
        ):
            raise SnapshotChecksumMismatch(
                "snapshot metadata checksum differs from the requested SHA-256"
            )

        response = self._s3.get_object(**object_arguments)
        raw_body = response.get("Body")
        defaults_file: Path | None = None
        process: MySqlProcess | None = None
        stderr_collector: _StderrCollector | None = None
        process_reaped = False
        try:
            if (
                raw_body is None
                or not callable(getattr(raw_body, "read", None))
                or not callable(getattr(raw_body, "close", None))
            ):
                raise SnapshotRestoreError("S3 get_object returned no streaming body")
            body = cast(StreamingBody, raw_body)
            defaults_file = _create_defaults_file(self._settings)
            try:
                process = self._process_factory(
                    _mysql_argv(self._mysql_executable, defaults_file),
                    stdin=subprocess.PIPE,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    shell=False,
                    env=_mysql_environment(),
                )
                if process.stdin is None:
                    raise SnapshotRestoreError("mysql process did not expose an input pipe")
                if process.stderr is None:
                    raise SnapshotRestoreError("mysql process did not expose an error pipe")
                stderr_collector = _StderrCollector(process.stderr)
                stderr_collector.start()
                compressed = _HashingReader(body)
                with gzip.GzipFile(fileobj=cast(BinaryIO, compressed), mode="rb") as sql:
                    while chunk := sql.read(self._chunk_size):
                        _write_all(process.stdin, chunk)
                compressed.drain(self._chunk_size)
                _close_input(process)
                exit_code = process.wait()
                process_reaped = True
                stderr_content = stderr_collector.finish()
                if exit_code != 0:
                    raise SnapshotRestoreError(
                        _bounded_error_message(
                            f"mysql restore failed with exit code {exit_code}",
                            stderr_content,
                            settings=self._settings,
                            defaults_file=defaults_file,
                        )
                    )
                if not compressed.contains_gzip_member():
                    raise SnapshotRestoreError(
                        "snapshot stream does not contain a valid gzip member"
                    )
                compressed_sha256 = compressed.hexdigest()
                if not hmac.compare_digest(compressed_sha256, request.expected_sha256):
                    raise SnapshotChecksumMismatch(
                        "snapshot stream checksum differs from the requested SHA-256"
                    )
                return RestoreResult(compressed_sha256, compressed.bytes_read)
            except SnapshotChecksumMismatch:
                raise
            except SnapshotRestoreError:
                raise
            except (BrokenPipeError, OSError, EOFError, gzip.BadGzipFile) as error:
                if process is not None and not process_reaped:
                    _terminate_and_reap(process)
                    process_reaped = True
                stderr_content = b"" if stderr_collector is None else stderr_collector.finish()
                raise SnapshotRestoreError(
                    _bounded_error_message(
                        "mysql restore could not consume the snapshot stream",
                        stderr_content,
                        settings=self._settings,
                        defaults_file=defaults_file,
                    )
                ) from error
            finally:
                if process is not None and not process_reaped:
                    _terminate_and_reap(process)
                    process_reaped = True
                if stderr_collector is not None:
                    stderr_collector.finish()
        finally:
            try:
                close_body = getattr(raw_body, "close", None)
                if callable(close_body):
                    close_body()
            finally:
                if defaults_file is not None:
                    defaults_file.unlink(missing_ok=True)


__all__ = ["MySqlSnapshotRestorer", "SnapshotRestoreError"]
