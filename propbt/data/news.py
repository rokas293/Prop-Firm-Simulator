"""News calendar loader (CLAUDE.md section 4). The source is whatever the
user exports from their economic calendar provider, so this is
deliberately format-tolerant: column names/casing and timestamp format
aren't assumed, only that SOME column looks like a timestamp, an
event/title, and an impact rating.
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable, List, Optional, Union

import pandas as pd

TIMESTAMP_COLUMN_CANDIDATES = ["timestamp_utc", "timestamp", "time", "datetime", "date", "ts", "ts_event"]
EVENT_COLUMN_CANDIDATES = ["event", "title", "name", "description"]
IMPACT_COLUMN_CANDIDATES = ["impact", "importance", "priority", "volatility"]

DEFAULT_HIGH_IMPACT_VALUES = ("high",)


class NewsFormatError(ValueError):
    """Raised when news_events.csv doesn't have a recognizable timestamp/event/impact column."""


def _find_column(columns: List[str], candidates: List[str]) -> Optional[str]:
    lower_map = {c.lower().strip(): c for c in columns}
    for cand in candidates:
        if cand in lower_map:
            return lower_map[cand]
    return None


def load_news_events(path: Union[str, Path]) -> pd.DataFrame:
    """Load a news_events.csv into a tidy DataFrame: tz-aware UTC
    DatetimeIndex named `timestamp`, columns `event` (str) and `impact`
    (str, lowercased). Raises NewsFormatError if the required columns
    can't be located, or if any timestamp fails to parse.
    """
    path = Path(path)
    raw = pd.read_csv(path)
    raw.columns = [str(c).strip() for c in raw.columns]

    ts_col = _find_column(list(raw.columns), TIMESTAMP_COLUMN_CANDIDATES)
    event_col = _find_column(list(raw.columns), EVENT_COLUMN_CANDIDATES)
    impact_col = _find_column(list(raw.columns), IMPACT_COLUMN_CANDIDATES)

    if ts_col is None:
        raise NewsFormatError(f"{path.name}: no timestamp column found (looked for {TIMESTAMP_COLUMN_CANDIDATES}); got columns {list(raw.columns)}")
    if event_col is None:
        raise NewsFormatError(f"{path.name}: no event/title column found (looked for {EVENT_COLUMN_CANDIDATES}); got columns {list(raw.columns)}")
    if impact_col is None:
        raise NewsFormatError(f"{path.name}: no impact column found (looked for {IMPACT_COLUMN_CANDIDATES}); got columns {list(raw.columns)}")

    # utc=True both converts tz-aware timestamps to UTC and localizes
    # tz-naive ones AS UTC (CLAUDE.md: news_events.csv timestamps are UTC).
    ts = pd.to_datetime(raw[ts_col], utc=True, errors="coerce")
    bad = ts.isna()
    if bad.any():
        bad_values = raw.loc[bad, ts_col].tolist()
        raise NewsFormatError(f"{path.name}: {bad.sum()} row(s) have an unparseable timestamp, e.g. {bad_values[:5]!r}")

    # .to_numpy() so the dict values are plain arrays -- otherwise pandas
    # aligns Series-valued dict entries to the new index by LABEL (their
    # original 0..n-1 RangeIndex vs. the DatetimeIndex here), not position,
    # silently producing all-NaN columns.
    out = pd.DataFrame(
        {
            "event": raw[event_col].astype(str).str.strip().to_numpy(),
            "impact": raw[impact_col].astype(str).str.strip().str.lower().to_numpy(),
        },
        index=pd.DatetimeIndex(ts, name="timestamp"),
    )
    out = out.sort_index()
    if out.index.duplicated().any():
        raise NewsFormatError(f"{path.name}: duplicate event timestamps found")
    return out


def filter_impact(df: pd.DataFrame, impact_values: Iterable[str] = DEFAULT_HIGH_IMPACT_VALUES) -> pd.DataFrame:
    """Keep only rows whose (already-lowercased) `impact` is in `impact_values`."""
    allowed = {v.strip().lower() for v in impact_values}
    return df[df["impact"].isin(allowed)]
