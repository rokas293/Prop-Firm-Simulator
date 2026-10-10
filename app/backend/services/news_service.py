"""The economic calendar (FXR_V2_SPEC.md section 6, phase G7), read from
news_events.csv through propbt's own loader (propbt/data/news.py), so the chart
shows exactly the events the automated news leg trades around.

What this serves is the SCHEDULE only: when, which event, its impact. The file
holds nothing about an event's outcome (no actual / forecast / previous), and
nothing here adds it -- a scheduled event ahead of the replay cursor is public
in advance and fine to show; what the number turned out to be is not.

The "no news trading" prop restriction is enforced against the same list:
`window_refusal` is the one rule, used when a client persists a position.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import List, Optional

from app.backend import models
from propbt.data.news import filter_impact, load_news_events

DEFAULT_NEWS_PATH = Path(__file__).resolve().parents[3] / "news_events.csv"

# (path, mtime) -> events, so an edited file is picked up without a restart.
_CACHE: dict = {}


def news_path() -> Path:
    override = os.environ.get("PROPBT_NEWS_EVENTS_PATH")
    return Path(override) if override else DEFAULT_NEWS_PATH


def all_events() -> List[models.NewsEvent]:
    """Every high-impact event in the file, oldest first. A missing file is an
    empty calendar, not an error (the app works without one)."""
    path = news_path()
    try:
        mtime = path.stat().st_mtime
    except FileNotFoundError:
        return []
    key = (str(path), mtime)
    if key not in _CACHE:
        df = filter_impact(load_news_events(path))
        _CACHE.clear()
        _CACHE[key] = [
            models.NewsEvent(time=int(ts.value // 1_000_000_000), event=str(row["event"]), impact=str(row["impact"]))
            for ts, row in df.iterrows()
        ]
    return _CACHE[key]


def events_between(ts_from: int, ts_to: int) -> List[models.NewsEvent]:
    return [e for e in all_events() if ts_from <= e.time <= ts_to]


def window_refusal(time: int, window_minutes: int) -> Optional[str]:
    """Why an entry at `time` is refused by the no-news rule, or None. The window
    is `window_minutes` either side of a high-impact event, edges included."""
    span = window_minutes * 60
    for e in all_events():
        if e.time - span <= time <= e.time + span:
            return f"{e.event} is scheduled at this time ({window_minutes} min either side is closed to entries)"
    return None
