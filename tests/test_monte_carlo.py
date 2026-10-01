from __future__ import annotations

import datetime as dt

import pandas as pd
import pytest

from propbt.config import load_contracts, load_prop_rules, load_sessions
from propbt.engine.events import Order, OrderType, Side
from propbt.sim.monte_carlo import (
    available_trading_days,
    run_monte_carlo,
    run_trade_sequence_monte_carlo,
    sample_start_dates,
)
from propbt.strategy.placeholder import AlwaysFlatStrategy
from tests.conftest import make_ohlcv


def flat_df(start: str, n_days: int, price: float = 5000.0) -> pd.DataFrame:
    idx = pd.date_range(start, periods=n_days * 1440, freq="1min", tz="UTC")
    n = len(idx)
    return make_ohlcv(idx, [price] * n, [price + 0.5] * n, [price - 0.5] * n, [price] * n, [100] * n)


def declining_df(start: str, n_days: int, start_price: float = 5000.0, pts_per_bar: float = 0.1) -> pd.DataFrame:
    """Monotonically declining price -- so a strategy that always goes LONG
    reliably racks up a large unrealized loss regardless of which bar it
    enters on."""
    idx = pd.date_range(start, periods=n_days * 1440, freq="1min", tz="UTC")
    n = len(idx)
    closes = [start_price - i * pts_per_bar for i in range(n)]
    highs = [c + 0.5 for c in closes]
    lows = [c - 0.5 for c in closes]
    return make_ohlcv(idx, closes, highs, lows, closes, [100] * n)


class AlwaysBreachStrategy:
    """Re-enters a huge losing (no-stop) LONG position every time it's
    flat. Against declining_df, day 1 gets flattened by the $1000 daily
    loss lock (as intended -- that's not a Combine fail), but re-entering
    on day 2 drives equity down through the (still-48000, never-trailed-up)
    MLL floor before day 2's OWN daily-lock threshold is reached, since
    48000 > day2_start-1000. That reliably forces a real MLL breach within
    a couple of days, for testing fail-reason aggregation."""

    def on_bar(self, state):
        if state.daily_locked or state.symbol in state.open_positions:
            return []
        return [Order(ts=state.bar.ts, symbol=state.symbol, side=Side.LONG,
                       order_type=OrderType.MARKET, contracts=5, sl_points=100000, tp_points=100000)]


@pytest.fixture(scope="module")
def sessions_cfg():
    return load_sessions()


@pytest.fixture(scope="module")
def contracts():
    return load_contracts()


@pytest.fixture(scope="module")
def prop_cfg():
    return load_prop_rules()


def test_available_trading_days_sorted_and_deduped(sessions_cfg):
    df = flat_df("2025-01-01 00:00:00", n_days=5)
    days = available_trading_days(df, sessions_cfg)
    assert days == sorted(set(days))
    assert len(days) >= 4  # ~5 calendar days worth of trading-day boundaries


def test_sample_start_dates_rolling_is_stride_spaced(sessions_cfg):
    df = flat_df("2025-01-01 00:00:00", n_days=30)
    dates = sample_start_dates(df, sessions_cfg, n_attempts=5, method="rolling", stride_days=3, warmup_days=2)
    days = available_trading_days(df, sessions_cfg)
    cutoff = days[0] + dt.timedelta(days=2)
    candidates = [d for d in days if d >= cutoff]
    assert dates == candidates[::3][:5]


def test_sample_start_dates_random_is_seeded_and_reproducible(sessions_cfg):
    df = flat_df("2025-01-01 00:00:00", n_days=30)
    d1 = sample_start_dates(df, sessions_cfg, n_attempts=5, method="random", seed=42, warmup_days=2)
    d2 = sample_start_dates(df, sessions_cfg, n_attempts=5, method="random", seed=42, warmup_days=2)
    assert d1 == d2
    assert d1 == sorted(d1)  # returned in chronological order


def test_sample_start_dates_respects_warmup_cutoff(sessions_cfg):
    df = flat_df("2025-01-01 00:00:00", n_days=10)
    days = available_trading_days(df, sessions_cfg)
    dates = sample_start_dates(df, sessions_cfg, n_attempts=100, method="rolling", stride_days=1, warmup_days=4)
    assert all(d >= days[0] + dt.timedelta(days=4) for d in dates)


def test_monte_carlo_all_incomplete_with_flat_strategy(sessions_cfg, contracts, prop_cfg):
    df = flat_df("2025-01-01 00:00:00", n_days=20)
    dates = sample_start_dates(df, sessions_cfg, n_attempts=3, method="rolling", stride_days=3, warmup_days=2)
    mc = run_monte_carlo(df, "MES", AlwaysFlatStrategy, contracts, prop_cfg, sessions_cfg,
                          dates, warmup_days=2, max_calendar_days=3)
    assert mc.n_attempts == len(dates)
    assert mc.n_incomplete == mc.n_attempts
    assert mc.n_passed == 0 and mc.n_failed == 0
    assert mc.pass_rate == 0.0
    import math
    assert math.isnan(mc.resolved_pass_rate)
    assert mc.days_to_pass == []
    assert mc.fail_reasons == {}


def test_monte_carlo_aggregates_mll_breach_fail_reasons(sessions_cfg, contracts, prop_cfg):
    df = declining_df("2025-01-01 00:00:00", n_days=20)
    dates = sample_start_dates(df, sessions_cfg, n_attempts=3, method="rolling", stride_days=3, warmup_days=2)
    mc = run_monte_carlo(df, "MES", AlwaysBreachStrategy, contracts, prop_cfg, sessions_cfg,
                          dates, warmup_days=2, max_calendar_days=5)
    assert mc.n_failed == mc.n_attempts
    assert mc.fail_reasons == {"mll_breach": mc.n_attempts}
    assert mc.pass_rate == 0.0
    assert mc.resolved_pass_rate == 0.0


# --- trade-sequence Monte Carlo (resamples realized per-trade PnL) ---

def test_trade_sequence_mc_shuffle_keeps_terminal_pnl_and_reports_actual_path():
    # Hand check: cumulative PnL after each trade is 100, 50, 250; worst
    # peak-to-trough drop in the realized order is 100 -> 50 = 50.
    mc = run_trade_sequence_monte_carlo([100.0, -50.0, 200.0], n_sims=200, method="shuffle", seed=1)
    assert mc.actual_path == [0.0, 100.0, 50.0, 250.0]
    assert mc.actual_final_pnl == 250.0
    assert mc.actual_max_drawdown == 50.0
    # A permutation never changes the sum, so every percentile of the terminal PnL is 250.
    assert set(mc.final_pnl_pct.values()) == {250.0}
    assert mc.prob_profit == 1.0
    # Every ordering of these three trades has a max drawdown of exactly 50
    # except [-50, ...] (0 -> -50 = 50) -- all equal 50, none worse.
    assert set(mc.max_drawdown_pct.values()) == {50.0}


def test_trade_sequence_mc_is_deterministic_for_a_seed():
    pnls = [120.0, -80.0, 45.0, -200.0, 310.0, -60.0]
    a = run_trade_sequence_monte_carlo(pnls, n_sims=300, method="bootstrap", seed=7)
    b = run_trade_sequence_monte_carlo(pnls, n_sims=300, method="bootstrap", seed=7)
    c = run_trade_sequence_monte_carlo(pnls, n_sims=300, method="bootstrap", seed=8)
    assert a == b
    assert a.final_pnl_pct != c.final_pnl_pct


def test_trade_sequence_mc_bootstrap_of_constant_trades_and_breach_probability():
    mc = run_trade_sequence_monte_carlo([-300.0, -300.0, -300.0], n_sims=50, method="bootstrap", seed=0,
                                         drawdown_budget_usd=800.0)
    assert set(mc.final_pnl_pct.values()) == {-900.0}
    assert mc.prob_profit == 0.0
    assert mc.prob_drawdown_breach == 1.0       # 900 drawdown >= 800 budget in every sim
    assert len(mc.fan[50]) == 4                  # starting 0 + one point per trade


def test_trade_sequence_mc_rejects_empty_and_unknown_method():
    with pytest.raises(ValueError):
        run_trade_sequence_monte_carlo([], n_sims=10)
    with pytest.raises(ValueError):
        run_trade_sequence_monte_carlo([1.0], n_sims=10, method="nope")  # type: ignore[arg-type]
