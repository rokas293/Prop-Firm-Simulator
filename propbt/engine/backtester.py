"""The offline backtest: tag a whole frame of bars, then step the engine over
it until the Combine resolves or the data ends.

The bar loop itself -- and with it the end-to-end no-look-ahead guarantee
(fills for decisions on STRICTLY earlier bars, then mark-to-market, then prop
rules, and only then the strategy, which sees `history = bars[: i+1]`) -- lives
in `propbt.engine.stepper.EngineStepper`, so that Autopilot's replay session
and this function are one computation. See that module's docstring, and
tests/test_backtester.py for the structural tests.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import pandas as pd

from propbt.config import ContractSpec, PropRulesConfig, SessionsConfig
from propbt.engine.broker import Rejection
from propbt.engine.events import Fill
from propbt.engine.prop_rules import CombineResult
from propbt.engine.stepper import EngineStepper, EquityLogRow  # noqa: F401 -- EquityLogRow is re-exported
from propbt.strategy.base import Strategy


@dataclass
class BacktestResult:
    combine: CombineResult
    fills: List[Fill]
    equity_curve: List[Tuple[pd.Timestamp, float]]
    rejections: List[Rejection]
    equity_log: List[EquityLogRow]


def run_backtest(
    df: pd.DataFrame,
    symbol: str,
    strategy: Strategy,
    contracts: Dict[str, ContractSpec],
    prop_rules_config: PropRulesConfig,
    sessions_config: SessionsConfig,
    slippage_ticks: int = 1,
    trading_start_ts: Optional[pd.Timestamp] = None,
) -> BacktestResult:
    """`trading_start_ts`, if given, lets `df` include bars BEFORE trading
    actually starts (e.g. a Combine attempt wants swing/consolidation/fair-
    value context from before its own start date). Bars before it are
    skipped entirely -- no fills, no prop-rule tracking, no strategy calls
    -- but they still count as `history` once trading does start, since
    that's legitimate already-happened market data, not a look-ahead.
    """
    stepper = EngineStepper(
        symbol=symbol, contracts=contracts, prop_rules_config=prop_rules_config,
        sessions_config=sessions_config, slippage_ticks=slippage_ticks,
        strategy=strategy, trading_start_ts=trading_start_ts,
    )
    stepper.append(df)
    stepper.run()

    combine_result = stepper.finalize()
    return BacktestResult(
        combine=combine_result,
        fills=stepper.portfolio.fills,
        equity_curve=stepper.portfolio.equity_curve,
        rejections=stepper.rejections,
        equity_log=stepper.equity_log,
    )
