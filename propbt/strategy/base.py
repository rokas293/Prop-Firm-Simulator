"""Strategy interface. Built in Phase 1 (ahead of any real strategy logic)
because the backtester needs *some* interface to call -- session_open.py
and later legs (mean-reversion, news) are all built against this same
BarState/Strategy contract.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Dict, List, Protocol

import pandas as pd

from propbt.engine.broker import Position
from propbt.engine.events import Bar, Order


@dataclass(frozen=True)
class BarState:
    """Everything a strategy is allowed to see when deciding at bar t.

    `history` is bars[: i+1] -- it includes bar t itself (so bar t's own
    close is visible, per CLAUDE.md's "decision made on bar t may use data
    with timestamp <= close of bar t") but nothing beyond it. Any orders
    returned from `on_bar` are only eligible to fill starting bar t+1 (see
    engine/broker.py).
    """
    symbol: str
    i: int
    bar: Bar
    history: pd.DataFrame
    open_positions: Dict[str, Position]
    balance: float
    equity: float
    daily_locked: bool
    trading_day: dt.date


class Strategy(Protocol):
    def on_bar(self, state: BarState) -> List[Order]: ...
