"""Safety checks for the isolated notebook MySQL fixture loader."""

import pytest

import scripts.load_test_fixture as fixture
from scripts.load_test_fixture import load_test_fixture


def test_fixture_loader_rejects_any_database_other_than_argus_test():
    with pytest.raises(ValueError, match="argus_test"):
        load_test_fixture("mysql+pymysql://root:local@127.0.0.1:3307/argus?charset=utf8mb4")


@pytest.mark.parametrize(
    "database_url",
    [
        "mysql+pymysql://root:local@db.example.test:3307/argus_test?charset=utf8mb4",
        "mysql+pymysql://root:local@10.0.0.8:3307/argus_test?charset=utf8mb4",
        "mysql+pymysql://root:local@127.0.0.1:3307/argus_test?unix_socket=/tmp/mysql.sock",
    ],
)
def test_fixture_loader_rejects_remote_or_unix_urls_before_connecting(monkeypatch, database_url):
    monkeypatch.setattr(fixture, "create_engine", pytest.fail)

    with pytest.raises(ValueError, match="local"):
        load_test_fixture(database_url)


def test_fixture_loader_derives_a_server_url_without_the_test_database():
    test_url = fixture._parse_test_url(
        "mysql+pymysql://root:local@127.0.0.1:3307/argus_test?charset=utf8mb4"
    )

    server_url = fixture._server_url(test_url)

    assert server_url.database is None
    assert server_url.host == "127.0.0.1"
    assert server_url.query == test_url.query
