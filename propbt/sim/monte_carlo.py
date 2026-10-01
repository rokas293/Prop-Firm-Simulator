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


# --------------------------- trade-sequence Monte Carlo ---------------------------
#
# The Combine-attempt Monte Carlo above needs a *strategy* it can re-run from
# many start dates. A fixed, already-realized trade list (a discretionary
# session's journaled trades, or any run's trades.parquet) has no strategy to
# re-run -- the only honest question left is "how much of this equity curve
# was ordering/sampling luck?", answered by resampling the realized per-trade
# PnLs. It reads pnl_usd only; nothing about fills/PnL is recomputed here.

TradeResampleMethod = Literal["bootstrap", "shuffle"]

FAN_PERCENTILES = (5, 25, 50, 75, 95)
SUMMARY_PERCENTILES = (5, 25, 50, 75, 95)


@dataclass(frozen=True)
class TradeSequenceMonteCarlo:
    method: str
    n_trades: int
    n_sims: int
    seed: int
    drawdown_budget_usd: float
    final_pnl_pct: Dict[int, float]          # percentile -> terminal cumulative PnL
    max_drawdown_pct: Dict[int, float]       # percentile -> worst peak-to-trough drop (positive USD)
    prob_profit: float                        # share of sims ending > 0
    prob_drawdown_breach: float               # share of sims whose max drawdown >= budget
    actual_final_pnl: float
    actual_max_drawdown: float
    fan: Dict[int, List[float]] = field(default_factory=dict)   # percentile -> cum PnL after trade 0..n
    actual_path: List[float] = field(default_factory=list)       # realized cum PnL after trade 0..n


def _max_drawdown_rows(paths: "np.ndarray") -> "np.ndarray":
    """Worst peak-to-trough drop per row of a (sims x steps) cumulative-PnL
    matrix whose first column is the starting 0."""
    import numpy as np

    peaks = np.maximum.accumulate(paths, axis=1)
    return (peaks - paths).max(axis=1)


def run_trade_sequence_monte_carlo(
    pnls: List[float],
    n_sims: int = 1000,
    method: TradeResampleMethod = "bootstrap",
    seed: int = 0,
    drawdown_budget_usd: float = 2000.0,
) -> TradeSequenceMonteCarlo:
    """Resample the realized per-trade PnL sequence `n_sims` times.

    - "bootstrap": draw n_trades with replacement (the terminal PnL varies).
    - "shuffle":   permute the same trades (terminal PnL is fixed; only the
                   path / drawdown depend on ordering).
    Deterministic for a given seed. The realized path is reported alongside
    so the UI can show where the real run sits inside the distribution.
    """
    import numpy as np

    if method not in ("bootstrap", "shuffle"):
        raise ValueError(f"Unknown resample method {method!r}")
    if n_sims < 1:
        raise ValueError("n_sims must be >= 1")
    n = len(pnls)
    if n == 0:
        raise ValueError("cannot run a Monte Carlo over zero trades")

    arr = np.asarray(pnls, dtype="float64")
    rng = np.random.default_rng(seed)
    if method == "bootstrap":
        samples = arr[rng.integers(0, n, size=(n_sims, n))]
    else:
        samples = np.stack([rng.permutation(arr) for _ in range(n_sims)])

    paths = np.concatenate([np.zeros((n_sims, 1)), np.cumsum(samples, axis=1)], axis=1)
    finals = paths[:, -1]
    drawdowns = _max_drawdown_rows(paths)

    actual = np.concatenate([[0.0], np.cumsum(arr)])
    actual_dd = float((np.maximum.accumulate(actual) - actual).max())

    return TradeSequenceMonteCarlo(
        method=method,
        n_trades=n,
        n_sims=n_sims,
        seed=seed,
        drawdown_budget_usd=drawdown_budget_usd,
        final_pnl_pct={p: float(np.percentile(finals, p)) for p in SUMMARY_PERCENTILES},
        max_drawdown_pct={p: float(np.percentile(drawdowns, p)) for p in SUMMARY_PERCENTILES},
        prob_profit=float((finals > 0).mean()),
        prob_drawdown_breach=float((drawdowns >= drawdown_budget_usd).mean()),
        actual_final_pnl=float(actual[-1]),
        actual_max_drawdown=actual_dd,
        fan={p: [float(v) for v in np.percentile(paths, p, axis=0)] for p in FAN_PERCENTILES},
        actual_path=[float(v) for v in actual],
    )
