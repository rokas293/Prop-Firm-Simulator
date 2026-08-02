"""Order fills, position/SL-TP management, slippage, commissions, and the
flat 5-contract position limit.

Fill timing (no-look-ahead, CLAUDE.md section 2): an Order carries the
timestamp of the bar it was decided on (`order.ts`). `process_bar(bar)` only
fills orders with `order.ts < bar.ts` -- i.e. decided on a STRICTLY earlier
bar. This is enforced by the broker itself, not just by caller discipline,
so a market order decided on bar t fills at bar t+1's open (or a limit/stop
order fills within bar t+1 if its range crosses the level), never using bar
t's own close.

Simplification for Phase 1 (no real strategy legs yet): at most one open
position per symbol at a time; a new entry order for a symbol that already
has an open position is rejected, not queued or pyramided.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional

import pandas as pd

from propbt.config import ContractSpec
from propbt.engine.events import Bar, Fill, FillType, Order, OrderType, Side


@dataclass
class Position:
    symbol: str
    side: Side
    contracts: int
    entry_price: float
    entry_ts: pd.Timestamp
    sl_price: Optional[float]
    tp_price: Optional[float]

    def unrealized_pnl(self, current_price: float, point_value: float) -> float:
        return self.side.sign * (current_price - self.entry_price) * point_value * self.contracts


@dataclass
class Rejection:
    ts: pd.Timestamp
    symbol: str
    order_ts: pd.Timestamp
    reason: str


class Broker:
    def __init__(
        self,
        contracts: Dict[str, ContractSpec],
        slippage_ticks: int,
        commissions: Dict[str, float],
        max_open_contracts: int,
    ):
        self.contracts = contracts
        self.slippage_ticks = slippage_ticks
        self.commissions = commissions
        self.max_open_contracts = max_open_contracts

        self._pending: List[Order] = []
        self.open_positions: Dict[str, Position] = {}
        self.rejections: List[Rejection] = []

    @property
    def total_open_contracts(self) -> int:
        return sum(p.contracts for p in self.open_positions.values())

    def submit_order(self, order: Order) -> None:
        self._pending.append(order)

    def process_bar(self, bar: Bar) -> List[Fill]:
        """Resolve fills using ONLY this bar's own OHLC. Must be called once
        per bar, in bar-timestamp order, for a given symbol.
        """
        fills: List[Fill] = []

        pos = self.open_positions.get(bar.symbol)
        if pos is not None:
            exit_fill = self._check_stop_take(bar, pos)
            if exit_fill is not None:
                fills.append(exit_fill)
                del self.open_positions[bar.symbol]

        still_pending: List[Order] = []
        for order in self._pending:
            if order.symbol != bar.symbol or order.ts >= bar.ts:
                still_pending.append(order)  # not this symbol, or not yet eligible
                continue
            fills.extend(self._try_fill_entry(bar, order))
        self._pending = still_pending

        return fills

    def flatten(self, bar: Bar, fill_type: FillType) -> List[Fill]:
        """Force-close any open position in `bar.symbol` at this bar's close
        (plus adverse slippage), and cancel any pending orders for it. Used
        for a daily-loss-lock or an MLL breach -- both require flattening
        immediately, not waiting for the position's own SL/TP.
        """
        fills: List[Fill] = []
        pos = self.open_positions.pop(bar.symbol, None)
        if pos is not None:
            spec = self.contracts[bar.symbol]
            exit_price = self._apply_slippage(bar.symbol, -pos.side.sign, bar.close, adverse=True)
            commission = self.commissions.get(bar.symbol, 0.0) * pos.contracts
            realized_pnl = pos.unrealized_pnl(exit_price, spec.point_value)
            fills.append(Fill(
                ts=bar.ts, symbol=bar.symbol, side=pos.side, contracts=pos.contracts,
                price=exit_price, fill_type=fill_type, commission=commission,
                realized_pnl=realized_pnl, order_ts=None,
            ))
        self._pending = [o for o in self._pending if o.symbol != bar.symbol]
        return fills

    def _apply_slippage(self, symbol: str, direction: int, base_price: float, adverse: bool) -> float:
        """direction: +1 if the transaction is a BUY (adverse = higher price),
        -1 if a SELL (adverse = lower price)."""
        if not adverse or self.slippage_ticks == 0:
            return base_price
        spec = self.contracts[symbol]
        return base_price + direction * self.slippage_ticks * spec.tick_size

    def _try_fill_entry(self, bar: Bar, order: Order) -> List[Fill]:
        if bar.symbol in self.open_positions:
            self.rejections.append(Rejection(bar.ts, bar.symbol, order.ts, "position_already_open"))
            return []
        if self.total_open_contracts + order.contracts > self.max_open_contracts:
            self.rejections.append(Rejection(bar.ts, bar.symbol, order.ts, "position_limit"))
            return []

        if order.order_type is OrderType.MARKET:
            fill_price = self._apply_slippage(bar.symbol, order.side.sign, bar.open, adverse=True)
        elif order.order_type is OrderType.STOP:
            triggered = (
                (order.side is Side.LONG and bar.high >= order.limit_price)
                or (order.side is Side.SHORT and bar.low <= order.limit_price)
            )
            if not triggered:
                return []  # expires unfilled within this bar
            fill_price = self._apply_slippage(bar.symbol, order.side.sign, order.limit_price, adverse=True)
        elif order.order_type is OrderType.LIMIT:
            triggered = (
                (order.side is Side.LONG and bar.low <= order.limit_price)
                or (order.side is Side.SHORT and bar.high >= order.limit_price)
            )
            if not triggered:
                return []
            fill_price = order.limit_price  # limit fills get no adverse slippage
        else:
            raise ValueError(f"Unknown order type {order.order_type}")

        sl_price = fill_price - order.side.sign * order.sl_points if order.sl_points is not None else None
        tp_price = fill_price + order.side.sign * order.tp_points if order.tp_points is not None else None

        entry_fill = Fill(
            ts=bar.ts, symbol=bar.symbol, side=order.side, contracts=order.contracts,
            price=fill_price, fill_type=FillType.ENTRY, commission=0.0,
            realized_pnl=None, order_ts=order.ts, reason=order.reason,
            sl_price=sl_price, tp_price=tp_price,
        )

        position = Position(
            symbol=bar.symbol, side=order.side, contracts=order.contracts,
            entry_price=fill_price, entry_ts=bar.ts, sl_price=sl_price, tp_price=tp_price,
        )
        self.open_positions[bar.symbol] = position

        fills = [entry_fill]
        # a freshly opened position can still be hit by its own SL/TP within
        # the REMAINDER of this same bar -- not look-ahead, since we're only
        # using this bar's own OHLC to resolve it.
        same_bar_exit = self._check_stop_take(bar, position)
        if same_bar_exit is not None:
            fills.append(same_bar_exit)
            del self.open_positions[bar.symbol]
        return fills

    def _check_stop_take(self, bar: Bar, pos: Position) -> Optional[Fill]:
        hit_sl = pos.sl_price is not None and (
            (pos.side is Side.LONG and bar.low <= pos.sl_price)
            or (pos.side is Side.SHORT and bar.high >= pos.sl_price)
        )
        hit_tp = pos.tp_price is not None and (
            (pos.side is Side.LONG and bar.high >= pos.tp_price)
            or (pos.side is Side.SHORT and bar.low <= pos.tp_price)
        )
        if not hit_sl and not hit_tp:
            return None

        spec = self.contracts[bar.symbol]
        if hit_sl:
            # if both are touched in the same bar, we can't know the true
            # intrabar path from OHLC alone -- conservatively assume the
            # worse outcome (the stop).
            exit_price = self._apply_slippage(bar.symbol, -pos.side.sign, pos.sl_price, adverse=True)
            fill_type = FillType.STOP_LOSS
        else:
            exit_price = pos.tp_price  # limit-style, no adverse slippage
            fill_type = FillType.TAKE_PROFIT

        commission = self.commissions.get(bar.symbol, 0.0) * pos.contracts
        realized_pnl = pos.unrealized_pnl(exit_price, spec.point_value)
        return Fill(
            ts=bar.ts, symbol=bar.symbol, side=pos.side, contracts=pos.contracts,
            price=exit_price, fill_type=fill_type, commission=commission,
            realized_pnl=realized_pnl, order_ts=None,
        )
