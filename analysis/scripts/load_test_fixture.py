"""Load the sanitized notebook fixture into the isolated ``argus_test`` schema."""

import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.engine import URL, make_url

FIXTURE_PATH = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "argus_fixture.sql"
FIXTURE_TABLES = (
    "signal_bucket",
    "signal_meta",
    "nr_run",
    "player_hourly",
    "incidents",
    "incident_label",
    "tsuru_event",
    "live_event",
    "live_active_15min",
)
TEST_DATABASE = "argus_test"


def _parse_test_url(database_url: str) -> URL:
    """Accept only a root URL pointed at the dedicated local test database."""
    url = make_url(database_url)
    if url.database != TEST_DATABASE:
        raise ValueError("o fixture só pode usar o banco argus_test")
    if url.get_backend_name() != "mysql" or url.username != "root":
        raise ValueError("o fixture exige uma URL MySQL local com a credencial root de teste")
    return url


def _fixture_statements() -> list[str]:
    """Split the repository-owned fixture, whose statements deliberately contain no semicolons."""
    return [
        statement.strip() for statement in FIXTURE_PATH.read_text().split(";") if statement.strip()
    ]


def load_test_fixture(database_url: str) -> None:
    """Recreate only sanitized fixture tables in ``argus_test``.

    The database is created from a server URL first, so a missing CREATE privilege
    aborts before this function connects to or clears any schema tables.
    """
    test_url = _parse_test_url(database_url)
    server_url = test_url.set(database=None)

    server_engine = create_engine(server_url, pool_pre_ping=True)
    try:
        with server_engine.begin() as connection:
            connection.exec_driver_sql(
                "CREATE DATABASE IF NOT EXISTS argus_test CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"
            )
    finally:
        server_engine.dispose()

    test_engine = create_engine(test_url, pool_pre_ping=True)
    try:
        with test_engine.begin() as connection:
            for table_name in FIXTURE_TABLES:
                connection.exec_driver_sql(f"DROP TABLE IF EXISTS `{table_name}`")
            for statement in _fixture_statements():
                connection.exec_driver_sql(statement)
    finally:
        test_engine.dispose()


def main() -> None:
    """Load the URL configured privately in ``.env`` or the shell environment."""
    load_dotenv()
    database_url = os.environ.get("ARGUS_TEST_DATABASE_URL", "")
    if not database_url:
        raise SystemExit("ARGUS_TEST_DATABASE_URL não configurada")
    load_test_fixture(database_url)


if __name__ == "__main__":
    main()
