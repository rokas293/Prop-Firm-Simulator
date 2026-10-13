"""The per-bar engine loop, as an object you can drive one bar (or one batch)
at a time. `run_backtest` is "tag the bars, then step until done"; Autopilot
(FXR_V2_SPEC.md section 8) feeds the same stepper the 1-minute bars a replay
session has revealed so far. One implementation of the loop is what makes an
Autopilot run and the offline backtest the same computation, not two that
have to be kept in agreement.

No-look-ahead, structurally (unchanged from the loop this was extracted from).
For each real bar t, in increasing timestamp order:
  1. broker.process_bar(t) resolves fills for orders/positions decided on
     STRICTLY earlier bars, using only bar t's own OHLC (this is what makes
     a decision made at bar t-1 execute "at bar t", i.e. that order's t+1).
  2. Portfolio marks to market as of bar t's close -> balance & equity.
  3. PropRulesTracker.on_bar consumes that balance/equity (MLL breach,
     daily loss lock, target/consistency).
  4. Only THEN does the strategy see bar t (via `history = frame[:i+1]`, a
     slice that cannot physically contain bar t+1 or later) and return
     orders, which are submitted for the NEXT bar's process_bar call.

Steps 1-3 for bar t never depend on anything the strategy decides at step 4
for bar t, and step 4 never sees data past bar t's own close. The stepper can
only ever see bars that were `append`ed to it, so a caller that appends bars
up to a cursor cannot leak anything beyond it.

Nothing in here changes fills, PnL or prop-rule decisions: `equity_log` only
RECORDS per-bar bookkeeping that already exists in `status`/`prop_rules`.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import pandas as pd

from propbt.config import ContractSpec, PropRulesConfig, SessionsConfig
from propbt.data.sessions import tag_sessions
from propbt.engine.broker import Broker, Rejection
from propbt.engine.events import Bar, Fill, FillType, Order
from propbt.engine.portfolio import Portfolio
from propbt.engine.prop_rules import BarRuleStatus, CombineResult, PropRulesTracker
from propbt.strategy.base import BarState, Strategy


@dataclass(frozen=True)
class EquityLogRow:
    """Per-bar prop-rule bookkeeping, for the run-bundle/viz layer only --
    nothing here is read back by the engine. `daily_loss_floor` and
    `target_level` aren't stored (they're trivial derivations from
    day_start_balance/PropRulesConfig); the bundle writer computes them."""
    ts: pd.Timestamp
    balance: float
    equity: float
    mll_floor: float
    trading_day: dt.date
    day_start_balance: float
    breached: bool         # True only on the exact bar a newly_failed MLL breach occurred
    daily_locked: bool


@dataclass(frozen=True)
class BarOutcome:
    """What one processed bar did. `fills` are everything the broker booked at
    this bar (entries, SL/TP exits, forced flattens); `orders` are what the
    strategy decided on this bar's close, to execute from the next bar on."""
    bar: Bar
    fills: List[Fill]
    status: BarRuleStatus
    balance: float
    equity: float
    orders: List[Order]
    strategy_called: bool      # False while daily-locked or when no strategy is attached
    finished: Optional[str]    # None | "failed" | "passed": the run ends at this bar


class EngineStepper:
    """Drives broker + portfolio + prop-rule tracker + strategy bar by bar.

    `strategy` may be None (positions are still managed and the account still
    marked, but nothing new is decided) and may be replaced between bars with
    `set_strategy`. `trading_start_ts`, if given, lets the frame hold bars
    BEFORE trading starts (warm-up context for fair value / consolidation /
    swings): those bars are skipped entirely -- no fills, no prop-rule
    tracking, no strategy calls -- but still count as `history` once trading
    does start, since that is legitimate already-happened market data.
    """

    def __init__(
        self,
        symbol: str,
        contracts: Dict[str, ContractSpec],
        prop_rules_config: PropRulesConfig,
        sessions_config: SessionsConfig,
        slippage_ticks: int = 1,
        strategy: Optional[Strategy] = None,
        trading_start_ts: Optional[pd.Timestamp] = None,
    ):
        self.symbol = symbol
        self.sessions_config = sessions_config
        self.strategy = strategy
        self.trading_start_ts = trading_start_ts

        self.broker = Broker(
            contracts=contracts,
            slippage_ticks=slippage_ticks,
            commissions=prop_rules_config.commissions,
            max_open_contracts=prop_rules_config.max_open_contracts,
        )
        self.portfolio = Portfolio(contracts=contracts, start_balance=prop_rules_config.start_balance)
        self.prop_rules = PropRulesTracker(prop_rules_config)
        self.equity_log: List[EquityLogRow] = []

        self.frame: Optional[pd.DataFrame] = None   # tagged bars (warm-up + everything appended)
        self._i = 0                                  # next frame index to consume
        self.finished: Optional[str] = None          # None | "failed" | "passed"

    # ---- feeding -----------------------------------------------------------

    def append(self, bars: pd.DataFrame) -> None:
        """Add raw 1-minute bars (loader schema). They must come strictly after
        everything already held. Tagging is per-row wall-clock arithmetic, so
        tagging a chunk alone equals tagging it as part of the whole."""
        tagged = tag_sessions(bars, self.sessions_config)
        if self.frame is None:
            self.frame = tagged
        elif len(tagged):
            if len(self.frame) and tagged.index[0] <= self.frame.index[-1]:
                raise ValueError("appended bars must come strictly after the bars already held")
            self.frame = pd.concat([self.frame, tagged])
        if self.trading_start_ts is not None:
            start_i = self.frame.index.searchsorted(self.trading_start_ts, side="left")
            self._i = max(self._i, int(start_i))

    @property
    def n_held(self) -> int:
        return 0 if self.frame is None else len(self.frame)

    @property
    def n_pending(self) -> int:
        """Held bars not yet consumed (halt bars included)."""
        return max(0, self.n_held - self._i)

    @property
    def last_held_ts(self) -> Optional[pd.Timestamp]:
        return None if not self.n_held else self.frame.index[-1]

    def set_strategy(self, strategy: Optional[Strategy]) -> None:
        self.strategy = strategy

    # ---- stepping ----------------------------------------------------------

    def step(self) -> Optional[BarOutcome]:
        """Consume held bars until one real trading bar is processed and
        return what it did; None when nothing is left (or the run finished)."""
        if self.finished is not None:
            return None
        frame = self.frame
        n = self.n_held
        while self._i < n:
            i = self._i
            self._i += 1
            row = frame.iloc[i]
            trading_day = row["trading_day"]
            if trading_day is None:
                continue  # maintenance-halt bar -- not a real trading bar
            return self._process(i, row, trading_day)
        return None

    def run(self) -> int:
        """Step through every held bar (or until the run finishes). Returns
        how many real bars were processed."""
        count = 0
        while self.step() is not None:
            count += 1
        return count

    def _process(self, i: int, row: pd.Series, trading_day: dt.date) -> BarOutcome:
        symbol, broker, portfolio, prop_rules = self.symbol, self.broker, self.portfolio, self.prop_rules
        ts = self.frame.index[i]
        bar = Bar(
            symbol=symbol, ts=ts, open=row["open"], high=row["high"],
            low=row["low"], close=row["close"], volume=int(row["volume"]),
            trading_day=trading_day, session=row["session"],
        )
        bar_fills: List[Fill] = []

        # 1. fills for decisions made on earlier bars, using only bar i's OHLC
        for f in broker.process_bar(bar):
            portfolio.apply_fill(f)
            bar_fills.append(f)

        # 2. mark to market as of this bar's close
        balance = portfolio.balance
        equity = portfolio.mark_to_market(bar.ts, {symbol: bar.close}, broker.open_positions)

        # 3. prop rules
        status = prop_rules.on_bar(bar.ts, bar.trading_day, balance, equity)

        self.equity_log.append(EquityLogRow(
            ts=bar.ts, balance=balance, equity=equity, mll_floor=status.mll_floor,
            trading_day=trading_day, day_start_balance=prop_rules.day_start_balance,
            breached=status.newly_failed, daily_locked=status.is_daily_locked,
        ))

        if status.newly_failed:
            for f in broker.flatten(bar, FillType.MLL_BREACH_FLATTEN):
                portfolio.apply_fill(f)
                bar_fills.append(f)
            self.finished = "failed"
            return BarOutcome(bar, bar_fills, status, balance, equity, [], False, self.finished)

        if status.newly_daily_locked:
            for f in broker.flatten(bar, FillType.DAILY_LOCK_FLATTEN):
                portfolio.apply_fill(f)
                bar_fills.append(f)

        if status.newly_passed:
            self.finished = "passed"
            return BarOutcome(bar, bar_fills, status, balance, equity, [], False, self.finished)

        # 4. strategy sees bar i (and everything before it) only
        orders: List[Order] = []
        called = False
        if self.strategy is not None and not status.is_daily_locked:
            called = True
            state = BarState(
                symbol=symbol, i=i, bar=bar, history=self.frame.iloc[: i + 1],
                open_positions=dict(broker.open_positions),
                balance=portfolio.balance, equity=equity,
                daily_locked=status.is_daily_locked, trading_day=trading_day,
            )
            orders = list(self.strategy.on_bar(state))
            for order in orders:
                broker.submit_order(order)

        return BarOutcome(bar, bar_fills, status, balance, equity, orders, called, None)

    # ---- results -----------------------------------------------------------

    @property
    def rejections(self) -> List[Rejection]:
        return self.broker.rejections

    def finalize(self) -> CombineResult:
        """Close the open trading day and return the Combine verdict. This
        MUTATES the tracker (it trails the floor and logs the day): call it
        once, when the run is over -- not mid-stream for a "where do things
        stand" reading."""
        return self.prop_rules.finalize(final_balance=self.portfolio.balance)
