"""Trade-level reporting: pair entry/exit fills into round-trip Trades, and
summarize win rate / expectancy ($ and R) overall and per session.

Deliberately generic w.r.t. the engine: Fill doesn't carry a "session"
label (that's a strategy-specific concept, not an engine one), so the
session for each trade is looked up separately via `session_by_ts` -- a
Series mapping a bar timestamp to whatever session tag was active then
(built by data.sessions.tag_sessions). A trade's session is whichever
session was active at its ENTRY decision (order_ts).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import pandas as pd

from propbt.engine.events import Fill, FillType, Side
from propbt.engine.prop_rules import CombineResult


@dataclass(frozen=True)
class Trade:
    symbol: str
    side: Side
    contracts: int
    entry_ts: pd.Timestamp
    entry_price: float
    exit_ts: pd.Timestamp
    exit_price: float
    exit_type: FillType
    commission: float
    realized_pnl: float          # net of commission
    session: Optional[str]


def pair_trades(fills: List[Fill], session_by_ts: Optional[pd.Series] = None) -> List[Trade]:
    """Pair ENTRY fills with their corresponding exit fill (STOP_LOSS,
    TAKE_PROFIT, or a forced flatten), per symbol, in fill order.
    """
    pending: Dict[str, Fill] = {}
    trades: List[Trade] = []
    for f in fills:
        if f.fill_type is FillType.ENTRY:
            pending[f.symbol] = f
            continue
        entry = pending.pop(f.symbol, None)
        if entry is None:
            continue  # an exit with no matching entry shouldn't happen; ignore defensively

        session = None
        if session_by_ts is not None and entry.ts in session_by_ts.index:
            session = session_by_ts.loc[entry.ts]

        net_pnl = (f.realized_pnl or 0.0) - f.commission
        trades.append(Trade(
            symbol=f.symbol, side=entry.side, contracts=entry.contracts,
            entry_ts=entry.ts, entry_price=entry.price, exit_ts=f.ts, exit_price=f.price,
            exit_type=f.fill_type, commission=f.commission, realized_pnl=net_pnl, session=session,
        ))
    return trades


@dataclass(frozen=True)
class TradeStats:
    n_trades: int
    win_rate: float           # nan if n_trades == 0
    expectancy_dollars: float  # nan if n_trades == 0
    expectancy_r: float        # nan if n_trades == 0 or risk_dollars_per_trade == 0


def compute_stats(trades: List[Trade], risk_dollars_per_trade: float) -> TradeStats:
    n = len(trades)
    if n == 0:
        return TradeStats(n_trades=0, win_rate=math.nan, expectancy_dollars=math.nan, expectancy_r=math.nan)
    wins = sum(1 for t in trades if t.realized_pnl > 0)
    win_rate = wins / n
    expectancy_dollars = sum(t.realized_pnl for t in trades) / n
    expectancy_r = expectancy_dollars / risk_dollars_per_trade if risk_dollars_per_trade else math.nan
    return TradeStats(n_trades=n, win_rate=win_rate, expectancy_dollars=expectancy_dollars, expectancy_r=expectancy_r)


@dataclass(frozen=True)
class BacktestSummary:
    overall: TradeStats
    by_session: Dict[str, TradeStats] = field(default_factory=dict)
    combine: Optional[CombineResult] = None


def summarize(
    trades: List[Trade], risk_dollars_per_trade: float, combine: Optional[CombineResult] = None
) -> BacktestSummary:
    overall = compute_stats(trades, risk_dollars_per_trade)

    sessions = sorted({t.session for t in trades if t.session is not None})
    by_session = {
        s: compute_stats([t for t in trades if t.session == s], risk_dollars_per_trade)
        for s in sessions
    }
    return BacktestSummary(overall=overall, by_session=by_session, combine=combine)
