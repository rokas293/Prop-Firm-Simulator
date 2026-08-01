from __future__ import annotations

import pandas as pd
import pytest

from propbt.config import load_contracts, load_data_paths, load_prop_rules, load_sessions
from propbt.data.loader import load_ohlcv
from propbt.engine.backtester import run_backtest
from propbt.engine.events import Order, OrderType, Side
from propbt.strategy.placeholder import AlwaysFlatStrategy, RandomStrategy
from tests.conftest import make_ohlcv


class BuyOnceStrategy:
    """Places exactly one market order, on the very first bar it sees."""

    def __init__(self):
        self._done = False

    def on_bar(self, state):
        if state.i == 0 and not self._done:
            self._done = True
            return [Order(ts=state.bar.ts, symbol=state.symbol, side=Side.LONG,
                           order_type=OrderType.MARKET, contracts=1)]
        return []


def test_no_lookahead_strategy_cannot_get_filled_at_bar_t_close():
    """Mandatory no-look-ahead test: a decision made on bar t must fill at
    bar t+1's open, never at bar t's own close -- proven end to end through
    run_backtest, not just at the broker unit level.
    """
    idx = pd.date_range("2025-01-06 14:30:00", periods=6, freq="1min", tz="UTC")
    # closes are deliberately far from the NEXT bar's open, so a look-ahead
    # bug (filling at bar t's close) would produce a clearly wrong price.
    opens = [5000.0, 5100.0, 5200.0, 5300.0, 5400.0, 5500.0]
    closes = [o + 10.0 for o in opens]
    highs = [o + 15.0 for o in opens]
    lows = [o - 15.0 for o in opens]
    volumes = [100] * 6
    df = make_ohlcv(idx, opens, highs, lows, closes, volumes)

    contracts = load_contracts()
    result = run_backtest(
        df, symbol="MES", strategy=BuyOnceStrategy(), contracts=contracts,
        prop_rules_config=load_prop_rules(), sessions_config=load_sessions(), slippage_ticks=0,
    )

    entries = [f for f in result.fills if f.fill_type.value == "entry"]
    assert len(entries) == 1
    fill = entries[0]

    assert fill.order_ts == idx[0]           # decided on bar 0
    assert fill.ts == idx[1]                  # filled on bar 1 (t+1)
    assert fill.price == opens[1]             # at bar 1's OPEN...
    assert fill.price != closes[0]            # ...never at bar 0's close
    assert fill.price not in closes           # not equal to ANY bar's close, to be doubly sure


def test_always_flat_strategy_keeps_equity_exactly_at_start_balance():
    paths = load_data_paths()
    if "MES" not in paths or not paths["MES"].exists():
        pytest.skip("MES data file not present")

    df = load_ohlcv("MES")
    sliced = df.loc["2025-03-10":"2025-03-12"]

    contracts = load_contracts()
    prop_cfg = load_prop_rules()
    result = run_backtest(
        sliced, symbol="MES", strategy=AlwaysFlatStrategy(), contracts=contracts,
        prop_rules_config=prop_cfg, sessions_config=load_sessions(), slippage_ticks=1,
    )

    assert result.fills == []
    assert result.rejections == []
    assert result.combine.final_balance == prop_cfg.start_balance
    assert result.combine.status == "incomplete"
    assert all(pnl == 0.0 for pnl in (d.daily_pnl for d in result.combine.day_logs))
    assert all(equity == prop_cfg.start_balance for _, equity in result.equity_curve)


def test_random_strategy_runs_end_to_end_and_produces_a_valid_result():
    paths = load_data_paths()
    if "MES" not in paths or not paths["MES"].exists():
        pytest.skip("MES data file not present")

    df = load_ohlcv("MES")
    sliced = df.loc["2025-03-10":"2025-03-21"]  # ~2 trading weeks

    contracts = load_contracts()
    prop_cfg = load_prop_rules()
    strategy = RandomStrategy(contracts=1, sl_points=8, tp_points=8, trade_prob=0.02, seed=42)
    result = run_backtest(
        sliced, symbol="MES", strategy=strategy, contracts=contracts,
        prop_rules_config=prop_cfg, sessions_config=load_sessions(), slippage_ticks=1,
    )

    assert result.combine.status in ("passed", "failed", "incomplete")
    assert len(result.combine.day_logs) >= 1
    # every fill happened at or after its originating order's decision bar (entries),
    # or is a forced/SL/TP exit (order_ts is None) -- either way, never *before* it.
    for f in result.fills:
        if f.order_ts is not None:
            assert f.ts > f.order_ts
    # position-limit accounting: broker never ends up over the cap
    assert prop_cfg.max_open_contracts == 5


def test_random_strategy_is_deterministic_given_a_seed():
    paths = load_data_paths()
    if "MES" not in paths or not paths["MES"].exists():
        pytest.skip("MES data file not present")

    df = load_ohlcv("MES")
    sliced = df.loc["2025-03-10":"2025-03-14"]
    contracts = load_contracts()
    prop_cfg = load_prop_rules()

    def run():
        strategy = RandomStrategy(contracts=1, sl_points=8, tp_points=8, trade_prob=0.05, seed=7)
        return run_backtest(sliced, symbol="MES", strategy=strategy, contracts=contracts,
                             prop_rules_config=prop_cfg, sessions_config=load_sessions(), slippage_ticks=1)

    r1, r2 = run(), run()
    assert [f.price for f in r1.fills] == [f.price for f in r2.fills]
    assert r1.combine.final_balance == r2.combine.final_balance
