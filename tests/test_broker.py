from __future__ import annotations

import pandas as pd
import pytest

from propbt.config import ContractSpec
from propbt.engine.broker import Broker
from propbt.engine.events import Bar, FillType, Order, OrderType, Side


@pytest.fixture
def mes_spec():
    return ContractSpec(symbol="MES", point_value=5.0, tick_size=0.25, tick_value=1.25, is_micro=True)


def make_bar(ts, o, h, l, c, symbol="MES", volume=100):
    return Bar(symbol=symbol, ts=pd.Timestamp(ts, tz="UTC"), open=o, high=h, low=l, close=c, volume=volume)


def test_market_order_fills_at_next_bar_open_not_current_close(mes_spec):
    broker = Broker(contracts={"MES": mes_spec}, slippage_ticks=0, commissions={"MES": 0.0}, max_open_contracts=5)
    bar0 = make_bar("2025-01-06 14:30", 5000, 5005, 4995, 5002)
    bar1 = make_bar("2025-01-06 14:31", 5010, 5015, 5008, 5012)

    order = Order(ts=bar0.ts, symbol="MES", side=Side.LONG, order_type=OrderType.MARKET, contracts=1)
    broker.submit_order(order)

    fills0 = broker.process_bar(bar0)  # decided ON bar0 -- must not fill during bar0
    assert fills0 == []
    assert "MES" not in broker.open_positions

    fills1 = broker.process_bar(bar1)  # fills on the NEXT bar, at its open
    assert len(fills1) == 1
    assert fills1[0].price == bar1.open
    assert fills1[0].price != bar0.close
    assert fills1[0].ts == bar1.ts
    assert fills1[0].order_ts == bar0.ts


def test_market_order_slippage_is_adverse(mes_spec):
    broker = Broker(contracts={"MES": mes_spec}, slippage_ticks=2, commissions={"MES": 0.0}, max_open_contracts=5)
    bar0 = make_bar("2025-01-06 14:30", 5000, 5005, 4995, 5002)
    bar1 = make_bar("2025-01-06 14:31", 5010, 5015, 5008, 5012)

    long_order = Order(ts=bar0.ts, symbol="MES", side=Side.LONG, order_type=OrderType.MARKET, contracts=1)
    broker.submit_order(long_order)
    broker.process_bar(bar0)
    fills = broker.process_bar(bar1)
    # buying: adverse slippage = higher price
    assert fills[0].price == pytest.approx(bar1.open + 2 * mes_spec.tick_size)


def test_stop_loss_hit_with_slippage_and_commission(mes_spec):
    broker = Broker(contracts={"MES": mes_spec}, slippage_ticks=1, commissions={"MES": 1.30}, max_open_contracts=5)
    bar0 = make_bar("2025-01-06 14:30", 5000, 5000, 5000, 5000)
    bar1 = make_bar("2025-01-06 14:31", 5000, 5001, 4998, 5000)  # entry bar
    bar2 = make_bar("2025-01-06 14:32", 4990, 4991, 4980, 4985)  # low breaches SL

    order = Order(ts=bar0.ts, symbol="MES", side=Side.LONG, order_type=OrderType.MARKET,
                  contracts=2, sl_points=10, tp_points=50)
    broker.submit_order(order)
    broker.process_bar(bar0)
    entry_fills = broker.process_bar(bar1)
    assert entry_fills[0].fill_type is FillType.ENTRY
    entry_price = entry_fills[0].price
    sl_price = entry_price - 10  # long SL is below entry

    exit_fills = broker.process_bar(bar2)
    assert len(exit_fills) == 1
    exit_fill = exit_fills[0]
    assert exit_fill.fill_type is FillType.STOP_LOSS
    # sell to close -> adverse slippage is LOWER price
    assert exit_fill.price == pytest.approx(sl_price - 1 * mes_spec.tick_size)
    assert exit_fill.commission == pytest.approx(1.30 * 2)
    expected_pnl = (exit_fill.price - entry_price) * mes_spec.point_value * 2
    assert exit_fill.realized_pnl == pytest.approx(expected_pnl)
    assert "MES" not in broker.open_positions


def test_take_profit_hit_no_slippage(mes_spec):
    broker = Broker(contracts={"MES": mes_spec}, slippage_ticks=3, commissions={"MES": 0.0}, max_open_contracts=5)
    bar0 = make_bar("2025-01-06 14:30", 5000, 5000, 5000, 5000)
    bar1 = make_bar("2025-01-06 14:31", 5000, 5001, 4999, 5000)  # entry bar
    bar2 = make_bar("2025-01-06 14:32", 5015, 5025, 5010, 5020)  # high breaches TP

    order = Order(ts=bar0.ts, symbol="MES", side=Side.LONG, order_type=OrderType.MARKET,
                  contracts=1, sl_points=50, tp_points=20)
    broker.submit_order(order)
    broker.process_bar(bar0)
    entry_fills = broker.process_bar(bar1)
    entry_price = entry_fills[0].price
    tp_price = entry_price + 20

    exit_fills = broker.process_bar(bar2)
    assert exit_fills[0].fill_type is FillType.TAKE_PROFIT
    assert exit_fills[0].price == pytest.approx(tp_price)  # exact, no slippage on limit-style TP fill


def test_same_bar_sl_hit_right_after_entry(mes_spec):
    # entry fills at this bar's open, and the SAME bar's range already
    # breaches the stop -- must close within the same bar, not one bar late.
    broker = Broker(contracts={"MES": mes_spec}, slippage_ticks=0, commissions={"MES": 0.0}, max_open_contracts=5)
    bar0 = make_bar("2025-01-06 14:30", 5000, 5000, 5000, 5000)
    bar1 = make_bar("2025-01-06 14:31", 5000, 5002, 4985, 4990)  # open 5000, but low 4985 breaches a 10pt SL

    order = Order(ts=bar0.ts, symbol="MES", side=Side.LONG, order_type=OrderType.MARKET,
                  contracts=1, sl_points=10, tp_points=100)
    broker.submit_order(order)
    broker.process_bar(bar0)
    fills = broker.process_bar(bar1)

    assert len(fills) == 2
    assert fills[0].fill_type is FillType.ENTRY
    assert fills[1].fill_type is FillType.STOP_LOSS
    assert "MES" not in broker.open_positions


def test_position_limit_rejects_oversized_entry(mes_spec):
    broker = Broker(contracts={"MES": mes_spec}, slippage_ticks=0, commissions={"MES": 0.0}, max_open_contracts=5)
    bar0 = make_bar("2025-01-06 14:30", 5000, 5000, 5000, 5000)
    bar1 = make_bar("2025-01-06 14:31", 5000, 5000, 5000, 5000)

    order = Order(ts=bar0.ts, symbol="MES", side=Side.LONG, order_type=OrderType.MARKET, contracts=6)
    broker.submit_order(order)
    broker.process_bar(bar0)
    fills = broker.process_bar(bar1)

    assert fills == []
    assert "MES" not in broker.open_positions
    assert len(broker.rejections) == 1
    assert broker.rejections[0].reason == "position_limit"


def test_second_entry_while_position_open_is_rejected(mes_spec):
    broker = Broker(contracts={"MES": mes_spec}, slippage_ticks=0, commissions={"MES": 0.0}, max_open_contracts=5)
    bar0 = make_bar("2025-01-06 14:30", 5000, 5000, 5000, 5000)
    bar1 = make_bar("2025-01-06 14:31", 5000, 5000, 5000, 5000)
    bar2 = make_bar("2025-01-06 14:32", 5000, 5000, 5000, 5000)

    order1 = Order(ts=bar0.ts, symbol="MES", side=Side.LONG, order_type=OrderType.MARKET, contracts=1)
    broker.submit_order(order1)
    broker.process_bar(bar0)
    broker.process_bar(bar1)  # opens position
    assert "MES" in broker.open_positions

    order2 = Order(ts=bar1.ts, symbol="MES", side=Side.LONG, order_type=OrderType.MARKET, contracts=1)
    broker.submit_order(order2)
    fills = broker.process_bar(bar2)

    assert fills == []
    assert broker.rejections[-1].reason == "position_already_open"


def test_flatten_closes_position_and_cancels_pending(mes_spec):
    broker = Broker(contracts={"MES": mes_spec}, slippage_ticks=1, commissions={"MES": 1.30}, max_open_contracts=5)
    bar0 = make_bar("2025-01-06 14:30", 5000, 5000, 5000, 5000)
    bar1 = make_bar("2025-01-06 14:31", 5000, 5010, 4990, 5005)

    order = Order(ts=bar0.ts, symbol="MES", side=Side.LONG, order_type=OrderType.MARKET,
                  contracts=1, sl_points=100, tp_points=100)  # far away, won't trigger
    broker.submit_order(order)
    broker.process_bar(bar0)
    broker.process_bar(bar1)
    assert "MES" in broker.open_positions

    # a pending order that hasn't filled yet either
    late_order = Order(ts=bar1.ts, symbol="MES", side=Side.SHORT, order_type=OrderType.MARKET, contracts=1)
    broker.submit_order(late_order)

    flatten_fills = broker.flatten(bar1, FillType.MLL_BREACH_FLATTEN)
    assert len(flatten_fills) == 1
    assert flatten_fills[0].fill_type is FillType.MLL_BREACH_FLATTEN
    assert "MES" not in broker.open_positions
    assert broker._pending == []  # cancelled, not carried into the next bar
