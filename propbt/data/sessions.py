"""Session windows, fair value, and CME/Topstep trading-day attribution.

All wall-clock logic is anchored to America/New_York and goes through
zoneinfo so DST transitions are handled correctly -- never hardcode a UTC
offset here.

Trading day boundary (CLAUDE.md section 3): the CME/Topstep trading day runs
18:00 ET -> 17:00 ET the next calendar day, with a 17:00-18:00 ET
maintenance halt. A bar at NY wall-clock time >= 18:00 belongs to the
*following* calendar date's trading day; a bar at NY wall-clock time < 17:00
belongs to that calendar date's trading day. This is what makes Asia
(20:00 ET), the following London (03:00 ET) and NY (09:30 ET) share one
trading day.
"""
from __future__ import annotations

from datetime import date, time
from typing import Dict, Optional, Tuple
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from propbt.config import SessionsConfig

MINUTES_PER_DAY = 24 * 60


def _minutes(hour: int, minute: int) -> int:
    return hour * 60 + minute


def trading_day(ts_utc: pd.Timestamp, config: SessionsConfig) -> Optional[date]:
    """Map a single UTC timestamp to the CME/Topstep trading day it belongs
    to. Returns None if `ts_utc` falls in the 17:00-18:00 ET maintenance
    halt (no bars should exist there in real data).
    """
    tz = ZoneInfo(config.timezone)
    ts_ny = ts_utc.tz_convert(tz)
    b = config.trading_day_boundary
    close_t, reopen_t = time(b.close_hour, b.close_minute), time(b.reopen_hour, b.reopen_minute)
    t = ts_ny.time()
    if t >= reopen_t:
        return (ts_ny + pd.Timedelta(days=1)).date()
    if t < close_t:
        return ts_ny.date()
    return None  # maintenance halt


def add_trading_day(df: pd.DataFrame, config: SessionsConfig) -> pd.DataFrame:
    """Return a copy of `df` with a `trading_day` column (python `date`,
    NaT/None during the maintenance halt). Vectorized equivalent of
    `trading_day()`.
    """
    tz = ZoneInfo(config.timezone)
    ny_idx = df.index.tz_convert(tz)
    minutes_of_day = ny_idx.hour * 60 + ny_idx.minute
    b = config.trading_day_boundary
    close_m, reopen_m = _minutes(b.close_hour, b.close_minute), _minutes(b.reopen_hour, b.reopen_minute)

    is_next = minutes_of_day >= reopen_m
    is_halt = (minutes_of_day >= close_m) & (minutes_of_day < reopen_m)

    calendar_day = pd.Series(ny_idx.normalize(), index=df.index)
    trading_day_ts = calendar_day.where(~is_next, calendar_day + pd.Timedelta(days=1))
    trading_day_ts = trading_day_ts.dt.tz_localize(None)
    trading_day_dates = trading_day_ts.dt.date.mask(is_halt, None)

    out = df.copy()
    out["trading_day"] = trading_day_dates
    return out


def session_anchor_utc(trading_day_date: date, session_name: str, config: SessionsConfig) -> pd.Timestamp:
    """UTC timestamp of `session_name`'s anchor within a given trading day."""
    if session_name not in config.anchors:
        raise KeyError(f"Unknown session {session_name!r}. Known: {sorted(config.anchors)}")
    anchor = config.anchors[session_name]
    tz = ZoneInfo(config.timezone)
    for delta_days in (-1, 0):
        candidate_date = trading_day_date + pd.Timedelta(days=delta_days)
        candidate_ny = pd.Timestamp(
            year=candidate_date.year, month=candidate_date.month, day=candidate_date.day,
            hour=anchor.hour, minute=anchor.minute, tz=tz,
        )
        if trading_day(candidate_ny.tz_convert("UTC"), config) == trading_day_date:
            return candidate_ny.tz_convert("UTC")
    raise ValueError(f"Could not place anchor {session_name!r} within trading day {trading_day_date}")


def session_windows(trading_day_date: date, config: SessionsConfig) -> Dict[str, Tuple[pd.Timestamp, pd.Timestamp]]:
    """Per-session (start, end) UTC windows for one trading day. Each
    session's window runs from its own anchor to the next chronological
    anchor; the last session runs to the trading-day close (17:00 ET).
    """
    anchors = {name: session_anchor_utc(trading_day_date, name, config) for name in config.anchors}
    ordered = sorted(anchors.items(), key=lambda kv: kv[1])

    tz = ZoneInfo(config.timezone)
    b = config.trading_day_boundary
    close_ts = pd.Timestamp(
        year=trading_day_date.year, month=trading_day_date.month, day=trading_day_date.day,
        hour=b.close_hour, minute=b.close_minute, tz=tz,
    ).tz_convert("UTC")

    windows = {}
    for i, (name, start) in enumerate(ordered):
        end = ordered[i + 1][1] if i + 1 < len(ordered) else close_ts
        windows[name] = (start, end)
    return windows


def fair_value(df: pd.DataFrame, anchor_ts_utc: pd.Timestamp) -> Optional[Tuple[pd.Timestamp, float]]:
    """The fair value for a session/news anchor: close of the 1-minute bar
    immediately *before* `anchor_ts_utc`. Returns None if there's no prior
    bar (e.g. anchor is before the start of the data).
    """
    pos = df.index.searchsorted(anchor_ts_utc, side="left")
    if pos == 0:
        return None
    ts = df.index[pos - 1]
    return ts, float(df["close"].iloc[pos - 1])


def tag_sessions(df: pd.DataFrame, config: SessionsConfig) -> pd.DataFrame:
    """Return a copy of `df` with `trading_day` and `session` columns added.
    `session` is whichever configured anchor's window the bar falls into
    (see `session_windows`); bars in the maintenance halt get `session=None`.
    """
    tz = ZoneInfo(config.timezone)
    ny_idx = df.index.tz_convert(tz)
    minutes_of_day = ny_idx.hour * 60 + ny_idx.minute
    b = config.trading_day_boundary
    close_m, reopen_m = _minutes(b.close_hour, b.close_minute), _minutes(b.reopen_hour, b.reopen_minute)

    is_next = minutes_of_day >= reopen_m
    is_halt = (minutes_of_day >= close_m) & (minutes_of_day < reopen_m)
    # minutes elapsed since this trading day's 18:00 ET reopen -- computed
    # from wall-clock time only, so it's identical every day regardless of
    # DST (DST only changes the UTC offset, not the NY-local ordering).
    minutes_since_start = np.where(
        is_next, minutes_of_day - reopen_m, (MINUTES_PER_DAY - reopen_m) + minutes_of_day
    )

    def _anchor_since_start(hour: int, minute: int) -> int:
        m = _minutes(hour, minute)
        return (m - reopen_m) if m >= reopen_m else (MINUTES_PER_DAY - reopen_m) + m

    anchor_offsets = sorted(
        ((name, _anchor_since_start(a.hour, a.minute)) for name, a in config.anchors.items()),
        key=lambda kv: kv[1],
    )
    names = [name for name, _ in anchor_offsets]
    trading_day_length = MINUTES_PER_DAY - (reopen_m - close_m)
    edges = np.array([offset for _, offset in anchor_offsets] + [trading_day_length])

    session_idx = np.searchsorted(edges, minutes_since_start, side="right") - 1
    session_idx = np.clip(session_idx, 0, len(names) - 1)
    session = np.array(names, dtype=object)[session_idx]
    session = np.where(is_halt, None, session)

    out = add_trading_day(df, config)
    out["session"] = session
    return out
