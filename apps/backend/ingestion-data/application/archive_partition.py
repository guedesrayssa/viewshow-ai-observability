"""Publica uma partição histórica e preserva evidências de cada efeito externo.

O módulo transforma registros canônicos em uma partição codificada e conduz sua publicação pela
sequência ``STAGING -> UPLOADED -> CATALOGED -> VALIDATED -> AVAILABLE``. O objeto é primeiro
enviado para uma chave temporária, promovido para a chave imutável, registrado no Glue e contado
novamente pelo Athena. Somente uma reconciliação aprovada permite tornar a partição disponível.

Os repositórios e serviços externos são acessados por portas. Chaves de idempotência e a
comparação das evidências persistidas permitem repetir a operação depois de uma interrupção sem
substituir um objeto divergente. A expiração dos itens quentes é autorizada separadamente, apenas
quando a partição correspondente já está ``AVAILABLE``.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import cast

from domain.archive import (
    canonical_archive_key,
    canonical_staging_archive_key,
    legacy_canonical_archive_key,
    staging_archive_key,
    validate_archive_partition,
)
from domain.datasets import DatasetDescriptor
from domain.disk_budget import DiskBudget
from domain.models import CanonicalRecord
from ports import (
    ArchiveObject,
    ArchiveObjectStore,
    ArchivePartition,
    ArchivePartitionRepository,
    ArchiveReconciliationError,
    ArchiveState,
    AthenaValidator,
    EncodedPartition,
    GlueCatalog,
    HotExpirationRepository,
    ParquetEncoder,
    ReconciliationCounts,
)


def archive_partition_key(
    record: CanonicalRecord, descriptor: DatasetDescriptor, *, snapshot_date: date
) -> str:
    """Escolhe a chave de partição histórica definida pelo descritor do dataset.

    Datasets de snapshot usam a data lógica da extração; datasets temporais usam a data UTC do
    registro. O retorno é apenas o segmento de partição, não a chave completa do S3.

    Args:
        record: Registro canônico consumido pela operação.
        descriptor: Descritor físico e semântico do dataset processado.
        snapshot_date: Data civil usada para particionamento ou proveniência.

    Returns:
        Segmento ``snapshot_date=...`` ou ``year=.../month=.../day=...``.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
    """
    if record.source_dataset != descriptor.table:
        raise ValueError("record source_dataset differs from descriptor table")
    if isinstance(snapshot_date, datetime) or not isinstance(snapshot_date, date):
        raise TypeError("snapshot_date must be a date")
    if descriptor.archive_partition["strategy"] == "snapshot_date":
        return f"snapshot_date={snapshot_date.isoformat()}"
    observed_at = record.observed_at
    if observed_at is None:
        raise ValueError("event_time archive partitions require observed_at")
    return f"year={observed_at:%Y}/month={observed_at:%m}/day={observed_at:%d}"


@dataclass(frozen=True, slots=True)
class ArchivePartitionEncoder:
    """Adapta a porta de Parquet para a etapa de arquivamento da aplicação.

    O encoder recebe a versão e as proteções de idempotência necessárias para produzir um
    arquivo determinístico acompanhado de checksum, tamanho e contagem de linhas.

    Attributes:
        encoder: Porta que serializa os registros no esquema físico contratado.
    """

    encoder: ParquetEncoder

    def encode(
        self,
        records: Iterable[CanonicalRecord],
        descriptor: DatasetDescriptor,
        path: Path,
        *,
        dataset_version: str,
        expected_absent: bool = True,
        idempotency_key: str,
        disk_budget: DiskBudget | None = None,
    ) -> EncodedPartition:
        """Codifica os registros no formato exigido pela porta de destino.

        Args:
            records: Registros canônicos consumidos pela operação.
            descriptor: Descritor físico e semântico do dataset processado.
            path: Caminho local do artefato lido ou produzido.
            dataset_version: Identificador imutável da versão do dataset.
            expected_absent: Indica se a operação exige que o recurso ainda não exista.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.
            disk_budget: Orçamento opcional que reserva espaço antes da escrita.

        Returns:
            Evidências do arquivo criado, incluindo checksum, tamanho e quantidade de linhas.
        """
        return self.encoder.write_partition(
            records,
            descriptor,
            path,
            dataset_version=dataset_version,
            expected_absent=expected_absent,
            idempotency_key=idempotency_key,
            disk_budget=disk_budget,
        )


class ArchivePublicationError(RuntimeError):
    """Indica que ``ArchivePublicationError`` impediu a operação de continuar com segurança."""


_STATE_ORDER = {
    ArchiveState.STAGING: 0,
    ArchiveState.UPLOADED: 1,
    ArchiveState.CATALOGED: 2,
    ArchiveState.VALIDATED: 3,
    ArchiveState.AVAILABLE: 4,
}


@dataclass(frozen=True, slots=True)
class ArchivePartitionPublisher:
    """Conduz uma partição codificada até o estado histórico ``AVAILABLE``.

    Cada transição só ocorre depois que o efeito anterior foi confirmado. Ao retomar, a classe
    compara os metadados imutáveis já persistidos e continua do estado alcançado, recusando
    partições incompatíveis ou marcadas como ``FAILED``.

    Attributes:
        object_store: Porta do armazenamento externo consultado ou atualizado.
        glue_catalog: Entrada ``glue_catalog``; a forma aceita é definida pela anotação de tipo
        e validada antes do uso.
        athena: Entrada ``athena``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        partitions: Entrada ``partitions``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        expiration: Entrada ``expiration``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.
        bucket: Nome do bucket S3 autorizado para a operação.
        clock: Função injetável que fornece o instante atual para validação e testes.
        schema_fingerprint: Entrada ``schema_fingerprint``; a forma aceita é definida pela
        anotação de tipo e validada antes do uso.
    """

    object_store: ArchiveObjectStore
    glue_catalog: GlueCatalog
    athena: AthenaValidator
    partitions: ArchivePartitionRepository
    expiration: HotExpirationRepository
    bucket: str
    clock: Callable[[], datetime]
    schema_fingerprint: Callable[[DatasetDescriptor], str]

    def __post_init__(self) -> None:
        """Valida e normaliza os atributos após a criação da instância imutável.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ValueError: Se um valor estiver fora das invariantes aceitas.
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        if not isinstance(self.bucket, str) or not self.bucket or "/" in self.bucket:
            raise ValueError("bucket must be a non-empty S3 bucket name")
        if not callable(self.clock):
            raise TypeError("clock must be callable")
        if not callable(self.schema_fingerprint):
            raise TypeError("schema_fingerprint must be callable")

    @staticmethod
    def _key(root: str, suffix: str) -> str:
        """Deriva uma chave de idempotência específica a partir da chave raiz.

        Args:
            root: Entrada ``root``; a forma aceita é definida pela anotação de tipo e validada
            antes do uso.
            suffix: Entrada ``suffix``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``str`` produzido pela operação após as validações.
        """
        return f"{root}-{suffix}"

    @staticmethod
    def _current(
        repository: ArchivePartitionRepository, requested: ArchivePartition
    ) -> ArchivePartition | None:
        """Obtém a única partição persistida que corresponde à identidade solicitada.

        Args:
            repository: Porta de persistência usada pelo caso de uso.
            requested: Entrada ``requested``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Valor ``ArchivePartition | None`` produzido pela operação após as validações.

        Raises:
            ArchivePublicationError: Se a operação não puder preservar as invariantes descritas.
        """
        return repository.get(
            requested.dataset_version,
            requested.dataset,
            requested.partition,
        )

    @staticmethod
    def _require_compatible(current: ArchivePartition, requested: ArchivePartition) -> None:
        """Valida e devolve compatible, rejeitando entradas fora do contrato.

        Args:
            current: Entrada ``current``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            requested: Entrada ``requested``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            ArchivePublicationError: Se a operação não puder preservar as invariantes descritas.
        """
        canonical_v2 = "aggregateDigest" in requested.metadata
        if canonical_v2 != ("aggregateDigest" in current.metadata):
            raise ArchivePublicationError(
                "persisted archive partition differs from publication input"
            )
        immutable = (
            {
                "interval",
                "counts",
                "objects",
                "aggregateDigest",
                "catalogGeneration",
            }
            if canonical_v2
            else {
                "interval",
                "counts",
                "s3Uri",
                "sha256",
                "hotItemCount",
                "projectionItemCount",
                "catalogGeneration",
            }
        )
        if any(current.metadata.get(name) != requested.metadata.get(name) for name in immutable):
            raise ArchivePublicationError(
                "persisted archive partition differs from publication input"
            )
        if canonical_v2:
            catalog_digest = current.metadata.get("catalogDigest")
            aggregate_digest = requested.metadata.get("aggregateDigest")
            if catalog_digest is not None and catalog_digest != aggregate_digest:
                raise ArchivePublicationError(
                    "persisted archive catalogDigest differs from aggregateDigest"
                )
        if current.state is ArchiveState.FAILED:
            raise ArchivePublicationError("FAILED archive partition cannot be republished")

    def _advance(
        self,
        current: ArchivePartition,
        target: ArchiveState,
        *,
        idempotency_key: str,
    ) -> ArchivePartition:
        """Avança a entrada somente a partir do estado previamente observado.

        Args:
            current: Entrada ``current``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            target: Estado ou destino solicitado para a operação.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Partição persistida em ``AVAILABLE`` com reconciliação aprovada.
        """
        if current.state is target or _STATE_ORDER[current.state] > _STATE_ORDER[target]:
            return current
        return self.partitions.update_state(
            current.dataset_version,
            current.dataset,
            current.partition,
            target,
            expected_state=current.state,
            idempotency_key=idempotency_key,
        )

    @staticmethod
    def _ttl_epoch_s(archive: ArchivePartition, descriptor: DatasetDescriptor) -> int:
        """Executa a etapa interna ``ttl_epoch_s`` e devolve o resultado validado indicado pela
        assinatura.

        Args:
            archive: Partição histórica cuja evidência será consultada ou atualizada.
            descriptor: Descritor físico e semântico do dataset processado.

        Returns:
            Valor ``int`` produzido pela operação após as validações.

        Raises:
            ArchivePublicationError: Se a operação não puder preservar as invariantes descritas.
        """
        if archive.dataset != descriptor.table:
            raise ArchivePublicationError("archive dataset differs from descriptor")
        if archive.state is not ArchiveState.AVAILABLE:
            raise ArchivePublicationError("TTL authorization requires an AVAILABLE archive")
        hot_days = descriptor.retention["hotDays"]
        if isinstance(hot_days, bool) or not isinstance(hot_days, int) or hot_days <= 0:
            raise ArchivePublicationError("dataset hot retention must be a positive integer")
        interval = archive.metadata.get("interval")
        end_text = interval.get("end") if isinstance(interval, Mapping) else None
        if not isinstance(end_text, str):
            raise ArchivePublicationError("archive interval is invalid")
        try:
            end = datetime.fromisoformat(end_text.replace("Z", "+00:00"))
        except ValueError as error:
            raise ArchivePublicationError("archive interval is invalid") from error
        if end.tzinfo is None or end.utcoffset() != UTC.utcoffset(None):
            raise ArchivePublicationError("archive interval must end in UTC")
        return int((end + timedelta(days=hot_days)).timestamp())

    def authorize_expiration(
        self,
        descriptor: DatasetDescriptor,
        archive: ArchivePartition,
        *,
        idempotency_key: str,
    ) -> int:
        """Autoriza expiração somente após validar as evidências exigidas.

        Args:
            descriptor: Descritor físico e semântico do dataset processado.
            archive: Partição histórica cuja evidência será consultada ou atualizada.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Valor ``int`` produzido pela operação após as validações.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ValueError: Se um valor estiver fora das invariantes aceitas.
        """
        if not isinstance(descriptor, DatasetDescriptor):
            raise TypeError("descriptor must be a DatasetDescriptor")
        if not isinstance(archive, ArchivePartition):
            raise TypeError("archive must be an ArchivePartition")
        if not isinstance(idempotency_key, str) or not idempotency_key:
            raise ValueError("idempotency_key must be a non-empty string")
        return self.expiration.authorize_expiration(
            archive.dataset_version,
            archive.dataset,
            archive.partition,
            self._ttl_epoch_s(archive, descriptor),
            expected_archive_state=ArchiveState.AVAILABLE,
            idempotency_key=idempotency_key,
        )

    def _preflight_canonical(
        self,
        descriptor: DatasetDescriptor,
        archive: ArchivePartition,
    ) -> tuple[
        ArchivePartition | None,
        str,
        tuple[Mapping[str, object], ...],
        Mapping[str, object],
        tuple[ArchiveObject, ...],
    ]:
        """Validate immutable evidence and reconcile an existing AVAILABLE partition."""

        if not isinstance(descriptor, DatasetDescriptor):
            raise TypeError("descriptor must be a DatasetDescriptor")
        if not isinstance(archive, ArchivePartition):
            raise TypeError("archive must be an ArchivePartition")
        if archive.state is not ArchiveState.STAGING:
            raise ArchivePublicationError("publication input must begin in STAGING")
        if archive.dataset != descriptor.table:
            raise ArchivePublicationError("archive dataset differs from descriptor")
        validate_archive_partition(archive)
        aggregate_digest = archive.metadata.get("aggregateDigest")
        raw_objects = archive.metadata.get("objects")
        counts = archive.metadata.get("counts")
        if not isinstance(aggregate_digest, str) or not isinstance(raw_objects, Sequence):
            raise ArchivePublicationError("canonical archive evidence is invalid")
        if not isinstance(counts, Mapping):
            raise ArchivePublicationError("canonical archive counts are invalid")
        objects = tuple(cast(Mapping[str, object], item) for item in raw_objects)
        if not objects:
            raise ArchivePublicationError(
                "canonical archive partition must contain at least one object"
            )
        expected_final: list[ArchiveObject] = []
        for ordinal, evidence in enumerate(objects):
            sha256 = evidence.get("sha256")
            byte_count = evidence.get("byteCount")
            object_key = evidence.get("objectKey")
            if not isinstance(sha256, str) or not isinstance(byte_count, int):
                raise ArchivePublicationError("canonical archive object evidence is invalid")
            expected_key = canonical_archive_key(
                archive.dataset_version,
                archive.dataset,
                archive.partition,
                sha256,
                aggregate_digest=aggregate_digest,
                ordinal=ordinal,
            )
            if object_key != expected_key:
                raise ArchivePublicationError("canonical object key differs from archive evidence")
            expected_final.append(ArchiveObject(expected_key, sha256, byte_count))
        if sum(cast(int, item["rowCount"]) for item in objects) != counts.get("persisted"):
            raise ArchivePublicationError("canonical object rows differ from archive counts")

        current = self._current(self.partitions, archive)
        if current is not None:
            self._require_compatible(current, archive)
        if current is not None and current.state is ArchiveState.AVAILABLE:
            if current.metadata.get("catalogDigest") != aggregate_digest:
                raise ArchivePublicationError(
                    "AVAILABLE archive catalogDigest differs from aggregateDigest"
                )
            for expected in expected_final:
                actual = self.object_store.head(expected.key)
                if actual is None or (actual.sha256, actual.size) != (
                    expected.sha256,
                    expected.size,
                ):
                    raise ArchivePublicationError(
                        "available canonical object HEAD differs from persisted evidence"
                    )
        return current, aggregate_digest, objects, counts, tuple(expected_final)

    def preflight_canonical(
        self,
        descriptor: DatasetDescriptor,
        archive: ArchivePartition,
    ) -> ArchivePartition | None:
        """Check persisted canonical evidence without producing any external write."""

        return self._preflight_canonical(descriptor, archive)[0]

    def preflight_existing_canonical(
        self,
        dataset_version: str,
        dataset: str,
        partition: str,
    ) -> ArchivePartition | None:
        """Reject self-inconsistent persisted v2 evidence before staging new objects."""

        current = self.partitions.get(dataset_version, dataset, partition)
        if current is None:
            return None
        try:
            validate_archive_partition(current)
        except (TypeError, ValueError) as error:
            raise ArchivePublicationError(
                "persisted canonical partition evidence is invalid"
            ) from error
        aggregate_digest = current.metadata.get("aggregateDigest")
        if (
            not isinstance(aggregate_digest, str)
            or current.metadata.get("catalogGeneration") != 1
            or (
                current.state is ArchiveState.AVAILABLE
                and current.metadata.get("catalogDigest") != aggregate_digest
            )
        ):
            raise ArchivePublicationError(
                "persisted canonical partition catalog evidence is inconsistent"
            )
        return current

    def publish_canonical(
        self,
        staged_objects: Sequence[ArchiveObject],
        descriptor: DatasetDescriptor,
        archive: ArchivePartition,
        *,
        idempotency_key: str,
    ) -> ArchivePartition:
        """Publish one logical canonical-v2 partition from pre-staged immutable objects."""

        if not isinstance(staged_objects, Sequence) or isinstance(staged_objects, str | bytes):
            raise TypeError("staged_objects must be a sequence")
        if any(not isinstance(item, ArchiveObject) for item in staged_objects):
            raise TypeError("staged_objects must contain ArchiveObject values")
        if not isinstance(idempotency_key, str) or not idempotency_key:
            raise ValueError("idempotency_key must be a non-empty string")
        current, aggregate_digest, objects, counts, expected_final = self._preflight_canonical(
            descriptor, archive
        )
        if current is not None and current.state is ArchiveState.AVAILABLE:
            return current
        if len(objects) != len(staged_objects):
            raise ArchivePublicationError("staged object count differs from archive evidence")
        for ordinal, (staged, evidence) in enumerate(zip(staged_objects, objects, strict=True)):
            sha256 = cast(str, evidence["sha256"])
            expected_staging_key = canonical_staging_archive_key(
                archive.dataset_version,
                archive.dataset,
                archive.partition,
                sha256,
                ordinal=ordinal,
            )
            expected = expected_final[ordinal]
            if (
                staged.key != expected_staging_key
                or staged.sha256 != expected.sha256
                or staged.size != expected.size
            ):
                raise ArchivePublicationError(
                    "staged object differs from canonical archive evidence"
                )
        if current is None:
            self.partitions.put(
                archive,
                expected_absent=True,
                idempotency_key=self._key(idempotency_key, "partition"),
            )
            current = archive

        if _STATE_ORDER[current.state] < _STATE_ORDER[ArchiveState.UPLOADED]:
            for ordinal, (staged, expected) in enumerate(
                zip(staged_objects, expected_final, strict=True)
            ):
                promoted = self.object_store.promote(
                    staged,
                    expected.key,
                    expected_absent=True,
                    idempotency_key=self._key(idempotency_key, f"promote-{ordinal:05d}"),
                )
                if (promoted.key, promoted.sha256, promoted.size) != (
                    expected.key,
                    expected.sha256,
                    expected.size,
                ):
                    raise ArchivePublicationError("canonical object differs from staged evidence")
            current = self._advance(
                current,
                ArchiveState.UPLOADED,
                idempotency_key=self._key(idempotency_key, "uploaded"),
            )
        for expected in expected_final:
            actual = self.object_store.head(expected.key)
            if actual is None or (actual.sha256, actual.size) != (
                expected.sha256,
                expected.size,
            ):
                raise ArchivePublicationError("canonical object HEAD differs after promotion")

        if _STATE_ORDER[current.state] < _STATE_ORDER[ArchiveState.CATALOGED]:
            table_root = f"s3://{self.bucket}/canonical/schema_version=1.0/"
            generation_location = f"s3://{self.bucket}/{expected_final[0].key.rsplit('/', 1)[0]}/"
            self.glue_catalog.ensure_table(
                descriptor,
                table_root,
                idempotency_key=self._key(idempotency_key, "glue-table"),
            )
            self.glue_catalog.register_partition(
                descriptor,
                archive.dataset_version,
                archive.partition,
                generation_location,
                aggregate_digest=aggregate_digest,
                expected_absent=True,
                idempotency_key=self._key(idempotency_key, "glue-partition"),
            )
            current = self._advance(
                current,
                ArchiveState.CATALOGED,
                idempotency_key=self._key(idempotency_key, "cataloged"),
            )

        expected_rows = cast(int, counts["persisted"])
        if _STATE_ORDER[current.state] < _STATE_ORDER[ArchiveState.VALIDATED]:
            observed_rows = self.athena.validate_partition(
                descriptor.table,
                archive.dataset_version,
                archive.partition,
                expected_rows,
                aggregate_digest=aggregate_digest,
            )
            if observed_rows != expected_rows:
                raise ArchiveReconciliationError(
                    f"Athena returned {observed_rows} rows; expected {expected_rows}"
                )
            current = self._advance(
                current,
                ArchiveState.VALIDATED,
                idempotency_key=self._key(idempotency_key, "validated"),
            )

        reconciliation = current.metadata.get("reconciliation")
        if not isinstance(reconciliation, Mapping):
            raise ArchivePublicationError("archive reconciliation evidence is invalid")
        if reconciliation.get("state") != "PASSED":
            reconciled_at = self.clock()
            if (
                not isinstance(reconciled_at, datetime)
                or reconciled_at.tzinfo is None
                or reconciled_at.utcoffset() != UTC.utcoffset(None)
            ):
                raise ArchivePublicationError("clock must return an aware UTC datetime")
            current = self.partitions.record_reconciliation(
                archive.dataset_version,
                archive.dataset,
                archive.partition,
                observed_counts=cast(ReconciliationCounts, dict(counts)),
                reconciled_at=reconciled_at,
                expected_state=ArchiveState.VALIDATED,
                idempotency_key=self._key(idempotency_key, "reconciled"),
            )
        current = self._advance(
            current,
            ArchiveState.AVAILABLE,
            idempotency_key=self._key(idempotency_key, "available"),
        )
        if current.state is not ArchiveState.AVAILABLE:
            raise ArchivePublicationError("archive repository did not persist AVAILABLE")
        return current

    def publish(
        self,
        encoded: EncodedPartition,
        descriptor: DatasetDescriptor,
        archive: ArchivePartition,
        *,
        run_id: str,
        idempotency_key: str,
    ) -> ArchivePartition:
        """Publica uma partição codificada percorrendo, em ordem, todo o ciclo histórico.

        A operação grava em staging, promove o objeto canônico, registra a partição no Glue,
        reconcilia a contagem pelo Athena e só então marca a partição como disponível. Estados
        já concluídos são reutilizados para permitir retomada idempotente.

        Args:
            encoded: Arquivo Parquet e evidências de checksum, tamanho e contagem.
            descriptor: Descritor físico e semântico do dataset processado.
            archive: Partição histórica cuja evidência será consultada ou atualizada.
            run_id: Identificador não secreto e estável da execução.
            idempotency_key: Chave estável que identifica uma repetição da mesma operação.

        Returns:
            Partição persistida em ``AVAILABLE`` com reconciliação aprovada.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
            ArchivePublicationError: Se a operação não puder preservar as invariantes descritas.
            ValueError: Se um valor estiver fora das invariantes aceitas.
            ArchiveReconciliationError: Se a operação não puder preservar as invariantes
            descritas.
        """
        if not isinstance(encoded, EncodedPartition):
            raise TypeError("encoded must be an EncodedPartition")
        if not isinstance(descriptor, DatasetDescriptor):
            raise TypeError("descriptor must be a DatasetDescriptor")
        if not isinstance(archive, ArchivePartition):
            raise TypeError("archive must be an ArchivePartition")
        if archive.state is not ArchiveState.STAGING:
            raise ArchivePublicationError("publication input must begin in STAGING")
        if not isinstance(idempotency_key, str) or not idempotency_key:
            raise ValueError("idempotency_key must be a non-empty string")
        if archive.dataset != descriptor.table:
            raise ArchivePublicationError("archive dataset differs from descriptor")
        expected_schema_fingerprint = self.schema_fingerprint(descriptor)
        if (
            encoded.dataset != descriptor.table
            or encoded.dataset != archive.dataset
            or encoded.dataset_version != archive.dataset_version
            or encoded.schema_version != "1.0"
            or encoded.schema_fingerprint != expected_schema_fingerprint
        ):
            raise ArchivePublicationError(
                "encoded partition identity differs from descriptor or archive"
            )
        counts = archive.metadata.get("counts")
        if (
            not isinstance(counts, Mapping)
            or counts.get("persisted") != encoded.row_count
            or archive.metadata.get("sha256") != encoded.sha256
        ):
            raise ArchivePublicationError("encoded evidence differs from archive metadata")
        validate_archive_partition(archive)

        canonical_key = legacy_canonical_archive_key(
            archive.dataset_version,
            archive.dataset,
            archive.partition,
            encoded.sha256,
        )
        expected_uri = f"s3://{self.bucket}/{canonical_key}"
        if archive.metadata.get("s3Uri") != expected_uri:
            raise ArchivePublicationError("archive s3Uri differs from the canonical object key")
        staged_key = staging_archive_key(
            run_id,
            archive.dataset,
            archive.partition,
            encoded.sha256,
        )

        current = self._current(self.partitions, archive)
        if current is None:
            self.partitions.put(
                archive,
                expected_absent=True,
                idempotency_key=self._key(idempotency_key, "partition"),
            )
            current = archive
        else:
            self._require_compatible(current, archive)

        staged = self.object_store.stage(
            encoded,
            staged_key,
            expected_absent=True,
            idempotency_key=self._key(idempotency_key, "stage"),
        )
        if self.object_store.head(staged_key) != staged:
            raise ArchivePublicationError("staged object HEAD differs after upload")
        canonical = self.object_store.promote(
            staged,
            canonical_key,
            expected_absent=True,
            idempotency_key=self._key(idempotency_key, "promote"),
        )
        if canonical.sha256 != encoded.sha256 or canonical.size != encoded.byte_size:
            raise ArchivePublicationError("canonical object differs from encoded evidence")
        current = self._advance(
            current,
            ArchiveState.UPLOADED,
            idempotency_key=self._key(idempotency_key, "uploaded"),
        )

        table_root = f"s3://{self.bucket}/canonical/schema_version=1.0/"
        partition_location = f"s3://{self.bucket}/{canonical_key.rsplit('/', 1)[0]}/"
        self.glue_catalog.ensure_table(
            descriptor,
            table_root,
            idempotency_key=self._key(idempotency_key, "glue-table"),
        )
        self.glue_catalog.register_legacy_partition(
            descriptor,
            archive.dataset_version,
            archive.partition,
            partition_location,
            expected_absent=True,
            idempotency_key=self._key(idempotency_key, "glue-partition"),
        )
        current = self._advance(
            current,
            ArchiveState.CATALOGED,
            idempotency_key=self._key(idempotency_key, "cataloged"),
        )

        observed_row_count = self.athena.validate_legacy_partition(
            descriptor.table,
            archive.dataset_version,
            archive.partition,
            encoded.row_count,
        )
        if observed_row_count != encoded.row_count:
            raise ArchiveReconciliationError(
                f"Athena returned {observed_row_count} rows; expected {encoded.row_count}"
            )
        current = self._advance(
            current,
            ArchiveState.VALIDATED,
            idempotency_key=self._key(idempotency_key, "validated"),
        )
        reconciliation = current.metadata.get("reconciliation")
        if not isinstance(reconciliation, Mapping):
            raise ArchivePublicationError("archive reconciliation evidence is invalid")
        if reconciliation.get("state") != "PASSED":
            observed = cast(ReconciliationCounts, dict(cast(Mapping[str, int], counts)))
            reconciled_at = self.clock()
            if (
                not isinstance(reconciled_at, datetime)
                or reconciled_at.tzinfo is None
                or reconciled_at.utcoffset() != UTC.utcoffset(None)
            ):
                raise ArchivePublicationError("clock must return an aware UTC datetime")
            current = self.partitions.record_reconciliation(
                archive.dataset_version,
                archive.dataset,
                archive.partition,
                observed_counts=observed,
                reconciled_at=reconciled_at,
                expected_state=ArchiveState.VALIDATED,
                idempotency_key=self._key(idempotency_key, "reconciled"),
            )
        current = self._advance(
            current,
            ArchiveState.AVAILABLE,
            idempotency_key=self._key(idempotency_key, "available"),
        )
        if current.state is not ArchiveState.AVAILABLE:
            raise ArchivePublicationError("archive repository did not persist AVAILABLE")
        return current


__all__ = [
    "ArchivePartitionEncoder",
    "ArchivePartitionPublisher",
    "ArchivePublicationError",
    "archive_partition_key",
]
