import pandas as pd
import pytest
from sqlalchemy import text

from dump_explorer.database import ResultLimitError, read_frame


def test_read_frame_rejects_result_above_limit(monkeypatch):
    monkeypatch.setattr(
        pd,
        "read_sql_query",
        lambda *args, **kwargs: iter([pd.DataFrame({"id": range(4)})]),
    )

    with pytest.raises(ResultLimitError, match="3 linhas"):
        read_frame(object(), text("SELECT id FROM x"), max_rows=3)
