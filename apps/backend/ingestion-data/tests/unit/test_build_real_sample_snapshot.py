from __future__ import annotations

import gzip
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_real_sample_snapshot.py"
REGISTRY = ROOT / "contracts" / "argus" / "v2" / "registry.json"


def test_cli_copies_the_first_complete_real_insert_for_every_canonical_table(
    tmp_path: Path,
) -> None:
    descriptors = json.loads(REGISTRY.read_text(encoding="utf-8"))["descriptors"]
    source = tmp_path / "argus_dump.sql"
    source.write_text(
        "\n".join(
            f"CREATE TABLE `{table}` (`sample` text COMMENT '{table};schema');\n"
            f"INSERT INTO `{table}` (`sample`) VALUES\n('{table};real');"
            for table in descriptors
        )
        + "\nINSERT INTO `signal_bucket` (`sample`) VALUES ('ignored-second-batch');\n",
        encoding="utf-8",
    )
    output = tmp_path / "argus_dump.sql.gz"

    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--source",
            str(source),
            "--output",
            str(output),
        ],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    sql = gzip.decompress(output.read_bytes()).decode("utf-8")
    assert "ignored-second-batch" not in sql
    assert sql.count("INSERT INTO") == 23
    for table in descriptors:
        assert f"CREATE TABLE `{table}`" in sql
        assert f"COMMENT '{table};schema'" in sql
        assert f"INSERT INTO `{table}`" in sql
        assert f"('{table};real');" in sql
