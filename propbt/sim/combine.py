"""Simulate one full Topstep Combine attempt starting from a given date
(CLAUDE.md section 6). This is a thin wrapper around engine/backtester.py:
a Combine attempt IS a backtest, just started partway through the data,
with a fresh strategy instance (no state leaking from a previous attempt)
and the Combine clock (balance/day tracking) starting exactly at
`start_date`'s trading-day boundary rather than at bar 0.

`warmup_days` of data before that boundary are still handed to the engine
so the first real trading day's fair-value/consolidation/swing detection
isn't crippled by a cold start -- that's legitimate already-happened
market data (see engine/backtester.py's trading_start_ts), not a
look-ahead.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Tuple

import pandas as pd

from propbt.config import ContractSpec, PropRulesConfig, SessionsConfig
from propbt.data.sessions import session_anchor_utc
from propbt.engine.backtester import run_backtest
from propbt.engine.broker import Rejection
from propbt.engine.events import Fill
from propbt.engine.prop_rules import CombineResult
from propbt.strategy.base import Strategy

DEFAULT_WARMUP_DAYS = 5


@dataclass(frozen=True)
class CombineAttempt:
    start_date: dt.date
    combine: CombineResult
    fills: List[Fill]
    equity_curve: List[Tuple[pd.Timestamp, float]]
    rejections: List[Rejection]
    n_trading_days: int  # trading days actually simulated (from day_logs), regardless of status


def run_combine_attempt(
    df: pd.DataFrame,
    symbol: str,
    strategy_factory: Callable[[], Strategy],
    contracts: Dict[str, ContractSpec],
    prop_rules_config: PropRulesConfig,
    sessions_config: SessionsConfig,
    start_date: dt.date,
    slippage_ticks: int = 1,
    warmup_days: int = DEFAULT_WARMUP_DAYS,
    max_calendar_days: Optional[int] = None,
) -> CombineAttempt:
    """`strategy_factory` must return a FRESH strategy instance -- legs keep
    internal per-session/per-event state, and a previous attempt's leftover
    state must never leak into this one.

    `max_calendar_days`, if given, bounds how much data (from start_date)
    this attempt can run over -- an attempt that never resolves within that
    window ends up "incomplete" rather than running to the end of all
    available data. Useful for bounding worst-case Monte Carlo runtime;
    None means unbounded (run until pass/fail/data exhausted).
    """
    trading_start_ts = session_anchor_utc(start_date, "globex_reopen", sessions_config)
    warmup_start_ts = trading_start_ts - pd.Timedelta(days=warmup_days)

    window = df.loc[df.index >= warmup_start_ts]
    if max_calendar_days is not None:
        window_end_ts = trading_start_ts + pd.Timedelta(days=max_calendar_days)
        window = window.loc[window.index < window_end_ts]
    if len(window) == 0:
        raise ValueError(f"No data available for a Combine attempt starting {start_date}")

    strategy = strategy_factory()
    result = run_backtest(
        window, symbol=symbol, strategy=strategy, contracts=contracts,
        prop_rules_config=prop_rules_config, sessions_config=sessions_config,
        slippage_ticks=slippage_ticks, trading_start_ts=trading_start_ts,
    )

    return CombineAttempt(
        start_date=start_date,
        combine=result.combine,
        fills=result.fills,
        equity_curve=result.equity_curve,
        rejections=result.rejections,
        n_trading_days=len(result.combine.day_logs),
    )
