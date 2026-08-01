"""Resample 1-minute OHLCV bars up to higher timeframes. Never resamples down
(CLAUDE.md section 2) and never fabricates bars for windows with no trades --
empty windows are dropped, not filled.

Bar timestamp convention (matches the source 1-minute files): a bar labeled
`t` represents the interval [t, t+timeframe) and its `open` is the first
trade price in that window. Resampling preserves this convention (label and
closed both 'left'), so no-look-ahead code elsewhere can keep treating a
bar's own timestamp as its open time.
"""
from __future__ import annotations

import pandas as pd

_AGG = {
    "open": "first",
    "high": "max",
    "low": "min",
    "close": "last",
    "volume": "sum",
}


def resample_ohlcv(df: pd.DataFrame, rule: str) -> pd.DataFrame:
    """Resample 1-minute `df` (as returned by loader.load_ohlcv) up to `rule`
    (a pandas offset alias, e.g. '5min', '15min', '1h').

    Raises ValueError if `rule` is finer than 1 minute (that would require
    fabricating sub-minute data we don't have).
    """
    target = pd.tseries.frequencies.to_offset(rule)
    if target < pd.tseries.frequencies.to_offset("1min"):
        raise ValueError(f"Cannot resample down to {rule!r} from 1-minute bars")

    missing = [c for c in _AGG if c not in df.columns]
    if missing:
        raise ValueError(f"df is missing required columns: {missing}")

    out = df.resample(rule, label="left", closed="left").agg(_AGG)
    out = out.dropna(subset=["open"])
    out["volume"] = out["volume"].astype("uint64")
    return out
