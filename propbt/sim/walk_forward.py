"""Chronological in-sample optimize / out-of-sample validate walk-forward
evaluation (CLAUDE.md section 7 -- treat as a hard requirement). The
headline number is always OUT-OF-SAMPLE pass rate for whichever config the
in-sample search selects, never the in-sample one; the in-sample search
itself prefers a robust neighborhood over a single sharp optimum, and the
free-parameter count is checked against how many trades actually backed it
up.
"""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

from propbt.config import ContractSpec, PropRulesConfig, SessionsConfig
from propbt.sim.combine import DEFAULT_WARMUP_DAYS
from propbt.sim.monte_carlo import MonteCarloResult, run_monte_carlo, sample_start_dates
from propbt.strategy.combined import build_combined_strategy_factory
from propbt.strategy.news_spike import NewsSpikeConfig
from propbt.strategy.session_open import SessionOpenRunConfig

MIN_TRADES_PER_PARAMETER = 10  # rule-of-thumb minimum, not a formal statistical bound


def apply_overrides(run_config: SessionOpenRunConfig, overrides: Dict[str, Any]) -> SessionOpenRunConfig:
    """Apply a small set of "<leg>_<field>" overrides (e.g.
    {"continuation_rr": 1.0}) to `run_config`'s leg configs, re-running
    each leg's own __post_init__ validation via dataclasses.replace."""
    continuation = run_config.continuation
    mean_reversion = run_config.mean_reversion
    for key, value in overrides.items():
        if key.startswith("continuation_"):
            if continuation is None:
                raise ValueError(f"Override {key!r} given but the continuation leg isn't enabled")
            field_name = key[len("continuation_"):]
            continuation = dataclasses.replace(continuation, **{field_name: value})
        elif key.startswith("mean_reversion_"):
            if mean_reversion is None:
                raise ValueError(f"Override {key!r} given but the mean_reversion leg isn't enabled")
            field_name = key[len("mean_reversion_"):]
            mean_reversion = dataclasses.replace(mean_reversion, **{field_name: value})
        else:
            raise ValueError(f"Unknown override key {key!r} (expected a 'continuation_' or 'mean_reversion_' prefix)")
    return dataclasses.replace(run_config, continuation=continuation, mean_reversion=mean_reversion)


def count_leg_parameters(config: Optional[object]) -> int:
    """Rough free-parameter count for one leg config: every tunable field
    except position sizing (`contracts`) and the coarse leg toggle
    (`sessions`), which govern WHERE the leg trades, not its signal logic."""
    if config is None:
        return 0
    excluded = {"sessions", "contracts"}
    return sum(1 for f in dataclasses.fields(config) if f.name not in excluded)


def count_free_parameters(run_config: SessionOpenRunConfig, news_config: Optional[NewsSpikeConfig] = None) -> int:
    total = count_leg_parameters(run_config.continuation) + count_leg_parameters(run_config.mean_reversion)
    if news_config is not None:
        total += count_leg_parameters(news_config.continuation) + count_leg_parameters(news_config.mean_reversion)
    return total


@dataclass(frozen=True)
class GridPointResult:
    overrides: Dict[str, Any]
    monte_carlo: MonteCarloResult
    robustness_score: float  # neighbor-smoothed in-sample pass rate


def select_most_robust(grid_results: List[Tuple[Dict[str, Any], MonteCarloResult]]) -> List[GridPointResult]:
    """Score each grid point by the average pass rate of itself and its
    immediate neighbors IN THE GIVEN ORDER (list `param_grid` in ascending
    order of whatever it varies) -- prefers a robust plateau over an
    isolated spike (CLAUDE.md section 7: "prefer configs that are robust
    across neighbors... over single sharp optima"), rather than just
    picking whichever single point happens to score highest.
    """
    rates = [mc.pass_rate for _, mc in grid_results]
    scored = []
    for i, (overrides, mc) in enumerate(grid_results):
        neighborhood = rates[max(0, i - 1): i + 2]
        score = sum(neighborhood) / len(neighborhood)
        scored.append(GridPointResult(overrides=overrides, monte_carlo=mc, robustness_score=score))
    return scored


@dataclass(frozen=True)
class WalkForwardResult:
    in_sample_start: str
    in_sample_end: str
    out_of_sample_start: str
    out_of_sample_end: str
    selected_overrides: Dict[str, Any]
    grid: List[GridPointResult]
    in_sample: MonteCarloResult           # selected config's in-sample result (reused from the grid search)
    out_of_sample: MonteCarloResult        # SAME config, run on OOS data -- the headline number
    n_free_parameters: int
    n_in_sample_trades: int
    parameter_budget_warning: Optional[str]


def run_walk_forward(
    base_run_config: SessionOpenRunConfig,
    param_grid: List[Dict[str, Any]],
    df: pd.DataFrame,
    symbol: str,
    contracts: Dict[str, ContractSpec],
    prop_rules_config: PropRulesConfig,
    sessions_config: SessionsConfig,
    out_of_sample_start: str,
    out_of_sample_end: str,
    news_config: Optional[NewsSpikeConfig] = None,
    n_attempts_per_grid_point: int = 5,
    n_attempts_out_of_sample: int = 10,
    sample_method: str = "rolling",
    stride_days: int = 15,
    seed: int = 0,
    slippage_ticks: int = 1,
    warmup_days: int = DEFAULT_WARMUP_DAYS,
    max_calendar_days: Optional[int] = None,
) -> WalkForwardResult:
    if not param_grid:
        param_grid = [{}]  # a single "no override" point -- still runs, just no search

    in_sample_df = df.loc[base_run_config.start: base_run_config.end]
    out_of_sample_df = df.loc[out_of_sample_start: out_of_sample_end]

    in_sample_start_dates = sample_start_dates(
        in_sample_df, sessions_config, n_attempts_per_grid_point, method=sample_method,
        stride_days=stride_days, seed=seed, warmup_days=warmup_days,
    )

    grid_results: List[Tuple[Dict[str, Any], MonteCarloResult]] = []
    for overrides in param_grid:
        run_cfg = apply_overrides(base_run_config, overrides)
        strategy_factory = build_combined_strategy_factory(
            run_cfg, sessions_config, news_config, news_start=run_cfg.start, news_end=run_cfg.end,
        )
        mc = run_monte_carlo(
            in_sample_df, symbol, strategy_factory, contracts, prop_rules_config, sessions_config,
            in_sample_start_dates, slippage_ticks=slippage_ticks, warmup_days=warmup_days,
            max_calendar_days=max_calendar_days,
        )
        grid_results.append((overrides, mc))

    scored = select_most_robust(grid_results)
    best = max(scored, key=lambda g: g.robustness_score)
    selected_run_cfg = apply_overrides(base_run_config, best.overrides)

    out_of_sample_start_dates = sample_start_dates(
        out_of_sample_df, sessions_config, n_attempts_out_of_sample, method=sample_method,
        stride_days=stride_days, seed=seed, warmup_days=warmup_days,
    )
    oos_strategy_factory = build_combined_strategy_factory(
        selected_run_cfg, sessions_config, news_config,
        news_start=out_of_sample_start, news_end=out_of_sample_end,
    )
    out_of_sample_mc = run_monte_carlo(
        out_of_sample_df, symbol, oos_strategy_factory, contracts, prop_rules_config, sessions_config,
        out_of_sample_start_dates, slippage_ticks=slippage_ticks, warmup_days=warmup_days,
        max_calendar_days=max_calendar_days,
    )

    n_params = count_free_parameters(selected_run_cfg, news_config)
    n_in_sample_trades = sum(
        1 for a in best.monte_carlo.attempts for f in a.fills if f.fill_type.value == "entry"
    )

    warning = None
    if n_params > 0 and n_in_sample_trades < n_params * MIN_TRADES_PER_PARAMETER:
        ratio = n_in_sample_trades / n_params
        warning = (
            f"{n_params} free parameters but only {n_in_sample_trades} in-sample trades "
            f"({ratio:.1f} trades/parameter, under the {MIN_TRADES_PER_PARAMETER}/parameter rule of "
            f"thumb) -- CLAUDE.md section 7: treat any pass-rate uplift here with serious "
            f"skepticism, this config may just be curve-fit to a handful of trades."
        )

    return WalkForwardResult(
        in_sample_start=base_run_config.start, in_sample_end=base_run_config.end,
        out_of_sample_start=out_of_sample_start, out_of_sample_end=out_of_sample_end,
        selected_overrides=best.overrides, grid=scored,
        in_sample=best.monte_carlo, out_of_sample=out_of_sample_mc,
        n_free_parameters=n_params, n_in_sample_trades=n_in_sample_trades,
        parameter_budget_warning=warning,
    )
