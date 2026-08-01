from __future__ import annotations

import pandas as pd
import pytest


def make_ohlcv(index_utc, opens, highs, lows, closes, volumes) -> pd.DataFrame:
    """Build a DataFrame matching the loader's expected schema."""
    idx = pd.DatetimeIndex(index_utc, name="ts_event", tz="UTC")
    return pd.DataFrame(
        {
            "open": pd.array(opens, dtype="float64"),
            "high": pd.array(highs, dtype="float64"),
            "low": pd.array(lows, dtype="float64"),
            "close": pd.array(closes, dtype="float64"),
            "volume": pd.array(volumes, dtype="uint64"),
        },
        index=idx,
    )


@pytest.fixture
def one_day_1min() -> pd.DataFrame:
    """~2 hours of clean synthetic 1-minute bars."""
    idx = pd.date_range("2025-03-10 13:00:00", periods=120, freq="1min", tz="UTC")
    n = len(idx)
    opens = [100.0 + i * 0.25 for i in range(n)]
    closes = [o + 0.25 for o in opens]
    highs = [max(o, c) + 0.25 for o, c in zip(opens, closes)]
    lows = [min(o, c) - 0.25 for o, c in zip(opens, closes)]
    volumes = [100 + i for i in range(n)]
    return make_ohlcv(idx, opens, highs, lows, closes, volumes)
