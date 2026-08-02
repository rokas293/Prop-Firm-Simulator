from __future__ import annotations

import math

import pandas as pd
import pytest

from propbt.engine.events import Fill, FillType, Side
from propbt.reporting.metrics import compute_stats, pair_trades


def entry(ts, price, contracts=1, symbol="MES", reason=""):
    return Fill(ts=pd.Timestamp(ts, tz="UTC"), symbol=symbol, side=Side.LONG, contracts=contracts,
                price=price, fill_type=FillType.ENTRY, reason=reason)


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


def test_pair_trades_parses_leg_from_entry_reason():
    fills = [
        entry("2025-01-06 13:30", 5000, reason="continuation:ny"),
        exit_("2025-01-06 13:35", 5020, realized_pnl=100.0),
        entry("2025-01-06 14:00", 5010, reason="mean_reversion:london"),
        exit_("2025-01-06 14:05", 5000, realized_pnl=-50.0, fill_type=FillType.STOP_LOSS),
    ]
    trades = pair_trades(fills)
    assert trades[0].leg == "continuation"
    assert trades[1].leg == "mean_reversion"


def test_pair_trades_no_reason_means_no_leg():
    fills = [entry("2025-01-06 13:30", 5000), exit_("2025-01-06 13:35", 5020, realized_pnl=100.0)]
    trades = pair_trades(fills)
    assert trades[0].leg is None


def test_r_multiple_uses_per_leg_risk_dollars():
    fills = [
        entry("2025-01-06 13:30", 5000, reason="continuation:ny"),
        exit_("2025-01-06 13:35", 5020, realized_pnl=100.0, commission=0.0),
        entry("2025-01-06 14:00", 5010, reason="mean_reversion:london"),
        exit_("2025-01-06 14:05", 5000, realized_pnl=-50.0, commission=0.0, fill_type=FillType.STOP_LOSS),
    ]
    trades = pair_trades(fills, risk_dollars_by_leg={"continuation": 50.0, "mean_reversion": 40.0})
    assert trades[0].r_multiple == pytest.approx(100.0 / 50.0)
    assert trades[1].r_multiple == pytest.approx(-50.0 / 40.0)


def test_r_multiple_none_when_risk_unknown():
    fills = [entry("2025-01-06 13:30", 5000), exit_("2025-01-06 13:35", 5020, realized_pnl=100.0)]
    trades = pair_trades(fills)  # no risk_dollars_by_leg given
    assert trades[0].r_multiple is None


def test_compute_stats_empty_is_nan():
    stats = compute_stats([])
    assert stats.n_trades == 0
    assert math.isnan(stats.win_rate)
    assert math.isnan(stats.expectancy_dollars)
    assert math.isnan(stats.expectancy_r)


def test_compute_stats_win_rate_and_expectancy_r():
    fills = [
        entry("2025-01-06 13:30", 5000, reason="leg:ny"),
        exit_("2025-01-06 13:35", 5020, realized_pnl=100.0, commission=0.0),
        entry("2025-01-06 14:00", 5010, reason="leg:ny"),
        exit_("2025-01-06 14:05", 5000, realized_pnl=-50.0, commission=0.0),
    ]
    trades = pair_trades(fills, risk_dollars_by_leg={"leg": 50.0})
    stats = compute_stats(trades)
    assert stats.n_trades == 2
    assert stats.win_rate == 0.5
    assert stats.expectancy_dollars == pytest.approx((100.0 - 50.0) / 2)
    # mean of each trade's own R: (100/50 + -50/50) / 2
    assert stats.expectancy_r == pytest.approx((2.0 + -1.0) / 2)


def test_compute_stats_expectancy_r_ignores_trades_with_unknown_risk():
    fills = [
        entry("2025-01-06 13:30", 5000, reason="known:ny"),
        exit_("2025-01-06 13:35", 5020, realized_pnl=100.0, commission=0.0),
        entry("2025-01-06 14:00", 5010, reason="unknown:ny"),
        exit_("2025-01-06 14:05", 5040, realized_pnl=300.0, commission=0.0),
    ]
    trades = pair_trades(fills, risk_dollars_by_leg={"known": 50.0})
    stats = compute_stats(trades)
    assert stats.n_trades == 2  # both trades counted for win rate / $ expectancy
    assert stats.expectancy_r == pytest.approx(100.0 / 50.0)  # only the trade with known risk contributes
