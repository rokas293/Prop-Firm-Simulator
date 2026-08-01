"""The bar loop. This is where the no-look-ahead guarantee lives end to end:

For each bar t (in increasing timestamp order):
  1. broker.process_bar(t) resolves fills for orders/positions decided on
     STRICTLY earlier bars, using only bar t's own OHLC (this is what makes
     a decision made at bar t-1 execute "at bar t", i.e. that order's t+1).
  2. Portfolio marks to market as of bar t's close -> balance & equity.
  3. PropRulesTracker.on_bar consumes that balance/equity (MLL breach,
     daily loss lock, target/consistency).
  4. Only THEN does the strategy see bar t (via `history = bars[:i+1]`, a
     slice that cannot physically contain bar t+1 or later) and return
     orders, which are submitted for the NEXT bar's process_bar call.

Steps 1-3 for bar t never depend on anything the strategy decides at step 4
for bar t (that's next iteration's problem), and step 4 never sees data
past bar t's own close. Both directions of the no-look-ahead guarantee are
structural, not just convention -- see tests/test_backtester.py.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Tuple

import pandas as pd

from propbt.config import ContractSpec, PropRulesConfig, SessionsConfig
from propbt.data.sessions import tag_sessions
from propbt.engine.broker import Broker, Rejection
from propbt.engine.events import Bar, Fill, FillType
from propbt.engine.portfolio import Portfolio
from propbt.engine.prop_rules import CombineResult, PropRulesTracker
from propbt.strategy.base import BarState, Strategy


@dataclass
class BacktestResult:
    combine: CombineResult
    fills: List[Fill]
    equity_curve: List[Tuple[pd.Timestamp, float]]
    rejections: List[Rejection]


def run_backtest(
    df: pd.DataFrame,
    symbol: str,
    strategy: Strategy,
    contracts: Dict[str, ContractSpec],
    prop_rules_config: PropRulesConfig,
    sessions_config: SessionsConfig,
    slippage_ticks: int = 1,
) -> BacktestResult:
    tagged = tag_sessions(df, sessions_config)

    broker = Broker(
        contracts=contracts,
        slippage_ticks=slippage_ticks,
        commissions=prop_rules_config.commissions,
        max_open_contracts=prop_rules_config.max_open_contracts,
    )
    portfolio = Portfolio(contracts=contracts, start_balance=prop_rules_config.start_balance)
    prop_rules = PropRulesTracker(prop_rules_config)

    n = len(tagged)
    for i in range(n):
        row = tagged.iloc[i]
        trading_day = row["trading_day"]
        if trading_day is None:
            continue  # maintenance-halt bar -- not a real trading bar

        bar = Bar(
            symbol=symbol, ts=tagged.index[i], open=row["open"], high=row["high"],
            low=row["low"], close=row["close"], volume=int(row["volume"]),
            trading_day=trading_day, session=row["session"],
        )

        # 1. fills for decisions made on earlier bars, using only bar i's OHLC
        for f in broker.process_bar(bar):
            portfolio.apply_fill(f)

        # 2. mark to market as of this bar's close
        balance = portfolio.balance
        equity = portfolio.mark_to_market(bar.ts, {symbol: bar.close}, broker.open_positions)

        # 3. prop rules
        status = prop_rules.on_bar(bar.ts, bar.trading_day, balance, equity)

        if status.newly_failed:
            for f in broker.flatten(bar, FillType.MLL_BREACH_FLATTEN):
                portfolio.apply_fill(f)
            break

        if status.newly_daily_locked:
            for f in broker.flatten(bar, FillType.DAILY_LOCK_FLATTEN):
                portfolio.apply_fill(f)

        if status.newly_passed:
            break

        # 4. strategy sees bar i (and everything before it) only
        if not status.is_daily_locked:
            history = tagged.iloc[: i + 1]
            state = BarState(
                symbol=symbol, i=i, bar=bar, history=history,
                open_positions=dict(broker.open_positions),
                balance=portfolio.balance, equity=equity,
                daily_locked=status.is_daily_locked, trading_day=trading_day,
            )
            for order in strategy.on_bar(state):
                broker.submit_order(order)

    combine_result = prop_rules.finalize(final_balance=portfolio.balance)
    return BacktestResult(
        combine=combine_result,
        fills=portfolio.fills,
        equity_curve=portfolio.equity_curve,
        rejections=broker.rejections,
    )
