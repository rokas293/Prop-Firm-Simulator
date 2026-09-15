"""Pydantic response models -- one per API shape (VIZ_SPEC.md section 6).
All times are UNIX seconds UTC (Lightweight Charts' native format); the
backend converts from the bundle's tz-aware pandas Timestamps here, once,
so nothing downstream has to think about timezones again.
"""
from __future__ import annotations

from typing import Dict, List, Optional

from pydantic import BaseModel, Field


class RunResultModel(BaseModel):
    passed: bool
    fail_reason: Optional[str] = None
    days_to_fail: Optional[int] = None


class RunSummary(BaseModel):
    run_id: str
    created_at: str
    config_name: str
    instrument: str
    base_timeframe: str
    date_from: str
    date_to: str
    is_oos_split_date: Optional[str] = None
    result: RunResultModel
    params_count: int


class RunMetaResponse(RunSummary):
    config_hash: str


class TradeRecord(BaseModel):
    trade_id: int
    entry_time: int
    exit_time: int
    instrument: str
    side: str
    leg: Optional[str] = None
    session: Optional[str] = None
    trading_day: Optional[str] = None
    size_contracts: int
    entry_price: float
    exit_price: float
    sl_price: Optional[float] = None
    tp_price: Optional[float] = None
    sl_points: Optional[float] = None
    tp_points: Optional[float] = None
    rr_planned: Optional[float] = None
    exit_type: str
    pnl_usd: float
    r_multiple: Optional[float] = None
    commission_usd: float
    mae_points: float
    mfe_points: float
    mae_r: Optional[float] = None
    mfe_r: Optional[float] = None
    bars_held: int


class EquityPoint(BaseModel):
    time: int
    balance: float
    open_pnl: float
    equity: float
    mll_floor: float
    daily_loss_floor: float
    target_level: float
    trading_day: Optional[str] = None
    day_start_balance: float
    breached: bool
    daily_locked: bool
    drawdown_usd: float


class GroupStats(BaseModel):
    trades: int
    net_pnl_usd: float
    net_r: Optional[float] = None
    win_rate: Optional[float] = None
    expectancy_usd: Optional[float] = None
    expectancy_r: Optional[float] = None
    profit_factor: Optional[float] = None
    max_drawdown_usd: float = 0.0


class StatsResult(BaseModel):
    status: str
    fail_reason: Optional[str] = None
    target_hit: bool
    consistency_passed: Optional[bool] = None
    final_balance: float
    trading_days: int


class StatsResponse(BaseModel):
    scope: str
    overall: GroupStats
    by_leg: Dict[str, GroupStats]
    by_session: Dict[str, GroupStats]
    result: Optional[StatsResult] = None


class Bar(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: int


class DailyRiskPoint(BaseModel):
    trading_day: str
    min_distance_to_mll_usd: float
    min_distance_time: int
    breached: bool
    breach_time: Optional[int] = None
    daily_locked: bool
    daily_lock_time: Optional[int] = None
    trades: int


class IndicatorPoint(BaseModel):
    time: int
    value: float


class AiStatusResponse(BaseModel):
    available: bool


class SummarizeResponse(BaseModel):
    summary: str


class SessionWindow(BaseModel):
    trading_day: str
    session: str
    start: int
    end: int
    fair_value: Optional[float] = None
    fair_value_time: Optional[int] = None


# --- FXR_SPEC.md section 2: manual-backtest sessions (F1 shell). "Session"
# here means a saved manual-replay session (BacktestSession), a completely
# different concept from SessionWindow above (an Asia/London/NY trading-
# session window) -- named `BacktestSession...`/routed under /api/bt-
# sessions specifically to avoid colliding with that pre-existing meaning.

class SimAccountModel(BaseModel):
    id: str
    starting_balance: float
    balance: float
    currency: str = "USD"
    # Exactly one of these is set (validated in bt_session_service, not
    # here -- keeps this a plain data shape, no cross-field logic in a
    # response model). risk_per_trade_percent is of the CURRENT balance
    # when actually used to size a trade (F2+); nothing in F1 reads it yet.
    risk_per_trade_percent: Optional[float] = None
    risk_per_trade_usd: Optional[float] = None
    default_contracts: int
    commission_per_contract: float


class CreateSessionRequest(BaseModel):
    instrument: str
    base_timeframe: str
    # Exactly one of start_time/random_start is used (random_start=True
    # ignores start_time and picks server-side, so the client never sees --
    # let alone influences -- which historical point it lands on).
    start_time: Optional[int] = None
    random_start: bool = False
    starting_balance: float = 50000.0
    risk_per_trade_percent: Optional[float] = 1.0
    risk_per_trade_usd: Optional[float] = None
    default_contracts: int = 1
    commission_per_contract: float = 1.0


# --- FXR_SPEC.md section B/3, phase F4: the sim broker's open position and
# working orders, persisted WITH the session so a mid-trade reload restores
# them instead of silently losing the trade (F2/F3's own flagged gap).
# Deliberately no *_index field -- an index into the currently-loaded bars
# array is meaningless across a reload (a fresh fetch window re-indexes
# everything from 0), same reasoning as cursor_time itself: only the TIME
# survives a reload; the frontend re-resolves it back to an index the same
# way it already does for cursor_time (resyncCursorIndex).

class PersistedPosition(BaseModel):
    side: str
    contracts: int
    entry_price: float
    entry_time: int
    risk_usd: Optional[float] = None
    sl_price: Optional[float] = None
    tp_price: Optional[float] = None
    # F4 optional toggles -- carried on the position so they survive a
    # reload same as everything else about it.
    auto_breakeven: bool = False
    trailing_points: Optional[float] = None


class PersistedWorkingOrder(BaseModel):
    id: str
    side: str
    order_type: str  # "limit" | "stop"
    price: float
    contracts: int
    sl_price: Optional[float] = None
    tp_price: Optional[float] = None
    risk_usd: Optional[float] = None
    placed_time: int


class BacktestSessionSummary(BaseModel):
    id: str
    instrument: str
    base_timeframe: str
    start_time: int
    created_at: str
    updated_at: str
    cursor_time: int
    status: str  # "active" | "archived"
    account: SimAccountModel
    position: Optional[PersistedPosition] = None
    working_orders: List[PersistedWorkingOrder] = Field(default_factory=list)


class BacktestSessionDetail(BacktestSessionSummary):
    pass


class UpdateCursorRequest(BaseModel):
    cursor_time: int
    # F4: every cursor update also carries the FULL current broker state
    # (never a partial/optional patch) -- unambiguously distinguishes
    # "flat" (position=None) from "unchanged" without a separate sentinel,
    # since the frontend always knows its own current state at the moment
    # of any step. Also used standalone (cursor_time left at whatever it
    # already is) by every OTHER position-changing action (Buy/Sell/
    # Confirm/Close/partial-close/cancel-order/drag-modify) so a reload
    # never has to wait for the next replay step to see the latest trade.
    position: Optional[PersistedPosition] = None
    working_orders: List[PersistedWorkingOrder] = Field(default_factory=list)


# --- FXR_SPEC.md section 2/6, phase F2: manual trades journaled from the
# sim broker. Deliberately reuses TradeRecord's exact field set (not a
# fresh shape) -- "keep manual trades schema-compatible with the existing
# trade-record model" is section 2's explicit instruction, so Dashboard/
# Compass/Monte-Carlo/MAE-MFE repoint in F6 with minimal change.

class CreateManualTradeRequest(BaseModel):
    entry_time: int
    exit_time: int
    instrument: str
    side: str
    leg: Optional[str] = None
    session: Optional[str] = None
    trading_day: Optional[str] = None
    size_contracts: int
    entry_price: float
    exit_price: float
    sl_price: Optional[float] = None
    tp_price: Optional[float] = None
    sl_points: Optional[float] = None
    tp_points: Optional[float] = None
    rr_planned: Optional[float] = None
    exit_type: str
    pnl_usd: float
    r_multiple: Optional[float] = None
    commission_usd: float
    mae_points: float
    mfe_points: float
    mae_r: Optional[float] = None
    mfe_r: Optional[float] = None
    bars_held: int


class ManualTrade(TradeRecord):
    session_id: str
    source: str = "manual"


class RecordTradeResponse(BaseModel):
    trade: ManualTrade
    session: BacktestSessionDetail
