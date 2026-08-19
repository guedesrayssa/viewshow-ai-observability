import pandas as pd
import pytest

from dump_explorer.time_utils import TimeConversionError, epoch_ms_to_utc, local_day, to_timezone


def test_local_day_uses_brt_instead_of_utc_day():
    values = pd.Series([1785976200000])  # 2026-08-06 00:30 UTC

    utc = epoch_ms_to_utc(values)

    assert local_day(utc, "America/Sao_Paulo").iloc[0].isoformat() == "2026-08-05"


def test_epoch_ms_to_utc_coerces_invalid_values_to_nat():
    result = epoch_ms_to_utc(pd.Series([0, "invalid"]))

    assert result.iloc[0].isoformat() == "1970-01-01T00:00:00+00:00"
    assert pd.isna(result.iloc[1])


def test_to_timezone_rejects_unknown_timezone():
    utc = epoch_ms_to_utc(pd.Series([0]))

    with pytest.raises(TimeConversionError, match="Fuso horário inválido"):
        to_timezone(utc, "America/Not_A_Zone")
