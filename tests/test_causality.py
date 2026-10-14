"""No look-ahead, proven rather than asserted (CLAUDE.md invariant; G10a).

Three layers, each able to fail:

1. PREFIX INVARIANCE of the vectorized data prep. Every feature the strategy
   or the engine derives from bars (session/trading-day tags, fair value,
   true range / ATR, EMA, session VWAP, the scalar ATR) computed on the
   data up to bar k equals the same feature computed on the whole dataset and
   read at bar k. This is the audit of "anything that reads ahead".

2. PER-BAR TRUNCATION. For every bar t of pinned windows around real session
   opens and the late-session mean-reversion decisions: the strategy's
   decision at t, and the broker / account state it saw, given data cut off
   at t, equals the same under the full dataset; and everything the full run
   booked through t (fills, rejections, equity rows) equals the truncated
   run's. Warm-up bars before trading starts are allowed (they are history).

3. FUTURE SCRAMBLE. Replace every bar after t with garbage: nothing at or
   before t may change.

`test_the_harness_detects_a_leak` plants a real leak (a strategy handed the
whole frame instead of bars[:i+1]) and requires layer 2 to catch it; a
feature computed with a centred window must fail layer 1. A causality test
that cannot fail proves nothing.

Audit notes (what was read, not just run):
  tag_sessions / add_trading_day  per-row wall-clock arithmetic, no cross-row term
  fair_value                       searchsorted(anchor) - 1: the bar BEFORE the anchor
  session_anchor_utc/session_windows  pure calendar (no data)
  true_range / atr_series          shift(1) + trailing rolling mean
  ema_series                       adjust=False recursion (backward only)
  session_vwap                     group id from shift(1) comparisons + cumsum (backward only)
  strategy atr/range/volume/swing  read only the `history` slice they are handed
  news legs                        scheduled calendar + searchsorted(bar_ts, 'right') - 1
  resample_ohlcv                   last bucket is a PARTIAL candle by design; the engine
                                   and strategy never resample (the replay API only
                                   resamples bars <= cursor)
"""
from __future__ import annotations

import dataclasses
import datetime as dt
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
import pytest

from propbt.config import load_contracts, load_data_paths, load_execution, load_prop_rules, load_sessions
from propbt.data.indicators import atr_series, ema_series, session_vwap, true_range
from propbt.data.loader import load_ohlcv
from propbt.data.sessions import fair_value, session_anchor_utc, tag_sessions
from propbt.engine.backtester import BacktestResult, run_backtest
from propbt.strategy.combined import build_combined_strategy_factory
from propbt.strategy.session_open import atr as scalar_atr
from propbt.strategy.session_open import load_session_open_config
from tests.engine_golden import STRATEGY_YAML

SESS = load_sessions()


@pytest.fixture(scope="module")
def mnq() -> pd.DataFrame:
    paths = load_data_paths()
    if "MNQ" not in paths or not paths["MNQ"].exists():
        pytest.skip("MNQ data file not present")
    return load_ohlcv("MNQ")


# ----------------------------------------------------------------------------
# 1. prefix invariance of the data prep
# ----------------------------------------------------------------------------

def _cut_points(df: pd.DataFrame, extra_every: int = 53) -> List[int]:
    """Every bar within +-3 minutes of any session anchor / reopen / halt edge, plus a spread."""
    cuts = set(range(5, len(df), extra_every))
    days = {d for d in tag_sessions(df, SESS)["trading_day"].dropna().unique()}
    edges = []
    for day in days:
        for name in SESS.anchors:
            try:
                edges.append(session_anchor_utc(day, name, SESS))
            except ValueError:
                pass
    idx = df.index
    for e in edges:
        p = idx.searchsorted(e)
        cuts.update(range(max(0, p - 3), min(len(df), p + 4)))
    return sorted(cuts)


def _assert_prefix_invariant(df: pd.DataFrame, feature: Callable[[pd.DataFrame], object], cuts: List[int]) -> None:
    whole = feature(df)
    for k in cuts:
        part = feature(df.iloc[: k + 1])
        want = whole.iloc[: k + 1]
        if isinstance(want, pd.DataFrame):
            pd.testing.assert_frame_equal(part, want, check_exact=True)
        else:
            pd.testing.assert_series_equal(part, want, check_exact=True, check_names=False)


@pytest.fixture(scope="module")
def two_days(mnq) -> pd.DataFrame:
    # Mon 2023-03-06 20:00 UTC .. Wed 2023-03-08 08:00 UTC: Asia, London, NY, a halt and a reopen
    return mnq.loc["2023-03-06 20:00":"2023-03-08 08:00"]


def test_prefix_invariance_of_session_and_trading_day_tags(two_days):
    _assert_prefix_invariant(two_days, lambda d: tag_sessions(d, SESS), _cut_points(two_days))


def test_prefix_invariance_of_rolling_features(two_days):
    cuts = _cut_points(two_days)
    _assert_prefix_invariant(two_days, true_range, cuts)
    _assert_prefix_invariant(two_days, lambda d: atr_series(d, 14), cuts)
    _assert_prefix_invariant(two_days, lambda d: ema_series(d["close"], 20), cuts)
    _assert_prefix_invariant(two_days, lambda d: session_vwap(d, SESS), cuts)


def test_scalar_strategy_atr_equals_the_vectorized_series_read_at_that_bar(two_days):
    full = atr_series(two_days, 14)
    for k in _cut_points(two_days)[::4]:
        scalar = scalar_atr(two_days.iloc[: k + 1], 14)
        if np.isnan(full.iloc[k]):
            assert scalar is None
        else:
            assert scalar == full.iloc[k]


def test_fair_value_of_an_anchor_never_depends_on_bars_at_or_after_it(two_days):
    days = tag_sessions(two_days, SESS)["trading_day"].dropna().unique()
    anchors = [session_anchor_utc(d, n, SESS) for d in days for n in ("asia", "london", "ny")]
    anchors = [a for a in anchors if two_days.index[0] < a <= two_days.index[-1]]
    assert len(anchors) >= 3
    for a in anchors:
        want = fair_value(two_days, a)
        assert want is not None and want[0] < a
        # cutting the data anywhere at or after the anchor's own bar changes nothing...
        p = two_days.index.searchsorted(a)
        for k in (p, p + 1, p + 50, len(two_days) - 1):
            assert fair_value(two_days.iloc[: k + 1], a) == want
        # ...and dropping the anchor bar and everything after it still yields the same (prior-bar) value
        assert fair_value(two_days.iloc[:p], a) == want


def test_a_non_causal_feature_fails_the_prefix_check(two_days):
    with pytest.raises(AssertionError):
        _assert_prefix_invariant(two_days, lambda d: d["close"].rolling(5, center=True).mean(), _cut_points(two_days)[:8])
    with pytest.raises(AssertionError):
        _assert_prefix_invariant(two_days, lambda d: d["close"].shift(-1), _cut_points(two_days)[:8])


# ----------------------------------------------------------------------------
# 2. per-bar truncation, 3. future scramble
# ----------------------------------------------------------------------------

@dataclass(frozen=True)
class Seen:
    """What the strategy was handed and what it returned at one bar."""
    orders: tuple
    open_positions: tuple
    balance: float
    equity: float
    trading_day: dt.date
    history_len: int
    last_history_ts: pd.Timestamp


class Recording:
    def __init__(self, inner):
        self.inner = inner
        self.calls: Dict[pd.Timestamp, Seen] = {}

    def on_bar(self, state):
        orders = list(self.inner.on_bar(state))
        self.calls[state.bar.ts] = Seen(
            tuple(orders), tuple(sorted(state.open_positions.items())), state.balance, state.equity,
            state.trading_day, len(state.history), state.history.index[-1],
        )
        return orders


@dataclass
class Run:
    result: BacktestResult
    calls: Dict[pd.Timestamp, Seen]


StrategyMaker = Callable[[pd.DataFrame], object]   # (the df this run is given) -> a FRESH strategy


def real_legs(_run_df: pd.DataFrame):
    cfg = dataclasses.replace(load_session_open_config(str(STRATEGY_YAML)), symbol="MNQ")
    return build_combined_strategy_factory(cfg, SESS, None)()


class HistoryLeak:
    """A planted bug: hands the wrapped strategy the WHOLE frame as `history`
    instead of bars[: i+1] -- what an engine that passed `tagged` would do."""

    def __init__(self, inner, frame: pd.DataFrame):
        self.inner, self.frame = inner, frame

    def on_bar(self, state):
        return self.inner.on_bar(dataclasses.replace(state, history=self.frame))


def leaky_legs(run_df: pd.DataFrame):
    return HistoryLeak(real_legs(run_df), tag_sessions(run_df, SESS))


def _run(df: pd.DataFrame, make: StrategyMaker, trading_start: pd.Timestamp) -> Run:
    rec = Recording(make(df))
    res = run_backtest(
        df, symbol="MNQ", strategy=rec, contracts=load_contracts(), prop_rules_config=load_prop_rules(),
        sessions_config=SESS, slippage_ticks=load_execution().slippage_ticks, trading_start_ts=trading_start,
    )
    return Run(res, rec.calls)


def _assert_same_through(t: pd.Timestamp, full: Run, other: Run, what: str) -> None:
    """Everything `full` booked/decided at or before bar t equals `other`'s."""
    assert other.calls.get(t) == full.calls.get(t), f"{what}: decision/state at {t} differs"
    for ts, seen in other.calls.items():
        if ts <= t:
            assert full.calls.get(ts) == seen, f"{what}: decision/state at {ts} differs"
    assert {ts for ts in full.calls if ts <= t} == {ts for ts in other.calls if ts <= t}, f"{what}: which bars the strategy was called on differs"
    assert [f for f in full.result.fills if f.ts <= t] == [f for f in other.result.fills if f.ts <= t], f"{what}: fills through {t} differ"
    assert [r for r in full.result.rejections if r.ts <= t] == [r for r in other.result.rejections if r.ts <= t], f"{what}: rejections differ"
    assert [r for r in full.result.equity_log if r.ts <= t] == [r for r in other.result.equity_log if r.ts <= t], f"{what}: equity log differs"


def _check_truncation(df, ts_list, make, trading_start) -> Run:
    full = _run(df, make, trading_start)
    for t in ts_list:
        cut = _run(df.loc[:t], make, trading_start)
        _assert_same_through(t, full, cut, "truncation")
    return full


def _day_frame(mnq: pd.DataFrame, trading_day: str, end_utc: str) -> Tuple[pd.DataFrame, pd.Timestamp]:
    """Bars from 90 minutes before that trading day's 18:00 ET reopen (warm-up history) to `end_utc`;
    trading starts at the reopen, as a Combine attempt does."""
    reopen = session_anchor_utc(dt.date.fromisoformat(trading_day), "globex_reopen", SESS)
    return mnq.loc[reopen - pd.Timedelta(minutes=90): pd.Timestamp(end_utc, tz="UTC")], reopen


# (trading day, window UTC "HH:MM" pairs): NY continuation decides at anchor+2min; the late
# mean-reversion trade is the one the recorded reference shows on that day (21:23 / 20:55 UTC). 2023-03-07 is EST
# (NY anchor 14:30 UTC), 2022-10-12 is EDT (13:30 UTC).
PINNED = [
    ("2023-03-07", "2023-03-07 22:00", [("14:26", "14:38"), ("21:16", "21:30")]),
    ("2022-10-12", "2022-10-12 21:10", [("13:26", "13:38"), ("20:48", "21:00")]),
]


def _window_bars(df: pd.DataFrame, day_end: str, lo: str, hi: str) -> List[pd.Timestamp]:
    date = day_end[:10]
    a, b = pd.Timestamp(f"{date} {lo}", tz="UTC"), pd.Timestamp(f"{date} {hi}", tz="UTC")
    return [t for t in df.index if a <= t <= b]


@pytest.mark.parametrize("trading_day,end_utc,windows", PINNED, ids=[p[0] for p in PINNED])
def test_decision_at_every_bar_given_truncated_data_equals_given_the_full_dataset(mnq, trading_day, end_utc, windows):
    df, start = _day_frame(mnq, trading_day, end_utc)
    ts_list = [t for lo, hi in windows for t in _window_bars(df, end_utc, lo, hi)]
    assert len(ts_list) >= 20

    full = _check_truncation(df, ts_list, real_legs, start)

    # non-vacuous: the windows really contain the decisions the reference shows
    decided = {ts for ts in ts_list if full.calls.get(ts) and full.calls[ts].orders}
    assert len(decided) >= 2, "the pinned windows must contain at least one continuation and one mean-reversion decision"
    reasons = {o.reason.split(":")[0] for ts in decided for o in full.calls[ts].orders}
    assert {"continuation", "mean_reversion"} <= reasons
    # ...and bars where the strategy decided nothing, and bars where an order was rejected / an entry sat open
    assert any(not full.calls[ts].orders for ts in ts_list if ts in full.calls)


def test_strategy_never_sees_a_bar_after_the_one_it_decides_on(mnq):
    df, start = _day_frame(mnq, "2023-03-07", "2023-03-07 22:00")
    full = _run(df, real_legs, start)
    assert full.calls
    for ts, seen in full.calls.items():
        assert seen.last_history_ts == ts
        assert seen.history_len == df.index.get_loc(ts) + 1


@pytest.mark.parametrize("trading_day,end_utc,windows", PINNED, ids=[p[0] for p in PINNED])
def test_scrambling_every_bar_after_t_changes_nothing_at_or_before_t(mnq, trading_day, end_utc, windows):
    df, start = _day_frame(mnq, trading_day, end_utc)
    full = _run(df, real_legs, start)
    rng = np.random.default_rng(20261013)

    decision_bars = [ts for ts, s in full.calls.items() if s.orders]
    assert decision_bars
    cuts = []
    for ts in decision_bars[:4]:
        p = df.index.get_loc(ts)
        cuts += [df.index[p - 1], ts]          # the bar before the decision and the decision bar
    cuts += [df.index[i] for i in rng.integers(100, len(df) - 5, size=4)]

    for t in cuts:
        p = df.index.get_loc(t)
        garbage = df.copy()
        n = len(garbage) - p - 1
        for col in ("open", "high", "low", "close"):
            garbage.iloc[p + 1:, garbage.columns.get_loc(col)] = df[col].iloc[p + 1:].to_numpy() * (1 + rng.uniform(-0.04, 0.04, n))
        garbage.iloc[p + 1:, garbage.columns.get_loc("volume")] = rng.integers(1, 5000, n).astype("uint64")
        scrambled = _run(garbage, real_legs, start)
        _assert_same_through(t, full, scrambled, f"scramble after {t}")


def test_engine_gating_through_a_daily_lock_and_mll_breach_is_causal(mnq):
    """The prop gating (daily-lock flatten, MLL breach, which bars the strategy is called on)
    at bar t depends only on bars <= t: random flow that locks the day and then breaches."""
    from propbt.strategy.placeholder import RandomStrategy

    df = mnq.loc["2023-03-06":"2023-03-10"]
    start = df.index[0]

    def make(_df):
        return RandomStrategy(contracts=5, sl_points=25.0, tp_points=25.0, trade_prob=0.05, seed=2)

    full = _run(df, make, start)
    kinds = {f.fill_type.value for f in full.result.fills}
    assert {"daily_lock_flatten", "mll_breach_flatten"} <= kinds

    lock_ts = next(f.ts for f in full.result.fills if f.fill_type.value == "daily_lock_flatten")
    breach_ts = next(f.ts for f in full.result.fills if f.fill_type.value == "mll_breach_flatten")
    pos = {ts: i for i, ts in enumerate(df.index)}
    around = [df.index[pos[x] + d] for x in (lock_ts, breach_ts) for d in (-2, -1, 0)]
    mid = [df.index[i] for i in range(50, pos[breach_ts], max(1, pos[breach_ts] // 12))]
    for t in sorted(set(around + mid)):
        cut = _run(df.loc[:t], make, start)
        _assert_same_through(t, full, cut, "gating truncation")


# ----------------------------------------------------------------------------
# the harness must be able to fail
# ----------------------------------------------------------------------------

def test_the_harness_detects_a_leak(mnq):
    """An engine that handed strategies the whole frame (instead of bars[:i+1]) must be caught
    by the same truncation check that passes for the real engine above."""
    df, start = _day_frame(mnq, "2023-03-07", "2023-03-07 22:00")
    ts_list = _window_bars(df, "2023-03-07 22:00", "21:10", "21:40") + _window_bars(df, "2023-03-07 22:00", "14:28", "14:36")
    with pytest.raises(AssertionError):
        _check_truncation(df, ts_list, leaky_legs, start)
