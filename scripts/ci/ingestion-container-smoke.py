from __future__ import annotations

import os
from datetime import UTC, date, datetime
from pathlib import Path

from application.backfill import _RecordSpool
from domain.models import CanonicalRecord, RecordType


def main() -> None:
    archive_workdir = Path(os.environ["ARCHIVE_WORKDIR"])
    expected_workdir = Path(os.environ["INGESTION_SMOKE_EXPECT_WORKDIR"])
    expected_uid = int(os.environ["INGESTION_SMOKE_EXPECT_UID"])
    assert os.getuid() == expected_uid
    assert archive_workdir == expected_workdir

    root = archive_workdir / ".spool" / "container-smoke"
    spool = _RecordSpool(root, date(2026, 9, 1))
    record = CanonicalRecord(
        "1.0",
        RecordType.SIGNAL_OBSERVATION,
        "argus",
        "signal_bucket",
        (("signal", "smoke"),),
        datetime(2026, 9, 1, tzinfo=UTC),
        None,
        {},
        {"value": 1},
        {},
        (),
    )
    spool.append("signal_bucket", "year=2026/month=09/day=01", (record,))
    usage = spool.disk_usage()
    assert root.is_dir() and root.is_relative_to(archive_workdir)
    assert usage.artifacts["jsonlBytes"] > 0
    assert usage.artifacts["sqliteBytes"] > 0
    spool.cleanup()
    assert not root.exists()
    print("record-spool-create-cleanup-ok")


if __name__ == "__main__":
    main()
