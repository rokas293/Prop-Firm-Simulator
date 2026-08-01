from __future__ import annotations

import pandas as pd
import pytest

from propbt.data.resample import resample_ohlcv
from tests.conftest import make_ohlcv


def test_resample_aggregation_correctness():
    idx = pd.date_range("2025-03-10 13:00:00", periods=10, freq="1min", tz="UTC")
    opens = list(range(10))
    highs = [o + 5 for o in opens]
    lows = [o - 5 for o in opens]
    closes = [o + 1 for o in opens]
    volumes = [10] * 10
    df = make_ohlcv(idx, opens, highs, lows, closes, volumes)

    out = resample_ohlcv(df, "5min")
    assert len(out) == 2

    first = out.iloc[0]
    assert first["open"] == opens[0]           # first bar's open
    assert first["high"] == max(highs[0:5])
    assert first["low"] == min(lows[0:5])
    assert first["close"] == closes[4]          # last bar's close in the window
    assert first["volume"] == sum(volumes[0:5])


def test_resample_label_is_window_start_no_lookahead():
    idx = pd.date_range("2025-03-10 13:00:00", periods=5, freq="1min", tz="UTC")
    df = make_ohlcv(idx, [1] * 5, [1] * 5, [1] * 5, [1] * 5, [1] * 5)
    out = resample_ohlcv(df, "5min")
    # the resampled bar must be labeled with the window START (13:00), not
    # the close time (13:04) -- otherwise downstream code could think it
    # knows the bar's content before that window has actually elapsed.
    assert out.index[0] == pd.Timestamp("2025-03-10 13:00:00", tz="UTC")


def test_resample_rejects_downsample(one_day_1min):
    with pytest.raises(ValueError):
        resample_ohlcv(one_day_1min, "30s")


def test_resample_does_not_fabricate_bars_across_gaps():
    # bars at :00 and :01, then a big gap, then a bar at :20 -- resampling
    # to 5min should NOT produce filled/fabricated bars for the empty windows.
    idx = [
        pd.Timestamp("2025-03-10 13:00:00", tz="UTC"),
        pd.Timestamp("2025-03-10 13:01:00", tz="UTC"),
        pd.Timestamp("2025-03-10 13:20:00", tz="UTC"),
    ]
    df = make_ohlcv(idx, [1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1])
    out = resample_ohlcv(df, "5min")
    # only the windows that actually contain data should appear
    assert len(out) == 2
    assert list(out.index) == [
        pd.Timestamp("2025-03-10 13:00:00", tz="UTC"),
        pd.Timestamp("2025-03-10 13:20:00", tz="UTC"),
    ]


def test_resample_preserves_utc_tz(one_day_1min):
    out = resample_ohlcv(one_day_1min, "15min")
    assert str(out.index.tz) == "UTC"
