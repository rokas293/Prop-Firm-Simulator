"""Chart/analysis indicators. Shared with the strategy engine where
possible (propbt.strategy.session_open.atr()'s scalar lookback reuses
atr_series() here) so the viz backend's /api/indicators endpoint renders
exactly what the strategy computed, never a parallel reimplementation
(VIZ_SPEC section 6/8).
"""
from __future__ import annotations

import pandas as pd

from propbt.config import SessionsConfig
from propbt.data.sessions import tag_sessions


def true_range(df: pd.DataFrame) -> pd.Series:
    """Per-bar true range: max(high-low, |high-prev_close|, |low-prev_close|).
    First bar is NaN (no previous close to compare against)."""
    prev_close = df["close"].shift(1)
    return pd.concat(
        [df["high"] - df["low"], (df["high"] - prev_close).abs(), (df["low"] - prev_close).abs()],
        axis=1,
    ).max(axis=1, skipna=False)


def atr_series(df: pd.DataFrame, lookback_bars: int) -> pd.Series:
    """Simple (non-Wilder) moving average of true range over `lookback_bars`
    -- the exact quantity propbt.strategy.session_open.atr()'s scalar
    lookback returns the latest value of, as a full series for charting."""
    return true_range(df).rolling(lookback_bars, min_periods=lookback_bars).mean()


def ema_series(series: pd.Series, span: int) -> pd.Series:
    """Standard exponential moving average (adjust=False: the recursive
    definition, not pandas' bias-corrected startup alternative)."""
    return series.ewm(span=span, adjust=False).mean()


def session_vwap(df: pd.DataFrame, sessions_config: SessionsConfig) -> pd.Series:
    """Volume-weighted average price, resetting at the start of each
    session (CLAUDE.md section 4: mean-reversion fades back toward "fair
    value / session VWAP"). Uses typical price (H+L+C)/3.

    Resets on a change in EITHER `session` or `trading_day` (not session
    name alone) so a trading day whose last session happens to share a name
    with the next day's first session never gets its VWAP wrongly
    continued across the boundary. Bars outside any session (the
    maintenance halt) are excluded -- VWAP is undefined there.
    """
    tagged = tag_sessions(df, sessions_config)
    session = tagged["session"]
    trading_day = tagged["trading_day"].astype(object)

    is_new_group = (
        (session != session.shift(1))
        | (trading_day != trading_day.shift(1))
        | session.isna()
    )
    group = is_new_group.cumsum()

    typical_price = (df["high"] + df["low"] + df["close"]) / 3.0
    pv = typical_price * df["volume"]

    cum_pv = pv.groupby(group).cumsum()
    cum_vol = df["volume"].groupby(group).cumsum()
    vwap = cum_pv / cum_vol
    return vwap.where(session.notna())
