"""Define chaves, manifestos e transições válidas do ciclo de vida histórico.

Papel no fluxo:
    Este arquivo pertence ao núcleo de domínio e deve permanecer determinístico, sem acesso a
    rede, sistema de arquivos, banco de dados ou variáveis de ambiente.

Garantias e limites:
    As validações falham de forma fechada: valores ambíguos ou incompletos são rejeitados antes
    de atravessar uma porta de persistência.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from datetime import UTC, date, datetime, timedelta
from typing import cast
from urllib.parse import quote

from domain.run import RunPipeline
from domain.snapshot_provenance import parse_snapshot_extracted_on

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_COMPONENT = re.compile(r"^[^#\s]+$")
_CALENDAR_PARTITION = re.compile(r"^(?P<year>[0-9]{4})-(?P<month>[0-9]{2})-(?P<day>[0-9]{2})$")
_TEMPORAL_PARTITION = re.compile(
    r"^year=(?P<year>[0-9]{4})/month=(?P<month>[0-9]{2})/day=(?P<day>[0-9]{2})$"
)
_SNAPSHOT_PARTITION = re.compile(
    r"^snapshot_date=(?P<year>[0-9]{4})-(?P<month>[0-9]{2})-(?P<day>[0-9]{2})$"
)
_MANIFEST_FIELDS = frozenset(
    {
        "physicalContractVersion",
        "canonicalSchemaVersion",
        "dumpChecksumSha256",
        "snapshotExtractedOn",
        "availableIntervals",
        "hotFrom",
        "watermarks",
        "s3Prefix",
        "glueTables",
        "descriptorVersions",
        "formulaVersions",
        "projectionVersions",
        "coverage",
        "qualityFlags",
        "validations",
    }
)
_HOT_MATERIALIZATION_FIELDS = frozenset({"hotMaterialization", "hotItemCount"})
_CANONICAL_MARKER_FIELDS = frozenset({"canonicalMarker"})
_CANONICAL_MARKER_VALUE_FIELDS = frozenset(
    {
        "schemaVersion",
        "objectKey",
        "aggregateDigest",
        "documentSha256",
        "datasetCount",
        "partitionCount",
        "objectCount",
        "totalSourceRows",
        "totalAcceptedRows",
        "totalRejectedRows",
    }
)
_ARCHIVE_V1_FIELDS = frozenset(
    {
        "interval",
        "counts",
        "s3Uri",
        "sha256",
        "reconciliation",
        "expirationEligible",
        "hotItemCount",
        "projectionItemCount",
        "catalogGeneration",
        "catalogDigest",
    }
)
_ARCHIVE_V2_FIELDS = frozenset(
    {
        "interval",
        "counts",
        "objects",
        "aggregateDigest",
        "reconciliation",
        "expirationEligible",
        "hotItemCount",
        "catalogGeneration",
        "catalogDigest",
    }
)
_ARCHIVE_OBJECT_FIELDS = frozenset({"objectKey", "rowCount", "byteCount", "sha256"})
_MAX_CANONICAL_OBJECT_BYTES = 512 * 1024 * 1024


class ArchiveDomainError(ValueError):
    """Indica que ``ArchiveDomainError`` impediu a operação de continuar com segurança."""


class InvalidArchiveTransition(ArchiveDomainError):
    """Indica que ``InvalidArchiveTransition`` impediu a operação de continuar com segurança."""


class ArchiveNotAvailable(RuntimeError):
    """Indica que ``ArchiveNotAvailable`` impediu a operação de continuar com segurança."""


# A importação vem após as exceções de domínio para que ports.errors possa especializar com
# segurança a exceção pública de fronteira enquanto o pacote ports é inicializado.
from ports.models import ArchivePartition, ArchiveState, CandidateManifest  # noqa: E402

_NEXT_STATES: Mapping[ArchiveState, frozenset[ArchiveState]] = {
    ArchiveState.STAGING: frozenset({ArchiveState.UPLOADED, ArchiveState.FAILED}),
    ArchiveState.UPLOADED: frozenset({ArchiveState.CATALOGED, ArchiveState.FAILED}),
    ArchiveState.CATALOGED: frozenset({ArchiveState.VALIDATED, ArchiveState.FAILED}),
    ArchiveState.VALIDATED: frozenset({ArchiveState.AVAILABLE, ArchiveState.FAILED}),
    ArchiveState.AVAILABLE: frozenset(),
    ArchiveState.FAILED: frozenset(),
}


def require_key_component(value: object, field: str) -> str:
    """Valida e devolve chave component, rejeitando entradas fora do contrato.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    if not value:
        raise ValueError(f"{field} must not be empty")
    if _COMPONENT.fullmatch(value) is None:
        raise ValueError(f"{field} must not contain key delimiters or whitespace")
    if len(value.encode("utf-8")) > 512:
        raise ValueError(f"{field} exceeds the internal 512-byte limit")
    return value


def partition_date(partition: object) -> date:
    """Obtém a data de partição após validar o calendário e o formato.

    Args:
        partition: Identificador canônico da partição física ou lógica.

    Returns:
        Valor ``date`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(partition, str):
        raise TypeError("partition must be a string")
    matched = (
        _CALENDAR_PARTITION.fullmatch(partition)
        or _TEMPORAL_PARTITION.fullmatch(partition)
        or _SNAPSHOT_PARTITION.fullmatch(partition)
    )
    if matched is None:
        raise ValueError(
            "partition must use YYYY-MM-DD, year=YYYY/month=MM/day=DD, or snapshot_date=YYYY-MM-DD"
        )
    try:
        return date(
            int(matched.group("year")),
            int(matched.group("month")),
            int(matched.group("day")),
        )
    except ValueError as error:
        raise ValueError("partition contains an invalid calendar date") from error


def _archive_key_component(value: object, field: str) -> str:
    """Executa a etapa interna ``archive_key_component`` e devolve o resultado validado indicado
    pela assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    component = require_key_component(value, field)
    if "/" in component or component in {".", ".."}:
        raise ValueError(f"{field} must be a safe path component")
    return quote(component, safe="-_.~")


def _archive_sha256(value: object) -> str:
    """Executa a etapa interna ``archive_sha256`` e devolve o resultado validado indicado pela
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


def staging_archive_key(run_id: str, dataset: str, partition: str, sha256: str) -> str:
    """Monta a chave de staging arquivo histórico a partir de componentes validados.

    Args:
        run_id: Identificador não secreto e estável da execução.
        dataset: Nome do dataset permitido pelo registro de contratos.
        partition: Identificador canônico da partição física ou lógica.
        sha256: Entrada ``sha256``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.

    Returns:
        Valor ``str`` produzido pela operação após as validações.
    """
    day = partition_date(partition).isoformat()
    return (
        f"staging/run_id={_archive_key_component(run_id, 'run_id component')}/"
        f"dataset={_archive_key_component(dataset, 'dataset component')}/date={day}/"
        f"{_archive_sha256(sha256)}.parquet"
    )


def canonical_staging_archive_key(
    dataset_version: str,
    dataset: str,
    partition: str,
    sha256: str,
    *,
    ordinal: int,
) -> str:
    """Produce the deterministic, run-independent staging key for canonical-v2."""

    partition_date(partition)
    if not (partition.startswith("year=") or partition.startswith("snapshot_date=")):
        raise ValueError("partition must use the canonical archive layout")
    if isinstance(ordinal, bool) or not isinstance(ordinal, int):
        raise TypeError("ordinal must be an integer")
    if ordinal < 0 or ordinal > 99_999:
        raise ValueError("ordinal must be between 0 and 99999")
    return (
        "staging/canonical/"
        f"{_archive_key_component(dataset_version, 'dataset_version component')}/"
        f"{_archive_key_component(dataset, 'dataset component')}/{partition}/"
        f"part-{ordinal:05d}-{_archive_sha256(sha256)}.parquet"
    )


def canonical_set_marker_key(dataset_version: str) -> str:
    """Return the immutable S3 commit-marker key for a canonical dataset version."""
    encoded = _archive_key_component(dataset_version, "dataset_version component")
    return f"canonical/schema_version=1.0/dataset_version={encoded}/manifest.json"


def _canonical_archive_prefix(
    dataset_version: str,
    dataset: str,
    partition: str,
    *,
    schema_version: str = "1.0",
) -> str:
    """Build the validated prefix shared by the explicit v1 and v2 layouts."""
    if schema_version != "1.0":
        raise ValueError("schema_version must be 1.0")
    partition_date(partition)
    if not (partition.startswith("year=") or partition.startswith("snapshot_date=")):
        raise ValueError("partition must use the canonical archive layout")
    return (
        "canonical/schema_version=1.0/"
        f"dataset_version={_archive_key_component(dataset_version, 'dataset_version component')}/"
        f"dataset={_archive_key_component(dataset, 'dataset component')}/{partition}/"
    )


def legacy_canonical_archive_key(
    dataset_version: str,
    dataset: str,
    partition: str,
    sha256: str,
    *,
    schema_version: str = "1.0",
) -> str:
    """Encode the explicitly named single-object metadata-v1 archive layout."""
    prefix = _canonical_archive_prefix(
        dataset_version,
        dataset,
        partition,
        schema_version=schema_version,
    )
    return prefix + f"part-{_archive_sha256(sha256)}.parquet"


def canonical_archive_key(
    dataset_version: str,
    dataset: str,
    partition: str,
    sha256: str,
    *,
    aggregate_digest: str,
    ordinal: int,
    schema_version: str = "1.0",
) -> str:
    """Produce a generation-scoped canonical-v2 archive object key.

    Args:
        dataset_version: Identificador imutável da versão do dataset.
        dataset: Nome do dataset permitido pelo registro de contratos.
        partition: Identificador canônico da partição física ou lógica.
        sha256: Entrada ``sha256``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        aggregate_digest: Geração imutável do conjunto canônico v2.
        ordinal: Posição estável do objeto dentro da partição canônica v2.
        schema_version: Versão imutável usada para identidade e compatibilidade.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    prefix = _canonical_archive_prefix(
        dataset_version,
        dataset,
        partition,
        schema_version=schema_version,
    )
    generation = _archive_sha256(aggregate_digest)
    if isinstance(ordinal, bool) or not isinstance(ordinal, int):
        raise TypeError("ordinal must be an integer")
    if ordinal < 0 or ordinal > 99_999:
        raise ValueError("ordinal must be between 0 and 99999")
    return prefix + f"generation={generation}/part-{ordinal:05d}-{_archive_sha256(sha256)}.parquet"


def _mapping(value: object, field: str, *, nonempty: bool = True) -> Mapping[str, object]:
    """Executa a etapa interna ``mapping`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.
        nonempty: Entrada ``nonempty``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``Mapping[str, object]`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, Mapping) or any(not isinstance(key, str) for key in value):
        raise TypeError(f"{field} must be a string-keyed mapping")
    if nonempty and not value:
        raise ValueError(f"{field} must not be empty")
    return value


def _text(value: object, field: str) -> str:
    """Executa a etapa interna ``text`` e devolve o resultado validado indicado pela assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``str`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a string")
    if not value:
        raise ValueError(f"{field} must not be empty")
    return value


def _utc(value: object, field: str) -> datetime:
    """Executa a etapa interna ``utc`` e devolve o resultado validado indicado pela assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``datetime`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(value, str):
        raise TypeError(f"{field} must be a UTC timestamp string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"{field} must be a valid UTC timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        raise ValueError(f"{field} must be a UTC timestamp")
    return parsed.astimezone(UTC)


def _non_negative_int(value: object, field: str) -> int:
    """Executa a etapa interna ``non_negative_int`` e devolve o resultado validado indicado pela
    assinatura.

    Args:
        value: Valor não confiável que será validado ou convertido.
        field: Nome do campo usado para produzir mensagens de validação precisas.

    Returns:
        Valor ``int`` produzido pela operação após as validações.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field} must be an integer")
    if value < 0:
        raise ValueError(f"{field} must be non-negative")
    return value


def _same_dataset_keys(
    field: str,
    value: object,
    expected: frozenset[str] | None,
) -> tuple[Mapping[str, object], frozenset[str]]:
    """Compara as evidências e informa se dataset keys é equivalente.

    Args:
        field: Nome do campo usado para produzir mensagens de validação precisas.
        value: Valor não confiável que será validado ou convertido.
        expected: Entrada ``expected``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``tuple[Mapping[str, object], frozenset[str]]`` produzido pela operação após as
        validações.

    Raises:
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    mapping = _mapping(value, field)
    keys = frozenset(mapping)
    for key in keys:
        require_key_component(key, f"{field} dataset")
    if expected is not None and keys != expected:
        raise ValueError(f"{field} must describe exactly the manifest datasets")
    return mapping, keys


def validate_candidate_manifest(manifest: CandidateManifest) -> None:
    """Valida candidato manifesto contra as invariantes deste módulo.

    Args:
        manifest: Entrada ``manifest``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(manifest, CandidateManifest):
        raise TypeError("manifest must be a CandidateManifest")
    require_key_component(manifest.dataset_version, "dataset_version")
    metadata = _mapping(manifest.metadata, "manifest metadata")
    metadata_fields = frozenset(metadata)
    canonical_metadata_fields = (
        _MANIFEST_FIELDS | _HOT_MATERIALIZATION_FIELDS | _CANONICAL_MARKER_FIELDS
    )
    is_legacy = metadata_fields == _MANIFEST_FIELDS
    is_canonical = metadata_fields == canonical_metadata_fields
    if not is_legacy and not is_canonical:
        raise ValueError("manifest metadata must contain exactly the required contract fields")
    if is_canonical:
        if metadata["hotMaterialization"] != "SKIPPED":
            raise ValueError("hotMaterialization must be SKIPPED")
        if metadata["hotItemCount"] != 0:
            raise ValueError("a skipped hot materialization must contain zero items")
    canonical_marker = metadata.get("canonicalMarker")
    _text(metadata["physicalContractVersion"], "physicalContractVersion")
    _text(metadata["canonicalSchemaVersion"], "canonicalSchemaVersion")
    checksum = _text(metadata["dumpChecksumSha256"], "dumpChecksumSha256")
    if _SHA256.fullmatch(checksum) is None:
        raise ValueError("dumpChecksumSha256 must be a lowercase SHA-256 digest")
    parse_snapshot_extracted_on(metadata["snapshotExtractedOn"])

    intervals, datasets = _same_dataset_keys(
        "availableIntervals", metadata["availableIntervals"], None
    )
    observed_bounds: dict[str, tuple[datetime, datetime] | None] = {}
    for dataset, raw_intervals in intervals.items():
        if not isinstance(raw_intervals, Sequence) or isinstance(raw_intervals, str | bytes):
            raise TypeError("availableIntervals values must be sequences")
        if not raw_intervals:
            observed_bounds[dataset] = None
            continue
        previous_end: datetime | None = None
        first_start: datetime | None = None
        last_end: datetime | None = None
        for raw_interval in raw_intervals:
            interval = _mapping(raw_interval, "available interval")
            if set(interval) != {"start", "end"}:
                raise ValueError("available interval must contain exactly start and end")
            start = _utc(interval["start"], "available interval start")
            end = _utc(interval["end"], "available interval end")
            if start >= end:
                raise ValueError("available interval must be non-empty and half-open")
            if previous_end is not None and start < previous_end:
                raise ValueError("available intervals must be ordered and non-overlapping")
            first_start = start if first_start is None else first_start
            previous_end = last_end = end
        assert first_start is not None and last_end is not None
        observed_bounds[dataset] = (first_start, last_end)

    hot_from, _ = _same_dataset_keys("hotFrom", metadata["hotFrom"], datasets)
    watermarks, _ = _same_dataset_keys("watermarks", metadata["watermarks"], datasets)
    for dataset in datasets:
        bounds = observed_bounds[dataset]
        if bounds is None:
            if hot_from[dataset] is not None or watermarks[dataset] is not None:
                raise ValueError(
                    "datasets without available intervals require null hotFrom/watermark"
                )
            continue
        hot = _utc(hot_from[dataset], f"hotFrom.{dataset}")
        watermark = _utc(watermarks[dataset], f"watermarks.{dataset}")
        start, end = bounds
        if not start <= hot <= end:
            raise ValueError("hotFrom must lie inside the real available interval")
        if not start <= watermark <= end:
            raise ValueError("watermark must lie inside the real available interval")

    s3_prefix = _text(metadata["s3Prefix"], "s3Prefix")
    if not s3_prefix.startswith("s3://") or not s3_prefix.endswith("/"):
        raise ValueError("s3Prefix must be an s3:// prefix ending in slash")
    for field in ("glueTables", "descriptorVersions", "coverage"):
        values, _ = _same_dataset_keys(field, metadata[field], datasets)
        for dataset, value in values.items():
            text_value = _text(value, f"{field}.{dataset}")
            if field == "coverage" and text_value.lower() not in {
                "complete",
                "partial",
                "unavailable",
            }:
                raise ValueError("coverage must be COMPLETE, PARTIAL, or UNAVAILABLE")
            if field == "coverage":
                unavailable = text_value.upper() == "UNAVAILABLE"
                if unavailable != (observed_bounds[dataset] is None):
                    raise ValueError(
                        "UNAVAILABLE coverage must have zero intervals and available "
                        "coverage must have intervals"
                    )
    quality_flags, _ = _same_dataset_keys("qualityFlags", metadata["qualityFlags"], datasets)
    for dataset, raw_flags in quality_flags.items():
        if not isinstance(raw_flags, Sequence) or isinstance(raw_flags, str | bytes):
            raise TypeError(f"qualityFlags.{dataset} must be a sequence")
        flags = tuple(raw_flags)
        if any(not isinstance(flag, str) or not flag for flag in flags):
            raise ValueError("quality flags must be non-empty strings")
        if len(set(flags)) != len(flags) or flags != tuple(sorted(flags)):
            raise ValueError("quality flags must be unique and canonically ordered")
    for field in ("formulaVersions", "projectionVersions"):
        values = _mapping(metadata[field], field)
        for name, value in values.items():
            _text(name, f"{field} name")
            _text(value, f"{field}.{name}")
    validations = _mapping(metadata["validations"], "validations")
    categories = {
        "physicalSchemas",
        "reconciliation",
        "parquetCatalog",
        "requiredProjections",
        "coverageQuality",
    }
    if set(validations) != categories:
        raise ValueError("validations must contain exactly the five activation categories")
    expected_validation_fields = {
        "physicalSchemas": {"state", "validatedAt", "datasets"},
        "reconciliation": {"state", "validatedAt", "datasets"},
        "parquetCatalog": {"state", "validatedAt", "datasets"},
        "requiredProjections": {"state", "validatedAt", "projections"},
        "coverageQuality": {"state", "validatedAt", "datasets"},
    }
    for name, raw_validation in validations.items():
        validation = _mapping(raw_validation, f"validations.{name}")
        if set(validation) != expected_validation_fields[name]:
            raise ValueError(f"validation {name} has an invalid closed structure")
        if _text(validation["state"], f"validations.{name}.state") not in {
            "PASSED",
            "FAILED",
        }:
            raise ValueError("validation state must be PASSED or FAILED")
        _utc(validation["validatedAt"], f"validations.{name}.validatedAt")

    physical, _ = _same_dataset_keys(
        "validations.physicalSchemas.datasets",
        cast(Mapping[str, object], validations["physicalSchemas"])["datasets"],
        datasets,
    )
    for dataset, raw in physical.items():
        evidence = _mapping(raw, f"physicalSchemas.{dataset}")
        if set(evidence) != {"fingerprint", "compatible"}:
            raise ValueError("physical schema evidence has an invalid shape")
        if _SHA256.fullmatch(_text(evidence["fingerprint"], "schema fingerprint")) is None:
            raise ValueError("schema fingerprint must be a lowercase SHA-256 digest")
        if type(evidence["compatible"]) is not bool:
            raise TypeError("schema compatible must be a boolean")

    reconciliation, _ = _same_dataset_keys(
        "validations.reconciliation.datasets",
        cast(Mapping[str, object], validations["reconciliation"])["datasets"],
        datasets,
    )
    reconciliation_totals = [0, 0, 0]
    for dataset, raw in reconciliation.items():
        counts = _mapping(raw, f"reconciliation.{dataset}")
        if set(counts) != {"accepted", "rejected", "persisted"}:
            raise ValueError("reconciliation evidence must contain the three counts")
        accepted = _non_negative_int(counts["accepted"], "accepted")
        rejected = _non_negative_int(counts["rejected"], "rejected")
        persisted = _non_negative_int(counts["persisted"], "persisted")
        if persisted > accepted:
            raise ValueError("persisted reconciliation count cannot exceed accepted")
        reconciliation_totals[0] += accepted
        reconciliation_totals[1] += rejected
        reconciliation_totals[2] += persisted

    parquet, _ = _same_dataset_keys(
        "validations.parquetCatalog.datasets",
        cast(Mapping[str, object], validations["parquetCatalog"])["datasets"],
        datasets,
    )
    total_partitions = 0
    for dataset, raw in parquet.items():
        evidence = _mapping(raw, f"parquetCatalog.{dataset}")
        fields = set(evidence)
        legacy_fields = (
            {"partitionCount", "catalogValidated"},
            {"partitionCount", "catalogValidated", "partitions"},
        )
        canonical_evidence_fields = {
            "partitionCount",
            "catalogValidated",
            "projectionItemCount",
            "projectionDigest",
        }
        valid_shape = (
            fields == canonical_evidence_fields if is_canonical else fields in legacy_fields
        )
        if not valid_shape:
            raise ValueError("Parquet/catalog evidence has an invalid shape")
        partition_count = _non_negative_int(evidence["partitionCount"], "partitionCount")
        total_partitions += partition_count
        if type(evidence["catalogValidated"]) is not bool:
            raise TypeError("catalogValidated must be a boolean")
        if fields == canonical_evidence_fields:
            if canonical_marker is None:
                raise ValueError("aggregate Parquet evidence requires canonicalMarker")
            _non_negative_int(evidence["projectionItemCount"], "projectionItemCount")
            projection_digest = _text(evidence["projectionDigest"], "projectionDigest")
            if _SHA256.fullmatch(projection_digest) is None:
                raise ValueError("projectionDigest must be a lowercase SHA-256 digest")
        if "partitions" in evidence:
            if canonical_marker is not None:
                raise ValueError("canonical candidates must not embed partition evidence")
            partitions = _mapping(evidence["partitions"], f"parquetCatalog.{dataset}.partitions")
            if len(partitions) != partition_count:
                raise ValueError(
                    "projection cardinality evidence must cover every Parquet partition"
                )
            for partition, raw_partition in partitions.items():
                partition_date(partition)
                counts = _mapping(
                    raw_partition,
                    f"parquetCatalog.{dataset}.partitions.{partition}",
                )
                if set(counts) != {"projectionItemCount"}:
                    raise ValueError("projection cardinality evidence has an invalid shape")
                _non_negative_int(counts["projectionItemCount"], "projectionItemCount")

    projection_validation = cast(Mapping[str, object], validations["requiredProjections"])
    raw_projection_names = projection_validation["projections"]
    if not isinstance(raw_projection_names, Sequence) or isinstance(
        raw_projection_names, str | bytes
    ):
        raise TypeError("required projection evidence must be a sequence")
    projection_names = tuple(raw_projection_names)
    if any(not isinstance(name, str) or not name for name in projection_names):
        raise ValueError("required projection names must be non-empty strings")
    if projection_names != tuple(sorted(cast(tuple[str, ...], projection_names))):
        raise ValueError("required projection names must be canonically ordered")
    if frozenset(projection_names) != frozenset(
        cast(Mapping[str, object], metadata["projectionVersions"])
    ):
        raise ValueError("required projection evidence must cover every projection version")

    coverage_evidence, _ = _same_dataset_keys(
        "validations.coverageQuality.datasets",
        cast(Mapping[str, object], validations["coverageQuality"])["datasets"],
        datasets,
    )
    for dataset, raw in coverage_evidence.items():
        evidence = _mapping(raw, f"coverageQuality.{dataset}")
        if set(evidence) != {"coverage", "qualityFlags"}:
            raise ValueError("coverage/quality evidence has an invalid shape")
        if evidence["coverage"] != cast(Mapping[str, object], metadata["coverage"])[dataset]:
            raise ValueError("coverage evidence differs from manifest coverage")
        if tuple(cast(Sequence[object], evidence["qualityFlags"])) != tuple(
            cast(Sequence[object], quality_flags[dataset])
        ):
            raise ValueError("quality evidence differs from manifest quality flags")

    if canonical_marker is not None:
        marker = _mapping(canonical_marker, "canonicalMarker")
        if set(marker) != _CANONICAL_MARKER_VALUE_FIELDS:
            raise ValueError("canonicalMarker has an invalid closed structure")
        if _text(marker["schemaVersion"], "canonicalMarker.schemaVersion") != metadata[
            "canonicalSchemaVersion"
        ]:
            raise ValueError("canonicalMarker schemaVersion differs from the manifest")
        if _text(marker["objectKey"], "canonicalMarker.objectKey") != canonical_set_marker_key(
            manifest.dataset_version
        ):
            raise ValueError("canonicalMarker objectKey differs from the dataset version")
        for field in ("aggregateDigest", "documentSha256"):
            digest = _text(marker[field], f"canonicalMarker.{field}")
            if _SHA256.fullmatch(digest) is None:
                raise ValueError(f"canonicalMarker.{field} must be a lowercase SHA-256 digest")
        dataset_count = _non_negative_int(marker["datasetCount"], "canonicalMarker.datasetCount")
        partition_count = _non_negative_int(
            marker["partitionCount"], "canonicalMarker.partitionCount"
        )
        object_count = _non_negative_int(marker["objectCount"], "canonicalMarker.objectCount")
        total_source = _non_negative_int(
            marker["totalSourceRows"], "canonicalMarker.totalSourceRows"
        )
        total_accepted = _non_negative_int(
            marker["totalAcceptedRows"], "canonicalMarker.totalAcceptedRows"
        )
        total_rejected = _non_negative_int(
            marker["totalRejectedRows"], "canonicalMarker.totalRejectedRows"
        )
        if dataset_count != len(datasets):
            raise ValueError("canonicalMarker datasetCount differs from manifest datasets")
        if partition_count != total_partitions or object_count < partition_count:
            raise ValueError("canonicalMarker physical counts differ from Parquet evidence")
        if (
            total_source != total_accepted + total_rejected
            or total_accepted != reconciliation_totals[0]
            or total_rejected != reconciliation_totals[1]
            or reconciliation_totals[2] != total_accepted
        ):
            raise ValueError("canonicalMarker row totals differ from reconciliation evidence")


def candidate_manifest_pipeline(manifest: CandidateManifest) -> RunPipeline:
    """Return the representation contract encoded by a closed candidate manifest shape."""
    validate_candidate_manifest(manifest)
    fields = frozenset(manifest.metadata)
    if fields == _MANIFEST_FIELDS:
        return RunPipeline.LEGACY_V1
    if fields == _MANIFEST_FIELDS | _HOT_MATERIALIZATION_FIELDS | _CANONICAL_MARKER_FIELDS:
        return RunPipeline.CANONICAL_V2
    raise ValueError("manifest representation fields do not form a closed pipeline contract")


def manifest_is_ready_for_activation(manifest: CandidateManifest) -> bool:
    """Verifica a condição associada a manifesto is ready for activation.

    Args:
        manifest: Entrada ``manifest``; a forma aceita é definida pela anotação de tipo e
        validada antes do uso.

    Returns:
        Valor ``bool`` produzido pela operação após as validações.
    """
    validate_candidate_manifest(manifest)
    if _HOT_MATERIALIZATION_FIELDS <= set(manifest.metadata) and "canonicalMarker" not in (
        manifest.metadata
    ):
        return False
    validations = cast(Mapping[str, object], manifest.metadata["validations"])
    if not all(
        isinstance(value, Mapping) and value.get("state") == "PASSED"
        for value in validations.values()
    ):
        return False
    physical = cast(Mapping[str, object], validations["physicalSchemas"])["datasets"]
    parquet = cast(Mapping[str, object], validations["parquetCatalog"])["datasets"]
    coverage = cast(Mapping[str, object], manifest.metadata["coverage"])
    return (
        all(value != "UNAVAILABLE" for value in coverage.values())
        and all(
            cast(Mapping[str, object], evidence).get("compatible") is True
            for evidence in cast(Mapping[str, object], physical).values()
        )
        and all(
            cast(Mapping[str, object], evidence).get("catalogValidated") is True
            for evidence in cast(Mapping[str, object], parquet).values()
        )
    )


def validate_archive_partition(partition: ArchivePartition) -> None:
    """Valida arquivo histórico partição contra as invariantes deste módulo.

    Args:
        partition: Identificador canônico da partição física ou lógica.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        ValueError: Se um valor estiver fora das invariantes aceitas.
    """
    if not isinstance(partition, ArchivePartition):
        raise TypeError("partition must be an ArchivePartition")
    require_key_component(partition.dataset_version, "dataset_version")
    require_key_component(partition.dataset, "dataset")
    day = partition_date(partition.partition)
    metadata = _mapping(partition.metadata, "archive metadata")
    fields = set(metadata)
    is_canonical_v2 = fields == _ARCHIVE_V2_FIELDS
    if not is_canonical_v2 and fields != _ARCHIVE_V1_FIELDS:
        raise ValueError(
            "archive metadata must contain exactly the required v1 or v2 catalog fields"
        )
    interval = _mapping(metadata["interval"], "archive interval")
    if set(interval) != {"start", "end"}:
        raise ValueError("archive interval must contain exactly start and end")
    start = _utc(interval["start"], "archive interval start")
    end = _utc(interval["end"], "archive interval end")
    if start >= end:
        raise ValueError("archive interval must be non-empty and half-open")
    expected_start = datetime(day.year, day.month, day.day, tzinfo=UTC)
    if start != expected_start or end != expected_start + timedelta(days=1):
        raise ValueError("archive interval must match exactly the partition day")
    counts = _mapping(metadata["counts"], "archive counts")
    if set(counts) != {"accepted", "rejected", "persisted"}:
        raise ValueError("archive counts must contain accepted, rejected, and persisted")
    accepted = _non_negative_int(counts["accepted"], "archive accepted count")
    _non_negative_int(counts["rejected"], "archive rejected count")
    persisted = _non_negative_int(counts["persisted"], "archive persisted count")
    if persisted > accepted:
        raise ValueError("archive persisted count cannot exceed accepted count")
    if is_canonical_v2:
        aggregate_digest = _text(metadata["aggregateDigest"], "aggregateDigest")
        if _SHA256.fullmatch(aggregate_digest) is None:
            raise ValueError("aggregateDigest must be a lowercase SHA-256 digest")
        objects = metadata["objects"]
        if not isinstance(objects, Sequence) or isinstance(objects, str | bytes):
            raise TypeError("archive objects must be a sequence")
        if persisted > 0 and not objects:
            raise ValueError("a non-empty canonical partition must contain objects")
        object_rows = 0
        object_keys: list[str] = []
        for ordinal, raw_object in enumerate(objects):
            item = _mapping(raw_object, "archive object")
            if set(item) != _ARCHIVE_OBJECT_FIELDS:
                raise ValueError("archive object must contain exactly the required evidence")
            checksum = _text(item["sha256"], "archive object sha256")
            if _SHA256.fullmatch(checksum) is None:
                raise ValueError("archive object sha256 must be a lowercase SHA-256 digest")
            row_count = _non_negative_int(item["rowCount"], "archive object rowCount")
            byte_count = _non_negative_int(item["byteCount"], "archive object byteCount")
            if byte_count > _MAX_CANONICAL_OBJECT_BYTES:
                raise ValueError("canonical archive object must be at most 512 MiB")
            object_key = _text(item["objectKey"], "archive objectKey")
            expected_key = canonical_archive_key(
                partition.dataset_version,
                partition.dataset,
                partition.partition,
                checksum,
                aggregate_digest=aggregate_digest,
                ordinal=ordinal,
            )
            if object_key != expected_key:
                raise ValueError("archive objectKey differs from canonical evidence")
            object_rows += row_count
            object_keys.append(object_key)
        if object_rows != persisted:
            raise ValueError("archive object row counts must equal persisted count")
        if object_keys != sorted(object_keys) or len(object_keys) != len(set(object_keys)):
            raise ValueError("archive objects must be ordered and unique")
        if metadata["hotItemCount"] != 0:
            raise ValueError("canonical-v2 hotItemCount must be zero")
    else:
        uri = _text(metadata["s3Uri"], "s3Uri")
        if not uri.startswith("s3://") or uri.endswith("/"):
            raise ValueError("s3Uri must identify one s3:// object")
        canonical_identity = re.compile(
            r"^s3://[^/]+/canonical/schema_version=1\.0/"
            rf"dataset_version={re.escape(partition.dataset_version)}/"
            rf"dataset={re.escape(partition.dataset)}/"
            rf"{re.escape(partition.partition)}/part-[^/]+\.parquet$"
        )
        if canonical_identity.fullmatch(uri) is None:
            raise ValueError("s3Uri must use the canonical version/dataset/partition layout")
        checksum = _text(metadata["sha256"], "sha256")
        if _SHA256.fullmatch(checksum) is None:
            raise ValueError("sha256 must be a lowercase SHA-256 digest")
    reconciliation = _mapping(metadata["reconciliation"], "reconciliation")
    reconciliation_state = reconciliation.get("state")
    if reconciliation_state == "PENDING":
        if set(reconciliation) != {"state"}:
            raise ValueError("pending reconciliation must not claim evidence")
        if metadata["expirationEligible"] is not False or metadata["catalogDigest"] is not None:
            raise ValueError("pending reconciliation cannot be expiration eligible or sealed")
    elif reconciliation_state == "PASSED":
        if set(reconciliation) != {"state", "expected", "observed", "reconciledAt"}:
            raise ValueError("passed reconciliation must contain complete evidence")
        expected = _mapping(reconciliation["expected"], "reconciliation expected")
        observed = _mapping(reconciliation["observed"], "reconciliation observed")
        if expected != counts or observed != counts:
            raise ValueError("passed reconciliation counts must match archive counts")
        _utc(reconciliation["reconciledAt"], "reconciledAt")
        if metadata["expirationEligible"] is not True:
            raise ValueError("passed reconciliation must be expiration eligible")
        digest = _text(metadata["catalogDigest"], "catalogDigest")
        if _SHA256.fullmatch(digest) is None:
            raise ValueError("catalogDigest must be a lowercase SHA-256 digest")
    else:
        raise ValueError("reconciliation state must be PENDING or PASSED")
    if type(metadata["expirationEligible"]) is not bool:
        raise TypeError("expirationEligible must be a boolean")
    _non_negative_int(metadata["hotItemCount"], "hotItemCount")
    if not is_canonical_v2:
        _non_negative_int(metadata["projectionItemCount"], "projectionItemCount")
    generation = _non_negative_int(metadata["catalogGeneration"], "catalogGeneration")
    if generation == 0:
        raise ValueError("catalogGeneration must be positive")
    if partition.state is ArchiveState.AVAILABLE and (
        reconciliation_state != "PASSED" or metadata["expirationEligible"] is not True
    ):
        raise ValueError("AVAILABLE archive must be reconciled and expiration eligible")


def validate_new_archive_partition(partition: ArchivePartition) -> None:
    """Valida novo arquivo histórico partição contra as invariantes deste módulo.

    Args:
        partition: Identificador canônico da partição física ou lógica.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        InvalidArchiveTransition: Se a operação não puder preservar as invariantes descritas.
    """
    validate_archive_partition(partition)
    if partition.state is not ArchiveState.STAGING:
        raise InvalidArchiveTransition("a new archive partition must start at STAGING")


def validate_archive_transition(current: ArchiveState, target: ArchiveState) -> None:
    """Valida arquivo histórico transição contra as invariantes deste módulo.

    Args:
        current: Entrada ``current``; a forma aceita é definida pela anotação de tipo e validada
        antes do uso.
        target: Estado ou destino solicitado para a operação.

    Returns:
        Não produz valor de retorno; conclui após aplicar ou validar a operação.

    Raises:
        TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        InvalidArchiveTransition: Se a operação não puder preservar as invariantes descritas.
    """
    if not isinstance(current, ArchiveState) or not isinstance(target, ArchiveState):
        raise TypeError("archive states must be ArchiveState values")
    if target not in _NEXT_STATES[current]:
        raise InvalidArchiveTransition(f"archive cannot transition from {current} to {target}")


__all__ = [
    "ArchiveDomainError",
    "ArchiveNotAvailable",
    "InvalidArchiveTransition",
    "canonical_archive_key",
    "candidate_manifest_pipeline",
    "legacy_canonical_archive_key",
    "manifest_is_ready_for_activation",
    "partition_date",
    "require_key_component",
    "validate_archive_partition",
    "validate_new_archive_partition",
    "validate_archive_transition",
    "validate_candidate_manifest",
]
