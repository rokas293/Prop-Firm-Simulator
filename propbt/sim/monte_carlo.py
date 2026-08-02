"""Monte Carlo over many Combine attempts, started on different dates
(CLAUDE.md section 6 -- "the metric that matters"). A single equity curve
is nearly meaningless; this is the headline report: % of attempts passed,
distribution of days-to-pass, and distribution of fail reasons.
"""
from __future__ import annotations

import datetime as dt
import random
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Literal, Optional

import pandas as pd

from propbt.config import ContractSpec, PropRulesConfig, SessionsConfig
from propbt.data.sessions import tag_sessions
from propbt.sim.combine import DEFAULT_WARMUP_DAYS, CombineAttempt, run_combine_attempt
from propbt.strategy.base import Strategy

SampleMethod = Literal["rolling", "random"]


def available_trading_days(df: pd.DataFrame, sessions_config: SessionsConfig) -> List[dt.date]:
    """Every trading day actually present in `df`, sorted."""
    trading_day = tag_sessions(df, sessions_config)["trading_day"]
    days = sorted({d for d in trading_day if d is not None})
    return days


def sample_start_dates(
    df: pd.DataFrame,
    sessions_config: SessionsConfig,
    n_attempts: int,
    method: SampleMethod = "rolling",
    stride_days: int = 15,
    seed: int = 0,
    warmup_days: int = DEFAULT_WARMUP_DAYS,
) -> List[dt.date]:
    """Pick `n_attempts` start dates from the trading days available in
    `df`, skipping the first `warmup_days`-worth so every attempt gets real
    pre-start context (see sim/combine.py).
    """
    days = available_trading_days(df, sessions_config)
    if not days:
        return []
    cutoff = days[0] + dt.timedelta(days=warmup_days)
    candidates = [d for d in days if d >= cutoff]
    if not candidates:
        return []

    if method == "rolling":
        return candidates[::stride_days][:n_attempts]
    elif method == "random":
        rng = random.Random(seed)
        k = min(n_attempts, len(candidates))
        return sorted(rng.sample(candidates, k))
    else:
        raise ValueError(f"Unknown sample method {method!r}")


@dataclass(frozen=True)
class MonteCarloResult:
    n_attempts: int
    n_passed: int
    n_failed: int
    n_incomplete: int
    pass_rate: float                            # n_passed / n_attempts (incomplete counts against it)
    resolved_pass_rate: float                     # n_passed / (n_passed + n_failed); nan if none resolved
    days_to_pass: List[int] = field(default_factory=list)     # passed attempts only
    fail_reasons: Dict[str, int] = field(default_factory=dict)
    attempts: List[CombineAttempt] = field(default_factory=list)


def run_monte_carlo(
    df: pd.DataFrame,
    symbol: str,
    strategy_factory: Callable[[], Strategy],
    contracts: Dict[str, ContractSpec],
    prop_rules_config: PropRulesConfig,
    sessions_config: SessionsConfig,
    start_dates: List[dt.date],
    slippage_ticks: int = 1,
    warmup_days: int = DEFAULT_WARMUP_DAYS,
    max_calendar_days: Optional[int] = None,
) -> MonteCarloResult:
    attempts = [
        run_combine_attempt(
            df, symbol, strategy_factory, contracts, prop_rules_config, sessions_config,
            start_date=d, slippage_ticks=slippage_ticks, warmup_days=warmup_days,
            max_calendar_days=max_calendar_days,
        )
        for d in start_dates
    ]

    n = len(attempts)
    n_passed = sum(1 for a in attempts if a.combine.status == "passed")
    n_failed = sum(1 for a in attempts if a.combine.status == "failed")
    n_incomplete = sum(1 for a in attempts if a.combine.status == "incomplete")

    days_to_pass = [a.n_trading_days for a in attempts if a.combine.status == "passed"]
    fail_reasons: Dict[str, int] = {}
    for a in attempts:
        if a.combine.status == "failed" and a.combine.fail_reason is not None:
            fail_reasons[a.combine.fail_reason] = fail_reasons.get(a.combine.fail_reason, 0) + 1

    return MonteCarloResult(
        n_attempts=n,
        n_passed=n_passed,
        n_failed=n_failed,
        n_incomplete=n_incomplete,
        pass_rate=(n_passed / n) if n else float("nan"),
        resolved_pass_rate=(n_passed / (n_passed + n_failed)) if (n_passed + n_failed) else float("nan"),
        days_to_pass=days_to_pass,
        fail_reasons=fail_reasons,
        attempts=attempts,
    )
