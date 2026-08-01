"""Topstep $50k Combine rule tracker -- CLAUDE.md section 3, exactly:

- Trailing Max Loss Limit (MLL): floor starts at start_balance - 2000.
  Trails on EOD balance (`mll = max(mll, eod_balance - 2000)`). Once EOD
  balance reaches 52000, the floor freezes at 50000 forever. Breached
  against LIVE intraday equity, every bar -> immediate Combine fail.
- Daily Loss Limit: $1000 drawdown from the day's starting balance locks
  trading for the rest of that trading day (flatten + stop). NOT a fail.
- Profit target: balance reaches start_balance + 3000.
- Consistency rule: when the target is hit, the single best trading day's
  PnL must be <=50% of total profit, or it doesn't count as a pass yet
  ("target hit but not consistency-passed" -- tracked separately, and
  re-checked on every later bar since more profit can dilute an early big
  day below the 50% line).
- Trading day boundary: 18:00 ET -> 17:00 ET next day (see sessions.py);
  this is what stamps the EOD balance and resets the daily loss limit.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import pandas as pd

from propbt.config import PropRulesConfig


@dataclass(frozen=True)
class BarRuleStatus:
    is_daily_locked: bool
    newly_daily_locked: bool
    failed: bool
    newly_failed: bool
    fail_reason: Optional[str]
    passed: bool
    newly_passed: bool
    mll_floor: float


@dataclass(frozen=True)
class DayLog:
    trading_day: dt.date
    start_balance: float
    end_balance: float
    daily_pnl: float
    daily_loss_locked: bool
    mll_floor_after: float
    mll_frozen_after: bool


@dataclass(frozen=True)
class CombineResult:
    status: str                          # "passed" | "failed" | "incomplete"
    fail_reason: Optional[str]
    fail_ts: Optional[pd.Timestamp]
    pass_ts: Optional[pd.Timestamp]
    target_hit: bool
    target_hit_ts: Optional[pd.Timestamp]
    consistency_passed: Optional[bool]
    final_balance: float
    day_logs: List[DayLog] = field(default_factory=list)


class PropRulesTracker:
    def __init__(self, config: PropRulesConfig):
        self.config = config

        self.mll_floor = config.start_balance - config.mll_initial_offset
        self.mll_frozen = False

        self.current_trading_day: Optional[dt.date] = None
        self.day_start_balance: float = config.start_balance
        self.daily_locked = False

        self.failed = False
        self.fail_reason: Optional[str] = None
        self.fail_ts: Optional[pd.Timestamp] = None

        self.passed = False
        self.pass_ts: Optional[pd.Timestamp] = None

        self.target_hit = False
        self.target_hit_ts: Optional[pd.Timestamp] = None
        self.consistency_passed: Optional[bool] = None

        self.daily_pnls: Dict[dt.date, float] = {}
        self.day_logs: List[DayLog] = []

        self._last_balance: float = config.start_balance

    def on_bar(
        self, ts: pd.Timestamp, trading_day: Optional[dt.date], balance: float, equity: float
    ) -> BarRuleStatus:
        if self.failed or self.passed:
            return self._status(newly_failed=False, newly_daily_locked=False, newly_passed=False)

        if trading_day is not None and trading_day != self.current_trading_day:
            if self.current_trading_day is not None:
                self._close_day(self.current_trading_day, self._last_balance)
            self.current_trading_day = trading_day
            self.day_start_balance = self._last_balance
            self.daily_locked = False

        # --- intraday MLL breach: checked against LIVE equity, every bar ---
        if equity <= self.mll_floor:
            self.failed = True
            self.fail_reason = "mll_breach"
            self.fail_ts = ts
            self._last_balance = balance
            return self._status(newly_failed=True, newly_daily_locked=False, newly_passed=False)

        # --- daily loss limit: locks the day, does not fail the Combine ---
        newly_daily_locked = False
        if not self.daily_locked and (equity - self.day_start_balance) <= -self.config.daily_loss_limit:
            self.daily_locked = True
            newly_daily_locked = True

        # --- profit target + consistency (based on REALIZED balance) ---
        newly_passed = False
        total_profit = balance - self.config.start_balance
        if total_profit >= self.config.profit_target:
            current_day_pnl = balance - self.day_start_balance
            best_day_pnl = max([current_day_pnl, *self.daily_pnls.values()])
            consistency_ok = best_day_pnl <= total_profit * self.config.consistency_max_pct

            self.target_hit = True
            if self.target_hit_ts is None:
                self.target_hit_ts = ts
            self.consistency_passed = consistency_ok

            if consistency_ok:
                self.passed = True
                self.pass_ts = ts
                newly_passed = True

        self._last_balance = balance
        return self._status(newly_failed=False, newly_daily_locked=newly_daily_locked, newly_passed=newly_passed)

    def finalize(self, final_balance: Optional[float] = None) -> CombineResult:
        fb = final_balance if final_balance is not None else self._last_balance
        if self.current_trading_day is not None and not self.failed:
            self._close_day(self.current_trading_day, fb)

        status = "passed" if self.passed else ("failed" if self.failed else "incomplete")
        return CombineResult(
            status=status,
            fail_reason=self.fail_reason,
            fail_ts=self.fail_ts,
            pass_ts=self.pass_ts,
            target_hit=self.target_hit,
            target_hit_ts=self.target_hit_ts,
            consistency_passed=self.consistency_passed,
            final_balance=fb,
            day_logs=self.day_logs,
        )

    def _close_day(self, trading_day: dt.date, eod_balance: float) -> None:
        daily_pnl = eod_balance - self.day_start_balance
        self.daily_pnls[trading_day] = daily_pnl

        if not self.mll_frozen:
            self.mll_floor = max(self.mll_floor, eod_balance - self.config.mll_initial_offset)
            if eod_balance >= self.config.mll_freeze_trigger_balance:
                self.mll_frozen = True
                self.mll_floor = self.config.mll_freeze_floor

        self.day_logs.append(DayLog(
            trading_day=trading_day,
            start_balance=self.day_start_balance,
            end_balance=eod_balance,
            daily_pnl=daily_pnl,
            daily_loss_locked=self.daily_locked,
            mll_floor_after=self.mll_floor,
            mll_frozen_after=self.mll_frozen,
        ))

    def _status(self, *, newly_failed: bool, newly_daily_locked: bool, newly_passed: bool) -> BarRuleStatus:
        return BarRuleStatus(
            is_daily_locked=self.daily_locked,
            newly_daily_locked=newly_daily_locked,
            failed=self.failed,
            newly_failed=newly_failed,
            fail_reason=self.fail_reason,
            passed=self.passed,
            newly_passed=newly_passed,
            mll_floor=self.mll_floor,
        )
