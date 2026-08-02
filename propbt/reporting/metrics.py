"""Trade-level reporting: pair entry/exit fills into round-trip Trades, and
summarize win rate / expectancy ($ and R) overall, per session, and per leg.

Deliberately generic w.r.t. the engine: Fill doesn't carry "session" or
"leg" as first-class concepts (those are strategy-specific, not engine
ones). Session is looked up separately via `session_by_ts` -- a Series
mapping a bar timestamp to whatever session tag was active then (built by
data.sessions.tag_sessions). Leg is parsed from the entry fill's `reason`
string (each leg tags its orders "legname:session", e.g.
"continuation:ny" -- see strategy/session_open.py) since which leg
generated a trade isn't derivable from market data the way session is.

Expectancy in R is the mean of each trade's OWN pnl / its OWN risk (sl_points
* point_value * contracts for whichever leg opened it), not portfolio
dollars divided by one shared risk figure -- legs can size risk
differently, and this is also just the textbook definition of an R-multiple
expectancy.
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
    leg: Optional[str]
    risk_dollars: Optional[float]  # this trade's own risk (sl_points * point_value * contracts); None if unknown

    @property
    def r_multiple(self) -> Optional[float]:
        if not self.risk_dollars:
            return None
        return self.realized_pnl / self.risk_dollars


def pair_trades(
    fills: List[Fill],
    session_by_ts: Optional[pd.Series] = None,
    risk_dollars_by_leg: Optional[Dict[Optional[str], float]] = None,
) -> List[Trade]:
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

        leg = entry.reason.split(":", 1)[0] if entry.reason else None
        risk_dollars = risk_dollars_by_leg.get(leg) if risk_dollars_by_leg else None

        net_pnl = (f.realized_pnl or 0.0) - f.commission
        trades.append(Trade(
            symbol=f.symbol, side=entry.side, contracts=entry.contracts,
            entry_ts=entry.ts, entry_price=entry.price, exit_ts=f.ts, exit_price=f.price,
            exit_type=f.fill_type, commission=f.commission, realized_pnl=net_pnl,
            session=session, leg=leg, risk_dollars=risk_dollars,
        ))
    return trades


@dataclass(frozen=True)
class TradeStats:
    n_trades: int
    win_rate: float           # nan if n_trades == 0
    expectancy_dollars: float  # nan if n_trades == 0
    expectancy_r: float        # nan if no trade in the set has a known risk_dollars


def compute_stats(trades: List[Trade]) -> TradeStats:
    n = len(trades)
    if n == 0:
        return TradeStats(n_trades=0, win_rate=math.nan, expectancy_dollars=math.nan, expectancy_r=math.nan)
    wins = sum(1 for t in trades if t.realized_pnl > 0)
    win_rate = wins / n
    expectancy_dollars = sum(t.realized_pnl for t in trades) / n
    r_values = [t.r_multiple for t in trades if t.r_multiple is not None]
    expectancy_r = sum(r_values) / len(r_values) if r_values else math.nan
    return TradeStats(n_trades=n, win_rate=win_rate, expectancy_dollars=expectancy_dollars, expectancy_r=expectancy_r)


@dataclass(frozen=True)
class BacktestSummary:
    overall: TradeStats
    by_session: Dict[str, TradeStats] = field(default_factory=dict)
    by_leg: Dict[str, TradeStats] = field(default_factory=dict)
    combine: Optional[CombineResult] = None


def summarize(trades: List[Trade], combine: Optional[CombineResult] = None) -> BacktestSummary:
    overall = compute_stats(trades)

    sessions = sorted({t.session for t in trades if t.session is not None})
    by_session = {s: compute_stats([t for t in trades if t.session == s]) for s in sessions}

    legs = sorted({t.leg for t in trades if t.leg is not None})
    by_leg = {l: compute_stats([t for t in trades if t.leg == l]) for l in legs}

    return BacktestSummary(overall=overall, by_session=by_session, by_leg=by_leg, combine=combine)
