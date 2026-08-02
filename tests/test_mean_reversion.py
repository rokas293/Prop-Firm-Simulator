from __future__ import annotations

import pandas as pd
import pytest

from propbt.config import load_contracts, load_prop_rules
from propbt.data.sessions import tag_sessions
from propbt.engine.backtester import run_backtest
from propbt.reporting.metrics import pair_trades
from propbt.strategy.session_open import (
    ContinuationConfig,
    MeanReversionConfig,
    MeanReversionLeg,
    SessionOpenContinuation,
    SessionOpenStrategy,
    atr,
    is_consolidating,
    most_recent_confirmed_swing,
    range_compression,
    volume_ratio,
)
from tests.conftest import make_ohlcv
from tests.test_session_open import build_states, ny_bars, sessions_cfg  # noqa: F401 -- reuse fixture/helpers


def make_mr_config(**overrides):
    defaults = dict(
        sessions=("ny",), max_trades_per_session=3, compression_method="range",
        compression_lookback_bars=5, compression_threshold_points=3.0,
        require_volume_confirmation=False, volume_lookback_bars=5, volume_baseline_bars=20,
        volume_ratio_threshold=0.7, swing_lookback_bars=2, direction_mode="fade_break",
        contracts=1, sl_points=8.0, rr=1.0,
    )
    defaults.update(overrides)
    return MeanReversionConfig(**defaults)


# --- config validation -----------------------------------------------------

def test_rejects_bad_rr():
    with pytest.raises(ValueError):
        make_mr_config(rr=1.25)


def test_rejects_baseline_not_longer_than_recent_window():
    with pytest.raises(ValueError):
        make_mr_config(require_volume_confirmation=True, volume_lookback_bars=10, volume_baseline_bars=10)


def test_rejects_bad_direction_mode():
    with pytest.raises(ValueError):
        make_mr_config(direction_mode="something_else")


# --- range / ATR compression ------------------------------------------------

def test_range_compression_basic():
    idx = pd.date_range("2025-01-06 13:00", periods=5, freq="1min", tz="UTC")
    df = make_ohlcv(idx, [1] * 5, [10, 12, 11, 13, 9], [8, 9, 8, 10, 7], [1] * 5, [1] * 5)
    assert range_compression(df, 5) == pytest.approx(13 - 7)


def test_range_compression_insufficient_bars_is_none():
    idx = pd.date_range("2025-01-06 13:00", periods=3, freq="1min", tz="UTC")
    df = make_ohlcv(idx, [1] * 3, [10, 11, 12], [9, 10, 11], [1] * 3, [1] * 3)
    assert range_compression(df, 5) is None


def test_atr_basic():
    idx = pd.date_range("2025-01-06 13:00", periods=3, freq="1min", tz="UTC")
    df = make_ohlcv(idx, [100, 101, 102], [101, 102, 103], [99, 100, 101], [100, 101, 102], [1, 1, 1])
    assert atr(df, 2) == pytest.approx(2.0)


def test_atr_insufficient_bars_is_none():
    idx = pd.date_range("2025-01-06 13:00", periods=3, freq="1min", tz="UTC")
    df = make_ohlcv(idx, [100, 101, 102], [101, 102, 103], [99, 100, 101], [100, 101, 102], [1, 1, 1])
    assert atr(df, 5) is None


# --- volume ratio ------------------------------------------------------------

def test_volume_ratio_basic():
    idx = pd.date_range("2025-01-06 13:00", periods=50, freq="1min", tz="UTC")
    volumes = [100] * 40 + [50] * 10
    df = make_ohlcv(idx, [1] * 50, [1] * 50, [1] * 50, [1] * 50, volumes)
    baseline_avg = (40 * 100 + 10 * 50) / 50
    expected = 50 / baseline_avg
    assert volume_ratio(df, recent_bars=10, baseline_bars=50) == pytest.approx(expected)


def test_volume_ratio_insufficient_baseline_is_none():
    idx = pd.date_range("2025-01-06 13:00", periods=10, freq="1min", tz="UTC")
    df = make_ohlcv(idx, [1] * 10, [1] * 10, [1] * 10, [1] * 10, [100] * 10)
    assert volume_ratio(df, recent_bars=5, baseline_bars=50) is None


# --- consolidation combining range + volume ----------------------------------

def test_is_consolidating_range_only_pass():
    idx = pd.date_range("2025-01-06 13:00", periods=5, freq="1min", tz="UTC")
    df = make_ohlcv(idx, [100] * 5, [101, 101.5, 101, 100.5, 101], [100, 99.5, 100, 99.5, 100], [100] * 5, [1] * 5)
    cfg = make_mr_config(compression_threshold_points=3.0, require_volume_confirmation=False)
    assert is_consolidating(df, cfg) is True


def test_is_consolidating_range_fail_too_wide():
    idx = pd.date_range("2025-01-06 13:00", periods=5, freq="1min", tz="UTC")
    df = make_ohlcv(idx, [100] * 5, [110, 105, 108, 95, 102], [90, 95, 92, 85, 88], [100] * 5, [1] * 5)
    cfg = make_mr_config(compression_threshold_points=3.0, require_volume_confirmation=False)
    assert is_consolidating(df, cfg) is False


def test_is_consolidating_requires_volume_confirmation_when_enabled():
    idx = pd.date_range("2025-01-06 13:00", periods=25, freq="1min", tz="UTC")
    # tight range throughout, but volume stays flat (not "dried up") -> should fail the volume check
    highs = [101] * 25
    lows = [99] * 25
    volumes = [100] * 25
    df = make_ohlcv(idx, [100] * 25, highs, lows, [100] * 25, volumes)
    cfg = make_mr_config(compression_threshold_points=3.0, require_volume_confirmation=True,
                          volume_lookback_bars=5, volume_baseline_bars=20, volume_ratio_threshold=0.7)
    assert is_consolidating(df, cfg) is False  # range ok, but ratio ~1.0 > 0.7 threshold


def test_is_consolidating_passes_with_range_and_volume_both_confirming():
    idx = pd.date_range("2025-01-06 13:00", periods=25, freq="1min", tz="UTC")
    highs = [101] * 25
    lows = [99] * 25
    volumes = [100] * 20 + [30] * 5  # recent volume clearly dried up vs baseline
    df = make_ohlcv(idx, [100] * 25, highs, lows, [100] * 25, volumes)
    cfg = make_mr_config(compression_threshold_points=3.0, require_volume_confirmation=True,
                          volume_lookback_bars=5, volume_baseline_bars=20, volume_ratio_threshold=0.7)
    assert is_consolidating(df, cfg) is True


# --- swing point detection (with confirmation lag) ---------------------------

def test_swing_high_not_yet_confirmed_before_w_bars_elapse():
    idx = pd.date_range("2025-01-06 13:00", periods=5, freq="1min", tz="UTC")
    highs = [100.5, 101, 101.5, 101, 100.5]  # peak at index 2
    lows = [99.5, 99, 98.5, 99, 99.5]
    df = make_ohlcv(idx, highs, highs, lows, highs, [1] * 5)
    # only 5 bars total; w=2 needs the peak (index 2) to have 2 bars after it,
    # which it does (indices 3,4) -- but check a SHORTER slice where it doesn't yet
    high_none, low_none = most_recent_confirmed_swing(df.iloc[:4], w=2)  # only 4 bars: peak has just 1 bar after it
    assert high_none is None


def test_swing_high_confirmed_once_w_bars_elapse():
    idx = pd.date_range("2025-01-06 13:00", periods=5, freq="1min", tz="UTC")
    highs = [100.5, 101, 101.5, 101, 100.5]
    lows = [99.5, 99, 98.5, 99, 99.5]
    df = make_ohlcv(idx, highs, highs, lows, highs, [1] * 5)
    swing_high, _ = most_recent_confirmed_swing(df, w=2)
    assert swing_high == pytest.approx(101.5)


def test_swing_high_and_low_detected_independently():
    idx = pd.date_range("2025-01-06 13:00", periods=9, freq="1min", tz="UTC")
    highs = [10, 11, 12, 15, 12, 11, 10, 9, 9]     # swing high at index 3
    lows = [20, 19, 18, 17, 18, 19, 5, 19, 20]      # swing low at index 6
    closes = [(h + l) / 2 for h, l in zip(highs, lows)]
    df = make_ohlcv(idx, closes, highs, lows, closes, [1] * 9)
    swing_high, swing_low = most_recent_confirmed_swing(df, w=2)
    assert swing_high == pytest.approx(15)
    assert swing_low == pytest.approx(5)


def test_no_swing_when_flat():
    idx = pd.date_range("2025-01-06 13:00", periods=9, freq="1min", tz="UTC")
    df = make_ohlcv(idx, [100] * 9, [101] * 9, [99] * 9, [100] * 9, [1] * 9)
    swing_high, swing_low = most_recent_confirmed_swing(df, w=2)
    # a flat market: every bar ties for max/min in its window -- the scan
    # still finds A confirmed swing (the closest tie), just not a meaningful one
    assert swing_high == pytest.approx(101)
    assert swing_low == pytest.approx(99)


# --- MeanReversionLeg: entry direction / timing / gating ---------------------

# Session bars: 5 quiet consolidation bars (offsets 0-4, tight range, swing
# high forms at offset 2 = 101.5, confirmed once offset 4 is seen), then a
# breakout bar (offset 5, close 102.5 > 101.5) triggers the BoS.
CONSOLIDATION_AND_BREAKOUT = [
    (-1, 100, 100, 100, 100),           # fair value bar
    (0, 100.5, 100.5, 99.5, 100.5),
    (1, 100.8, 101, 100, 100.8),
    (2, 101, 101.5, 100.5, 101),
    (3, 100.8, 101, 100, 100.8),
    (4, 100.5, 100.5, 99.5, 100.5),
    (5, 100.5, 103, 100, 102.5),         # breakout bar: close 102.5 > swing high 101.5
    (6, 102.6, 103, 102, 102.8),         # next bar -- entry fills here
]


def test_bos_fade_break_shorts_an_upside_break(sessions_cfg):
    df = ny_bars("2025-03-11", CONSOLIDATION_AND_BREAKOUT)
    cfg = make_mr_config(direction_mode="fade_break")
    leg = MeanReversionLeg(cfg, sessions_cfg)
    states = build_states(df, "MES", sessions_cfg)

    orders = []
    for s in states:
        orders.extend(leg.on_bar(s))
    assert len(orders) == 1
    assert orders[0].side.value == "short"
    assert orders[0].ts == states[6].bar.ts  # decided on the breakout bar (offset 5)


def test_bos_join_break_longs_an_upside_break(sessions_cfg):
    df = ny_bars("2025-03-11", CONSOLIDATION_AND_BREAKOUT)
    cfg = make_mr_config(direction_mode="join_break")
    leg = MeanReversionLeg(cfg, sessions_cfg)
    states = build_states(df, "MES", sessions_cfg)

    orders = []
    for s in states:
        orders.extend(leg.on_bar(s))
    assert len(orders) == 1
    assert orders[0].side.value == "long"


def test_bos_blocked_when_not_consolidating(sessions_cfg):
    # same breakout, but widen the pre-breakout range well past the threshold
    wide = [
        (-1, 100, 100, 100, 100),
        (0, 100, 105, 95, 100),
        (1, 100, 108, 92, 100),
        (2, 100, 110, 90, 101),   # still forms a swing high (110) but the range is huge
        (3, 100, 105, 95, 100),
        (4, 100, 103, 97, 100),
        (5, 100, 112, 100, 111),   # close beyond the swing high (110)
    ]
    df = ny_bars("2025-03-11", wide)
    cfg = make_mr_config(compression_threshold_points=3.0)  # far tighter than this range
    leg = MeanReversionLeg(cfg, sessions_cfg)
    states = build_states(df, "MES", sessions_cfg)

    orders = []
    for s in states:
        orders.extend(leg.on_bar(s))
    assert orders == []


def test_no_trade_outside_configured_sessions(sessions_cfg):
    df = ny_bars("2025-03-11", CONSOLIDATION_AND_BREAKOUT)
    cfg = make_mr_config(sessions=("asia", "london"))  # ny not enabled
    leg = MeanReversionLeg(cfg, sessions_cfg)
    states = build_states(df, "MES", sessions_cfg)

    orders = []
    for s in states:
        orders.extend(leg.on_bar(s))
    assert orders == []


def test_does_not_refire_on_the_same_broken_level(sessions_cfg):
    extended = CONSOLIDATION_AND_BREAKOUT + [
        (7, 102.8, 103.5, 102.5, 103.2),  # keeps extending beyond the SAME swing high -- must not refire
        (8, 103.2, 104, 103, 103.8),
    ]
    df = ny_bars("2025-03-11", extended)
    cfg = make_mr_config()
    leg = MeanReversionLeg(cfg, sessions_cfg)
    states = build_states(df, "MES", sessions_cfg)

    orders = []
    for s in states:
        orders.extend(leg.on_bar(s))
    assert len(orders) == 1  # only the original breakout, not the continued drift


def test_max_trades_per_session_caps_attempts(sessions_cfg):
    df = ny_bars("2025-03-11", CONSOLIDATION_AND_BREAKOUT)
    cfg = make_mr_config(max_trades_per_session=0 + 1)
    leg = MeanReversionLeg(cfg, sessions_cfg)
    # manually mark the session as already having used its one trade
    states = build_states(df, "MES", sessions_cfg)
    key = (states[0].trading_day, "ny")
    leg._trade_count[key] = 1  # already at the cap

    orders = []
    for s in states:
        orders.extend(leg.on_bar(s))
    assert orders == []


# --- combined strategy: legs stay independently toggleable -------------------

def test_session_open_strategy_runs_both_legs_when_enabled(sessions_cfg):
    df = ny_bars("2025-03-11", CONSOLIDATION_AND_BREAKOUT)
    cont_cfg = ContinuationConfig(sessions=("ny",), direction_method="close_vs_fair_value",
                                   observation_window_minutes=1, contracts=1, sl_points=10, rr=1.0)
    mr_cfg = make_mr_config()
    strat = SessionOpenStrategy(
        continuation=SessionOpenContinuation(cont_cfg, sessions_cfg),
        mean_reversion=MeanReversionLeg(mr_cfg, sessions_cfg),
    )
    states = build_states(df, "MES", sessions_cfg)
    orders = []
    for s in states:
        orders.extend(strat.on_bar(s))

    reasons = {o.reason.split(":")[0] for o in orders}
    assert "continuation" in reasons
    assert "mean_reversion" in reasons


def test_session_open_strategy_mean_reversion_only_when_continuation_disabled(sessions_cfg):
    df = ny_bars("2025-03-11", CONSOLIDATION_AND_BREAKOUT)
    mr_cfg = make_mr_config()
    strat = SessionOpenStrategy(continuation=None, mean_reversion=MeanReversionLeg(mr_cfg, sessions_cfg))
    states = build_states(df, "MES", sessions_cfg)
    orders = []
    for s in states:
        orders.extend(strat.on_bar(s))
    assert all(o.reason.startswith("mean_reversion") for o in orders)
    assert len(orders) == 1


# --- end-to-end through the real engine: no-look-ahead + SL/TP accounting ----

def test_end_to_end_no_lookahead_and_sl_tp_accounting(sessions_cfg):
    df = ny_bars("2025-03-11", CONSOLIDATION_AND_BREAKOUT + [
        (7, 102.5, 102.6, 94.0, 94.5),   # SHORT's SL (entry+8) sits well above; TP (entry-8) breached here
    ])
    cfg = make_mr_config(sl_points=8.0, rr=1.0, direction_mode="fade_break")
    contracts = load_contracts()
    prop_cfg = load_prop_rules()

    leg = MeanReversionLeg(cfg, sessions_cfg)
    result = run_backtest(df, symbol="MES", strategy=leg, contracts=contracts,
                           prop_rules_config=prop_cfg, sessions_config=sessions_cfg, slippage_ticks=0)

    entries = [f for f in result.fills if f.fill_type.value == "entry"]
    assert len(entries) == 1
    entry = entries[0]
    assert entry.order_ts == df.index[6]     # decided on the breakout bar (offset 5 -> df.index[6])
    assert entry.ts == df.index[7]            # filled on the NEXT bar (offset 6)
    assert entry.price == 102.6               # at that bar's open, not the breakout bar's close (102.5)
    assert entry.reason == "mean_reversion:ny"

    trades = pair_trades(result.fills)
    assert len(trades) == 1
    assert trades[0].exit_type.value == "take_profit"
    spec = contracts["MES"]
    expected_gross = (102.6 - 94.6) * spec.point_value * 1  # short: entry - tp = 102.6 - (102.6-8)
    assert trades[0].realized_pnl == pytest.approx(expected_gross - prop_cfg.commissions["MES"])
