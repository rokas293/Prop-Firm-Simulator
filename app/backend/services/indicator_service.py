"""Indicator overlays for /api/indicators. Computed by reusing propbt
directly (propbt.data.indicators, propbt.data.resample) so the chart shows
exactly the same math the engine would use, never a parallel
reimplementation (VIZ_SPEC section 6/8).

Indicators are computed on bars already resampled to the requested `tf` --
same convention as /api/bars, so a "15min EMA(20)" means what it says (EMA
over 15-minute closes), not a 1-minute EMA subsampled onto a 15-minute grid.
"""
from __future__ import annotations

from typing import Dict, List

import pandas as pd

from app.backend import models
from app.backend.services.bar_service import _load_raw
from propbt.config import load_sessions
from propbt.data.indicators import atr_series, ema_series, session_vwap
from propbt.data.resample import resample_ohlcv

# Generous warm-up window fetched *before* `from` so EMA/ATR have converged
# and VWAP has its full current session's data by the time the visible
# range starts -- discarded from the response, kept only for context.
WARMUP_MINUTES = 10 * 24 * 60

ATR_LOOKBACK_BARS = 14
EMA_SHORT_SPAN = 20
EMA_LONG_SPAN = 50

KNOWN_INDICATORS = {"vwap", "ema20", "ema50", "atr14"}

# VWAP restarts with every session/trading day, and a session is shorter than a
# day, so a VWAP point depends on nothing earlier than the start of its own
# session. get_indicators_as_of therefore computes it over just this much before
# the first point it returns -- identical values, and the (slow) session tagging
# only runs on those bars instead of the whole warm-up.
VWAP_LOOKBACK_MINUTES = 36 * 60


class UnknownIndicator(Exception):
    def __init__(self, names):
        super().__init__(f"unknown indicator(s): {sorted(names)}. Known: {sorted(KNOWN_INDICATORS)}")


def _compute_series(bars: pd.DataFrame, which: List[str], vwap_bars: pd.DataFrame | None = None) -> Dict[str, pd.Series]:
    sessions_cfg = load_sessions()
    series: Dict[str, pd.Series] = {}
    if "vwap" in which:
        series["vwap"] = session_vwap(bars if vwap_bars is None else vwap_bars, sessions_cfg)
    if "ema20" in which:
        series["ema20"] = ema_series(bars["close"], EMA_SHORT_SPAN)
    if "ema50" in which:
        series["ema50"] = ema_series(bars["close"], EMA_LONG_SPAN)
    if "atr14" in which:
        series["atr14"] = atr_series(bars, ATR_LOOKBACK_BARS)
    return series


def _to_points(series: Dict[str, pd.Series], visible_from: pd.Timestamp) -> Dict[str, List[models.IndicatorPoint]]:
    result: Dict[str, List[models.IndicatorPoint]] = {}
    for name, s in series.items():
        s = s[s.index >= visible_from].dropna()
        result[name] = [
            models.IndicatorPoint(time=int(ts.value // 1_000_000_000), value=float(v)) for ts, v in s.items()
        ]
    return result


def get_indicators(
    instrument: str, tf: str, ts_from: int, ts_to: int, which: List[str]
) -> Dict[str, List[models.IndicatorPoint]]:
    unknown = set(which) - KNOWN_INDICATORS
    if unknown:
        raise UnknownIndicator(unknown)

    df = _load_raw(instrument)
    start = pd.Timestamp(ts_from, unit="s", tz="UTC") - pd.Timedelta(minutes=WARMUP_MINUTES)
    end = pd.Timestamp(ts_to, unit="s", tz="UTC")
    window = df.loc[start:end]

    bars = window if tf == "1min" else resample_ohlcv(window, tf)
    return _to_points(_compute_series(bars, which), pd.Timestamp(ts_from, unit="s", tz="UTC"))


def get_indicators_as_of(
    instrument: str, tf: str, ts_from: int, cursor: int, since: int, which: List[str]
) -> Dict[str, List[models.IndicatorPoint]]:
    """Indicators as a replay at `cursor` sees them (FXR_V2_SPEC.md section 5,
    G5): computed ONLY from 1-minute bars at or before `cursor` (the cursor bar
    is revealed whole), resampled to `tf` -- so the newest candle is the partial
    one the replay is drawing, and no value can depend on a later bar. The
    frontend never recomputes them: it draws these points for the forming
    candle and the ones completed since the history it loaded.

    The warm-up starts where /api/indicators' own does for the same `ts_from`
    (WARMUP_MINUTES before it), so a point here equals the one a single
    /api/indicators call would give for that bar, bit for bit. Only points at or
    after `since` are returned (a step wants just the newest, not the history).
    """
    unknown = set(which) - KNOWN_INDICATORS
    if unknown:
        raise UnknownIndicator(unknown)

    df = _load_raw(instrument)
    start = pd.Timestamp(ts_from, unit="s", tz="UTC") - pd.Timedelta(minutes=WARMUP_MINUTES)
    end = pd.Timestamp(cursor, unit="s", tz="UTC")
    # Label slicing is inclusive: bars with open time <= cursor, nothing after.
    window = df.loc[start:end]

    bars = window if tf == "1min" else resample_ohlcv(window, tf)
    first = pd.Timestamp(max(since, ts_from), unit="s", tz="UTC")
    vwap_bars = None
    if "vwap" in which:
        vwap_window = df.loc[first - pd.Timedelta(minutes=VWAP_LOOKBACK_MINUTES):end]
        vwap_bars = vwap_window if tf == "1min" else resample_ohlcv(vwap_window, tf)
    return _to_points(_compute_series(bars, which, vwap_bars), first)
