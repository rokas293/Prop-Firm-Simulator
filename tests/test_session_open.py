from __future__ import annotations

import datetime as dt

import pandas as pd
import pytest

from propbt.config import load_contracts, load_prop_rules, load_sessions
from propbt.data.sessions import tag_sessions
from propbt.engine.backtester import run_backtest
from propbt.reporting.metrics import pair_trades
from propbt.strategy.base import BarState
from propbt.strategy.session_open import ContinuationConfig, SessionOpenContinuation
from tests.conftest import make_ohlcv


@pytest.fixture(scope="module")
def sessions_cfg():
    return load_sessions()


def build_states(df: pd.DataFrame, symbol: str, sessions_cfg):
    """Mirror exactly what engine/backtester.py hands the strategy each bar."""
    tagged = tag_sessions(df, sessions_cfg)
    states = []
    for i in range(len(tagged)):
        row = tagged.iloc[i]
        from propbt.engine.events import Bar
        bar = Bar(symbol=symbol, ts=tagged.index[i], open=row["open"], high=row["high"],
                  low=row["low"], close=row["close"], volume=int(row["volume"]),
                  trading_day=row["trading_day"], session=row["session"])
        states.append(BarState(
            symbol=symbol, i=i, bar=bar, history=tagged.iloc[: i + 1],
            open_positions={}, balance=50000.0, equity=50000.0,
            daily_locked=False, trading_day=row["trading_day"],
        ))
    return states


def ny_bars(day: str, minute_offsets_and_ohlc):
    """Build a tiny df of 1-min bars anchored around NY open (13:30 UTC on
    an EDT date). `minute_offsets_and_ohlc` is [(offset_min, o, h, l, c), ...]
    with offset 0 == 13:30 UTC (i.e. offset -1 is the fair-value bar)."""
    base = pd.Timestamp(f"{day} 13:30:00", tz="UTC")
    idx = [base + pd.Timedelta(minutes=m) for m, *_ in minute_offsets_and_ohlc]
    opens = [o for _, o, h, l, c in minute_offsets_and_ohlc]
    highs = [h for _, o, h, l, c in minute_offsets_and_ohlc]
    lows = [l for _, o, h, l, c in minute_offsets_and_ohlc]
    closes = [c for _, o, h, l, c in minute_offsets_and_ohlc]
    volumes = [100] * len(idx)
    return make_ohlcv(idx, opens, highs, lows, closes, volumes)


# --- config validation -------------------------------------------------

def test_rejects_bad_rr():
    with pytest.raises(ValueError):
        ContinuationConfig(sessions=("ny",), direction_method="close_vs_fair_value",
                            observation_window_minutes=1, contracts=1, sl_points=10, rr=1.25)


def test_rejects_bad_window():
    with pytest.raises(ValueError):
        ContinuationConfig(sessions=("ny",), direction_method="close_vs_fair_value",
                            observation_window_minutes=0, contracts=1, sl_points=10, rr=1.0)


def test_tp_points_derived_from_sl_and_rr():
    cfg = ContinuationConfig(sessions=("ny",), direction_method="close_vs_fair_value",
                              observation_window_minutes=1, contracts=2, sl_points=8, rr=2.0)
    assert cfg.tp_points == 16


# --- direction / timing --------------------------------------------------

def test_close_vs_fair_value_long(sessions_cfg):
    df = ny_bars("2025-03-11", [
        (-1, 5000, 5000, 5000, 5000),   # fair value bar (13:29)
        (0, 5000, 5010, 4998, 5005),    # NY open bar: close (5005) > fair value (5000) -> LONG
    ])
    cfg = ContinuationConfig(sessions=("ny",), direction_method="close_vs_fair_value",
                              observation_window_minutes=1, contracts=1, sl_points=10, rr=1.0)
    strat = SessionOpenContinuation(cfg, sessions_cfg)
    states = build_states(df, "MES", sessions_cfg)

    assert strat.on_bar(states[0]) == []           # fair-value bar itself: not in "ny" session
    orders = strat.on_bar(states[1])
    assert len(orders) == 1
    assert orders[0].side.value == "long"
    assert orders[0].ts == states[1].bar.ts
    assert orders[0].sl_points == 10
    assert orders[0].tp_points == 10


def test_close_vs_fair_value_short(sessions_cfg):
    df = ny_bars("2025-03-11", [
        (-1, 5000, 5000, 5000, 5000),
        (0, 5000, 5002, 4990, 4993),    # close (4993) < fair value (5000) -> SHORT
    ])
    cfg = ContinuationConfig(sessions=("ny",), direction_method="close_vs_fair_value",
                              observation_window_minutes=1, contracts=1, sl_points=10, rr=1.0)
    strat = SessionOpenContinuation(cfg, sessions_cfg)
    states = build_states(df, "MES", sessions_cfg)
    strat.on_bar(states[0])
    orders = strat.on_bar(states[1])
    assert orders[0].side.value == "short"


def test_tie_produces_no_signal(sessions_cfg):
    df = ny_bars("2025-03-11", [
        (-1, 5000, 5000, 5000, 5000),
        (0, 5000, 5005, 4995, 5000),    # close == fair value exactly -> no trade
    ])
    cfg = ContinuationConfig(sessions=("ny",), direction_method="close_vs_fair_value",
                              observation_window_minutes=1, contracts=1, sl_points=10, rr=1.0)
    strat = SessionOpenContinuation(cfg, sessions_cfg)
    states = build_states(df, "MES", sessions_cfg)
    strat.on_bar(states[0])
    assert strat.on_bar(states[1]) == []


def test_observation_window_waits_full_n_minutes(sessions_cfg):
    df = ny_bars("2025-03-11", [
        (-1, 5000, 5000, 5000, 5000),   # fair value
        (0, 5000, 5010, 4995, 5008),    # bar 1 of window -- must NOT decide yet
        (1, 5008, 5012, 5000, 5001),    # bar 2 of window -- must NOT decide yet
        (2, 5001, 5006, 4990, 4990),    # bar 3 (window end, window=3) -- close < fair value -> SHORT
    ])
    cfg = ContinuationConfig(sessions=("ny",), direction_method="close_vs_fair_value",
                              observation_window_minutes=3, contracts=1, sl_points=10, rr=1.0)
    strat = SessionOpenContinuation(cfg, sessions_cfg)
    states = build_states(df, "MES", sessions_cfg)

    assert strat.on_bar(states[0]) == []
    assert strat.on_bar(states[1]) == []   # bar 1: window not elapsed
    assert strat.on_bar(states[2]) == []   # bar 2: window not elapsed
    orders = strat.on_bar(states[3])       # bar 3: decide now
    assert len(orders) == 1
    assert orders[0].ts == states[3].bar.ts
    assert orders[0].side.value == "short"


def test_window_displacement_method_ignores_fair_value(sessions_cfg):
    df = ny_bars("2025-03-11", [
        (-1, 9999, 9999, 9999, 9999),   # fair value far away -- irrelevant to this method
        (0, 5000, 5010, 4998, 5005),    # window start: open=5000
        (1, 5005, 5020, 5000, 5010),
        (2, 5010, 5030, 5005, 5025),    # window end: close=5025 > window-start open (5000) -> LONG
    ])
    cfg = ContinuationConfig(sessions=("ny",), direction_method="window_displacement",
                              observation_window_minutes=3, contracts=1, sl_points=10, rr=1.0)
    strat = SessionOpenContinuation(cfg, sessions_cfg)
    states = build_states(df, "MES", sessions_cfg)
    for s in states[:-1]:
        assert strat.on_bar(s) == []
    orders = strat.on_bar(states[-1])
    assert orders[0].side.value == "long"


def test_exactly_one_trade_per_session_per_day(sessions_cfg):
    df = ny_bars("2025-03-11", [
        (-1, 5000, 5000, 5000, 5000),
        (0, 5000, 5010, 4998, 5005),   # triggers LONG
        (1, 5005, 5006, 5004, 5005),   # still "ny" session, must NOT trigger again
        (2, 5005, 5006, 5004, 5005),
    ])
    cfg = ContinuationConfig(sessions=("ny",), direction_method="close_vs_fair_value",
                              observation_window_minutes=1, contracts=1, sl_points=10, rr=1.0)
    strat = SessionOpenContinuation(cfg, sessions_cfg)
    states = build_states(df, "MES", sessions_cfg)

    strat.on_bar(states[0])
    first = strat.on_bar(states[1])
    assert len(first) == 1
    assert strat.on_bar(states[2]) == []
    assert strat.on_bar(states[3]) == []


def test_session_not_in_config_is_never_traded(sessions_cfg):
    df = ny_bars("2025-03-11", [
        (-1, 5000, 5000, 5000, 5000),
        (0, 5000, 5010, 4998, 5005),
    ])
    cfg = ContinuationConfig(sessions=("asia", "london"), direction_method="close_vs_fair_value",
                              observation_window_minutes=1, contracts=1, sl_points=10, rr=1.0)
    strat = SessionOpenContinuation(cfg, sessions_cfg)
    states = build_states(df, "MES", sessions_cfg)
    assert strat.on_bar(states[0]) == []
    assert strat.on_bar(states[1]) == []  # "ny" session bar, but ny isn't enabled


# --- end-to-end: no-look-ahead + SL/TP accounting through the real engine --

def test_end_to_end_no_lookahead_and_tp_accounting(sessions_cfg):
    df = ny_bars("2025-03-11", [
        (-1, 5000, 5000, 5000, 5000),   # fair value bar
        (0, 5000, 5002, 4999, 5005),    # decision bar: close 5005 > fair value 5000 -> LONG, ts=13:30
        (1, 5006, 5008, 5004, 5007),    # fills HERE at open=5006 (bar t+1, not bar 0's close 5005)
        (2, 5007, 5025, 5010, 5020),    # high 5025 breaches TP (5006+15=5021)
        (3, 5020, 5021, 5015, 5018),
    ])
    cfg = ContinuationConfig(sessions=("ny",), direction_method="close_vs_fair_value",
                              observation_window_minutes=1, contracts=1, sl_points=10, rr=1.5)
    contracts = load_contracts()
    prop_cfg = load_prop_rules()

    strategy = SessionOpenContinuation(cfg, sessions_cfg)
    result = run_backtest(df, symbol="MES", strategy=strategy, contracts=contracts,
                           prop_rules_config=prop_cfg, sessions_config=sessions_cfg, slippage_ticks=0)

    entries = [f for f in result.fills if f.fill_type.value == "entry"]
    assert len(entries) == 1
    entry = entries[0]
    assert entry.order_ts == df.index[1]   # decided on bar 0 of the session (13:30)
    assert entry.ts == df.index[2]          # filled on the NEXT bar (13:31)
    assert entry.price == 5006              # at that bar's OPEN, not bar 0's close (5005)
    assert entry.price != 5005

    exits = [f for f in result.fills if f.fill_type.value != "entry"]
    assert len(exits) == 1
    assert exits[0].fill_type.value == "take_profit"
    assert exits[0].price == pytest.approx(5006 + 15)  # tp = sl(10) * rr(1.5) = 15 pts, no slippage on TP

    spec = contracts["MES"]
    commission = prop_cfg.commissions["MES"]
    expected_pnl = (5021 - 5006) * spec.point_value * 1 - commission
    assert exits[0].realized_pnl == pytest.approx((5021 - 5006) * spec.point_value * 1)

    trades = pair_trades(result.fills)
    assert len(trades) == 1
    assert trades[0].realized_pnl == pytest.approx(expected_pnl)
    assert trades[0].exit_type.value == "take_profit"


def test_end_to_end_stop_loss_accounting(sessions_cfg):
    df = ny_bars("2025-03-11", [
        (-1, 5000, 5000, 5000, 5000),
        (0, 5000, 5002, 4999, 5005),    # LONG decision
        (1, 5006, 5008, 5004, 5007),    # entry fills at open=5006; SL = 5006-10=4996
        (2, 5007, 5009, 4990, 4995),    # low 4990 breaches SL
    ])
    cfg = ContinuationConfig(sessions=("ny",), direction_method="close_vs_fair_value",
                              observation_window_minutes=1, contracts=1, sl_points=10, rr=1.0)
    contracts = load_contracts()
    prop_cfg = load_prop_rules()

    strategy = SessionOpenContinuation(cfg, sessions_cfg)
    result = run_backtest(df, symbol="MES", strategy=strategy, contracts=contracts,
                           prop_rules_config=prop_cfg, sessions_config=sessions_cfg, slippage_ticks=0)

    trades = pair_trades(result.fills)
    assert len(trades) == 1
    assert trades[0].exit_type.value == "stop_loss"
    spec = contracts["MES"]
    commission = prop_cfg.commissions["MES"]
    expected_pnl = (4996 - 5006) * spec.point_value * 1 - commission
    assert trades[0].realized_pnl == pytest.approx(expected_pnl)


def test_per_session_tagging_via_pair_trades(sessions_cfg):
    df = ny_bars("2025-03-11", [
        (-1, 5000, 5000, 5000, 5000),
        (0, 5000, 5002, 4999, 5005),
        (1, 5006, 5008, 5004, 5007),
        (2, 5007, 5009, 4990, 4995),
    ])
    cfg = ContinuationConfig(sessions=("ny",), direction_method="close_vs_fair_value",
                              observation_window_minutes=1, contracts=1, sl_points=10, rr=1.0)
    contracts = load_contracts()
    prop_cfg = load_prop_rules()
    strategy = SessionOpenContinuation(cfg, sessions_cfg)
    result = run_backtest(df, symbol="MES", strategy=strategy, contracts=contracts,
                           prop_rules_config=prop_cfg, sessions_config=sessions_cfg, slippage_ticks=0)

    session_by_ts = tag_sessions(df, sessions_cfg)["session"]
    trades = pair_trades(result.fills, session_by_ts)
    assert trades[0].session == "ny"
