"""Realized PnL bookkeeping and live intraday equity (realized + open PnL).

`balance` = start_balance + realized PnL so far (net of commissions) -- this
is what the account would show if flat, and it's what the Topstep EOD
trail/target/consistency rules key off (CLAUDE.md section 3). `equity` also
marks open positions to the current bar's close -- this is what the
intraday MLL breach check uses, every bar.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Tuple

import pandas as pd

from propbt.config import ContractSpec
from propbt.engine.broker import Position
from propbt.engine.events import Fill


@dataclass
class Portfolio:
    contracts: Dict[str, ContractSpec]
    start_balance: float
    realized_pnl: float = field(default=0.0, init=False)
    fills: List[Fill] = field(default_factory=list, init=False)
    equity_curve: List[Tuple[pd.Timestamp, float]] = field(default_factory=list, init=False)

    def apply_fill(self, fill: Fill) -> None:
        self.fills.append(fill)
        if fill.realized_pnl is not None:
            self.realized_pnl += fill.realized_pnl
        self.realized_pnl -= fill.commission

    @property
    def balance(self) -> float:
        return self.start_balance + self.realized_pnl

    def mark_to_market(
        self, ts: pd.Timestamp, closes: Dict[str, float], open_positions: Dict[str, Position]
    ) -> float:
        unrealized = 0.0
        for symbol, pos in open_positions.items():
            spec = self.contracts[symbol]
            unrealized += pos.unrealized_pnl(closes[symbol], spec.point_value)
        equity = self.balance + unrealized
        self.equity_curve.append((ts, equity))
        return equity
