"""The home page's numbers and the setup form's options (FXR_V2_SPEC.md section 4,
G6). Everything here is a read over journaled trades and saved sessions -- no
trade, P&L or rule is recomputed; the frontend renders what this returns.
"""
from __future__ import annotations

import bisect
from typing import Dict, List, Optional

import pandas as pd

from app.backend import models
from app.backend.services import bar_service, bt_session_service as bts, prop_presets
from propbt.config import load_sessions
from propbt.data.sessions import trading_day as trading_day_of

WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri"]


def setup_options() -> models.SessionSetupOptions:
    ranges: Dict[str, models.InstrumentRange] = {}
    for sym in bts.ALLOWED_INSTRUMENTS:
        lo, hi = bar_service.get_instrument_range(sym)
        ranges[sym] = models.InstrumentRange(min=lo, max=hi)
    return models.SessionSetupOptions(
        ranges=ranges,
        presets=prop_presets.list_presets(),
        default_commissions={sym: bts.DEFAULT_COMMISSION for sym in bts.ALLOWED_INSTRUMENTS},
    )


def _day_of(unix: int):
    """The CME trading day of a unix time (the maintenance halt belongs to the day that just closed)."""
    cfg = load_sessions()
    ts = pd.Timestamp(unix, unit="s", tz="UTC")
    return trading_day_of(ts, cfg) or trading_day_of(ts - pd.Timedelta(hours=1), cfg)


def session_progress(session: models.BacktestSessionSummary) -> models.SessionProgress:
    trades = bts.list_trades(session.id)
    wins = sum(1 for t in trades if t.pnl_usd > 0)
    out = models.SessionProgress(
        trades=len(trades),
        net_pnl_usd=sum(t.pnl_usd for t in trades),
        win_rate=(wins / len(trades)) if trades else None,
    )
    if session.end_date is None:
        return out

    span = session.end_date - session.start_time
    out.fraction = 1.0 if span <= 0 else min(1.0, max(0.0, (session.cursor_time - session.start_time) / span))
    # Complete once the cursor sits on the last bar the end date allows (what the
    # workspace calls "ended"): the cursor is a bar's open time, the end an instant.
    last = bar_service.last_bar_time_at_or_before(session.instrument, session.end_date)
    out.complete = last is not None and session.cursor_time >= last
    days = list(bar_service.get_trading_days(session.instrument))
    first_day, cursor_day, end_day = _day_of(session.start_time), _day_of(session.cursor_time), _day_of(session.end_date)
    lo = bisect.bisect_left(days, first_day)
    hi = bisect.bisect_right(days, end_day)
    out.trading_days_total = max(0, hi - lo)
    out.trading_days_remaining = 0 if out.complete else max(0, hi - bisect.bisect_right(days, cursor_day))
    return out


def attach_progress(sessions: List[models.BacktestSessionSummary]) -> None:
    for s in sessions:
        s.progress = session_progress(s)


def home_overview() -> models.HomeOverview:
    """Trades across every active session: count and buy/sell split, win rate, mean
    time in trade, and the win rate by the weekday of the trade's CME trading day."""
    kpis = models.HomeKpis()
    held: List[int] = []
    by_day: Dict[int, List[int]] = {d: [0, 0] for d in range(5)}  # weekday -> [trades, wins]
    for session in bts.list_sessions(include_archived=False):
        for t in bts.list_trades(session.id):
            kpis.trades += 1
            win = t.pnl_usd > 0
            kpis.wins += int(win)
            if t.side == "long":
                kpis.buys += 1
            else:
                kpis.sells += 1
            held.append(max(0, t.exit_time - t.entry_time))
            day = _day_of(t.entry_time)
            if day is not None and day.weekday() < 5:
                by_day[day.weekday()][0] += 1
                by_day[day.weekday()][1] += int(win)
    if kpis.trades:
        kpis.win_rate = kpis.wins / kpis.trades
        kpis.avg_time_in_trade_seconds = sum(held) / len(held)
    weekday = [
        models.WeekdayWinRate(
            weekday=d, label=WEEKDAY_LABELS[d], trades=n, wins=w, win_rate=(w / n) if n else None
        )
        for d, (n, w) in by_day.items()
    ]
    return models.HomeOverview(kpis=kpis, weekday=weekday)
