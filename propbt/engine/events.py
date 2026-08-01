"""Typed events that flow through the engine: Bar (market data) -> Signal /
Order (strategy intent) -> Fill (what the broker actually did).
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from enum import Enum
from typing import Optional

import pandas as pd


class Side(str, Enum):
    LONG = "long"
    SHORT = "short"

    @property
    def sign(self) -> int:
        """+1 for LONG, -1 for SHORT -- the direction PnL/slippage move in."""
        return 1 if self is Side.LONG else -1


class OrderType(str, Enum):
    MARKET = "market"
    LIMIT = "limit"
    STOP = "stop"


class FillType(str, Enum):
    ENTRY = "entry"
    STOP_LOSS = "stop_loss"
    TAKE_PROFIT = "take_profit"
    DAILY_LOCK_FLATTEN = "daily_lock_flatten"
    MLL_BREACH_FLATTEN = "mll_breach_flatten"


@dataclass(frozen=True)
class Bar:
    symbol: str
    ts: pd.Timestamp                 # UTC; represents the bar's OPEN time / interval start
    open: float
    high: float
    low: float
    close: float
    volume: int
    trading_day: Optional[dt.date] = None
    session: Optional[str] = None


@dataclass(frozen=True)
class Signal:
    """Directional intent, before sizing/SL-TP is decided."""
    ts: pd.Timestamp
    symbol: str
    side: Side
    reason: str = ""


@dataclass(frozen=True)
class Order:
    ts: pd.Timestamp                 # decision timestamp (bar t) -- eligible to fill starting the NEXT bar
    symbol: str
    side: Side
    order_type: OrderType
    contracts: int
    limit_price: Optional[float] = None   # required for LIMIT/STOP (the limit/stop trigger level)
    sl_points: Optional[float] = None      # static distance from fill price, in points
    tp_points: Optional[float] = None
    reason: str = ""

    def __post_init__(self) -> None:
        if self.contracts <= 0:
            raise ValueError("Order.contracts must be positive")
        if self.order_type in (OrderType.LIMIT, OrderType.STOP) and self.limit_price is None:
            raise ValueError(f"{self.order_type.value} order requires limit_price")
        if self.sl_points is not None and self.sl_points <= 0:
            raise ValueError("Order.sl_points must be positive (a distance)")
        if self.tp_points is not None and self.tp_points <= 0:
            raise ValueError("Order.tp_points must be positive (a distance)")


@dataclass(frozen=True)
class Fill:
    ts: pd.Timestamp
    symbol: str
    side: Side
    contracts: int
    price: float
    fill_type: FillType
    commission: float = 0.0
    realized_pnl: Optional[float] = None      # None for entries; $ (before commission) for exits
    order_ts: Optional[pd.Timestamp] = None    # originating order's decision ts -- None for forced exits
