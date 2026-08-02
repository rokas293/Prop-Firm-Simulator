"""Session windows + fair value for /api/sessions, reusing
propbt.data.sessions exactly (same anchors, same trading-day boundary, same
fair-value definition the engine used) -- see CLAUDE.md section 3-4.
"""
from __future__ import annotations

import datetime as dt
from typing import List

import pandas as pd

from app.backend import models
from app.backend.services.bar_service import _load_raw
from propbt.config import load_sessions
from propbt.data.sessions import fair_value, session_windows


def get_sessions(instrument: str, ts_from: int, ts_to: int) -> List[models.SessionWindow]:
    df = _load_raw(instrument)
    sessions_cfg = load_sessions()

    start = pd.Timestamp(ts_from, unit="s", tz="UTC")
    end = pd.Timestamp(ts_to, unit="s", tz="UTC")

    start_day = start.tz_convert(sessions_cfg.timezone).date()
    end_day = end.tz_convert(sessions_cfg.timezone).date()

    out: List[models.SessionWindow] = []
    day = start_day
    while day <= end_day:
        for name, (win_start, win_end) in session_windows(day, sessions_cfg).items():
            if win_end < start or win_start > end:
                continue
            fv = fair_value(df, win_start)
            out.append(models.SessionWindow(
                trading_day=day.isoformat(), session=name,
                start=int(win_start.value // 1_000_000_000), end=int(win_end.value // 1_000_000_000),
                fair_value=fv[1] if fv else None,
                fair_value_time=int(fv[0].value // 1_000_000_000) if fv else None,
            ))
        day += dt.timedelta(days=1)

    return out
