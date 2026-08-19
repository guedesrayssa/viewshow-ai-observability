import pytest

from dump_explorer.config import ConfigurationError, load_settings


def test_load_settings_requires_database_url():
    with pytest.raises(ConfigurationError, match="ARGUS_DATABASE_URL"):
        load_settings({})


def test_load_settings_rejects_limit_above_hard_cap():
    env = {"ARGUS_DATABASE_URL": "mysql+pymysql://x", "ARGUS_MAX_ROWS": "100001"}
    with pytest.raises(ConfigurationError, match="100000"):
        load_settings(env)


def test_load_settings_rejects_non_numeric_limit():
    env = {"ARGUS_DATABASE_URL": "mysql+pymysql://x", "ARGUS_MAX_ROWS": "many"}
    with pytest.raises(ConfigurationError, match="ARGUS_MAX_ROWS"):
        load_settings(env)
