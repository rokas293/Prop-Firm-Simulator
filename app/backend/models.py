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
    # FXR_SPEC.md phase F6: a manual session (or all of an instrument's
    # sessions) is served through the same /api/runs/{id}/... endpoints as a
    # completed automated run, under a "bt:" id (see manual_analytics.py) --
    # these let the frontend tell them apart without parsing the id. Defaults
    # keep every real run bundle's meta response unchanged.
    source: str = "engine"                      # "engine" | "manual"
    prop_ruleset: Optional[str] = None           # manual runs only: e.g. "topstep_50k"
    session_ids: List[str] = Field(default_factory=list)  # manual runs only


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
    # FXR_SPEC.md section 2 schema-compat: only populated on manual-run
    # trades (see manual_analytics.py); None/absent on every engine run.
    source: Optional[str] = None
    session_id: Optional[str] = None
    # The journal's own trade id inside session_id. Equals trade_id for a
    # single-session scope; a pooled (all-sessions) scope renumbers trade_id
    # to stay unique across sessions, so this is what links back to the journal.
    session_trade_id: Optional[int] = None
    tags: Optional[List[str]] = None
    setup_name: Optional[str] = None
    grade: Optional[str] = None


class EquityPoint(BaseModel):
    time: int
    balance: float
    open_pnl: float
    equity: float
    # None on a manual run that didn't use a prop ruleset (no floors exist).
    mll_floor: Optional[float] = None
    daily_loss_floor: Optional[float] = None
    target_level: Optional[float] = None
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
    # Manual runs only (F6): how/when the Combine resolved, so the dashboard
    # can say more than PASSED/FAILED. All None for engine runs and while
    # a manual session is still "incomplete".
    resolved_time: Optional[int] = None
    resolved_trade_id: Optional[int] = None
    trades_to_result: Optional[int] = None
    equity_at_result: Optional[float] = None
    mll_floor_at_result: Optional[float] = None
    daily_loss_lock_days: Optional[int] = None


class StatsResponse(BaseModel):
    scope: str
    overall: GroupStats
    by_leg: Dict[str, GroupStats]
    by_session: Dict[str, GroupStats]
    # Manual runs only (F6): breakdowns along the journal's own dimensions.
    by_setup: Dict[str, GroupStats] = Field(default_factory=dict)
    by_tag: Dict[str, GroupStats] = Field(default_factory=dict)
    by_grade: Dict[str, GroupStats] = Field(default_factory=dict)
    by_backtest_session: Dict[str, GroupStats] = Field(default_factory=dict)
    result: Optional[StatsResult] = None


class MonteCarloResponse(BaseModel):
    method: str
    n_trades: int
    n_sims: int
    seed: int
    drawdown_budget_usd: float
    final_pnl_pct: Dict[str, float]
    max_drawdown_pct: Dict[str, float]
    prob_profit: float
    prob_drawdown_breach: float
    actual_final_pnl: float
    actual_max_drawdown: float
    fan: Dict[str, List[float]]
    actual_path: List[float]


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
    # FXR_SPEC.md section 2/B, phase F6: optional prop ruleset ("topstep_50k"
    # = propbt/config/prop_rules.yaml). None = a plain practice account.
    # Optional/defaulted so every session.json written before F6 validates.
    prop_ruleset: Optional[str] = None
    # Max contracts in one position, set from the ruleset's position limit
    # (prop_rules.yaml max_open_contracts) when prop_ruleset is set; None =
    # uncapped practice account.
    max_contracts: Optional[int] = None


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
    prop_ruleset: Optional[str] = None


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


class PropStatus(BaseModel):
    """Where a Topstep session's Combine stands (propbt's PropRulesTracker,
    via manual_analytics.prop_status): passed | failed | incomplete."""
    status: str
    fail_reason: Optional[str] = None
    resolved_trade_id: Optional[int] = None
    trades_to_result: Optional[int] = None


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
    # FXR_SPEC.md section C, phase F5: session-level journal notes (separate
    # from any one trade's own notes below). Optional/defaulted so every
    # session.json written before F5 still validates unchanged.
    notes: Optional[str] = None
    # Filled only by GET /bt-sessions (the list), for prop sessions.
    prop_status: Optional[PropStatus] = None


class BacktestSessionDetail(BacktestSessionSummary):
    pass


class UpdateSessionNotesRequest(BaseModel):
    notes: str


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


# --- FXR_SPEC.md section C, phase F5: journaling on top of the auto-logged
# trade. A screenshot's BYTES live in their own file under the session's
# directory (bt_session_service._screenshots_dir), served back through a
# dedicated endpoint -- trades.json (and, via the account-balance write in
# record_trade, session.json) get rewritten on nearly every journal edit, so
# embedding a screenshot's data URL directly in either would mean re-writing
# every OTHER trade's screenshots, in full, on every single journal edit in
# the session. Only this lightweight reference is persisted in trades.json.

class Screenshot(BaseModel):
    id: str
    caption: Optional[str] = None
    # Which moment of the trade this captures -- "entry"/"exit" per
    # FXR_SPEC's own wording, or "custom" for any other capture the user
    # takes while reviewing. Display-only categorization, not enforced
    # against the trade's actual entry_time/exit_time.
    moment: str = "custom"
    # Where the frontend fetches the actual image bytes from (GET, served
    # by bt_sessions.get_screenshot) -- never the image data itself.
    url: str
    created_at: str


class ManualTrade(TradeRecord):
    session_id: str
    source: str = "manual"
    # Journal fields (F5): absent from CreateManualTradeRequest below --
    # the sim broker journals a bare trade record the moment it closes
    # (F2), and these are filled in afterward via update_trade_journal (or,
    # for screenshots, add_trade_screenshot -- see that function's own
    # comment for why it's a separate endpoint from the rest). Tag taxonomy
    # is user-editable (FXR_SPEC section C) -- a flat freeform list, not a
    # fixed enum -- while grade/setup_name get their own dedicated fields
    # since the UI treats them as single-value pickers, not tags.
    notes: str = ""
    tags: List[str] = Field(default_factory=list)
    setup_name: Optional[str] = None
    grade: Optional[str] = None  # "A" | "B" | "C" | None, validated in the service layer
    screenshots: List[Screenshot] = Field(default_factory=list)


class UpdateTradeJournalRequest(BaseModel):
    # Every field optional and merged via exclude_unset (not exclude_none):
    # a PATCH that only wants to set the grade must never accidentally null
    # out notes/tags it didn't mean to touch. Screenshots are deliberately
    # NOT here -- see add_trade_screenshot/delete_trade_screenshot below.
    notes: Optional[str] = None
    tags: Optional[List[str]] = None
    setup_name: Optional[str] = None
    grade: Optional[str] = None


class AddScreenshotRequest(BaseModel):
    # A data URL (what klinecharts' getConvertPictureUrl returns client-
    # side) -- decoded and written to its own file server-side; never
    # stored as-is (see Screenshot's own comment).
    data_url: str
    moment: str = "custom"
    caption: Optional[str] = None


class RecordTradeResponse(BaseModel):
    trade: ManualTrade
    session: BacktestSessionDetail
