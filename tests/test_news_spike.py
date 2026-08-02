from __future__ import annotations

import pandas as pd
import pytest

from propbt.config import PROJECT_ROOT, load_contracts, load_prop_rules, load_sessions
from propbt.engine.backtester import run_backtest
from propbt.reporting.metrics import pair_trades
from propbt.strategy.news_spike import (
    NewsContinuationConfig,
    NewsMeanReversionConfig,
    NewsSpikeContinuation,
    NewsSpikeMeanReversion,
    _active_event,
    build_news_legs,
    load_news_spike_config,
)
from tests.conftest import make_ohlcv
from tests.test_session_open import build_states, sessions_cfg  # noqa: F401 -- reuse fixture/helper


def bars_from_anchor(anchor: str, minute_offsets_and_ohlc):
    """Like test_session_open.ny_bars, but anchored at an arbitrary
    timestamp (news events aren't tied to a session open)."""
    base = pd.Timestamp(anchor, tz="UTC")
    idx = [base + pd.Timedelta(minutes=m) for m, *_ in minute_offsets_and_ohlc]
    opens = [o for _, o, h, l, c in minute_offsets_and_ohlc]
    highs = [h for _, o, h, l, c in minute_offsets_and_ohlc]
    lows = [l for _, o, h, l, c in minute_offsets_and_ohlc]
    closes = [c for _, o, h, l, c in minute_offsets_and_ohlc]
    volumes = [100] * len(idx)
    return make_ohlcv(idx, opens, highs, lows, closes, volumes)


def make_news_cont_config(**overrides):
    defaults = dict(direction_method="close_vs_fair_value", observation_window_minutes=1,
                     contracts=1, sl_points=10.0, rr=1.0)
    defaults.update(overrides)
    return NewsContinuationConfig(**defaults)


def make_news_mr_config(**overrides):
    defaults = dict(
        max_trades_per_event=3, compression_method="range", compression_lookback_bars=5,
        compression_threshold_points=3.0, require_volume_confirmation=False,
        volume_lookback_bars=5, volume_baseline_bars=20, volume_ratio_threshold=0.7,
        swing_lookback_bars=2, direction_mode="fade_break", contracts=1, sl_points=8.0, rr=1.0,
    )
    defaults.update(overrides)
    return NewsMeanReversionConfig(**defaults)


# --- _active_event -----------------------------------------------------------

def test_active_event_none_before_any_event():
    events = pd.DatetimeIndex([pd.Timestamp("2025-03-11 18:00:00", tz="UTC")])
    bar_ts = pd.Timestamp("2025-03-11 17:00:00", tz="UTC")
    assert _active_event(bar_ts, events, window_minutes=60) is None


def test_active_event_returns_event_within_window():
    events = pd.DatetimeIndex([pd.Timestamp("2025-03-11 18:00:00", tz="UTC")])
    bar_ts = pd.Timestamp("2025-03-11 18:30:00", tz="UTC")
    assert _active_event(bar_ts, events, window_minutes=60) == events[0]


def test_active_event_none_after_window_elapses():
    events = pd.DatetimeIndex([pd.Timestamp("2025-03-11 18:00:00", tz="UTC")])
    bar_ts = pd.Timestamp("2025-03-11 19:01:00", tz="UTC")
    assert _active_event(bar_ts, events, window_minutes=60) is None


def test_active_event_picks_nearest_preceding_event():
    events = pd.DatetimeIndex([
        pd.Timestamp("2025-03-11 18:00:00", tz="UTC"),
        pd.Timestamp("2025-04-10 12:30:00", tz="UTC"),
    ])
    bar_ts = pd.Timestamp("2025-04-10 12:45:00", tz="UTC")
    assert _active_event(bar_ts, events, window_minutes=60) == events[1]


# --- config validation ---------------------------------------------------

def test_news_continuation_rejects_bad_rr():
    with pytest.raises(ValueError):
        make_news_cont_config(rr=1.25)


def test_news_mean_reversion_rejects_bad_direction_mode():
    with pytest.raises(ValueError):
        make_news_mr_config(direction_mode="nonsense")


# --- continuation: direction + event-window entry timing ---------------------

def test_news_continuation_no_signal_before_event(sessions_cfg):
    df = bars_from_anchor("2025-03-11 18:00:00", [
        (-1, 5000, 5000, 5000, 5000),  # fair value bar, BEFORE the event fires
    ])
    events = pd.DatetimeIndex([pd.Timestamp("2025-03-11 18:00:00", tz="UTC")])
    leg = NewsSpikeContinuation(make_news_cont_config(), events, event_window_minutes=60)
    states = build_states(df, "MES", sessions_cfg)
    assert leg.on_bar(states[0]) == []


def test_news_continuation_fires_at_window_end_not_before(sessions_cfg):
    df = bars_from_anchor("2025-03-11 18:00:00", [
        (-1, 5000, 5000, 5000, 5000),  # fair value
        (0, 5000, 5010, 4998, 5001),   # event bar 1 of window
        (1, 5001, 5012, 5000, 5002),   # event bar 2 of window
        (2, 5002, 5015, 5001, 5008),   # window end (window=3): close 5008 > fair value 5000 -> LONG
    ])
    events = pd.DatetimeIndex([pd.Timestamp("2025-03-11 18:00:00", tz="UTC")])
    leg = NewsSpikeContinuation(make_news_cont_config(observation_window_minutes=3), events, event_window_minutes=60)
    states = build_states(df, "MES", sessions_cfg)

    assert leg.on_bar(states[0]) == []
    assert leg.on_bar(states[1]) == []  # window not yet elapsed
    assert leg.on_bar(states[2]) == []  # window not yet elapsed
    orders = leg.on_bar(states[3])
    assert len(orders) == 1
    assert orders[0].side.value == "long"
    assert orders[0].ts == states[3].bar.ts


def test_news_continuation_exactly_one_trade_per_event(sessions_cfg):
    df = bars_from_anchor("2025-03-11 18:00:00", [
        (-1, 5000, 5000, 5000, 5000),
        (0, 5000, 5010, 4998, 5005),   # triggers LONG (window=1)
        (1, 5005, 5006, 5004, 5005),   # must not retrigger
    ])
    events = pd.DatetimeIndex([pd.Timestamp("2025-03-11 18:00:00", tz="UTC")])
    leg = NewsSpikeContinuation(make_news_cont_config(observation_window_minutes=1), events, event_window_minutes=60)
    states = build_states(df, "MES", sessions_cfg)

    assert leg.on_bar(states[0]) == []
    assert len(leg.on_bar(states[1])) == 1
    assert leg.on_bar(states[2]) == []


def test_news_continuation_inactive_outside_event_window(sessions_cfg):
    # observation window (1 min) would elapse well past the event's own
    # activity window (10 min) -- the leg must never fire.
    df = bars_from_anchor("2025-03-11 18:00:00", [
        (-1, 5000, 5000, 5000, 5000),
        (20, 5000, 5010, 4998, 5005),  # 20 min after the event -- outside a 10-min window
    ])
    events = pd.DatetimeIndex([pd.Timestamp("2025-03-11 18:00:00", tz="UTC")])
    leg = NewsSpikeContinuation(make_news_cont_config(observation_window_minutes=1), events, event_window_minutes=10)
    states = build_states(df, "MES", sessions_cfg)
    assert leg.on_bar(states[0]) == []
    assert leg.on_bar(states[1]) == []


# --- mean-reversion: reuses session_open.py's BoS/consolidation logic --------

CONSOLIDATION_AND_BREAKOUT = [
    (-1, 100, 100, 100, 100),
    (0, 100.5, 100.5, 99.5, 100.5),
    (1, 100.8, 101, 100, 100.8),
    (2, 101, 101.5, 100.5, 101),
    (3, 100.8, 101, 100, 100.8),
    (4, 100.5, 100.5, 99.5, 100.5),
    (5, 100.5, 103, 100, 102.5),   # breakout: close 102.5 > swing high 101.5
    (6, 102.6, 103, 102, 102.8),   # entry fills here
]


def test_news_mean_reversion_fades_the_break(sessions_cfg):
    df = bars_from_anchor("2025-03-11 18:00:00", CONSOLIDATION_AND_BREAKOUT)
    events = pd.DatetimeIndex([pd.Timestamp("2025-03-11 18:00:00", tz="UTC")])
    leg = NewsSpikeMeanReversion(make_news_mr_config(direction_mode="fade_break"), events, event_window_minutes=60)
    states = build_states(df, "MES", sessions_cfg)

    orders = []
    for s in states:
        orders.extend(leg.on_bar(s))
    assert len(orders) == 1
    assert orders[0].side.value == "short"
    assert orders[0].reason.startswith("news_mean_reversion:")


def test_news_mean_reversion_respects_event_window(sessions_cfg):
    # same breakout pattern, but the event window is too short to still be
    # "active" by the time the breakout bar arrives.
    df = bars_from_anchor("2025-03-11 18:00:00", CONSOLIDATION_AND_BREAKOUT)
    events = pd.DatetimeIndex([pd.Timestamp("2025-03-11 18:00:00", tz="UTC")])
    leg = NewsSpikeMeanReversion(make_news_mr_config(), events, event_window_minutes=4)  # breakout is at minute 5
    states = build_states(df, "MES", sessions_cfg)

    orders = []
    for s in states:
        orders.extend(leg.on_bar(s))
    assert orders == []


def test_news_mean_reversion_max_trades_per_event_caps(sessions_cfg):
    df = bars_from_anchor("2025-03-11 18:00:00", CONSOLIDATION_AND_BREAKOUT)
    events = pd.DatetimeIndex([pd.Timestamp("2025-03-11 18:00:00", tz="UTC")])
    leg = NewsSpikeMeanReversion(make_news_mr_config(max_trades_per_event=1), events, event_window_minutes=60)
    leg._trade_count[events[0]] = 1  # already at the cap
    states = build_states(df, "MES", sessions_cfg)

    orders = []
    for s in states:
        orders.extend(leg.on_bar(s))
    assert orders == []


# --- end-to-end: no-look-ahead + SL/TP accounting through the real engine ----

def test_end_to_end_no_lookahead_and_tp_accounting(sessions_cfg):
    df = bars_from_anchor("2025-03-11 18:00:00", [
        (-1, 5000, 5000, 5000, 5000),   # fair value bar
        (0, 5000, 5002, 4999, 5005),    # decision bar: close 5005 > fair value -> LONG, ts = event + 0min
        (1, 5006, 5008, 5004, 5007),    # fills HERE at open=5006 (t+1, not bar 0's close 5005)
        (2, 5007, 5025, 5010, 5020),    # high 5025 breaches TP (5006 + 15 = 5021)
        (3, 5020, 5021, 5015, 5018),
    ])
    events = pd.DatetimeIndex([pd.Timestamp("2025-03-11 18:00:00", tz="UTC")])
    cfg = make_news_cont_config(observation_window_minutes=1, sl_points=10, rr=1.5)
    contracts = load_contracts()
    prop_cfg = load_prop_rules()

    leg = NewsSpikeContinuation(cfg, events, event_window_minutes=60)
    result = run_backtest(df, symbol="MES", strategy=leg, contracts=contracts,
                           prop_rules_config=prop_cfg, sessions_config=sessions_cfg, slippage_ticks=0)

    entries = [f for f in result.fills if f.fill_type.value == "entry"]
    assert len(entries) == 1
    entry = entries[0]
    assert entry.order_ts == df.index[1]   # decided on the event bar (18:00)
    assert entry.ts == df.index[2]          # filled on the NEXT bar (18:01)
    assert entry.price == 5006              # at that bar's open, not the decision bar's close (5005)
    assert entry.price != 5005
    assert entry.reason == "news_continuation:ny"  # 18:00 UTC = 14:00 EDT, within the NY session window

    exits = [f for f in result.fills if f.fill_type.value != "entry"]
    assert exits[0].fill_type.value == "take_profit"
    assert exits[0].price == pytest.approx(5006 + 15)

    trades = pair_trades(result.fills)
    assert len(trades) == 1
    assert trades[0].leg == "news_continuation"


# --- config loading against the real strategy.yaml + news_events.csv --------

def test_load_news_spike_config_from_real_file():
    path = PROJECT_ROOT / "propbt" / "config" / "strategy.yaml"
    cfg = load_news_spike_config(path)
    assert cfg is not None
    assert cfg.high_impact_only is True
    assert cfg.impact_values == ("high",)
    assert cfg.events_path == PROJECT_ROOT / "news_events.csv"
    assert cfg.continuation is not None
    assert cfg.mean_reversion is not None


def test_load_news_spike_config_returns_none_when_disabled(tmp_path):
    path = tmp_path / "strategy.yaml"
    path.write_text(
        "symbol: MES\n"
        "backtest: {start: '2021-01-01', end: '2021-12-31'}\n"
        "legs:\n"
        "  news:\n"
        "    enabled: false\n",
        encoding="utf-8",
    )
    assert load_news_spike_config(path) is None


def test_build_news_legs_scopes_events_to_date_range():
    events_path = PROJECT_ROOT / "news_events.csv"
    if not events_path.exists():
        pytest.skip("news_events.csv not present")
    cfg = load_news_spike_config(PROJECT_ROOT / "propbt" / "config" / "strategy.yaml")
    legs = build_news_legs(cfg, start="2022-01-01", end="2022-12-31")
    assert len(legs) == 2  # continuation + mean_reversion both enabled
    for leg in legs:
        assert all(2022 <= ts.year <= 2022 for ts in leg._event_timestamps)
