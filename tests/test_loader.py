from __future__ import annotations

import pandas as pd
import pytest

from propbt.config import load_data_paths
from propbt.data.loader import (
    SchemaError,
    compute_integrity_report,
    estimate_roll_days,
    load_ohlcv,
    validate_schema,
)
from tests.conftest import make_ohlcv


def test_validate_schema_accepts_good_df(one_day_1min):
    validate_schema(one_day_1min, symbol="TEST")  # should not raise


def test_validate_schema_rejects_tz_naive_index(one_day_1min):
    bad = one_day_1min.copy()
    bad.index = bad.index.tz_localize(None)
    bad.index.name = "ts_event"
    with pytest.raises(SchemaError, match="tz-naive"):
        validate_schema(bad)


def test_validate_schema_rejects_wrong_index_name(one_day_1min):
    bad = one_day_1min.copy()
    bad.index.name = "timestamp"
    with pytest.raises(SchemaError, match="ts_event"):
        validate_schema(bad)


def test_validate_schema_rejects_missing_column(one_day_1min):
    bad = one_day_1min.drop(columns=["volume"])
    with pytest.raises(SchemaError, match="volume"):
        validate_schema(bad)


def test_validate_schema_rejects_wrong_dtype(one_day_1min):
    bad = one_day_1min.copy()
    bad["volume"] = bad["volume"].astype("int64")
    with pytest.raises(SchemaError, match="volume"):
        validate_schema(bad)


def test_compute_integrity_report_clean_data(one_day_1min):
    report = compute_integrity_report(one_day_1min, symbol="TEST")
    assert report.is_clean()
    assert report.n_rows == 120
    assert report.n_duplicate_timestamps == 0
    assert report.gaps.total == 0


def test_compute_integrity_report_flags_duplicate_timestamps(one_day_1min):
    dup = pd.concat([one_day_1min, one_day_1min.iloc[[0]]]).sort_index()
    report = compute_integrity_report(dup, symbol="TEST")
    assert report.n_duplicate_timestamps == 1
    assert not report.is_clean()


def test_compute_integrity_report_classifies_gaps():
    # bar1 -> (maintenance-halt gap, ~61min) -> bar2 -> (weekend gap, ~50h) -> bar3 -> (odd 5min gap) -> bar4
    idx = [
        pd.Timestamp("2025-03-07 20:59:00", tz="UTC"),
        pd.Timestamp("2025-03-07 22:00:00", tz="UTC"),        # +61min: maintenance halt
        pd.Timestamp("2025-03-10 13:00:00", tz="UTC"),        # +~63h: weekend
        pd.Timestamp("2025-03-10 13:07:00", tz="UTC"),        # +7min: "other"
    ]
    df = make_ohlcv(idx, [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1])
    report = compute_integrity_report(df, symbol="TEST")
    assert report.gaps.total == 3
    assert report.gaps.maintenance_halt == 1
    assert report.gaps.weekend_holiday == 1
    assert report.gaps.other == 1


def test_compute_integrity_report_flags_bad_ohlc():
    idx = pd.date_range("2025-03-10 13:00:00", periods=2, freq="1min", tz="UTC")
    df = make_ohlcv(idx, [10, 10], [9, 12], [11, 8], [10, 10], [1, 1])  # row0: high<low
    report = compute_integrity_report(df, symbol="TEST")
    assert report.n_bad_high_low == 1
    assert not report.is_clean()


def test_estimate_roll_days_near_third_friday_minus_8(one_day_1min):
    idx = pd.date_range("2025-01-01", "2025-12-31", freq="1D", tz="UTC")
    df = make_ohlcv(idx, [1] * len(idx), [1] * len(idx), [1] * len(idx), [1] * len(idx), [1] * len(idx))
    rolls = estimate_roll_days(df)
    assert len(rolls) == 4  # Mar/Jun/Sep/Dec
    months = sorted(r.month for r in rolls)
    assert months == [3, 6, 9, 12]
    for r in rolls:
        # 3rd Friday minus 8 days should land within the 2nd/3rd week of the month
        assert 3 <= r.day <= 17


def test_load_ohlcv_real_files_match_schema_and_are_clean():
    paths = load_data_paths()
    for symbol in ("MES", "MNQ"):
        if symbol not in paths or not paths[symbol].exists():
            pytest.skip(f"{symbol} data file not present")
        df = load_ohlcv(symbol)
        validate_schema(df, symbol=symbol)  # should not raise
        report = compute_integrity_report(df, symbol=symbol)
        assert report.is_clean(), f"{symbol}: {report}"
        assert report.n_rows > 0
