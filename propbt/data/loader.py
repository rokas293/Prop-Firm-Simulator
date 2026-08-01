"""Databento 1-minute OHLCV ingestion.

Expected on-disk format (confirmed against the actual files, not assumed):
a parquet file whose DataFrame has a tz-aware UTC DatetimeIndex named
`ts_event`, and float64 columns open/high/low/close plus a uint64 `volume`
column. No symbol/expiration/roll metadata is embedded in the files.

This module only *reads and validates* -- it never fabricates bars (no
forward-fill) and never silently reorders or drops rows. If the data
doesn't match the expected shape, it raises rather than guessing.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from propbt.config import load_data_paths

REQUIRED_COLUMNS = {
    "open": "float64",
    "high": "float64",
    "low": "float64",
    "close": "float64",
    "volume": "uint64",
}
INDEX_NAME = "ts_event"

# Gaps at/around this many minutes are the recurring CME Globex daily
# maintenance halt (17:00-18:00 America/New_York), not a data defect.
MAINTENANCE_HALT_MINUTES = (55, 75)
# Gaps at least this long are almost certainly a weekend/holiday closure.
WEEKEND_GAP = pd.Timedelta(hours=40)


class SchemaError(ValueError):
    """Raised when a parquet file doesn't match the expected Databento format."""


def _path_for(symbol: str, data_paths: Optional[Dict[str, Path]] = None) -> Path:
    paths = data_paths if data_paths is not None else load_data_paths()
    if symbol not in paths:
        raise KeyError(f"No configured data path for symbol {symbol!r}. Known: {sorted(paths)}")
    return paths[symbol]


def validate_schema(df: pd.DataFrame, *, symbol: str = "") -> None:
    """Raise SchemaError if `df` doesn't match the expected loader format."""
    label = f" ({symbol})" if symbol else ""

    if not isinstance(df.index, pd.DatetimeIndex):
        raise SchemaError(f"Expected a DatetimeIndex{label}, got {type(df.index)}")
    if df.index.name != INDEX_NAME:
        raise SchemaError(f"Expected index named {INDEX_NAME!r}{label}, got {df.index.name!r}")
    if df.index.tz is None:
        raise SchemaError(f"Index is tz-naive{label} -- expected tz-aware UTC")
    if str(df.index.tz) != "UTC":
        raise SchemaError(f"Index tz is {df.index.tz}{label} -- expected UTC")

    missing = set(REQUIRED_COLUMNS) - set(df.columns)
    if missing:
        raise SchemaError(f"Missing required columns{label}: {sorted(missing)}")

    for col, expected_dtype in REQUIRED_COLUMNS.items():
        actual = str(df[col].dtype)
        if actual != expected_dtype:
            raise SchemaError(
                f"Column {col!r}{label} has dtype {actual}, expected {expected_dtype}"
            )


def load_ohlcv(symbol: str, data_paths: Optional[Dict[str, Path]] = None) -> pd.DataFrame:
    """Load one symbol's 1-minute bars as a tidy, tz-aware UTC DataFrame.

    Raises SchemaError if the file doesn't match the expected format, and
    ValueError if timestamps aren't strictly monotonic increasing (a real
    data problem -- we don't silently re-sort and mask it).
    """
    path = _path_for(symbol, data_paths)
    if not path.exists():
        raise FileNotFoundError(f"No data file for {symbol!r} at {path}")

    df = pd.read_parquet(path)
    validate_schema(df, symbol=symbol)

    if not df.index.is_monotonic_increasing:
        raise ValueError(f"{symbol}: ts_event index is not monotonic increasing")

    return df


@dataclass
class GapSummary:
    total: int
    maintenance_halt: int
    weekend_holiday: int
    other: int
    other_gaps: pd.Series = field(repr=False)  # index=gap start ts, value=Timedelta


@dataclass
class IntegrityReport:
    symbol: str
    n_rows: int
    first_ts: pd.Timestamp
    last_ts: pd.Timestamp
    is_monotonic: bool
    n_duplicate_timestamps: int
    n_nulls: Dict[str, int]
    n_zero_volume: int
    n_negative_volume: int
    n_bad_high_low: int
    n_bad_high_open_close: int
    n_bad_low_open_close: int
    n_nonpositive_price: int
    gaps: GapSummary

    def is_clean(self) -> bool:
        return (
            self.is_monotonic
            and self.n_duplicate_timestamps == 0
            and sum(self.n_nulls.values()) == 0
            and self.n_negative_volume == 0
            and self.n_bad_high_low == 0
            and self.n_bad_high_open_close == 0
            and self.n_bad_low_open_close == 0
            and self.n_nonpositive_price == 0
        )


def _classify_gaps(idx: pd.DatetimeIndex) -> GapSummary:
    deltas = idx.to_series().diff().dropna()
    gaps = deltas[deltas > pd.Timedelta(minutes=1)]

    is_halt = (gaps >= pd.Timedelta(minutes=MAINTENANCE_HALT_MINUTES[0])) & (
        gaps <= pd.Timedelta(minutes=MAINTENANCE_HALT_MINUTES[1])
    )
    is_weekend = gaps >= WEEKEND_GAP
    is_other = ~is_halt & ~is_weekend

    return GapSummary(
        total=len(gaps),
        maintenance_halt=int(is_halt.sum()),
        weekend_holiday=int(is_weekend.sum()),
        other=int(is_other.sum()),
        other_gaps=gaps[is_other].sort_values(ascending=False),
    )


def compute_integrity_report(df: pd.DataFrame, symbol: str = "") -> IntegrityReport:
    """Read-only integrity check. Never mutates `df`."""
    idx = df.index
    nulls = {col: int(df[col].isnull().sum()) for col in df.columns}

    high, low, open_, close = df["high"], df["low"], df["open"], df["close"]
    bad_hl = int((high < low).sum())
    bad_hoc = int((high < pd.concat([open_, close], axis=1).max(axis=1)).sum())
    bad_loc = int((low > pd.concat([open_, close], axis=1).min(axis=1)).sum())
    nonpositive = int((df[["open", "high", "low", "close"]] <= 0).any(axis=1).sum())

    return IntegrityReport(
        symbol=symbol,
        n_rows=len(df),
        first_ts=idx.min() if len(idx) else pd.NaT,
        last_ts=idx.max() if len(idx) else pd.NaT,
        is_monotonic=idx.is_monotonic_increasing,
        n_duplicate_timestamps=int(idx.duplicated().sum()),
        n_nulls=nulls,
        n_zero_volume=int((df["volume"] == 0).sum()),
        n_negative_volume=int((df["volume"].astype("int64") < 0).sum()),
        n_bad_high_low=bad_hl,
        n_bad_high_open_close=bad_hoc,
        n_bad_low_open_close=bad_loc,
        n_nonpositive_price=nonpositive,
        gaps=_classify_gaps(idx),
    )


def _third_friday(year: int, month: int) -> pd.Timestamp:
    d = pd.Timestamp(year=year, month=month, day=1)
    first_friday = d + pd.Timedelta(days=(4 - d.dayofweek) % 7)
    return first_friday + pd.Timedelta(weeks=2)


def estimate_roll_days(df: pd.DataFrame, days_before_expiry: int = 8) -> List[pd.Timestamp]:
    """Heuristic, ESTIMATED quarterly futures roll dates covering `df`'s range.

    The source files carry no symbol/expiration/instrument_id column, so the
    actual contract-switch date cannot be read from the data -- this is a
    calendar approximation (days_before_expiry days before the 3rd Friday of
    Mar/Jun/Sep/Dec), not ground truth. Do not treat these as authoritative;
    they're a placeholder until the real Databento roll rule is confirmed
    (see CLAUDE.md section 2).
    """
    if len(df) == 0:
        return []
    start_year, end_year = df.index.min().year, df.index.max().year
    estimates = []
    for year in range(start_year, end_year + 1):
        for month in (3, 6, 9, 12):
            roll = (_third_friday(year, month) - pd.Timedelta(days=days_before_expiry)).tz_localize("UTC")
            if df.index.min() <= roll <= df.index.max():
                estimates.append(roll)
    return sorted(estimates)


def add_roll_flags(df: pd.DataFrame, roll_days: Optional[List[pd.Timestamp]] = None) -> pd.DataFrame:
    """Return a copy of `df` with a boolean `roll_day` column marking bars
    whose UTC calendar date falls on an estimated roll date. Does not merge
    or alter any price/volume data -- flagging only, per CLAUDE.md's "never
    merge across a roll silently."
    """
    roll_days = roll_days if roll_days is not None else estimate_roll_days(df)
    roll_dates = {ts.date() for ts in roll_days}
    out = df.copy()
    out["roll_day"] = out.index.normalize().date
    out["roll_day"] = out["roll_day"].isin(roll_dates)
    return out
