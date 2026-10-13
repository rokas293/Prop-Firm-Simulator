"""FXR_V2_SPEC.md section 7 (G9): CSV export of manual trades with their
journal fields, for one session or every session.

Engine-truth: every number is the journaled value (the sim broker computed it
when the trade closed); this module only lays the trades out. Times are
rendered in America/New_York (the zone the session rules live in), prices and
P&L as plain decimals so a spreadsheet reads them as numbers.
"""
from __future__ import annotations

import csv
import io
from datetime import datetime
from typing import Iterable, List, Optional
from zoneinfo import ZoneInfo

from app.backend import models
from app.backend.services import bt_session_service as bts

ET = ZoneInfo("America/New_York")

COLUMNS = [
    "session_id",
    "session_name",
    "trade_id",
    "instrument",
    "side",
    "quantity",
    "entry_time_et",
    "exit_time_et",
    "entry_price",
    "exit_price",
    "entry_sl_price",
    "entry_tp_price",
    "sl_price_at_close",
    "tp_price_at_close",
    "exit_type",
    "exits",
    "pnl_usd",
    "commission_usd",
    "r_multiple",
    "mae_points",
    "mfe_points",
    "mae_r",
    "mfe_r",
    "tags",
    "setup",
    "grade",
    "notes",
    "checklist_ticked",
]

# A cell opening with one of these is read as a formula by spreadsheets; free
# text from the journal is prefixed with an apostrophe so it stays text.
_FORMULA_LEADERS = ("=", "+", "-", "@", "\t", "\r")


def fmt_et(unix_seconds: int) -> str:
    return datetime.fromtimestamp(unix_seconds, tz=ET).strftime("%Y-%m-%d %H:%M:%S")


def _num(v: Optional[float]) -> str:
    if v is None:
        return ""
    return repr(float(v))


def _text(v: Optional[str]) -> str:
    if not v:
        return ""
    return "'" + v if v.startswith(_FORMULA_LEADERS) else v


def _exits(t: models.ManualTrade) -> str:
    # "<ET time> <contracts>@<price> <exit_type> <pnl>" per exit, joined by " | ".
    return " | ".join(
        f"{fmt_et(e.time)} {e.contracts}@{e.price!r} {e.exit_type} {e.pnl_usd!r}" for e in sorted(t.exits, key=lambda e: e.time)
    )


def trade_row(session: models.BacktestSessionSummary, t: models.ManualTrade) -> List[str]:
    return [
        session.id,
        _text(session.name),
        str(t.trade_id),
        t.instrument,
        t.side,
        str(t.size_contracts),
        fmt_et(t.entry_time),
        fmt_et(t.exit_time),
        _num(t.entry_price),
        _num(t.exit_price),
        _num(t.entry_sl_price),
        _num(t.entry_tp_price),
        _num(t.sl_price),
        _num(t.tp_price),
        t.exit_type,
        _exits(t),
        _num(t.pnl_usd),
        _num(t.commission_usd),
        _num(t.r_multiple),
        _num(t.mae_points),
        _num(t.mfe_points),
        _num(t.mae_r),
        _num(t.mfe_r),
        _text("; ".join(t.tags)),
        _text(t.setup_name),
        t.grade or "",
        _text(t.notes),
        _text("; ".join(t.checklist)),
    ]


def _sessions(session_id: Optional[str]) -> Iterable[models.BacktestSessionSummary]:
    if session_id is not None:
        return [bts.get_session(session_id)]  # raises SessionNotFound
    # Every session, archived ones included: archiving hides a session, it never removes its trades.
    return sorted(bts.list_sessions(include_archived=True), key=lambda s: s.created_at)


def render(session_id: Optional[str] = None) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(COLUMNS)
    for s in _sessions(session_id):
        for t in bts.list_trades(s.id):
            w.writerow(trade_row(s, t))
    return buf.getvalue()


def filename(session_id: Optional[str]) -> str:
    return f"trades-{session_id}.csv" if session_id else "trades-all-sessions.csv"
