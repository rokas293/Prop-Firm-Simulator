"""Serves candlestick bars for /api/bars, reusing propbt's own loader and
resampler (VIZ_SPEC.md: "reuse propbt's loader/resampler for bars") so the
chart always sees exactly the same OHLCV the engine traded on.

Never ships 1.7M+ rows to the browser: if the requested window at the
requested timeframe would exceed `max_points`, steps up a coarser
timeframe (still an honest resample, never an arbitrary row-drop) until it
fits.
"""
from __future__ import annotations

from typing import Dict, List

import pandas as pd

from app.backend import models
from propbt.data.loader import load_ohlcv
from propbt.data.resample import resample_ohlcv

_RAW_CACHE: Dict[str, pd.DataFrame] = {}

# ladder of resample targets to step up through when a window is too wide
_TF_LADDER = ["1min", "5min", "15min", "1h", "4h", "1D"]


class UnknownInstrument(Exception):
    def __init__(self, instrument: str):
        super().__init__(f"unknown instrument {instrument!r}")
        self.instrument = instrument


def _load_raw(instrument: str) -> pd.DataFrame:
    if instrument not in _RAW_CACHE:
        try:
            _RAW_CACHE[instrument] = load_ohlcv(instrument)
        except (KeyError, FileNotFoundError):
            raise UnknownInstrument(instrument)
    return _RAW_CACHE[instrument]


def _to_bar(ts: pd.Timestamp, row: pd.Series) -> models.Bar:
    return models.Bar(
        time=int(ts.value // 1_000_000_000), open=float(row["open"]), high=float(row["high"]),
        low=float(row["low"]), close=float(row["close"]), volume=int(row["volume"]),
    )


def get_instrument_range(instrument: str) -> tuple[int, int]:
    """(min, max) unix-second timestamps of the instrument's loaded bars --
    used by bt_session_service.py to validate a chosen session start_time
    and to pick a Random-start point, without either of those needing to
    know anything about the loader/cache themselves.
    """
    df = _load_raw(instrument)
    return int(df.index[0].value // 1_000_000_000), int(df.index[-1].value // 1_000_000_000)


def get_bars(instrument: str, tf: str, ts_from: int, ts_to: int, max_points: int = 2000) -> List[models.Bar]:
    df = _load_raw(instrument)
    start = pd.Timestamp(ts_from, unit="s", tz="UTC")
    end = pd.Timestamp(ts_to, unit="s", tz="UTC")
    window = df.loc[start:end]

    resampled = window if tf == "1min" else resample_ohlcv(window, tf)

    if len(resampled) > max_points:
        start_idx = _TF_LADDER.index(tf) if tf in _TF_LADDER else 0
        for coarser in _TF_LADDER[start_idx + 1:]:
            candidate = resample_ohlcv(window, coarser)
            resampled = candidate
            if len(candidate) <= max_points:
                break

    return [_to_bar(ts, row) for ts, row in resampled.iterrows()]
