from __future__ import annotations

import math

import pandas as pd
import pytest

from propbt.engine.events import Fill, FillType, Side
from propbt.reporting.metrics import compute_stats, pair_trades


def entry(ts, price, contracts=1, symbol="MES"):
    return Fill(ts=pd.Timestamp(ts, tz="UTC"), symbol=symbol, side=Side.LONG, contracts=contracts,
                price=price, fill_type=FillType.ENTRY)


def exit_(ts, price, realized_pnl, commission=1.30, fill_type=FillType.TAKE_PROFIT, contracts=1, symbol="MES"):
    return Fill(ts=pd.Timestamp(ts, tz="UTC"), symbol=symbol, side=Side.LONG, contracts=contracts,
                price=price, fill_type=fill_type, commission=commission, realized_pnl=realized_pnl)


def test_pair_trades_matches_entry_to_next_exit_same_symbol():
    fills = [
        entry("2025-01-06 13:30", 5000),
        exit_("2025-01-06 13:35", 5020, realized_pnl=100.0),
    ]
    trades = pair_trades(fills)
    assert len(trades) == 1
    t = trades[0]
    assert t.entry_price == 5000 and t.exit_price == 5020
    assert t.realized_pnl == pytest.approx(100.0 - 1.30)


def test_pair_trades_handles_multiple_round_trips():
    fills = [
        entry("2025-01-06 13:30", 5000),
        exit_("2025-01-06 13:35", 5020, realized_pnl=100.0, fill_type=FillType.TAKE_PROFIT),
        entry("2025-01-06 14:00", 5010),
        exit_("2025-01-06 14:05", 5000, realized_pnl=-50.0, fill_type=FillType.STOP_LOSS),
    ]
    trades = pair_trades(fills)
    assert len(trades) == 2
    assert trades[0].exit_type is FillType.TAKE_PROFIT
    assert trades[1].exit_type is FillType.STOP_LOSS


def test_pair_trades_looks_up_session_by_entry_ts():
    fills = [
        entry("2025-01-06 13:30", 5000),
        exit_("2025-01-06 13:35", 5020, realized_pnl=100.0),
    ]
    session_by_ts = pd.Series(
        {pd.Timestamp("2025-01-06 13:30", tz="UTC"): "ny"}
    )
    trades = pair_trades(fills, session_by_ts)
    assert trades[0].session == "ny"


def test_compute_stats_empty_is_nan():
    stats = compute_stats([], risk_dollars_per_trade=50.0)
    assert stats.n_trades == 0
    assert math.isnan(stats.win_rate)
    assert math.isnan(stats.expectancy_dollars)
    assert math.isnan(stats.expectancy_r)


def test_compute_stats_win_rate_and_expectancy_r():
    fills = [
        entry("2025-01-06 13:30", 5000),
        exit_("2025-01-06 13:35", 5020, realized_pnl=100.0, commission=0.0),
        entry("2025-01-06 14:00", 5010),
        exit_("2025-01-06 14:05", 5000, realized_pnl=-50.0, commission=0.0),
    ]
    trades = pair_trades(fills)
    stats = compute_stats(trades, risk_dollars_per_trade=50.0)
    assert stats.n_trades == 2
    assert stats.win_rate == 0.5
    assert stats.expectancy_dollars == pytest.approx((100.0 - 50.0) / 2)
    assert stats.expectancy_r == pytest.approx(((100.0 - 50.0) / 2) / 50.0)
