"""Verify the immutable canonical-set commit marker domain."""

from __future__ import annotations

from dataclasses import replace
from datetime import date

import pytest

from contracts.registry import EXPECTED_ARGUS_V2_DATASETS
from domain.archive import canonical_archive_key
from domain.canonical_set import (
    MAX_CANONICAL_OBJECT_BYTES,
    CanonicalDatasetEvidence,
    CanonicalObjectEvidence,
    CanonicalPartitionEvidence,
    CanonicalSet,
    canonical_set_aggregate_digest,
)

SNAPSHOT_DATE = date(2026, 9, 1)


def canonical_set(*, object_sha: str = "a" * 64, coverage: str = "COMPLETE") -> CanonicalSet:
    """Build a complete registry-shaped set without deriving expectations from production."""
    logical_object = CanonicalObjectEvidence("", 7, 99, object_sha)
    populated = CanonicalDatasetEvidence(
        "app_error",
        8,
        7,
        1,
        "b" * 64,
        coverage,
        (
            CanonicalPartitionEvidence(
                "app_error", "snapshot_date=2026-09-01", 7, (logical_object,)
            ),
        ),
    )
    datasets = tuple(
        populated
        if name == "app_error"
        else CanonicalDatasetEvidence(name, 0, 0, 0, "c" * 64, "COMPLETE", ())
        for name in EXPECTED_ARGUS_V2_DATASETS
    )
    digest = canonical_set_aggregate_digest(
        schema_version="1.0",
        dataset_version="dsv_a",
        source_sha256="d" * 64,
        contract_version="2.0",
        snapshot_extracted_on=SNAPSHOT_DATE,
        datasets=datasets,
        total_source_rows=8,
        total_accepted_rows=7,
        total_rejected_rows=1,
    )
    object_with_key = replace(
        logical_object,
        object_key=canonical_archive_key(
            "dsv_a",
            "app_error",
            "snapshot_date=2026-09-01",
            object_sha,
            aggregate_digest=digest,
            ordinal=0,
        ),
    )
    finalized = tuple(
        replace(
            item,
            partitions=(
                replace(item.partitions[0], objects=(object_with_key,)),
            ),
        )
        if item.dataset == "app_error"
        else item
        for item in datasets
    )
    return CanonicalSet(
        "1.0",
        "dsv_a",
        "d" * 64,
        "2.0",
        SNAPSHOT_DATE,
        digest,
        finalized,
        8,
        7,
        1,
    )


def test_canonical_set_requires_the_complete_registry_and_consistent_totals() -> None:
    value = canonical_set()

    assert tuple(item.dataset for item in value.datasets) == EXPECTED_ARGUS_V2_DATASETS
    assert value.datasets[EXPECTED_ARGUS_V2_DATASETS.index("signal_bucket")].partitions == ()

    with pytest.raises(ValueError, match="registry"):
        replace(value, datasets=value.datasets[:-1])
    with pytest.raises(ValueError, match="total"):
        replace(value, total_accepted_rows=8)
    app_error_index = EXPECTED_ARGUS_V2_DATASETS.index("app_error")
    bad_dataset = replace(value.datasets[app_error_index], rejected_row_count=2)
    with pytest.raises(ValueError, match="source.*accepted.*rejected"):
        replace(
            value,
            datasets=value.datasets[:app_error_index]
            + (bad_dataset,)
            + value.datasets[app_error_index + 1 :],
        )


def test_canonical_set_rejects_partition_and_object_drift() -> None:
    value = canonical_set()
    app_error_index = EXPECTED_ARGUS_V2_DATASETS.index("app_error")
    app_error = value.datasets[app_error_index]
    partition = app_error.partitions[0]
    object_evidence = partition.objects[0]

    with pytest.raises(ValueError, match="partition.*accepted"):
        replace(
            value,
            datasets=value.datasets[:app_error_index]
            + (replace(app_error, partitions=(replace(partition, row_count=6),)),)
            + value.datasets[app_error_index + 1 :],
        )
    with pytest.raises(ValueError, match="object.*row"):
        replace(
            value,
            datasets=value.datasets[:app_error_index]
            + (
                replace(
                    app_error,
                    partitions=(
                        replace(
                            partition,
                            objects=(replace(object_evidence, row_count=6),),
                        ),
                    ),
                ),
            )
            + value.datasets[app_error_index + 1 :],
        )
    with pytest.raises(ValueError, match="512 MiB"):
        replace(
            value,
            datasets=value.datasets[:app_error_index]
            + (
                replace(
                    app_error,
                    partitions=(
                        replace(
                            partition,
                            objects=(
                                replace(
                                    object_evidence,
                                    byte_count=MAX_CANONICAL_OBJECT_BYTES + 1,
                                ),
                            ),
                        ),
                    ),
                ),
            )
            + value.datasets[app_error_index + 1 :],
        )


def test_aggregate_digest_changes_for_every_logical_evidence_class() -> None:
    original = canonical_set()
    app_error_index = EXPECTED_ARGUS_V2_DATASETS.index("app_error")
    app_error = original.datasets[app_error_index]
    partition = app_error.partitions[0]
    item = partition.objects[0]

    def digest(
        changed: CanonicalDatasetEvidence,
        *,
        totals: tuple[int, int, int] = (8, 7, 1),
    ) -> str:
        datasets = (
            original.datasets[:app_error_index]
            + (changed,)
            + original.datasets[app_error_index + 1 :]
        )
        return canonical_set_aggregate_digest(
            schema_version="1.0",
            dataset_version="dsv_a",
            source_sha256="d" * 64,
            contract_version="2.0",
            snapshot_extracted_on=SNAPSHOT_DATE,
            datasets=datasets,
            total_source_rows=totals[0],
            total_accepted_rows=totals[1],
            total_rejected_rows=totals[2],
        )

    mutations = {
        "schema": replace(app_error, schema_fingerprint="e" * 64),
        "coverage": replace(app_error, coverage="PARTIAL"),
        "partition": replace(
            app_error,
            partitions=(replace(partition, partition="snapshot_date=2026-09-02"),),
        ),
        "object-bytes": replace(
            app_error,
            partitions=(
                replace(partition, objects=(replace(item, byte_count=item.byte_count + 1),)),
            ),
        ),
        "object-sha": replace(
            app_error,
            partitions=(replace(partition, objects=(replace(item, sha256="e" * 64),)),),
        ),
    }
    count_mutation = replace(
        app_error,
        source_row_count=9,
        accepted_row_count=8,
        partitions=(
            replace(partition, row_count=8, objects=(replace(item, row_count=8),)),
        ),
    )
    rejected_count_mutation = replace(
        app_error,
        source_row_count=9,
        rejected_row_count=2,
    )
    digests = {name: digest(value) for name, value in mutations.items()}
    digests["accepted-partition-object-counts"] = digest(
        count_mutation, totals=(9, 8, 1)
    )
    digests["source-rejected-counts"] = digest(
        rejected_count_mutation, totals=(9, 7, 2)
    )

    assert len(set(digests.values()) | {original.aggregate_digest}) == len(digests) + 1
    with pytest.raises(ValueError, match="aggregate"):
        replace(original, aggregate_digest="f" * 64)


def test_object_keys_are_generation_scoped_ordered_and_not_caller_bucketed() -> None:
    value = canonical_set()
    obj = value.datasets[EXPECTED_ARGUS_V2_DATASETS.index("app_error")].partitions[0].objects[0]

    assert obj.object_key == (
        "canonical/schema_version=1.0/dataset_version=dsv_a/dataset=app_error/"
        "snapshot_date=2026-09-01/generation="
        f"{value.aggregate_digest}/part-00000-{'a' * 64}.parquet"
    )
    assert not obj.object_key.startswith("s3://")

    with pytest.raises(ValueError, match="object key"):
        bad = replace(obj, object_key=obj.object_key.replace("part-00000", "part-00001"))
        app_error_index = EXPECTED_ARGUS_V2_DATASETS.index("app_error")
        app_error = value.datasets[app_error_index]
        replace(
            value,
            datasets=value.datasets[:app_error_index]
            + (
                replace(
                    app_error,
                    partitions=(replace(app_error.partitions[0], objects=(bad,)),),
                ),
            )
            + value.datasets[app_error_index + 1 :],
        )
