"""Publica objetos históricos imutáveis no S3 e confirma sua identidade por checksum.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from __future__ import annotations

import base64
import hashlib
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Protocol
from urllib.parse import unquote

from botocore.exceptions import ClientError  # type: ignore[import-untyped]

from domain.archive import (
    canonical_archive_key,
    canonical_staging_archive_key,
    legacy_canonical_archive_key,
    staging_archive_key,
)
from domain.canonical_set import MAX_CANONICAL_OBJECT_BYTES
from ports import ArchiveObject, ArchiveObjectStore, ConditionalWriteError, EncodedPartition

MIN_MULTIPART_PART_SIZE = 5 * 1024 * 1024
MAX_MULTIPART_PART_SIZE = 5 * 1024 * 1024 * 1024
MAX_PUT_OBJECT_SIZE = 5 * 1024 * 1024 * 1024
MAX_COPY_OBJECT_SIZE = 5 * 1024 * 1024 * 1024
DEFAULT_MULTIPART_THRESHOLD = 64 * 1024 * 1024
DEFAULT_MULTIPART_PART_SIZE = 16 * 1024 * 1024
_MAX_MULTIPART_PARTS = 10_000
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_STAGING_KEY = re.compile(
    r"^staging/run_id=(?P<run>[^/]+)/dataset=(?P<dataset>[^/]+)/"
    r"date=(?P<date>[0-9]{4}-[0-9]{2}-[0-9]{2})/"
    r"(?P<sha>[0-9a-f]{64})\.parquet$"
)
_STAGING_KEY_V2 = re.compile(
    r"^staging/canonical/(?P<version>[^/]+)/(?P<dataset>[^/]+)/"
    r"(?P<partition>year=[0-9]{4}/month=[0-9]{2}/day=[0-9]{2}|"
    r"snapshot_date=[0-9]{4}-[0-9]{2}-[0-9]{2})/"
    r"part-(?P<ordinal>[0-9]{5})-(?P<sha>[0-9a-f]{64})\.parquet$"
)
_CANONICAL_KEY_V1 = re.compile(
    r"^canonical/schema_version=1\.0/dataset_version=(?P<version>[^/]+)/"
    r"dataset=(?P<dataset>[^/]+)/"
    r"(?P<partition>year=[0-9]{4}/month=[0-9]{2}/day=[0-9]{2}|"
    r"snapshot_date=[0-9]{4}-[0-9]{2}-[0-9]{2})/"
    r"part-(?P<sha>[0-9a-f]{64})\.parquet$"
)
_CANONICAL_KEY_V2 = re.compile(
    r"^canonical/schema_version=1\.0/dataset_version=(?P<version>[^/]+)/"
    r"dataset=(?P<dataset>[^/]+)/"
    r"(?P<partition>year=[0-9]{4}/month=[0-9]{2}/day=[0-9]{2}|"
    r"snapshot_date=[0-9]{4}-[0-9]{2}-[0-9]{2})/"
    r"generation=(?P<generation>[0-9a-f]{64})/"
    r"part-(?P<ordinal>[0-9]{5})-(?P<sha>[0-9a-f]{64})\.parquet$"
)
_SAFE_ERROR_CODE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
_ACCOUNT_ID = re.compile(r"^[0-9]{12}$")
_BUCKET = re.compile(r"^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$")
_IP_ADDRESS = re.compile(r"^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$")
_RESERVED_BUCKET_PREFIXES = ("xn--", "sthree-", "amzn-s3-demo-")
_RESERVED_BUCKET_SUFFIXES = ("-s3alias", "--ol-s3", ".mrap", "--x-s3", "--table-s3")


class S3ArchiveClient(Protocol):
    """Define o contrato mínimo de s3 arquivo histórico cliente usado para injeção de
    dependência.

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
        """Stream one exact object without listing or widening the requested scope."""
        ...

    def put_object(self, **kwargs: object) -> Mapping[str, object]:
        """Executa a etapa interna ``put_object`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def create_multipart_upload(self, **kwargs: object) -> Mapping[str, object]:
        """Cria multipart upload preservando as invariantes da camada.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def upload_part(self, **kwargs: object) -> Mapping[str, object]:
        """Envia part e confirma a identidade do objeto persistido.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def complete_multipart_upload(self, **kwargs: object) -> Mapping[str, object]:
        """Conclui multipart upload e devolve a evidência final da operação.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def abort_multipart_upload(self, **kwargs: object) -> Mapping[str, object]:
        """Cancela multipart upload e libera os recursos parciais conhecidos.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...

    def copy_object(self, **kwargs: object) -> Mapping[str, object]:
        """Copia objeto preservando sua identidade e integridade.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``Mapping[str, object]`` produzido pela operação após as validações.
        """
        ...


class ArchiveStorageError(RuntimeError):
    """Indica que ``ArchiveStorageError`` impediu a operação de continuar com segurança."""


class ArchiveChecksumMismatch(ArchiveStorageError):
    """Physical object bytes or metadata diverged from their immutable checksum."""


def _sha256(value: object) -> str:
    """Executa a etapa interna ``sha256`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise ValueError("sha256 must be a lowercase hexadecimal SHA-256 digest")
    return value


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


def _is_missing(error: ClientError) -> bool:
    """Informa se missing satisfaz a condição esperada.

    Args:
        error: Entrada ``error``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.
    """
    return _error_code(error) in {"404", "NoSuchKey", "NotFound"}


def _is_precondition(error: ClientError) -> bool:
    """Informa se precondition satisfaz a condição esperada.

    Args:
        error: Entrada ``error``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.
    """
    return _error_code(error) in {"409", "412", "ConditionalRequestConflict", "PreconditionFailed"}


def _checksum_base64(hex_digest: str) -> str:
    """Executa a etapa interna ``checksum_base64`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        hex_digest: Entrada ``hex_digest``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    return base64.b64encode(bytes.fromhex(_sha256(hex_digest))).decode("ascii")


def _decode_base64_checksum(value: str) -> bytes:
    """Decodifica base64 checksum e valida sua forma antes de devolvê-lo.

    Args:
        value: Valor não confiável que será validado ou convertido.

    Returns:
        Valor ``bytes`` produzido pela operação após as validações.

    Raises:
        ArchiveStorageError: Se a operação não puder preservar as invariantes descritas.
    """
    try:
        raw = base64.b64decode(value, validate=True)
    except (TypeError, ValueError) as error:
        raise ArchiveChecksumMismatch("S3 archive HEAD has an invalid SHA-256 checksum") from error
    if len(raw) != hashlib.sha256().digest_size:
        raise ArchiveChecksumMismatch("S3 archive HEAD has an invalid SHA-256 checksum")
    return raw


def _local_evidence(
    partition: EncodedPartition, part_size: int | None
) -> tuple[str, tuple[str, ...]]:
    """Executa a etapa interna ``local_evidence`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        partition: Identificador canônico da partição física ou lógica.
        part_size: Entrada ``part_size``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``tuple[str, tuple[str, ...]]`` produzido pela operação após as validações.

    Raises:
        ArchiveStorageError: Se a operação não puder preservar as invariantes descritas.
    """
    try:
        size = partition.path.stat().st_size
        digest = hashlib.sha256()
        part_checksums: list[str] = []
        read_size = part_size or 1024 * 1024
        with partition.path.open("rb") as source:
            for chunk in iter(lambda: source.read(read_size), b""):
                digest.update(chunk)
                if part_size is not None:
                    part_checksums.append(
                        base64.b64encode(hashlib.sha256(chunk).digest()).decode("ascii")
                    )
    except OSError as error:
        raise ArchiveStorageError("cannot read local encoded partition") from error
    if size != partition.byte_size or digest.hexdigest() != partition.sha256:
        raise ArchiveChecksumMismatch("local encoded partition differs from its checksum or size")
    if part_size is None:
        return _checksum_base64(partition.sha256), ()
    composite_digest = hashlib.sha256(
        b"".join(_decode_base64_checksum(checksum) for checksum in part_checksums)
    ).digest()
    composite = base64.b64encode(composite_digest).decode("ascii")
    return f"{composite}-{len(part_checksums)}", tuple(part_checksums)


class S3ArchiveStore(ArchiveObjectStore):
    """Agrupa o estado e as operações de ``S3ArchiveStore`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        client: S3ArchiveClient,
        bucket: str,
        *,
        multipart_threshold: int = DEFAULT_MULTIPART_THRESHOLD,
        multipart_part_size: int = DEFAULT_MULTIPART_PART_SIZE,
        expected_bucket_owner: str,
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            client: Cliente externo que executa a operação de infraestrutura.
            bucket: Nome do bucket S3 autorizado para a operação.
            multipart_threshold: Entrada ``multipart_threshold``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.
            multipart_part_size: Entrada ``multipart_part_size``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        if (
            not isinstance(bucket, str)
            or _BUCKET.fullmatch(bucket) is None
            or ".." in bucket
            or _IP_ADDRESS.fullmatch(bucket) is not None
            or bucket.startswith(_RESERVED_BUCKET_PREFIXES)
            or bucket.endswith(_RESERVED_BUCKET_SUFFIXES)
        ):
            raise ValueError("bucket must be a canonical S3 bucket name")
        if isinstance(multipart_threshold, bool) or not isinstance(multipart_threshold, int):
            raise TypeError("multipart_threshold must be an integer")
        if multipart_threshold <= 0:
            raise ValueError("multipart_threshold must be positive")
        if isinstance(multipart_part_size, bool) or not isinstance(multipart_part_size, int):
            raise TypeError("multipart_part_size must be an integer")
        if multipart_part_size < MIN_MULTIPART_PART_SIZE:
            raise ValueError("multipart_part_size must be at least 5 MiB")
        if multipart_part_size > MAX_MULTIPART_PART_SIZE:
            raise ValueError("multipart_part_size must be at most 5 GiB")
        if (
            not isinstance(expected_bucket_owner, str)
            or _ACCOUNT_ID.fullmatch(expected_bucket_owner) is None
        ):
            raise ValueError("expected_bucket_owner must be a 12-digit AWS account id")
        self._client = client
        self.bucket = bucket
        self._multipart_threshold = multipart_threshold
        self._multipart_part_size = multipart_part_size
        self._expected_bucket_owner = expected_bucket_owner

    def download(
        self,
        key: str,
        destination: Path,
        *,
        expected_sha256: str,
        expected_size: int,
        chunk_size: int = 8 * 1024 * 1024,
    ) -> ArchiveObject:
        """Download one canonical object while calculating its physical evidence."""
        if not isinstance(destination, Path):
            raise TypeError("destination must be a Path")
        expected_sha = _sha256(expected_sha256)
        if isinstance(expected_size, bool) or not isinstance(expected_size, int):
            raise TypeError("expected_size must be an integer")
        if expected_size < 0 or expected_size > MAX_CANONICAL_OBJECT_BYTES:
            raise ValueError("expected_size must be between zero and 512 MiB")
        if isinstance(chunk_size, bool) or not isinstance(chunk_size, int):
            raise TypeError("chunk_size must be an integer")
        if chunk_size <= 0:
            raise ValueError("chunk_size must be positive")
        self._validate_canonical_key(key, expected_sha)
        try:
            response = self._client.get_object(
                Bucket=self.bucket,
                Key=key,
                ExpectedBucketOwner=self._expected_bucket_owner,
                ChecksumMode="ENABLED",
            )
        except ClientError as error:
            raise ArchiveStorageError(f"S3 GetObject failed ({_error_code(error)})") from None
        body = response.get("Body")
        read = getattr(body, "read", None)
        close = getattr(body, "close", None)
        content_length = response.get("ContentLength")
        if (
            not callable(read)
            or isinstance(content_length, bool)
            or not isinstance(content_length, int)
        ):
            if callable(close):
                close()
            raise ArchiveStorageError("S3 GetObject returned invalid streaming evidence")
        if content_length != expected_size:
            if callable(close):
                close()
            raise ArchiveChecksumMismatch("canonical object size differs from marker evidence")
        digest = hashlib.sha256()
        observed_size = 0
        destination_created = False
        try:
            with destination.open("xb") as output:
                destination_created = True
                while chunk := read(chunk_size):
                    if not isinstance(chunk, bytes):
                        raise ArchiveStorageError("S3 GetObject body returned non-bytes content")
                    observed_size += len(chunk)
                    if observed_size > expected_size:
                        raise ArchiveChecksumMismatch(
                            "canonical object size differs from marker evidence"
                        )
                    digest.update(chunk)
                    output.write(chunk)
        except ArchiveStorageError:
            if destination_created:
                destination.unlink(missing_ok=True)
            raise
        except OSError as error:
            if destination_created:
                destination.unlink(missing_ok=True)
            raise ArchiveStorageError("cannot stream canonical object to local storage") from error
        finally:
            if callable(close):
                close()
        if observed_size != expected_size or digest.hexdigest() != expected_sha:
            destination.unlink(missing_ok=True)
            raise ArchiveChecksumMismatch("canonical object checksum differs from marker evidence")
        return ArchiveObject(key, expected_sha, expected_size)

    @staticmethod
    def _match_key(key: str, pattern: re.Pattern[str], expected_sha: str) -> re.Match[str]:
        """Monta a chave de match a partir de componentes validados.

        Args:
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            pattern: Entrada ``pattern``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            expected_sha: Valor esperado usado para detectar concorrência ou divergência de
            estado.

        Returns:
            Valor ``re.Match[str]`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(key, str):
            raise TypeError("archive key must be a string")
        matched = pattern.fullmatch(key)
        if matched is None or matched.group("sha") != expected_sha:
            raise ValueError("archive key differs from its required layout or checksum")
        return matched

    @classmethod
    def _validate_staging_key(cls, key: str, expected_sha: str) -> None:
        """Valida staging chave contra as invariantes deste módulo.

        Args:
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            expected_sha: Valor esperado usado para detectar concorrência ou divergência de
            estado.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        try:
            matched_v2 = _STAGING_KEY_V2.fullmatch(key)
            if matched_v2 is not None:
                matched = cls._match_key(key, _STAGING_KEY_V2, expected_sha)
                rebuilt = canonical_staging_archive_key(
                    unquote(matched.group("version"), errors="strict"),
                    unquote(matched.group("dataset"), errors="strict"),
                    matched.group("partition"),
                    expected_sha,
                    ordinal=int(matched.group("ordinal")),
                )
            else:
                matched = cls._match_key(key, _STAGING_KEY, expected_sha)
                rebuilt = staging_archive_key(
                    unquote(matched.group("run"), errors="strict"),
                    unquote(matched.group("dataset"), errors="strict"),
                    matched.group("date"),
                    expected_sha,
                )
        except (TypeError, ValueError, UnicodeError) as error:
            raise ValueError("archive key differs from its required layout or checksum") from error
        if rebuilt != key:
            raise ValueError("archive key differs from its required layout or checksum")

    @classmethod
    def _validate_canonical_key(cls, key: str, expected_sha: str) -> None:
        """Valida canônico chave contra as invariantes deste módulo.

        Args:
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            expected_sha: Valor esperado usado para detectar concorrência ou divergência de
            estado.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        matched_v2 = _CANONICAL_KEY_V2.fullmatch(key)
        try:
            if matched_v2 is not None:
                matched = cls._match_key(key, _CANONICAL_KEY_V2, expected_sha)
                rebuilt = canonical_archive_key(
                    unquote(matched.group("version"), errors="strict"),
                    unquote(matched.group("dataset"), errors="strict"),
                    matched.group("partition"),
                    expected_sha,
                    aggregate_digest=matched.group("generation"),
                    ordinal=int(matched.group("ordinal")),
                )
            else:
                matched = cls._match_key(key, _CANONICAL_KEY_V1, expected_sha)
                rebuilt = legacy_canonical_archive_key(
                    unquote(matched.group("version"), errors="strict"),
                    unquote(matched.group("dataset"), errors="strict"),
                    matched.group("partition"),
                    expected_sha,
                )
        except (TypeError, ValueError, UnicodeError) as error:
            raise ValueError("archive key differs from its required layout or checksum") from error
        if rebuilt != key:
            raise ValueError("archive key differs from its required layout or checksum")

    @staticmethod
    def _inputs(expected_absent: bool, idempotency_key: str) -> None:
        """Executa a etapa interna ``inputs`` e valida seus efeitos antes de concluir.

        Args:
            expected_absent: Indica se a operação exige que o recurso ainda não exista.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if expected_absent is not True:
            raise ConditionalWriteError("immutable archive writes require expected_absent=True")
        if not isinstance(idempotency_key, str) or not idempotency_key:
            raise ValueError("idempotency_key must be a non-empty string")

    def head(self, key: str) -> ArchiveObject | None:
        """Executa a etapa interna ``head`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.

        Returns:
            Valor ``ArchiveObject | None`` produzido pela operação após as validações.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
            ArchiveStorageError: Se a operação não puder preservar as invariantes descritas.
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        if not isinstance(key, str) or not key:
            raise ValueError("archive key must be non-empty")
        try:
            response = self._client.head_object(
                Bucket=self.bucket,
                Key=key,
                ChecksumMode="ENABLED",
                ExpectedBucketOwner=self._expected_bucket_owner,
            )
        except ClientError as error:
            if _is_missing(error):
                return None
            raise ArchiveStorageError(f"S3 HeadObject failed ({_error_code(error)})") from None
        try:
            size = response["ContentLength"]
            metadata = response["Metadata"]
            if isinstance(size, bool) or not isinstance(size, int) or size < 0:
                raise TypeError
            if not isinstance(metadata, Mapping):
                raise TypeError
            source_sha = _sha256(metadata.get("source-sha256"))
            if metadata.get("sha256") != source_sha:
                raise ValueError
            if metadata.get("source-size") != str(size):
                raise ValueError
            aws_checksum = metadata.get("aws-checksum-sha256")
            checksum_type = metadata.get("checksum-type")
            checksum_parts = metadata.get("checksum-parts")
            if response.get("ChecksumSHA256") != aws_checksum or not isinstance(aws_checksum, str):
                raise ValueError
            if checksum_type == "full":
                if checksum_parts != "1" or aws_checksum != _checksum_base64(source_sha):
                    raise ValueError
            elif checksum_type == "composite":
                raw_checksum, separator, raw_parts = aws_checksum.rpartition("-")
                if separator != "-" or raw_parts != checksum_parts:
                    raise ValueError
                parts = int(raw_parts)
                if parts < 2:
                    raise ValueError
                _decode_base64_checksum(raw_checksum)
            else:
                raise ValueError
            version_id = response.get("VersionId")
            if version_id is not None and (not isinstance(version_id, str) or not version_id):
                raise TypeError
            etag = response.get("ETag")
            if not isinstance(etag, str) or not etag:
                raise TypeError
            return ArchiveObject(key, source_sha, size, version_id=version_id, etag=etag)
        except (KeyError, TypeError) as error:
            raise ArchiveStorageError("S3 archive HEAD metadata is inconsistent") from error
        except ValueError as error:
            raise ArchiveChecksumMismatch(
                "S3 archive HEAD metadata is inconsistent with physical checksum evidence"
            ) from error

    @staticmethod
    def _require_content(
        actual: ArchiveObject | None, expected: ArchiveObject, context: str
    ) -> None:
        """Valida e devolve content, rejeitando entradas fora do contrato.

        Args:
            actual: Entrada ``actual``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            expected: Entrada ``expected``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            context: Contexto validado compartilhado durante o processamento.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ArchiveStorageError: Se o objeto confirmado não puder mais ser encontrado.
            ArchiveChecksumMismatch: Se a evidência física divergir do conteúdo esperado.
        """
        if actual is None:
            raise ArchiveStorageError(f"{context} is missing after S3 acknowledged the operation")
        if (actual.key, actual.sha256, actual.size) != (
            expected.key,
            expected.sha256,
            expected.size,
        ):
            raise ArchiveChecksumMismatch(
                f"{context} differs from expected physical checksum evidence"
            )

    def stage(
        self,
        partition: EncodedPartition,
        key: str,
        *,
        expected_absent: bool,
        idempotency_key: str,
    ) -> ArchiveObject:
        """Grava o objeto em staging antes de sua publicação definitiva.

        Args:
            partition: Identificador canônico da partição física ou lógica.
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            expected_absent: Indica se a operação exige que o recurso ainda não exista.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``ArchiveObject`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(partition, EncodedPartition):
            raise TypeError("partition must be an EncodedPartition")
        self._inputs(expected_absent, idempotency_key)
        self._validate_staging_key(key, partition.sha256)
        if _STAGING_KEY_V2.fullmatch(key) is not None and (
            partition.byte_size > MAX_CANONICAL_OBJECT_BYTES
        ):
            raise ValueError("canonical-v2 archive object must be at most 512 MiB")
        if partition.byte_size > MAX_COPY_OBJECT_SIZE:
            raise ValueError("archive partition must be at most 5 GiB for atomic promotion")
        multipart = (
            partition.byte_size > self._multipart_threshold
            or partition.byte_size > MAX_PUT_OBJECT_SIZE
        ) and partition.byte_size > self._multipart_part_size
        aws_checksum, part_checksums = _local_evidence(
            partition, self._multipart_part_size if multipart else None
        )
        expected = ArchiveObject(key, partition.sha256, partition.byte_size)
        current = self.head(key)
        if current is not None:
            self._require_content(current, expected, "staged archive object")
            return current
        if multipart:
            self._multipart_upload(partition, key, aws_checksum, part_checksums)
        else:
            self._put_object(partition, key, aws_checksum)
        confirmed = self.head(key)
        self._require_content(confirmed, expected, "uploaded staged archive object")
        assert confirmed is not None
        return confirmed

    def _metadata(
        self,
        partition: EncodedPartition,
        aws_checksum: str,
        *,
        checksum_type: str,
        checksum_parts: int,
    ) -> dict[str, str]:
        """Executa a etapa interna ``metadata`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            partition: Identificador canônico da partição física ou lógica.
            aws_checksum: Entrada ``aws_checksum``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            checksum_type: Entrada ``checksum_type``; a forma aceita é definida pela anotação de
            tipo e validada antes do uso.
            checksum_parts: Entrada ``checksum_parts``; a forma aceita é definida pela anotação
            de tipo e validada antes do uso.

        Returns:
            Valor ``dict[str, str]`` produzido pela operação após as validações.
        """
        return {
            "sha256": partition.sha256,
            "source-sha256": partition.sha256,
            "source-size": str(partition.byte_size),
            "aws-checksum-sha256": aws_checksum,
            "checksum-type": checksum_type,
            "checksum-parts": str(checksum_parts),
        }

    def _put_object(self, partition: EncodedPartition, key: str, checksum: str) -> None:
        """Executa a etapa interna ``put_object`` e valida seus efeitos antes de concluir.

        Args:
            partition: Identificador canônico da partição física ou lógica.
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            checksum: Entrada ``checksum``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ArchiveStorageError: Se a operação não puder preservar as invariantes descritas.
        """
        try:
            with partition.path.open("rb") as source:
                self._client.put_object(
                    Bucket=self.bucket,
                    Key=key,
                    Body=source,
                    ContentLength=partition.byte_size,
                    ContentType="application/vnd.apache.parquet",
                    ChecksumAlgorithm="SHA256",
                    ChecksumSHA256=checksum,
                    IfNoneMatch="*",
                    Metadata=self._metadata(
                        partition, checksum, checksum_type="full", checksum_parts=1
                    ),
                    ExpectedBucketOwner=self._expected_bucket_owner,
                )
        except ClientError as error:
            if _is_precondition(error):
                existing = self.head(key)
                self._require_content(
                    existing,
                    ArchiveObject(key, partition.sha256, partition.byte_size),
                    "concurrent staged archive object",
                )
                return
            raise ArchiveStorageError(f"S3 PutObject failed ({_error_code(error)})") from None
        except OSError as error:
            raise ArchiveStorageError("cannot stream local encoded partition") from error

    def _multipart_upload(
        self,
        partition: EncodedPartition,
        key: str,
        composite_checksum: str,
        part_checksums: tuple[str, ...],
    ) -> None:
        """Executa a etapa interna ``multipart_upload`` e valida seus efeitos antes de concluir.

        Args:
            partition: Identificador canônico da partição física ou lógica.
            key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            composite_checksum: Entrada ``composite_checksum``; a forma aceita é definida pela
            anotação de tipo e validada antes do uso.
            part_checksums: Entrada ``part_checksums``; a forma aceita é definida pela anotação
            de tipo e validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ArchiveStorageError: Se a operação não puder preservar as invariantes descritas.
        """
        part_count = (
            partition.byte_size + self._multipart_part_size - 1
        ) // self._multipart_part_size
        if part_count > _MAX_MULTIPART_PARTS:
            raise ArchiveStorageError("encoded partition exceeds the configured multipart bound")
        upload_id: str | None = None
        try:
            created = self._client.create_multipart_upload(
                Bucket=self.bucket,
                Key=key,
                ContentType="application/vnd.apache.parquet",
                ChecksumAlgorithm="SHA256",
                ChecksumType="COMPOSITE",
                Metadata=self._metadata(
                    partition,
                    composite_checksum,
                    checksum_type="composite",
                    checksum_parts=len(part_checksums),
                ),
                ExpectedBucketOwner=self._expected_bucket_owner,
            )
            raw_upload_id = created.get("UploadId")
            if not isinstance(raw_upload_id, str) or not raw_upload_id:
                raise ArchiveStorageError("S3 multipart creation returned no upload id")
            upload_id = raw_upload_id
            parts: list[dict[str, object]] = []
            streamed_digest = hashlib.sha256()
            with partition.path.open("rb") as source:
                part_number = 1
                while body := source.read(self._multipart_part_size):
                    part_checksum = base64.b64encode(hashlib.sha256(body).digest()).decode("ascii")
                    if (
                        part_number > len(part_checksums)
                        or part_checksum != part_checksums[part_number - 1]
                    ):
                        raise ArchiveChecksumMismatch(
                            "local encoded partition changed during multipart upload"
                        )
                    streamed_digest.update(body)
                    response = self._client.upload_part(
                        Bucket=self.bucket,
                        Key=key,
                        UploadId=upload_id,
                        PartNumber=part_number,
                        Body=body,
                        ContentLength=len(body),
                        ChecksumAlgorithm="SHA256",
                        ChecksumSHA256=part_checksum,
                        ExpectedBucketOwner=self._expected_bucket_owner,
                    )
                    etag = response.get("ETag")
                    returned_checksum = response.get("ChecksumSHA256")
                    if not isinstance(etag, str) or not etag:
                        raise ArchiveStorageError("S3 multipart upload returned no part ETag")
                    if returned_checksum is not None and returned_checksum != part_checksum:
                        raise ArchiveChecksumMismatch("S3 multipart part checksum differs")
                    parts.append(
                        {
                            "ETag": etag,
                            "PartNumber": part_number,
                            "ChecksumSHA256": part_checksum,
                        }
                    )
                    part_number += 1
            if len(parts) != len(part_checksums) or streamed_digest.hexdigest() != partition.sha256:
                raise ArchiveChecksumMismatch(
                    "local encoded partition changed during multipart upload"
                )
            self._client.complete_multipart_upload(
                Bucket=self.bucket,
                Key=key,
                UploadId=upload_id,
                MultipartUpload={"Parts": parts},
                ChecksumType="COMPOSITE",
                MpuObjectSize=partition.byte_size,
                IfNoneMatch="*",
                ExpectedBucketOwner=self._expected_bucket_owner,
            )
            upload_id = None
        except ClientError as error:
            if _is_precondition(error):
                existing = self.head(key)
                self._require_content(
                    existing,
                    ArchiveObject(key, partition.sha256, partition.byte_size),
                    "concurrent staged archive object",
                )
                return
            raise ArchiveStorageError(
                f"S3 multipart upload failed ({_error_code(error)})"
            ) from None
        except OSError as error:
            raise ArchiveStorageError("cannot stream local encoded partition") from error
        finally:
            if upload_id is not None:
                try:
                    self._client.abort_multipart_upload(
                        Bucket=self.bucket,
                        Key=key,
                        UploadId=upload_id,
                        ExpectedBucketOwner=self._expected_bucket_owner,
                    )
                except ClientError:
                    pass

    def promote(
        self,
        staged: ArchiveObject,
        canonical_key: str,
        *,
        expected_absent: bool,
        idempotency_key: str,
    ) -> ArchiveObject:
        """Promove o objeto temporário para sua identidade canônica e imutável.

        Args:
            staged: Entrada ``staged``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            canonical_key: Chave usada para identificar, consultar ou persistir o recurso.
            expected_absent: Indica se a operação exige que o recurso ainda não exista.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``ArchiveObject`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
            ConditionalWriteError: Se a operação não puder preservar as invariantes descritas.
            ArchiveStorageError: Se a operação não puder preservar as invariantes descritas.
        """
        if not isinstance(staged, ArchiveObject):
            raise TypeError("staged must be an ArchiveObject")
        self._inputs(expected_absent, idempotency_key)
        self._validate_staging_key(staged.key, staged.sha256)
        self._validate_canonical_key(canonical_key, staged.sha256)
        if staged.size > MAX_COPY_OBJECT_SIZE:
            raise ValueError("archive partition must be at most 5 GiB for atomic promotion")
        staged_head = self.head(staged.key)
        self._require_content(staged_head, staged, "staged archive object")
        assert staged_head is not None
        if (
            staged.etag is None
            or staged_head.etag != staged.etag
            or staged_head.version_id != staged.version_id
        ):
            raise ConditionalWriteError(
                "staged archive object version differs from expected evidence"
            )
        expected = ArchiveObject(canonical_key, staged.sha256, staged.size)
        current = self.head(canonical_key)
        if current is not None:
            self._require_content(current, expected, "canonical archive object")
            return current
        try:
            copy_source = {"Bucket": self.bucket, "Key": staged.key}
            if staged.version_id is not None:
                copy_source["VersionId"] = staged.version_id
            self._client.copy_object(
                Bucket=self.bucket,
                Key=canonical_key,
                CopySource=copy_source,
                CopySourceIfMatch=staged.etag,
                IfNoneMatch="*",
                ChecksumAlgorithm="SHA256",
                MetadataDirective="REPLACE",
                ContentType="application/vnd.apache.parquet",
                Metadata={
                    "sha256": staged.sha256,
                    "source-sha256": staged.sha256,
                    "source-size": str(staged.size),
                    "aws-checksum-sha256": _checksum_base64(staged.sha256),
                    "checksum-type": "full",
                    "checksum-parts": "1",
                },
                ExpectedBucketOwner=self._expected_bucket_owner,
                ExpectedSourceBucketOwner=self._expected_bucket_owner,
            )
        except ClientError as error:
            if not _is_precondition(error):
                raise ArchiveStorageError(f"S3 CopyObject failed ({_error_code(error)})") from None
        confirmed = self.head(canonical_key)
        self._require_content(confirmed, expected, "promoted canonical archive object")
        assert confirmed is not None
        return confirmed


__all__ = [
    "ArchiveStorageError",
    "DEFAULT_MULTIPART_PART_SIZE",
    "DEFAULT_MULTIPART_THRESHOLD",
    "MAX_COPY_OBJECT_SIZE",
    "MAX_MULTIPART_PART_SIZE",
    "MAX_PUT_OBJECT_SIZE",
    "MIN_MULTIPART_PART_SIZE",
    "S3ArchiveStore",
    "canonical_archive_key",
    "staging_archive_key",
]
