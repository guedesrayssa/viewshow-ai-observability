"""Safety checks for the isolated notebook MySQL fixture loader."""

import pytest

from scripts.load_test_fixture import load_test_fixture


def test_fixture_loader_rejects_any_database_other_than_argus_test():
    with pytest.raises(ValueError, match="argus_test"):
        load_test_fixture("mysql+pymysql://root:local@127.0.0.1:3307/argus?charset=utf8mb4")
