"""EngineStepper (propbt/engine/stepper.py): the per-bar loop `run_backtest` is
built on, driven here the way Autopilot drives it -- bars appended in batches,
stepped as they arrive. Streaming must be the same computation as the offline
run, whatever the batch sizes."""
from __future__ import annotations

import dataclasses

import pandas as pd
import pytest

from propbt.config import PropRulesConfig, load_contracts, load_data_paths, load_execution, load_prop_rules, load_sessions
from propbt.data.loader import load_ohlcv
from propbt.engine.backtester import run_backtest
from propbt.engine.events import Order, OrderType, Side
from propbt.engine.stepper import EngineStepper
from propbt.strategy.placeholder import AlwaysFlatStrategy, RandomStrategy
from tests.conftest import make_ohlcv


@pytest.fixture(scope="module")
def mes_week() -> pd.DataFrame:
    paths = load_data_paths()
    if "MES" not in paths or not paths["MES"].exists():
        pytest.skip("MES data file not present")
    return load_ohlcv("MES").loc["2024-02-05":"2024-02-09"].iloc[:3000]


def _random_strategy() -> RandomStrategy:
    return RandomStrategy(contracts=3, sl_points=6.0, tp_points=12.0, trade_prob=0.06, seed=5)


def _stepper(strategy=None, trading_start_ts=None, prop=None) -> EngineStepper:
    return EngineStepper(
        symbol="MES", contracts=load_contracts(), prop_rules_config=prop or load_prop_rules(),
        sessions_config=load_sessions(), slippage_ticks=load_execution().slippage_ticks,
        strategy=strategy, trading_start_ts=trading_start_ts,
    )


def _offline(df, strategy, trading_start_ts=None):
    return run_backtest(
        df, symbol="MES", strategy=strategy, contracts=load_contracts(), prop_rules_config=load_prop_rules(),
        sessions_config=load_sessions(), slippage_ticks=load_execution().slippage_ticks,
        trading_start_ts=trading_start_ts,
    )


def _stream(df, strategy, sizes, trading_start_ts=None):
    s = _stepper(strategy, trading_start_ts)
    pos, k = 0, 0
    while pos < len(df):
        n = sizes[k % len(sizes)]
        s.append(df.iloc[pos:pos + n])
        s.run()
        pos += n
        k += 1
    return s


@pytest.mark.parametrize("sizes", [[1], [7], [60], [1000], [1, 59, 3, 600, 17], [4000]])
def test_streaming_in_batches_equals_the_offline_run(mes_week, sizes):
    ref = _offline(mes_week, _random_strategy())
    assert len(ref.fills) > 20  # the comparison has something to compare

    s = _stream(mes_week, _random_strategy(), sizes)
    assert s.portfolio.fills == ref.fills
    assert s.rejections == ref.rejections
    assert s.equity_log == ref.equity_log
    assert s.portfolio.equity_curve == ref.equity_curve
    assert s.finalize() == ref.combine


def test_streaming_with_warmup_and_trading_start_in_the_middle_of_a_batch(mes_week):
    start = mes_week.index[1500]
    ref = _offline(mes_week, _random_strategy(), trading_start_ts=start)
    assert ref.equity_log[0].ts == start  # warm-up bars were skipped, trading began at `start`

    s = _stream(mes_week, _random_strategy(), [700], trading_start_ts=start)
    assert s.portfolio.fills == ref.fills
    assert s.equity_log == ref.equity_log
    assert s.finalize() == ref.combine


def test_trading_start_after_everything_held_then_bars_arrive(mes_week):
    """Autopilot turned on: warm-up appended first, the activation bar arrives later."""
    start = mes_week.index[900]
    s = _stepper(_random_strategy(), trading_start_ts=start)
    s.append(mes_week.iloc[:900])
    assert s.run() == 0 and s.equity_log == []        # nothing before trading start is processed
    s.append(mes_week.iloc[900:1200])
    s.run()
    assert s.equity_log[0].ts == start
    assert len(s.equity_log) == 300


def test_strategy_none_manages_positions_but_decides_nothing(mes_week):
    s = _stepper(strategy=None)
    s.append(mes_week.iloc[:2000])
    assert s.run() > 0
    assert s.portfolio.fills == [] and s.rejections == []
    assert all(r.equity == 50000.0 for r in s.equity_log)


def test_strategy_attached_mid_run_only_decides_from_then_on(mes_week):
    s = _stepper(strategy=None)
    s.append(mes_week.iloc[:1000])
    s.run()
    s.set_strategy(_random_strategy())
    s.append(mes_week.iloc[1000:3000])
    s.run()
    entries = [f for f in s.portfolio.fills if f.fill_type.value == "entry"]
    assert entries, "random flow should have traded in 2000 bars"
    assert all(f.order_ts >= mes_week.index[1000] for f in entries)
    # and a decision made on the last bar before attaching can't exist: nothing filled before bar 1001
    assert all(f.ts > mes_week.index[1000] for f in entries)


def test_detaching_strategy_keeps_managing_the_open_position(mes_week):
    class OneShot:
        done = False

        def on_bar(self, state):
            if self.done:
                return []
            self.done = True
            return [Order(ts=state.bar.ts, symbol=state.symbol, side=Side.LONG, order_type=OrderType.MARKET,
                          contracts=1, sl_points=5.0, tp_points=5.0)]

    s = _stepper(OneShot())
    s.append(mes_week.iloc[:50])
    s.run()
    s.set_strategy(None)
    s.append(mes_week.iloc[50:3000])
    s.run()
    kinds = [f.fill_type.value for f in s.portfolio.fills]
    assert kinds[0] == "entry" and kinds[1] in ("stop_loss", "take_profit")  # exited by its own SL/TP


def test_overlapping_or_out_of_order_bars_are_refused(mes_week):
    s = _stepper(AlwaysFlatStrategy())
    s.append(mes_week.iloc[:100])
    with pytest.raises(ValueError):
        s.append(mes_week.iloc[50:150])
    with pytest.raises(ValueError):
        s.append(mes_week.iloc[:10])          # older bars than what is held


def test_finished_run_stops_consuming(mes_week):
    cfg = dataclasses.replace(load_prop_rules(), mll_initial_offset=150.0)  # trips quickly
    s = _stepper(RandomStrategy(contracts=5, sl_points=25.0, tp_points=25.0, trade_prob=0.1, seed=1), prop=cfg)
    s.append(mes_week)
    s.run()
    assert s.finished == "failed"
    n = len(s.equity_log)
    assert s.step() is None
    s.set_strategy(None)
    assert s.run() == 0 and len(s.equity_log) == n


def test_uncapped_broker_when_the_rule_set_has_no_position_cap():
    """PropRulesConfig.max_open_contracts is Optional ("no cap"); the broker used to
    compare against None."""
    idx = pd.date_range("2025-01-06 14:30:00", periods=6, freq="1min", tz="UTC")
    opens = [5000.0 + i for i in range(6)]
    df = make_ohlcv(idx, opens, [o + 1 for o in opens], [o - 1 for o in opens], opens, [10] * 6)
    base = load_prop_rules()
    cfg = PropRulesConfig(
        start_balance=base.start_balance, profit_target=base.profit_target, mll_initial_offset=base.mll_initial_offset,
        mll_freeze_trigger_balance=None, mll_freeze_floor=None, daily_loss_limit=None, consistency_max_pct=None,
        max_open_contracts=None, commissions=dict(base.commissions),
    )

    class Big:
        def on_bar(self, state):
            if state.i != 0:
                return []
            return [Order(ts=state.bar.ts, symbol=state.symbol, side=Side.LONG, order_type=OrderType.MARKET, contracts=50)]

    r = run_backtest(df, symbol="MES", strategy=Big(), contracts=load_contracts(), prop_rules_config=cfg,
                     sessions_config=load_sessions(), slippage_ticks=0)
    assert [f.contracts for f in r.fills if f.fill_type.value == "entry"] == [50]
    assert r.rejections == []
