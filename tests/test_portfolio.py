from __future__ import annotations

import pandas as pd
import pytest

from propbt.config import ContractSpec
from propbt.engine.broker import Position
from propbt.engine.events import FillType, Side
from propbt.engine.portfolio import Portfolio
from tests.test_broker import mes_spec  # reuse fixture  # noqa: F401


def make_fill(ts, side, contracts, price, fill_type, commission=0.0, realized_pnl=None):
    from propbt.engine.events import Fill
    return Fill(ts=pd.Timestamp(ts, tz="UTC"), symbol="MES", side=side, contracts=contracts,
                price=price, fill_type=fill_type, commission=commission, realized_pnl=realized_pnl)


def test_balance_unaffected_by_entry_fill(mes_spec):
    pf = Portfolio(contracts={"MES": mes_spec}, start_balance=50000.0)
    pf.apply_fill(make_fill("2025-01-06 14:31", Side.LONG, 1, 5000.0, FillType.ENTRY))
    assert pf.balance == 50000.0  # entries carry no realized pnl/commission in our round-turn convention


def test_balance_updates_on_exit_fill_net_of_commission(mes_spec):
    pf = Portfolio(contracts={"MES": mes_spec}, start_balance=50000.0)
    pf.apply_fill(make_fill("2025-01-06 14:31", Side.LONG, 1, 5000.0, FillType.ENTRY))
    pf.apply_fill(make_fill("2025-01-06 14:32", Side.LONG, 1, 5010.0, FillType.TAKE_PROFIT,
                             commission=1.30, realized_pnl=50.0))  # 10 pts * $5 = $50
    assert pf.balance == pytest.approx(50000.0 + 50.0 - 1.30)


def test_mark_to_market_includes_open_unrealized_pnl(mes_spec):
    pf = Portfolio(contracts={"MES": mes_spec}, start_balance=50000.0)
    pf.apply_fill(make_fill("2025-01-06 14:31", Side.LONG, 2, 5000.0, FillType.ENTRY))

    pos = Position(symbol="MES", side=Side.LONG, contracts=2, entry_price=5000.0,
                    entry_ts=pd.Timestamp("2025-01-06 14:31", tz="UTC"), sl_price=None, tp_price=None)
    equity = pf.mark_to_market(pd.Timestamp("2025-01-06 14:35", tz="UTC"), {"MES": 5004.0}, {"MES": pos})

    # balance still 50000 (nothing realized), unrealized = (5004-5000)*5*2 = $40
    assert pf.balance == 50000.0
    assert equity == pytest.approx(50040.0)
    assert pf.equity_curve[-1] == (pd.Timestamp("2025-01-06 14:35", tz="UTC"), pytest.approx(50040.0))


def test_mark_to_market_with_no_open_positions_equals_balance(mes_spec):
    pf = Portfolio(contracts={"MES": mes_spec}, start_balance=50000.0)
    equity = pf.mark_to_market(pd.Timestamp("2025-01-06 14:35", tz="UTC"), {"MES": 5004.0}, {})
    assert equity == pf.balance == 50000.0
