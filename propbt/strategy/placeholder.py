"""Trivial strategies with no trading logic of their own -- only used to
exercise the engine machinery (Phase 1). Real legs land in Phase 2+.
"""
from __future__ import annotations

import random
from dataclasses import dataclass

from propbt.engine.events import Order, OrderType, Side, Signal
from propbt.strategy.base import BarState


@dataclass
class AlwaysFlatStrategy:
    """Never trades. Useful as a baseline: equity should stay exactly at
    start_balance and no fills/rejections should ever occur."""

    def on_bar(self, state: BarState):
        return []


@dataclass
class RandomStrategy:
    """Each bar, if flat and not daily-locked, flips a coin (seeded, so
    deterministic/reproducible per CLAUDE.md) to enter a random-direction
    market order with fixed size and static SL/TP in points."""

    contracts: int = 1
    sl_points: float = 10.0
    tp_points: float = 10.0
    trade_prob: float = 0.05
    seed: int = 0

    def __post_init__(self) -> None:
        self._rng = random.Random(self.seed)

    def on_bar(self, state: BarState):
        if state.daily_locked or state.symbol in state.open_positions:
            return []
        if self._rng.random() >= self.trade_prob:
            return []

        side = Side.LONG if self._rng.random() < 0.5 else Side.SHORT
        signal = Signal(ts=state.bar.ts, symbol=state.symbol, side=side, reason="random_placeholder")
        order = Order(
            ts=signal.ts, symbol=signal.symbol, side=signal.side, order_type=OrderType.MARKET,
            contracts=self.contracts, sl_points=self.sl_points, tp_points=self.tp_points,
            reason=signal.reason,
        )
        return [order]
