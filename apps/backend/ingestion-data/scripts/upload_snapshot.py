"""Valida e envia ao S3 um snapshot gzip imutável e versionado.

Papel no fluxo:
    Este arquivo é uma ferramenta operacional executada fora do worker principal e valida todas
    as entradas antes de produzir efeitos externos.

Garantias e limites:
    A saída contém somente evidências não sensíveis que podem ser preservadas para auditoria ou
    consumidas pela etapa operacional seguinte.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import os
import stat
import sys
import tempfile
import zipfile
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Protocol, cast

from domain.snapshot_provenance import parse_snapshot_extracted_on

MIB = 1024 * 1024
MIN_MULTIPART_PART_SIZE = 5 * MIB
DEFAULT_PART_SIZE = 16 * MIB
MAX_MULTIPART_PARTS = 10_000
READ_CHUNK_SIZE = MIB
EXPECTED_MEMBER_NAME = "argus_dump.sql.gz"


class SnapshotUploadError(RuntimeError):
    """Indica que ``SnapshotUploadError`` impediu a operação de continuar com segurança."""


class S3SnapshotUploadClient(Protocol):
    """Define o contrato mínimo de s3 snapshot upload cliente usado para injeção de dependência.

    Implementações concretas devem preservar tipos, efeitos e falhas descritos pelos métodos.
    """

    def get_bucket_versioning(self, **kwargs: object) -> Mapping[str, object]:
        """Obtém bucket versioning a partir da fonte configurada.

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

    def abort_multipart_upload(self, **kwargs: object) -> object:
        """Cancela multipart upload e libera os recursos parciais conhecidos.

        Args:
            kwargs: Entrada ``kwargs``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``object`` produzido pela operação após as validações.
        """
        ...

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


@dataclass(frozen=True, slots=True)
class UploadLimits:
    """Representa os dados de ``UploadLimits`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        max_input_bytes: Quantidade de bytes usada como tamanho ou limite.
        max_gzip_bytes: Quantidade de bytes usada como tamanho ou limite.
        max_sql_bytes: Quantidade de bytes usada como tamanho ou limite.
        max_zip_expansion_ratio: Entrada ``max_zip_expansion_ratio``; a forma aceita é definida
        pela anotação de tipo e validada antes do uso.
    """

    max_input_bytes: int = 10 * 1024 * MIB
    max_gzip_bytes: int = 5 * 1024 * MIB
    max_sql_bytes: int = 100 * 1024 * MIB
    max_zip_expansion_ratio: int = 100

    def validate(self) -> None:
        """Valida a configuração e as invariantes mantidas pela instância.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if any(
            isinstance(value, bool) or not isinstance(value, int) or value <= 0
            for value in (
                self.max_input_bytes,
                self.max_gzip_bytes,
                self.max_sql_bytes,
                self.max_zip_expansion_ratio,
            )
        ):
            raise ValueError("upload limits must be positive integers")


DEFAULT_UPLOAD_LIMITS = UploadLimits()


@dataclass(frozen=True, slots=True)
class SnapshotUploadResult:
    """Representa os dados de ``SnapshotUploadResult`` usados por este módulo.

    A construção valida os atributos para que a instância possa circular entre as etapas sem
    verificações defensivas repetidas.

    Attributes:
        schema_version: Versão imutável usada para identidade e compatibilidade.
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

    schema_version: str
    bucket: str
    key: str
    version_id: str
    sha256: str
    size: int
    snapshot_extracted_on: date

    def to_public_dict(self) -> dict[str, object]:
        """Converte a instância para public dict.

        Returns:
            Valor ``dict[str, object]`` produzido pela operação após as validações.
        """
        return {
            "schemaVersion": self.schema_version,
            "bucket": self.bucket,
            "key": self.key,
            "versionId": self.version_id,
            "sha256": self.sha256,
            "size": self.size,
            "snapshotExtractedOn": self.snapshot_extracted_on.isoformat(),
        }


class _HashingReader:
    """Agrupa o estado e as operações de ``_HashingReader`` neste módulo.

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
        self._hasher = hashlib.sha256()
        self.size = 0

    def read(self, amount: int = -1) -> bytes:
        """Lê e devolve o conteúdo solicitado pela interface desta instância.

        Args:
            amount: Entrada ``amount``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``bytes`` produzido pela operação após as validações.

        Raises:
            SnapshotUploadError: Se a operação não puder preservar as invariantes descritas.
        """
        content = self._stream.read(amount)
        if not isinstance(content, bytes):
            raise SnapshotUploadError("snapshot stream did not return bytes")
        self._hasher.update(content)
        self.size += len(content)
        return content

    def drain(self) -> None:
        """Consome o fluxo até o fim sem manter todo o conteúdo em memória.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.
        """
        while self.read(READ_CHUNK_SIZE):
            pass

    def hexdigest(self) -> str:
        """Devolve o digest hexadecimal acumulado pelo leitor.

        Returns:
            Valor ``str`` produzido pela operação após as validações.
        """
        return self._hasher.hexdigest()


def _require_regular_file(path: Path, limits: UploadLimits) -> os.stat_result:
    """Valida e devolve regular arquivo, rejeitando entradas fora do contrato.

    Args:
        path: Caminho local do artefato lido ou produzido.
        limits: Entrada ``limits``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``os.stat_result`` produzido pela operação após as validações.

    Raises:
        SnapshotUploadError: Se a operação não puder preservar as invariantes descritas.
    """
    try:
        metadata = path.stat()
    except OSError as error:
        raise SnapshotUploadError("snapshot file cannot be inspected") from error
    if not stat.S_ISREG(metadata.st_mode):
        raise SnapshotUploadError("snapshot input must be a regular file")
    if metadata.st_size <= 0:
        raise SnapshotUploadError("snapshot input must not be empty")
    if metadata.st_size > limits.max_input_bytes:
        raise SnapshotUploadError("snapshot input exceeds the configured size limit")
    return metadata


def _validate_gzip(stream: BinaryIO, limits: UploadLimits) -> tuple[str, int]:
    """Valida gzip contra as invariantes deste módulo.

    Args:
        stream: Fluxo binário ou textual consumido incrementalmente.
        limits: Entrada ``limits``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``tuple[str, int]`` produzido pela operação após as validações.

    Raises:
        SnapshotUploadError: Se a operação não puder preservar as invariantes descritas.
    """
    compressed = _HashingReader(stream)
    sql_bytes = 0
    try:
        with gzip.GzipFile(fileobj=cast(BinaryIO, compressed), mode="rb") as sql:
            while chunk := sql.read(READ_CHUNK_SIZE):
                sql_bytes += len(chunk)
                if sql_bytes > limits.max_sql_bytes:
                    raise SnapshotUploadError("gzip SQL payload exceeds the configured size limit")
        compressed.drain()
    except (EOFError, OSError, gzip.BadGzipFile) as error:
        raise SnapshotUploadError("snapshot is not a complete valid gzip stream") from error
    if compressed.size <= 0:
        raise SnapshotUploadError("snapshot gzip stream must not be empty")
    if compressed.size > limits.max_gzip_bytes:
        raise SnapshotUploadError("gzip snapshot exceeds the configured size limit")
    return compressed.hexdigest(), compressed.size


def _safe_zip_member(archive: zipfile.ZipFile, limits: UploadLimits) -> zipfile.ZipInfo:
    """Produz zip member em formato seguro para logs ou persistência.

    Args:
        archive: Partição histórica cuja evidência será consultada ou atualizada.
        limits: Entrada ``limits``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``zipfile.ZipInfo`` produzido pela operação após as validações.

    Raises:
        SnapshotUploadError: Se a operação não puder preservar as invariantes descritas.
    """
    members = archive.infolist()
    if len(members) != 1:
        raise SnapshotUploadError("ZIP must contain exactly one root member: argus_dump.sql.gz")
    selected = members[0]
    member_path = PurePosixPath(selected.filename)
    if member_path.is_absolute() or ".." in member_path.parts:
        raise SnapshotUploadError("ZIP member path is not safe")
    if (
        selected.is_dir()
        or member_path != PurePosixPath(EXPECTED_MEMBER_NAME)
        or selected.filename != EXPECTED_MEMBER_NAME
        or selected.orig_filename != EXPECTED_MEMBER_NAME
    ):
        raise SnapshotUploadError("ZIP must contain exactly one root member: argus_dump.sql.gz")
    mode = selected.external_attr >> 16
    if stat.S_IFMT(mode) not in {0, stat.S_IFREG}:
        raise SnapshotUploadError("ZIP member must be a regular file")
    if selected.flag_bits & 0x1:
        raise SnapshotUploadError("encrypted ZIP members are not supported")
    if selected.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
        raise SnapshotUploadError("ZIP compression method is not supported")
    if selected.file_size <= 0 or selected.file_size > limits.max_gzip_bytes:
        raise SnapshotUploadError("ZIP gzip member exceeds the configured size limit")
    compressed_size = max(selected.compress_size, 1)
    if selected.file_size > compressed_size * limits.max_zip_expansion_ratio:
        raise SnapshotUploadError("ZIP gzip member exceeds the configured expansion ratio")
    return selected


def _copy_to_staging(source: BinaryIO, staging: BinaryIO, limits: UploadLimits) -> tuple[str, int]:
    """Copia to staging preservando sua identidade e integridade.

    Args:
        source: Identificador da fonte de dados processada.
        staging: Entrada ``staging``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        limits: Entrada ``limits``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``tuple[str, int]`` produzido pela operação após as validações.

    Raises:
        SnapshotUploadError: Se a operação não puder preservar as invariantes descritas.
    """
    hasher = hashlib.sha256()
    size = 0
    while chunk := source.read(READ_CHUNK_SIZE):
        if not isinstance(chunk, bytes):
            raise SnapshotUploadError("snapshot stream did not return bytes")
        size += len(chunk)
        if size > limits.max_gzip_bytes:
            raise SnapshotUploadError("gzip snapshot exceeds the configured size limit")
        hasher.update(chunk)
        staging.write(chunk)
    if size <= 0:
        raise SnapshotUploadError("snapshot gzip stream must not be empty")
    return hasher.hexdigest(), size


def _part_size_for(total_size: int, requested_part_size: int) -> int:
    """Executa a etapa interna ``part_size_for`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        total_size: Entrada ``total_size``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        requested_part_size: Entrada ``requested_part_size``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.

    Returns:
        Valor ``int`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if isinstance(requested_part_size, bool) or not isinstance(requested_part_size, int):
        raise TypeError("part_size must be an integer")
    if requested_part_size < MIN_MULTIPART_PART_SIZE:
        raise ValueError("part_size must be at least 5 MiB")
    minimum_for_count = (total_size + MAX_MULTIPART_PARTS - 1) // MAX_MULTIPART_PARTS
    return max(requested_part_size, minimum_for_count, MIN_MULTIPART_PART_SIZE)


def _composite_checksum(part_checksums: list[str]) -> str:
    """Executa a etapa interna ``composite_checksum`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        part_checksums: Entrada ``part_checksums``; a forma aceita é definida pela anotação de
        tipo e validada antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        SnapshotUploadError: Se a operação não puder preservar as invariantes descritas.
    """
    if not part_checksums:
        raise SnapshotUploadError("multipart upload produced no parts")
    try:
        raw_parts = [base64.b64decode(value, validate=True) for value in part_checksums]
    except (TypeError, ValueError) as error:
        raise SnapshotUploadError("multipart part checksum is invalid") from error
    digest = base64.b64encode(hashlib.sha256(b"".join(raw_parts)).digest()).decode("ascii")
    return f"{digest}-{len(raw_parts)}"


def _owner_arguments(expected_bucket_owner: str) -> dict[str, str]:
    """Executa a etapa interna ``owner_arguments`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        expected_bucket_owner: Valor esperado usado para detectar concorrência ou divergência de
        estado.

    Returns:
        Valor ``dict[str, str]`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(expected_bucket_owner, str) or len(expected_bucket_owner) != 12:
        raise ValueError("expected_bucket_owner must be a 12 digit AWS account ID")
    if not expected_bucket_owner.isascii() or not expected_bucket_owner.isdigit():
        raise ValueError("expected_bucket_owner must be a 12 digit AWS account ID")
    return {"ExpectedBucketOwner": expected_bucket_owner}


def _require_versioned_bucket(
    client: S3SnapshotUploadClient, bucket: str, owner: dict[str, str]
) -> None:
    """Valida e devolve versioned bucket, rejeitando entradas fora do contrato.

    Args:
        client: Cliente externo que executa a operação de infraestrutura.
        bucket: Nome do bucket S3 autorizado para a operação.
        owner: Identidade do worker que possui ou solicita o lease.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        SnapshotUploadError: Se a operação não puder preservar as invariantes descritas.
    """
    response = client.get_bucket_versioning(Bucket=bucket, **owner)
    if response.get("Status") != "Enabled":
        raise SnapshotUploadError("snapshot bucket must have versioning enabled")


def _upload_multipart(
    client: S3SnapshotUploadClient,
    stream: BinaryIO,
    *,
    bucket: str,
    key: str,
    expected_sha256: str,
    expected_size: int,
    expected_bucket_owner: str,
    part_size: int,
    snapshot_extracted_on: date,
) -> SnapshotUploadResult:
    """Envia multipart e confirma a identidade do objeto persistido.

    Args:
        client: Cliente externo que executa a operação de infraestrutura.
        stream: Fluxo binário ou textual consumido incrementalmente.
        bucket: Nome do bucket S3 autorizado para a operação.
        key: Entrada ``key``; a forma aceita é definida pela anotação de tipo e validada antes
        do uso.
        expected_sha256: Valor esperado usado para detectar concorrência ou divergência de
        estado.
        expected_size: Valor esperado usado para detectar concorrência ou divergência de estado.
        expected_bucket_owner: Valor esperado usado para detectar concorrência ou divergência de
        estado.
        part_size: Entrada ``part_size``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        snapshot_extracted_on: Entrada ``snapshot_extracted_on``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.

    Returns:
        Valor ``SnapshotUploadResult`` produzido pela operação após as validações.

    Raises:
        SnapshotUploadError: Se a operação não puder preservar as invariantes descritas.
    """
    owner = _owner_arguments(expected_bucket_owner)
    _require_versioned_bucket(client, bucket, owner)
    upload_id: str | None = None
    try:
        created = client.create_multipart_upload(
            Bucket=bucket,
            Key=key,
            ChecksumAlgorithm="SHA256",
            ContentType="application/gzip",
            Metadata={"sha256": expected_sha256},
            **owner,
        )
        candidate_upload_id = created.get("UploadId")
        if not isinstance(candidate_upload_id, str) or not candidate_upload_id:
            raise SnapshotUploadError("S3 multipart creation returned no upload ID")
        upload_id = candidate_upload_id
        parts: list[dict[str, object]] = []
        part_checksums: list[str] = []
        streamed = hashlib.sha256()
        streamed_size = 0
        part_number = 1
        while content := stream.read(part_size):
            if not isinstance(content, bytes):
                raise SnapshotUploadError("snapshot stream did not return bytes")
            if part_number > MAX_MULTIPART_PARTS:
                raise SnapshotUploadError("snapshot exceeds the multipart part limit")
            checksum = base64.b64encode(hashlib.sha256(content).digest()).decode("ascii")
            uploaded = client.upload_part(
                Bucket=bucket,
                Key=key,
                UploadId=upload_id,
                PartNumber=part_number,
                Body=content,
                ChecksumSHA256=checksum,
                **owner,
            )
            returned_checksum = uploaded.get("ChecksumSHA256")
            etag = uploaded.get("ETag")
            if returned_checksum != checksum or not isinstance(etag, str) or not etag:
                raise SnapshotUploadError("S3 multipart part confirmation is invalid")
            parts.append({"ETag": etag, "PartNumber": part_number, "ChecksumSHA256": checksum})
            part_checksums.append(checksum)
            streamed.update(content)
            streamed_size += len(content)
            part_number += 1
        if streamed_size != expected_size or streamed.hexdigest() != expected_sha256:
            raise SnapshotUploadError("snapshot changed between validation and upload")
        composite = _composite_checksum(part_checksums)
        completed = client.complete_multipart_upload(
            Bucket=bucket,
            Key=key,
            UploadId=upload_id,
            MultipartUpload={"Parts": parts},
            ChecksumType="COMPOSITE",
            MpuObjectSize=expected_size,
            **owner,
        )
        candidate_version_id = completed.get("VersionId")
        if not isinstance(candidate_version_id, str) or not candidate_version_id:
            raise SnapshotUploadError("S3 multipart completion returned no version ID")
        upload_id = None
        head = client.head_object(
            Bucket=bucket,
            Key=key,
            VersionId=candidate_version_id,
            ChecksumMode="ENABLED",
            **owner,
        )
        metadata = head.get("Metadata")
        if not isinstance(metadata, Mapping):
            raise SnapshotUploadError("S3 uploaded object has no metadata")
        stored_hash = metadata.get("sha256")
        if (
            head.get("ContentLength") != expected_size
            or stored_hash != expected_sha256
            or head.get("ChecksumType") != "COMPOSITE"
            or head.get("ChecksumSHA256") != composite
        ):
            raise SnapshotUploadError("S3 uploaded object confirmation differs from local evidence")
        return SnapshotUploadResult(
            "1",
            bucket,
            key,
            candidate_version_id,
            expected_sha256,
            expected_size,
            snapshot_extracted_on,
        )
    except SnapshotUploadError:
        raise
    except Exception as error:
        raise SnapshotUploadError("S3 multipart upload failed") from error
    finally:
        if upload_id is not None:
            try:
                client.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id, **owner)
            except Exception:
                pass


def upload_snapshot(
    client: S3SnapshotUploadClient,
    snapshot_path: Path | str,
    *,
    bucket: str,
    expected_bucket_owner: str,
    snapshot_extracted_on: date,
    part_size: int = DEFAULT_PART_SIZE,
    limits: UploadLimits = DEFAULT_UPLOAD_LIMITS,
    staging_directory: Path | None = None,
) -> SnapshotUploadResult:
    """Envia snapshot e confirma a identidade do objeto persistido.

    Args:
        client: Cliente externo que executa a operação de infraestrutura.
        snapshot_path: Caminho local do recurso lido ou produzido pela operação.
        bucket: Nome do bucket S3 autorizado para a operação.
        expected_bucket_owner: Valor esperado usado para detectar concorrência ou divergência de
        estado.
        snapshot_extracted_on: Entrada ``snapshot_extracted_on``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
        part_size: Entrada ``part_size``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        limits: Entrada ``limits``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``SnapshotUploadResult`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        SnapshotUploadError: Se a operação não puder preservar as invariantes descritas.
    """

    if type(snapshot_extracted_on) is not date:
        raise TypeError("snapshot_extracted_on must be a date")
    path = Path(snapshot_path)
    if path.suffix not in {".zip", ".gz"} or (
        path.suffix == ".gz" and not path.name.endswith(".sql.gz")
    ):
        raise SnapshotUploadError("snapshot input must be a .sql.gz file or a .zip package")
    limits.validate()
    _require_regular_file(path, limits)
    temporary_path: str | None = None
    try:
        descriptor_fd, temporary_path = tempfile.mkstemp(
            prefix="argus-snapshot-",
            suffix=".sql.gz",
            dir=staging_directory,
        )
        with os.fdopen(descriptor_fd, "w+b") as staging:
            os.fchmod(staging.fileno(), 0o600)
            with path.open("rb") as descriptor:
                if path.suffix == ".zip":
                    try:
                        with zipfile.ZipFile(descriptor) as archive:
                            member = _safe_zip_member(archive, limits)
                            with archive.open(member, "r") as gzip_member:
                                digest, size = _copy_to_staging(
                                    cast(BinaryIO, gzip_member), staging, limits
                                )
                    except zipfile.BadZipFile as error:
                        raise SnapshotUploadError(
                            "snapshot package is not a valid ZIP file"
                        ) from error
                else:
                    digest, size = _copy_to_staging(descriptor, staging, limits)
            staging.flush()
            os.fsync(staging.fileno())
            staging.seek(0)
            staged_digest, staged_size = _validate_gzip(staging, limits)
            if staged_digest != digest or staged_size != size:
                raise SnapshotUploadError("staged snapshot differs from streamed local evidence")
            staging.seek(0)
            return _upload_multipart(
                client,
                staging,
                bucket=bucket,
                key=f"dumps/{digest}/{EXPECTED_MEMBER_NAME}",
                expected_sha256=digest,
                expected_size=size,
                expected_bucket_owner=expected_bucket_owner,
                part_size=_part_size_for(size, part_size),
                snapshot_extracted_on=snapshot_extracted_on,
            )
    except OSError as error:
        raise SnapshotUploadError("snapshot input could not be streamed") from error
    finally:
        if temporary_path is not None:
            try:
                os.unlink(temporary_path)
            except FileNotFoundError:
                pass


def _parse_arguments(argv: list[str]) -> argparse.Namespace:
    """Converte argumentos para a representação interna validada.

    Args:
        argv: Argumentos da linha de comando; ``None`` utiliza ``sys.argv``.

    Returns:
        Valor ``argparse.Namespace`` produzido pela operação após as validações.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--account-id", required=True, dest="account_id")
    parser.add_argument("--region", required=True)
    parser.add_argument(
        "--snapshot-extracted-on",
        required=True,
        type=parse_snapshot_extracted_on,
        dest="snapshot_extracted_on",
    )
    parser.add_argument("--output", type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Executa o ponto de entrada de linha de comando e devolve seu código de saída.

    Args:
        argv: Argumentos da linha de comando; ``None`` utiliza ``sys.argv``.

    Returns:
        Valor ``int`` produzido pela operação após as validações.

    Raises:
        SnapshotUploadError: Se a operação não puder preservar as invariantes descritas.
    """
    arguments = _parse_arguments(sys.argv[1:] if argv is None else argv)
    if any(name.startswith("AWS_ENDPOINT_URL") for name in os.environ):
        raise SnapshotUploadError("AWS endpoint overrides are not allowed")
    import boto3  # type: ignore[import-untyped]

    result = upload_snapshot(
        boto3.client("s3", region_name=arguments.region),
        arguments.snapshot,
        bucket=arguments.bucket,
        expected_bucket_owner=arguments.account_id,
        snapshot_extracted_on=arguments.snapshot_extracted_on,
    )
    payload = json.dumps(result.to_public_dict(), sort_keys=True) + "\n"
    if arguments.output is None:
        sys.stdout.write(payload)
    else:
        temporary = arguments.output.with_name(f".{arguments.output.name}.tmp")
        temporary.write_text(payload, encoding="utf-8")
        os.replace(temporary, arguments.output)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SnapshotUploadError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
