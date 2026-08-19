import pandas as pd
import pytest

import dump_explorer.catalog as catalog
from dump_explorer.catalog import (
    compare_expected_tables,
    load_column_catalog,
    load_table_catalog,
)
from dump_explorer.config import HARD_MAX_ROWS
from dump_explorer.database import ResultLimitError


def test_table_catalog_marks_mysql_counts_as_estimates(monkeypatch):
    captured = {}

    def fake_read_frame(engine, statement, **kwargs):
        captured["sql"] = str(statement)
        return pd.DataFrame({"table_name": ["signal_bucket"], "estimated_rows": [1200]})

    monkeypatch.setattr(catalog, "read_frame", fake_read_frame)

    frame = load_table_catalog(object())

    assert frame.loc[0, "count_kind"] == "estimate"
    assert "information_schema.tables" in captured["sql"]
    assert "table_schema = DATABASE()" in captured["sql"]
    assert "COUNT(" not in captured["sql"]


def test_column_catalog_reads_schema_and_index_metadata(monkeypatch):
    captured = {}

    def fake_read_frame(engine, statement, **kwargs):
        captured["sql"] = str(statement)
        return pd.DataFrame(
            {
                "table_name": ["signal_bucket"],
                "column_name": ["id"],
                "data_type": ["bigint"],
                "column_key": ["PRIMARY"],
            }
        )

    monkeypatch.setattr(catalog, "read_frame", fake_read_frame)

    frame = load_column_catalog(object())

    assert frame.to_dict("records") == [
        {
            "table_name": "signal_bucket",
            "column_name": "id",
            "data_type": "bigint",
            "column_key": "PRIMARY",
        }
    ]
    assert "information_schema.columns" in captured["sql"]
    assert "information_schema.statistics" in captured["sql"]
    assert "table_schema = DATABASE()" in captured["sql"]


def test_compare_expected_tables_labels_all_schema_states():
    frame = compare_expected_tables(
        actual=["signal_point", "adhoc_table"],
        expected=["signal_point", "signal_bucket"],
    )

    assert frame.to_dict("records") == [
        {"table_name": "adhoc_table", "status": "undocumented"},
        {"table_name": "signal_bucket", "status": "missing"},
        {"table_name": "signal_point", "status": "present"},
    ]


def test_compare_expected_tables_rejects_inputs_above_hard_cap():
    actual = (f"table_{index}" for index in range(HARD_MAX_ROWS + 1))

    with pytest.raises(ResultLimitError, match="100000"):
        compare_expected_tables(actual=actual, expected=[])


def test_compare_expected_tables_rejects_expected_input_above_hard_cap():
    expected = (f"table_{index}" for index in range(HARD_MAX_ROWS + 1))

    with pytest.raises(ResultLimitError, match="100000"):
        compare_expected_tables(actual=[], expected=expected)


def test_compare_expected_tables_rejects_result_above_hard_cap():
    actual = (f"table_{index}" for index in range(HARD_MAX_ROWS))

    with pytest.raises(ResultLimitError, match="100000"):
        compare_expected_tables(actual=actual, expected=["documented_extra"])
