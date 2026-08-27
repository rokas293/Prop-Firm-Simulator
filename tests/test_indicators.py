from __future__ import annotations

import pandas as pd
import pytest

from propbt.config import load_sessions
from propbt.data.indicators import atr_series, ema_series, session_vwap, true_range
from propbt.strategy.session_open import atr as scalar_atr
from tests.conftest import make_ohlcv


@pytest.fixture(scope="module")
def cfg():
    return load_sessions()


# --- true_range / atr_series --------------------------------------------------

def test_true_range_first_bar_is_nan():
    idx = pd.date_range("2025-01-06 13:00", periods=3, freq="1min", tz="UTC")
    df = make_ohlcv(idx, [100, 101, 102], [101, 102, 103], [99, 100, 101], [100, 101, 102], [1, 1, 1])
    tr = true_range(df)
    assert pd.isna(tr.iloc[0])


def test_true_range_hand_verified():
    # Same fixture as test_mean_reversion.py's test_atr_basic: high-low is
    # always 2, and |high/low - prev_close| never exceeds that, so TR == 2
    # for both non-first bars.
    idx = pd.date_range("2025-01-06 13:00", periods=3, freq="1min", tz="UTC")
    df = make_ohlcv(idx, [100, 101, 102], [101, 102, 103], [99, 100, 101], [100, 101, 102], [1, 1, 1])
    tr = true_range(df)
    assert tr.iloc[1] == pytest.approx(2.0)
    assert tr.iloc[2] == pytest.approx(2.0)


def test_atr_series_last_value_matches_scalar_atr():
    """propbt.strategy.session_open.atr() is a hand-rolled numpy loop (kept
    separate from atr_series for backtest hot-loop speed -- see its
    docstring), but both MUST compute the identical formula. This is the
    test that guarantees they stay in sync."""
    idx = pd.date_range("2025-01-06 13:00", periods=20, freq="1min", tz="UTC")
    opens = [100 + i * 0.3 for i in range(20)]
    highs = [o + 1.5 for o in opens]
    lows = [o - 1.1 for o in opens]
    closes = [o + 0.4 for o in opens]
    volumes = [10] * 20
    df = make_ohlcv(idx, opens, highs, lows, closes, volumes)

    for lookback in (2, 5, 14):
        expected = scalar_atr(df, lookback)
        actual = atr_series(df, lookback).iloc[-1]
        assert actual == pytest.approx(expected)


def test_atr_series_leading_values_nan_until_lookback_satisfied():
    idx = pd.date_range("2025-01-06 13:00", periods=5, freq="1min", tz="UTC")
    df = make_ohlcv(idx, [100] * 5, [101] * 5, [99] * 5, [100] * 5, [1] * 5)
    series = atr_series(df, 3)
    assert series.iloc[:3].isna().all()
    assert not pd.isna(series.iloc[3])


# --- ema_series ----------------------------------------------------------------

def test_ema_series_hand_verified():
    # span=3 -> alpha = 2/(3+1) = 0.5. EMA0=10; EMA1=0.5*20+0.5*10=15;
    # EMA2=0.5*30+0.5*15=22.5.
    s = pd.Series([10.0, 20.0, 30.0])
    ema = ema_series(s, span=3)
    assert ema.iloc[0] == pytest.approx(10.0)
    assert ema.iloc[1] == pytest.approx(15.0)
    assert ema.iloc[2] == pytest.approx(22.5)


# --- session_vwap ----------------------------------------------------------------

def test_session_vwap_basic_single_session(cfg):
    # 3 bars, all inside the NY session (>= 13:30 UTC on 2025-03-11 == 09:30 ET).
    idx = pd.date_range("2025-03-11 13:30", periods=3, freq="1min", tz="UTC")
    highs = [101.0, 103.0, 99.0]
    lows = [99.0, 101.0, 97.0]
    closes = [100.0, 102.0, 98.0]
    volumes = [10, 20, 10]
    df = make_ohlcv(idx, closes, highs, lows, closes, volumes)

    vwap = session_vwap(df, cfg)

    typical = [(h + l + c) / 3 for h, l, c in zip(highs, lows, closes)]
    expected_0 = typical[0]
    expected_1 = (typical[0] * 10 + typical[1] * 20) / 30
    expected_2 = (typical[0] * 10 + typical[1] * 20 + typical[2] * 10) / 40
    assert vwap.iloc[0] == pytest.approx(expected_0)
    assert vwap.iloc[1] == pytest.approx(expected_1)
    assert vwap.iloc[2] == pytest.approx(expected_2)


def test_session_vwap_resets_at_session_boundary(cfg):
    # 13:29 UTC is still London (NY opens at 13:30 UTC on this date); 13:30
    # UTC starts a fresh NY session, so its VWAP must NOT carry over London's
    # accumulated sum -- it should equal that single bar's own typical price.
    idx = pd.date_range("2025-03-11 13:28", periods=4, freq="1min", tz="UTC")
    highs = [201.0, 201.0, 51.0, 53.0]
    lows = [199.0, 199.0, 49.0, 51.0]
    closes = [200.0, 200.0, 50.0, 52.0]
    volumes = [100, 100, 5, 5]
    df = make_ohlcv(idx, closes, highs, lows, closes, volumes)

    vwap = session_vwap(df, cfg)

    ny_typical_0 = (highs[2] + lows[2] + closes[2]) / 3
    assert vwap.iloc[2] == pytest.approx(ny_typical_0)
    # and it's nowhere near the London-session price level (~200)
    assert vwap.iloc[2] < 60


def test_session_vwap_nan_during_maintenance_halt(cfg):
    # 2025-03-10 is EDT (UTC-4): 17:00-18:00 ET == 21:00-22:00 UTC.
    idx = pd.date_range("2025-03-10 21:15", periods=2, freq="1min", tz="UTC")
    df = make_ohlcv(idx, [100, 100], [101, 101], [99, 99], [100, 100], [1, 1])
    vwap = session_vwap(df, cfg)
    assert vwap.isna().all()
